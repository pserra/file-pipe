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
    },

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
    },

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
    },

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
    },

    describeLocalDepthStatus() {
      if (!this.localDepthProcessor) return "";
      if (!isLocalDepthProcessor(this.localDepthProcessor)) return "";
      const target = LAYOUT_LABELS[this.localDepthTargetLayout] || "3D";
      if (!window.FilePipeLocalDepth3dAdapter?.attach) return ` Local depth is selected for ${target}; no local depth adapter is loaded.`;
      if (this.localDepthAdapter?.status) return ` ${this.localDepthAdapter.status}`;
      return ` Local browser depth adapter is active for ${target}.`;
    },

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
    },

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
          viewportWarp: clampNumber(Number(stored.viewportWarp), 0, 100, DEFAULT_SETTINGS.viewportWarp),
          distance: clampNumber(Number(stored.distance), 1.4, 6, DEFAULT_SETTINGS.distance),
          roomViewX: clampNumber(Number(stored.roomViewX), THEATER_SETTING_LIMITS.roomViewX[0], THEATER_SETTING_LIMITS.roomViewX[1], DEFAULT_SETTINGS.roomViewX),
          roomViewY: clampNumber(Number(stored.roomViewY), THEATER_SETTING_LIMITS.roomViewY[0], THEATER_SETTING_LIMITS.roomViewY[1], DEFAULT_SETTINGS.roomViewY),
          roomViewZ: clampNumber(Number(stored.roomViewZ), THEATER_SETTING_LIMITS.roomViewZ[0], THEATER_SETTING_LIMITS.roomViewZ[1], DEFAULT_SETTINGS.roomViewZ),
          roomViewYaw: normalizeDegrees(clampNumber(Number(stored.roomViewYaw), -180, 180, DEFAULT_SETTINGS.roomViewYaw)),
          roomViewPitch: clampNumber(Number(stored.roomViewPitch), -35, 35, DEFAULT_SETTINGS.roomViewPitch),
          roomViewPresetVersion: clampNumber(Number(stored.roomViewPresetVersion), 0, 100, 0),
          seating: typeof stored.seating === "string" && stored.seating ? stored.seating : DEFAULT_SETTINGS.seating,
          freeRoam: Boolean(stored.freeRoam),
          roomDim: clampNumber(Number(stored.roomDim), 0, 100, DEFAULT_SETTINGS.roomDim),
          sidePanelVisible: Boolean(stored.sidePanelVisible ?? DEFAULT_SETTINGS.sidePanelVisible),
          aspectLocked: stored.aspectLocked !== false,
          backlightMode: isKnownBacklightMode(stored.backlightMode) ? stored.backlightMode : DEFAULT_SETTINGS.backlightMode,
          backlightIntensity: clampNumber(Number(stored.backlightIntensity), 0, 150, DEFAULT_SETTINGS.backlightIntensity),
          spatialAudio: Boolean(stored.spatialAudio ?? DEFAULT_SETTINGS.spatialAudio),
          avatarEnabled: Boolean(stored.avatarEnabled ?? DEFAULT_SETTINGS.avatarEnabled),
          avatarViewpoint: Boolean(stored.avatarViewpoint ?? DEFAULT_SETTINGS.avatarViewpoint),
          avatarMirror: Boolean(stored.avatarMirror ?? DEFAULT_SETTINGS.avatarMirror),
          avatarPinned: Boolean(stored.avatarPinned ?? DEFAULT_SETTINGS.avatarPinned),
          theme: typeof stored.theme === "string" && stored.theme ? stored.theme : DEFAULT_SETTINGS.theme,
          themeValues: isPlainObject(stored.themeValues) ? stored.themeValues : {},
          themeValueRevisions: isPlainObject(stored.themeValueRevisions) ? stored.themeValueRevisions : {},
          themeDefaultRevisions: isPlainObject(stored.themeDefaultRevisions) ? stored.themeDefaultRevisions : {},
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
    },

    saveSettings() {
      try {
        localStorage.setItem(this.options.storageKey, JSON.stringify(this.settings));
      } catch (error) {
        // Storage may be disabled.
      }
    },

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
          <label class="fp-xr-check">
            <input class="form-check-input" type="checkbox" data-role="avatar-enabled">
            <span>Avatar body</span>
          </label>
          <label class="fp-xr-check">
            <input class="form-check-input" type="checkbox" data-role="avatar-viewpoint">
            <span>View as avatar</span>
          </label>
          <label class="fp-xr-check">
            <input class="form-check-input" type="checkbox" data-role="avatar-mirror">
            <span>Mirror preview</span>
          </label>
          <label class="fp-xr-check">
            <input class="form-check-input" type="checkbox" data-role="avatar-pinned">
            <span>Pin body</span>
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
      this.avatarEnabledInput = this.panel.querySelector("[data-role='avatar-enabled']");
      this.avatarViewpointInput = this.panel.querySelector("[data-role='avatar-viewpoint']");
      this.avatarMirrorInput = this.panel.querySelector("[data-role='avatar-mirror']");
      this.avatarPinnedInput = this.panel.querySelector("[data-role='avatar-pinned']");
      this.eyeField = this.panel.querySelector("[data-role='eye-field']");
      this.vrButton = this.panel.querySelector("[data-action='enter-vr']");
      this.liteButton = this.panel.querySelector("[data-action='enter-lite']");
      this.vrLabel = this.panel.querySelector("[data-role='vr-label']");
      this.statusElement = this.panel.querySelector("[data-role='status']");
      this.layoutSelect.value = this.settings.layout;
      this.eyeSelect.value = this.settings.eye;
      this.headsetModeSelect.value = this.settings.headsetMode;
      this.spatialAudioInput.checked = Boolean(this.settings.spatialAudio);
      this.avatarEnabledInput.checked = Boolean(this.settings.avatarEnabled);
      this.avatarViewpointInput.checked = Boolean(this.settings.avatarViewpoint);
      this.avatarMirrorInput.checked = Boolean(this.settings.avatarMirror);
      this.avatarPinnedInput.checked = Boolean(this.settings.avatarPinned);
      this.avatarViewpointInput.disabled = !this.settings.avatarEnabled;
      this.avatarMirrorInput.disabled = !this.settings.avatarEnabled;
      this.avatarPinnedInput.disabled = !this.settings.avatarEnabled;
      this.eyeField.hidden = this.settings.layout === "mono";
    },

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
      this.listen(this.avatarEnabledInput, "change", () => {
        this.setAvatarEnabled(this.avatarEnabledInput.checked);
      });
      this.listen(this.avatarViewpointInput, "change", () => {
        this.setAvatarViewpoint(this.avatarViewpointInput.checked);
      });
      this.listen(this.avatarMirrorInput, "change", () => {
        this.setAvatarMirrorEnabled(this.avatarMirrorInput.checked);
      });
      this.listen(this.avatarPinnedInput, "change", () => {
        this.setAvatarPinned(this.avatarPinnedInput.checked);
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
    },

    listen(target, eventName, handler) {
      if (!target) return;
      target.addEventListener(eventName, handler);
      this.cleanups.push(() => target.removeEventListener(eventName, handler));
    },

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
    },

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
    },

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
      const seatingChanged = this.ensureValidSeatingSelection();
      const themeValuesChanged = this.migrateThemeValueDefaults();
      const themeDefaultsChanged = this.migrateThemeDefaults();
      const seatPositionChanged = this.applyCurrentThemeSeatIfAnchored();
      if (seatingChanged || themeValuesChanged || themeDefaultsChanged || seatPositionChanged) this.saveSettings();
      this.syncOverlayControls();
      if (themeDefaultsChanged) this.updateVideoGeometry();
      if (this.scene) this.applyTheme();
      if (this.settings.spatialAudio && this.spatialAudioGraph?.mode === "spatial") {
        this.rebuildSpatialAudioGraph();
      }
    },

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
    },

    syncSeatingOptions() {
      if (!this.seatingSelect) return;
      const existing = this.seatingSelect.value || this.settings.seating || "manual";
      const seats = this.themeSeatingPositions();
      this.seatingSelect.innerHTML = "";
      const manual = document.createElement("option");
      manual.value = "manual";
      manual.textContent = "Manual";
      this.seatingSelect.appendChild(manual);
      for (const seat of seats) {
        const option = document.createElement("option");
        option.value = seat.id;
        option.textContent = seat.label;
        this.seatingSelect.appendChild(option);
      }
      if (existing !== "manual" && seats.some((seat) => seat.id === existing)) {
        this.seatingSelect.value = existing;
      } else if (this.settings.seating !== "manual" && seats.some((seat) => seat.id === this.settings.seating)) {
        this.seatingSelect.value = this.settings.seating;
      } else {
        this.seatingSelect.value = "manual";
      }
    },

    currentTheme() {
      return this.themes.find((theme) => theme.id === this.settings.theme) || {
        id: "default",
        name: "Default room",
        background: "#01040a",
        floor: { color: "#162033", grid: true },
        seating: [],
        settings: [],
        lights: [],
        assets: [],
      };
    },

    themeSeatingPositions(theme = this.currentTheme()) {
      const seating = Array.isArray(theme.seating)
        ? theme.seating
        : Array.isArray(theme.seating?.positions) ? theme.seating.positions : [];
      return seating
        .map((seat, index) => normalizeSeatingPosition(seat, index))
        .filter(Boolean);
    },

    currentSeat() {
      if (!this.settings.seating || this.settings.seating === "manual") return null;
      return this.themeSeatingPositions().find((seat) => seat.id === this.settings.seating) || null;
    },

    ensureValidSeatingSelection() {
      if (!this.settings.seating || this.settings.seating === "manual") {
        this.settings.seating = "manual";
        return false;
      }
      if (this.currentSeat()) return false;
      this.settings.seating = "manual";
      return true;
    },

    applySeatingPosition(seat, options = {}) {
      const normalized = normalizeSeatingPosition(seat, 0);
      if (!normalized) return false;
      this.settings.roomViewX = normalized.x;
      this.settings.roomViewY = normalized.y;
      this.settings.roomViewZ = normalized.z;
      this.settings.roomViewYaw = normalized.yaw;
      this.settings.roomViewPitch = normalized.pitch;
      if (options.select !== false) this.settings.seating = normalized.id;
      this.avatarPinnedAnchor = null;
      this.desktopKeys.clear();
      if (options.save !== false) this.saveSettings();
      this.updateDesktopCamera();
      this.updateWorldOffset();
      if (options.sync !== false) this.syncOverlayControls();
      this.updateXrSidePanelTexture(true);
      return true;
    },

    selectSeating(id, options = {}) {
      const nextId = id && id !== "manual" ? String(id) : "manual";
      if (nextId === "manual") {
        this.settings.seating = "manual";
        this.avatarPinnedAnchor = null;
        if (options.save !== false) this.saveSettings();
        if (options.sync !== false) this.syncOverlayControls();
        this.updateXrSidePanelTexture(true);
        return true;
      }
      const seat = this.themeSeatingPositions().find((candidate) => candidate.id === nextId);
      if (!seat) return false;
      return this.applySeatingPosition(seat, { ...options, select: true });
    },

    cycleSeatingPosition() {
      const seats = this.themeSeatingPositions();
      if (!seats.length) return false;
      const currentIndex = seats.findIndex((seat) => seat.id === this.settings.seating);
      const next = seats[(currentIndex + 1 + seats.length) % seats.length];
      const changed = this.applySeatingPosition(next, { save: true, sync: true, select: true });
      if (changed) this.updateInlineStatus(`Seat: ${next.label}`);
      return changed;
    },

    applyCurrentThemeSeatIfAnchored() {
      if (this.settings.freeRoam) return false;
      const seat = this.currentSeat();
      if (!seat) return false;
      const changed = Math.abs(Number(this.settings.roomViewX) - seat.x) > 0.001
        || Math.abs(Number(this.settings.roomViewY) - seat.y) > 0.001
        || Math.abs(Number(this.settings.roomViewZ) - seat.z) > 0.001
        || Math.abs(normalizeDegrees(Number(this.settings.roomViewYaw) - seat.yaw)) > 0.001
        || Math.abs(Number(this.settings.roomViewPitch) - seat.pitch) > 0.001;
      if (!changed) return false;
      this.applySeatingPosition(seat, { save: false, sync: false, select: true });
      return true;
    },

    themeSettingDefinitions(theme = this.currentTheme()) {
      return Array.isArray(theme.settings)
        ? theme.settings.filter((setting) => isPlainObject(setting) && setting.id)
        : [];
    },

    themeValueStore(themeId = this.currentTheme().id) {
      if (!isPlainObject(this.settings.themeValues)) this.settings.themeValues = {};
      if (!isPlainObject(this.settings.themeValues[themeId])) this.settings.themeValues[themeId] = {};
      return this.settings.themeValues[themeId];
    },

    migrateThemeValueDefaults(theme = this.currentTheme()) {
      if (!isPlainObject(theme) || !theme.id) return false;
      const revision = Math.max(0, Math.floor(Number(theme.settingsRevision || 0)));
      if (!revision || !isPlainObject(theme.settingsRevisionDefaults)) return false;
      if (!isPlainObject(this.settings.themeValueRevisions)) this.settings.themeValueRevisions = {};
      const currentRevision = Math.max(0, Math.floor(Number(this.settings.themeValueRevisions[theme.id] || 0)));
      if (currentRevision >= revision) return false;
      const store = this.themeValueStore(theme.id);
      let changed = false;
      for (const [id, value] of Object.entries(theme.settingsRevisionDefaults)) {
        const next = coerceThemeSettingValue(value, this.themeSettingDefinition(id, theme));
        if (store[id] !== next) {
          store[id] = next;
          changed = true;
        }
      }
      this.settings.themeValueRevisions[theme.id] = revision;
      return changed;
    },

    coerceTheaterSettingDefault(key, value) {
      if (!Object.prototype.hasOwnProperty.call(THEATER_SETTING_LIMITS, key)) return undefined;
      const limits = THEATER_SETTING_LIMITS[key];
      const fallback = Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key) ? DEFAULT_SETTINGS[key] : limits[0];
      const next = clampNumber(Number(value), limits[0], limits[1], fallback);
      return key === "roomViewYaw" ? normalizeDegrees(next) : next;
    },

    themeDefaultSettings(theme = this.currentTheme()) {
      if (!isPlainObject(theme)) return {};
      const settings = {};
      const addDefaults = (defaults) => {
        if (!isPlainObject(defaults)) return;
        for (const [key, value] of Object.entries(defaults)) {
          const next = this.coerceTheaterSettingDefault(key, value);
          if (next !== undefined) settings[key] = next;
        }
      };
      addDefaults(theme.defaults);
      addDefaults(theme.screenMount?.defaults);
      return settings;
    },

    themeScreenMountDefaults(theme = this.currentTheme()) {
      if (!isPlainObject(theme?.screenMount?.defaults)) return {};
      const settings = {};
      for (const [key, value] of Object.entries(theme.screenMount.defaults)) {
        const next = this.coerceTheaterSettingDefault(key, value);
        if (next !== undefined) settings[key] = next;
      }
      return settings;
    },

    applyThemeScreenMount(options = {}) {
      const mount = this.themeScreenMountDefaults();
      const placementKeys = ["panelX", "panelY", "panelYaw", "panelPitch"];
      const resetKeys = ["panelWidth", "panelHeight", "screenCurve", "viewportWarp", "distance"];
      let hasMount = false;
      let changed = false;
      for (const key of placementKeys) {
        if (!Object.prototype.hasOwnProperty.call(mount, key)) continue;
        hasMount = true;
        if (Math.abs(Number(this.settings[key]) - mount[key]) > 0.001) {
          this.settings[key] = mount[key];
          changed = true;
        }
      }
      if (options.resetDistance) {
        for (const key of resetKeys) {
          if (!Object.prototype.hasOwnProperty.call(mount, key)) continue;
          hasMount = true;
          if (Math.abs(Number(this.settings[key]) - mount[key]) > 0.001) {
            this.settings[key] = mount[key];
            changed = true;
          }
        }
      }
      return hasMount ? changed : null;
    },

    migrateThemeDefaults(theme = this.currentTheme()) {
      if (!isPlainObject(theme) || !theme.id) return false;
      const revision = Math.max(0, Math.floor(Number(theme.defaultsRevision || 0)));
      if (!revision) return false;
      if (!isPlainObject(this.settings.themeDefaultRevisions)) this.settings.themeDefaultRevisions = {};
      const currentRevision = Math.max(0, Math.floor(Number(this.settings.themeDefaultRevisions[theme.id] || 0)));
      if (currentRevision >= revision) return false;
      for (const [key, value] of Object.entries(this.themeDefaultSettings(theme))) {
        this.settings[key] = value;
      }
      this.settings.themeDefaultRevisions[theme.id] = revision;
      return true;
    },

    themeSettingDefinition(id, theme = this.currentTheme()) {
      return this.themeSettingDefinitions(theme).find((setting) => setting.id === id) || null;
    },

    themeSettingValue(id, fallback = null, theme = this.currentTheme()) {
      const definition = this.themeSettingDefinition(id, theme);
      const store = this.themeValueStore(theme.id);
      if (Object.prototype.hasOwnProperty.call(store, id)) return store[id];
      if (definition && Object.prototype.hasOwnProperty.call(definition, "default")) return definition.default;
      return fallback;
    },

    setThemeSettingValue(id, value, options = {}) {
      const theme = this.currentTheme();
      const definition = this.themeSettingDefinition(id, theme);
      const store = this.themeValueStore(theme.id);
      store[id] = coerceThemeSettingValue(value, definition);
      this.saveSettings();
      this.syncThemeSettingsControls();
      if (options.rebuild !== false) this.applyTheme();
    },

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
    },

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
    },

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
  });
})();
