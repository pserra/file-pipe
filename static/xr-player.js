(() => {
  const INSTANCE_BY_VIDEO = new WeakMap();
  const DEFAULT_SETTINGS = {
    layout: "mono",
    eye: "left",
    panelWidth: 3.2,
    panelHeight: 1.8,
    distance: 3,
    roomDim: 80,
  };
  const LAYOUT_LABELS = {
    mono: "Full frame",
    "half-sbs": "Half SBS 3D",
    "full-sbs": "Full SBS 3D",
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
      this.videoMesh = null;
      this.videoTexture = null;
      this.xrSupported = false;
      this.xrSupportChecked = false;
      this.sidePanel = null;
      this.sidePanelPlaceholder = null;
      this.xrSession = null;
      this.xrSessionEndHandler = null;
      this.inTheater = false;

      this.buildInlineControls();
      this.bindInlineControls();
      this.refreshXrSupport();
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
          panelWidth: clampNumber(Number(stored.panelWidth), 1.4, 6, DEFAULT_SETTINGS.panelWidth),
          panelHeight: clampNumber(Number(stored.panelHeight), 0.8, 3.6, DEFAULT_SETTINGS.panelHeight),
          distance: clampNumber(Number(stored.distance), 1.4, 6, DEFAULT_SETTINGS.distance),
          roomDim: clampNumber(Number(stored.roomDim), 0, 100, DEFAULT_SETTINGS.roomDim),
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
          <button class="btn btn-sm btn-outline-info" type="button" data-action="enter-vr">
            <i class="bi bi-badge-vr"></i>
            <span data-role="vr-label">View in VR</span>
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
      this.eyeField = this.panel.querySelector("[data-role='eye-field']");
      this.vrButton = this.panel.querySelector("[data-action='enter-vr']");
      this.vrLabel = this.panel.querySelector("[data-role='vr-label']");
      this.statusElement = this.panel.querySelector("[data-role='status']");
      this.layoutSelect.value = this.settings.layout;
      this.eyeSelect.value = this.settings.eye;
      this.eyeField.hidden = this.settings.layout === "mono";
    }

    bindInlineControls() {
      this.listen(this.layoutSelect, "change", () => {
        this.settings.layout = this.layoutSelect.value;
        this.eyeField.hidden = this.settings.layout === "mono";
        this.saveSettings();
        this.updateVideoMaterialUv();
        this.syncOverlayControls();
        this.updateInlineStatus();
      });
      this.listen(this.eyeSelect, "change", () => {
        this.settings.eye = this.eyeSelect.value === "right" ? "right" : "left";
        this.saveSettings();
        this.updateVideoMaterialUv();
        this.syncOverlayControls();
      });
      this.listen(this.vrButton, "click", () => this.openTheater());
      this.listen(this.video, "loadedmetadata", () => this.updateVideoGeometry());
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
      this.xrSupported = Boolean(window.isSecureContext && navigator.xr?.isSessionSupported);
      if (this.xrSupported) {
        this.xrSupported = await navigator.xr.isSessionSupported("immersive-vr").catch(() => false);
      }
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
      this.statusElement.textContent = this.xrSupported
        ? `${layout}. Three.js theater is ready for desktop or WebXR.`
        : `${layout}. Three.js theater is available; WebXR is unavailable in this browser.`;
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
      this.xrSessionEndHandler = null;
      if (this.renderer) this.renderer.setAnimationLoop(null);
      this.restoreSidePanel();
      if (this.overlay) this.overlay.remove();
      this.overlay = null;
      if (this.videoTexture) this.videoTexture.dispose();
      if (this.renderer) this.renderer.dispose();
      this.renderer = null;
      this.scene = null;
      this.camera = null;
      this.videoMesh = null;
      this.videoTexture = null;
      document.body.classList.remove("fp-three-xr-active");
    }

    buildOverlay() {
      this.overlay = document.createElement("div");
      this.overlay.className = "fp-three-xr-overlay";
      this.overlay.innerHTML = `
        <div class="fp-three-xr-topbar">
          <div>
            <strong>File Pipe Theater</strong>
            <span data-role="theater-status"></span>
          </div>
          <div class="fp-three-xr-top-actions">
            <button class="btn btn-sm btn-outline-light" type="button" data-action="enter-webxr">
              <i class="bi bi-badge-vr"></i> WebXR
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
              <label class="fp-xr-range"><span>Width <output data-role="width-label"></output></span><input class="form-range" type="range" min="1.4" max="6" step="0.1" data-role="panel-width"></label>
              <label class="fp-xr-range"><span>Height <output data-role="height-label"></output></span><input class="form-range" type="range" min="0.8" max="3.6" step="0.1" data-role="panel-height"></label>
              <label class="fp-xr-range"><span>Distance <output data-role="distance-label"></output></span><input class="form-range" type="range" min="1.4" max="6" step="0.1" data-role="panel-distance"></label>
              <label class="fp-xr-range"><span>Room dim <output data-role="dim-label"></output></span><input class="form-range" type="range" min="0" max="100" step="5" data-role="room-dim"></label>
            </div>
            <div class="fp-three-xr-side-slot" data-role="side-slot"></div>
          </aside>
        </div>
      `;
      document.body.appendChild(this.overlay);
      this.canvas = this.overlay.querySelector(".fp-three-xr-canvas");
      this.theaterStatus = this.overlay.querySelector("[data-role='theater-status']");
      this.overlayLayoutSelect = this.overlay.querySelector("[data-role='overlay-layout']");
      this.overlayEyeSelect = this.overlay.querySelector("[data-role='overlay-eye']");
      this.overlayEyeField = this.overlay.querySelector("[data-role='overlay-eye-field']");
      this.widthInput = this.overlay.querySelector("[data-role='panel-width']");
      this.heightInput = this.overlay.querySelector("[data-role='panel-height']");
      this.distanceInput = this.overlay.querySelector("[data-role='panel-distance']");
      this.dimInput = this.overlay.querySelector("[data-role='room-dim']");
      this.widthLabel = this.overlay.querySelector("[data-role='width-label']");
      this.heightLabel = this.overlay.querySelector("[data-role='height-label']");
      this.distanceLabel = this.overlay.querySelector("[data-role='distance-label']");
      this.dimLabel = this.overlay.querySelector("[data-role='dim-label']");
      this.playButton = this.overlay.querySelector("[data-action='play-toggle']");
      this.playIcon = this.playButton.querySelector(".bi");
      this.seekInput = this.overlay.querySelector("[data-role='seek']");
      this.timeLabel = this.overlay.querySelector("[data-role='time']");
      this.muteButton = this.overlay.querySelector("[data-action='mute-toggle']");
      this.muteIcon = this.muteButton.querySelector(".bi");
      this.webXrButton = this.overlay.querySelector("[data-action='enter-webxr']");
      this.sideSlot = this.overlay.querySelector("[data-role='side-slot']");
      this.overlay.querySelector("[data-action='close']").addEventListener("click", () => this.closeTheater());
      this.webXrButton.addEventListener("click", () => this.enterWebXr());
      this.playButton.addEventListener("click", () => this.togglePlayback());
      this.muteButton.addEventListener("click", () => {
        this.video.muted = !this.video.muted;
        this.updatePlaybackControls();
      });
      this.seekInput.addEventListener("input", () => {
        const duration = Number(this.video.duration || 0);
        if (duration) this.video.currentTime = duration * (Number(this.seekInput.value || 0) / 1000);
      });
      this.overlayLayoutSelect.addEventListener("change", () => {
        this.settings.layout = this.overlayLayoutSelect.value;
        this.layoutSelect.value = this.settings.layout;
        this.saveSettings();
        this.updateVideoMaterialUv();
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
      this.widthInput.addEventListener("input", () => this.updateNumericSetting("panelWidth", this.widthInput.value));
      this.heightInput.addEventListener("input", () => this.updateNumericSetting("panelHeight", this.heightInput.value));
      this.distanceInput.addEventListener("input", () => this.updateNumericSetting("distance", this.distanceInput.value));
      this.dimInput.addEventListener("input", () => this.updateNumericSetting("roomDim", this.dimInput.value));
      this.syncOverlayControls();
    }

    syncOverlayControls() {
      if (!this.overlay) return;
      this.overlayLayoutSelect.value = this.settings.layout;
      this.overlayEyeSelect.value = this.settings.eye;
      this.overlayEyeField.hidden = this.settings.layout === "mono";
      this.widthInput.value = String(this.settings.panelWidth);
      this.heightInput.value = String(this.settings.panelHeight);
      this.distanceInput.value = String(this.settings.distance);
      this.dimInput.value = String(this.settings.roomDim);
      this.widthLabel.textContent = `${this.settings.panelWidth.toFixed(1)}m`;
      this.heightLabel.textContent = `${this.settings.panelHeight.toFixed(1)}m`;
      this.distanceLabel.textContent = `${this.settings.distance.toFixed(1)}m`;
      this.dimLabel.textContent = `${Math.round(this.settings.roomDim)}%`;
      if (this.webXrButton) {
        this.webXrButton.disabled = !this.xrSupported || Boolean(this.xrSession);
      }
      if (this.theaterStatus) {
        const mode = this.xrSession ? "WebXR active" : "Desktop theater";
        this.theaterStatus.textContent = `${mode} · ${LAYOUT_LABELS[this.settings.layout] || "Video"} · ${this.settings.panelWidth.toFixed(1)} x ${this.settings.panelHeight.toFixed(1)}m`;
      }
    }

    updateNumericSetting(key, value) {
      const limits = {
        panelWidth: [1.4, 6],
        panelHeight: [0.8, 3.6],
        distance: [1.4, 6],
        roomDim: [0, 100],
      }[key];
      this.settings[key] = clampNumber(Number(value), limits[0], limits[1], DEFAULT_SETTINGS[key]);
      this.saveSettings();
      this.syncOverlayControls();
      this.updateVideoGeometry();
      this.updateSceneLighting();
    }

    initThree() {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.xr.enabled = true;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
      this.camera.position.set(0, 0, 0);
      const ambient = new THREE.AmbientLight(0xffffff, 1);
      this.scene.add(ambient);
      this.videoTexture = new THREE.VideoTexture(this.video);
      this.videoTexture.colorSpace = THREE.SRGBColorSpace;
      this.videoTexture.minFilter = THREE.LinearFilter;
      this.videoTexture.magFilter = THREE.LinearFilter;
      this.videoTexture.generateMipmaps = false;
      const material = new THREE.MeshBasicMaterial({ map: this.videoTexture, side: THREE.DoubleSide });
      this.videoMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      this.scene.add(this.videoMesh);
      const grid = new THREE.GridHelper(8, 16, 0x2f80ff, 0x1f2937);
      grid.position.y = -1.65;
      this.scene.add(grid);
      this.updateSceneLighting();
    }

    updateSceneLighting() {
      if (!this.scene) return;
      const dim = clampNumber(Number(this.settings.roomDim), 0, 100, DEFAULT_SETTINGS.roomDim) / 100;
      this.scene.background = new THREE.Color(dim * 0.025, dim * 0.03, dim * 0.04);
    }

    updateVideoGeometry() {
      if (!this.videoMesh) return;
      this.videoMesh.scale.set(this.settings.panelWidth, this.settings.panelHeight, 1);
      this.videoMesh.position.set(0, 0, -this.settings.distance);
    }

    updateVideoMaterialUv() {
      if (!this.videoTexture) return;
      this.videoTexture.offset.set(0, 0);
      this.videoTexture.repeat.set(1, 1);
      if (this.settings.layout === "half-sbs") {
        this.videoTexture.repeat.set(0.5, 1);
        this.videoTexture.offset.set(this.settings.eye === "right" ? 0.5 : 0, 0);
      }
      if (this.settings.layout === "full-sbs") {
        this.videoTexture.repeat.set(0.5, 1);
        this.videoTexture.offset.set(this.settings.eye === "right" ? 0.5 : 0, 0);
      }
      this.videoTexture.needsUpdate = true;
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
        session = await navigator.xr.requestSession("immersive-vr", {
          optionalFeatures: ["local-floor", "bounded-floor", "dom-overlay"],
          domOverlay: { root: this.overlay },
        });
        this.xrSession = session;
        this.xrSessionEndHandler = () => {
          this.xrSession = null;
          this.xrSessionEndHandler = null;
          this.syncOverlayControls();
        };
        session.addEventListener("end", this.xrSessionEndHandler, { once: true });
        await this.renderer.xr.setSession(session);
        this.syncOverlayControls();
      } catch (error) {
        if (session && this.xrSession === session) {
          session.removeEventListener("end", this.xrSessionEndHandler);
          this.xrSession = null;
          this.xrSessionEndHandler = null;
          session.end().catch(() => {});
        }
        this.updateInlineStatus(error.message || "Could not enter WebXR.");
        this.syncOverlayControls();
      }
    }

    moveSidePanelIntoOverlay() {
      const panel = document.querySelector(this.options.panelSelector);
      if (!panel || !this.sideSlot || this.sidePanel) return;
      this.sidePanel = panel;
      this.sidePanelPlaceholder = document.createComment("file-pipe-xr-side-panel");
      panel.parentNode.insertBefore(this.sidePanelPlaceholder, panel);
      this.sideSlot.appendChild(panel);
      panel.classList.add("fp-three-xr-moved-panel");
    }

    restoreSidePanel() {
      if (!this.sidePanel || !this.sidePanelPlaceholder) return;
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

  function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const remaining = total % 60;
    return `${minutes}:${String(remaining).padStart(2, "0")}`;
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
