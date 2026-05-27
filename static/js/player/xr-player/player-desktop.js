(() => {
  const XR = window.FilePipeXr = window.FilePipeXr || {};
  const { FilePipeThreeXrPlayer } = XR;
  const {
    INSTANCE_BY_VIDEO,
    AUDIO_GRAPH_BY_VIDEO,
    DEFAULT_SETTINGS,
    THEATER_SETTING_LIMITS,
    DEFAULT_AUDIO_CHANNEL_LABELS,
    LAYOUT_LABELS,
    BACKLIGHT_SEGMENT_COUNTS,
    XR_SIDE_PANEL_LOGICAL_SIZE,
    XR_SIDE_PANEL_TEXTURE_SIZE,
    XR_SIDE_PANEL_ANGLE,
    XR_THUMBSTICK_SEEK_SECONDS,
    XR_THUMBSTICK_SEEK_DEADZONE,
    XR_THUMBSTICK_SEEK_RESET_ZONE,
    XR_THUMBSTICK_SEEK_REPEAT_MS,
    MR_DIM_RENDER_ORDER,
    BACKLIGHT_MASK_RENDER_ORDER,
    BACKLIGHT_RENDER_ORDER,
    isKnownLayout,
    isKnownBacklightMode,
    isLocalDepthProcessor,
    normalizeLocalDepthSettings,
    normalizeSpeakerChannel,
    defaultSpeakerDefinition,
    speakerVectorFromDefinition,
    safeDisconnect,
    setAudioParamValue,
    setPannerPosition,
    setListenerPosition,
    setListenerOrientation,
    clampNumber,
    isPlainObject,
    mediaInfoVideoAspectRatio,
    glbMaterialTextureConfig,
    glbMaterialOverrideConfig,
    normalizeTextureConfig,
    normalizeGlbMaterialName,
    normalizeGlbNodeName,
    resolveRelativeAssetUrl,
    disposeThemeTexture,
    disposeThemeMaterial,
    gltfWrapMode,
    gltfMagFilter,
    gltfMinFilter,
    parseThemeGlb,
    shouldExcludeThemeGlbNode,
    buildThemeGlbTexture,
    applyGltfTextureTransform,
    buildThemeGlbNode,
    applyGltfNodeTransform,
    buildThemeGlbPrimitive,
    readGltfAccessor,
    readGltfComponent,
    coerceThemeSettingValue,
    formatThemeSettingValue,
    cssEscape,
    setObjectOpacity,
    normalizeDegrees,
    isEditableTarget,
    normalizedNavigationKey,
    isBacklightCornerSide,
    backlightOpacityScale,
    emptyBacklightColorMap,
    cornerVideoSampleRegion,
    lerp,
    createBacklightGlowTexture,
    createBacklightStaticMaterial,
    createBacklightSegmentMaterial,
    flipRgbaRows,
    hasVisibleSamplePixels,
    samplePixelDebug,
    objectMaterials,
    normalizeSeatingPosition,
    slugifySeatId,
    themeVideoSampleColor,
    averageBacklightColorMap,
    averageVisibleColors,
    averageSampleRegion,
    sampleExpandedSegmentRegion,
    isVisibleBacklightColor,
    hasVisibleBacklightColors,
    sampleExpandedBacklightColors,
    fallbackBacklightColors,
    offBacklightColors,
    offBacklightColor,
    colorToRgb,
    fallbackBacklightColor,
    lockedPanelSize,
    formatTime,
    cleanPanelText,
    wrapCanvasText,
    roundRect,
    drawXrPanelButton,
    colorFromTheme,
    shouldRestoreDesktopRoomView,
    parseObjGeometry,
  } = XR;

  Object.assign(FilePipeThreeXrPlayer.prototype, {
    bindDesktopStageControls() {
      if (!this.canvas) return;
      this.canvas.tabIndex = 0;
      this.listenOverlay(this.canvas, "contextmenu", (event) => event.preventDefault());
      this.listenOverlay(this.canvas, "pointerdown", (event) => this.startDesktopDrag(event));
      this.listenOverlay(this.canvas, "pointermove", (event) => this.updateDesktopDrag(event));
      this.listenOverlay(this.canvas, "pointerup", (event) => this.endDesktopDrag(event));
      this.listenOverlay(this.canvas, "pointercancel", (event) => this.endDesktopDrag(event));
      this.listenOverlay(this.canvas, "lostpointercapture", (event) => this.endDesktopDrag(event));
      this.listenOverlay(this.canvas, "click", (event) => this.handleLiteCanvasClick(event));
      this.listenOverlay(this.overlay, "pointermove", (event) => this.handleLitePointerMove(event));
      this.listenOverlay(document, "fullscreenchange", () => this.syncTheaterModeControls());
      this.listenOverlay(document, "webkitfullscreenchange", () => this.syncTheaterModeControls());
      this.listenOverlay(window, "keydown", (event) => this.handleDesktopKeyDown(event));
      this.listenOverlay(window, "keyup", (event) => this.handleDesktopKeyUp(event));
    },

    listenOverlay(target, eventName, handler) {
      target.addEventListener(eventName, handler);
      this.overlayCleanups.push(() => target.removeEventListener(eventName, handler));
    },

    handleLiteCanvasClick(event) {
      if (this.theaterMode !== "lite" || event.target !== this.canvas) return;
      event.preventDefault();
      if (this.isCoarsePointer() || this.liteControlsVisible || this.liteToolsVisible) {
        this.hideLiteControls();
      } else {
        this.showLiteControlsTemporarily(3600);
      }
    },

    handleLitePointerMove(event) {
      if (this.theaterMode !== "lite" || this.isCoarsePointer()) return;
      if (event.pointerType && event.pointerType !== "mouse") return;
      this.showLiteControlsTemporarily();
    },

    startDesktopDrag(event) {
      if (!this.canvas || this.xrSession || (event.button !== 0 && event.button !== 2)) return;
      if (this.theaterMode === "lite") return;
      event.preventDefault();
      this.canvas.focus?.({ preventScroll: true });
      const hit = event.button === 0 && !event.shiftKey ? this.themeHitFromPointer(event) : null;
      if (hit?.object?.userData?.themeInteractive) {
        const config = hit.object.userData.themeConfig || {};
        this.desktopDrag = {
          pointerId: event.pointerId,
          mode: config.movable ? "object-move" : "object-interact",
          object: hit.object,
          startClientX: event.clientX,
          startClientY: event.clientY,
          startPosition: hit.object.position.clone(),
        };
        this.canvas.setPointerCapture?.(event.pointerId);
        this.canvas.classList.add("fp-three-xr-canvas-dragging");
        return;
      }
      this.desktopDrag = {
        pointerId: event.pointerId,
        mode: this.desktopDragModeForEvent(event),
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPanelX: this.settings.panelX,
        startPanelY: this.settings.panelY,
        startPanelYaw: this.settings.panelYaw,
        startPanelPitch: this.settings.panelPitch,
        startRoomViewX: this.settings.roomViewX,
        startRoomViewY: this.settings.roomViewY,
        startRoomViewZ: this.settings.roomViewZ,
        startRoomViewYaw: this.settings.roomViewYaw,
        startRoomViewPitch: this.settings.roomViewPitch,
      };
      this.canvas.setPointerCapture?.(event.pointerId);
      this.canvas.classList.add("fp-three-xr-canvas-dragging");
    },

    desktopDragModeForEvent(event) {
      if (event.shiftKey && event.button === 2) return "room-look";
      if (event.shiftKey) return "room-move";
      return event.button === 2 ? "screen-rotate" : "screen-move";
    },

    updateDesktopDrag(event) {
      if (!this.desktopDrag || this.desktopDrag.pointerId !== event.pointerId || !this.canvas) return;
      event.preventDefault();
      const dx = event.clientX - this.desktopDrag.startClientX;
      const dy = event.clientY - this.desktopDrag.startClientY;
      if (this.desktopDrag.mode === "object-move") {
        this.moveThemeObjectFromDrag(dx, dy);
      } else if (this.desktopDrag.mode === "object-interact") {
        return;
      } else if (this.desktopDrag.mode === "room-move") {
        this.moveRoomViewFromDrag(dx, dy);
        this.updateDesktopCamera();
      } else if (this.desktopDrag.mode === "room-look") {
        this.settings.roomViewYaw = normalizeDegrees(this.desktopDrag.startRoomViewYaw - dx * 0.16);
        this.settings.roomViewPitch = clampNumber(this.desktopDrag.startRoomViewPitch - dy * 0.12, -35, 35, DEFAULT_SETTINGS.roomViewPitch);
        this.updateDesktopCamera();
      } else if (this.desktopDrag.mode === "screen-rotate") {
        this.settings.panelYaw = clampNumber(this.desktopDrag.startPanelYaw + dx * 0.18, -35, 35, DEFAULT_SETTINGS.panelYaw);
        this.settings.panelPitch = clampNumber(this.desktopDrag.startPanelPitch + dy * 0.12, -20, 20, DEFAULT_SETTINGS.panelPitch);
        this.syncOverlayControls();
        this.updateVideoGeometry();
      } else {
        const rect = this.canvas.getBoundingClientRect();
        const viewHeight = 2 * this.settings.distance * Math.tan(THREE.MathUtils.degToRad(60) / 2);
        const viewWidth = viewHeight * (rect.width / Math.max(1, rect.height));
        this.settings.panelX = clampNumber(
          this.desktopDrag.startPanelX + (dx / Math.max(1, rect.width)) * viewWidth,
          -3,
          3,
          DEFAULT_SETTINGS.panelX,
        );
        this.settings.panelY = clampNumber(
          this.desktopDrag.startPanelY - (dy / Math.max(1, rect.height)) * viewHeight,
          -1.4,
          1.4,
          DEFAULT_SETTINGS.panelY,
        );
        this.syncOverlayControls();
        this.updateVideoGeometry();
      }
    },

    moveRoomViewFromDrag(dx, dy) {
      const yaw = THREE.MathUtils.degToRad(this.desktopDrag.startRoomViewYaw);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const forwardX = -Math.sin(yaw);
      const forwardZ = -Math.cos(yaw);
      const strafe = dx * 0.006;
      const forward = -dy * 0.006;
      this.settings.roomViewX = clampNumber(
        this.desktopDrag.startRoomViewX + rightX * strafe + forwardX * forward,
        THEATER_SETTING_LIMITS.roomViewX[0],
        THEATER_SETTING_LIMITS.roomViewX[1],
        DEFAULT_SETTINGS.roomViewX,
      );
      this.settings.roomViewZ = clampNumber(
        this.desktopDrag.startRoomViewZ + rightZ * strafe + forwardZ * forward,
        THEATER_SETTING_LIMITS.roomViewZ[0],
        THEATER_SETTING_LIMITS.roomViewZ[1],
        DEFAULT_SETTINGS.roomViewZ,
      );
    },

    endDesktopDrag(event) {
      if (!this.desktopDrag || this.desktopDrag.pointerId !== event.pointerId) return;
      if (this.canvas?.hasPointerCapture?.(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      this.canvas?.classList.remove("fp-three-xr-canvas-dragging");
      const moved = Math.hypot(
        event.clientX - this.desktopDrag.startClientX,
        event.clientY - this.desktopDrag.startClientY,
      );
      if (this.desktopDrag.mode === "object-interact" && moved < 6) {
        this.activateThemeObjectInteraction(this.desktopDrag.object);
      }
      if (this.desktopDrag.mode === "object-move") {
        const object = this.desktopDrag.object;
        const id = object?.userData?.themeConfig?.id;
        if (id) {
          this.setThemeObjectState(id, {
            position: [object.position.x, object.position.y, object.position.z],
          });
        }
      }
      this.desktopDrag = null;
      this.saveSettings();
      this.syncOverlayControls();
    },

    themeHitFromPointer(event) {
      if (!this.themeRaycaster || !this.themePointer || !this.camera || !this.canvas || !this.themeInteractiveObjects.length) return null;
      const rect = this.canvas.getBoundingClientRect();
      this.themePointer.set(
        ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
        -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1),
      );
      this.themeRaycaster.setFromCamera(this.themePointer, this.camera);
      return this.themeRaycaster.intersectObjects(this.themeInteractiveObjects.filter((object) => object.visible), true)[0] || null;
    },

    moveThemeObjectFromDrag(dx, dy) {
      const object = this.desktopDrag?.object;
      if (!object) return;
      const config = object.userData.themeConfig || {};
      const axis = String(config.moveAxis || "xz").toLowerCase();
      const amountX = dx * this.resolveThemeNumber(config.moveScale, 0.006);
      const amountY = -dy * this.resolveThemeNumber(config.moveScale, 0.006);
      const yaw = THREE.MathUtils.degToRad(this.settings.roomViewYaw);
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const next = this.desktopDrag.startPosition.clone();
      if (axis === "xy") {
        next.x += amountX;
        next.y += amountY;
      } else if (axis === "x") {
        next.x += amountX;
      } else if (axis === "z") {
        next.z += amountY;
      } else if (axis === "y") {
        next.y += amountY;
      } else {
        next.add(right.multiplyScalar(amountX));
        next.add(forward.multiplyScalar(amountY));
      }
      const bounds = Array.isArray(config.moveBounds) ? config.moveBounds : null;
      if (bounds?.length >= 6) {
        next.x = clampNumber(next.x, Number(bounds[0]), Number(bounds[1]), next.x);
        next.y = clampNumber(next.y, Number(bounds[2]), Number(bounds[3]), next.y);
        next.z = clampNumber(next.z, Number(bounds[4]), Number(bounds[5]), next.z);
      }
      object.position.copy(next);
    },

    handleDesktopKeyDown(event) {
      if (this.xrSession || isEditableTarget(event.target)) return;
      if (this.theaterMode === "lite") {
        const rawKey = String(event.key || "").toLowerCase();
        if (rawKey === "f") {
          event.preventDefault();
          this.toggleLiteFullscreen();
          return;
        }
        if (rawKey === "c" || rawKey === "h") {
          event.preventDefault();
          if (this.liteControlsVisible || this.liteToolsVisible) {
            this.hideLiteControls();
          } else {
            this.showLiteControlsTemporarily(3600);
          }
          return;
        }
        if (rawKey === " " || rawKey === "spacebar") {
          event.preventDefault();
          this.showLiteControlsTemporarily(1800);
          this.togglePlayback();
          return;
        }
        if (rawKey === "escape") {
          this.showLiteControlsTemporarily(2200);
          return;
        }
      }
      const key = normalizedNavigationKey(event);
      if (!key) return;
      event.preventDefault();
      this.desktopKeys.add(key);
    },

    handleDesktopKeyUp(event) {
      const key = normalizedNavigationKey(event);
      if (!key) return;
      this.desktopKeys.delete(key);
      this.saveSettings();
    },

    updateDesktopKeyboardNavigation(deltaSeconds) {
      if (this.theaterMode === "lite") return;
      if (this.xrSession || !this.desktopKeys.size) return;
      const speed = this.desktopKeys.has("shift") ? 3.0 : 1.45;
      const amount = speed * deltaSeconds;
      let forward = 0;
      let strafe = 0;
      let vertical = 0;
      let yawDelta = 0;
      if (this.desktopKeys.has("arrowup") || this.desktopKeys.has("w")) forward += amount;
      if (this.desktopKeys.has("arrowdown") || this.desktopKeys.has("s")) forward -= amount;
      if (this.desktopKeys.has("a")) strafe -= amount;
      if (this.desktopKeys.has("d")) strafe += amount;
      if (this.desktopKeys.has("arrowleft")) yawDelta += 80 * deltaSeconds;
      if (this.desktopKeys.has("arrowright")) yawDelta -= 80 * deltaSeconds;
      if (this.desktopKeys.has("q")) vertical -= amount;
      if (this.desktopKeys.has("e")) vertical += amount;
      if (!forward && !strafe && !vertical && !yawDelta) return;
      if (yawDelta) this.settings.roomViewYaw = normalizeDegrees(this.settings.roomViewYaw + yawDelta);
      const yaw = THREE.MathUtils.degToRad(this.settings.roomViewYaw);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const forwardX = -Math.sin(yaw);
      const forwardZ = -Math.cos(yaw);
      this.settings.roomViewX = clampNumber(
        this.settings.roomViewX + rightX * strafe + forwardX * forward,
        THEATER_SETTING_LIMITS.roomViewX[0],
        THEATER_SETTING_LIMITS.roomViewX[1],
        DEFAULT_SETTINGS.roomViewX,
      );
      this.settings.roomViewY = clampNumber(
        this.settings.roomViewY + vertical,
        THEATER_SETTING_LIMITS.roomViewY[0],
        THEATER_SETTING_LIMITS.roomViewY[1],
        DEFAULT_SETTINGS.roomViewY,
      );
      this.settings.roomViewZ = clampNumber(
        this.settings.roomViewZ + rightZ * strafe + forwardZ * forward,
        THEATER_SETTING_LIMITS.roomViewZ[0],
        THEATER_SETTING_LIMITS.roomViewZ[1],
        DEFAULT_SETTINGS.roomViewZ,
      );
      this.updateDesktopCamera();
    },

    updateDesktopCamera() {
      if (!this.camera || this.xrSession) return;
      this.updateWorldOffset();
      if (this.theaterMode === "lite") {
        this.camera.fov = 60;
        this.camera.position.set(0, 0, 0);
        this.camera.rotation.set(0, 0, 0);
        this.camera.updateProjectionMatrix();
        return;
      }
      const desktopConfig = isPlainObject(this.currentTheme().desktop) ? this.currentTheme().desktop : {};
      const fov = clampNumber(Number(desktopConfig.fov), 45, 90, 60);
      if (this.camera.fov !== fov) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
      const avatarViewpointAnchor = typeof this.avatarViewpointAnchor === "function"
        ? this.avatarViewpointAnchor()
        : null;
      if (avatarViewpointAnchor?.headPosition) {
        this.camera.position.copy(avatarViewpointAnchor.headPosition);
      } else {
        this.camera.position.set(this.settings.roomViewX, this.settings.roomViewY, this.settings.roomViewZ);
      }
      this.camera.rotation.set(
        THREE.MathUtils.degToRad(this.settings.roomViewPitch),
        avatarViewpointAnchor?.headPosition
          ? Number(avatarViewpointAnchor.bodyYaw || 0)
          : THREE.MathUtils.degToRad(this.settings.roomViewYaw),
        0,
      );
    },

    updateWorldOffset() {
      if (!this.worldGroup) return;
      const offsetForXr = Boolean(this.xrSession && this.xrSessionMode !== "immersive-ar" && this.theaterMode !== "lite");
      if (!offsetForXr) {
        this.worldGroup.position.set(0, 0, 0);
        this.worldGroup.rotation.set(0, 0, 0);
        return;
      }
      const avatarViewpointAnchor = typeof this.avatarViewpointAnchor === "function"
        ? this.avatarViewpointAnchor()
        : null;
      const targetPosition = avatarViewpointAnchor?.headPosition || {
        x: Number(this.settings.roomViewX || 0),
        y: 0,
        z: Number(this.settings.roomViewZ || 0),
      };
      const yaw = avatarViewpointAnchor?.headPosition
        ? Number(avatarViewpointAnchor.bodyYaw || 0)
        : THREE.MathUtils.degToRad(this.settings.roomViewYaw || 0);
      const inverseOffset = new THREE.Vector3(
        -Number(targetPosition.x || 0),
        0,
        -Number(targetPosition.z || 0),
      ).applyAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
      let yOffset = 0;
      if (avatarViewpointAnchor?.headPosition) {
        const xrCamera = this.renderer?.xr?.getCamera?.(this.camera);
        xrCamera?.updateMatrixWorld?.(true);
        const sceneHeadPosition = xrCamera
          ? new THREE.Vector3().setFromMatrixPosition(xrCamera.matrixWorld)
          : null;
        if (sceneHeadPosition && Number.isFinite(sceneHeadPosition.y) && sceneHeadPosition.y > 0.05) {
          yOffset = sceneHeadPosition.y - Number(targetPosition.y || 0);
        }
      }
      this.worldGroup.position.set(inverseOffset.x, yOffset, inverseOffset.z);
      this.worldGroup.rotation.set(0, -yaw, 0);
    }
  });
})();
