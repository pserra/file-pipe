(() => {
  const INSTANCE_BY_VIDEO = new WeakMap();
  const DEFAULT_INPUT_SIZE = 256;
  const DEFAULT_INFERENCE_SCALE = 0.33;
  const DEFAULT_MIN_INFERENCE_WIDTH = 384;
  const DEFAULT_MIN_INFERENCE_HEIGHT = 216;
  const DEFAULT_INFERENCE_INTERVAL_MS = 180;
  const DEFAULT_DEPTH_STRENGTH = 0.72;
  const DEFAULT_TEMPORAL_SMOOTHING = 0.55;
  const DEFAULT_CONVERGENCE = 0.42;
  const FIXED_MODEL_INPUT_SIZES = {
    "fastdepth-mobilenet-onnx": 224,
  };
  const LOCAL_PROCESSORS = new Set([
    "midas-small-onnx",
    "fastdepth-mobilenet-onnx",
    "depth-anything-v2-tiny-onnx",
    "depth-anything-v2-small-onnx",
    "webgpu-depth-anything-v2-small",
  ]);
  const DEFAULT_MODEL_URLS = {
    "midas-small-onnx": [
      "/static/models/depth/midas-small.onnx",
      "https://huggingface.co/unity/inference-engine-midas/resolve/16c4ad4a24c789e82afa983e549cf07846327b1b/model-small_opset19.onnx",
    ],
    "fastdepth-mobilenet-onnx": [
      "/static/models/depth/fastdepth-mobilenet.onnx",
    ],
    "depth-anything-v2-tiny-onnx": [
      "/static/models/depth/depth-anything-v2-tiny.onnx",
      "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_quantized.onnx",
    ],
    "depth-anything-v2-small-onnx": [
      "/static/models/depth/depth-anything-v2-small.onnx",
      "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx",
    ],
    "webgpu-depth-anything-v2-small": [
      "/static/models/depth/depth-anything-v2-small.onnx",
      "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx",
    ],
  };

  class FilePipeLocalDepth3dAdapter {
    constructor(video, options = {}) {
      this.video = video;
      this.options = {};
      this.processor = "midas-small-onnx";
      this.targetLayout = "full-sbs";
      this.depthStrength = DEFAULT_DEPTH_STRENGTH;
      this.temporalSmoothing = DEFAULT_TEMPORAL_SMOOTHING;
      this.inferenceIntervalMs = DEFAULT_INFERENCE_INTERVAL_MS;
      this.inputSize = DEFAULT_INPUT_SIZE;
      this.inferenceScale = DEFAULT_INFERENCE_SCALE;
      this.minInferenceWidth = DEFAULT_MIN_INFERENCE_WIDTH;
      this.minInferenceHeight = DEFAULT_MIN_INFERENCE_HEIGHT;
      this.convergence = DEFAULT_CONVERGENCE;
      this.invertDepth = false;
      this.standardOutputEnabled = false;
      this.status = "Local depth initializing.";
      this.modelStatus = "idle";
      this.session = null;
      this.sessionInputName = "";
      this.sessionOutputName = "";
      this.sessionInputLayout = "nchw";
      this.sessionInputWidth = DEFAULT_INPUT_SIZE;
      this.sessionInputHeight = DEFAULT_INPUT_SIZE;
      this.sessionInitializing = null;
      this.inferenceRunning = false;
      this.lastInferenceAt = 0;
      this.lastInferenceTimeMs = 0;
      this.depthReady = false;
      this.depthWidth = 1;
      this.depthHeight = 1;
      this.depthFloat = null;
      this.depthBytes = new Uint8Array([128]);
      this.depthTexture = null;
      this.placeholderDepthTexture = null;
      this.inputCanvas = document.createElement("canvas");
      this.inputContext = this.inputCanvas.getContext("2d", { willReadFrequently: true });
      this.standardContainer = null;
      this.standardCanvas = null;
      this.standardRenderer = null;
      this.standardScene = null;
      this.standardCamera = null;
      this.standardMaterial = null;
      this.standardVideoTexture = null;
      this.standardFrame = 0;
      this.standardControls = null;
      this.standardPlayButton = null;
      this.standardSeek = null;
      this.standardTime = null;
      this.standardMuteButton = null;
      this.standardStatus = null;
      this.threeMaterials = new Set();
      this.updateOptions(options);
      this.initializeDepthModel();
      this.setStandardOutputEnabled(this.standardOutputEnabled);
    }

    updateOptions(options = {}) {
      this.options = { ...this.options, ...options };
      const previousProcessor = this.processor;
      this.processor = normalizeLocalProcessor(options.processor || this.processor);
      this.targetLayout = normalizeStereoLayout(options.targetLayout || this.targetLayout);
      this.depthStrength = clampNumber(Number(options.depthStrength ?? options.playbackProfile?.depthStrength), 0, 2, this.depthStrength);
      this.temporalSmoothing = clampNumber(Number(options.temporalSmoothing ?? options.playbackProfile?.temporalSmoothing), 0, 0.92, this.temporalSmoothing);
      this.inferenceIntervalMs = clampNumber(Number(options.inferenceIntervalMs), 80, 1000, this.inferenceIntervalMs);
      this.inputSize = Math.round(clampNumber(Number(options.inputSize), 128, 512, this.inputSize));
      this.inferenceScale = clampNumber(Number(options.inferenceScale ?? options.playbackProfile?.inferenceScale), 0.1, 1, this.inferenceScale);
      this.minInferenceWidth = Math.round(clampNumber(Number(options.minInferenceWidth), 64, 2048, this.minInferenceWidth));
      this.minInferenceHeight = Math.round(clampNumber(Number(options.minInferenceHeight), 64, 2048, this.minInferenceHeight));
      this.convergence = clampNumber(Number(options.convergence), 0, 1, this.convergence);
      this.invertDepth = Boolean(options.invertDepth ?? this.invertDepth);
      this.standardOutputEnabled = options.standardOutput !== false;
      this.updateMaterialUniforms();
      this.updateStandardAspect();
      if (previousProcessor !== this.processor) {
        this.session = null;
        this.sessionInitializing = null;
        this.modelStatus = "idle";
        this.depthReady = false;
        this.status = "Local depth initializing.";
        this.initializeDepthModel();
      } else if (this.session) {
        this.configureSessionMetadata();
      }
      if (this.standardOutputEnabled !== Boolean(this.standardContainer)) {
        this.setStandardOutputEnabled(this.standardOutputEnabled);
      }
      return this;
    }

    isLocalProcessor() {
      return LOCAL_PROCESSORS.has(this.processor);
    }

    isEnabled() {
      return this.isLocalProcessor();
    }

    setStandardOutputEnabled(enabled) {
      const nextEnabled = Boolean(enabled && this.isEnabled());
      this.standardOutputEnabled = nextEnabled;
      if (nextEnabled) {
        this.ensureStandardOutput();
      } else {
        this.disposeStandardOutput();
      }
    }

    createThreeMaterial(videoTexture, options = {}) {
      const material = createStereoReprojectionMaterial({
        videoTexture,
        depthTexture: this.currentDepthTexture(),
        outputMode: options.outputMode || "eye",
        depthStrength: this.depthStrength,
        temporalSmoothing: this.temporalSmoothing,
        convergence: this.convergence,
        depthReady: this.depthReady,
        depthSize: [this.depthWidth, this.depthHeight],
      });
      this.threeMaterials.add(material);
      material.addEventListener?.("dispose", () => {
        this.threeMaterials.delete(material);
      });
      return material;
    }

    setThreeEye(eye) {
      const eyeSign = eye === "right" ? 1 : -1;
      for (const material of this.threeMaterials) {
        if (material?.uniforms?.eyeSign) material.uniforms.eyeSign.value = eyeSign;
      }
    }

    updateFrame(now = performance.now()) {
      if (!this.isEnabled()) return;
      this.scheduleInference(now);
      this.updateMaterialUniforms();
    }

    initializeDepthModel() {
      if (this.sessionInitializing || !this.isEnabled()) return this.sessionInitializing;
      this.modelStatus = "loading";
      this.status = "Loading browser depth model.";
      this.sessionInitializing = this.createOrtSession()
        .then((session) => {
          this.session = session;
          this.configureSessionMetadata();
          this.modelStatus = "ready";
          this.status = `Local ${this.processorLabel()} depth active.`;
          return session;
        })
        .catch((error) => {
          this.session = null;
          this.modelStatus = "fallback";
          this.status = `Local depth model unavailable; using shader depth fallback (${error.message || error}).`;
          return null;
        });
      return this.sessionInitializing;
    }

    async createOrtSession() {
      if (!window.ort?.InferenceSession) {
        throw new Error("ONNX Runtime Web did not load");
      }
      if (window.ort.env?.wasm && this.options.wasmPaths) {
        window.ort.env.wasm.wasmPaths = this.options.wasmPaths;
      }
      const urls = this.modelUrls();
      if (!urls.length) throw new Error(`No model URL configured for ${this.processor}`);
      const providerOptions = this.executionProviderOptions();
      let lastError = null;
      for (const url of urls) {
        for (const executionProviders of providerOptions) {
          try {
            return await window.ort.InferenceSession.create(url, {
              executionProviders,
              graphOptimizationLevel: "all",
            });
          } catch (error) {
            lastError = error;
          }
        }
      }
      throw lastError || new Error("Could not load local depth model");
    }

    executionProviderOptions() {
      const configured = Array.isArray(this.options.executionProviders)
        ? this.options.executionProviders.filter(Boolean)
        : null;
      const primary = configured?.length ? configured : (navigator.gpu ? ["webgpu", "wasm"] : ["wasm"]);
      if (primary.length === 1 && primary[0] === "wasm") return [primary];
      return [primary, ["wasm"]];
    }

    modelUrls() {
      const configured = this.options.modelUrls || window.FILE_PIPE_LOCAL_DEPTH3D_CONFIG?.modelUrls || {};
      const value = configured[this.processor] || configured.default || DEFAULT_MODEL_URLS[this.processor] || [];
      return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
    }

    configureSessionMetadata() {
      const inputName = this.session?.inputNames?.[0] || "";
      const outputName = this.session?.outputNames?.[0] || "";
      this.sessionInputName = inputName;
      this.sessionOutputName = outputName;
      const metadata = this.session?.inputMetadata?.[inputName] || {};
      const dimensions = Array.isArray(metadata.dimensions) ? metadata.dimensions : [];
      const target = this.targetInferenceSize();
      const fixedInputSize = FIXED_MODEL_INPUT_SIZES[this.processor] || 0;
      const dim = (index, fallback) => {
        const value = Number(dimensions[index]);
        return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
      };
      if (dim(3, 0) === 3) {
        this.sessionInputLayout = "nhwc";
        this.sessionInputHeight = fixedInputSize || dim(1, target.height);
        this.sessionInputWidth = fixedInputSize || dim(2, target.width);
      } else {
        this.sessionInputLayout = "nchw";
        this.sessionInputHeight = fixedInputSize || dim(2, target.height);
        this.sessionInputWidth = fixedInputSize || dim(3, target.width);
      }
      this.inputCanvas.width = this.sessionInputWidth;
      this.inputCanvas.height = this.sessionInputHeight;
    }

    targetInferenceSize() {
      const sourceWidth = Math.max(1, Number(this.video?.videoWidth || this.video?.clientWidth || 0));
      const sourceHeight = Math.max(1, Number(this.video?.videoHeight || this.video?.clientHeight || Math.round(sourceWidth * 9 / 16) || 0));
      return {
        width: Math.max(this.minInferenceWidth, Math.round(sourceWidth * this.inferenceScale)),
        height: Math.max(this.minInferenceHeight, Math.round(sourceHeight * this.inferenceScale)),
      };
    }

    scheduleInference(now = performance.now()) {
      if (!this.session && this.modelStatus === "idle") {
        this.initializeDepthModel();
      }
      if (!this.session || this.inferenceRunning || !this.inputContext) return;
      if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      if (now - this.lastInferenceAt < this.inferenceIntervalMs) return;
      this.lastInferenceAt = now;
      this.inferenceRunning = true;
      Promise.resolve()
        .then(() => this.runDepthInference())
        .catch((error) => {
          this.modelStatus = "fallback";
          this.status = `Local depth inference paused; using shader fallback (${error.message || error}).`;
        })
        .finally(() => {
          this.inferenceRunning = false;
        });
    }

    async runDepthInference() {
      const startedAt = performance.now();
      const tensor = this.createInputTensor();
      const feeds = { [this.sessionInputName]: tensor };
      const outputs = await this.session.run(feeds);
      const output = outputs[this.sessionOutputName] || outputs[Object.keys(outputs)[0]];
      if (!output?.data?.length) throw new Error("Depth model returned no output");
      this.updateDepthTexture(output);
      this.lastInferenceTimeMs = Math.round(performance.now() - startedAt);
      this.status = `Local ${this.processorLabel()} depth ${this.lastInferenceTimeMs}ms.`;
    }

    createInputTensor() {
      const width = this.sessionInputWidth;
      const height = this.sessionInputHeight;
      this.inputContext.drawImage(this.video, 0, 0, width, height);
      const pixels = this.inputContext.getImageData(0, 0, width, height).data;
      const data = new Float32Array(width * height * 3);
      const mean = [0.485, 0.456, 0.406];
      const std = [0.229, 0.224, 0.225];
      if (this.sessionInputLayout === "nhwc") {
        for (let pixel = 0; pixel < width * height; pixel += 1) {
          const rgba = pixel * 4;
          const base = pixel * 3;
          data[base] = (pixels[rgba] / 255 - mean[0]) / std[0];
          data[base + 1] = (pixels[rgba + 1] / 255 - mean[1]) / std[1];
          data[base + 2] = (pixels[rgba + 2] / 255 - mean[2]) / std[2];
        }
        return new window.ort.Tensor("float32", data, [1, height, width, 3]);
      }
      const planeSize = width * height;
      for (let pixel = 0; pixel < planeSize; pixel += 1) {
        const rgba = pixel * 4;
        data[pixel] = (pixels[rgba] / 255 - mean[0]) / std[0];
        data[planeSize + pixel] = (pixels[rgba + 1] / 255 - mean[1]) / std[1];
        data[planeSize * 2 + pixel] = (pixels[rgba + 2] / 255 - mean[2]) / std[2];
      }
      return new window.ort.Tensor("float32", data, [1, 3, height, width]);
    }

    updateDepthTexture(output) {
      const shape = Array.isArray(output.dims) ? output.dims : [];
      const width = outputWidth(shape, this.sessionInputWidth);
      const height = outputHeight(shape, this.sessionInputHeight);
      const size = width * height;
      if (!size) return;
      const normalized = normalizeDepth(output.data, size, this.invertDepth);
      if (!this.depthFloat || this.depthFloat.length !== size) {
        this.depthFloat = new Float32Array(size);
        this.depthBytes = new Uint8Array(size);
      }
      const smoothing = this.depthReady ? this.temporalSmoothing : 0;
      for (let index = 0; index < size; index += 1) {
        const value = smoothing > 0
          ? this.depthFloat[index] * smoothing + normalized[index] * (1 - smoothing)
          : normalized[index];
        this.depthFloat[index] = value;
        this.depthBytes[index] = Math.round(clampNumber(value, 0, 1, 0) * 255);
      }
      this.depthWidth = width;
      this.depthHeight = height;
      this.depthReady = true;
      this.ensureDepthTexture();
      this.depthTexture.needsUpdate = true;
      this.updateMaterialUniforms();
    }

    ensureDepthTexture() {
      if (!window.THREE) return null;
      if (this.depthTexture && this.depthTexture.image?.width === this.depthWidth && this.depthTexture.image?.height === this.depthHeight) {
        return this.depthTexture;
      }
      this.depthTexture?.dispose?.();
      const format = THREE.RedFormat || THREE.LuminanceFormat;
      this.depthTexture = new THREE.DataTexture(this.depthBytes, this.depthWidth, this.depthHeight, format, THREE.UnsignedByteType);
      this.depthTexture.minFilter = THREE.LinearFilter;
      this.depthTexture.magFilter = THREE.LinearFilter;
      this.depthTexture.wrapS = THREE.ClampToEdgeWrapping;
      this.depthTexture.wrapT = THREE.ClampToEdgeWrapping;
      this.depthTexture.generateMipmaps = false;
      return this.depthTexture;
    }

    currentDepthTexture() {
      return this.ensureDepthTexture() || this.ensurePlaceholderDepthTexture();
    }

    ensurePlaceholderDepthTexture() {
      if (!window.THREE) return null;
      if (this.placeholderDepthTexture) return this.placeholderDepthTexture;
      const format = THREE.RedFormat || THREE.LuminanceFormat;
      this.placeholderDepthTexture = new THREE.DataTexture(new Uint8Array([128]), 1, 1, format, THREE.UnsignedByteType);
      this.placeholderDepthTexture.minFilter = THREE.LinearFilter;
      this.placeholderDepthTexture.magFilter = THREE.LinearFilter;
      this.placeholderDepthTexture.needsUpdate = true;
      return this.placeholderDepthTexture;
    }

    updateMaterialUniforms() {
      const depthTexture = this.currentDepthTexture();
      for (const material of this.threeMaterials) {
        updateStereoMaterialUniforms(material, {
          depthTexture,
          depthReady: this.depthReady,
          depthStrength: this.depthStrength,
          temporalSmoothing: this.temporalSmoothing,
          convergence: this.convergence,
          depthSize: [this.depthWidth, this.depthHeight],
        });
      }
      updateStereoMaterialUniforms(this.standardMaterial, {
        depthTexture,
        depthReady: this.depthReady,
        depthStrength: this.depthStrength,
        temporalSmoothing: this.temporalSmoothing,
        convergence: this.convergence,
        depthSize: [this.depthWidth, this.depthHeight],
      });
      this.updateStandardStatus();
    }

    ensureStandardOutput() {
      if (!window.THREE || !this.video?.parentNode || this.standardContainer) return;
      const parent = this.video.parentNode;
      this.standardContainer = document.createElement("div");
      this.standardContainer.className = "fp-local-depth3d-standard";
      this.standardContainer.innerHTML = `
        <canvas class="fp-local-depth3d-canvas"></canvas>
        <div class="fp-local-depth3d-controls">
          <button class="btn btn-sm btn-light" type="button" data-action="play"><i class="bi bi-play-fill"></i></button>
          <input class="form-range" type="range" min="0" max="1000" step="1" value="0" data-role="seek">
          <span data-role="time">0:00 / 0:00</span>
          <button class="btn btn-sm btn-light" type="button" data-action="mute"><i class="bi bi-volume-up"></i></button>
        </div>
        <div class="fp-local-depth3d-status" data-role="status"></div>
      `;
      parent.insertBefore(this.standardContainer, this.video.nextSibling);
      this.video.classList.add("fp-local-depth3d-source-hidden");
      this.standardCanvas = this.standardContainer.querySelector("canvas");
      this.standardControls = this.standardContainer.querySelector(".fp-local-depth3d-controls");
      this.standardPlayButton = this.standardContainer.querySelector("[data-action='play']");
      this.standardSeek = this.standardContainer.querySelector("[data-role='seek']");
      this.standardTime = this.standardContainer.querySelector("[data-role='time']");
      this.standardMuteButton = this.standardContainer.querySelector("[data-action='mute']");
      this.standardStatus = this.standardContainer.querySelector("[data-role='status']");
      this.standardPlayButton.addEventListener("click", () => this.togglePlayback());
      this.standardMuteButton.addEventListener("click", () => {
        this.video.muted = !this.video.muted;
        this.updateStandardControls();
      });
      this.standardSeek.addEventListener("input", () => {
        const duration = Number(this.video.duration || 0);
        if (duration) this.video.currentTime = duration * (Number(this.standardSeek.value || 0) / 1000);
      });
      this.video.addEventListener("play", this.boundStandardControls ||= () => this.updateStandardControls());
      this.video.addEventListener("pause", this.boundStandardControls);
      this.video.addEventListener("volumechange", this.boundStandardControls);
      this.video.addEventListener("durationchange", this.boundStandardControls);
      this.initStandardRenderer();
      this.renderStandardFrame();
    }

    initStandardRenderer() {
      if (!this.standardCanvas || this.standardRenderer) return;
      this.standardRenderer = new THREE.WebGLRenderer({ canvas: this.standardCanvas, antialias: false, alpha: false });
      this.standardRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.standardScene = new THREE.Scene();
      this.standardCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
      this.standardCamera.position.set(0, 0, 1);
      this.standardVideoTexture = new THREE.VideoTexture(this.video);
      this.standardVideoTexture.colorSpace = THREE.SRGBColorSpace;
      this.standardVideoTexture.minFilter = THREE.LinearFilter;
      this.standardVideoTexture.magFilter = THREE.LinearFilter;
      this.standardVideoTexture.generateMipmaps = false;
      this.standardMaterial = this.createThreeMaterial(this.standardVideoTexture, { outputMode: "sbs" });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.standardMaterial);
      this.standardScene.add(mesh);
      this.updateStandardAspect();
    }

    renderStandardFrame() {
      if (!this.standardRenderer || !this.standardScene || !this.standardCamera || !this.standardCanvas) return;
      const now = performance.now();
      this.resizeStandardRenderer();
      if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.standardVideoTexture) {
        this.standardVideoTexture.needsUpdate = true;
      }
      this.updateFrame(now);
      this.standardRenderer.render(this.standardScene, this.standardCamera);
      this.updateStandardControls();
      this.standardFrame = requestAnimationFrame(() => this.renderStandardFrame());
    }

    resizeStandardRenderer() {
      const rect = this.standardCanvas.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      this.standardRenderer.setSize(width, height, false);
    }

    updateStandardAspect() {
      if (!this.standardContainer) return;
      const sourceWidth = Number(this.video.videoWidth || 16);
      const sourceHeight = Number(this.video.videoHeight || 9);
      const sourceAspect = sourceWidth > 0 && sourceHeight > 0 ? sourceWidth / sourceHeight : 16 / 9;
      const outputAspect = this.targetLayout === "full-sbs" ? sourceAspect * 2 : sourceAspect;
      this.standardContainer.style.setProperty("--fp-local-depth3d-aspect", String(outputAspect));
    }

    updateStandardControls() {
      if (!this.standardPlayButton || !this.standardSeek || !this.standardTime || !this.standardMuteButton) return;
      const playIcon = this.standardPlayButton.querySelector(".bi");
      const muteIcon = this.standardMuteButton.querySelector(".bi");
      if (playIcon) playIcon.className = this.video.paused ? "bi bi-play-fill" : "bi bi-pause-fill";
      if (muteIcon) muteIcon.className = this.video.muted || this.video.volume === 0 ? "bi bi-volume-mute" : "bi bi-volume-up";
      const duration = Number(this.video.duration || 0);
      const currentTime = Number(this.video.currentTime || 0);
      this.standardSeek.disabled = !duration;
      this.standardSeek.value = duration ? String(Math.round((currentTime / duration) * 1000)) : "0";
      this.standardTime.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    }

    updateStandardStatus() {
      if (!this.standardStatus) return;
      const layout = this.targetLayout === "half-sbs" ? "Half SBS" : "Full SBS";
      const inference = this.depthReady
        ? `${this.processorLabel()} ${this.sessionInputWidth}x${this.sessionInputHeight} ${this.lastInferenceTimeMs || 0}ms`
        : (this.modelStatus === "fallback" ? "shader fallback" : "loading depth model");
      this.standardStatus.textContent = `${layout} local 3D · depth ${Math.round(this.depthStrength * 100)}% · ${inference}`;
    }

    async togglePlayback() {
      if (this.video.paused) {
        await this.video.play().catch(() => {});
      } else {
        this.video.pause();
      }
      this.updateStandardControls();
    }

    disposeStandardOutput() {
      if (this.standardFrame) cancelAnimationFrame(this.standardFrame);
      this.standardFrame = 0;
      this.video.classList.remove("fp-local-depth3d-source-hidden");
      if (this.boundStandardControls) {
        this.video.removeEventListener("play", this.boundStandardControls);
        this.video.removeEventListener("pause", this.boundStandardControls);
        this.video.removeEventListener("volumechange", this.boundStandardControls);
        this.video.removeEventListener("durationchange", this.boundStandardControls);
      }
      this.standardMaterial?.dispose?.();
      this.standardVideoTexture?.dispose?.();
      this.standardRenderer?.dispose?.();
      this.standardContainer?.remove?.();
      this.standardContainer = null;
      this.standardCanvas = null;
      this.standardRenderer = null;
      this.standardScene = null;
      this.standardCamera = null;
      this.standardMaterial = null;
      this.standardVideoTexture = null;
      this.standardControls = null;
      this.standardPlayButton = null;
      this.standardSeek = null;
      this.standardTime = null;
      this.standardMuteButton = null;
      this.standardStatus = null;
    }

    processorLabel() {
      const labels = {
        "midas-small-onnx": "MiDaS Small ONNX",
        "fastdepth-mobilenet-onnx": "FastDepth MobileNet ONNX",
        "depth-anything-v2-tiny-onnx": "Depth Anything V2 Small Quantized ONNX",
        "depth-anything-v2-small-onnx": "Depth Anything V2 Small ONNX",
        "webgpu-depth-anything-v2-small": "Depth Anything V2 Small ONNX",
      };
      return labels[this.processor] || this.processor;
    }

    dispose() {
      this.disposeStandardOutput();
      for (const material of this.threeMaterials) material?.dispose?.();
      this.threeMaterials.clear();
      this.depthTexture?.dispose?.();
      this.placeholderDepthTexture?.dispose?.();
      this.depthTexture = null;
      this.placeholderDepthTexture = null;
      this.session = null;
      INSTANCE_BY_VIDEO.delete(this.video);
    }
  }

  function createStereoReprojectionMaterial(config) {
    return new THREE.ShaderMaterial({
      uniforms: {
        videoMap: { value: config.videoTexture },
        depthMap: { value: config.depthTexture },
        depthReady: { value: config.depthReady ? 1 : 0 },
        depthStrength: { value: config.depthStrength },
        convergence: { value: config.convergence },
        eyeSign: { value: -1 },
        outputMode: { value: config.outputMode === "sbs" ? 1 : 0 },
        depthSize: { value: new THREE.Vector2(config.depthSize?.[0] || 1, config.depthSize?.[1] || 1) },
      },
      vertexShader: `
        varying vec2 vUv;

        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D videoMap;
        uniform sampler2D depthMap;
        uniform float depthReady;
        uniform float depthStrength;
        uniform float convergence;
        uniform float eyeSign;
        uniform float outputMode;
        varying vec2 vUv;

        float luminanceDepth(vec2 uv) {
          vec3 color = texture2D(videoMap, uv).rgb;
          float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
          vec3 rightColor = texture2D(videoMap, clamp(uv + vec2(0.004, 0.0), vec2(0.0), vec2(1.0))).rgb;
          vec3 downColor = texture2D(videoMap, clamp(uv + vec2(0.0, 0.004), vec2(0.0), vec2(1.0))).rgb;
          float edge = length(color - rightColor) + length(color - downColor);
          return clamp(0.38 + luma * 0.34 + edge * 0.72, 0.0, 1.0);
        }

        vec3 reproject(vec2 eyeUv, float signValue) {
          float depthValue = depthReady > 0.5
            ? texture2D(depthMap, eyeUv).r
            : luminanceDepth(eyeUv);
          float fallbackScale = mix(0.18, 1.0, depthReady);
          float parallax = (depthValue - convergence) * depthStrength * 0.075 * fallbackScale;
          vec2 sourceUv = clamp(vec2(eyeUv.x + signValue * parallax, eyeUv.y), vec2(0.001), vec2(0.999));
          vec3 center = texture2D(videoMap, sourceUv).rgb;
          vec3 edgeA = texture2D(videoMap, clamp(sourceUv + vec2(signValue * 0.0025, 0.0), vec2(0.001), vec2(0.999))).rgb;
          vec3 edgeB = texture2D(videoMap, clamp(sourceUv + vec2(signValue * 0.0050, 0.0), vec2(0.001), vec2(0.999))).rgb;
          return mix(center, (center + edgeA + edgeB) / 3.0, smoothstep(0.82, 1.0, abs(sourceUv.x - 0.5) * 2.0));
        }

        void main() {
          vec2 eyeUv = vUv;
          float signValue = eyeSign;
          if (outputMode > 0.5) {
            float rightEye = step(0.5, vUv.x);
            eyeUv = vec2(fract(vUv.x * 2.0), vUv.y);
            signValue = mix(-1.0, 1.0, rightEye);
          }
          gl_FragColor = vec4(reproject(eyeUv, signValue), 1.0);
        }
      `,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
  }

  function updateStereoMaterialUniforms(material, values) {
    if (!material?.uniforms) return;
    if (values.depthTexture && material.uniforms.depthMap) material.uniforms.depthMap.value = values.depthTexture;
    if (material.uniforms.depthReady) material.uniforms.depthReady.value = values.depthReady ? 1 : 0;
    if (material.uniforms.depthStrength) material.uniforms.depthStrength.value = values.depthStrength;
    if (material.uniforms.convergence) material.uniforms.convergence.value = values.convergence;
    if (material.uniforms.depthSize && values.depthSize) {
      material.uniforms.depthSize.value.set(values.depthSize[0] || 1, values.depthSize[1] || 1);
    }
  }

  function normalizeDepth(data, size, invert = false) {
    const output = new Float32Array(size);
    let min = Infinity;
    let max = -Infinity;
    for (let index = 0; index < size && index < data.length; index += 1) {
      const value = Number(data[index]);
      if (!Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    const range = Math.max(1e-6, max - min);
    for (let index = 0; index < size; index += 1) {
      const value = Number(data[index]);
      const normalized = Number.isFinite(value) ? (value - min) / range : 0.5;
      output[index] = invert ? 1 - normalized : normalized;
    }
    return output;
  }

  function outputWidth(shape, fallback) {
    if (shape.length >= 4) {
      if (positiveDimension(shape[1], 0) === 1) return positiveDimension(shape[3], fallback);
      if (positiveDimension(shape[3], 0) === 1) return positiveDimension(shape[2], fallback);
      return positiveDimension(shape[3], fallback);
    }
    if (shape.length >= 3) return positiveDimension(shape[2], fallback);
    if (shape.length >= 2) return positiveDimension(shape[1], fallback);
    return fallback;
  }

  function outputHeight(shape, fallback) {
    if (shape.length >= 4) {
      if (positiveDimension(shape[1], 0) === 1) return positiveDimension(shape[2], fallback);
      if (positiveDimension(shape[3], 0) === 1) return positiveDimension(shape[1], fallback);
      return positiveDimension(shape[2], fallback);
    }
    if (shape.length >= 3) return positiveDimension(shape[1], fallback);
    if (shape.length >= 2) return positiveDimension(shape[0], fallback);
    return fallback;
  }

  function positiveDimension(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
  }

  function normalizeLocalProcessor(value) {
    const processor = String(value || "").trim().toLowerCase();
    const aliases = {
      "": "midas-small-onnx",
      local: "midas-small-onnx",
      webgpu: "webgpu-depth-anything-v2-small",
      "webgpu-small": "webgpu-depth-anything-v2-small",
      "webgpu-depth-anything-v2-small": "webgpu-depth-anything-v2-small",
      midas: "midas-small-onnx",
      "midas-small": "midas-small-onnx",
      "midas-small-onnx": "midas-small-onnx",
      fastdepth: "fastdepth-mobilenet-onnx",
      "fastdepth-mobilenet": "fastdepth-mobilenet-onnx",
      "fastdepth-mobilenet-onnx": "fastdepth-mobilenet-onnx",
      "depth-anything-v2-tiny": "depth-anything-v2-tiny-onnx",
      "depth-anything-v2-tiny-onnx": "depth-anything-v2-tiny-onnx",
      "depth-anything-v2-small": "depth-anything-v2-small-onnx",
      "depth-anything-v2-small-onnx": "depth-anything-v2-small-onnx",
    };
    return aliases[processor] || (LOCAL_PROCESSORS.has(processor) ? processor : "midas-small-onnx");
  }

  function normalizeStereoLayout(value) {
    return String(value || "").toLowerCase() === "half-sbs" ? "half-sbs" : "full-sbs";
  }

  function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    return `${minutes}:${String(total % 60).padStart(2, "0")}`;
  }

  window.FilePipeLocalDepth3dAdapter = {
    attach(video, options = {}) {
      if (!video) return null;
      const existing = INSTANCE_BY_VIDEO.get(video);
      if (existing) return existing.updateOptions(options);
      const instance = new FilePipeLocalDepth3dAdapter(video, options);
      INSTANCE_BY_VIDEO.set(video, instance);
      return instance;
    },
    isLocalProcessor(processor) {
      return LOCAL_PROCESSORS.has(normalizeLocalProcessor(processor));
    },
  };
})();
