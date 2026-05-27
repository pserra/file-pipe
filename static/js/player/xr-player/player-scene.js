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
    initThree() {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setClearAlpha(0);
      if (THREE.SRGBColorSpace) this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      if (THREE.ACESFilmicToneMapping) this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1;
      if (this.renderer.shadowMap) {
        this.renderer.shadowMap.enabled = false;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap || THREE.PCFShadowMap;
      }
      this.renderer.xr.enabled = true;
      this.renderer.xr.setReferenceSpaceType("local-floor");
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      this.camera.rotation.order = "YXZ";
      this.camera.position.set(0, 0, 0);
      this.scene.add(this.camera);
      this.initMrDimLayer();
      this.xrRaycaster = new THREE.Raycaster();
      this.xrControllerRayMatrix = new THREE.Matrix4();
      this.themeRaycaster = new THREE.Raycaster();
      this.themePointer = new THREE.Vector2();
      this.baseAmbientLight = new THREE.AmbientLight(0xffffff, 0.55);
      this.scene.add(this.baseAmbientLight);
      this.worldGroup = new THREE.Group();
      this.worldGroup.name = "xr-theater-world";
      this.scene.add(this.worldGroup);
      this.screenGroup = new THREE.Group();
      this.worldGroup.add(this.screenGroup);
      this.screenSurfaceGroup = new THREE.Group();
      this.screenGroup.add(this.screenSurfaceGroup);
      this.themeGroup = new THREE.Group();
      this.worldGroup.add(this.themeGroup);
      this.avatarGroup = new THREE.Group();
      this.avatarGroup.name = "xr-theater-avatars";
      this.worldGroup.add(this.avatarGroup);
      this.videoTexture = new THREE.VideoTexture(this.video);
      this.videoTexture.colorSpace = THREE.SRGBColorSpace;
      this.videoTexture.minFilter = THREE.LinearFilter;
      this.videoTexture.magFilter = THREE.LinearFilter;
      this.videoTexture.generateMipmaps = false;
      const material = this.createVideoMaterial();
      this.videoMesh = new THREE.Mesh(this.createVideoGeometry(), material);
      this.videoMesh.renderOrder = 2;
      this.videoMesh.onBeforeRender = (_renderer, _scene, camera) => this.applyVideoTextureUvForCamera(camera);
      this.screenSurfaceGroup.add(this.videoMesh);
      this.initBacklight();
      if (this.theaterMode !== "lite") {
        this.initXrSidePanel();
        this.initXrControllers();
        this.applyTheme();
      }
      this.updateSceneLighting();
      this.updateDesktopCamera();
      this.updateWorldOffset();
    },

    createVideoMaterial() {
      if (this.localDepthAdapter?.isEnabled?.() && this.videoTexture) {
        this.localDepthMaterial?.dispose?.();
        this.localDepthMaterial = this.localDepthAdapter.createThreeMaterial(this.videoTexture, { outputMode: "eye" });
        return this.localDepthMaterial;
      }
      this.localDepthMaterial = null;
      return new THREE.MeshBasicMaterial({ map: this.videoTexture, side: THREE.DoubleSide, transparent: true, opacity: 1 });
    },

    updateVideoMaterial() {
      if (!this.videoMesh || !this.videoTexture || !window.THREE) return;
      const previousMaterial = this.videoMesh.material;
      this.videoMesh.material = this.createVideoMaterial();
      if (previousMaterial && previousMaterial !== this.videoMesh.material) previousMaterial.dispose?.();
      this.updateVideoMaterialUv();
    },

    initMrDimLayer() {
      if (!this.camera) return;
      const material = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.mrDimMesh = new THREE.Mesh(new THREE.PlaneGeometry(240, 160), material);
      this.mrDimMesh.name = "mr-room-dim-overlay";
      this.mrDimMesh.visible = false;
      this.mrDimMesh.renderOrder = MR_DIM_RENDER_ORDER;
      this.mrDimMesh.position.set(0, 0, -80);
      this.camera.add(this.mrDimMesh);
    },

    updateSceneLighting() {
      if (!this.scene) return;
      if (this.theaterMode === "lite") {
        this.scene.background = new THREE.Color(0x000000);
        if (this.gridMesh) this.gridMesh.visible = false;
        if (this.themeGroup) this.themeGroup.visible = false;
        if (this.mrDimMesh) this.mrDimMesh.visible = false;
        return;
      }
      const dim = clampNumber(Number(this.settings.roomDim), 0, 100, DEFAULT_SETTINGS.roomDim) / 100;
      const mrActive = this.xrSessionMode === "immersive-ar";
      const theme = this.currentTheme();
      const render = isPlainObject(theme.render) ? theme.render : {};
      if (this.baseAmbientLight) {
        this.baseAmbientLight.intensity = clampNumber(Number(render.globalAmbient ?? 0.55), 0, 2, 0.55);
      }
      if (this.renderer) {
        this.renderer.toneMappingExposure = clampNumber(Number(render.exposure ?? 1), 0.2, 2.5, 1);
        const allowXrShadows = render.xrShadows === true || render.shadowsInXr === true;
        const shadowsEnabled = Boolean(render.shadows) && (!this.xrSession || allowXrShadows);
        if (this.renderer.shadowMap) this.renderer.shadowMap.enabled = shadowsEnabled;
      }
      const background = colorFromTheme(theme.background, new THREE.Color(0.025, 0.03, 0.04));
      this.scene.background = mrActive ? null : new THREE.Color(
        background.r * dim,
        background.g * dim,
        background.b * dim,
      );
      if (this.gridMesh) this.gridMesh.visible = !mrActive && dim > 0.05;
      if (this.themeGroup) this.themeGroup.visible = !mrActive;
      if (this.mrDimMesh?.material) {
        const opacity = clampNumber((1 - dim) * 0.82, 0, 0.82, 0);
        this.mrDimMesh.visible = mrActive && opacity > 0.01;
        this.mrDimMesh.material.opacity = opacity;
      }
    },

    createVideoGeometry() {
      const curve = clampNumber(Number(this.settings.screenCurve), 0, 100, DEFAULT_SETTINGS.screenCurve) / 100;
      const warp = clampNumber(Number(this.settings.viewportWarp), 0, 100, DEFAULT_SETTINGS.viewportWarp) / 100;
      if (curve <= 0.001 && warp <= 0.001) return new THREE.PlaneGeometry(1, 1, 1, 1);
      const widthSegments = Math.round(lerp(18, 56, Math.max(curve, warp)));
      const heightSegments = Math.round(lerp(3, 18, warp));
      const geometry = new THREE.PlaneGeometry(1, 1, widthSegments, heightSegments);
      const positions = geometry.attributes.position;
      const halfAngle = THREE.MathUtils.degToRad(70 * curve) / 2;
      const sinHalfAngle = Math.max(0.001, Math.sin(halfAngle));
      const depthScale = clampNumber(Number(this.settings.panelWidth), 1.4, 6, DEFAULT_SETTINGS.panelWidth);
      for (let index = 0; index < positions.count; index += 1) {
        const u = positions.getX(index) + 0.5;
        const v = positions.getY(index) + 0.5;
        const nx = (u - 0.5) * 2;
        const ny = (v - 0.5) * 2;
        let x = positions.getX(index);
        let y = positions.getY(index);
        let z = 0;
        if (curve > 0.001) {
          const theta = nx * halfAngle;
          x = Math.sin(theta) / (2 * sinHalfAngle);
          z = ((1 - Math.cos(theta)) / (2 * sinHalfAngle)) * depthScale;
        }
        if (warp > 0.001) {
          const edge = Math.pow(Math.abs(ny), 1.4);
          const center = 1 - Math.min(1, nx * nx);
          const side = Math.min(1, Math.abs(nx));
          x *= 1 - warp * 0.07 * edge;
          y -= Math.sign(ny) * warp * 0.075 * center * edge;
          y *= 1 + warp * 0.035 * side * side;
          z += warp * 0.075 * (1 - Math.min(1, nx * nx)) * (1 - Math.min(1, ny * ny)) * depthScale;
        }
        positions.setX(index, x);
        positions.setY(index, y);
        positions.setZ(index, z);
      }
      positions.needsUpdate = true;
      geometry.computeVertexNormals();
      return geometry;
    },

    updateVideoGeometry() {
      if (!this.videoMesh) return;
      const geometryKey = [
        Number(this.settings.panelWidth).toFixed(3),
        Number(this.settings.screenCurve).toFixed(1),
        Number(this.settings.viewportWarp).toFixed(1),
      ].join(":");
      if (this.videoGeometryKey !== geometryKey) {
        const previousGeometry = this.videoMesh.geometry;
        this.videoMesh.geometry = this.createVideoGeometry();
        previousGeometry?.dispose?.();
        this.videoGeometryKey = geometryKey;
      }
      this.videoMesh.scale.set(this.settings.panelWidth, this.settings.panelHeight, 1);
      this.videoMesh.position.set(0, 0, 0);
      const lite = this.theaterMode === "lite";
      if (this.screenGroup) {
        this.screenGroup.position.set(lite ? 0 : this.settings.panelX, lite ? 0 : this.settings.panelY, -this.settings.distance);
        this.screenGroup.rotation.set(0, 0, 0);
      }
      if (this.screenSurfaceGroup) {
        this.screenSurfaceGroup.rotation.set(
          THREE.MathUtils.degToRad(lite ? 0 : this.settings.panelPitch),
          THREE.MathUtils.degToRad(lite ? 0 : this.settings.panelYaw),
          0,
        );
      }
      this.updateBacklightGeometry();
      this.updateXrSidePanelGeometry();
    },

    updateVideoMaterialUv() {
      this.applyVideoTextureUvForCamera(null);
    },

    applyVideoTextureUvForCamera(camera) {
      if (!this.videoTexture) return;
      this.videoTexture.offset.set(0, 0);
      this.videoTexture.repeat.set(1, 1);
      if (this.localDepthAdapter?.isEnabled?.() && this.videoMesh?.material === this.localDepthMaterial) {
        this.localDepthAdapter.setThreeEye?.(this.videoEyeForCamera(camera));
        this.videoTexture.needsUpdate = true;
        return;
      }
      if (this.settings.layout === "half-sbs") {
        this.videoTexture.repeat.set(0.5, 1);
        this.videoTexture.offset.set(this.videoEyeForCamera(camera) === "right" ? 0.5 : 0, 0);
      }
      if (this.settings.layout === "full-sbs") {
        this.videoTexture.repeat.set(0.5, 1);
        this.videoTexture.offset.set(this.videoEyeForCamera(camera) === "right" ? 0.5 : 0, 0);
      }
      this.videoTexture.needsUpdate = true;
    },

    videoEyeForCamera(camera) {
      if (!camera) return this.settings.eye;
      const viewport = camera.viewport;
      if (viewport && Number(viewport.x || 0) > 0) return "right";
      if (typeof camera.name === "string" && camera.name.toLowerCase().includes("right")) return "right";
      if (typeof camera.name === "string" && camera.name.toLowerCase().includes("left")) return "left";
      if (!this.xrSession && this.theaterMode !== "lite") return this.settings.eye;
      return "left";
    },

    updateRenderFallback(now = performance.now()) {
      if (!this.fallbackCanvas || !this.fallbackContext || !this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      if (this.fallbackCanvas.width !== width || this.fallbackCanvas.height !== height) {
        this.fallbackCanvas.width = width;
        this.fallbackCanvas.height = height;
      }
      if (!this.lastRenderSampleAt || now - this.lastRenderSampleAt > 550) {
        this.lastRenderSampleAt = now;
        this.fallbackActive = this.isRenderedCanvasBlank();
        this.fallbackCanvas.hidden = !this.fallbackActive;
      }
      if (this.fallbackActive) {
        this.drawRenderFallback(width, height);
      }
    },

    isRenderedCanvasBlank() {
      if (!this.canvas) return false;
      if (!this.renderSampleCanvas) {
        this.renderSampleCanvas = document.createElement("canvas");
        this.renderSampleCanvas.width = 24;
        this.renderSampleCanvas.height = 14;
        this.renderSampleContext = this.renderSampleCanvas.getContext("2d", { willReadFrequently: true });
      }
      const context = this.renderSampleContext;
      if (!context) return false;
      try {
        context.clearRect(0, 0, this.renderSampleCanvas.width, this.renderSampleCanvas.height);
        context.drawImage(this.canvas, 0, 0, this.renderSampleCanvas.width, this.renderSampleCanvas.height);
        const data = context.getImageData(0, 0, this.renderSampleCanvas.width, this.renderSampleCanvas.height).data;
        let litPixels = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index] + data[index + 1] + data[index + 2] > 24) litPixels += 1;
          if (litPixels > 8) return false;
        }
        return true;
      } catch (error) {
        return true;
      }
    },

    drawRenderFallback(width, height) {
      const context = this.fallbackContext;
      if (!context) return;
      context.clearRect(0, 0, width, height);
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "#070b12");
      gradient.addColorStop(0.55, "#101826");
      gradient.addColorStop(1, "#05070a");
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);

      const roomPad = Math.max(18, width * 0.035);
      const horizonY = height * 0.64;
      context.fillStyle = "rgba(31, 41, 55, 0.62)";
      context.beginPath();
      context.moveTo(roomPad, height);
      context.lineTo(width * 0.33, horizonY);
      context.lineTo(width * 0.67, horizonY);
      context.lineTo(width - roomPad, height);
      context.closePath();
      context.fill();
      context.strokeStyle = "rgba(148, 163, 184, 0.22)";
      context.lineWidth = 2;
      context.stroke();

      const panelWidth = Math.min(width * 0.68, height * 1.45);
      const panelHeight = panelWidth / Math.max(1.2, this.videoAspectRatio());
      const panelX = (width - panelWidth) / 2;
      const panelY = Math.max(height * 0.18, (height - panelHeight) * 0.42);
      context.shadowColor = "rgba(147, 197, 253, 0.48)";
      context.shadowBlur = 42;
      context.fillStyle = "#172033";
      context.fillRect(panelX - 14, panelY - 14, panelWidth + 28, panelHeight + 28);
      context.shadowBlur = 0;

      try {
        if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          context.drawImage(this.video, panelX, panelY, panelWidth, panelHeight);
        } else {
          context.fillStyle = "#0f172a";
          context.fillRect(panelX, panelY, panelWidth, panelHeight);
        }
      } catch (error) {
        context.fillStyle = "#0f172a";
        context.fillRect(panelX, panelY, panelWidth, panelHeight);
      }

      context.strokeStyle = "rgba(226, 232, 240, 0.86)";
      context.lineWidth = 2;
      context.strokeRect(panelX, panelY, panelWidth, panelHeight);
      context.fillStyle = "rgba(226, 232, 240, 0.9)";
      context.font = "700 13px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
      context.fillText("2D preview fallback", panelX + 12, panelY + panelHeight + 24);
    },

    displayedVideoSampleWindow(camera = null) {
      if (this.settings.layout === "half-sbs" || this.settings.layout === "full-sbs") {
        return this.videoEyeForCamera(camera) === "right"
          ? { x0: 0.5, x1: 1, y0: 0, y1: 1 }
          : { x0: 0, x1: 0.5, y0: 0, y1: 1 };
      }
      return { x0: 0, x1: 1, y0: 0, y1: 1 };
    },

    resizeRenderer() {
      if (!this.renderer || !this.canvas) return;
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      this.renderer.setSize(width, height, false);
      this.camera.aspect = this.theaterMode === "lite" ? Math.max(1, width / 2) / height : width / height;
      if (!this.xrSession) {
        if (this.theaterMode === "lite") {
          this.camera.fov = 60;
        } else {
          const desktopConfig = isPlainObject(this.currentTheme().desktop) ? this.currentTheme().desktop : {};
          this.camera.fov = clampNumber(Number(desktopConfig.fov), 45, 90, 60);
        }
      }
      this.camera.updateProjectionMatrix();
    },

    renderFrame() {
      if (!this.renderer || !this.scene || !this.camera) return;
      const now = performance.now();
      const deltaSeconds = this.lastRenderAt ? Math.min(0.05, (now - this.lastRenderAt) / 1000) : 0;
      this.lastRenderAt = now;
      try {
        if (this.videoTexture && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          this.videoTexture.needsUpdate = true;
        }
        this.localDepthAdapter?.updateFrame?.(now);
        this.updateControllerDrag();
        this.updateXrThumbstickScrub();
        this.updateXrSeatingControls(deltaSeconds, now);
        this.updateWorldOffset();
        this.updateBacklight();
        this.updateThemeVideoSampling();
        this.updateSpatialAudio();
        this.updateAvatarFrame(deltaSeconds, now);
        this.updateXrSidePanelTexture();
        this.updatePlaybackControls();
        this.updateThemeAnimations(now / 1000);
        this.updateDesktopKeyboardNavigation(deltaSeconds);
      } catch (error) {
        this.lastRenderError = error;
      }
      if (this.theaterMode === "lite" && !this.xrSession) {
        this.renderLiteStereoFrame();
      } else {
        this.renderer.render(this.scene, this.camera);
      }
      this.updateRenderFallback(now);
    },

    renderLiteStereoFrame() {
      if (!this.renderer || !this.scene || !this.camera) return;
      this.ensureLiteStereoCameras();
      const size = this.renderer.getSize(new THREE.Vector2());
      const width = Math.max(2, Math.floor(size.x));
      const height = Math.max(1, Math.floor(size.y));
      const halfWidth = Math.max(1, Math.floor(width / 2));
      const rightWidth = Math.max(1, width - halfWidth);
      const previousViewport = this.renderer.getViewport(new THREE.Vector4());
      const previousScissor = this.renderer.getScissor(new THREE.Vector4());
      const previousScissorTest = this.renderer.getScissorTest();
      const previousXrEnabled = this.renderer.xr.enabled;
      try {
        this.renderer.xr.enabled = false;
        this.renderer.setScissorTest(true);
        this.configureLiteEyeCamera(this.liteLeftCamera, -0.032, halfWidth / height);
        this.renderer.setViewport(0, 0, halfWidth, height);
        this.renderer.setScissor(0, 0, halfWidth, height);
        this.renderer.render(this.scene, this.liteLeftCamera);

        this.configureLiteEyeCamera(this.liteRightCamera, 0.032, rightWidth / height);
        this.renderer.setViewport(halfWidth, 0, rightWidth, height);
        this.renderer.setScissor(halfWidth, 0, rightWidth, height);
        this.renderer.render(this.scene, this.liteRightCamera);
      } finally {
        this.renderer.setViewport(previousViewport);
        this.renderer.setScissor(previousScissor);
        this.renderer.setScissorTest(previousScissorTest);
        this.renderer.xr.enabled = previousXrEnabled;
      }
    },

    ensureLiteStereoCameras() {
      if (!this.liteLeftCamera) {
        this.liteLeftCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
        this.liteLeftCamera.name = "xr-lite-left-eye";
        this.liteLeftCamera.rotation.order = "YXZ";
      }
      if (!this.liteRightCamera) {
        this.liteRightCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
        this.liteRightCamera.name = "xr-lite-right-eye";
        this.liteRightCamera.rotation.order = "YXZ";
      }
    },

    configureLiteEyeCamera(camera, eyeOffset, aspect) {
      if (!camera) return;
      camera.fov = this.camera?.fov || 60;
      camera.aspect = Math.max(0.1, aspect || 1);
      camera.near = this.camera?.near || 0.1;
      camera.far = this.camera?.far || 100;
      camera.position.set(eyeOffset, 0, 0);
      camera.rotation.set(0, 0, 0);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    }
  });
})();
