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
    initXrControllers() {
      if (!this.renderer || !this.scene) return;
      const lineGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1),
      ]);
      for (let index = 0; index < 2; index += 1) {
        const controller = this.renderer.xr.getController(index);
        controller.userData.index = index;
        controller.addEventListener("connected", (event) => {
          controller.userData.inputSource = event.data;
        });
        controller.addEventListener("selectstart", () => this.handleControllerSelect(controller));
        controller.addEventListener("squeezestart", () => this.startScreenGrab(controller));
        controller.addEventListener("squeezeend", () => this.endScreenGrab(controller));
        controller.addEventListener("disconnected", () => {
          controller.userData.inputSource = null;
          this.endScreenGrab(controller);
        });
        const line = new THREE.Line(
          lineGeometry.clone(),
          new THREE.LineBasicMaterial({ color: index === 0 ? 0x93c5fd : 0xf8fafc, transparent: true, opacity: 0.72 }),
        );
        line.name = "screen-ray";
        line.scale.z = 3;
        controller.add(line);
        this.scene.add(controller);
        this.controllers.push(controller);
        this.controllerLines.push(line);
        if (this.renderer.xr.getHand) {
          const hand = this.renderer.xr.getHand(index);
          hand.userData.index = index;
          hand.addEventListener("connected", (event) => {
            hand.userData.inputSource = event.data;
          });
          hand.addEventListener("disconnected", () => {
            hand.userData.inputSource = null;
          });
          this.scene.add(hand);
          this.hands.push(hand);
        }
      }
    },

    handleControllerSelect(controller) {
      if (this.activateXrSidePanelHotspot(controller)) {
        this.pulseController(controller);
        return;
      }
      if (this.activateThemeInteractionForController(controller)) {
        this.pulseController(controller);
        return;
      }
      this.toggleSidePanel();
      this.pulseController(controller);
    },

    activateXrSidePanelHotspot(controller) {
      if (!this.xrSession || !this.xrSidePanelMesh?.visible || !this.xrRaycaster || !this.xrControllerRayMatrix) return false;
      const hit = this.sidePanelHitForController(controller);
      if (!hit?.uv) return false;
      const x = hit.uv.x * XR_SIDE_PANEL_LOGICAL_SIZE;
      const y = (1 - hit.uv.y) * XR_SIDE_PANEL_LOGICAL_SIZE;
      const hotspot = this.xrSidePanelHotspots.find((item) => (
        x >= item.x
        && x <= item.x + item.width
        && y >= item.y
        && y <= item.y + item.height
      ));
      if (!hotspot) return false;
      this.activateXrHotspot(hotspot);
      this.updateXrSidePanelTexture(true);
      return true;
    },

    sidePanelHitForController(controller) {
      this.xrControllerRayMatrix.identity().extractRotation(controller.matrixWorld);
      this.xrRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      this.xrRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.xrControllerRayMatrix);
      return this.xrRaycaster.intersectObject(this.xrSidePanelMesh, false)[0] || null;
    },

    activateThemeInteractionForController(controller) {
      if (!this.xrSession || !this.xrRaycaster || !this.xrControllerRayMatrix || !this.themeInteractiveObjects.length) return false;
      this.xrControllerRayMatrix.identity().extractRotation(controller.matrixWorld);
      this.xrRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      this.xrRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.xrControllerRayMatrix);
      const hit = this.xrRaycaster.intersectObjects(this.themeInteractiveObjects.filter((object) => object.visible), true)[0];
      if (!hit?.object?.userData?.themeInteractive) return false;
      return this.activateThemeObjectInteraction(hit.object);
    },

    activateThemeObjectInteraction(object) {
      const config = object?.userData?.themeConfig || {};
      const interaction = isPlainObject(config.interaction) ? config.interaction : null;
      if (!interaction) return false;
      const action = String(interaction.action || interaction.type || "toggleSetting");
      if (action === "toggleSetting" || action === "toggle") {
        const setting = interaction.setting;
        if (!setting) return false;
        const definition = this.themeSettingDefinition(setting);
        const current = this.themeSettingValue(setting, definition?.default ?? false);
        this.setThemeSettingValue(setting, !Boolean(current));
        return true;
      }
      if (action === "incrementSetting" || action === "dim") {
        const setting = interaction.setting;
        if (!setting) return false;
        const definition = this.themeSettingDefinition(setting) || {};
        const current = Number(this.themeSettingValue(setting, definition.default ?? 0));
        const step = Number(interaction.step ?? definition.step ?? 0.1);
        const min = Number(definition.min ?? 0);
        const max = Number(definition.max ?? 1);
        const next = current + step > max && interaction.wrap !== false ? min : clampNumber(current + step, min, max, current);
        this.setThemeSettingValue(setting, next);
        return true;
      }
      if (action === "toggleVisible") {
        const target = this.themeObjectById.get(String(interaction.target || ""));
        if (!target) return false;
        target.visible = !target.visible;
        return true;
      }
      return false;
    },

    activateXrHotspot(hotspot) {
      const sizeStep = 0.2;
      const intensityStep = 10;
      const dimStep = 10;
      const curveStep = 10;
      if (hotspot.action === "play") {
        this.togglePlayback();
      } else if (hotspot.action === "mute-video") {
        this.video.muted = !this.video.muted;
        this.updatePlaybackControls();
      } else if (hotspot.action === "spatial-audio-toggle") {
        this.setSpatialAudioEnabled(!this.settings.spatialAudio);
      } else if (hotspot.action === "recenter") {
        this.recenterScreen();
      } else if (hotspot.action === "size-down") {
        this.updatePanelSize("width", this.settings.panelWidth - sizeStep);
      } else if (hotspot.action === "size-up") {
        this.updatePanelSize("width", this.settings.panelWidth + sizeStep);
      } else if (hotspot.action === "curve-down") {
        this.updateNumericSetting("screenCurve", this.settings.screenCurve - curveStep);
      } else if (hotspot.action === "curve-up") {
        this.updateNumericSetting("screenCurve", this.settings.screenCurve + curveStep);
      } else if (hotspot.action === "intensity-down") {
        this.updateNumericSetting("backlightIntensity", this.settings.backlightIntensity - intensityStep);
      } else if (hotspot.action === "intensity-up") {
        this.updateNumericSetting("backlightIntensity", this.settings.backlightIntensity + intensityStep);
      } else if (hotspot.action === "dim-down") {
        this.updateNumericSetting("roomDim", this.settings.roomDim - dimStep);
      } else if (hotspot.action === "dim-up") {
        this.updateNumericSetting("roomDim", this.settings.roomDim + dimStep);
      } else if (hotspot.action === "backlight-cycle") {
        const nextMode = this.settings.backlightMode === "off"
          ? "soft"
          : this.settings.backlightMode === "soft" ? "dynamic" : this.settings.backlightMode === "dynamic" ? "video" : "off";
        this.settings.backlightMode = nextMode;
        this.saveSettings();
        this.syncOverlayControls();
        this.updateBacklight(true);
      } else if (hotspot.action === "free-roam-toggle") {
        this.settings.freeRoam = !this.settings.freeRoam;
        this.saveSettings();
        this.syncOverlayControls();
        this.updateXrSidePanelTexture(true);
      } else if (hotspot.action === "avatar-toggle") {
        this.setAvatarEnabled(!this.settings.avatarEnabled);
      } else if (hotspot.action === "avatar-view-toggle") {
        this.setAvatarViewpoint(!this.settings.avatarViewpoint);
      } else if (hotspot.action === "avatar-mirror-toggle") {
        if (!this.settings.avatarEnabled) this.setAvatarEnabled(true);
        this.setAvatarMirrorEnabled(!this.settings.avatarMirror);
      } else if (hotspot.action === "avatar-pin-toggle") {
        if (!this.settings.avatarEnabled) this.setAvatarEnabled(true);
        this.setAvatarPinned(!this.settings.avatarPinned);
      } else if (hotspot.action === "seat-cycle") {
        this.cycleSeatingPosition();
      } else if (hotspot.action === "dom-click" && hotspot.element) {
        hotspot.element.click();
      }
    },

    pulseController(controller) {
      const actuator = controller.userData.inputSource?.gamepad?.hapticActuators?.[0];
      if (actuator?.pulse) {
        actuator.pulse(0.35, 35).catch(() => {});
      }
    },

    pulseControllerSeek(controller) {
      const actuator = controller.userData.inputSource?.gamepad?.hapticActuators?.[0];
      if (actuator?.pulse) {
        actuator.pulse(0.22, 28).catch(() => {});
      }
    },

    startScreenGrab(controller) {
      if (!this.screenGroup || !this.xrSession) return;
      this.activeGrab = {
        controller,
        controllerStart: new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld),
        screenStart: this.screenGroup.position.clone(),
      };
      this.updateInlineStatus("Grip held: move the controller to place the screen.");
    },

    endScreenGrab(controller) {
      if (!this.activeGrab || this.activeGrab.controller !== controller) return;
      this.activeGrab = null;
      this.settings.panelX = clampNumber(this.screenGroup.position.x, -3, 3, DEFAULT_SETTINGS.panelX);
      this.settings.panelY = clampNumber(this.screenGroup.position.y, -1.4, 1.4, DEFAULT_SETTINGS.panelY);
      this.settings.distance = clampNumber(Math.abs(this.screenGroup.position.z), 1.4, 6, DEFAULT_SETTINGS.distance);
      this.saveSettings();
      this.syncOverlayControls();
    },

    updateControllerDrag() {
      if (!this.activeGrab || !this.screenGroup) return;
      const current = new THREE.Vector3().setFromMatrixPosition(this.activeGrab.controller.matrixWorld);
      const delta = current.sub(this.activeGrab.controllerStart);
      if (this.worldGroup) delta.applyQuaternion(this.worldGroup.quaternion.clone().invert());
      const next = this.activeGrab.screenStart.clone().add(delta);
      next.x = clampNumber(next.x, -3, 3, DEFAULT_SETTINGS.panelX);
      next.y = clampNumber(next.y, -1.4, 1.4, DEFAULT_SETTINGS.panelY);
      next.z = -clampNumber(Math.abs(next.z), 1.4, 6, DEFAULT_SETTINGS.distance);
      this.screenGroup.position.copy(next);
    },

    updateXrThumbstickScrub(now = performance.now()) {
      if (!this.xrSession || !this.controllers.length) {
        this.xrThumbstickSeekDirection = 0;
        return;
      }
      const controller = this.controllers.find((item) => item.userData.inputSource?.handedness === "left")
        || this.controllers.find((item) => !item.userData.inputSource?.handedness && item.userData.index === 0);
      const axis = this.thumbstickHorizontalAxis(controller);
      if (Math.abs(axis) < XR_THUMBSTICK_SEEK_RESET_ZONE) {
        this.xrThumbstickSeekDirection = 0;
        return;
      }
      if (Math.abs(axis) < XR_THUMBSTICK_SEEK_DEADZONE) return;
      const direction = axis > 0 ? 1 : -1;
      const repeatReady = now - this.xrThumbstickSeekAt >= XR_THUMBSTICK_SEEK_REPEAT_MS;
      if (this.xrThumbstickSeekDirection === direction && !repeatReady) return;
      this.xrThumbstickSeekDirection = direction;
      this.xrThumbstickSeekAt = now;
      this.seekVideoBy(direction * XR_THUMBSTICK_SEEK_SECONDS);
      if (controller) this.pulseControllerSeek(controller);
    },

    updateXrSeatingControls(deltaSeconds, now = performance.now()) {
      if (!this.xrSession || !this.controllers.length) {
        this.xrRoamThumbstickActive = false;
        this.xrButtonState = {};
        return;
      }
      const rightController = this.controllers.find((item) => item.userData.inputSource?.handedness === "right")
        || this.controllers.find((item) => item.userData.index === 1);
      this.updateXrSeatCycleButton(rightController);
      if (!this.settings.freeRoam || this.xrSessionMode === "immersive-ar") {
        this.xrRoamThumbstickActive = false;
        return;
      }
      this.updateXrFreeRoam(rightController, deltaSeconds, now);
    },

    updateXrSeatCycleButton(controller) {
      const gamepad = controller?.userData?.inputSource?.gamepad;
      const pressed = Boolean(gamepad?.buttons?.[5]?.pressed);
      const key = `seat-cycle:${controller?.userData?.index ?? "right"}`;
      const wasPressed = Boolean(this.xrButtonState[key]);
      this.xrButtonState[key] = pressed;
      if (!pressed || wasPressed) return;
      if (this.cycleSeatingPosition() && controller) this.pulseController(controller);
    },

    updateXrFreeRoam(controller, deltaSeconds, now = performance.now()) {
      const axes = this.thumbstickAxes(controller);
      const strafeAxis = Math.abs(axes.x) > 0.18 ? axes.x : 0;
      const forwardAxis = Math.abs(axes.y) > 0.18 ? -axes.y : 0;
      if (!strafeAxis && !forwardAxis) {
        if (this.xrRoamThumbstickActive) this.saveSettings();
        this.xrRoamThumbstickActive = false;
        return;
      }
      this.xrRoamThumbstickActive = true;
      const speed = 1.15;
      const amount = Math.min(0.08, Math.max(0, deltaSeconds || 0)) * speed;
      const yaw = THREE.MathUtils.degToRad(this.settings.roomViewYaw || 0);
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const forwardX = -Math.sin(yaw);
      const forwardZ = -Math.cos(yaw);
      this.settings.roomViewX = clampNumber(
        this.settings.roomViewX + rightX * strafeAxis * amount + forwardX * forwardAxis * amount,
        THEATER_SETTING_LIMITS.roomViewX[0],
        THEATER_SETTING_LIMITS.roomViewX[1],
        DEFAULT_SETTINGS.roomViewX,
      );
      this.settings.roomViewZ = clampNumber(
        this.settings.roomViewZ + rightZ * strafeAxis * amount + forwardZ * forwardAxis * amount,
        THEATER_SETTING_LIMITS.roomViewZ[0],
        THEATER_SETTING_LIMITS.roomViewZ[1],
        DEFAULT_SETTINGS.roomViewZ,
      );
      if (now - this.xrRoamSavedAt > 900) {
        this.xrRoamSavedAt = now;
        this.saveSettings();
        this.syncOverlayControls();
      }
    },

    thumbstickHorizontalAxis(controller) {
      const axes = controller?.userData?.inputSource?.gamepad?.axes;
      if (!axes?.length) return 0;
      let best = 0;
      for (const index of [2, 0]) {
        const value = Number(axes[index] || 0);
        if (Math.abs(value) > Math.abs(best)) best = value;
      }
      return best;
    },

    thumbstickAxes(controller) {
      const axes = controller?.userData?.inputSource?.gamepad?.axes;
      if (!axes?.length) return { x: 0, y: 0 };
      return {
        x: Math.abs(Number(axes[2] || 0)) >= Math.abs(Number(axes[0] || 0)) ? Number(axes[2] || 0) : Number(axes[0] || 0),
        y: Math.abs(Number(axes[3] || 0)) >= Math.abs(Number(axes[1] || 0)) ? Number(axes[3] || 0) : Number(axes[1] || 0),
      };
    },

    seekVideoBy(seconds) {
      const duration = Number(this.video.duration || 0);
      if (!duration || !Number.isFinite(duration)) return;
      const currentTime = Number(this.video.currentTime || 0);
      this.video.currentTime = clampNumber(currentTime + seconds, 0, duration, currentTime);
      this.updatePlaybackControls();
      this.updateXrSidePanelTexture(true);
    },

    async enterWebXr() {
      if (!this.renderer) return;
      if (!this.xrSupported) {
        this.updateInlineStatus("WebXR immersive VR is unavailable in this browser.");
        return;
      }
      let session = null;
      try {
        await this.video.play().catch(() => {});
        if (this.settings.spatialAudio) {
          await this.spatialAudioGraph?.context?.resume?.().catch(() => {});
        }
        this.applyXrFramebufferScale();
        const sessionMode = this.settings.headsetMode === "mr" && this.xrArSupported ? "immersive-ar" : "immersive-vr";
        session = await this.requestImmersiveSession(sessionMode);
        this.xrSession = session;
        this.xrSessionMode = sessionMode;
        this.xrSessionEndHandler = () => {
          this.xrSession = null;
          this.xrSessionMode = "";
          this.xrSessionEndHandler = null;
          this.activeGrab = null;
          this.xrRoamThumbstickActive = false;
          this.xrButtonState = {};
          this.desktopKeys.clear();
          this.updateWorldOffset();
          this.updateDesktopCamera();
          this.updateSceneLighting();
          this.syncOverlayControls();
        };
        session.addEventListener("end", this.xrSessionEndHandler, { once: true });
        await this.renderer.xr.setSession(session);
        this.updateWorldOffset();
        this.updateXrSidePanelGeometry();
        this.updateXrSidePanelTexture(true);
        this.updateSceneLighting();
        this.syncOverlayControls();
      } catch (error) {
        if (session && this.xrSession === session) {
          session.removeEventListener("end", this.xrSessionEndHandler);
          this.xrSession = null;
          this.xrSessionMode = "";
          this.xrSessionEndHandler = null;
          session.end().catch(() => {});
        }
        this.updateInlineStatus(error.message || "Could not enter WebXR.");
        this.syncOverlayControls();
      }
    },

    applyXrFramebufferScale() {
      if (!this.renderer?.xr?.setFramebufferScaleFactor) return;
      const theme = this.currentTheme();
      const render = isPlainObject(theme.render) ? theme.render : {};
      const scale = clampNumber(Number(render.xrFramebufferScale ?? 1), 0.6, 1.25, 1);
      this.renderer.xr.setFramebufferScaleFactor(scale);
    },

    async requestImmersiveSession(sessionMode) {
      if (!navigator.xr) throw new Error("WebXR is unavailable in this browser.");
      const optionalFeatures = sessionMode === "immersive-ar"
        ? ["local-floor", "bounded-floor", "dom-overlay", "hit-test", "hand-tracking"]
        : ["local-floor", "bounded-floor", "dom-overlay", "hand-tracking"];
      try {
        return await navigator.xr.requestSession(sessionMode, {
          optionalFeatures,
          domOverlay: { root: this.overlay },
        });
      } catch (overlayError) {
        try {
          return await navigator.xr.requestSession(sessionMode, {
            optionalFeatures: optionalFeatures.filter((feature) => feature !== "dom-overlay"),
          });
        } catch (plainError) {
          throw plainError || overlayError;
        }
      }
    },

    initXrSidePanel() {
      this.xrSidePanelCanvas = document.createElement("canvas");
      this.xrSidePanelCanvas.width = XR_SIDE_PANEL_TEXTURE_SIZE;
      this.xrSidePanelCanvas.height = XR_SIDE_PANEL_TEXTURE_SIZE;
      this.xrSidePanelContext = this.xrSidePanelCanvas.getContext("2d");
      this.xrSidePanelTexture = new THREE.CanvasTexture(this.xrSidePanelCanvas);
      this.xrSidePanelTexture.colorSpace = THREE.SRGBColorSpace;
      this.xrSidePanelTexture.minFilter = THREE.LinearMipmapLinearFilter;
      this.xrSidePanelTexture.magFilter = THREE.LinearFilter;
      this.xrSidePanelTexture.generateMipmaps = true;
      this.xrSidePanelTexture.anisotropy = Math.min(8, this.renderer?.capabilities?.getMaxAnisotropy?.() || 1);
      const material = new THREE.MeshBasicMaterial({
        map: this.xrSidePanelTexture,
        side: THREE.DoubleSide,
        transparent: true,
      });
      this.xrSidePanelMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      this.xrSidePanelMesh.visible = false;
      this.xrSidePanelMesh.renderOrder = 3;
      this.screenGroup.add(this.xrSidePanelMesh);
      this.updateXrSidePanelGeometry();
      this.updateXrSidePanelTexture(true);
    },

    updateXrSidePanelGeometry() {
      if (!this.xrSidePanelMesh) return;
      const sideWidth = clampNumber(this.settings.panelWidth * 0.48, 1.25, 2.05, 1.55);
      const sideHeight = clampNumber(this.settings.panelHeight, 1.05, 3.2, 1.8);
      const gap = 0.38;
      const panelAngle = XR_SIDE_PANEL_ANGLE;
      const leftEdgeZ = 0.08;
      this.xrSidePanelMesh.scale.set(sideWidth, sideHeight, 1);
      this.xrSidePanelMesh.position.set(
        this.settings.panelWidth / 2 + gap + Math.cos(panelAngle) * (sideWidth / 2),
        0,
        leftEdgeZ - Math.sin(panelAngle) * (sideWidth / 2),
      );
      this.xrSidePanelMesh.rotation.set(0, panelAngle, 0);
    },

    updateXrSidePanelTexture(force = false) {
      if (!this.xrSidePanelContext || !this.xrSidePanelTexture) return;
      const now = performance.now();
      if (this.xrSidePanelMesh) this.xrSidePanelMesh.visible = Boolean(this.xrSession && this.settings.sidePanelVisible);
      if (!force && now - this.lastSidePanelTextureAt < 500) return;
      this.lastSidePanelTextureAt = now;

      const context = this.xrSidePanelContext;
      const textureScale = this.xrSidePanelCanvas.width / XR_SIDE_PANEL_LOGICAL_SIZE;
      const width = XR_SIDE_PANEL_LOGICAL_SIZE;
      const height = XR_SIDE_PANEL_LOGICAL_SIZE;
      const lines = this.collectSidePanelLines();
      const hotspots = [];
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, this.xrSidePanelCanvas.width, this.xrSidePanelCanvas.height);
      context.setTransform(textureScale, 0, 0, textureScale, 0, 0);
      context.fillStyle = "rgba(8, 13, 24, 0.94)";
      roundRect(context, 0, 0, width, height, 44);
      context.fill();
      context.strokeStyle = "rgba(148, 197, 255, 0.45)";
      context.lineWidth = 5;
      context.stroke();

      context.fillStyle = "#f8fafc";
      context.font = "700 54px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      context.fillText("Voice & Room", 56, 92);
      context.fillStyle = "rgba(248, 250, 252, 0.62)";
      context.font = "700 28px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      context.fillText("Trigger selects. B cycles seats. Right stick roams.", 56, 136);

      let y = 205;
      for (const line of lines.slice(0, 18)) {
        if (line.kind === "header") {
          context.fillStyle = "#93c5fd";
          context.font = "800 34px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
          y += y > 205 ? 28 : 0;
          context.fillText(line.text, 56, y);
          y += 52;
        } else {
          context.fillStyle = "rgba(248, 250, 252, 0.88)";
          context.font = "500 29px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
          for (const wrapped of wrapCanvasText(context, line.text, 900)) {
            context.fillText(wrapped, 70, y);
            y += 42;
            if (y > height - 352) break;
          }
        }
        if (y > height - 352) break;
      }

      const buttonWidth = 292;
      const buttonHeight = 58;
      const gap = 18;
      const startX = 56;
      const baseY = height - 296;
      const buttons = [
        { label: this.video.paused ? "Play" : "Pause", action: "play" },
        { label: this.video.muted || this.video.volume === 0 ? "Unmute video" : "Mute video", action: "mute-video" },
        { label: this.settings.spatialAudio ? "Audio 3D off" : "Audio 3D on", action: "spatial-audio-toggle" },
        { label: "Recenter", action: "recenter" },
        { label: "Size -", action: "size-down" },
        { label: "Size +", action: "size-up" },
        { label: `Backlight ${this.backlightModeLabel()}`, action: "backlight-cycle" },
        { label: this.settings.freeRoam ? "Free roam off" : "Free roam on", action: "free-roam-toggle" },
        { label: this.settings.avatarEnabled ? "Avatar off" : "Avatar on", action: "avatar-toggle" },
        { label: this.settings.avatarViewpoint ? "Body view off" : "Body view on", action: "avatar-view-toggle" },
        { label: this.settings.avatarMirror ? "Mirror off" : "Mirror on", action: "avatar-mirror-toggle" },
        { label: this.settings.avatarPinned ? "Unpin body" : "Pin body", action: "avatar-pin-toggle" },
        { label: "Next seat", action: "seat-cycle" },
        { label: "Light -", action: "intensity-down" },
        { label: "Light +", action: "intensity-up" },
        { label: "Room dim -", action: "dim-down" },
        { label: "Room dim +", action: "dim-up" },
        { label: "Curve +", action: "curve-up" },
        ...this.collectVoiceActionButtons().slice(0, 2),
      ];
      buttons.slice(0, 12).forEach((button, index) => {
        const col = index % 3;
        const row = Math.floor(index / 3);
        const rect = {
          x: startX + col * (buttonWidth + gap),
          y: baseY + row * (buttonHeight + gap),
          width: buttonWidth,
          height: buttonHeight,
        };
        drawXrPanelButton(context, rect, button.label);
        hotspots.push({ ...rect, action: button.action, element: button.element || null });
      });
      this.xrSidePanelHotspots = hotspots;

      context.fillStyle = "rgba(248, 250, 252, 0.48)";
      context.font = "600 24px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      context.fillText("Microphone and output device selection still use the browser panel.", 56, height - 28);
      this.xrSidePanelTexture.needsUpdate = true;
    },

    backlightModeLabel() {
      if (this.settings.backlightMode === "video") return "Video";
      if (this.settings.backlightMode === "dynamic") return "Dynamic";
      if (this.settings.backlightMode === "soft") return "Soft";
      return "Off";
    },

    collectSidePanelLines() {
      if (!this.sidePanel) {
        return [
          { kind: "header", text: "Status" },
          { kind: "text", text: "No side panel is attached to this player." },
        ];
      }
      const cards = [
        ...Array.from(this.sidePanel.querySelectorAll(".voice-chat-card")),
        ...Array.from(this.sidePanel.querySelectorAll(".card:not(.voice-chat-card)")).slice(0, 3),
      ];
      const output = [];
      for (const card of cards) {
        const header = cleanPanelText(card.querySelector(".card-header")?.textContent || "Panel");
        output.push({ kind: "header", text: header });
        const candidates = Array.from(card.querySelectorAll(".list-group-item, .form-text, .badge, label, button"))
          .map((node) => cleanPanelText(node.textContent || ""))
          .filter(Boolean);
        const seen = new Set();
        for (const candidate of candidates) {
          if (candidate.length < 2 || seen.has(candidate)) continue;
          seen.add(candidate);
          output.push({ kind: "text", text: candidate });
          if (seen.size >= 5) break;
        }
      }
      return output.length
        ? output
        : [
            { kind: "header", text: "Status" },
            { kind: "text", text: "Voice controls are available on the page side panel." },
          ];
    },

    collectVoiceActionButtons() {
      if (!this.sidePanel) return [];
      const actions = [];
      const seen = new Set();
      for (const element of Array.from(this.sidePanel.querySelectorAll("button"))) {
        if (element.disabled || element.hidden || element.offsetParent === null) continue;
        const label = cleanPanelText(element.textContent || "");
        if (!label || seen.has(label)) continue;
        if (!/voice|mic|mute|unmute|host|enable|stop/i.test(label)) continue;
        seen.add(label);
        actions.push({
          label: label.length > 22 ? `${label.slice(0, 21).trim()}...` : label,
          action: "dom-click",
          element,
        });
        if (actions.length >= 4) break;
      }
      return actions;
    }
  });
})();
