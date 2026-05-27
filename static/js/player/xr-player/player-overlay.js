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
    openTheater() {
      this.openTheaterMode("theater");
    },

    openLiteTheater() {
      this.openTheaterMode("lite");
    },

    openTheaterMode(mode = "theater") {
      if (this.inTheater) return;
      if (!window.THREE) {
        this.updateInlineStatus("Three.js did not load. Reload the page and try again.");
        return;
      }
      if (isKnownLayout(this.options.sourceLayout) && this.options.sourceLayout !== "mono") {
        this.setLayout(this.options.sourceLayout, { persist: false });
      }
      this.theaterMode = mode === "lite" ? "lite" : "theater";
      this.liteToolsVisible = this.theaterMode !== "lite";
      this.liteControlsVisible = this.theaterMode === "lite";
      this.clearLiteControlsHideTimer();
      this.inTheater = true;
      this.buildOverlay();
      if (this.theaterMode === "lite") this.requestLiteFullscreen({ silent: true });
      this.initThree();
      if (this.theaterMode !== "lite") this.moveSidePanelIntoOverlay();
      if (this.settings.aspectLocked) this.applyAspectRatioFrom("width");
      this.updateVideoGeometry();
      this.updateVideoMaterialUv();
      this.updateTheaterModeScene();
      this.resizeRenderer();
      this.renderer.setAnimationLoop(() => this.renderFrame());
      this.updatePlaybackControls();
      if (this.settings.spatialAudio) {
        this.setSpatialAudioEnabled(true).catch(() => {});
      }
      document.body.classList.add("fp-three-xr-active");
      if (this.theaterMode === "lite") this.showLiteControlsTemporarily(2200);
    },

    closeTheater() {
      if (!this.inTheater) return;
      this.inTheater = false;
      const session = this.xrSession;
      this.xrSession = null;
      if (session) {
        session.removeEventListener("end", this.xrSessionEndHandler);
        session.end().catch(() => {});
      }
      this.xrSessionMode = "";
      this.xrSessionEndHandler = null;
      if (this.renderer) this.renderer.setAnimationLoop(null);
      this.restoreSidePanel();
      if (this.liteFullscreenElement() === this.overlay) this.exitLiteFullscreen();
      if (this.overlay) this.overlay.remove();
      this.overlay = null;
      if (this.videoTexture) this.videoTexture.dispose();
      if (this.xrSidePanelTexture) this.xrSidePanelTexture.dispose();
      if (this.xrSidePanelMesh) {
        this.xrSidePanelMesh.geometry?.dispose();
        this.xrSidePanelMesh.material?.dispose();
      }
      if (this.mrDimMesh) {
        this.mrDimMesh.geometry?.dispose();
        this.mrDimMesh.material?.dispose();
        this.mrDimMesh.parent?.remove?.(this.mrDimMesh);
      }
      if (this.videoMesh) {
        this.videoMesh.geometry?.dispose();
        this.videoMesh.material?.dispose();
      }
      if (this.screenBackingMesh) {
        this.screenBackingMesh.geometry?.dispose();
        this.screenBackingMesh.material?.dispose();
      }
      this.clearThemeObjects();
      this.clearAvatarObjects();
      if (this.backlightGroup) {
        this.disposeBacklight();
      }
      if (this.renderer) this.renderer.dispose();
      this.renderer = null;
      this.scene = null;
      this.camera = null;
      this.liteLeftCamera = null;
      this.liteRightCamera = null;
      this.worldGroup = null;
      this.videoMesh = null;
      this.screenBackingMesh = null;
      this.videoGeometryKey = "";
      this.mrDimMesh = null;
      this.videoTexture = null;
      this.xrSidePanelMesh = null;
      this.xrSidePanelTexture = null;
      this.xrSidePanelCanvas = null;
      this.xrSidePanelContext = null;
      this.xrSidePanelHotspots = [];
      this.screenGroup = null;
      this.screenSurfaceGroup = null;
      this.gridMesh = null;
      this.themeGroup = null;
      this.avatarGroup = null;
      this.localAvatar = null;
      this.mirrorAvatar = null;
      this.avatarMirrorFrame = null;
      this.localAvatarPose = null;
      this.localAvatarNetworkPose = null;
      this.localAvatarPoseKey = "";
      this.avatarPinnedAnchor = null;
      this.remoteAvatars = new Map();
      this.lastAvatarPoseSentAt = 0;
      this.avatarPoseSequence = 0;
      this.avatarStatus = "";
      this.themeObjects = [];
      this.themeObjectById = new Map();
      this.themeInteractiveObjects = [];
      this.themeAnimatedObjects = [];
      this.themeSampledObjects = [];
      this.themeVideoSampleColors = null;
      this.themeSettingRenderKey = "";
      this.themeRaycaster = null;
      this.themePointer = null;
      this.themeMovableDrag = null;
      this.backlightGroup = null;
      this.backlightMesh = null;
      this.backlightMaskMesh = null;
      this.backlightSegments = [];
      this.backlightTexture = null;
      this.backlightSampleCanvas = null;
      this.backlightSampleContext = null;
      this.backlightRenderTarget = null;
      this.backlightSampleScene = null;
      this.backlightSampleCamera = null;
      this.backlightSampleMesh = null;
      this.backlightReadPixels = null;
      this.backlightReadData = null;
      this.spatialAudioNodes = [];
      this.controllers = [];
      this.controllerLines = [];
      this.hands = [];
      this.xrThumbstickSeekDirection = 0;
      this.xrThumbstickSeekAt = 0;
      this.xrRoamThumbstickActive = false;
      this.xrRoamSavedAt = 0;
      this.xrButtonState = {};
      this.activeGrab = null;
      this.desktopDrag = null;
      this.desktopKeys.clear();
      this.fallbackCanvas = null;
      this.fallbackContext = null;
      this.renderSampleCanvas = null;
      this.renderSampleContext = null;
      this.fallbackActive = false;
      this.lastRenderSampleAt = 0;
      this.overlayCleanups.forEach((cleanup) => cleanup());
      this.overlayCleanups = [];
      this.lastRenderAt = 0;
      this.xrRaycaster = null;
      this.xrControllerRayMatrix = null;
      this.theaterMode = "theater";
      this.liteToolsVisible = false;
      this.liteControlsVisible = false;
      this.clearLiteControlsHideTimer();
      document.body.classList.remove("fp-three-xr-active");
      if (this.settings.spatialAudio) {
        this.rebuildSpatialAudioGraph();
      } else {
        this.enableAudioPassthrough();
      }
    },

    buildOverlay() {
      this.overlay = document.createElement("div");
      this.overlay.className = "fp-three-xr-overlay";
      this.overlay.innerHTML = `
        <div class="fp-three-xr-topbar">
          <div>
            <strong data-role="theater-title">XR Theater</strong>
            <span data-role="theater-status"></span>
          </div>
          <div class="fp-three-xr-top-actions">
            <button class="btn btn-sm btn-info" type="button" data-action="enter-webxr" data-lite-hidden>
              <i class="bi bi-badge-vr"></i>
              <span data-role="webxr-label">Enter headset</span>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="recenter">
              <i class="bi bi-crosshair"></i>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="fullscreen-lite" data-lite-only title="Fullscreen">
              <i class="bi bi-arrows-fullscreen" data-role="fullscreen-icon"></i>
              <span data-role="fullscreen-label">Fullscreen</span>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="toggle-lite-controls" data-lite-only title="Hide controls">
              <i class="bi bi-eye-slash"></i>
              <span>Hide controls</span>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="toggle-lite-tools" data-lite-only title="Settings">
              <i class="bi bi-sliders"></i>
              <span data-role="lite-tools-label">Settings</span>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="reset-room-view" title="Reset desktop room view" data-lite-hidden>
              <i class="bi bi-house"></i>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="zoom-out" title="Zoom out">
              <i class="bi bi-dash-lg"></i>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="zoom-in" title="Zoom in">
              <i class="bi bi-plus-lg"></i>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="toggle-side-panel" data-lite-hidden>
              <i class="bi bi-layout-sidebar-inset-reverse"></i>
              <span data-role="side-panel-label">Voice</span>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="close">
              <i class="bi bi-x-lg"></i>
            </button>
          </div>
        </div>
        <div class="fp-three-xr-main">
          <div class="fp-three-xr-stage-panel">
            <canvas class="fp-three-xr-canvas"></canvas>
            <div class="fp-three-xr-playback">
              <button class="btn btn-sm btn-light" type="button" data-action="play-toggle"><i class="bi bi-play-fill"></i></button>
              <input class="form-range" type="range" min="0" max="1000" step="1" value="0" data-role="seek">
              <span data-role="time">0:00 / 0:00</span>
              <button class="btn btn-sm btn-light" type="button" data-action="mute-toggle"><i class="bi bi-volume-up"></i></button>
            </div>
          </div>
          <aside class="fp-three-xr-tools">
            <div class="fp-three-xr-tool-card">
              <div class="fp-three-xr-tool-title">Video Panel</div>
              <label class="fp-xr-field" data-lite-hidden>
                <span>Headset</span>
                <select class="form-select form-select-sm" data-role="overlay-headset-mode">
                  <option value="vr">VR room</option>
                  <option value="mr">MR passthrough</option>
                </select>
              </label>
              <label class="fp-xr-field" data-lite-hidden>
                <span>Room</span>
                <select class="form-select form-select-sm" data-role="theme">
                  <option value="default">Default room</option>
                </select>
              </label>
              <label class="fp-xr-field" data-lite-hidden>
                <span>Seating</span>
                <select class="form-select form-select-sm" data-role="seating">
                  <option value="manual">Manual</option>
                </select>
              </label>
              <label class="fp-xr-check" data-lite-hidden>
                <input class="form-check-input" type="checkbox" data-role="free-roam">
                <span>Free roam</span>
              </label>
              <label class="fp-xr-check" data-lite-hidden>
                <input class="form-check-input" type="checkbox" data-role="overlay-avatar-enabled">
                <span>Avatar body</span>
              </label>
              <label class="fp-xr-check" data-lite-hidden>
                <input class="form-check-input" type="checkbox" data-role="overlay-avatar-viewpoint">
                <span>View as avatar</span>
              </label>
              <label class="fp-xr-check" data-lite-hidden>
                <input class="form-check-input" type="checkbox" data-role="overlay-avatar-mirror">
                <span>Mirror preview</span>
              </label>
              <label class="fp-xr-check" data-lite-hidden>
                <input class="form-check-input" type="checkbox" data-role="overlay-avatar-pinned">
                <span>Pin body</span>
              </label>
              <div class="fp-xr-debug" data-role="avatar-status" data-lite-hidden></div>
              <div class="fp-three-xr-theme-settings" data-role="theme-settings" data-lite-hidden hidden></div>
              <label class="fp-xr-field">
                <span>Backlight</span>
                <select class="form-select form-select-sm" data-role="backlight">
                  <option value="off">Off</option>
                  <option value="soft">Soft glow</option>
                  <option value="dynamic">Dynamic glow</option>
                  <option value="video">Video sampled</option>
                </select>
              </label>
              <label class="fp-xr-range"><span>Backlight intensity <output data-role="backlight-intensity-label"></output></span><input class="form-range" type="range" min="0" max="150" step="5" data-role="backlight-intensity"></label>
              <div class="fp-xr-debug" data-role="backlight-debug" hidden></div>
              <label class="fp-xr-check" data-lite-hidden>
                <input class="form-check-input" type="checkbox" data-role="overlay-spatial-audio">
                <span>Spatial audio</span>
              </label>
              <div class="fp-xr-debug" data-role="spatial-audio-status" data-lite-hidden></div>
              <label class="fp-xr-field">
                <span>View</span>
                <select class="form-select form-select-sm" data-role="overlay-layout">
                  <option value="mono">Full frame</option>
                  <option value="half-sbs">Half SBS 3D</option>
                  <option value="full-sbs">Full SBS 3D</option>
                </select>
              </label>
              <label class="fp-xr-field" data-role="overlay-eye-field">
                <span>2D eye</span>
                <select class="form-select form-select-sm" data-role="overlay-eye">
                  <option value="left">Left</option>
                  <option value="right">Right</option>
                </select>
              </label>
              <label class="fp-xr-check">
                <input class="form-check-input" type="checkbox" data-role="aspect-lock">
                <span>Keep aspect ratio</span>
              </label>
              <label class="fp-xr-range"><span>Width <output data-role="width-label"></output></span><input class="form-range" type="range" min="1.4" max="6" step="0.1" data-role="panel-width"></label>
              <label class="fp-xr-range"><span>Height <output data-role="height-label"></output></span><input class="form-range" type="range" min="0.8" max="3.6" step="0.1" data-role="panel-height"></label>
              <label class="fp-xr-range" data-lite-hidden><span>X <output data-role="x-label"></output></span><input class="form-range" type="range" min="-3" max="3" step="0.05" data-role="panel-x"></label>
              <label class="fp-xr-range" data-lite-hidden><span>Height pos <output data-role="y-label"></output></span><input class="form-range" type="range" min="-1.4" max="1.4" step="0.05" data-role="panel-y"></label>
              <label class="fp-xr-range" data-lite-hidden><span>Yaw <output data-role="yaw-label"></output></span><input class="form-range" type="range" min="-35" max="35" step="1" data-role="panel-yaw"></label>
              <label class="fp-xr-range" data-lite-hidden><span>Tilt <output data-role="pitch-label"></output></span><input class="form-range" type="range" min="-20" max="20" step="1" data-role="panel-pitch"></label>
              <label class="fp-xr-range"><span>Screen curve <output data-role="curve-label"></output></span><input class="form-range" type="range" min="0" max="100" step="5" data-role="screen-curve"></label>
              <label class="fp-xr-range"><span>Viewport warp <output data-role="warp-label"></output></span><input class="form-range" type="range" min="0" max="100" step="5" data-role="viewport-warp"></label>
              <label class="fp-xr-range"><span>Distance <output data-role="distance-label"></output></span><input class="form-range" type="range" min="1.4" max="6" step="0.1" data-role="panel-distance"></label>
              <label class="fp-xr-range" data-lite-hidden><span>Room dim <output data-role="dim-label"></output></span><input class="form-range" type="range" min="0" max="100" step="5" data-role="room-dim"></label>
              <button class="btn btn-sm btn-outline-light w-100" type="button" data-action="reset-screen">
                <i class="bi bi-crosshair"></i> Recenter screen
              </button>
            </div>
            <div class="fp-three-xr-side-slot" data-role="side-slot"></div>
          </aside>
        </div>
      `;
      document.body.appendChild(this.overlay);
      this.canvas = this.overlay.querySelector(".fp-three-xr-canvas");
      this.fallbackCanvas = null;
      this.fallbackContext = null;
      this.theaterTitle = this.overlay.querySelector("[data-role='theater-title']");
      this.theaterStatus = this.overlay.querySelector("[data-role='theater-status']");
      this.overlayHeadsetModeSelect = this.overlay.querySelector("[data-role='overlay-headset-mode']");
      this.themeSelect = this.overlay.querySelector("[data-role='theme']");
      this.seatingSelect = this.overlay.querySelector("[data-role='seating']");
      this.freeRoamInput = this.overlay.querySelector("[data-role='free-roam']");
      this.overlayAvatarEnabledInput = this.overlay.querySelector("[data-role='overlay-avatar-enabled']");
      this.overlayAvatarViewpointInput = this.overlay.querySelector("[data-role='overlay-avatar-viewpoint']");
      this.overlayAvatarMirrorInput = this.overlay.querySelector("[data-role='overlay-avatar-mirror']");
      this.overlayAvatarPinnedInput = this.overlay.querySelector("[data-role='overlay-avatar-pinned']");
      this.avatarStatusElement = this.overlay.querySelector("[data-role='avatar-status']");
      this.themeSettingsContainer = this.overlay.querySelector("[data-role='theme-settings']");
      this.backlightSelect = this.overlay.querySelector("[data-role='backlight']");
      this.backlightIntensityInput = this.overlay.querySelector("[data-role='backlight-intensity']");
      this.backlightDebug = this.overlay.querySelector("[data-role='backlight-debug']");
      this.overlaySpatialAudioInput = this.overlay.querySelector("[data-role='overlay-spatial-audio']");
      this.spatialAudioStatusElement = this.overlay.querySelector("[data-role='spatial-audio-status']");
      this.overlayLayoutSelect = this.overlay.querySelector("[data-role='overlay-layout']");
      this.overlayEyeSelect = this.overlay.querySelector("[data-role='overlay-eye']");
      this.overlayEyeField = this.overlay.querySelector("[data-role='overlay-eye-field']");
      this.aspectLockInput = this.overlay.querySelector("[data-role='aspect-lock']");
      this.widthInput = this.overlay.querySelector("[data-role='panel-width']");
      this.heightInput = this.overlay.querySelector("[data-role='panel-height']");
      this.xInput = this.overlay.querySelector("[data-role='panel-x']");
      this.yInput = this.overlay.querySelector("[data-role='panel-y']");
      this.yawInput = this.overlay.querySelector("[data-role='panel-yaw']");
      this.pitchInput = this.overlay.querySelector("[data-role='panel-pitch']");
      this.curveInput = this.overlay.querySelector("[data-role='screen-curve']");
      this.warpInput = this.overlay.querySelector("[data-role='viewport-warp']");
      this.distanceInput = this.overlay.querySelector("[data-role='panel-distance']");
      this.dimInput = this.overlay.querySelector("[data-role='room-dim']");
      this.backlightIntensityLabel = this.overlay.querySelector("[data-role='backlight-intensity-label']");
      this.widthLabel = this.overlay.querySelector("[data-role='width-label']");
      this.heightLabel = this.overlay.querySelector("[data-role='height-label']");
      this.xLabel = this.overlay.querySelector("[data-role='x-label']");
      this.yLabel = this.overlay.querySelector("[data-role='y-label']");
      this.yawLabel = this.overlay.querySelector("[data-role='yaw-label']");
      this.pitchLabel = this.overlay.querySelector("[data-role='pitch-label']");
      this.curveLabel = this.overlay.querySelector("[data-role='curve-label']");
      this.warpLabel = this.overlay.querySelector("[data-role='warp-label']");
      this.distanceLabel = this.overlay.querySelector("[data-role='distance-label']");
      this.dimLabel = this.overlay.querySelector("[data-role='dim-label']");
      this.playButton = this.overlay.querySelector("[data-action='play-toggle']");
      this.playIcon = this.playButton.querySelector(".bi");
      this.seekInput = this.overlay.querySelector("[data-role='seek']");
      this.timeLabel = this.overlay.querySelector("[data-role='time']");
      this.muteButton = this.overlay.querySelector("[data-action='mute-toggle']");
      this.muteIcon = this.muteButton.querySelector(".bi");
      this.webXrButton = this.overlay.querySelector("[data-action='enter-webxr']");
      this.webXrLabel = this.overlay.querySelector("[data-role='webxr-label']");
      this.fullscreenButton = this.overlay.querySelector("[data-action='fullscreen-lite']");
      this.fullscreenIcon = this.overlay.querySelector("[data-role='fullscreen-icon']");
      this.fullscreenLabel = this.overlay.querySelector("[data-role='fullscreen-label']");
      this.liteToolsToggleButton = this.overlay.querySelector("[data-action='toggle-lite-tools']");
      this.liteToolsLabel = this.overlay.querySelector("[data-role='lite-tools-label']");
      this.sidePanelToggleButton = this.overlay.querySelector("[data-action='toggle-side-panel']");
      this.sidePanelLabel = this.overlay.querySelector("[data-role='side-panel-label']");
      this.sideSlot = this.overlay.querySelector("[data-role='side-slot']");
      this.overlay.querySelector("[data-action='close']").addEventListener("click", () => this.closeTheater());
      this.overlay.querySelector("[data-action='recenter']").addEventListener("click", () => this.recenterScreen());
      this.overlay.querySelector("[data-action='fullscreen-lite']").addEventListener("click", () => this.toggleLiteFullscreen());
      this.overlay.querySelector("[data-action='toggle-lite-controls']").addEventListener("click", () => this.hideLiteControls());
      this.overlay.querySelector("[data-action='toggle-lite-tools']").addEventListener("click", () => this.toggleLiteTools());
      this.overlay.querySelector("[data-action='reset-room-view']").addEventListener("click", () => this.resetRoomView());
      this.overlay.querySelector("[data-action='zoom-out']").addEventListener("click", () => this.zoomScreen(0.2));
      this.overlay.querySelector("[data-action='zoom-in']").addEventListener("click", () => this.zoomScreen(-0.2));
      this.overlay.querySelector("[data-action='reset-screen']").addEventListener("click", () => this.recenterScreen({ resetDistance: true }));
      this.bindDesktopStageControls();
      this.webXrButton.addEventListener("click", () => this.enterWebXr());
      this.sidePanelToggleButton.addEventListener("click", () => this.toggleSidePanel());
      this.playButton.addEventListener("click", () => this.togglePlayback());
      this.muteButton.addEventListener("click", () => {
        this.video.muted = !this.video.muted;
        this.updatePlaybackControls();
      });
      this.seekInput.addEventListener("input", () => {
        const duration = Number(this.video.duration || 0);
        if (duration) this.video.currentTime = duration * (Number(this.seekInput.value || 0) / 1000);
      });
      this.overlayHeadsetModeSelect.addEventListener("change", () => {
        this.settings.headsetMode = this.overlayHeadsetModeSelect.value === "mr" ? "mr" : "vr";
        this.headsetModeSelect.value = this.settings.headsetMode;
        this.saveSettings();
        this.syncOverlayControls();
        this.updateSceneLighting();
        this.updateInlineStatus();
      });
      this.themeSelect.addEventListener("change", () => {
        this.settings.theme = this.themeSelect.value || DEFAULT_SETTINGS.theme;
        this.ensureValidSeatingSelection();
        this.migrateThemeValueDefaults();
        const themeDefaultsChanged = this.migrateThemeDefaults();
        this.applyCurrentThemeSeatIfAnchored();
        this.saveSettings();
        this.themeSettingRenderKey = "";
        this.syncOverlayControls();
        if (themeDefaultsChanged) this.updateVideoGeometry();
        this.applyTheme();
        this.rebuildSpatialAudioGraph();
      });
      this.seatingSelect.addEventListener("change", () => {
        this.selectSeating(this.seatingSelect.value || "manual");
      });
      this.freeRoamInput.addEventListener("change", () => {
        this.settings.freeRoam = Boolean(this.freeRoamInput.checked);
        this.saveSettings();
        this.syncOverlayControls();
        this.updateXrSidePanelTexture(true);
      });
      this.overlayAvatarEnabledInput.addEventListener("change", () => {
        this.setAvatarEnabled(this.overlayAvatarEnabledInput.checked);
      });
      this.overlayAvatarViewpointInput.addEventListener("change", () => {
        this.setAvatarViewpoint(this.overlayAvatarViewpointInput.checked);
      });
      this.overlayAvatarMirrorInput.addEventListener("change", () => {
        this.setAvatarMirrorEnabled(this.overlayAvatarMirrorInput.checked);
      });
      this.overlayAvatarPinnedInput.addEventListener("change", () => {
        this.setAvatarPinned(this.overlayAvatarPinnedInput.checked);
      });
      this.backlightSelect.addEventListener("change", () => {
        this.settings.backlightMode = isKnownBacklightMode(this.backlightSelect.value) ? this.backlightSelect.value : "off";
        this.saveSettings();
        this.syncOverlayControls();
        this.updateBacklight(true);
      });
      this.overlaySpatialAudioInput.addEventListener("change", () => {
        this.setSpatialAudioEnabled(this.overlaySpatialAudioInput.checked);
      });
      this.aspectLockInput.addEventListener("change", () => {
        this.settings.aspectLocked = this.aspectLockInput.checked;
        if (this.settings.aspectLocked) this.applyAspectRatioFrom("width");
        this.saveSettings();
        this.syncOverlayControls();
        this.updateVideoGeometry();
      });
      this.overlayLayoutSelect.addEventListener("change", () => {
        this.settings.layout = this.overlayLayoutSelect.value;
        this.layoutSelect.value = this.settings.layout;
        if (this.settings.aspectLocked) this.applyAspectRatioFrom("width");
        this.saveSettings();
        this.updateVideoMaterialUv();
        this.updateVideoGeometry();
        this.syncOverlayControls();
        this.updateInlineStatus();
      });
      this.overlayEyeSelect.addEventListener("change", () => {
        this.settings.eye = this.overlayEyeSelect.value === "right" ? "right" : "left";
        this.eyeSelect.value = this.settings.eye;
        this.saveSettings();
        this.updateVideoMaterialUv();
        this.syncOverlayControls();
      });
      this.widthInput.addEventListener("input", () => this.updatePanelSize("width", this.widthInput.value));
      this.heightInput.addEventListener("input", () => this.updatePanelSize("height", this.heightInput.value));
      this.xInput.addEventListener("input", () => this.updateNumericSetting("panelX", this.xInput.value));
      this.yInput.addEventListener("input", () => this.updateNumericSetting("panelY", this.yInput.value));
      this.yawInput.addEventListener("input", () => this.updateNumericSetting("panelYaw", this.yawInput.value));
      this.pitchInput.addEventListener("input", () => this.updateNumericSetting("panelPitch", this.pitchInput.value));
      this.curveInput.addEventListener("input", () => this.updateNumericSetting("screenCurve", this.curveInput.value));
      this.warpInput.addEventListener("input", () => this.updateNumericSetting("viewportWarp", this.warpInput.value));
      this.distanceInput.addEventListener("input", () => this.updateNumericSetting("distance", this.distanceInput.value));
      this.dimInput.addEventListener("input", () => this.updateNumericSetting("roomDim", this.dimInput.value));
      this.backlightIntensityInput.addEventListener("input", () => this.updateNumericSetting("backlightIntensity", this.backlightIntensityInput.value));
      this.syncOverlayControls();
    },

    syncOverlayControls() {
      if (this.headsetModeSelect) {
        this.headsetModeSelect.value = this.settings.headsetMode;
        this.headsetModeSelect.querySelector("option[value='mr']").disabled = !this.xrArSupported;
      }
      if (this.spatialAudioInput) this.spatialAudioInput.checked = Boolean(this.settings.spatialAudio);
      if (this.avatarEnabledInput) this.avatarEnabledInput.checked = Boolean(this.settings.avatarEnabled);
      if (this.avatarViewpointInput) {
        this.avatarViewpointInput.checked = Boolean(this.settings.avatarViewpoint);
        this.avatarViewpointInput.disabled = !this.settings.avatarEnabled;
      }
      if (this.avatarMirrorInput) {
        this.avatarMirrorInput.checked = Boolean(this.settings.avatarMirror);
        this.avatarMirrorInput.disabled = !this.settings.avatarEnabled;
      }
      if (this.avatarPinnedInput) {
        this.avatarPinnedInput.checked = Boolean(this.settings.avatarPinned);
        this.avatarPinnedInput.disabled = !this.settings.avatarEnabled;
      }
      if (!this.overlay) return;
      this.syncTheaterModeControls();
      this.overlayHeadsetModeSelect.value = this.settings.headsetMode;
      this.overlayHeadsetModeSelect.querySelector("option[value='mr']").disabled = !this.xrArSupported;
      this.syncThemeOptions();
      this.themeSelect.value = this.settings.theme;
      this.syncSeatingOptions();
      this.seatingSelect.value = this.settings.seating || "manual";
      this.freeRoamInput.checked = Boolean(this.settings.freeRoam);
      this.overlayAvatarEnabledInput.checked = Boolean(this.settings.avatarEnabled);
      this.overlayAvatarViewpointInput.checked = Boolean(this.settings.avatarViewpoint);
      this.overlayAvatarMirrorInput.checked = Boolean(this.settings.avatarMirror);
      this.overlayAvatarPinnedInput.checked = Boolean(this.settings.avatarPinned);
      this.overlayAvatarViewpointInput.disabled = !this.settings.avatarEnabled;
      this.overlayAvatarMirrorInput.disabled = !this.settings.avatarEnabled;
      this.overlayAvatarPinnedInput.disabled = !this.settings.avatarEnabled;
      if (this.avatarStatusElement) this.avatarStatusElement.textContent = this.avatarStatus || "Avatar body off.";
      this.syncThemeSettingsControls();
      this.backlightSelect.value = this.settings.backlightMode;
      this.backlightIntensityInput.value = String(this.settings.backlightIntensity);
      this.overlaySpatialAudioInput.checked = Boolean(this.settings.spatialAudio);
      if (this.spatialAudioStatusElement) {
        this.spatialAudioStatusElement.textContent = this.spatialAudioStatus || "Spatial audio off.";
      }
      this.aspectLockInput.checked = Boolean(this.settings.aspectLocked);
      this.overlayLayoutSelect.value = this.settings.layout;
      this.overlayEyeSelect.value = this.settings.eye;
      this.overlayEyeField.hidden = this.settings.layout === "mono";
      this.widthInput.value = String(this.settings.panelWidth);
      this.heightInput.value = String(this.settings.panelHeight);
      this.xInput.value = String(this.settings.panelX);
      this.yInput.value = String(this.settings.panelY);
      this.yawInput.value = String(this.settings.panelYaw);
      this.pitchInput.value = String(this.settings.panelPitch);
      this.curveInput.value = String(this.settings.screenCurve);
      this.warpInput.value = String(this.settings.viewportWarp);
      this.distanceInput.value = String(this.settings.distance);
      this.dimInput.value = String(this.settings.roomDim);
      this.widthLabel.textContent = `${this.settings.panelWidth.toFixed(1)}m`;
      this.heightLabel.textContent = `${this.settings.panelHeight.toFixed(1)}m`;
      this.xLabel.textContent = `${this.settings.panelX.toFixed(2)}m`;
      this.yLabel.textContent = `${this.settings.panelY.toFixed(2)}m`;
      this.yawLabel.textContent = `${Math.round(this.settings.panelYaw)}°`;
      this.pitchLabel.textContent = `${Math.round(this.settings.panelPitch)}°`;
      this.curveLabel.textContent = this.settings.screenCurve > 0 ? `${Math.round(this.settings.screenCurve)}%` : "Flat";
      this.warpLabel.textContent = this.settings.viewportWarp > 0 ? `${Math.round(this.settings.viewportWarp)}%` : "Off";
      this.distanceLabel.textContent = `${this.settings.distance.toFixed(1)}m`;
      this.dimLabel.textContent = `${Math.round(this.settings.roomDim)}%`;
      this.backlightIntensityLabel.textContent = `${Math.round(this.settings.backlightIntensity)}%`;
      if (this.backlightDebug) {
        this.backlightDebug.hidden = this.settings.backlightMode !== "video";
        this.backlightDebug.textContent = `Sample ${this.backlightSampleStatus || "idle"}`;
      }
      if (this.webXrButton) {
        const modeSupported = this.settings.headsetMode === "mr" ? this.xrArSupported : this.xrVrSupported;
        this.webXrButton.disabled = !modeSupported || Boolean(this.xrSession);
        this.webXrLabel.textContent = this.xrSession
          ? "Headset active"
          : modeSupported
            ? (this.settings.headsetMode === "mr" ? "Enter MR" : "Enter VR")
            : (this.settings.headsetMode === "mr" ? "No MR" : "No headset");
      }
      if (this.sidePanelLabel) {
        this.sidePanelLabel.textContent = this.settings.sidePanelVisible ? "Hide voice" : "Show voice";
      }
      this.syncSidePanelVisibility();
      if (this.theaterStatus) {
        if (this.theaterMode === "lite") {
          this.theaterStatus.textContent = `Full SBS browser output · ${LAYOUT_LABELS[this.settings.layout] || "Video"} source · ${this.settings.distance.toFixed(1)}m`;
        } else {
          const mode = this.xrSession
            ? (this.xrSessionMode === "immersive-ar" ? "MR active" : "VR active")
            : "Desktop theater";
          const seat = this.currentSeat();
          const seatLabel = seat ? seat.label : "Manual";
          const roam = this.settings.freeRoam ? " · Free roam" : "";
          this.theaterStatus.textContent = `${mode} · ${LAYOUT_LABELS[this.settings.layout] || "Video"} · ${seatLabel}${roam} · ${this.settings.panelWidth.toFixed(1)} x ${this.settings.panelHeight.toFixed(1)}m`;
        }
      }
    },

    syncTheaterModeControls() {
      if (!this.overlay) return;
      const lite = this.theaterMode === "lite";
      this.overlay.classList.toggle("fp-three-xr-lite-mode", lite);
      this.overlay.classList.toggle("fp-three-xr-lite-tools-open", lite && this.liteToolsVisible);
      this.overlay.classList.toggle("fp-three-xr-lite-controls-hidden", lite && !this.liteControlsVisible && !this.liteToolsVisible);
      if (this.theaterTitle) this.theaterTitle.textContent = lite ? "XR Lite" : "XR Theater";
      if (this.fullscreenIcon) this.fullscreenIcon.className = this.isLiteFullscreen() ? "bi bi-fullscreen-exit" : "bi bi-arrows-fullscreen";
      if (this.fullscreenLabel) this.fullscreenLabel.textContent = this.isLiteFullscreen() ? "Exit full screen" : "Fullscreen";
      if (this.liteToolsLabel) this.liteToolsLabel.textContent = this.liteToolsVisible ? "Hide settings" : "Settings";
      for (const element of this.overlay.querySelectorAll("[data-lite-hidden]")) {
        element.hidden = lite;
      }
      for (const element of this.overlay.querySelectorAll("[data-lite-only]")) {
        element.hidden = !lite;
      }
      if (this.sideSlot && lite) this.sideSlot.hidden = true;
    },

    toggleLiteTools() {
      this.liteToolsVisible = !this.liteToolsVisible;
      this.liteControlsVisible = true;
      this.syncTheaterModeControls();
      if (this.liteToolsVisible) {
        this.clearLiteControlsHideTimer();
      } else {
        this.scheduleLiteControlsHide(2600);
      }
    },

    updateTheaterModeScene() {
      this.syncTheaterModeControls();
      this.updateDesktopCamera();
      this.updateSceneLighting();
      this.updateVideoGeometry();
      this.updateSpatialAudio();
    },

    showLiteControlsTemporarily(delayMs = 2600) {
      if (this.theaterMode !== "lite") return;
      this.liteControlsVisible = true;
      this.syncTheaterModeControls();
      this.scheduleLiteControlsHide(delayMs);
    },

    hideLiteControls() {
      if (this.theaterMode !== "lite") return;
      this.liteToolsVisible = false;
      this.liteControlsVisible = false;
      this.clearLiteControlsHideTimer();
      this.syncTheaterModeControls();
    },

    scheduleLiteControlsHide(delayMs = 2600) {
      this.clearLiteControlsHideTimer();
      if (this.theaterMode !== "lite" || this.liteToolsVisible) return;
      this.liteControlsHideTimer = window.setTimeout(() => {
        this.liteControlsVisible = false;
        this.liteControlsHideTimer = null;
        this.syncTheaterModeControls();
      }, Math.max(400, Number(delayMs) || 2600));
    },

    clearLiteControlsHideTimer() {
      if (!this.liteControlsHideTimer) return;
      window.clearTimeout(this.liteControlsHideTimer);
      this.liteControlsHideTimer = null;
    },

    isCoarsePointer() {
      return Boolean(window.matchMedia?.("(pointer: coarse)")?.matches);
    },

    liteFullscreenElement() {
      return document.fullscreenElement || document.webkitFullscreenElement || null;
    },

    isLiteFullscreen() {
      return this.liteFullscreenElement() === this.overlay;
    },

    toggleLiteFullscreen() {
      if (this.isLiteFullscreen()) {
        this.exitLiteFullscreen();
      } else {
        this.requestLiteFullscreen();
      }
      this.showLiteControlsTemporarily(2200);
    },

    requestLiteFullscreen(options = {}) {
      if (this.theaterMode !== "lite" || !this.overlay) return;
      if (this.isLiteFullscreen()) {
        this.syncTheaterModeControls();
        return;
      }
      try {
        let request = null;
        if (this.overlay.requestFullscreen) {
          request = this.overlay.requestFullscreen({ navigationUI: "hide" });
        } else if (this.overlay.webkitRequestFullscreen) {
          request = this.overlay.webkitRequestFullscreen();
        } else if (!options.silent) {
          this.updateInlineStatus("Fullscreen is unavailable in this browser.");
          return;
        }
        if (request?.catch) {
          request.catch((error) => {
            if (!options.silent) this.updateInlineStatus(error?.message || "Fullscreen was blocked by the browser.");
          });
        }
      } catch (error) {
        if (!options.silent) this.updateInlineStatus(error?.message || "Fullscreen was blocked by the browser.");
      } finally {
        this.syncTheaterModeControls();
      }
    },

    exitLiteFullscreen() {
      try {
        if (document.exitFullscreen && document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else if (document.webkitExitFullscreen && document.webkitFullscreenElement) {
          document.webkitExitFullscreen();
        }
      } catch (error) {
        // The browser already left fullscreen or denied the request.
      } finally {
        this.syncTheaterModeControls();
      }
    },

    updateNumericSetting(key, value) {
      const limits = THEATER_SETTING_LIMITS[key];
      this.settings[key] = clampNumber(Number(value), limits[0], limits[1], DEFAULT_SETTINGS[key]);
      this.saveSettings();
      this.syncOverlayControls();
      this.updateVideoGeometry();
      this.updateSceneLighting();
      this.updateSpatialAudio();
      if (key === "backlightIntensity") this.updateBacklight(true);
    },

    updatePanelSize(axis, value) {
      const aspect = this.videoAspectRatio();
      if (this.settings.aspectLocked) {
        const size = lockedPanelSize(axis, Number(value), aspect, this.settings);
        this.settings.panelWidth = size.width;
        this.settings.panelHeight = size.height;
      } else if (axis === "height") {
        this.settings.panelHeight = clampNumber(Number(value), 0.8, 3.6, DEFAULT_SETTINGS.panelHeight);
      } else {
        this.settings.panelWidth = clampNumber(Number(value), 1.4, 6, DEFAULT_SETTINGS.panelWidth);
      }
      this.saveSettings();
      this.syncOverlayControls();
      this.updateVideoGeometry();
      this.updateSpatialAudio();
      this.updateBacklight(true);
    },

    applyAspectRatioFrom(axis = "width") {
      const aspect = this.videoAspectRatio();
      const value = axis === "height" ? this.settings.panelHeight : this.settings.panelWidth;
      const size = lockedPanelSize(axis, value, aspect, this.settings);
      this.settings.panelWidth = size.width;
      this.settings.panelHeight = size.height;
    },

    videoAspectRatio() {
      const generatedStereoAspect = this.generatedStereoSourceAspectRatio();
      if (generatedStereoAspect) return generatedStereoAspect;
      const width = Number(this.video.videoWidth || 16);
      const height = Number(this.video.videoHeight || 9);
      if (!width || !height) return 16 / 9;
      if (this.settings.layout === "full-sbs") return Math.max(0.1, (width / 2) / height);
      return Math.max(0.1, width / height);
    },

    generatedStereoSourceAspectRatio() {
      const profile = isPlainObject(this.options.playbackProfile) ? this.options.playbackProfile : {};
      const profileLayout = profile.targetVideoLayout || profile.videoLayout || this.options.sourceLayout || "";
      const stereoLayout = ["half-sbs", "full-sbs"].includes(profileLayout) ? profileLayout : "";
      const generatedStereo = Boolean(profile.localStereoProcessor || profile.sourceKind === "hls-live");
      if (!generatedStereo || !stereoLayout) return 0;
      return mediaInfoVideoAspectRatio(this.mediaInfo());
    },

    recenterScreen(options = {}) {
      const mounted = this.applyThemeScreenMount(options);
      if (mounted === null) {
        this.settings.panelX = 0;
        this.settings.panelY = 0;
        this.settings.panelYaw = 0;
        this.settings.panelPitch = 0;
        if (options.resetDistance) {
          this.settings.distance = DEFAULT_SETTINGS.distance;
          this.settings.panelWidth = DEFAULT_SETTINGS.panelWidth;
          this.settings.panelHeight = DEFAULT_SETTINGS.panelHeight;
          this.settings.screenCurve = DEFAULT_SETTINGS.screenCurve;
          this.settings.viewportWarp = DEFAULT_SETTINGS.viewportWarp;
        }
      }
      this.saveSettings();
      this.syncOverlayControls();
      this.updateVideoGeometry();
      this.updateSpatialAudio();
    },

    toggleSidePanel(force = null) {
      this.settings.sidePanelVisible = force === null ? !this.settings.sidePanelVisible : Boolean(force);
      this.saveSettings();
      this.syncOverlayControls();
      this.updateXrSidePanelTexture(true);
    },

    syncSidePanelVisibility() {
      if (this.sideSlot) this.sideSlot.hidden = !this.settings.sidePanelVisible;
    },

    zoomScreen(distanceDelta) {
      this.updateNumericSetting("distance", this.settings.distance + distanceDelta);
    },

    resetRoomView() {
      const seat = this.currentSeat();
      if (seat) {
        this.applySeatingPosition(seat, { save: true, sync: true, select: true });
        return;
      }
      this.settings.roomViewX = DEFAULT_SETTINGS.roomViewX;
      this.settings.roomViewY = DEFAULT_SETTINGS.roomViewY;
      this.settings.roomViewZ = DEFAULT_SETTINGS.roomViewZ;
      this.settings.roomViewYaw = DEFAULT_SETTINGS.roomViewYaw;
      this.settings.roomViewPitch = DEFAULT_SETTINGS.roomViewPitch;
      this.desktopKeys.clear();
      this.saveSettings();
      this.updateDesktopCamera();
      this.updateWorldOffset();
    },

    moveSidePanelIntoOverlay() {
      const panel = document.querySelector(this.options.panelSelector);
      if (!panel || !this.sideSlot || this.sidePanel) return;
      this.sidePanel = panel;
      this.sidePanelPlaceholder = document.createComment("file-pipe-xr-side-panel");
      panel.parentNode.insertBefore(this.sidePanelPlaceholder, panel);
      this.sideSlot.appendChild(panel);
      panel.classList.add("fp-three-xr-moved-panel");
      this.syncSidePanelVisibility();
    },

    restoreSidePanel() {
      if (!this.sidePanel || !this.sidePanelPlaceholder) return;
      if (this.sideSlot) this.sideSlot.hidden = false;
      this.sidePanel.classList.remove("fp-three-xr-moved-panel");
      this.sidePanelPlaceholder.parentNode.insertBefore(this.sidePanel, this.sidePanelPlaceholder);
      this.sidePanelPlaceholder.remove();
      this.sidePanel = null;
      this.sidePanelPlaceholder = null;
    },

    async togglePlayback() {
      if (this.video.paused) {
        await this.video.play().catch((error) => this.updateInlineStatus(error.message || "Playback was blocked."));
      } else {
        this.video.pause();
      }
      this.updatePlaybackControls();
    },

    updatePlaybackControls() {
      if (!this.playIcon || !this.seekInput || !this.timeLabel || !this.muteIcon) return;
      this.playIcon.className = this.video.paused ? "bi bi-play-fill" : "bi bi-pause-fill";
      const duration = Number(this.video.duration || 0);
      const currentTime = Number(this.video.currentTime || 0);
      this.seekInput.disabled = !duration;
      this.seekInput.value = duration ? String(Math.round((currentTime / duration) * 1000)) : "0";
      this.timeLabel.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
      this.muteIcon.className = this.video.muted || this.video.volume === 0 ? "bi bi-volume-mute" : "bi bi-volume-up";
    }
  });
})();
