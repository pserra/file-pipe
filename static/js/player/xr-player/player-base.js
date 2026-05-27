(() => {
  const XR = window.FilePipeXr = window.FilePipeXr || {};
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

  class FilePipeThreeXrPlayer {
    constructor(video, options = {}) {
      this.video = video;
      this.options = {
        storageKey: "filePipeXrPlayer",
        fill: false,
        panelSelector: ".xr-side-panel",
        ...options,
      };
      this.settings = this.readSettings();
      this.cleanups = [];
      this.overlay = null;
      this.fallbackCanvas = null;
      this.fallbackContext = null;
      this.renderSampleCanvas = null;
      this.renderSampleContext = null;
      this.fallbackActive = false;
      this.lastRenderSampleAt = 0;
      this.renderer = null;
      this.scene = null;
      this.baseAmbientLight = null;
      this.camera = null;
      this.worldGroup = null;
      this.screenGroup = null;
      this.screenSurfaceGroup = null;
      this.screenBackingMesh = null;
      this.videoMesh = null;
      this.videoGeometryKey = "";
      this.mrDimMesh = null;
      this.gridMesh = null;
      this.themeGroup = null;
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
      this.themes = [];
      this.themeRevision = 0;
      this.localDepthProcessor = String(this.options.localDepthProcessor || "");
      this.localDepthTargetLayout = isKnownLayout(this.options.localDepthTargetLayout) ? this.options.localDepthTargetLayout : "";
      this.localDepthSettings = normalizeLocalDepthSettings(this.options.localDepthSettings || this.options.playbackProfile || {});
      this.localDepthStatus = this.describeLocalDepthStatus();
      this.localDepthAdapter = null;
      this.localDepthMaterial = null;
      this.videoTexture = null;
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
      this.backlightCaptureCanvas = null;
      this.backlightCaptureContext = null;
      this.backlightCaptureStream = null;
      this.backlightImageCapture = null;
      this.backlightCapturePending = false;
      this.backlightCaptureSample = null;
      this.backlightSampleStatus = "idle";
      this.backlightSampleDebug = null;
      this.lastVideoBacklightColors = null;
      this.lastBacklightSampleAt = 0;
      this.xrSidePanelCanvas = null;
      this.xrSidePanelContext = null;
      this.xrSidePanelTexture = null;
      this.xrSidePanelMesh = null;
      this.xrSidePanelHotspots = [];
      this.lastSidePanelTextureAt = 0;
      this.spatialAudioGraph = null;
      this.spatialAudioNodes = [];
      this.spatialAudioStatus = "Spatial audio off.";
      this.xrSupported = false;
      this.xrVrSupported = false;
      this.xrArSupported = false;
      this.xrSupportChecked = false;
      this.xrSessionMode = "";
      this.sidePanel = null;
      this.sidePanelPlaceholder = null;
      this.xrSession = null;
      this.xrSessionEndHandler = null;
      this.inTheater = false;
      this.theaterMode = "theater";
      this.liteToolsVisible = false;
      this.liteControlsVisible = false;
      this.liteControlsHideTimer = null;
      this.liteLeftCamera = null;
      this.liteRightCamera = null;
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
      this.desktopKeys = new Set();
      this.overlayCleanups = [];
      this.lastRenderAt = 0;
      this.xrRaycaster = null;
      this.xrControllerRayMatrix = null;
      this.updateOptions = this.updateOptions.bind(this);
      this.openTheater = this.openTheater.bind(this);
      this.openLiteTheater = this.openLiteTheater.bind(this);
      this.closeTheater = this.closeTheater.bind(this);
      this.dispose = this.dispose.bind(this);
      this.setSpatialAudioEnabled = this.setSpatialAudioEnabled.bind(this);

      this.buildInlineControls();
      this.bindInlineControls();
      this.refreshXrSupport();
      this.loadThemes();
      this.configureLocalDepthAdapter();
      this.updateInlineStatus();
      if (isKnownLayout(this.options.sourceLayout) && this.options.sourceLayout !== "mono") {
        this.setLayout(this.options.sourceLayout, { persist: false });
      }
      if (this.settings.aspectLocked && this.generatedStereoSourceAspectRatio()) {
        this.applyAspectRatioFrom("width");
        this.syncOverlayControls();
      }
    }
  }

  XR.FilePipeThreeXrPlayer = FilePipeThreeXrPlayer;
})();
