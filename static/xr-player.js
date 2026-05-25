(() => {
  const INSTANCE_BY_VIDEO = new WeakMap();
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
    distance: 3,
    roomViewX: 0,
    roomViewY: 0,
    roomViewZ: 0,
    roomViewYaw: 0,
    roomViewPitch: 0,
    roomDim: 80,
    sidePanelVisible: false,
    aspectLocked: true,
    backlightMode: "off",
    backlightIntensity: 100,
    theme: "default",
  };
  const LAYOUT_LABELS = {
    mono: "Full frame",
    "half-sbs": "Half SBS 3D",
    "full-sbs": "Full SBS 3D",
  };
  const BACKLIGHT_SEGMENT_COUNTS = {
    top: 20,
    bottom: 20,
    left: 8,
    right: 8,
  };

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
      this.renderer = null;
      this.scene = null;
      this.camera = null;
      this.screenGroup = null;
      this.videoMesh = null;
      this.gridMesh = null;
      this.themeGroup = null;
      this.themeObjects = [];
      this.themes = [];
      this.themeRevision = 0;
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
      this.controllers = [];
      this.controllerLines = [];
      this.activeGrab = null;
      this.desktopDrag = null;
      this.desktopKeys = new Set();
      this.overlayCleanups = [];
      this.lastRenderAt = 0;
      this.xrRaycaster = null;
      this.xrControllerRayMatrix = null;

      this.buildInlineControls();
      this.bindInlineControls();
      this.refreshXrSupport();
      this.loadThemes();
      this.updateInlineStatus();
    }

    updateOptions(options = {}) {
      this.options = { ...this.options, ...options };
      return this;
    }

    readSettings() {
      try {
        const stored = JSON.parse(localStorage.getItem(this.options.storageKey) || "{}");
        return {
          layout: isKnownLayout(stored.layout) ? stored.layout : DEFAULT_SETTINGS.layout,
          eye: stored.eye === "right" ? "right" : DEFAULT_SETTINGS.eye,
          headsetMode: stored.headsetMode === "mr" ? "mr" : DEFAULT_SETTINGS.headsetMode,
          panelWidth: clampNumber(Number(stored.panelWidth), 1.4, 6, DEFAULT_SETTINGS.panelWidth),
          panelHeight: clampNumber(Number(stored.panelHeight), 0.8, 3.6, DEFAULT_SETTINGS.panelHeight),
          panelX: clampNumber(Number(stored.panelX), -3, 3, DEFAULT_SETTINGS.panelX),
          panelY: clampNumber(Number(stored.panelY), -1.4, 1.4, DEFAULT_SETTINGS.panelY),
          panelYaw: clampNumber(Number(stored.panelYaw), -35, 35, DEFAULT_SETTINGS.panelYaw),
          panelPitch: clampNumber(Number(stored.panelPitch), -20, 20, DEFAULT_SETTINGS.panelPitch),
          distance: clampNumber(Number(stored.distance), 1.4, 6, DEFAULT_SETTINGS.distance),
          roomViewX: clampNumber(Number(stored.roomViewX), -2.8, 2.8, DEFAULT_SETTINGS.roomViewX),
          roomViewY: clampNumber(Number(stored.roomViewY), -0.8, 1.2, DEFAULT_SETTINGS.roomViewY),
          roomViewZ: clampNumber(Number(stored.roomViewZ), -3.7, 1.2, DEFAULT_SETTINGS.roomViewZ),
          roomViewYaw: normalizeDegrees(clampNumber(Number(stored.roomViewYaw), -180, 180, DEFAULT_SETTINGS.roomViewYaw)),
          roomViewPitch: clampNumber(Number(stored.roomViewPitch), -35, 35, DEFAULT_SETTINGS.roomViewPitch),
          roomDim: clampNumber(Number(stored.roomDim), 0, 100, DEFAULT_SETTINGS.roomDim),
          sidePanelVisible: Boolean(stored.sidePanelVisible ?? DEFAULT_SETTINGS.sidePanelVisible),
          aspectLocked: stored.aspectLocked !== false,
          backlightMode: isKnownBacklightMode(stored.backlightMode) ? stored.backlightMode : DEFAULT_SETTINGS.backlightMode,
          backlightIntensity: clampNumber(Number(stored.backlightIntensity), 0, 150, DEFAULT_SETTINGS.backlightIntensity),
          theme: typeof stored.theme === "string" && stored.theme ? stored.theme : DEFAULT_SETTINGS.theme,
        };
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
          <button class="btn btn-sm btn-primary" type="button" data-action="enter-vr">
            <i class="bi bi-badge-vr"></i>
            <span data-role="vr-label">Open XR Theater</span>
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
      this.eyeField = this.panel.querySelector("[data-role='eye-field']");
      this.vrButton = this.panel.querySelector("[data-action='enter-vr']");
      this.vrLabel = this.panel.querySelector("[data-role='vr-label']");
      this.statusElement = this.panel.querySelector("[data-role='status']");
      this.layoutSelect.value = this.settings.layout;
      this.eyeSelect.value = this.settings.eye;
      this.headsetModeSelect.value = this.settings.headsetMode;
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
      this.listen(this.vrButton, "click", () => this.openTheater());
      this.listen(this.video, "loadedmetadata", () => {
        if (this.settings.aspectLocked) this.applyAspectRatioFrom("width");
        this.saveSettings();
        this.syncOverlayControls();
        this.updateVideoGeometry();
      });
      this.listen(this.video, "play", () => this.updatePlaybackControls());
      this.listen(this.video, "pause", () => this.updatePlaybackControls());
      this.listen(this.video, "timeupdate", () => this.updatePlaybackControls());
      this.listen(this.video, "volumechange", () => this.updatePlaybackControls());
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
      this.statusElement.textContent = this.xrSupported
        ? `${layout}. ${headset}. Open the theater, then enter the headset from the top bar.`
        : `${layout}. Desktop theater is available; no WebXR headset is visible to this browser.`;
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
      this.syncOverlayControls();
      if (this.scene) this.applyTheme();
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
        assets: [],
      };
    }

    applyTheme() {
      if (!this.scene || !this.themeGroup || !window.THREE) return;
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
      if (this.themeGroup) this.themeGroup.clear();
    }

    addThemeAsset(asset, revision = this.themeRevision) {
      if (!asset) return;
      if (asset.type === "image") {
        if (!asset.url) return;
        const texture = new THREE.TextureLoader().load(asset.url);
        texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.MeshBasicMaterial({
          map: texture,
          transparent: Number(asset.opacity ?? 1) < 1,
          opacity: clampNumber(Number(asset.opacity ?? 1), 0, 1, 1),
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
        this.applyThemeTransform(mesh, asset);
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
            const material = new THREE.MeshBasicMaterial({
              color: colorFromTheme(asset.color || "#94a3b8", new THREE.Color("#94a3b8")),
              wireframe: Boolean(asset.wireframe),
            });
            const mesh = new THREE.Mesh(geometry, material);
            this.applyThemeTransform(mesh, asset);
            if (revision === this.themeRevision) {
              this.themeGroup.add(mesh);
              this.themeObjects.push(mesh);
            }
          })
          .catch(() => {});
      } else if (asset.type === "box") {
        const size = Array.isArray(asset.size) ? asset.size : [1, 1, 1];
        const geometry = new THREE.BoxGeometry(
          Number(size[0] ?? 1),
          Number(size[1] ?? 1),
          Number(size[2] ?? 1),
        );
        const material = new THREE.MeshBasicMaterial({
          color: colorFromTheme(asset.color || "#334155", new THREE.Color("#334155")),
          transparent: Number(asset.opacity ?? 1) < 1,
          opacity: clampNumber(Number(asset.opacity ?? 1), 0, 1, 1),
        });
        const mesh = new THREE.Mesh(geometry, material);
        this.applyThemeTransform(mesh, asset);
        if (revision === this.themeRevision) {
          this.themeGroup.add(mesh);
          this.themeObjects.push(mesh);
        }
      }
    }

    applyThemeTransform(object, asset) {
      const position = Array.isArray(asset.position) ? asset.position : [0, 0, -4];
      const scale = Array.isArray(asset.scale) ? asset.scale : [1, 1, 1];
      const rotation = Array.isArray(asset.rotation) ? asset.rotation : [0, 0, 0];
      object.position.set(Number(position[0] ?? 0), Number(position[1] ?? 0), Number(position[2] ?? -4));
      object.scale.set(Number(scale[0] ?? 1), Number(scale[1] ?? scale[0] ?? 1), Number(scale[2] ?? 1));
      object.rotation.set(
        THREE.MathUtils.degToRad(Number(rotation[0] ?? 0)),
        THREE.MathUtils.degToRad(Number(rotation[1] ?? 0)),
        THREE.MathUtils.degToRad(Number(rotation[2] ?? 0)),
      );
    }

    openTheater() {
      if (this.inTheater) return;
      if (!window.THREE) {
        this.updateInlineStatus("Three.js did not load. Reload the page and try again.");
        return;
      }
      this.inTheater = true;
      this.buildOverlay();
      this.initThree();
      this.moveSidePanelIntoOverlay();
      if (this.settings.aspectLocked) this.applyAspectRatioFrom("width");
      this.updateVideoGeometry();
      this.updateVideoMaterialUv();
      this.resizeRenderer();
      this.renderer.setAnimationLoop(() => this.renderFrame());
      this.updatePlaybackControls();
      document.body.classList.add("fp-three-xr-active");
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
      if (this.overlay) this.overlay.remove();
      this.overlay = null;
      if (this.videoTexture) this.videoTexture.dispose();
      if (this.xrSidePanelTexture) this.xrSidePanelTexture.dispose();
      if (this.xrSidePanelMesh) {
        this.xrSidePanelMesh.geometry?.dispose();
        this.xrSidePanelMesh.material?.dispose();
      }
      this.clearThemeObjects();
      if (this.backlightGroup) {
        this.disposeBacklight();
      }
      if (this.renderer) this.renderer.dispose();
      this.renderer = null;
      this.scene = null;
      this.camera = null;
      this.videoMesh = null;
      this.videoTexture = null;
      this.xrSidePanelMesh = null;
      this.xrSidePanelTexture = null;
      this.xrSidePanelCanvas = null;
      this.xrSidePanelContext = null;
      this.xrSidePanelHotspots = [];
      this.screenGroup = null;
      this.gridMesh = null;
      this.themeGroup = null;
      this.themeObjects = [];
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
      this.controllers = [];
      this.controllerLines = [];
      this.activeGrab = null;
      this.desktopDrag = null;
      this.desktopKeys.clear();
      this.overlayCleanups.forEach((cleanup) => cleanup());
      this.overlayCleanups = [];
      this.lastRenderAt = 0;
      this.xrRaycaster = null;
      this.xrControllerRayMatrix = null;
      document.body.classList.remove("fp-three-xr-active");
    }

    buildOverlay() {
      this.overlay = document.createElement("div");
      this.overlay.className = "fp-three-xr-overlay";
      this.overlay.innerHTML = `
        <div class="fp-three-xr-topbar">
          <div>
            <strong>XR Theater</strong>
            <span data-role="theater-status"></span>
          </div>
          <div class="fp-three-xr-top-actions">
            <button class="btn btn-sm btn-info" type="button" data-action="enter-webxr">
              <i class="bi bi-badge-vr"></i>
              <span data-role="webxr-label">Enter headset</span>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="recenter">
              <i class="bi bi-crosshair"></i>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="reset-room-view" title="Reset desktop room view">
              <i class="bi bi-house"></i>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="zoom-out" title="Zoom out">
              <i class="bi bi-dash-lg"></i>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="zoom-in" title="Zoom in">
              <i class="bi bi-plus-lg"></i>
            </button>
            <button class="btn btn-sm btn-light" type="button" data-action="toggle-side-panel">
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
              <label class="fp-xr-field">
                <span>Headset</span>
                <select class="form-select form-select-sm" data-role="overlay-headset-mode">
                  <option value="vr">VR room</option>
                  <option value="mr">MR passthrough</option>
                </select>
              </label>
              <label class="fp-xr-field">
                <span>Room</span>
                <select class="form-select form-select-sm" data-role="theme">
                  <option value="default">Default room</option>
                </select>
              </label>
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
              <label class="fp-xr-range"><span>X <output data-role="x-label"></output></span><input class="form-range" type="range" min="-3" max="3" step="0.05" data-role="panel-x"></label>
              <label class="fp-xr-range"><span>Height pos <output data-role="y-label"></output></span><input class="form-range" type="range" min="-1.4" max="1.4" step="0.05" data-role="panel-y"></label>
              <label class="fp-xr-range"><span>Yaw <output data-role="yaw-label"></output></span><input class="form-range" type="range" min="-35" max="35" step="1" data-role="panel-yaw"></label>
              <label class="fp-xr-range"><span>Tilt <output data-role="pitch-label"></output></span><input class="form-range" type="range" min="-20" max="20" step="1" data-role="panel-pitch"></label>
              <label class="fp-xr-range"><span>Distance <output data-role="distance-label"></output></span><input class="form-range" type="range" min="1.4" max="6" step="0.1" data-role="panel-distance"></label>
              <label class="fp-xr-range"><span>Room dim <output data-role="dim-label"></output></span><input class="form-range" type="range" min="0" max="100" step="5" data-role="room-dim"></label>
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
      this.theaterStatus = this.overlay.querySelector("[data-role='theater-status']");
      this.overlayHeadsetModeSelect = this.overlay.querySelector("[data-role='overlay-headset-mode']");
      this.themeSelect = this.overlay.querySelector("[data-role='theme']");
      this.backlightSelect = this.overlay.querySelector("[data-role='backlight']");
      this.backlightIntensityInput = this.overlay.querySelector("[data-role='backlight-intensity']");
      this.backlightDebug = this.overlay.querySelector("[data-role='backlight-debug']");
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
      this.distanceInput = this.overlay.querySelector("[data-role='panel-distance']");
      this.dimInput = this.overlay.querySelector("[data-role='room-dim']");
      this.backlightIntensityLabel = this.overlay.querySelector("[data-role='backlight-intensity-label']");
      this.widthLabel = this.overlay.querySelector("[data-role='width-label']");
      this.heightLabel = this.overlay.querySelector("[data-role='height-label']");
      this.xLabel = this.overlay.querySelector("[data-role='x-label']");
      this.yLabel = this.overlay.querySelector("[data-role='y-label']");
      this.yawLabel = this.overlay.querySelector("[data-role='yaw-label']");
      this.pitchLabel = this.overlay.querySelector("[data-role='pitch-label']");
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
      this.sidePanelToggleButton = this.overlay.querySelector("[data-action='toggle-side-panel']");
      this.sidePanelLabel = this.overlay.querySelector("[data-role='side-panel-label']");
      this.sideSlot = this.overlay.querySelector("[data-role='side-slot']");
      this.overlay.querySelector("[data-action='close']").addEventListener("click", () => this.closeTheater());
      this.overlay.querySelector("[data-action='recenter']").addEventListener("click", () => this.recenterScreen());
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
        this.updateInlineStatus();
      });
      this.themeSelect.addEventListener("change", () => {
        this.settings.theme = this.themeSelect.value || DEFAULT_SETTINGS.theme;
        this.saveSettings();
        this.syncOverlayControls();
        this.applyTheme();
      });
      this.backlightSelect.addEventListener("change", () => {
        this.settings.backlightMode = isKnownBacklightMode(this.backlightSelect.value) ? this.backlightSelect.value : "off";
        this.saveSettings();
        this.syncOverlayControls();
        this.updateBacklight(true);
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
      if (!this.overlay) return;
      this.overlayHeadsetModeSelect.value = this.settings.headsetMode;
      this.overlayHeadsetModeSelect.querySelector("option[value='mr']").disabled = !this.xrArSupported;
      this.syncThemeOptions();
      this.themeSelect.value = this.settings.theme;
      this.backlightSelect.value = this.settings.backlightMode;
      this.backlightIntensityInput.value = String(this.settings.backlightIntensity);
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
      this.distanceInput.value = String(this.settings.distance);
      this.dimInput.value = String(this.settings.roomDim);
      this.widthLabel.textContent = `${this.settings.panelWidth.toFixed(1)}m`;
      this.heightLabel.textContent = `${this.settings.panelHeight.toFixed(1)}m`;
      this.xLabel.textContent = `${this.settings.panelX.toFixed(2)}m`;
      this.yLabel.textContent = `${this.settings.panelY.toFixed(2)}m`;
      this.yawLabel.textContent = `${Math.round(this.settings.panelYaw)}°`;
      this.pitchLabel.textContent = `${Math.round(this.settings.panelPitch)}°`;
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
        const mode = this.xrSession
          ? (this.xrSessionMode === "immersive-ar" ? "MR active" : "VR active")
          : "Desktop theater";
        this.theaterStatus.textContent = `${mode} · ${LAYOUT_LABELS[this.settings.layout] || "Video"} · ${this.settings.panelWidth.toFixed(1)} x ${this.settings.panelHeight.toFixed(1)}m`;
      }
    }

    updateNumericSetting(key, value) {
      const limits = {
        panelWidth: [1.4, 6],
        panelHeight: [0.8, 3.6],
        panelX: [-3, 3],
        panelY: [-1.4, 1.4],
        panelYaw: [-35, 35],
        panelPitch: [-20, 20],
        distance: [1.4, 6],
        roomDim: [0, 100],
        backlightIntensity: [0, 150],
      }[key];
      this.settings[key] = clampNumber(Number(value), limits[0], limits[1], DEFAULT_SETTINGS[key]);
      this.saveSettings();
      this.syncOverlayControls();
      this.updateVideoGeometry();
      this.updateSceneLighting();
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
      const width = Number(this.video.videoWidth || 16);
      const height = Number(this.video.videoHeight || 9);
      if (!width || !height) return 16 / 9;
      if (this.settings.layout === "full-sbs") return Math.max(0.1, (width / 2) / height);
      return Math.max(0.1, width / height);
    }

    recenterScreen(options = {}) {
      this.settings.panelX = 0;
      this.settings.panelY = 0;
      this.settings.panelYaw = 0;
      if (options.resetDistance) {
        this.settings.distance = DEFAULT_SETTINGS.distance;
        this.settings.panelWidth = DEFAULT_SETTINGS.panelWidth;
        this.settings.panelHeight = DEFAULT_SETTINGS.panelHeight;
      }
      this.saveSettings();
      this.syncOverlayControls();
      this.updateVideoGeometry();
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

    initThree() {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setClearAlpha(0);
      this.renderer.xr.enabled = true;
      this.renderer.xr.setReferenceSpaceType("local-floor");
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      this.camera.position.set(0, 0, 0);
      this.xrRaycaster = new THREE.Raycaster();
      this.xrControllerRayMatrix = new THREE.Matrix4();
      const ambient = new THREE.AmbientLight(0xffffff, 1);
      this.scene.add(ambient);
      this.screenGroup = new THREE.Group();
      this.scene.add(this.screenGroup);
      this.themeGroup = new THREE.Group();
      this.scene.add(this.themeGroup);
      this.videoTexture = new THREE.VideoTexture(this.video);
      this.videoTexture.colorSpace = THREE.SRGBColorSpace;
      this.videoTexture.minFilter = THREE.LinearFilter;
      this.videoTexture.magFilter = THREE.LinearFilter;
      this.videoTexture.generateMipmaps = false;
      const material = new THREE.MeshBasicMaterial({ map: this.videoTexture, side: THREE.DoubleSide });
      this.videoMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      this.videoMesh.onBeforeRender = (_renderer, _scene, camera) => this.applyVideoTextureUvForCamera(camera);
      this.screenGroup.add(this.videoMesh);
      this.initBacklight();
      this.initXrSidePanel();
      this.initXrControllers();
      this.applyTheme();
      this.updateSceneLighting();
    }

    updateSceneLighting() {
      if (!this.scene) return;
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
    }

    updateVideoGeometry() {
      if (!this.videoMesh) return;
      this.videoMesh.scale.set(this.settings.panelWidth, this.settings.panelHeight, 1);
      this.videoMesh.position.set(0, 0, 0);
      if (this.screenGroup) {
        this.screenGroup.position.set(this.settings.panelX, this.settings.panelY, -this.settings.distance);
        this.screenGroup.rotation.set(0, THREE.MathUtils.degToRad(this.settings.panelYaw), 0);
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
      if (!this.xrSession || !camera) return this.settings.eye;
      const viewport = camera.viewport;
      if (viewport && Number(viewport.x || 0) > 0) return "right";
      if (typeof camera.name === "string" && camera.name.toLowerCase().includes("right")) return "right";
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
      this.toggleSidePanel();
      this.pulseController(controller);
    }

    activateXrSidePanelHotspot(controller) {
      if (!this.xrSession || !this.xrSidePanelMesh?.visible || !this.xrRaycaster || !this.xrControllerRayMatrix) return false;
      const hit = this.sidePanelHitForController(controller);
      if (!hit?.uv) return false;
      const x = hit.uv.x * this.xrSidePanelCanvas.width;
      const y = (1 - hit.uv.y) * this.xrSidePanelCanvas.height;
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

    activateXrHotspot(hotspot) {
      const sizeStep = 0.2;
      const intensityStep = 10;
      const dimStep = 10;
      if (hotspot.action === "play") {
        this.togglePlayback();
      } else if (hotspot.action === "mute-video") {
        this.video.muted = !this.video.muted;
        this.updatePlaybackControls();
      } else if (hotspot.action === "recenter") {
        this.recenterScreen();
      } else if (hotspot.action === "size-down") {
        this.updatePanelSize("width", this.settings.panelWidth - sizeStep);
      } else if (hotspot.action === "size-up") {
        this.updatePanelSize("width", this.settings.panelWidth + sizeStep);
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

    initBacklight() {
      this.backlightGroup = new THREE.Group();
      this.backlightGroup.position.set(0, 0, -0.1);
      this.screenGroup.add(this.backlightGroup);
      this.backlightTexture = createBacklightGlowTexture();
      const segments = [
        ...Array.from({ length: BACKLIGHT_SEGMENT_COUNTS.top }, (_value, index) => ({ side: "top", index, count: BACKLIGHT_SEGMENT_COUNTS.top })),
        ...Array.from({ length: BACKLIGHT_SEGMENT_COUNTS.bottom }, (_value, index) => ({ side: "bottom", index, count: BACKLIGHT_SEGMENT_COUNTS.bottom })),
        ...Array.from({ length: BACKLIGHT_SEGMENT_COUNTS.left }, (_value, index) => ({ side: "left", index, count: BACKLIGHT_SEGMENT_COUNTS.left })),
        ...Array.from({ length: BACKLIGHT_SEGMENT_COUNTS.right }, (_value, index) => ({ side: "right", index, count: BACKLIGHT_SEGMENT_COUNTS.right })),
      ];
      this.backlightSegments = segments.map((segment) => {
        const material = createBacklightSegmentMaterial(this.backlightTexture, this.videoTexture);
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 3, 3), material);
        mesh.renderOrder = -3;
        mesh.userData.backlightSegment = segment;
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
      this.backlightMaskMesh.renderOrder = -4;
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
          segment.material?.dispose?.();
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
      if (this.backlightMaskMesh) {
        this.backlightMaskMesh.scale.set(width * 1.01, height * 1.01, 1);
      }
      for (const segmentMesh of this.backlightSegments) {
        const segment = segmentMesh.userData.backlightSegment || {};
        if (segment.side === "top" || segment.side === "bottom") {
          const segmentWidth = (width / segment.count) * 3.65;
          const x = -width / 2 + (segment.index + 0.5) * (width / segment.count);
          const y = segment.side === "top" ? height / 2 - edgeInset : -height / 2 + edgeInset;
          segmentMesh.position.set(x, y, 0);
          segmentMesh.scale.set(segmentWidth, 2.2, 1);
        } else {
          const segmentHeight = (height / segment.count) * 3.35;
          const x = segment.side === "left" ? -width / 2 - edgeInset * 0.15 : width / 2 + edgeInset * 0.15;
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
        if (this.videoTexture) this.videoTexture.needsUpdate = true;
        for (const segmentMesh of this.backlightSegments) {
          this.setBacklightSegmentVideo(segmentMesh, ready ? 0.8 * intensity : 0);
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
      if (material.uniforms) {
        material.uniforms.useVideo.value = 0;
        material.uniforms.glowColor.value.setRGB(color.r, color.g, color.b);
        material.uniforms.opacity.value = opacity;
        material.needsUpdate = true;
        return;
      }
      material.color?.setRGB?.(color.r, color.g, color.b);
      material.opacity = opacity;
    }

    setBacklightSegmentVideo(segmentMesh, opacity) {
      const material = segmentMesh?.material;
      if (!material?.uniforms) {
        this.setBacklightSegmentStatic(segmentMesh, fallbackBacklightColor(segmentMesh?.userData?.backlightSegment || {}), opacity * 0.45);
        return;
      }
      const region = this.videoSampleRegionForSegment(segmentMesh.userData.backlightSegment || {});
      material.uniforms.useVideo.value = 1;
      material.uniforms.opacity.value = opacity;
      material.uniforms.videoMap.value = this.videoTexture;
      material.uniforms.sampleRegion.value.set(region.x0, region.y0, region.x1, region.y1);
    }

    videoSampleRegionForSegment(segment) {
      const window = this.displayedVideoSampleWindow();
      const start = Number(segment.index || 0) / Math.max(1, Number(segment.count || 1));
      const end = (Number(segment.index || 0) + 1) / Math.max(1, Number(segment.count || 1));
      const edgeDepth = 0.34;
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
        const output = { top: [], bottom: [], left: [], right: [] };
        const edgeDepth = 0.32;
        for (const segment of this.backlightSegments) {
          const start = segment.index / segment.count;
          const end = (segment.index + 1) / segment.count;
          let color = null;
          if (segment.side === "top") {
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
        this.setBacklightSampleStatus(this.lastVideoBacklightColors ? `${sample.source}: blank, using last` : `${sample.source}: blank`);
        return this.lastVideoBacklightColors || offBacklightColors();
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

    displayedVideoSampleWindow() {
      if (this.settings.layout === "half-sbs" || this.settings.layout === "full-sbs") {
        return this.settings.eye === "right"
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
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }

    renderFrame() {
      if (!this.renderer || !this.scene || !this.camera) return;
      if (this.videoTexture && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        this.videoTexture.needsUpdate = true;
      }
      this.updateControllerDrag();
      this.updateBacklight();
      this.updateXrSidePanelTexture();
      this.updatePlaybackControls();
      this.renderer.render(this.scene, this.camera);
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
        const sessionMode = this.settings.headsetMode === "mr" && this.xrArSupported ? "immersive-ar" : "immersive-vr";
        session = await this.requestImmersiveSession(sessionMode);
        this.xrSession = session;
        this.xrSessionMode = sessionMode;
        this.xrSessionEndHandler = () => {
          this.xrSession = null;
          this.xrSessionMode = "";
          this.xrSessionEndHandler = null;
          this.activeGrab = null;
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
      this.xrSidePanelCanvas.width = 1024;
      this.xrSidePanelCanvas.height = 1024;
      this.xrSidePanelContext = this.xrSidePanelCanvas.getContext("2d");
      this.xrSidePanelTexture = new THREE.CanvasTexture(this.xrSidePanelCanvas);
      this.xrSidePanelTexture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.MeshBasicMaterial({
        map: this.xrSidePanelTexture,
        side: THREE.DoubleSide,
        transparent: true,
      });
      this.xrSidePanelMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      this.xrSidePanelMesh.visible = false;
      this.screenGroup.add(this.xrSidePanelMesh);
      this.updateXrSidePanelGeometry();
      this.updateXrSidePanelTexture(true);
    }

    updateXrSidePanelGeometry() {
      if (!this.xrSidePanelMesh) return;
      const sideWidth = clampNumber(this.settings.panelWidth * 0.48, 1.25, 2.05, 1.55);
      const sideHeight = clampNumber(this.settings.panelHeight, 1.05, 3.2, 1.8);
      this.xrSidePanelMesh.scale.set(sideWidth, sideHeight, 1);
      this.xrSidePanelMesh.position.set(
        this.settings.panelWidth / 2 + 0.35 + sideWidth / 2,
        0,
        0.04,
      );
      this.xrSidePanelMesh.rotation.set(0, -0.12, 0);
    }

    updateXrSidePanelTexture(force = false) {
      if (!this.xrSidePanelContext || !this.xrSidePanelTexture) return;
      const now = performance.now();
      if (this.xrSidePanelMesh) this.xrSidePanelMesh.visible = Boolean(this.xrSession && this.settings.sidePanelVisible);
      if (!force && now - this.lastSidePanelTextureAt < 500) return;
      this.lastSidePanelTextureAt = now;

      const context = this.xrSidePanelContext;
      const width = this.xrSidePanelCanvas.width;
      const height = this.xrSidePanelCanvas.height;
      const lines = this.collectSidePanelLines();
      const hotspots = [];
      context.clearRect(0, 0, width, height);
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
        { label: "Recenter", action: "recenter" },
        { label: "Size -", action: "size-down" },
        { label: "Size +", action: "size-up" },
        { label: `Backlight ${this.backlightModeLabel()}`, action: "backlight-cycle" },
        { label: "Light -", action: "intensity-down" },
        { label: "Light +", action: "intensity-up" },
        { label: "Room dim -", action: "dim-down" },
        { label: "Room dim +", action: "dim-up" },
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

  function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
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

  function createBacklightSegmentMaterial(glowTexture, videoTexture) {
    return new THREE.ShaderMaterial({
      uniforms: {
        glowMap: { value: glowTexture },
        videoMap: { value: videoTexture },
        glowColor: { value: new THREE.Color("#3b82f6") },
        opacity: { value: 0.24 },
        sampleRegion: { value: new THREE.Vector4(0, 0, 1, 1) },
        useVideo: { value: 0 },
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
        uniform vec3 glowColor;
        uniform float opacity;
        uniform vec4 sampleRegion;
        uniform float useVideo;
        varying vec2 vUv;

        vec3 sampledVideoColor() {
          vec3 sum = vec3(0.0);
          for (int y = 0; y < 3; y += 1) {
            for (int x = 0; x < 4; x += 1) {
              vec2 grid = (vec2(float(x), float(y)) + vec2(0.5)) / vec2(4.0, 3.0);
              vec2 topOriginUv = mix(sampleRegion.xy, sampleRegion.zw, grid);
              vec2 textureUv = vec2(topOriginUv.x, 1.0 - topOriginUv.y);
              sum += texture2D(videoMap, textureUv).rgb;
            }
          }
          vec3 average = sum / 12.0;
          float maxChannel = max(max(average.r, average.g), average.b);
          float luminance = dot(average, vec3(0.2126, 0.7152, 0.0722));
          float active = smoothstep(0.018, 0.075, max(maxChannel, luminance));
          float boost = mix(1.65, 1.08, smoothstep(0.14, 0.55, maxChannel));
          return clamp(average * boost * active, vec3(0.0), vec3(1.0));
        }

        void main() {
          vec4 glow = texture2D(glowMap, vUv);
          vec3 videoColor = sampledVideoColor();
          float videoMax = max(max(videoColor.r, videoColor.g), videoColor.b);
          float videoLuminance = dot(videoColor, vec3(0.2126, 0.7152, 0.0722));
          float videoAlpha = smoothstep(0.01, 0.05, max(videoMax, videoLuminance));
          vec3 color = mix(glowColor, videoColor, useVideo);
          float alpha = glow.a * opacity * mix(1.0, videoAlpha, useVideo);
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
    const output = { top: [], bottom: [], left: [], right: [] };
    for (const segment of segments || []) {
      if (!output[segment.side]) continue;
      output[segment.side][segment.index] = sampleExpandedSegmentRegion(data, width, height, window, segment);
    }
    return output;
  }

  function fallbackBacklightColors(color = null, opacity = null) {
    const output = { top: [], bottom: [], left: [], right: [] };
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
    const output = { top: [], bottom: [], left: [], right: [] };
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
