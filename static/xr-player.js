(() => {
  const INSTANCE_BY_VIDEO = new WeakMap();
  const DEFAULT_SETTINGS = {
    layout: "mono",
    desktop2d: false,
    eye: "left",
    windowScale: 100,
    xrDistance: 2,
    roomDim: 85,
  };
  const LAYOUT_LABELS = {
    mono: "Full frame",
    "half-sbs": "Half SBS 3D",
    "full-sbs": "Full SBS 3D",
  };

  class FilePipeXrVideoPlayer {
    constructor(video, options = {}) {
      this.video = video;
      this.options = {
        storageKey: "filePipeXrPlayer",
        fill: false,
        ...options,
      };
      this.settings = this.readSettings();
      this.cleanups = [];
      this.desktopFrameRequest = 0;
      this.xrSupported = false;
      this.xrSupportChecked = false;
      this.xrSession = null;
      this.xrReferenceSpace = null;
      this.gl = null;
      this.glResources = null;
      this.textureWarningShown = false;

      this.buildDom();
      this.bindEvents();
      this.applySettings({ persist: false });
      this.refreshXrSupport();
    }

    updateOptions(options = {}) {
      this.options = { ...this.options, ...options };
      this.stage.classList.toggle("fp-xr-fill", Boolean(this.options.fill));
      this.panel.classList.toggle("fp-xr-panel-overlay", Boolean(this.options.fill));
      this.updateAspect();
      return this;
    }

    readSettings() {
      try {
        const stored = JSON.parse(localStorage.getItem(this.options.storageKey) || "{}");
        return {
          layout: isKnownLayout(stored.layout) ? stored.layout : DEFAULT_SETTINGS.layout,
          desktop2d: Boolean(stored.desktop2d),
          eye: stored.eye === "right" ? "right" : DEFAULT_SETTINGS.eye,
          windowScale: clampNumber(Number(stored.windowScale), 60, 120, DEFAULT_SETTINGS.windowScale),
          xrDistance: clampNumber(Number(stored.xrDistance), 1.2, 4, DEFAULT_SETTINGS.xrDistance),
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
        // Local storage can be disabled in private contexts.
      }
    }

    buildDom() {
      const parent = this.video.parentNode;
      this.stage = document.createElement("div");
      this.stage.className = "fp-xr-stage";
      this.stage.classList.toggle("fp-xr-fill", Boolean(this.options.fill));
      parent.insertBefore(this.stage, this.video);
      this.stage.appendChild(this.video);

      this.desktopCanvas = document.createElement("canvas");
      this.desktopCanvas.className = "fp-xr-canvas fp-xr-2d-canvas";
      this.desktopCanvas.setAttribute("aria-hidden", "true");
      this.stage.appendChild(this.desktopCanvas);

      this.xrCanvas = document.createElement("canvas");
      this.xrCanvas.className = "fp-xr-canvas fp-xr-webxr-canvas";
      this.xrCanvas.setAttribute("aria-hidden", "true");
      this.stage.appendChild(this.xrCanvas);

      this.playbackControls = document.createElement("div");
      this.playbackControls.className = "fp-xr-playback-controls";
      this.playbackControls.innerHTML = `
        <button class="btn btn-sm btn-light fp-xr-play-toggle" type="button" data-action="play-toggle">
          <i class="bi bi-play-fill"></i>
        </button>
        <input class="form-range fp-xr-seek" type="range" min="0" max="1000" step="1" value="0" data-role="seek">
        <span class="fp-xr-time" data-role="time">0:00 / 0:00</span>
        <button class="btn btn-sm btn-light fp-xr-mute-toggle" type="button" data-action="mute-toggle">
          <i class="bi bi-volume-up"></i>
        </button>
      `;
      this.stage.appendChild(this.playbackControls);

      this.panel = document.createElement("div");
      this.panel.className = "fp-xr-panel";
      this.panel.classList.toggle("fp-xr-panel-overlay", Boolean(this.options.fill));
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
          <button class="btn btn-sm btn-outline-primary" type="button" data-action="toggle-2d">
            <i class="bi bi-crop"></i>
            <span data-role="toggle-2d-label">Show 2D</span>
          </button>
          <label class="fp-xr-field fp-xr-eye-field" data-role="eye-field">
            <span>Eye</span>
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
        <div class="fp-xr-tuning-row">
          <label class="fp-xr-range">
            <span>Window <output data-role="window-size-label">100%</output></span>
            <input class="form-range" type="range" min="60" max="120" step="5" data-role="window-size">
          </label>
          <label class="fp-xr-range">
            <span>Distance <output data-role="distance-label">2.0m</output></span>
            <input class="form-range" type="range" min="1.2" max="4" step="0.1" data-role="distance">
          </label>
          <label class="fp-xr-range">
            <span>Room dim <output data-role="dim-label">85%</output></span>
            <input class="form-range" type="range" min="0" max="100" step="5" data-role="dim">
          </label>
        </div>
        <div class="fp-xr-status" data-role="status"></div>
      `;
      this.stage.insertAdjacentElement("afterend", this.panel);

      this.layoutSelect = this.panel.querySelector("[data-role='layout']");
      this.eyeSelect = this.panel.querySelector("[data-role='eye']");
      this.eyeField = this.panel.querySelector("[data-role='eye-field']");
      this.toggle2dButton = this.panel.querySelector("[data-action='toggle-2d']");
      this.toggle2dLabel = this.panel.querySelector("[data-role='toggle-2d-label']");
      this.vrButton = this.panel.querySelector("[data-action='enter-vr']");
      this.vrLabel = this.panel.querySelector("[data-role='vr-label']");
      this.statusElement = this.panel.querySelector("[data-role='status']");
      this.windowSizeInput = this.panel.querySelector("[data-role='window-size']");
      this.windowSizeLabel = this.panel.querySelector("[data-role='window-size-label']");
      this.distanceInput = this.panel.querySelector("[data-role='distance']");
      this.distanceLabel = this.panel.querySelector("[data-role='distance-label']");
      this.dimInput = this.panel.querySelector("[data-role='dim']");
      this.dimLabel = this.panel.querySelector("[data-role='dim-label']");
      this.playButton = this.playbackControls.querySelector("[data-action='play-toggle']");
      this.playIcon = this.playButton.querySelector(".bi");
      this.seekInput = this.playbackControls.querySelector("[data-role='seek']");
      this.timeLabel = this.playbackControls.querySelector("[data-role='time']");
      this.muteButton = this.playbackControls.querySelector("[data-action='mute-toggle']");
      this.muteIcon = this.muteButton.querySelector(".bi");
    }

    bindEvents() {
      this.listen(this.layoutSelect, "change", () => {
        this.settings.layout = this.layoutSelect.value;
        if (!this.isStereoLayout()) this.settings.desktop2d = false;
        this.applySettings();
      });
      this.listen(this.eyeSelect, "change", () => {
        this.settings.eye = this.eyeSelect.value === "right" ? "right" : "left";
        this.applySettings();
      });
      this.listen(this.toggle2dButton, "click", () => {
        if (!this.isStereoLayout()) return;
        this.settings.desktop2d = !this.settings.desktop2d;
        this.applySettings();
      });
      this.listen(this.vrButton, "click", () => {
        if (this.xrSession) {
          this.xrSession.end();
          return;
        }
        this.enterVr();
      });
      this.listen(this.windowSizeInput, "input", () => {
        this.settings.windowScale = clampNumber(Number(this.windowSizeInput.value), 60, 120, DEFAULT_SETTINGS.windowScale);
        this.applySettings();
      });
      this.listen(this.distanceInput, "input", () => {
        this.settings.xrDistance = clampNumber(Number(this.distanceInput.value), 1.2, 4, DEFAULT_SETTINGS.xrDistance);
        this.applySettings();
      });
      this.listen(this.dimInput, "input", () => {
        this.settings.roomDim = clampNumber(Number(this.dimInput.value), 0, 100, DEFAULT_SETTINGS.roomDim);
        this.applySettings();
      });
      this.listen(this.desktopCanvas, "click", () => this.togglePlayback());
      this.listen(this.playButton, "click", () => this.togglePlayback());
      this.listen(this.muteButton, "click", () => {
        this.video.muted = !this.video.muted;
        this.updatePlaybackControls();
      });
      this.listen(this.seekInput, "input", () => {
        const duration = Number(this.video.duration || 0);
        if (!duration) return;
        this.video.currentTime = duration * (Number(this.seekInput.value || 0) / 1000);
        this.drawDesktopFrame();
        this.updatePlaybackControls();
      });

      ["loadedmetadata", "durationchange", "resize"].forEach((eventName) => {
        this.listen(this.video, eventName, () => {
          this.updateAspect();
          this.drawDesktopFrame();
          this.updatePlaybackControls();
        });
      });
      ["play", "pause", "timeupdate", "volumechange", "seeked"].forEach((eventName) => {
        this.listen(this.video, eventName, () => this.updatePlaybackControls());
      });
      this.listen(window, "resize", () => {
        this.updateAspect();
        this.drawDesktopFrame();
      });
    }

    listen(target, eventName, handler) {
      target.addEventListener(eventName, handler);
      this.cleanups.push(() => target.removeEventListener(eventName, handler));
    }

    async refreshXrSupport() {
      this.xrSupportChecked = true;
      this.xrSupported = Boolean(window.isSecureContext && navigator.xr?.isSessionSupported);
      if (this.xrSupported) {
        this.xrSupported = await navigator.xr.isSessionSupported("immersive-vr").catch(() => false);
      }
      this.updateXrButton();
      this.updateStatus();
    }

    isStereoLayout() {
      return this.settings.layout === "half-sbs" || this.settings.layout === "full-sbs";
    }

    isDesktop2dActive() {
      return this.isStereoLayout() && this.settings.desktop2d;
    }

    applySettings({ persist = true } = {}) {
      this.layoutSelect.value = this.settings.layout;
      this.eyeSelect.value = this.settings.eye;
      const desktopActive = this.isDesktop2dActive();
      this.stage.classList.toggle("fp-xr-desktop-2d", desktopActive);
      this.stage.classList.toggle("fp-xr-stereo-source", this.isStereoLayout());
      this.toggle2dButton.disabled = !this.isStereoLayout();
      this.toggle2dButton.classList.toggle("btn-primary", desktopActive);
      this.toggle2dButton.classList.toggle("btn-outline-primary", !desktopActive);
      this.toggle2dLabel.textContent = desktopActive ? "Showing 2D" : "Show 2D";
      this.eyeField.hidden = !desktopActive;
      this.windowSizeInput.value = String(this.settings.windowScale);
      this.windowSizeLabel.textContent = `${Math.round(this.settings.windowScale)}%`;
      this.distanceInput.value = String(this.settings.xrDistance);
      this.distanceLabel.textContent = `${this.settings.xrDistance.toFixed(1)}m`;
      this.dimInput.value = String(this.settings.roomDim);
      this.dimLabel.textContent = `${Math.round(this.settings.roomDim)}%`;
      const desktopWidth = this.options.fill ? "100%" : `${this.settings.windowScale}%`;
      this.stage.style.setProperty("--fp-xr-desktop-width", desktopWidth);
      this.panel.style.setProperty("--fp-xr-desktop-width", desktopWidth);
      this.updateAspect();
      this.updateXrButton();
      this.updateStatus();
      this.updatePlaybackControls();
      if (desktopActive) {
        this.startDesktopLoop();
      } else {
        this.stopDesktopLoop();
      }
      if (persist) this.saveSettings();
    }

    updateAspect() {
      const aspect = this.stageAspect();
      if (aspect) this.stage.style.setProperty("--fp-xr-aspect", String(aspect));
    }

    updateXrButton() {
      if (!this.vrButton) return;
      this.vrButton.disabled = !this.xrSupported && !this.xrSession;
      this.vrLabel.textContent = this.xrSession ? "Exit VR" : "View in VR";
    }

    updateStatus(message = "") {
      if (message) {
        this.statusElement.textContent = message;
        return;
      }
      if (!this.isStereoLayout()) {
        this.statusElement.textContent = this.xrSupported
          ? `Full frame selected. VR opens a ${Math.round(this.settings.windowScale)}% video window.`
          : "Full frame selected.";
        return;
      }
      const layout = LAYOUT_LABELS[this.settings.layout];
      if (this.isDesktop2dActive()) {
        this.statusElement.textContent = `${layout}: showing the ${this.settings.eye} half as 2D in a resizable window.`;
        return;
      }
      if (!this.xrSupported && this.xrSupportChecked) {
        this.statusElement.textContent = `${layout} selected. WebXR VR is unavailable in this browser.`;
        return;
      }
      this.statusElement.textContent = `${layout} selected. VR renders it as a ${Math.round(this.settings.windowScale)}% stereo screen.`;
    }

    async togglePlayback() {
      if (this.video.paused) {
        await this.video.play().catch((error) => {
          this.updateStatus(error.message || "Playback was blocked by the browser.");
        });
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
      this.muteIcon.className = this.video.muted || this.video.volume === 0
        ? "bi bi-volume-mute"
        : "bi bi-volume-up";
    }

    startDesktopLoop() {
      if (this.desktopFrameRequest) return;
      const draw = () => {
        this.desktopFrameRequest = 0;
        if (!this.isDesktop2dActive()) return;
        this.drawDesktopFrame();
        this.updatePlaybackControls();
        this.desktopFrameRequest = requestAnimationFrame(draw);
      };
      draw();
    }

    stopDesktopLoop() {
      if (this.desktopFrameRequest) {
        cancelAnimationFrame(this.desktopFrameRequest);
        this.desktopFrameRequest = 0;
      }
    }

    drawDesktopFrame() {
      if (!this.isDesktop2dActive()) return;
      const canvas = this.desktopCanvas;
      const context = canvas.getContext("2d");
      const width = Math.max(1, Math.round(canvas.clientWidth * window.devicePixelRatio));
      const height = Math.max(1, Math.round(canvas.clientHeight * window.devicePixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.fillStyle = "#000000";
      context.fillRect(0, 0, width, height);
      if (!this.video.videoWidth || !this.video.videoHeight || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
      }

      const source = this.sourceRect(this.settings.eye);
      const dest = fitRect(width, height, this.displayAspect());
      try {
        context.drawImage(
          this.video,
          source.x,
          source.y,
          source.width,
          source.height,
          dest.x,
          dest.y,
          dest.width,
          dest.height,
        );
      } catch (error) {
        if (!this.textureWarningShown) {
          this.textureWarningShown = true;
          this.updateStatus("This video source cannot be cropped by the browser. Try the stable MP4 cache or a same-origin file.");
        }
      }
    }

    async enterVr() {
      if (!this.xrSupported || !navigator.xr) {
        this.updateStatus("WebXR immersive VR is unavailable in this browser.");
        return;
      }
      if (!this.video.videoWidth || !this.video.videoHeight) {
        this.updateStatus("Wait for the video metadata to load before entering VR.");
        return;
      }
      try {
        await this.video.play().catch(() => {});
        const session = await navigator.xr.requestSession("immersive-vr", {
          optionalFeatures: ["local-floor", "bounded-floor", "dom-overlay"],
          domOverlay: { root: document.body },
        });
        this.xrSession = session;
        this.updateXrButton();
        this.updateStatus(this.isStereoLayout()
          ? `${LAYOUT_LABELS[this.settings.layout]} is rendering as stereo in VR.`
          : "Full frame is rendering as 2D in VR.");

        this.gl = this.gl || this.xrCanvas.getContext("webgl", {
          alpha: false,
          antialias: true,
          preserveDrawingBuffer: false,
          xrCompatible: true,
        });
        if (!this.gl) throw new Error("This browser could not create the WebGL context required for WebXR.");
        if (this.gl.makeXRCompatible) await this.gl.makeXRCompatible();
        session.updateRenderState({ baseLayer: new XRWebGLLayer(session, this.gl) });
        this.xrReferenceSpace = await session.requestReferenceSpace("local")
          .catch(() => session.requestReferenceSpace("viewer"));
        this.ensureGlResources();
        session.addEventListener("end", () => this.handleXrEnd(), { once: true });
        session.requestAnimationFrame((time, frame) => this.renderXrFrame(time, frame));
      } catch (error) {
        this.xrSession = null;
        this.updateXrButton();
        this.updateStatus(error.message || "Could not start WebXR VR playback.");
      }
    }

    handleXrEnd() {
      this.xrSession = null;
      this.xrReferenceSpace = null;
      this.updateXrButton();
      this.updateStatus("VR session ended.");
    }

    renderXrFrame(_time, frame) {
      const session = frame.session;
      if (!this.xrSession || session !== this.xrSession) return;
      session.requestAnimationFrame((time, nextFrame) => this.renderXrFrame(time, nextFrame));
      const pose = frame.getViewerPose(this.xrReferenceSpace);
      if (!pose) return;
      const gl = this.gl;
      const layer = session.renderState.baseLayer;
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      gl.enable(gl.SCISSOR_TEST);
      const backdrop = this.backdropLevel();
      gl.clearColor(backdrop, backdrop, backdrop, 1);
      this.updateVideoTexture();

      for (const view of pose.views) {
        const viewport = layer.getViewport(view);
        gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
        gl.scissor(viewport.x, viewport.y, viewport.width, viewport.height);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.drawXrEye(view.eye === "right" ? "right" : "left", viewport);
      }
      gl.disable(gl.SCISSOR_TEST);
    }

    ensureGlResources() {
      if (this.glResources) return;
      const gl = this.gl;
      const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
        attribute vec2 aPosition;
        attribute vec2 aTexCoord;
        uniform vec2 uScale;
        varying vec2 vTexCoord;
        void main() {
          gl_Position = vec4(aPosition * uScale, 0.0, 1.0);
          vTexCoord = aTexCoord;
        }
      `);
      const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
        precision mediump float;
        uniform sampler2D uTexture;
        varying vec2 vTexCoord;
        void main() {
          gl_FragColor = texture2D(uTexture, vTexCoord);
        }
      `);
      const program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program) || "Could not link the WebXR video shader.");
      }

      const positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );

      const texCoordBuffer = gl.createBuffer();
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

      this.glResources = {
        program,
        positionBuffer,
        texCoordBuffer,
        texture,
        positionLocation: gl.getAttribLocation(program, "aPosition"),
        texCoordLocation: gl.getAttribLocation(program, "aTexCoord"),
        scaleLocation: gl.getUniformLocation(program, "uScale"),
        textureLocation: gl.getUniformLocation(program, "uTexture"),
      };
    }

    updateVideoTexture() {
      if (!this.video.videoWidth || !this.video.videoHeight || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
      }
      const gl = this.gl;
      const resources = this.glResources;
      try {
        gl.bindTexture(gl.TEXTURE_2D, resources.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
      } catch (error) {
        if (!this.textureWarningShown) {
          this.textureWarningShown = true;
          this.updateStatus("This video source cannot be used as a WebXR texture. Try the stable MP4 cache or a same-origin file.");
        }
      }
    }

    drawXrEye(eye, viewport) {
      const gl = this.gl;
      const resources = this.glResources;
      const crop = this.textureCrop(eye);
      const texCoords = new Float32Array([
        crop.u0, 0,
        crop.u1, 0,
        crop.u0, 1,
        crop.u1, 1,
      ]);
      const targetAspect = this.displayAspect();
      const viewportAspect = viewport.width / Math.max(1, viewport.height);
      let scaleX = 1;
      let scaleY = 1;
      if (targetAspect > viewportAspect) {
        scaleY = viewportAspect / targetAspect;
      } else {
        scaleX = targetAspect / viewportAspect;
      }
      const windowScale = clampNumber(this.settings.windowScale / 100, 0.6, 1.2, 1);
      const distanceScale = clampNumber(2 / this.settings.xrDistance, 0.5, 1.35, 1);
      scaleX *= windowScale * distanceScale;
      scaleY *= windowScale * distanceScale;
      this.drawXrWindowFrame(viewport, scaleX, scaleY);

      gl.useProgram(resources.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.positionBuffer);
      gl.enableVertexAttribArray(resources.positionLocation);
      gl.vertexAttribPointer(resources.positionLocation, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, resources.texCoordBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(resources.texCoordLocation);
      gl.vertexAttribPointer(resources.texCoordLocation, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(resources.scaleLocation, scaleX, scaleY);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, resources.texture);
      gl.uniform1i(resources.textureLocation, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    drawXrWindowFrame(viewport, scaleX, scaleY) {
      const gl = this.gl;
      const width = Math.min(viewport.width, Math.max(1, viewport.width * scaleX));
      const height = Math.min(viewport.height, Math.max(1, viewport.height * scaleY));
      const border = Math.max(8, Math.round(Math.min(viewport.width, viewport.height) * 0.012));
      const frameWidth = Math.min(viewport.width, width + border * 2);
      const frameHeight = Math.min(viewport.height, height + border * 2);
      const x = Math.round(viewport.x + (viewport.width - frameWidth) / 2);
      const y = Math.round(viewport.y + (viewport.height - frameHeight) / 2);
      gl.scissor(x, y, Math.round(frameWidth), Math.round(frameHeight));
      gl.clearColor(0.006, 0.008, 0.012, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const backdrop = this.backdropLevel();
      gl.clearColor(backdrop, backdrop, backdrop, 1);
      gl.scissor(viewport.x, viewport.y, viewport.width, viewport.height);
    }

    sourceRect(eye) {
      const width = this.video.videoWidth || 1;
      const height = this.video.videoHeight || 1;
      if (!this.isStereoLayout()) {
        return { x: 0, y: 0, width, height };
      }
      const halfWidth = width / 2;
      return {
        x: eye === "right" ? halfWidth : 0,
        y: 0,
        width: halfWidth,
        height,
      };
    }

    textureCrop(eye) {
      if (!this.isStereoLayout()) return { u0: 0, u1: 1 };
      return eye === "right"
        ? { u0: 0.5, u1: 1 }
        : { u0: 0, u1: 0.5 };
    }

    displayAspect() {
      const width = this.video.videoWidth || 16;
      const height = this.video.videoHeight || 9;
      if (this.settings.layout === "full-sbs") return (width / 2) / height;
      return width / height;
    }

    stageAspect() {
      if (this.isDesktop2dActive()) return this.displayAspect();
      const width = this.video.videoWidth || 16;
      const height = this.video.videoHeight || 9;
      return width / height;
    }

    backdropLevel() {
      return ((100 - this.settings.roomDim) / 100) * 0.08;
    }

    dispose() {
      this.stopDesktopLoop();
      if (this.xrSession) this.xrSession.end().catch(() => {});
      this.cleanups.forEach((cleanup) => cleanup());
      this.cleanups = [];
      if (this.stage.parentNode) {
        this.stage.parentNode.insertBefore(this.video, this.stage);
        this.stage.remove();
      }
      this.panel.remove();
      INSTANCE_BY_VIDEO.delete(this.video);
    }
  }

  function isKnownLayout(layout) {
    return layout === "mono" || layout === "half-sbs" || layout === "full-sbs";
  }

  function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function fitRect(width, height, aspect) {
    if (!aspect || !Number.isFinite(aspect)) return { x: 0, y: 0, width, height };
    const canvasAspect = width / Math.max(1, height);
    if (aspect > canvasAspect) {
      const fittedHeight = width / aspect;
      return {
        x: 0,
        y: (height - fittedHeight) / 2,
        width,
        height: fittedHeight,
      };
    }
    const fittedWidth = height * aspect;
    return {
      x: (width - fittedWidth) / 2,
      y: 0,
      width: fittedWidth,
      height,
    };
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
    const rounded = Math.floor(seconds);
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const remainingSeconds = rounded % 60;
    if (hours) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
    }
    return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
  }

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "Could not compile the WebXR video shader.");
    }
    return shader;
  }

  function attach(video, options = {}) {
    if (!video) return null;
    const existing = INSTANCE_BY_VIDEO.get(video);
    if (existing) return existing.updateOptions(options);
    const instance = new FilePipeXrVideoPlayer(video, options);
    INSTANCE_BY_VIDEO.set(video, instance);
    return instance;
  }

  function detach(video) {
    const existing = INSTANCE_BY_VIDEO.get(video);
    if (existing) existing.dispose();
  }

  window.FilePipeXrPlayer = {
    attach,
    detach,
  };
})();
