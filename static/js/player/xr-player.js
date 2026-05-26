(() => {
  const INSTANCE_BY_VIDEO = new WeakMap();
  const AUDIO_GRAPH_BY_VIDEO = new WeakMap();
  const DEFAULT_SETTINGS = {
    layout: "mono",
    eye: "left",
    headsetMode: "vr",
    panelWidth: 3.2,
    panelHeight: 1.8,
    panelX: 0,
    panelY: 0,
    panelYaw: 0,
    panelPitch: 0,
    screenCurve: 0,
    distance: 3,
    roomViewX: 0,
    roomViewY: 1.45,
    roomViewZ: 0,
    roomViewYaw: 0,
    roomViewPitch: -16,
    roomViewPresetVersion: 2,
    roomDim: 80,
    sidePanelVisible: false,
    aspectLocked: true,
    backlightMode: "off",
    backlightIntensity: 100,
    spatialAudio: false,
    theme: "default",
  };
  const DEFAULT_AUDIO_CHANNEL_LABELS = ["L", "R", "C", "LFE", "SL", "SR", "BL", "BR"];
  const LAYOUT_LABELS = {
    mono: "Full frame",
    "half-sbs": "Half SBS 3D",
    "full-sbs": "Full SBS 3D",
  };
  const BACKLIGHT_SEGMENT_COUNTS = {
    top: 22,
    bottom: 22,
    left: 9,
    right: 9,
    "top-left": 2,
    "top-right": 2,
    "bottom-left": 2,
    "bottom-right": 2,
  };
  const XR_SIDE_PANEL_LOGICAL_SIZE = 1024;
  const XR_SIDE_PANEL_TEXTURE_SIZE = 2048;
  const XR_SIDE_PANEL_ANGLE = -0.34;
  const XR_THUMBSTICK_SEEK_SECONDS = 30;
  const XR_THUMBSTICK_SEEK_DEADZONE = 0.72;
  const XR_THUMBSTICK_SEEK_RESET_ZONE = 0.32;
  const XR_THUMBSTICK_SEEK_REPEAT_MS = 650;
  const MR_DIM_RENDER_ORDER = -10000;
  const BACKLIGHT_MASK_RENDER_ORDER = -30;
  const BACKLIGHT_RENDER_ORDER = -20;

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
      this.camera = null;
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
      this.liteLeftCamera = null;
      this.liteRightCamera = null;
      this.controllers = [];
      this.controllerLines = [];
      this.xrThumbstickSeekDirection = 0;
      this.xrThumbstickSeekAt = 0;
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

    updateOptions(options = {}) {
      this.options = { ...this.options, ...options };
      if (isKnownLayout(options.sourceLayout) && options.sourceLayout !== "mono") {
        this.setLayout(options.sourceLayout, { persist: false });
      }
      if ("playbackProfile" in options || "mediaInfo" in options || "sourceLayout" in options) {
        if (this.settings.aspectLocked) this.applyAspectRatioFrom("width");
        this.updateVideoGeometry();
        this.syncOverlayControls();
        this.updateInlineStatus();
      }
      if ("localDepthProcessor" in options || "localDepthTargetLayout" in options || "localDepthSettings" in options) {
        this.setLocalDepthProcessor(options.localDepthProcessor || "", options.localDepthTargetLayout || "", options.localDepthSettings || options.playbackProfile || {});
      }
      if (this.settings.spatialAudio && this.spatialAudioGraph?.mode === "spatial") {
        this.rebuildSpatialAudioGraph();
      }
      return this;
    }

    setLayout(layout, options = {}) {
      if (!isKnownLayout(layout) || this.settings.layout === layout) return;
      this.settings.layout = layout;
      if (this.layoutSelect) this.layoutSelect.value = layout;
      if (this.overlayLayoutSelect) this.overlayLayoutSelect.value = layout;
      if (this.eyeField) this.eyeField.hidden = layout === "mono";
      if (this.overlayEyeField) this.overlayEyeField.hidden = layout === "mono";
      if (this.settings.aspectLocked) this.applyAspectRatioFrom("width");
      if (options.persist !== false) this.saveSettings();
      this.updateVideoMaterialUv();
      this.updateVideoGeometry();
      this.syncOverlayControls();
      this.updateInlineStatus();
    }

    setLocalDepthProcessor(processor = "", targetLayout = "", settings = {}) {
      const nextProcessor = String(processor || "");
      const nextTargetLayout = isKnownLayout(targetLayout) ? targetLayout : "";
      const nextSettings = normalizeLocalDepthSettings(settings);
      const processorChanged = this.localDepthProcessor !== nextProcessor || this.localDepthTargetLayout !== nextTargetLayout;
      this.localDepthProcessor = nextProcessor;
      this.localDepthTargetLayout = nextTargetLayout;
      this.localDepthSettings = nextSettings;
      this.localDepthStatus = this.describeLocalDepthStatus();
      if (processorChanged || !this.localDepthAdapter) {
        this.configureLocalDepthAdapter();
      } else {
        this.updateLocalDepthSettings(nextSettings);
      }
      this.updateInlineStatus();
    }

    updateLocalDepthSettings(settings = this.localDepthSettings) {
      this.localDepthSettings = normalizeLocalDepthSettings(settings);
      if (this.localDepthAdapter?.updateOptions) {
        this.localDepthAdapter.updateOptions({
          processor: this.localDepthProcessor,
          targetLayout: this.localDepthTargetLayout,
          ...this.localDepthSettings,
          standardOutput: true,
          xrPlayer: this,
        });
        if (this.localDepthAdapter?.status) this.localDepthStatus = ` ${this.localDepthAdapter.status}`;
      } else {
        this.localDepthStatus = this.describeLocalDepthStatus();
      }
      this.updateInlineStatus();
      return this;
    }

    describeLocalDepthStatus() {
      if (!this.localDepthProcessor) return "";
      if (!isLocalDepthProcessor(this.localDepthProcessor)) return "";
      const target = LAYOUT_LABELS[this.localDepthTargetLayout] || "3D";
      if (!window.FilePipeLocalDepth3dAdapter?.attach) return ` Local depth is selected for ${target}; no local depth adapter is loaded.`;
      if (this.localDepthAdapter?.status) return ` ${this.localDepthAdapter.status}`;
      return ` Local browser depth adapter is active for ${target}.`;
    }

    configureLocalDepthAdapter() {
      if (this.localDepthAdapter?.dispose) {
        this.localDepthAdapter.dispose();
      }
      this.localDepthAdapter = null;
      this.updateVideoMaterial();
      if (!isLocalDepthProcessor(this.localDepthProcessor) || !window.FilePipeLocalDepth3dAdapter?.attach) return;
      try {
        this.localDepthAdapter = window.FilePipeLocalDepth3dAdapter.attach(this.video, {
          processor: this.localDepthProcessor,
          targetLayout: this.localDepthTargetLayout,
          ...this.localDepthSettings,
          standardOutput: true,
          xrPlayer: this,
        });
        if (this.localDepthAdapter?.status) this.localDepthStatus = ` ${this.localDepthAdapter.status}`;
        this.updateVideoMaterial();
      } catch (error) {
        this.localDepthStatus = ` Local depth adapter failed: ${error.message || error}`;
      }
    }

    readSettings() {
      try {
        const stored = JSON.parse(localStorage.getItem(this.options.storageKey) || "{}");
        const settings = {
          layout: isKnownLayout(stored.layout) ? stored.layout : DEFAULT_SETTINGS.layout,
          eye: stored.eye === "right" ? "right" : DEFAULT_SETTINGS.eye,
          headsetMode: stored.headsetMode === "mr" ? "mr" : DEFAULT_SETTINGS.headsetMode,
          panelWidth: clampNumber(Number(stored.panelWidth), 1.4, 6, DEFAULT_SETTINGS.panelWidth),
          panelHeight: clampNumber(Number(stored.panelHeight), 0.8, 3.6, DEFAULT_SETTINGS.panelHeight),
          panelX: clampNumber(Number(stored.panelX), -3, 3, DEFAULT_SETTINGS.panelX),
          panelY: clampNumber(Number(stored.panelY), -1.4, 1.4, DEFAULT_SETTINGS.panelY),
          panelYaw: clampNumber(Number(stored.panelYaw), -35, 35, DEFAULT_SETTINGS.panelYaw),
          panelPitch: clampNumber(Number(stored.panelPitch), -20, 20, DEFAULT_SETTINGS.panelPitch),
          screenCurve: clampNumber(Number(stored.screenCurve), 0, 100, DEFAULT_SETTINGS.screenCurve),
          distance: clampNumber(Number(stored.distance), 1.4, 6, DEFAULT_SETTINGS.distance),
          roomViewX: clampNumber(Number(stored.roomViewX), -2.8, 2.8, DEFAULT_SETTINGS.roomViewX),
          roomViewY: clampNumber(Number(stored.roomViewY), -0.8, 1.8, DEFAULT_SETTINGS.roomViewY),
          roomViewZ: clampNumber(Number(stored.roomViewZ), -3.7, 1.2, DEFAULT_SETTINGS.roomViewZ),
          roomViewYaw: normalizeDegrees(clampNumber(Number(stored.roomViewYaw), -180, 180, DEFAULT_SETTINGS.roomViewYaw)),
          roomViewPitch: clampNumber(Number(stored.roomViewPitch), -35, 35, DEFAULT_SETTINGS.roomViewPitch),
          roomViewPresetVersion: clampNumber(Number(stored.roomViewPresetVersion), 0, 100, 0),
          roomDim: clampNumber(Number(stored.roomDim), 0, 100, DEFAULT_SETTINGS.roomDim),
          sidePanelVisible: Boolean(stored.sidePanelVisible ?? DEFAULT_SETTINGS.sidePanelVisible),
          aspectLocked: stored.aspectLocked !== false,
          backlightMode: isKnownBacklightMode(stored.backlightMode) ? stored.backlightMode : DEFAULT_SETTINGS.backlightMode,
          backlightIntensity: clampNumber(Number(stored.backlightIntensity), 0, 150, DEFAULT_SETTINGS.backlightIntensity),
          spatialAudio: Boolean(stored.spatialAudio ?? DEFAULT_SETTINGS.spatialAudio),
          theme: typeof stored.theme === "string" && stored.theme ? stored.theme : DEFAULT_SETTINGS.theme,
          themeValues: isPlainObject(stored.themeValues) ? stored.themeValues : {},
          themeValueRevisions: isPlainObject(stored.themeValueRevisions) ? stored.themeValueRevisions : {},
          themeObjectStates: isPlainObject(stored.themeObjectStates) ? stored.themeObjectStates : {},
        };
        if (settings.roomViewPresetVersion < DEFAULT_SETTINGS.roomViewPresetVersion && shouldRestoreDesktopRoomView(stored)) {
          settings.roomViewX = DEFAULT_SETTINGS.roomViewX;
          settings.roomViewY = DEFAULT_SETTINGS.roomViewY;
          settings.roomViewZ = DEFAULT_SETTINGS.roomViewZ;
          settings.roomViewYaw = DEFAULT_SETTINGS.roomViewYaw;
          settings.roomViewPitch = DEFAULT_SETTINGS.roomViewPitch;
        }
        settings.roomViewPresetVersion = DEFAULT_SETTINGS.roomViewPresetVersion;
        return settings;
      } catch (error) {
        return { ...DEFAULT_SETTINGS };
      }
    }

    saveSettings() {
      try {
        localStorage.setItem(this.options.storageKey, JSON.stringify(this.settings));
      } catch (error) {
        // Storage may be disabled.
      }
    }

    buildInlineControls() {
      const parent = this.video.parentNode;
      if (!parent) return;
      this.panel = document.createElement("div");
      this.panel.className = "fp-xr-panel fp-three-xr-inline-panel";
      this.panel.innerHTML = `
        <div class="fp-xr-control-row">
          <label class="fp-xr-field">
            <span>View</span>
            <select class="form-select form-select-sm" data-role="layout">
              <option value="mono">Full frame</option>
              <option value="half-sbs">Half SBS 3D</option>
              <option value="full-sbs">Full SBS 3D</option>
            </select>
          </label>
          <label class="fp-xr-field" data-role="eye-field">
            <span>2D eye</span>
            <select class="form-select form-select-sm" data-role="eye">
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
          <label class="fp-xr-field">
            <span>Headset</span>
            <select class="form-select form-select-sm" data-role="headset-mode">
              <option value="vr">VR room</option>
              <option value="mr">MR passthrough</option>
            </select>
          </label>
          <label class="fp-xr-check">
            <input class="form-check-input" type="checkbox" data-role="spatial-audio">
            <span>Spatial audio</span>
          </label>
          <button class="btn btn-sm btn-primary" type="button" data-action="enter-vr">
            <i class="bi bi-badge-vr"></i>
            <span data-role="vr-label">Open XR Theater</span>
          </button>
          <button class="btn btn-sm btn-outline-primary" type="button" data-action="enter-lite">
            <i class="bi bi-badge-3d"></i>
            <span>Open XR Lite</span>
          </button>
        </div>
        <div class="fp-xr-status" data-role="status"></div>
      `;
      if (this.options.fill) {
        this.panel.classList.add("fp-xr-panel-overlay");
        parent.appendChild(this.panel);
      } else {
        parent.insertAdjacentElement("afterend", this.panel);
      }
      this.layoutSelect = this.panel.querySelector("[data-role='layout']");
      this.eyeSelect = this.panel.querySelector("[data-role='eye']");
      this.headsetModeSelect = this.panel.querySelector("[data-role='headset-mode']");
      this.spatialAudioInput = this.panel.querySelector("[data-role='spatial-audio']");
      this.eyeField = this.panel.querySelector("[data-role='eye-field']");
      this.vrButton = this.panel.querySelector("[data-action='enter-vr']");
      this.liteButton = this.panel.querySelector("[data-action='enter-lite']");
      this.vrLabel = this.panel.querySelector("[data-role='vr-label']");
      this.statusElement = this.panel.querySelector("[data-role='status']");
      this.layoutSelect.value = this.settings.layout;
      this.eyeSelect.value = this.settings.eye;
      this.headsetModeSelect.value = this.settings.headsetMode;
      this.spatialAudioInput.checked = Boolean(this.settings.spatialAudio);
      this.eyeField.hidden = this.settings.layout === "mono";
    }

    bindInlineControls() {
      this.listen(this.layoutSelect, "change", () => {
        this.settings.layout = this.layoutSelect.value;
        this.eyeField.hidden = this.settings.layout === "mono";
        if (this.settings.aspectLocked) this.applyAspectRatioFrom("width");
        this.saveSettings();
        this.updateVideoMaterialUv();
        this.updateVideoGeometry();
        this.syncOverlayControls();
        this.updateInlineStatus();
      });
      this.listen(this.eyeSelect, "change", () => {
        this.settings.eye = this.eyeSelect.value === "right" ? "right" : "left";
        this.saveSettings();
        this.updateVideoMaterialUv();
        this.syncOverlayControls();
      });
      this.listen(this.headsetModeSelect, "change", () => {
        this.settings.headsetMode = this.headsetModeSelect.value === "mr" ? "mr" : "vr";
        this.saveSettings();
        this.syncOverlayControls();
        this.updateInlineStatus();
      });
      this.listen(this.spatialAudioInput, "change", () => {
        this.setSpatialAudioEnabled(this.spatialAudioInput.checked);
      });
      this.listen(this.vrButton, "click", () => this.openTheater());
      this.listen(this.liteButton, "click", () => this.openLiteTheater());
      this.listen(this.video, "loadedmetadata", () => {
        if (this.settings.aspectLocked) this.applyAspectRatioFrom("width");
        this.saveSettings();
        this.syncOverlayControls();
        this.updateVideoGeometry();
      });
      this.listen(this.video, "play", () => this.updatePlaybackControls());
      this.listen(this.video, "pause", () => this.updatePlaybackControls());
      this.listen(this.video, "timeupdate", () => this.updatePlaybackControls());
      this.listen(this.video, "volumechange", () => {
        this.updatePlaybackControls();
        this.updateSpatialAudioVolume();
      });
      this.listen(window, "resize", () => this.resizeRenderer());
    }

    listen(target, eventName, handler) {
      if (!target) return;
      target.addEventListener(eventName, handler);
      this.cleanups.push(() => target.removeEventListener(eventName, handler));
    }

    async refreshXrSupport() {
      this.xrSupportChecked = true;
      const canCheck = Boolean(window.isSecureContext && navigator.xr?.isSessionSupported);
      this.xrVrSupported = false;
      this.xrArSupported = false;
      if (canCheck) {
        const [vrSupported, arSupported] = await Promise.all([
          navigator.xr.isSessionSupported("immersive-vr").catch(() => false),
          navigator.xr.isSessionSupported("immersive-ar").catch(() => false),
        ]);
        this.xrVrSupported = Boolean(vrSupported);
        this.xrArSupported = Boolean(arSupported);
      }
      this.xrSupported = this.xrVrSupported || this.xrArSupported;
      if (this.settings.headsetMode === "mr" && !this.xrArSupported) this.settings.headsetMode = "vr";
      this.updateInlineStatus();
      this.syncOverlayControls();
    }

    updateInlineStatus(message = "") {
      if (!this.statusElement) return;
      if (message) {
        this.statusElement.textContent = message;
        return;
      }
      const layout = LAYOUT_LABELS[this.settings.layout] || LAYOUT_LABELS.mono;
      const headset = this.settings.headsetMode === "mr" ? "MR passthrough" : "VR room";
      const spatial = this.settings.spatialAudio ? ` ${this.spatialAudioStatus || "Spatial audio on."}` : "";
      const localDepth = this.localDepthStatus || "";
      const baseStatus = this.xrSupported
        ? `${layout}. ${headset}. Open the theater, then enter the headset from the top bar.`
        : `${layout}. Desktop theater is available; no WebXR headset is visible to this browser.`;
      this.statusElement.textContent = `${baseStatus} XR Lite opens a Full SBS browser view for stereo glasses.${spatial}${localDepth}`;
    }

    async loadThemes() {
      try {
        const response = await fetch("/api/xr/themes", { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`Theme list failed with ${response.status}.`);
        const payload = await response.json();
        this.themes = Array.isArray(payload.themes) ? payload.themes : [];
      } catch (error) {
        this.themes = [];
      }
      if (!this.themes.some((theme) => theme.id === this.settings.theme)) {
        this.settings.theme = this.themes[0]?.id || DEFAULT_SETTINGS.theme;
      }
      if (this.migrateThemeValueDefaults()) this.saveSettings();
      this.syncOverlayControls();
      if (this.scene) this.applyTheme();
      if (this.settings.spatialAudio && this.spatialAudioGraph?.mode === "spatial") {
        this.rebuildSpatialAudioGraph();
      }
    }

    syncThemeOptions() {
      if (!this.themeSelect) return;
      const existing = this.themeSelect.value;
      const themes = this.themes.length
        ? this.themes
        : [{ id: "default", name: "Default room" }];
      this.themeSelect.innerHTML = "";
      for (const theme of themes) {
        const option = document.createElement("option");
        option.value = theme.id;
        option.textContent = theme.name || theme.id;
        this.themeSelect.appendChild(option);
      }
      if (themes.some((theme) => theme.id === this.settings.theme)) {
        this.themeSelect.value = this.settings.theme;
      } else if (themes.some((theme) => theme.id === existing)) {
        this.themeSelect.value = existing;
      }
    }

    currentTheme() {
      return this.themes.find((theme) => theme.id === this.settings.theme) || {
        id: "default",
        name: "Default room",
        background: "#01040a",
        floor: { color: "#162033", grid: true },
        settings: [],
        lights: [],
        assets: [],
      };
    }

    themeSettingDefinitions(theme = this.currentTheme()) {
      return Array.isArray(theme.settings)
        ? theme.settings.filter((setting) => isPlainObject(setting) && setting.id)
        : [];
    }

    themeValueStore(themeId = this.currentTheme().id) {
      if (!isPlainObject(this.settings.themeValues)) this.settings.themeValues = {};
      if (!isPlainObject(this.settings.themeValues[themeId])) this.settings.themeValues[themeId] = {};
      return this.settings.themeValues[themeId];
    }

    migrateThemeValueDefaults(theme = this.currentTheme()) {
      if (!isPlainObject(theme) || !theme.id) return false;
      const revision = Math.max(0, Math.floor(Number(theme.settingsRevision || 0)));
      if (!revision || !isPlainObject(theme.settingsRevisionDefaults)) return false;
      if (!isPlainObject(this.settings.themeValueRevisions)) this.settings.themeValueRevisions = {};
      const currentRevision = Math.max(0, Math.floor(Number(this.settings.themeValueRevisions[theme.id] || 0)));
      const store = this.themeValueStore(theme.id);
      let changed = currentRevision < revision;
      for (const [id, value] of Object.entries(theme.settingsRevisionDefaults)) {
        const next = coerceThemeSettingValue(value, this.themeSettingDefinition(id, theme));
        if (store[id] !== next) {
          store[id] = next;
          changed = true;
        }
      }
      this.settings.themeValueRevisions[theme.id] = revision;
      return changed;
    }

    themeSettingDefinition(id, theme = this.currentTheme()) {
      return this.themeSettingDefinitions(theme).find((setting) => setting.id === id) || null;
    }

    themeSettingValue(id, fallback = null, theme = this.currentTheme()) {
      const definition = this.themeSettingDefinition(id, theme);
      const store = this.themeValueStore(theme.id);
      if (Object.prototype.hasOwnProperty.call(store, id)) return store[id];
      if (definition && Object.prototype.hasOwnProperty.call(definition, "default")) return definition.default;
      return fallback;
    }

    setThemeSettingValue(id, value, options = {}) {
      const theme = this.currentTheme();
      const definition = this.themeSettingDefinition(id, theme);
      const store = this.themeValueStore(theme.id);
      store[id] = coerceThemeSettingValue(value, definition);
      this.saveSettings();
      this.syncThemeSettingsControls();
      if (options.rebuild !== false) this.applyTheme();
    }

    syncThemeSettingsControls() {
      if (!this.themeSettingsContainer) return;
      const theme = this.currentTheme();
      const definitions = this.themeSettingDefinitions(theme);
      const renderKey = `${theme.id}:${definitions.map((item) => `${item.id}:${item.type || "number"}`).join("|")}`;
      if (!definitions.length) {
        this.themeSettingsContainer.hidden = true;
        this.themeSettingsContainer.innerHTML = "";
        this.themeSettingRenderKey = renderKey;
        return;
      }
      this.themeSettingsContainer.hidden = false;
      if (this.themeSettingRenderKey !== renderKey) {
        this.themeSettingsContainer.innerHTML = "";
        for (const definition of definitions) {
          this.themeSettingsContainer.appendChild(this.createThemeSettingControl(definition));
        }
        this.themeSettingRenderKey = renderKey;
      }
      for (const definition of definitions) {
        this.syncThemeSettingControl(definition);
      }
    }

    createThemeSettingControl(definition) {
      const type = String(definition.type || "number").toLowerCase();
      const label = document.createElement("label");
      label.className = type === "boolean" ? "fp-xr-check fp-three-xr-theme-setting" : "fp-xr-range fp-three-xr-theme-setting";
      label.dataset.settingId = definition.id;
      if (type === "boolean") {
        const input = document.createElement("input");
        input.className = "form-check-input";
        input.type = "checkbox";
        input.dataset.settingInput = definition.id;
        input.addEventListener("change", () => this.setThemeSettingValue(definition.id, input.checked));
        const text = document.createElement("span");
        text.textContent = definition.label || definition.id;
        label.append(input, text);
        return label;
      }
      const span = document.createElement("span");
      span.textContent = `${definition.label || definition.id} `;
      const output = document.createElement("output");
      output.dataset.settingOutput = definition.id;
      span.appendChild(output);
      label.appendChild(span);
      if (type === "select" || type === "enum") {
        const select = document.createElement("select");
        select.className = "form-select form-select-sm";
        select.dataset.settingInput = definition.id;
        const options = Array.isArray(definition.options) ? definition.options : [];
        for (const optionValue of options) {
          const option = document.createElement("option");
          option.value = String(optionValue);
          option.textContent = String(optionValue);
          select.appendChild(option);
        }
        select.addEventListener("change", () => this.setThemeSettingValue(definition.id, select.value));
        label.className = "fp-xr-field fp-three-xr-theme-setting";
        label.appendChild(select);
        return label;
      }
      const input = document.createElement("input");
      input.className = "form-range";
      input.type = "range";
      input.min = String(definition.min ?? 0);
      input.max = String(definition.max ?? 1);
      input.step = String(definition.step ?? 0.05);
      input.dataset.settingInput = definition.id;
      input.addEventListener("input", () => this.setThemeSettingValue(definition.id, input.value));
      label.appendChild(input);
      return label;
    }

    syncThemeSettingControl(definition) {
      const input = this.themeSettingsContainer.querySelector(`[data-setting-input="${cssEscape(definition.id)}"]`);
      const output = this.themeSettingsContainer.querySelector(`[data-setting-output="${cssEscape(definition.id)}"]`);
      const value = this.themeSettingValue(definition.id, definition.default);
      if (input?.type === "checkbox") {
        input.checked = Boolean(value);
      } else if (input) {
        input.value = String(value);
      }
      if (output) output.textContent = formatThemeSettingValue(value, definition);
    }

    applyTheme() {
      if (!this.scene || !this.themeGroup || !window.THREE) return;
      if (this.theaterMode === "lite") {
        this.clearThemeObjects();
        this.updateSceneLighting();
        return;
      }
      const revision = this.themeRevision + 1;
      this.themeRevision = revision;
      this.clearThemeObjects();
      const theme = this.currentTheme();
      const floor = typeof theme.floor === "object" && theme.floor ? theme.floor : {};
      if (floor.grid !== false) {
        const grid = new THREE.GridHelper(
          Number(floor.size || 8),
          Number(floor.divisions || 16),
          colorFromTheme(floor.accent || "#2f80ff", new THREE.Color("#2f80ff")),
          colorFromTheme(floor.color || "#1f2937", new THREE.Color("#1f2937")),
        );
        grid.position.y = Number(floor.y ?? -1.65);
        this.themeGroup.add(grid);
        this.gridMesh = grid;
        this.themeObjects.push(grid);
      } else {
        this.gridMesh = null;
      }
      for (const asset of Array.isArray(theme.assets) ? theme.assets : []) {
        this.addThemeAsset(asset, revision);
      }
      for (const light of Array.isArray(theme.lights) ? theme.lights : []) {
        this.addThemeLight(light, revision);
      }
      this.updateSceneLighting();
    }

    clearThemeObjects() {
      for (const object of this.themeObjects || []) {
        object.parent?.remove(object);
        object.traverse?.((child) => {
          child.geometry?.dispose?.();
          if (Array.isArray(child.material)) {
            child.material.forEach((material) => material.dispose?.());
          } else {
            child.material?.map?.dispose?.();
            child.material?.dispose?.();
          }
        });
        object.geometry?.dispose?.();
        object.material?.dispose?.();
      }
      this.themeObjects = [];
      this.themeObjectById = new Map();
      this.themeInteractiveObjects = [];
      this.themeAnimatedObjects = [];
      this.themeSampledObjects = [];
      this.themeVideoSampleColors = null;
      this.themeMovableDrag = null;
      if (this.themeGroup) this.themeGroup.clear();
    }

    addThemeAsset(asset, revision = this.themeRevision) {
      if (!asset) return;
      if (asset.type === "image") {
        if (!asset.url) return;
        const texture = new THREE.TextureLoader().load(asset.url);
        texture.colorSpace = THREE.SRGBColorSpace;
        const additive = asset.blending === "additive" || asset.glow === true;
        const opacity = this.resolveThemeOpacity(asset, 1);
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: additive || opacity < 1,
          opacity: clampNumber(opacity, 0, additive ? 3 : 1, 1),
          side: THREE.DoubleSide,
          depthWrite: additive ? false : asset.depthWrite !== false,
          depthTest: asset.depthTest === false ? false : true,
          blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
        mesh.renderOrder = Number(asset.renderOrder || 0);
        this.configureThemeObject(mesh, asset, revision);
        if (revision === this.themeRevision) {
          this.themeGroup.add(mesh);
          this.themeObjects.push(mesh);
        }
      } else if (asset.type === "obj") {
        if (!asset.url) return;
        fetch(asset.url)
          .then((response) => response.ok ? response.text() : "")
          .then((text) => {
            if (!text || !this.themeGroup || revision !== this.themeRevision) return;
            const geometry = parseObjGeometry(text);
            if (!geometry) return;
            const material = this.createThemeSurfaceMaterial(asset, "#94a3b8");
            const mesh = new THREE.Mesh(geometry, material);
            this.configureThemeObject(mesh, asset, revision);
            if (revision === this.themeRevision) {
              this.themeGroup.add(mesh);
              this.themeObjects.push(mesh);
            }
          })
          .catch(() => {});
      } else if (asset.type === "light") {
        this.addThemeLight(asset, revision);
      } else if (asset.type === "empty") {
        const group = new THREE.Group();
        this.configureThemeObject(group, asset, revision);
        if (revision === this.themeRevision) {
          this.themeGroup.add(group);
          this.themeObjects.push(group);
        }
      } else if (asset.type === "box") {
        const size = Array.isArray(asset.size) ? asset.size : [1, 1, 1];
        const geometry = new THREE.BoxGeometry(
          Number(size[0] ?? 1),
          Number(size[1] ?? 1),
          Number(size[2] ?? 1),
        );
        const materialType = String(asset.material || "").toLowerCase();
        const useSurfaceMaterial = materialType === "glass" || (asset.material !== "basic" && (asset.lit === true || asset.roughness !== undefined || asset.metalness !== undefined || asset.emissive !== undefined));
        const material = useSurfaceMaterial && THREE.MeshStandardMaterial
          ? this.createThemeSurfaceMaterial(asset, "#334155")
          : new THREE.MeshBasicMaterial({
              color: this.resolveThemeColor(asset.color, "#334155"),
              transparent: this.resolveThemeOpacity(asset, 1) < 1,
              opacity: clampNumber(this.resolveThemeOpacity(asset, 1), 0, 1, 1),
            });
        const mesh = new THREE.Mesh(geometry, material);
        this.configureThemeObject(mesh, asset, revision);
        if (revision === this.themeRevision) {
          this.themeGroup.add(mesh);
          this.themeObjects.push(mesh);
        }
      }
    }

    createThemeSurfaceMaterial(asset, fallbackColor) {
      const opacity = clampNumber(this.resolveThemeOpacity(asset, 1), 0, 1, 1);
      const color = this.resolveThemeColor(asset.color, fallbackColor);
      const materialType = String(asset.material || "").toLowerCase();
      if (asset.material === "basic" || !THREE.MeshStandardMaterial) {
        return new THREE.MeshBasicMaterial({
          color,
          wireframe: Boolean(asset.wireframe),
          transparent: opacity < 1,
          opacity,
        });
      }
      if (materialType === "glass") {
        const glassOpacity = clampNumber(this.resolveThemeOpacity(asset, 0.32), 0.04, 0.85, 0.32);
        const glassConfig = {
          color,
          roughness: clampNumber(this.resolveThemeNumber(asset.roughness, 0.04), 0, 1, 0.04),
          metalness: clampNumber(this.resolveThemeNumber(asset.metalness, 0), 0, 1, 0),
          emissive: this.resolveThemeColor(asset.emissive, "#000000"),
          emissiveIntensity: clampNumber(this.resolveThemeNumber(asset.emissiveIntensity, 0), 0, 8, 0),
          wireframe: Boolean(asset.wireframe),
          transparent: true,
          opacity: glassOpacity,
          depthWrite: asset.depthWrite === true,
          depthTest: asset.depthTest === false ? false : true,
          side: THREE.DoubleSide,
        };
        if (THREE.MeshPhysicalMaterial) {
          return new THREE.MeshPhysicalMaterial({
            ...glassConfig,
            transmission: clampNumber(this.resolveThemeNumber(asset.transmission, 0.62), 0, 1, 0.62),
            thickness: clampNumber(this.resolveThemeNumber(asset.thickness, 0.08), 0, 5, 0.08),
            ior: clampNumber(this.resolveThemeNumber(asset.ior, 1.45), 1, 2.333, 1.45),
            clearcoat: clampNumber(this.resolveThemeNumber(asset.clearcoat, 0.85), 0, 1, 0.85),
            clearcoatRoughness: clampNumber(this.resolveThemeNumber(asset.clearcoatRoughness, 0.08), 0, 1, 0.08),
            attenuationColor: this.resolveThemeColor(asset.attenuationColor, asset.color || fallbackColor),
            attenuationDistance: clampNumber(this.resolveThemeNumber(asset.attenuationDistance, 2.6), 0.01, 1000, 2.6),
          });
        }
        return new THREE.MeshStandardMaterial(glassConfig);
      }
      return new THREE.MeshStandardMaterial({
        color,
        roughness: clampNumber(this.resolveThemeNumber(asset.roughness, 0.82), 0, 1, 0.82),
        metalness: clampNumber(this.resolveThemeNumber(asset.metalness, 0.18), 0, 1, 0.18),
        emissive: this.resolveThemeColor(asset.emissive, "#000000"),
        emissiveIntensity: clampNumber(this.resolveThemeNumber(asset.emissiveIntensity, 0), 0, 8, 0),
        wireframe: Boolean(asset.wireframe),
        transparent: opacity < 1,
        opacity,
      });
    }

    addThemeLight(light, revision = this.themeRevision) {
      if (!isPlainObject(light)) return;
      const type = String(light.type || "point").toLowerCase();
      const color = this.resolveThemeColor(light.color, "#ffffff");
      const intensity = this.resolveThemeNumber(light.intensitySetting ? `$${light.intensitySetting}` : light.intensity, 1);
      let object = null;
      if (type === "ambient") {
        object = new THREE.AmbientLight(color, intensity);
      } else if (type === "directional") {
        object = new THREE.DirectionalLight(color, intensity);
      } else if (type === "spot") {
        object = new THREE.SpotLight(
          color,
          intensity,
          this.resolveThemeNumber(light.distance, 0),
          THREE.MathUtils.degToRad(this.resolveThemeNumber(light.angle, 35)),
          clampNumber(this.resolveThemeNumber(light.penumbra, 0.35), 0, 1, 0.35),
        );
      } else if (type === "hemisphere") {
        object = new THREE.HemisphereLight(
          color,
          this.resolveThemeColor(light.groundColor, "#0f172a"),
          intensity,
        );
      } else {
        object = new THREE.PointLight(
          color,
          intensity,
          this.resolveThemeNumber(light.distance, 0),
          this.resolveThemeNumber(light.decay, 2),
        );
      }
      this.configureThemeObject(object, light, revision);
      if (Array.isArray(light.target) && object.target) {
        object.target.position.set(
          this.resolveThemeNumber(light.target[0], 0),
          this.resolveThemeNumber(light.target[1], 0),
          this.resolveThemeNumber(light.target[2], -1),
        );
        this.themeGroup.add(object.target);
        this.themeObjects.push(object.target);
      }
      if (revision === this.themeRevision) {
        this.themeGroup.add(object);
        this.themeObjects.push(object);
      }
    }

    configureThemeObject(object, config, revision) {
      this.applyThemeTransform(object, config);
      if (config.renderOrder !== undefined) object.renderOrder = Number(config.renderOrder) || 0;
      object.visible = this.resolveThemeBoolean(config.visibleSetting ? `$${config.visibleSetting}` : config.visible, true);
      object.userData.themeConfig = config;
      object.userData.themeRevision = revision;
      object.userData.themeBasePosition = object.position.clone();
      object.userData.themeBaseRotation = object.rotation.clone();
      object.userData.themeBaseScale = object.scale.clone();
      object.userData.themeBaseIntensity = Number(object.intensity ?? 0);
      if (object.color?.clone) object.userData.themeBaseColor = object.color.clone();
      object.userData.themeBaseOpacity = Array.isArray(object.material)
        ? Number(object.material[0]?.opacity ?? 1)
        : Number(object.material?.opacity ?? 1);
      if (config.id) {
        this.themeObjectById.set(String(config.id), object);
      }
      if (config.interaction || config.movable) {
        object.userData.themeInteractive = true;
        this.themeInteractiveObjects.push(object);
      }
      if (config.animation) {
        this.themeAnimatedObjects.push(object);
      }
      if (config.videoSample) {
        this.themeSampledObjects.push(object);
      }
    }

    applyThemeTransform(object, asset) {
      const position = Array.isArray(asset.position) ? asset.position : [0, 0, -4];
      const scale = Array.isArray(asset.scale) ? asset.scale : [1, 1, 1];
      const rotation = Array.isArray(asset.rotation) ? asset.rotation : [0, 0, 0];
      const state = asset.id ? this.themeObjectState(asset.id) : null;
      const finalPosition = Array.isArray(state?.position) ? state.position : position;
      object.position.set(
        this.resolveThemeNumber(finalPosition[0], 0),
        this.resolveThemeNumber(finalPosition[1], 0),
        this.resolveThemeNumber(finalPosition[2], -4),
      );
      object.scale.set(
        this.resolveThemeNumber(scale[0], 1),
        this.resolveThemeNumber(scale[1], scale[0] ?? 1),
        this.resolveThemeNumber(scale[2], 1),
      );
      object.rotation.set(
        THREE.MathUtils.degToRad(this.resolveThemeNumber(rotation[0], 0)),
        THREE.MathUtils.degToRad(this.resolveThemeNumber(rotation[1], 0)),
        THREE.MathUtils.degToRad(this.resolveThemeNumber(rotation[2], 0)),
      );
    }

    resolveThemeValue(value, fallback = null) {
      if (typeof value === "string" && value.startsWith("$")) {
        return this.themeSettingValue(value.slice(1), fallback);
      }
      if (value === undefined || value === null || value === "") return fallback;
      return value;
    }

    resolveThemeNumber(value, fallback = 0) {
      const resolved = this.resolveThemeValue(value, fallback);
      return clampNumber(Number(resolved), -100000, 100000, fallback);
    }

    resolveThemeBoolean(value, fallback = true) {
      const resolved = this.resolveThemeValue(value, fallback);
      if (typeof resolved === "boolean") return resolved;
      if (typeof resolved === "string") return !["false", "0", "off", "no"].includes(resolved.toLowerCase());
      return Boolean(resolved);
    }

    resolveThemeOpacity(config, fallback = 1) {
      const base = config.opacitySetting ? this.themeSettingValue(config.opacitySetting, fallback) : this.resolveThemeValue(config.opacity, fallback);
      return this.resolveThemeNumber(Number(base) * this.resolveThemeNumber(config.opacityMultiplier, 1), fallback);
    }

    resolveThemeColor(value, fallback) {
      return colorFromTheme(this.resolveThemeValue(value, fallback), new THREE.Color(fallback));
    }

    themeObjectState(id) {
      const themeId = this.currentTheme().id;
      const allStates = isPlainObject(this.settings.themeObjectStates) ? this.settings.themeObjectStates : {};
      const themeStates = isPlainObject(allStates[themeId]) ? allStates[themeId] : {};
      return isPlainObject(themeStates[id]) ? themeStates[id] : null;
    }

    setThemeObjectState(id, state) {
      const themeId = this.currentTheme().id;
      if (!isPlainObject(this.settings.themeObjectStates)) this.settings.themeObjectStates = {};
      if (!isPlainObject(this.settings.themeObjectStates[themeId])) this.settings.themeObjectStates[themeId] = {};
      this.settings.themeObjectStates[themeId][id] = state;
      this.saveSettings();
    }

    openTheater() {
      this.openTheaterMode("theater");
    }

    openLiteTheater() {
      this.openTheaterMode("lite");
    }

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
      this.inTheater = true;
      this.buildOverlay();
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
      if (this.theaterMode === "lite") this.requestLiteFullscreen();
    }

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
      if (document.fullscreenElement === this.overlay && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
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
      if (this.backlightGroup) {
        this.disposeBacklight();
      }
      if (this.renderer) this.renderer.dispose();
      this.renderer = null;
      this.scene = null;
      this.camera = null;
      this.liteLeftCamera = null;
      this.liteRightCamera = null;
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
      this.xrThumbstickSeekDirection = 0;
      this.xrThumbstickSeekAt = 0;
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
      document.body.classList.remove("fp-three-xr-active");
      if (this.settings.spatialAudio) {
        this.rebuildSpatialAudioGraph();
      } else {
        this.enableAudioPassthrough();
      }
    }

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
              <i class="bi bi-arrows-fullscreen"></i>
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
      this.liteToolsToggleButton = this.overlay.querySelector("[data-action='toggle-lite-tools']");
      this.liteToolsLabel = this.overlay.querySelector("[data-role='lite-tools-label']");
      this.sidePanelToggleButton = this.overlay.querySelector("[data-action='toggle-side-panel']");
      this.sidePanelLabel = this.overlay.querySelector("[data-role='side-panel-label']");
      this.sideSlot = this.overlay.querySelector("[data-role='side-slot']");
      this.overlay.querySelector("[data-action='close']").addEventListener("click", () => this.closeTheater());
      this.overlay.querySelector("[data-action='recenter']").addEventListener("click", () => this.recenterScreen());
      this.overlay.querySelector("[data-action='fullscreen-lite']").addEventListener("click", () => this.requestLiteFullscreen());
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
        this.migrateThemeValueDefaults();
        this.saveSettings();
        this.themeSettingRenderKey = "";
        this.syncOverlayControls();
        this.applyTheme();
        this.rebuildSpatialAudioGraph();
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
      this.distanceInput.addEventListener("input", () => this.updateNumericSetting("distance", this.distanceInput.value));
      this.dimInput.addEventListener("input", () => this.updateNumericSetting("roomDim", this.dimInput.value));
      this.backlightIntensityInput.addEventListener("input", () => this.updateNumericSetting("backlightIntensity", this.backlightIntensityInput.value));
      this.syncOverlayControls();
    }

    syncOverlayControls() {
      if (this.headsetModeSelect) {
        this.headsetModeSelect.value = this.settings.headsetMode;
        this.headsetModeSelect.querySelector("option[value='mr']").disabled = !this.xrArSupported;
      }
      if (this.spatialAudioInput) this.spatialAudioInput.checked = Boolean(this.settings.spatialAudio);
      if (!this.overlay) return;
      this.syncTheaterModeControls();
      this.overlayHeadsetModeSelect.value = this.settings.headsetMode;
      this.overlayHeadsetModeSelect.querySelector("option[value='mr']").disabled = !this.xrArSupported;
      this.syncThemeOptions();
      this.themeSelect.value = this.settings.theme;
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
      this.distanceInput.value = String(this.settings.distance);
      this.dimInput.value = String(this.settings.roomDim);
      this.widthLabel.textContent = `${this.settings.panelWidth.toFixed(1)}m`;
      this.heightLabel.textContent = `${this.settings.panelHeight.toFixed(1)}m`;
      this.xLabel.textContent = `${this.settings.panelX.toFixed(2)}m`;
      this.yLabel.textContent = `${this.settings.panelY.toFixed(2)}m`;
      this.yawLabel.textContent = `${Math.round(this.settings.panelYaw)}°`;
      this.pitchLabel.textContent = `${Math.round(this.settings.panelPitch)}°`;
      this.curveLabel.textContent = this.settings.screenCurve > 0 ? `${Math.round(this.settings.screenCurve)}%` : "Flat";
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
          this.theaterStatus.textContent = `${mode} · ${LAYOUT_LABELS[this.settings.layout] || "Video"} · ${this.settings.panelWidth.toFixed(1)} x ${this.settings.panelHeight.toFixed(1)}m`;
        }
      }
    }

    syncTheaterModeControls() {
      if (!this.overlay) return;
      const lite = this.theaterMode === "lite";
      this.overlay.classList.toggle("fp-three-xr-lite-mode", lite);
      this.overlay.classList.toggle("fp-three-xr-lite-tools-open", lite && this.liteToolsVisible);
      if (this.theaterTitle) this.theaterTitle.textContent = lite ? "XR Lite" : "XR Theater";
      if (this.liteToolsLabel) this.liteToolsLabel.textContent = this.liteToolsVisible ? "Hide settings" : "Settings";
      for (const element of this.overlay.querySelectorAll("[data-lite-hidden]")) {
        element.hidden = lite;
      }
      for (const element of this.overlay.querySelectorAll("[data-lite-only]")) {
        element.hidden = !lite;
      }
      if (this.sideSlot && lite) this.sideSlot.hidden = true;
    }

    toggleLiteTools() {
      this.liteToolsVisible = !this.liteToolsVisible;
      this.syncTheaterModeControls();
    }

    updateTheaterModeScene() {
      this.syncTheaterModeControls();
      this.updateDesktopCamera();
      this.updateSceneLighting();
      this.updateVideoGeometry();
      this.updateSpatialAudio();
    }

    requestLiteFullscreen() {
      if (this.theaterMode !== "lite" || !this.overlay?.requestFullscreen) return;
      if (document.fullscreenElement) return;
      this.overlay.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
    }

    updateNumericSetting(key, value) {
      const limits = {
        panelWidth: [1.4, 6],
        panelHeight: [0.8, 3.6],
        panelX: [-3, 3],
        panelY: [-1.4, 1.4],
        panelYaw: [-35, 35],
        panelPitch: [-20, 20],
        screenCurve: [0, 100],
        distance: [1.4, 6],
        roomDim: [0, 100],
        backlightIntensity: [0, 150],
      }[key];
      this.settings[key] = clampNumber(Number(value), limits[0], limits[1], DEFAULT_SETTINGS[key]);
      this.saveSettings();
      this.syncOverlayControls();
      this.updateVideoGeometry();
      this.updateSceneLighting();
      this.updateSpatialAudio();
      if (key === "backlightIntensity") this.updateBacklight(true);
    }

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
    }

    applyAspectRatioFrom(axis = "width") {
      const aspect = this.videoAspectRatio();
      const value = axis === "height" ? this.settings.panelHeight : this.settings.panelWidth;
      const size = lockedPanelSize(axis, value, aspect, this.settings);
      this.settings.panelWidth = size.width;
      this.settings.panelHeight = size.height;
    }

    videoAspectRatio() {
      const generatedStereoAspect = this.generatedStereoSourceAspectRatio();
      if (generatedStereoAspect) return generatedStereoAspect;
      const width = Number(this.video.videoWidth || 16);
      const height = Number(this.video.videoHeight || 9);
      if (!width || !height) return 16 / 9;
      if (this.settings.layout === "full-sbs") return Math.max(0.1, (width / 2) / height);
      return Math.max(0.1, width / height);
    }

    generatedStereoSourceAspectRatio() {
      const profile = isPlainObject(this.options.playbackProfile) ? this.options.playbackProfile : {};
      const profileLayout = profile.targetVideoLayout || profile.videoLayout || this.options.sourceLayout || "";
      const stereoLayout = ["half-sbs", "full-sbs"].includes(profileLayout) ? profileLayout : "";
      const generatedStereo = Boolean(profile.localStereoProcessor || profile.sourceKind === "hls-live");
      if (!generatedStereo || !stereoLayout) return 0;
      return mediaInfoVideoAspectRatio(this.mediaInfo());
    }

    recenterScreen(options = {}) {
      this.settings.panelX = 0;
      this.settings.panelY = 0;
      this.settings.panelYaw = 0;
      this.settings.panelPitch = 0;
      if (options.resetDistance) {
        this.settings.distance = DEFAULT_SETTINGS.distance;
        this.settings.panelWidth = DEFAULT_SETTINGS.panelWidth;
        this.settings.panelHeight = DEFAULT_SETTINGS.panelHeight;
      }
      this.saveSettings();
      this.syncOverlayControls();
      this.updateVideoGeometry();
      this.updateSpatialAudio();
    }

    toggleSidePanel(force = null) {
      this.settings.sidePanelVisible = force === null ? !this.settings.sidePanelVisible : Boolean(force);
      this.saveSettings();
      this.syncOverlayControls();
      this.updateXrSidePanelTexture(true);
    }

    syncSidePanelVisibility() {
      if (this.sideSlot) this.sideSlot.hidden = !this.settings.sidePanelVisible;
    }

    zoomScreen(distanceDelta) {
      this.updateNumericSetting("distance", this.settings.distance + distanceDelta);
    }

    resetRoomView() {
      this.settings.roomViewX = DEFAULT_SETTINGS.roomViewX;
      this.settings.roomViewY = DEFAULT_SETTINGS.roomViewY;
      this.settings.roomViewZ = DEFAULT_SETTINGS.roomViewZ;
      this.settings.roomViewYaw = DEFAULT_SETTINGS.roomViewYaw;
      this.settings.roomViewPitch = DEFAULT_SETTINGS.roomViewPitch;
      this.desktopKeys.clear();
      this.saveSettings();
      this.updateDesktopCamera();
    }

    bindDesktopStageControls() {
      if (!this.canvas) return;
      this.canvas.tabIndex = 0;
      this.listenOverlay(this.canvas, "contextmenu", (event) => event.preventDefault());
      this.listenOverlay(this.canvas, "pointerdown", (event) => this.startDesktopDrag(event));
      this.listenOverlay(this.canvas, "pointermove", (event) => this.updateDesktopDrag(event));
      this.listenOverlay(this.canvas, "pointerup", (event) => this.endDesktopDrag(event));
      this.listenOverlay(this.canvas, "pointercancel", (event) => this.endDesktopDrag(event));
      this.listenOverlay(this.canvas, "lostpointercapture", (event) => this.endDesktopDrag(event));
      this.listenOverlay(window, "keydown", (event) => this.handleDesktopKeyDown(event));
      this.listenOverlay(window, "keyup", (event) => this.handleDesktopKeyUp(event));
    }

    listenOverlay(target, eventName, handler) {
      target.addEventListener(eventName, handler);
      this.overlayCleanups.push(() => target.removeEventListener(eventName, handler));
    }

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
    }

    desktopDragModeForEvent(event) {
      if (event.shiftKey && event.button === 2) return "room-look";
      if (event.shiftKey) return "room-move";
      return event.button === 2 ? "screen-rotate" : "screen-move";
    }

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
    }

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
        -2.8,
        2.8,
        DEFAULT_SETTINGS.roomViewX,
      );
      this.settings.roomViewZ = clampNumber(
        this.desktopDrag.startRoomViewZ + rightZ * strafe + forwardZ * forward,
        -3.7,
        1.2,
        DEFAULT_SETTINGS.roomViewZ,
      );
    }

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
    }

    themeHitFromPointer(event) {
      if (!this.themeRaycaster || !this.themePointer || !this.camera || !this.canvas || !this.themeInteractiveObjects.length) return null;
      const rect = this.canvas.getBoundingClientRect();
      this.themePointer.set(
        ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
        -(((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1),
      );
      this.themeRaycaster.setFromCamera(this.themePointer, this.camera);
      return this.themeRaycaster.intersectObjects(this.themeInteractiveObjects.filter((object) => object.visible), true)[0] || null;
    }

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
    }

    handleDesktopKeyDown(event) {
      if (this.xrSession || isEditableTarget(event.target)) return;
      const key = normalizedNavigationKey(event);
      if (!key) return;
      event.preventDefault();
      this.desktopKeys.add(key);
    }

    handleDesktopKeyUp(event) {
      const key = normalizedNavigationKey(event);
      if (!key) return;
      this.desktopKeys.delete(key);
      this.saveSettings();
    }

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
        -2.8,
        2.8,
        DEFAULT_SETTINGS.roomViewX,
      );
      this.settings.roomViewY = clampNumber(
        this.settings.roomViewY + vertical,
        -0.8,
        1.8,
        DEFAULT_SETTINGS.roomViewY,
      );
      this.settings.roomViewZ = clampNumber(
        this.settings.roomViewZ + rightZ * strafe + forwardZ * forward,
        -3.7,
        1.2,
        DEFAULT_SETTINGS.roomViewZ,
      );
      this.updateDesktopCamera();
    }

    updateDesktopCamera() {
      if (!this.camera || this.xrSession) return;
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
      this.camera.position.set(this.settings.roomViewX, this.settings.roomViewY, this.settings.roomViewZ);
      this.camera.rotation.set(
        THREE.MathUtils.degToRad(this.settings.roomViewPitch),
        THREE.MathUtils.degToRad(this.settings.roomViewYaw),
        0,
      );
    }

    updateThemeAnimations(elapsedSeconds) {
      for (const object of this.themeAnimatedObjects) {
        const config = object.userData.themeConfig || {};
        const animation = isPlainObject(config.animation) ? config.animation : { type: config.animation };
        const type = String(animation.type || "pulse");
        const speed = this.resolveThemeNumber(animation.speed, 1);
        const phase = this.resolveThemeNumber(animation.phase, 0);
        const wave = Math.sin(elapsedSeconds * speed * Math.PI * 2 + phase);
        if (type === "rotate") {
          const axis = String(animation.axis || "y").toLowerCase();
          const amount = THREE.MathUtils.degToRad(this.resolveThemeNumber(animation.amount, 35) * elapsedSeconds * speed);
          object.rotation.copy(object.userData.themeBaseRotation);
          if (axis.includes("x")) object.rotation.x += amount;
          if (axis.includes("y")) object.rotation.y += amount;
          if (axis.includes("z")) object.rotation.z += amount;
        } else if (type === "bob" || type === "sway") {
          const amplitude = this.resolveThemeNumber(animation.amplitude, 0.05);
          const axis = String(animation.axis || "y").toLowerCase();
          object.position.copy(object.userData.themeBasePosition);
          if (axis.includes("x")) object.position.x += wave * amplitude;
          if (axis.includes("y")) object.position.y += wave * amplitude;
          if (axis.includes("z")) object.position.z += wave * amplitude;
        } else {
          const amplitude = this.resolveThemeNumber(animation.amplitude, 0.25);
          const factor = 1 + wave * amplitude;
          if (typeof object.intensity === "number") {
            object.intensity = Math.max(0, object.userData.themeBaseIntensity * factor);
          }
          const opacity = clampNumber(object.userData.themeBaseOpacity * factor, 0, config.glow ? 3 : 1, object.userData.themeBaseOpacity);
          setObjectOpacity(object, opacity);
        }
      }
    }

    themeWantsVideoSampling() {
      const theme = this.currentTheme();
      return Boolean(theme.videoSampling || this.themeSampledObjects.length);
    }

    updateThemeVideoSampling() {
      if (!this.themeWantsVideoSampling() || !this.backlightSegments?.length) return;
      const colors = this.sampleVideoEdgeColors();
      this.themeVideoSampleColors = colors;
      for (const object of this.themeSampledObjects) {
        this.applyThemeVideoSample(object, colors);
      }
    }

    applyThemeVideoSample(object, colors) {
      const config = object?.userData?.themeConfig || {};
      const sample = themeVideoSampleColor(colors, config.videoSample) || offBacklightColor();
      const sampleVisible = isVisibleBacklightColor(sample);
      const color = sampleVisible ? new THREE.Color(sample.r, sample.g, sample.b) : null;
      const multiplier = clampNumber(this.resolveThemeNumber(config.videoSampleMultiplier, 1), 0, 20, 1);
      const sampleLevel = sampleVisible ? clampNumber(Number(sample.opacity || 0) * multiplier, 0, 4, 0) : 0;
      if (object.isLight && object.color) {
        object.color.copy(color || object.userData.themeBaseColor || object.color);
        const minIntensity = clampNumber(this.resolveThemeNumber(config.videoSampleMinIntensity, 0), 0, 20, 0);
        const maxIntensity = clampNumber(this.resolveThemeNumber(config.videoSampleMaxIntensity, object.userData.themeBaseIntensity * 2.2 || 2), 0, 50, 2);
        object.intensity = clampNumber(object.userData.themeBaseIntensity * sampleLevel, minIntensity, maxIntensity, object.userData.themeBaseIntensity);
        return;
      }
      const target = String(config.videoSampleTarget || "emissive").toLowerCase();
      for (const material of objectMaterials(object)) {
        if (!material) continue;
        if (!material.userData.themeBaseColor && material.color) material.userData.themeBaseColor = material.color.clone();
        if (!material.userData.themeBaseEmissive && material.emissive) material.userData.themeBaseEmissive = material.emissive.clone();
        if (material.userData.themeBaseEmissiveIntensity === undefined) {
          material.userData.themeBaseEmissiveIntensity = Number(material.emissiveIntensity || 0);
        }
        if (target === "color" || target === "both") {
          material.color?.copy(color || material.userData.themeBaseColor || material.color);
        }
        if ((target === "emissive" || target === "both") && material.emissive) {
          material.emissive.copy(color || material.userData.themeBaseEmissive || material.emissive);
          const base = Number(material.userData.themeBaseEmissiveIntensity || 0);
          const min = clampNumber(this.resolveThemeNumber(config.videoSampleMinIntensity, base), 0, 20, base);
          const max = clampNumber(this.resolveThemeNumber(config.videoSampleMaxIntensity, base + 2.5), 0, 50, base + 2.5);
          material.emissiveIntensity = clampNumber(base + sampleLevel, min, max, base);
        }
        if (config.videoSampleOpacity) {
          if (material.userData.themeBaseOpacity === undefined) material.userData.themeBaseOpacity = Number(material.opacity ?? 1);
          material.opacity = clampNumber(material.userData.themeBaseOpacity * sampleLevel, 0, 1, material.userData.themeBaseOpacity);
          material.transparent = material.transparent || material.opacity < 1;
        }
      }
    }

    async setSpatialAudioEnabled(enabled) {
      const nextEnabled = Boolean(enabled);
      this.settings.spatialAudio = nextEnabled;
      this.saveSettings();
      this.syncOverlayControls();
      if (!nextEnabled) {
        this.enableAudioPassthrough();
        this.spatialAudioStatus = "Spatial audio off.";
        this.syncOverlayControls();
        this.updateInlineStatus();
        this.updateXrSidePanelTexture(true);
        return;
      }
      if (typeof this.options.onSpatialAudioPreference === "function") {
        try {
          await this.options.onSpatialAudioPreference(true, this);
        } catch (error) {
          this.spatialAudioStatus = error?.message || "Spatial audio source switch failed.";
        }
      }
      if (!this.ensureSpatialAudioGraph()) {
        this.settings.spatialAudio = false;
        this.saveSettings();
        this.syncOverlayControls();
        this.updateInlineStatus();
        return;
      }
      await this.spatialAudioGraph.context.resume().catch(() => {});
      this.rebuildSpatialAudioGraph();
      this.updateXrSidePanelTexture(true);
    }

    ensureSpatialAudioGraph() {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        this.spatialAudioStatus = "Web Audio is unavailable in this browser.";
        return null;
      }
      let graph = AUDIO_GRAPH_BY_VIDEO.get(this.video);
      if (graph) {
        this.spatialAudioGraph = graph;
        return graph;
      }
      try {
        const context = new AudioContextClass();
        const source = context.createMediaElementSource(this.video);
        source.channelInterpretation = "discrete";
        const passthroughGain = context.createGain();
        const masterGain = context.createGain();
        graph = {
          context,
          source,
          passthroughGain,
          masterGain,
          splitter: null,
          nodes: [],
          mode: "",
        };
        AUDIO_GRAPH_BY_VIDEO.set(this.video, graph);
        this.spatialAudioGraph = graph;
        this.connectAudioPassthrough(graph);
        return graph;
      } catch (error) {
        this.spatialAudioStatus = error?.message || "Could not attach Web Audio to this video.";
        return null;
      }
    }

    rebuildSpatialAudioGraph() {
      if (!this.settings.spatialAudio) {
        this.enableAudioPassthrough();
        return;
      }
      if (!window.THREE) {
        this.spatialAudioStatus = "Spatial audio needs Three.js for speaker placement.";
        this.syncOverlayControls();
        this.updateInlineStatus();
        return;
      }
      const graph = this.ensureSpatialAudioGraph();
      if (!graph) return;
      this.disconnectSpatialAudioGraph(graph);
      const channelCount = this.spatialAudioChannelCount();
      const labels = this.spatialAudioChannelLabels(channelCount);
      const speakers = this.spatialSpeakerDefinitions(labels);
      try {
        graph.splitter = graph.context.createChannelSplitter(channelCount);
        graph.splitter.channelInterpretation = "discrete";
        graph.source.connect(graph.splitter);
        graph.masterGain.connect(graph.context.destination);
        graph.nodes = speakers.map((speaker, index) => this.connectSpatialSpeakerNode(graph, speaker, index));
        graph.mode = "spatial";
        this.spatialAudioGraph = graph;
        this.spatialAudioNodes = graph.nodes;
        this.updateSpatialAudioVolume();
        this.updateSpatialAudio();
        this.spatialAudioStatus = this.spatialAudioStatusText(channelCount, speakers);
        this.syncOverlayControls();
        this.updateInlineStatus();
      } catch (error) {
        this.spatialAudioStatus = error?.message || "Could not build spatial audio graph.";
        this.enableAudioPassthrough();
        this.syncOverlayControls();
        this.updateInlineStatus();
      }
    }

    connectSpatialSpeakerNode(graph, speaker, outputIndex) {
      const gain = graph.context.createGain();
      gain.gain.value = clampNumber(Number(speaker.gain), 0, 4, 1);
      const nodeRecord = { speaker, gain, panner: null, lowpass: null };
      graph.splitter.connect(gain, outputIndex);
      if (speaker.lfe || normalizeSpeakerChannel(speaker.channel) === "LFE") {
        const lowpass = graph.context.createBiquadFilter();
        lowpass.type = "lowpass";
        lowpass.frequency.value = clampNumber(Number(speaker.frequency), 40, 240, 120);
        gain.connect(lowpass);
        lowpass.connect(graph.masterGain);
        nodeRecord.lowpass = lowpass;
        return nodeRecord;
      }
      const panner = graph.context.createPanner();
      panner.panningModel = speaker.panningModel === "equalpower" ? "equalpower" : "HRTF";
      panner.distanceModel = speaker.distanceModel || "inverse";
      panner.refDistance = clampNumber(Number(speaker.refDistance), 0.1, 20, 1.2);
      panner.maxDistance = clampNumber(Number(speaker.maxDistance), 1, 1000, 18);
      panner.rolloffFactor = clampNumber(Number(speaker.rolloffFactor), 0, 10, 0.6);
      panner.coneInnerAngle = clampNumber(Number(speaker.coneInnerAngle), 0, 360, 360);
      panner.coneOuterAngle = clampNumber(Number(speaker.coneOuterAngle), 0, 360, 360);
      panner.coneOuterGain = clampNumber(Number(speaker.coneOuterGain), 0, 1, 0);
      gain.connect(panner);
      panner.connect(graph.masterGain);
      nodeRecord.panner = panner;
      return nodeRecord;
    }

    disconnectSpatialAudioGraph(graph = this.spatialAudioGraph) {
      if (!graph) return;
      safeDisconnect(graph.source);
      safeDisconnect(graph.passthroughGain);
      safeDisconnect(graph.masterGain);
      safeDisconnect(graph.splitter);
      for (const record of graph.nodes || []) {
        safeDisconnect(record.gain);
        safeDisconnect(record.panner);
        safeDisconnect(record.lowpass);
      }
      graph.splitter = null;
      graph.nodes = [];
      graph.mode = "";
      this.spatialAudioNodes = [];
    }

    enableAudioPassthrough() {
      const graph = this.spatialAudioGraph || AUDIO_GRAPH_BY_VIDEO.get(this.video);
      if (!graph) return;
      this.disconnectSpatialAudioGraph(graph);
      this.connectAudioPassthrough(graph);
      this.spatialAudioStatus = "Spatial audio off.";
      this.syncOverlayControls();
      this.updateInlineStatus();
    }

    connectAudioPassthrough(graph) {
      if (!graph) return;
      safeDisconnect(graph.source);
      safeDisconnect(graph.passthroughGain);
      graph.source.connect(graph.passthroughGain);
      graph.passthroughGain.connect(graph.context.destination);
      graph.mode = "passthrough";
      this.updateSpatialAudioVolume();
    }

    updateSpatialAudioVolume() {
      const graph = this.spatialAudioGraph || AUDIO_GRAPH_BY_VIDEO.get(this.video);
      if (!graph) return;
      const gain = this.video.muted ? 0 : clampNumber(Number(this.video.volume), 0, 1, 1);
      setAudioParamValue(graph.masterGain?.gain, gain, graph.context);
      setAudioParamValue(graph.passthroughGain?.gain, gain, graph.context);
    }

    updateSpatialAudio() {
      const graph = this.spatialAudioGraph;
      if (!graph || graph.mode !== "spatial") return;
      this.updateSpatialAudioVolume();
      this.updateSpatialAudioListener(graph);
      for (const record of graph.nodes || []) {
        if (!record?.panner) continue;
        const position = this.spatialSpeakerWorldPosition(record.speaker);
        setPannerPosition(record.panner, position, graph.context);
      }
    }

    updateSpatialAudioListener(graph) {
      const listener = graph.context.listener;
      if (!listener) return;
      const camera = this.camera ? this.audioListenerCamera() : null;
      if (!camera) {
        setListenerPosition(listener, new THREE.Vector3(0, 0, 0), graph.context);
        setListenerOrientation(listener, new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), graph.context);
        return;
      }
      camera.updateMatrixWorld?.();
      const position = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
      const quaternion = new THREE.Quaternion().setFromRotationMatrix(camera.matrixWorld);
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion).normalize();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize();
      setListenerPosition(listener, position, graph.context);
      setListenerOrientation(listener, forward, up, graph.context);
    }

    audioListenerCamera() {
      if (this.renderer?.xr?.isPresenting) {
        const xrCamera = this.renderer.xr.getCamera(this.camera);
        if (xrCamera) return xrCamera;
      }
      return this.camera;
    }

    spatialAudioMediaInfo() {
      return this.mediaInfo();
    }

    mediaInfo() {
      try {
        return typeof this.options.mediaInfo === "function" ? this.options.mediaInfo() : this.options.mediaInfo;
      } catch (error) {
        return null;
      }
    }

    spatialAudioChannelCount() {
      const mediaInfo = this.spatialAudioMediaInfo() || {};
      const defaultAudio = mediaInfo.defaultAudio || {};
      const count = Number(mediaInfo.audioChannels || defaultAudio.channels || 0);
      if (Number.isFinite(count) && count > 0) return clampNumber(Math.round(count), 1, 8, 2);
      return 8;
    }

    spatialAudioChannelLabels(channelCount = this.spatialAudioChannelCount()) {
      const mediaInfo = this.spatialAudioMediaInfo() || {};
      const labels = Array.isArray(mediaInfo.audioChannelLabels) ? mediaInfo.audioChannelLabels : [];
      if (labels.length) return labels.slice(0, channelCount).map((label) => normalizeSpeakerChannel(label));
      return DEFAULT_AUDIO_CHANNEL_LABELS.slice(0, channelCount);
    }

    spatialSpeakerDefinitions(labels) {
      const theme = this.currentTheme();
      const themed = [
        ...(Array.isArray(theme.speakers) ? theme.speakers : []),
        ...(Array.isArray(theme.audio?.speakers) ? theme.audio.speakers : []),
      ].filter((speaker) => isPlainObject(speaker));
      return labels.map((label, index) => {
        const channel = normalizeSpeakerChannel(label || DEFAULT_AUDIO_CHANNEL_LABELS[index] || `CH${index + 1}`);
        const override = themed.find((speaker) => (
          normalizeSpeakerChannel(speaker.channel || speaker.id) === channel
          || Number(speaker.index) === index
        ));
        return this.resolveSpeakerDefinition(channel, index, override);
      });
    }

    resolveSpeakerDefinition(channel, index, override = null) {
      const base = defaultSpeakerDefinition(channel, index, this.settings);
      if (!override) return base;
      return {
        ...base,
        ...override,
        channel,
        themeProvided: true,
        position: Array.isArray(override.position) ? override.position : base.position,
        relativeTo: override.relativeTo || override.relative || base.relativeTo,
        gain: override.gain ?? base.gain,
      };
    }

    spatialSpeakerWorldPosition(speaker) {
      const local = speakerVectorFromDefinition(speaker);
      const relativeTo = String(speaker.relativeTo || "screen").toLowerCase();
      if (relativeTo === "room" || relativeTo === "world") return local;
      if (relativeTo === "listener" || relativeTo === "head") {
        const camera = this.camera ? this.audioListenerCamera() : null;
        if (!camera) return local;
        camera.updateMatrixWorld?.();
        const offset = local.clone().applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(camera.matrixWorld));
        return new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).add(offset);
      }
      const anchor = this.screenSurfaceGroup || this.screenGroup;
      if (!anchor) return this.spatialDefaultScreenWorldPosition(local);
      anchor.updateMatrixWorld?.();
      return anchor.localToWorld(local.clone());
    }

    spatialDefaultScreenWorldPosition(local) {
      const yaw = THREE.MathUtils.degToRad(clampNumber(Number(this.settings.panelYaw), -35, 35, DEFAULT_SETTINGS.panelYaw));
      const pitch = THREE.MathUtils.degToRad(clampNumber(Number(this.settings.panelPitch), -20, 20, DEFAULT_SETTINGS.panelPitch));
      const distance = clampNumber(Number(this.settings.distance), 1.4, 6, DEFAULT_SETTINGS.distance);
      const origin = new THREE.Vector3(
        clampNumber(Number(this.settings.panelX), -3, 3, DEFAULT_SETTINGS.panelX),
        clampNumber(Number(this.settings.panelY), -1.4, 1.4, DEFAULT_SETTINGS.panelY),
        -distance,
      );
      const rotation = new THREE.Euler(pitch, yaw, 0, "YXZ");
      return local.clone().applyEuler(rotation).add(origin);
    }

    spatialAudioStatusText(channelCount, speakers) {
      const mediaInfo = this.spatialAudioMediaInfo() || {};
      const layout = mediaInfo.audioChannelLayout || `${channelCount}ch`;
      const source = mediaInfo.spatialAudioCandidate || channelCount > 2 ? layout : `${layout}; stereo/mono source`;
      const themed = speakers.some((speaker) => speaker.themeProvided);
      const mode = this.inTheater ? "XR spatial audio" : "Headphone spatial audio";
      return `${mode} on: ${source}${themed ? "; theme speaker layout" : "; default speaker layout"}.`;
    }

    initThree() {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setClearAlpha(0);
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
      const ambient = new THREE.AmbientLight(0xffffff, 0.55);
      this.scene.add(ambient);
      this.screenGroup = new THREE.Group();
      this.scene.add(this.screenGroup);
      this.screenSurfaceGroup = new THREE.Group();
      this.screenGroup.add(this.screenSurfaceGroup);
      this.themeGroup = new THREE.Group();
      this.scene.add(this.themeGroup);
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
    }

    createVideoMaterial() {
      if (this.localDepthAdapter?.isEnabled?.() && this.videoTexture) {
        this.localDepthMaterial?.dispose?.();
        this.localDepthMaterial = this.localDepthAdapter.createThreeMaterial(this.videoTexture, { outputMode: "eye" });
        return this.localDepthMaterial;
      }
      this.localDepthMaterial = null;
      return new THREE.MeshBasicMaterial({ map: this.videoTexture, side: THREE.DoubleSide, transparent: true, opacity: 1 });
    }

    updateVideoMaterial() {
      if (!this.videoMesh || !this.videoTexture || !window.THREE) return;
      const previousMaterial = this.videoMesh.material;
      this.videoMesh.material = this.createVideoMaterial();
      if (previousMaterial && previousMaterial !== this.videoMesh.material) previousMaterial.dispose?.();
      this.updateVideoMaterialUv();
    }

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
    }

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
    }

    createVideoGeometry() {
      const curve = clampNumber(Number(this.settings.screenCurve), 0, 100, DEFAULT_SETTINGS.screenCurve) / 100;
      if (curve <= 0.001) return new THREE.PlaneGeometry(1, 1, 1, 1);
      const segments = Math.round(lerp(18, 48, curve));
      const geometry = new THREE.PlaneGeometry(1, 1, segments, 1);
      const positions = geometry.attributes.position;
      const halfAngle = THREE.MathUtils.degToRad(70 * curve) / 2;
      const sinHalfAngle = Math.max(0.001, Math.sin(halfAngle));
      const depthScale = clampNumber(Number(this.settings.panelWidth), 1.4, 6, DEFAULT_SETTINGS.panelWidth);
      for (let index = 0; index < positions.count; index += 1) {
        const u = positions.getX(index) + 0.5;
        const theta = (u - 0.5) * 2 * halfAngle;
        positions.setX(index, Math.sin(theta) / (2 * sinHalfAngle));
        positions.setZ(index, ((1 - Math.cos(theta)) / (2 * sinHalfAngle)) * depthScale);
      }
      positions.needsUpdate = true;
      geometry.computeVertexNormals();
      return geometry;
    }

    updateVideoGeometry() {
      if (!this.videoMesh) return;
      const geometryKey = `${Number(this.settings.panelWidth).toFixed(3)}:${Number(this.settings.screenCurve).toFixed(1)}`;
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
    }

    updateVideoMaterialUv() {
      this.applyVideoTextureUvForCamera(null);
    }

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
    }

    videoEyeForCamera(camera) {
      if (!camera) return this.settings.eye;
      const viewport = camera.viewport;
      if (viewport && Number(viewport.x || 0) > 0) return "right";
      if (typeof camera.name === "string" && camera.name.toLowerCase().includes("right")) return "right";
      if (typeof camera.name === "string" && camera.name.toLowerCase().includes("left")) return "left";
      if (!this.xrSession && this.theaterMode !== "lite") return this.settings.eye;
      return "left";
    }

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
      }
    }

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
    }

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
    }

    sidePanelHitForController(controller) {
      this.xrControllerRayMatrix.identity().extractRotation(controller.matrixWorld);
      this.xrRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      this.xrRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.xrControllerRayMatrix);
      return this.xrRaycaster.intersectObject(this.xrSidePanelMesh, false)[0] || null;
    }

    activateThemeInteractionForController(controller) {
      if (!this.xrSession || !this.xrRaycaster || !this.xrControllerRayMatrix || !this.themeInteractiveObjects.length) return false;
      this.xrControllerRayMatrix.identity().extractRotation(controller.matrixWorld);
      this.xrRaycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      this.xrRaycaster.ray.direction.set(0, 0, -1).applyMatrix4(this.xrControllerRayMatrix);
      const hit = this.xrRaycaster.intersectObjects(this.themeInteractiveObjects.filter((object) => object.visible), true)[0];
      if (!hit?.object?.userData?.themeInteractive) return false;
      return this.activateThemeObjectInteraction(hit.object);
    }

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
    }

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
      } else if (hotspot.action === "dom-click" && hotspot.element) {
        hotspot.element.click();
      }
    }

    pulseController(controller) {
      const actuator = controller.userData.inputSource?.gamepad?.hapticActuators?.[0];
      if (actuator?.pulse) {
        actuator.pulse(0.35, 35).catch(() => {});
      }
    }

    pulseControllerSeek(controller) {
      const actuator = controller.userData.inputSource?.gamepad?.hapticActuators?.[0];
      if (actuator?.pulse) {
        actuator.pulse(0.22, 28).catch(() => {});
      }
    }

    startScreenGrab(controller) {
      if (!this.screenGroup || !this.xrSession) return;
      this.activeGrab = {
        controller,
        controllerStart: new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld),
        screenStart: this.screenGroup.position.clone(),
      };
      this.updateInlineStatus("Grip held: move the controller to place the screen.");
    }

    endScreenGrab(controller) {
      if (!this.activeGrab || this.activeGrab.controller !== controller) return;
      this.activeGrab = null;
      this.settings.panelX = clampNumber(this.screenGroup.position.x, -3, 3, DEFAULT_SETTINGS.panelX);
      this.settings.panelY = clampNumber(this.screenGroup.position.y, -1.4, 1.4, DEFAULT_SETTINGS.panelY);
      this.settings.distance = clampNumber(Math.abs(this.screenGroup.position.z), 1.4, 6, DEFAULT_SETTINGS.distance);
      this.saveSettings();
      this.syncOverlayControls();
    }

    updateControllerDrag() {
      if (!this.activeGrab || !this.screenGroup) return;
      const current = new THREE.Vector3().setFromMatrixPosition(this.activeGrab.controller.matrixWorld);
      const delta = current.sub(this.activeGrab.controllerStart);
      const next = this.activeGrab.screenStart.clone().add(delta);
      next.x = clampNumber(next.x, -3, 3, DEFAULT_SETTINGS.panelX);
      next.y = clampNumber(next.y, -1.4, 1.4, DEFAULT_SETTINGS.panelY);
      next.z = -clampNumber(Math.abs(next.z), 1.4, 6, DEFAULT_SETTINGS.distance);
      this.screenGroup.position.copy(next);
    }

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
    }

    thumbstickHorizontalAxis(controller) {
      const axes = controller?.userData?.inputSource?.gamepad?.axes;
      if (!axes?.length) return 0;
      let best = 0;
      for (const index of [2, 0]) {
        const value = Number(axes[index] || 0);
        if (Math.abs(value) > Math.abs(best)) best = value;
      }
      return best;
    }

    seekVideoBy(seconds) {
      const duration = Number(this.video.duration || 0);
      if (!duration || !Number.isFinite(duration)) return;
      const currentTime = Number(this.video.currentTime || 0);
      this.video.currentTime = clampNumber(currentTime + seconds, 0, duration, currentTime);
      this.updatePlaybackControls();
      this.updateXrSidePanelTexture(true);
    }

    initBacklight() {
      this.backlightGroup = new THREE.Group();
      this.backlightGroup.position.set(0, 0, -0.16);
      (this.screenSurfaceGroup || this.screenGroup).add(this.backlightGroup);
      this.backlightTexture = createBacklightGlowTexture();
      const segments = Object.entries(BACKLIGHT_SEGMENT_COUNTS).flatMap(([side, count]) => (
        Array.from({ length: count }, (_value, index) => ({
          side,
          index,
          count,
          opacityScale: isBacklightCornerSide(side) ? 0.72 : 1,
        }))
      ));
      this.backlightSegments = segments.map((segment) => {
        const material = createBacklightStaticMaterial(this.backlightTexture);
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 3, 3), material);
        mesh.renderOrder = BACKLIGHT_RENDER_ORDER;
        mesh.userData.backlightSegment = segment;
        mesh.userData.staticMaterial = material;
        mesh.userData.videoMaterial = null;
        mesh.onBeforeRender = (_renderer, _scene, camera) => this.updateBacklightSegmentRenderState(mesh, camera);
        this.backlightGroup.add(mesh);
        return mesh;
      });
      this.backlightMaskMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          color: 0x000000,
          colorWrite: false,
          depthWrite: true,
          depthTest: true,
          side: THREE.DoubleSide,
        }),
      );
      this.backlightMaskMesh.renderOrder = BACKLIGHT_MASK_RENDER_ORDER;
      this.backlightMaskMesh.position.set(0, 0, 0.02);
      this.backlightGroup.add(this.backlightMaskMesh);
      this.backlightSampleCanvas = document.createElement("canvas");
      this.backlightSampleCanvas.width = 96;
      this.backlightSampleCanvas.height = 54;
      this.backlightSampleContext = this.backlightSampleCanvas.getContext("2d", { willReadFrequently: true });
      this.backlightCaptureCanvas = document.createElement("canvas");
      this.backlightCaptureCanvas.width = 96;
      this.backlightCaptureCanvas.height = 54;
      this.backlightCaptureContext = this.backlightCaptureCanvas.getContext("2d", { willReadFrequently: true });
      this.backlightRenderTarget = new THREE.WebGLRenderTarget(96, 54, {
        depthBuffer: false,
        stencilBuffer: false,
      });
      this.backlightRenderTarget.texture.colorSpace = THREE.SRGBColorSpace;
      this.backlightReadPixels = new Uint8Array(96 * 54 * 4);
      this.backlightReadData = new Uint8Array(96 * 54 * 4);
      this.backlightSampleScene = new THREE.Scene();
      this.backlightSampleCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
      this.backlightSampleCamera.position.set(0, 0, 1);
      this.backlightSampleCamera.lookAt(0, 0, 0);
      this.backlightSampleMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({ map: this.videoTexture, side: THREE.DoubleSide }),
      );
      this.backlightSampleScene.add(this.backlightSampleMesh);
      this.updateBacklightGeometry();
      this.updateBacklight(true);
    }

    disposeBacklight() {
      if (this.backlightGroup) {
        for (const segment of this.backlightSegments || []) {
          segment.geometry?.dispose?.();
          segment.userData?.staticMaterial?.dispose?.();
          if (segment.userData?.videoMaterial && segment.userData.videoMaterial !== segment.userData.staticMaterial) {
            segment.userData.videoMaterial.dispose?.();
          }
          if (segment.material && segment.material !== segment.userData?.staticMaterial && segment.material !== segment.userData?.videoMaterial) {
            segment.material.dispose?.();
          }
          segment.parent?.remove?.(segment);
        }
        if (this.backlightMaskMesh) {
          this.backlightMaskMesh.geometry?.dispose?.();
          this.backlightMaskMesh.material?.dispose?.();
          this.backlightMaskMesh.parent?.remove?.(this.backlightMaskMesh);
        }
        this.backlightGroup.parent?.remove?.(this.backlightGroup);
      }
      this.backlightTexture?.dispose?.();
      this.backlightRenderTarget?.dispose?.();
      this.backlightSampleMesh?.geometry?.dispose?.();
      this.backlightSampleMesh?.material?.dispose?.();
      this.backlightCaptureStream?.getTracks?.().forEach((track) => track.stop());
      this.backlightGroup = null;
      this.backlightMesh = null;
      this.backlightMaskMesh = null;
      this.backlightSegments = [];
      this.backlightTexture = null;
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
    }

    updateBacklightGeometry() {
      if (!this.backlightGroup) return;
      const width = this.settings.panelWidth;
      const height = this.settings.panelHeight;
      const edgeInset = 0.12;
      const rearOffset = edgeInset * 0.45;
      if (this.backlightMaskMesh) {
        this.backlightMaskMesh.scale.set(width * 1.01, height * 1.01, 1);
      }
      for (const segmentMesh of this.backlightSegments) {
        const segment = segmentMesh.userData.backlightSegment || {};
        if (isBacklightCornerSide(segment.side)) {
          const horizontal = segment.side.includes("left") ? -1 : 1;
          const vertical = segment.side.includes("top") ? 1 : -1;
          const amount = (segment.index + 0.5) / Math.max(1, segment.count);
          const xInset = edgeInset * lerp(0.55, 1.45, amount);
          const yInset = edgeInset * lerp(1.45, 0.55, amount);
          segmentMesh.position.set(
            horizontal * (width / 2 + rearOffset - xInset * 0.35),
            vertical * (height / 2 + rearOffset - yInset * 0.35),
            0,
          );
          segmentMesh.scale.set(3.25, 2.85, 1);
        } else if (segment.side === "top" || segment.side === "bottom") {
          const segmentWidth = (width / segment.count) * 3.65;
          const x = -width / 2 + (segment.index + 0.5) * (width / segment.count);
          const y = segment.side === "top" ? height / 2 + rearOffset : -height / 2 - rearOffset;
          segmentMesh.position.set(x, y, 0);
          segmentMesh.scale.set(segmentWidth, 2.64, 1);
        } else {
          const segmentHeight = (height / segment.count) * 3.35;
          const x = segment.side === "left" ? -width / 2 - rearOffset : width / 2 + rearOffset;
          const y = -height / 2 + (segment.index + 0.5) * (height / segment.count);
          segmentMesh.position.set(x, y, 0);
          segmentMesh.scale.set(2.75, segmentHeight, 1);
        }
      }
    }

    updateBacklight(force = false) {
      if (!this.backlightGroup) return;
      const mode = this.settings.backlightMode;
      this.backlightGroup.visible = mode !== "off";
      if (mode === "off") return;
      const intensity = clampNumber(Number(this.settings.backlightIntensity), 0, 150, DEFAULT_SETTINGS.backlightIntensity) / 100;
      if (mode === "soft") {
        for (const segmentMesh of this.backlightSegments) {
          this.setBacklightSegmentStatic(segmentMesh, colorToRgb("#3b82f6"), 0.16 * intensity);
        }
        return;
      }
      if (mode === "video") {
        const ready = this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
        const videoIntensity = intensity + 2;
        if (this.videoTexture) this.videoTexture.needsUpdate = true;
        for (const segmentMesh of this.backlightSegments) {
          this.setBacklightSegmentVideo(segmentMesh, ready ? 0.32 * videoIntensity : 0);
        }
        this.setBacklightSampleStatus(ready ? "shader: live video texture" : "shader: waiting for frame");
        return;
      }
      const colors = mode === "video" ? this.sampleVideoEdgeColors() : fallbackBacklightColors();
      this.updateBacklightDebugLabel();
      for (const segmentMesh of this.backlightSegments) {
        const segment = segmentMesh.userData.backlightSegment || {};
        const color = colors[segment.side]?.[segment.index] || (
          mode === "video" ? offBacklightColor() : fallbackBacklightColor(segment)
        );
        this.setBacklightSegmentStatic(
          segmentMesh,
          color,
          clampNumber((color.opacity ?? 0.3) * 0.72 * intensity, 0, 0.52, 0.26),
        );
      }
    }

    setBacklightSegmentStatic(segmentMesh, color, opacity) {
      const material = segmentMesh?.material;
      if (!material) return;
      const staticMaterial = this.useBacklightStaticMaterial(segmentMesh);
      staticMaterial.color.setRGB(color.r, color.g, color.b);
      staticMaterial.opacity = opacity * backlightOpacityScale(segmentMesh.userData.backlightSegment || {});
    }

    setBacklightSegmentVideo(segmentMesh, opacity) {
      const material = this.useBacklightVideoMaterial(segmentMesh);
      if (!material?.uniforms) {
        this.setBacklightSegmentStatic(segmentMesh, fallbackBacklightColor(segmentMesh?.userData?.backlightSegment || {}), opacity * 0.45);
        return;
      }
      const region = this.videoSampleRegionForSegment(segmentMesh.userData.backlightSegment || {});
      material.uniforms.opacity.value = opacity * backlightOpacityScale(segmentMesh.userData.backlightSegment || {});
      material.uniforms.videoMap.value = this.videoTexture;
      material.uniforms.sampleRegion.value.set(region.x0, region.y0, region.x1, region.y1);
    }

    updateBacklightSegmentRenderState(segmentMesh, camera) {
      const material = segmentMesh?.material;
      if (!material?.uniforms?.sampleRegion) return;
      const region = this.videoSampleRegionForSegment(segmentMesh.userData.backlightSegment || {}, camera);
      material.uniforms.sampleRegion.value.set(region.x0, region.y0, region.x1, region.y1);
    }

    useBacklightStaticMaterial(segmentMesh) {
      let material = segmentMesh.userData.staticMaterial;
      if (!material) {
        material = createBacklightStaticMaterial(this.backlightTexture);
        segmentMesh.userData.staticMaterial = material;
      }
      if (segmentMesh.material !== material) segmentMesh.material = material;
      return material;
    }

    useBacklightVideoMaterial(segmentMesh) {
      let material = segmentMesh.userData.videoMaterial;
      if (!material) {
        material = createBacklightSegmentMaterial(this.backlightTexture, this.videoTexture);
        segmentMesh.userData.videoMaterial = material;
      }
      if (segmentMesh.material !== material) segmentMesh.material = material;
      return material;
    }

    videoSampleRegionForSegment(segment, camera = null) {
      const window = this.displayedVideoSampleWindow(camera);
      const start = Number(segment.index || 0) / Math.max(1, Number(segment.count || 1));
      const end = (Number(segment.index || 0) + 1) / Math.max(1, Number(segment.count || 1));
      const edgeDepth = 0.34;
      if (isBacklightCornerSide(segment.side)) {
        return cornerVideoSampleRegion(window, segment, edgeDepth);
      }
      if (segment.side === "top") {
        return {
          x0: lerp(window.x0, window.x1, start),
          x1: lerp(window.x0, window.x1, end),
          y0: window.y0,
          y1: lerp(window.y0, window.y1, edgeDepth),
        };
      }
      if (segment.side === "bottom") {
        return {
          x0: lerp(window.x0, window.x1, start),
          x1: lerp(window.x0, window.x1, end),
          y0: lerp(window.y0, window.y1, 1 - edgeDepth),
          y1: window.y1,
        };
      }
      const yStart = 1 - end;
      const yEnd = 1 - start;
      if (segment.side === "left") {
        return {
          x0: window.x0,
          x1: lerp(window.x0, window.x1, edgeDepth),
          y0: lerp(window.y0, window.y1, yStart),
          y1: lerp(window.y0, window.y1, yEnd),
        };
      }
      return {
        x0: lerp(window.x0, window.x1, 1 - edgeDepth),
        x1: window.x1,
        y0: lerp(window.y0, window.y1, yStart),
        y1: lerp(window.y0, window.y1, yEnd),
      };
    }

    sampleVideoEdgeColors() {
      if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        this.setBacklightSampleStatus(this.lastVideoBacklightColors ? "last: waiting for frame" : "off: waiting for frame");
        return this.lastVideoBacklightColors || offBacklightColors();
      }
      try {
        const sample = this.readBacklightVideoSample();
        if (!sample) {
          this.setBacklightSampleStatus(this.lastVideoBacklightColors ? "last: no readable sample" : "off: no readable sample");
          return this.lastVideoBacklightColors || offBacklightColors();
        }
        const { data, width, height } = sample;
        const window = this.displayedVideoSampleWindow();
        const output = emptyBacklightColorMap();
        const edgeDepth = 0.32;
        for (const segmentMesh of this.backlightSegments) {
          const segment = segmentMesh.userData.backlightSegment || {};
          const start = segment.index / segment.count;
          const end = (segment.index + 1) / segment.count;
          let color = null;
          if (isBacklightCornerSide(segment.side)) {
            color = averageSampleRegion(data, width, height, cornerVideoSampleRegion(window, segment, edgeDepth));
            output[segment.side][segment.index] = isVisibleBacklightColor(color)
              ? color
              : sampleExpandedSegmentRegion(data, width, height, window, segment);
          } else if (segment.side === "top") {
            color = averageSampleRegion(data, width, height, {
              x0: lerp(window.x0, window.x1, start),
              x1: lerp(window.x0, window.x1, end),
              y0: window.y0,
              y1: lerp(window.y0, window.y1, edgeDepth),
            });
            output.top[segment.index] = isVisibleBacklightColor(color)
              ? color
              : sampleExpandedSegmentRegion(data, width, height, window, segment);
          } else if (segment.side === "bottom") {
            color = averageSampleRegion(data, width, height, {
              x0: lerp(window.x0, window.x1, start),
              x1: lerp(window.x0, window.x1, end),
              y0: lerp(window.y0, window.y1, 1 - edgeDepth),
              y1: window.y1,
            });
            output.bottom[segment.index] = isVisibleBacklightColor(color)
              ? color
              : sampleExpandedSegmentRegion(data, width, height, window, segment);
          } else if (segment.side === "left") {
            const yStart = 1 - end;
            const yEnd = 1 - start;
            color = averageSampleRegion(data, width, height, {
              x0: window.x0,
              x1: lerp(window.x0, window.x1, edgeDepth),
              y0: lerp(window.y0, window.y1, yStart),
              y1: lerp(window.y0, window.y1, yEnd),
            });
            output.left[segment.index] = isVisibleBacklightColor(color)
              ? color
              : sampleExpandedSegmentRegion(data, width, height, window, segment);
          } else if (segment.side === "right") {
            const yStart = 1 - end;
            const yEnd = 1 - start;
            color = averageSampleRegion(data, width, height, {
              x0: lerp(window.x0, window.x1, 1 - edgeDepth),
              x1: window.x1,
              y0: lerp(window.y0, window.y1, yStart),
              y1: lerp(window.y0, window.y1, yEnd),
            });
            output.right[segment.index] = isVisibleBacklightColor(color)
              ? color
              : sampleExpandedSegmentRegion(data, width, height, window, segment);
          }
        }
        if (hasVisibleBacklightColors(output)) {
          this.lastVideoBacklightColors = output;
          this.setBacklightSampleStatus(`${sample.source}: ${sample.debug || "visible"}`);
          return output;
        }
        const broadOutput = sampleExpandedBacklightColors(data, width, height, window, this.backlightSegments);
        if (hasVisibleBacklightColors(broadOutput)) {
          this.lastVideoBacklightColors = broadOutput;
          this.setBacklightSampleStatus(`${sample.source}: broad ${sample.debug || "visible"}`);
          return broadOutput;
        }
        const offColors = offBacklightColors();
        this.lastVideoBacklightColors = offColors;
        this.setBacklightSampleStatus(`${sample.source}: blank`);
        return offColors;
      } catch (error) {
        this.setBacklightSampleStatus(this.lastVideoBacklightColors ? "last: sample error" : "off: sample error");
        return this.lastVideoBacklightColors || offBacklightColors();
      }
    }

    readBacklightVideoSample() {
      let canvasSample = null;
      try {
        canvasSample = this.readBacklightCanvasSample();
      } catch (error) {
        canvasSample = null;
      }
      if (canvasSample) canvasSample.debug = samplePixelDebug(canvasSample.data);
      if (canvasSample && hasVisibleSamplePixels(canvasSample.data)) return canvasSample;
      let webglSample = null;
      try {
        webglSample = this.readBacklightWebglSample();
      } catch (error) {
        webglSample = null;
      }
      if (webglSample) webglSample.debug = samplePixelDebug(webglSample.data);
      if (webglSample && hasVisibleSamplePixels(webglSample.data)) return webglSample;
      if (this.backlightCaptureSample && hasVisibleSamplePixels(this.backlightCaptureSample.data)) return this.backlightCaptureSample;
      this.requestBacklightCaptureSample();
      return canvasSample || webglSample || this.backlightCaptureSample;
    }

    readBacklightCanvasSample() {
      if (!this.backlightSampleContext || !this.backlightSampleCanvas) return null;
      const context = this.backlightSampleContext;
      const width = this.backlightSampleCanvas.width;
      const height = this.backlightSampleCanvas.height;
      context.drawImage(this.video, 0, 0, width, height);
      return {
        data: context.getImageData(0, 0, width, height).data,
        source: "canvas",
        width,
        height,
      };
    }

    readBacklightWebglSample() {
      if (!this.renderer || !this.videoTexture || !this.backlightRenderTarget || !this.backlightSampleScene || !this.backlightSampleCamera) {
        return null;
      }
      const width = this.backlightRenderTarget.width;
      const height = this.backlightRenderTarget.height;
      const previousTarget = this.renderer.getRenderTarget();
      const previousViewport = this.renderer.getViewport(new THREE.Vector4());
      const previousScissor = this.renderer.getScissor(new THREE.Vector4());
      const previousScissorTest = this.renderer.getScissorTest();
      const previousXrEnabled = this.renderer.xr.enabled;
      const previousOffsetX = this.videoTexture.offset.x;
      const previousOffsetY = this.videoTexture.offset.y;
      const previousRepeatX = this.videoTexture.repeat.x;
      const previousRepeatY = this.videoTexture.repeat.y;
      try {
        this.renderer.xr.enabled = false;
        this.videoTexture.offset.set(0, 0);
        this.videoTexture.repeat.set(1, 1);
        this.videoTexture.needsUpdate = true;
        this.renderer.setRenderTarget(this.backlightRenderTarget);
        this.renderer.clear();
        this.renderer.render(this.backlightSampleScene, this.backlightSampleCamera);
        this.renderer.readRenderTargetPixels(this.backlightRenderTarget, 0, 0, width, height, this.backlightReadPixels);
        flipRgbaRows(this.backlightReadPixels, this.backlightReadData, width, height);
        return {
          data: this.backlightReadData,
          source: "webgl",
          width,
          height,
        };
      } finally {
        this.videoTexture.offset.set(previousOffsetX, previousOffsetY);
        this.videoTexture.repeat.set(previousRepeatX, previousRepeatY);
        this.videoTexture.needsUpdate = true;
        this.renderer.setRenderTarget(previousTarget);
        this.renderer.setViewport(previousViewport);
        this.renderer.setScissor(previousScissor);
        this.renderer.setScissorTest(previousScissorTest);
        this.renderer.xr.enabled = previousXrEnabled;
      }
    }

    requestBacklightCaptureSample() {
      if (this.backlightCapturePending || !this.backlightCaptureContext) return;
      const captureStream = this.video.captureStream || this.video.mozCaptureStream;
      const canGrabFrame = typeof window.ImageCapture === "function" && typeof captureStream === "function";
      const canCreateBitmap = typeof window.createImageBitmap === "function";
      if (!canCreateBitmap && !canGrabFrame) return;
      this.backlightCapturePending = true;
      Promise.resolve().then(async () => {
        let bitmap = null;
        let source = "";
        if (canCreateBitmap) {
          try {
            bitmap = await window.createImageBitmap(this.video);
            source = "bitmap";
          } catch (error) {
            bitmap = null;
          }
        }
        if (!bitmap && canGrabFrame) {
          if (!this.backlightCaptureStream) {
            this.backlightCaptureStream = captureStream.call(this.video);
            const [track] = this.backlightCaptureStream?.getVideoTracks?.() || [];
            if (!track) throw new Error("Video capture track unavailable.");
            this.backlightImageCapture = new ImageCapture(track);
          }
          bitmap = await this.backlightImageCapture.grabFrame();
          source = "capture";
        }
        if (!bitmap) throw new Error("Video frame capture unavailable.");
        const width = this.backlightCaptureCanvas.width;
        const height = this.backlightCaptureCanvas.height;
        this.backlightCaptureContext.drawImage(bitmap, 0, 0, width, height);
        bitmap.close?.();
        const data = this.backlightCaptureContext.getImageData(0, 0, width, height).data;
        this.backlightCaptureSample = {
          data,
          debug: samplePixelDebug(data),
          source,
          width,
          height,
        };
      }).catch(() => {
        if (this.backlightCaptureStream) {
          this.backlightCaptureStream.getTracks?.().forEach((track) => track.stop());
          this.backlightCaptureStream = null;
          this.backlightImageCapture = null;
        }
      }).finally(() => {
        this.backlightCapturePending = false;
      });
    }

    setBacklightSampleStatus(status) {
      this.backlightSampleStatus = status;
      this.updateBacklightDebugLabel();
    }

    updateBacklightDebugLabel() {
      if (!this.backlightDebug) return;
      this.backlightDebug.hidden = this.settings.backlightMode !== "video";
      if (!this.backlightDebug.hidden) {
        this.backlightDebug.textContent = `Sample ${this.backlightSampleStatus || "idle"}`;
      }
    }

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
    }

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
    }

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
    }

    displayedVideoSampleWindow(camera = null) {
      if (this.settings.layout === "half-sbs" || this.settings.layout === "full-sbs") {
        return this.videoEyeForCamera(camera) === "right"
          ? { x0: 0.5, x1: 1, y0: 0, y1: 1 }
          : { x0: 0, x1: 0.5, y0: 0, y1: 1 };
      }
      return { x0: 0, x1: 1, y0: 0, y1: 1 };
    }

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
    }

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
        this.updateBacklight();
        this.updateThemeVideoSampling();
        this.updateSpatialAudio();
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
    }

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
    }

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
    }

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
        const sessionMode = this.settings.headsetMode === "mr" && this.xrArSupported ? "immersive-ar" : "immersive-vr";
        session = await this.requestImmersiveSession(sessionMode);
        this.xrSession = session;
        this.xrSessionMode = sessionMode;
        this.xrSessionEndHandler = () => {
          this.xrSession = null;
          this.xrSessionMode = "";
          this.xrSessionEndHandler = null;
          this.activeGrab = null;
          this.desktopKeys.clear();
          this.updateDesktopCamera();
          this.updateSceneLighting();
          this.syncOverlayControls();
        };
        session.addEventListener("end", this.xrSessionEndHandler, { once: true });
        await this.renderer.xr.setSession(session);
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
    }

    async requestImmersiveSession(sessionMode) {
      if (!navigator.xr) throw new Error("WebXR is unavailable in this browser.");
      const optionalFeatures = sessionMode === "immersive-ar"
        ? ["local-floor", "bounded-floor", "dom-overlay", "hit-test"]
        : ["local-floor", "bounded-floor", "dom-overlay"];
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
    }

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
    }

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
    }

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
      context.fillText("Aim + trigger selects. Trigger off-controls toggles this panel. Grip moves screen.", 56, 136);

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
    }

    backlightModeLabel() {
      if (this.settings.backlightMode === "video") return "Video";
      if (this.settings.backlightMode === "dynamic") return "Dynamic";
      if (this.settings.backlightMode === "soft") return "Soft";
      return "Off";
    }

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
    }

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

    moveSidePanelIntoOverlay() {
      const panel = document.querySelector(this.options.panelSelector);
      if (!panel || !this.sideSlot || this.sidePanel) return;
      this.sidePanel = panel;
      this.sidePanelPlaceholder = document.createComment("file-pipe-xr-side-panel");
      panel.parentNode.insertBefore(this.sidePanelPlaceholder, panel);
      this.sideSlot.appendChild(panel);
      panel.classList.add("fp-three-xr-moved-panel");
      this.syncSidePanelVisibility();
    }

    restoreSidePanel() {
      if (!this.sidePanel || !this.sidePanelPlaceholder) return;
      if (this.sideSlot) this.sideSlot.hidden = false;
      this.sidePanel.classList.remove("fp-three-xr-moved-panel");
      this.sidePanelPlaceholder.parentNode.insertBefore(this.sidePanel, this.sidePanelPlaceholder);
      this.sidePanelPlaceholder.remove();
      this.sidePanel = null;
      this.sidePanelPlaceholder = null;
    }

    async togglePlayback() {
      if (this.video.paused) {
        await this.video.play().catch((error) => this.updateInlineStatus(error.message || "Playback was blocked."));
      } else {
        this.video.pause();
      }
      this.updatePlaybackControls();
    }

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

    dispose() {
      if (this.localDepthAdapter?.dispose) this.localDepthAdapter.dispose();
      this.localDepthAdapter = null;
      this.closeTheater();
      this.cleanups.forEach((cleanup) => cleanup());
      this.cleanups = [];
      if (this.panel) this.panel.remove();
      INSTANCE_BY_VIDEO.delete(this.video);
    }
  }

  function isKnownLayout(value) {
    return ["mono", "half-sbs", "full-sbs"].includes(value);
  }

  function isKnownBacklightMode(value) {
    return ["off", "soft", "dynamic", "video"].includes(value);
  }

  function isLocalDepthProcessor(value) {
    const processor = String(value || "").trim().toLowerCase();
    if (!processor) return false;
    if (window.FilePipeLocalDepth3dAdapter?.isLocalProcessor) {
      return window.FilePipeLocalDepth3dAdapter.isLocalProcessor(processor);
    }
    return [
      "midas-small-onnx",
      "fastdepth-mobilenet-onnx",
      "depth-anything-v2-tiny-onnx",
      "depth-anything-v2-small-onnx",
      "webgpu-depth-anything-v2-small",
    ].includes(processor);
  }

  function normalizeLocalDepthSettings(settings = {}) {
    return {
      depthStrength: clampNumber(Number(settings.depthStrength), 0, 2, 0.72),
      temporalSmoothing: clampNumber(Number(settings.temporalSmoothing), 0, 0.92, 0.55),
      inferenceIntervalMs: clampNumber(Number(settings.inferenceIntervalMs), 80, 1000, 180),
      inputSize: clampNumber(Number(settings.inputSize), 128, 512, 256),
    };
  }

  function normalizeSpeakerChannel(value) {
    const channel = String(value || "").trim().toUpperCase().replace(/[\s_-]+/g, "");
    const aliases = {
      LEFT: "L",
      RIGHT: "R",
      CENTER: "C",
      CENTRE: "C",
      SUB: "LFE",
      SUBWOOFER: "LFE",
      LOWFREQUENCY: "LFE",
      LS: "SL",
      RS: "SR",
      LEFTSURROUND: "SL",
      RIGHTSURROUND: "SR",
      SURROUNDLEFT: "SL",
      SURROUNDRIGHT: "SR",
      LEFTSIDE: "SL",
      RIGHTSIDE: "SR",
      LEFTBACK: "BL",
      RIGHTBACK: "BR",
      BACKLEFT: "BL",
      BACKRIGHT: "BR",
      BACKCENTER: "BC",
      CENTERSURROUND: "BC",
    };
    return aliases[channel] || channel || "";
  }

  function defaultSpeakerDefinition(channel, index, settings) {
    const panelWidth = clampNumber(Number(settings.panelWidth), 1.4, 6, DEFAULT_SETTINGS.panelWidth);
    const distance = clampNumber(Number(settings.distance), 1.4, 6, DEFAULT_SETTINGS.distance);
    const sideX = Math.max(1.15, panelWidth * 0.48);
    const rearX = Math.max(1.45, panelWidth * 0.58);
    const rearZ = distance + 0.7;
    const backZ = distance + 1.45;
    const definitions = {
      L: { position: [-sideX, 0.02, 0.08] },
      R: { position: [sideX, 0.02, 0.08] },
      C: { position: [0, 0.02, 0.04] },
      LFE: { position: [0, -0.85, 0.55], lfe: true, gain: 0.8 },
      SL: { position: [-rearX, 0.02, rearZ] },
      SR: { position: [rearX, 0.02, rearZ] },
      BL: { position: [-rearX, 0.02, backZ] },
      BR: { position: [rearX, 0.02, backZ] },
      BC: { position: [0, 0.02, backZ] },
      FLC: { position: [-sideX * 0.55, 0.18, 0.02] },
      FRC: { position: [sideX * 0.55, 0.18, 0.02] },
    };
    const fallbackAngle = index === 0 ? -30 : index === 1 ? 30 : 0;
    return {
      channel,
      relativeTo: "screen",
      gain: 1,
      refDistance: 1.2,
      rolloffFactor: 0.6,
      ...(definitions[channel] || {
        relativeTo: "listener",
        angle: fallbackAngle,
        distance: 2.2,
        height: 0,
      }),
    };
  }

  function speakerVectorFromDefinition(speaker) {
    if (Array.isArray(speaker.position)) {
      return new THREE.Vector3(
        Number(speaker.position[0] || 0),
        Number(speaker.position[1] || 0),
        Number(speaker.position[2] || 0),
      );
    }
    const angle = Number(speaker.angle ?? speaker.azimuth);
    const radius = clampNumber(Number(speaker.distance ?? speaker.radius), 0.1, 20, 2.2);
    const height = clampNumber(Number(speaker.height ?? speaker.y), -5, 5, 0);
    if (Number.isFinite(angle)) {
      const radians = THREE.MathUtils.degToRad(angle);
      return new THREE.Vector3(Math.sin(radians) * radius, height, -Math.cos(radians) * radius);
    }
    return new THREE.Vector3(0, height, -radius);
  }

  function safeDisconnect(node) {
    try {
      node?.disconnect?.();
    } catch (error) {
      // Already disconnected.
    }
  }

  function setAudioParamValue(param, value, context) {
    if (!param) return;
    const now = context?.currentTime || 0;
    const when = now + 0.015;
    if (typeof param.linearRampToValueAtTime === "function") {
      param.cancelScheduledValues?.(now);
      param.linearRampToValueAtTime(value, when);
    } else {
      param.value = value;
    }
  }

  function setPannerPosition(panner, position, context) {
    setAudioParamValue(panner.positionX, position.x, context);
    setAudioParamValue(panner.positionY, position.y, context);
    setAudioParamValue(panner.positionZ, position.z, context);
    if (!panner.positionX && typeof panner.setPosition === "function") {
      panner.setPosition(position.x, position.y, position.z);
    }
  }

  function setListenerPosition(listener, position, context) {
    setAudioParamValue(listener.positionX, position.x, context);
    setAudioParamValue(listener.positionY, position.y, context);
    setAudioParamValue(listener.positionZ, position.z, context);
    if (!listener.positionX && typeof listener.setPosition === "function") {
      listener.setPosition(position.x, position.y, position.z);
    }
  }

  function setListenerOrientation(listener, forward, up, context) {
    setAudioParamValue(listener.forwardX, forward.x, context);
    setAudioParamValue(listener.forwardY, forward.y, context);
    setAudioParamValue(listener.forwardZ, forward.z, context);
    setAudioParamValue(listener.upX, up.x, context);
    setAudioParamValue(listener.upY, up.y, context);
    setAudioParamValue(listener.upZ, up.z, context);
    if (!listener.forwardX && typeof listener.setOrientation === "function") {
      listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function isPlainObject(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function mediaInfoVideoAspectRatio(mediaInfo) {
    const streams = Array.isArray(mediaInfo?.videoStreams) ? mediaInfo.videoStreams : [];
    const candidates = [mediaInfo?.defaultVideo, ...streams];
    for (const candidate of candidates) {
      const width = Number(candidate?.width || 0);
      const height = Number(candidate?.height || 0);
      if (width > 0 && height > 0) return Math.max(0.1, width / height);
    }
    return 0;
  }

  function coerceThemeSettingValue(value, definition = null) {
    const type = String(definition?.type || "number").toLowerCase();
    if (type === "boolean") return Boolean(value);
    if (type === "select" || type === "enum") return String(value);
    const min = Number(definition?.min ?? -100000);
    const max = Number(definition?.max ?? 100000);
    return clampNumber(Number(value), min, max, Number(definition?.default ?? 0));
  }

  function formatThemeSettingValue(value, definition = null) {
    const type = String(definition?.type || "number").toLowerCase();
    if (type === "boolean") return Boolean(value) ? "On" : "Off";
    if (type === "select" || type === "enum") return String(value);
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    const suffix = definition?.suffix ? String(definition.suffix) : "";
    return `${Number.isInteger(number) ? number : number.toFixed(2).replace(/\.?0+$/, "")}${suffix}`;
  }

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function setObjectOpacity(object, opacity) {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      material.opacity = opacity;
      material.transparent = opacity < 1 || material.blending === THREE.AdditiveBlending;
    }
  }

  function normalizeDegrees(value) {
    if (!Number.isFinite(value)) return 0;
    return ((value + 180) % 360 + 360) % 360 - 180;
  }

  function isEditableTarget(target) {
    if (!(target instanceof Element)) return false;
    const tagName = target.tagName.toLowerCase();
    return target.isContentEditable || ["input", "select", "textarea", "button"].includes(tagName);
  }

  function normalizedNavigationKey(event) {
    const key = String(event.key || "").toLowerCase();
    const navigationKeys = ["arrowup", "arrowdown", "arrowleft", "arrowright", "w", "a", "s", "d", "q", "e", "shift"];
    return navigationKeys.includes(key) ? key : "";
  }

  function isBacklightCornerSide(side) {
    return ["top-left", "top-right", "bottom-left", "bottom-right"].includes(side);
  }

  function backlightOpacityScale(segment) {
    return Number(segment?.opacityScale ?? 1);
  }

  function emptyBacklightColorMap() {
    return Object.fromEntries(Object.keys(BACKLIGHT_SEGMENT_COUNTS).map((side) => [side, []]));
  }

  function cornerVideoSampleRegion(window, segment, edgeDepth) {
    const amount = (Number(segment.index || 0) + 0.5) / Math.max(1, Number(segment.count || 1));
    const broad = edgeDepth * lerp(1.24, 0.72, amount);
    const narrow = edgeDepth * lerp(0.72, 1.24, amount);
    const left = segment.side.includes("left");
    const top = segment.side.includes("top");
    const width = window.x1 - window.x0;
    const height = window.y1 - window.y0;
    const xSize = width * (top ? broad : narrow);
    const ySize = height * (top ? narrow : broad);
    return {
      x0: left ? window.x0 : window.x1 - xSize,
      x1: left ? window.x0 + xSize : window.x1,
      y0: top ? window.y0 : window.y1 - ySize,
      y1: top ? window.y0 + ySize : window.y1,
    };
  }

  function lerp(start, end, amount) {
    return start + (end - start) * amount;
  }

  function createBacklightGlowTexture() {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    const gradient = context.createRadialGradient(160, 160, 0, 160, 160, 160);
    gradient.addColorStop(0, "rgba(255, 255, 255, 0.46)");
    gradient.addColorStop(0.14, "rgba(255, 255, 255, 0.32)");
    gradient.addColorStop(0.38, "rgba(255, 255, 255, 0.16)");
    gradient.addColorStop(0.66, "rgba(255, 255, 255, 0.055)");
    gradient.addColorStop(0.88, "rgba(255, 255, 255, 0.014)");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  function createBacklightStaticMaterial(glowTexture) {
    return new THREE.MeshBasicMaterial({
      color: 0x3b82f6,
      map: glowTexture,
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }

  function createBacklightSegmentMaterial(glowTexture, videoTexture) {
    return new THREE.ShaderMaterial({
      uniforms: {
        glowMap: { value: glowTexture },
        videoMap: { value: videoTexture },
        opacity: { value: 0.24 },
        sampleRegion: { value: new THREE.Vector4(0, 0, 1, 1) },
      },
      vertexShader: `
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D glowMap;
        uniform sampler2D videoMap;
        uniform float opacity;
        uniform vec4 sampleRegion;
        varying vec2 vUv;

        vec3 videoAt(vec2 point) {
          vec2 topOriginUv = mix(sampleRegion.xy, sampleRegion.zw, point);
          return texture2D(videoMap, vec2(topOriginUv.x, 1.0 - topOriginUv.y)).rgb;
        }

        void main() {
          vec4 glow = texture2D(glowMap, vUv);
          vec3 videoColor = (
            videoAt(vec2(0.18, 0.18)) +
            videoAt(vec2(0.50, 0.18)) +
            videoAt(vec2(0.82, 0.18)) +
            videoAt(vec2(0.24, 0.50)) +
            videoAt(vec2(0.50, 0.50)) +
            videoAt(vec2(0.76, 0.50)) +
            videoAt(vec2(0.18, 0.82)) +
            videoAt(vec2(0.50, 0.82)) +
            videoAt(vec2(0.82, 0.82))
          ) / 9.0;
          float glowStrength = glow.a;
          float videoMax = max(max(videoColor.r, videoColor.g), videoColor.b);
          float videoLuminance = dot(videoColor, vec3(0.2126, 0.7152, 0.0722));
          float videoAlpha = smoothstep(0.018, 0.09, max(videoMax, videoLuminance));
          float boost = mix(1.25, 1.0, smoothstep(0.18, 0.62, videoMax));
          vec3 color = clamp(videoColor * boost, vec3(0.0), vec3(1.0));
          float alpha = glowStrength * opacity * videoAlpha;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
  }

  function flipRgbaRows(source, target, width, height) {
    const rowBytes = width * 4;
    for (let y = 0; y < height; y += 1) {
      const sourceStart = (height - 1 - y) * rowBytes;
      const targetStart = y * rowBytes;
      target.set(source.subarray(sourceStart, sourceStart + rowBytes), targetStart);
    }
    return target;
  }

  function hasVisibleSamplePixels(data) {
    if (!data?.length) return false;
    let visible = 0;
    for (let index = 0; index < data.length; index += 16) {
      const pixelR = data[index];
      const pixelG = data[index + 1];
      const pixelB = data[index + 2];
      const pixelMax = Math.max(pixelR, pixelG, pixelB) / 255;
      const pixelLuminance = (0.2126 * pixelR + 0.7152 * pixelG + 0.0722 * pixelB) / 255;
      if (pixelLuminance > 0.018 || pixelMax > 0.045) {
        visible += 1;
        if (visible >= 6) return true;
      }
    }
    return false;
  }

  function samplePixelDebug(data) {
    if (!data?.length) return "empty";
    let max = 0;
    let luminance = 0;
    let samples = 0;
    for (let index = 0; index < data.length; index += 16) {
      const pixelR = data[index];
      const pixelG = data[index + 1];
      const pixelB = data[index + 2];
      max = Math.max(max, pixelR, pixelG, pixelB);
      luminance += 0.2126 * pixelR + 0.7152 * pixelG + 0.0722 * pixelB;
      samples += 1;
    }
    const avg = samples ? Math.round(luminance / samples) : 0;
    return `avg ${avg} max ${Math.round(max)}`;
  }

  function objectMaterials(object) {
    const materials = [];
    object?.traverse?.((child) => {
      if (Array.isArray(child.material)) {
        materials.push(...child.material.filter(Boolean));
      } else if (child.material) {
        materials.push(child.material);
      }
    });
    if (!materials.length && object?.material) {
      if (Array.isArray(object.material)) materials.push(...object.material.filter(Boolean));
      else materials.push(object.material);
    }
    return materials;
  }

  function themeVideoSampleColor(colors, region = "average") {
    const key = String(region || "average").toLowerCase();
    if (key === "average" || key === "center" || key === "all") return averageBacklightColorMap(colors);
    if (key.includes("-")) {
      const sideColors = colors?.[key];
      if (Array.isArray(sideColors)) return averageVisibleColors(sideColors);
    }
    if (["top", "bottom", "left", "right"].includes(key)) {
      return averageVisibleColors(colors?.[key] || []);
    }
    if (key === "vertical") return averageVisibleColors([...(colors?.left || []), ...(colors?.right || [])]);
    if (key === "horizontal") return averageVisibleColors([...(colors?.top || []), ...(colors?.bottom || [])]);
    return averageBacklightColorMap(colors);
  }

  function averageBacklightColorMap(colors) {
    return averageVisibleColors(Object.values(colors || {}).flatMap((sideColors) => Array.isArray(sideColors) ? sideColors : []));
  }

  function averageVisibleColors(colors) {
    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    let opacity = 0;
    for (const color of colors || []) {
      if (!isVisibleBacklightColor(color)) continue;
      const colorWeight = Math.max(0.01, Number(color.opacity || 0));
      r += Number(color.r || 0) * colorWeight;
      g += Number(color.g || 0) * colorWeight;
      b += Number(color.b || 0) * colorWeight;
      opacity += Number(color.opacity || 0);
      weight += colorWeight;
    }
    if (!weight) return offBacklightColor();
    return {
      r: clampNumber(r / weight, 0, 1, 0),
      g: clampNumber(g / weight, 0, 1, 0),
      b: clampNumber(b / weight, 0, 1, 0),
      opacity: clampNumber(opacity / Math.max(1, colors.length), 0, 1, 0),
    };
  }

  function averageSampleRegion(data, width, height, region) {
    const x0 = Math.max(0, Math.min(width - 1, Math.floor(region.x0 * width)));
    const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(region.x1 * width)));
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(region.y0 * height)));
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(region.y1 * height)));
    let r = 0;
    let g = 0;
    let b = 0;
    let weightedR = 0;
    let weightedG = 0;
    let weightedB = 0;
    let activeWeight = 0;
    let activePixels = 0;
    let pixels = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const index = (y * width + x) * 4;
        const pixelR = data[index];
        const pixelG = data[index + 1];
        const pixelB = data[index + 2];
        r += pixelR;
        g += pixelG;
        b += pixelB;
        const pixelMax = Math.max(pixelR, pixelG, pixelB) / 255;
        const pixelLuminance = (0.2126 * pixelR + 0.7152 * pixelG + 0.0722 * pixelB) / 255;
        if (pixelLuminance > 0.025 || pixelMax > 0.055) {
          const weight = 0.35 + Math.min(1.6, pixelLuminance * 5 + pixelMax * 1.4);
          weightedR += pixelR * weight;
          weightedG += pixelG * weight;
          weightedB += pixelB * weight;
          activeWeight += weight;
          activePixels += 1;
        }
        pixels += 1;
      }
    }
    if (!pixels) return { r: 0.23, g: 0.51, b: 0.96, opacity: 0.42 };
    const maxChannel = Math.max(r, g, b) / pixels / 255;
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / pixels / 255;
    const activeRatio = activePixels / pixels;
    if (luminance < 0.012 && maxChannel < 0.028 && activeRatio < 0.004) {
      return { r: 0, g: 0, b: 0, opacity: 0 };
    }
    const sampleR = activeWeight ? weightedR / activeWeight : r / pixels;
    const sampleG = activeWeight ? weightedG / activeWeight : g / pixels;
    const sampleB = activeWeight ? weightedB / activeWeight : b / pixels;
    const sampleMax = Math.max(sampleR, sampleG, sampleB) / 255;
    const boost = sampleMax < 0.24 ? 1.45 : 1.12;
    const opacityFloor = activePixels ? 0.16 : 0.08;
    const opacity = opacityFloor + Math.sqrt(Math.max(luminance, sampleMax * Math.max(activeRatio, 0.02))) * 0.36 + Math.sqrt(activeRatio) * 0.12;
    return {
      r: clampNumber(sampleR / 255 * boost, 0.02, 1, 0.2),
      g: clampNumber(sampleG / 255 * boost, 0.02, 1, 0.45),
      b: clampNumber(sampleB / 255 * boost, 0.02, 1, 0.95),
      opacity: clampNumber(opacity, 0.08, 0.5, 0.26),
    };
  }

  function sampleExpandedSegmentRegion(data, width, height, window, segment) {
    if (isBacklightCornerSide(segment.side)) {
      return averageSampleRegion(data, width, height, cornerVideoSampleRegion(window, segment, 0.58));
    }
    const start = segment.index / segment.count;
    const end = (segment.index + 1) / segment.count;
    if (segment.side === "top" || segment.side === "bottom") {
      return averageSampleRegion(data, width, height, {
        x0: lerp(window.x0, window.x1, start),
        x1: lerp(window.x0, window.x1, end),
        y0: window.y0,
        y1: window.y1,
      });
    }
    const yStart = 1 - end;
    const yEnd = 1 - start;
    return averageSampleRegion(data, width, height, {
      x0: window.x0,
      x1: window.x1,
      y0: lerp(window.y0, window.y1, yStart),
      y1: lerp(window.y0, window.y1, yEnd),
    });
  }

  function isVisibleBacklightColor(color) {
    return Number(color?.opacity || 0) > 0.01;
  }

  function hasVisibleBacklightColors(colors) {
    return Object.values(colors || {}).some((sideColors) => (
      Array.isArray(sideColors)
      && sideColors.some((color) => isVisibleBacklightColor(color))
    ));
  }

  function sampleExpandedBacklightColors(data, width, height, window, segments) {
    const output = emptyBacklightColorMap();
    for (const item of segments || []) {
      const segment = item?.userData?.backlightSegment || item;
      if (!output[segment.side]) continue;
      output[segment.side][segment.index] = sampleExpandedSegmentRegion(data, width, height, window, segment);
    }
    return output;
  }

  function fallbackBacklightColors(color = null, opacity = null) {
    const output = emptyBacklightColorMap();
    for (const side of Object.keys(output)) {
      const count = BACKLIGHT_SEGMENT_COUNTS[side] || 1;
      for (let index = 0; index < count; index += 1) {
        output[side][index] = color
          ? { ...colorToRgb(color), opacity: opacity ?? 0.34 }
          : fallbackBacklightColor({ side, index, count });
      }
    }
    return output;
  }

  function offBacklightColors() {
    const output = emptyBacklightColorMap();
    for (const side of Object.keys(output)) {
      const count = BACKLIGHT_SEGMENT_COUNTS[side] || 1;
      for (let index = 0; index < count; index += 1) {
        output[side][index] = offBacklightColor();
      }
    }
    return output;
  }

  function offBacklightColor() {
    return { r: 0, g: 0, b: 0, opacity: 0 };
  }

  function colorToRgb(value) {
    const color = colorFromTheme(value, new THREE.Color("#3b82f6"));
    return { r: color.r, g: color.g, b: color.b };
  }

  function fallbackBacklightColor(segment) {
    const position = segment.count ? segment.index / Math.max(1, segment.count - 1) : 0;
    const palette = [
      { r: 0.05, g: 0.35, b: 1, opacity: 0.3 },
      { r: 0.1, g: 0.9, b: 0.95, opacity: 0.31 },
      { r: 0.9, g: 0.12, b: 1, opacity: 0.36 },
      { r: 1, g: 0.86, b: 0.22, opacity: 0.32 },
    ];
    const offset = segment.side === "bottom" ? 0.16 : segment.side === "right" ? 0.32 : segment.side === "left" ? -0.12 : 0;
    const scaled = ((position + offset) % 1 + 1) % 1 * (palette.length - 1);
    const index = Math.floor(scaled);
    const next = Math.min(palette.length - 1, index + 1);
    const amount = scaled - index;
    return {
      r: lerp(palette[index].r, palette[next].r, amount),
      g: lerp(palette[index].g, palette[next].g, amount),
      b: lerp(palette[index].b, palette[next].b, amount),
      opacity: lerp(palette[index].opacity, palette[next].opacity, amount),
    };
  }

  function lockedPanelSize(axis, value, aspect, current) {
    const minWidth = 1.4;
    const maxWidth = 6;
    const minHeight = 0.8;
    const maxHeight = 3.6;
    let width = clampNumber(Number(current.panelWidth), minWidth, maxWidth, DEFAULT_SETTINGS.panelWidth);
    let height = clampNumber(Number(current.panelHeight), minHeight, maxHeight, DEFAULT_SETTINGS.panelHeight);
    const ratio = clampNumber(Number(aspect), 0.1, 10, 16 / 9);
    if (axis === "height") {
      height = clampNumber(Number(value), minHeight, maxHeight, height);
      width = height * ratio;
      if (width > maxWidth) {
        width = maxWidth;
        height = width / ratio;
      }
      if (width < minWidth) {
        width = minWidth;
        height = width / ratio;
      }
    } else {
      width = clampNumber(Number(value), minWidth, maxWidth, width);
      height = width / ratio;
      if (height > maxHeight) {
        height = maxHeight;
        width = height * ratio;
      }
      if (height < minHeight) {
        height = minHeight;
        width = height * ratio;
      }
    }
    return {
      width: clampNumber(width, minWidth, maxWidth, DEFAULT_SETTINGS.panelWidth),
      height: clampNumber(height, minHeight, maxHeight, DEFAULT_SETTINGS.panelHeight),
    };
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const remaining = total % 60;
    return `${minutes}:${String(remaining).padStart(2, "0")}`;
  }

  function cleanPanelText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function wrapCanvasText(context, text, maxWidth) {
    const words = cleanPanelText(text).split(" ");
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  function roundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function drawXrPanelButton(context, rect, label) {
    context.fillStyle = "rgba(20, 33, 55, 0.94)";
    roundRect(context, rect.x, rect.y, rect.width, rect.height, 14);
    context.fill();
    context.strokeStyle = "rgba(147, 197, 253, 0.52)";
    context.lineWidth = 3;
    context.stroke();
    context.fillStyle = "#f8fafc";
    context.font = "800 25px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, rect.x + rect.width / 2, rect.y + rect.height / 2);
    context.textAlign = "start";
    context.textBaseline = "alphabetic";
  }

  function colorFromTheme(value, fallback) {
    try {
      return new THREE.Color(String(value || "") || fallback);
    } catch (error) {
      return fallback instanceof THREE.Color ? fallback : new THREE.Color(fallback || "#000000");
    }
  }

  function shouldRestoreDesktopRoomView(stored) {
    const viewKeys = ["roomViewX", "roomViewY", "roomViewZ", "roomViewYaw", "roomViewPitch"];
    if (!viewKeys.some((key) => Object.prototype.hasOwnProperty.call(stored, key))) return false;
    const allZero = viewKeys.every((key) => Math.abs(Number(stored[key] || 0)) < 0.001);
    const flatFloorView = Math.abs(Number(stored.roomViewY || 0)) < 0.05
      && Math.abs(Number(stored.roomViewPitch || 0)) < 1;
    return allZero || flatFloorView;
  }

  function parseObjGeometry(text) {
    const vertices = [];
    const positions = [];
    const lines = text.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(/\s+/);
      if (parts[0] === "v" && parts.length >= 4) {
        vertices.push([
          Number(parts[1] || 0),
          Number(parts[2] || 0),
          Number(parts[3] || 0),
        ]);
      }
      if (parts[0] === "f" && parts.length >= 4) {
        const indexes = parts.slice(1).map((part) => Number(part.split("/")[0]) - 1).filter((index) => index >= 0);
        for (let i = 1; i < indexes.length - 1; i += 1) {
          for (const index of [indexes[0], indexes[i], indexes[i + 1]]) {
            const vertex = vertices[index];
            if (vertex) positions.push(vertex[0], vertex[1], vertex[2]);
          }
        }
      }
    }
    if (!positions.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  window.FilePipeXrPlayer = {
    attach(video, options = {}) {
      if (!video) return null;
      const existing = INSTANCE_BY_VIDEO.get(video);
      if (existing) return existing.updateOptions(options);
      const instance = new FilePipeThreeXrPlayer(video, options);
      INSTANCE_BY_VIDEO.set(video, instance);
      return instance;
    },
  };
})();
