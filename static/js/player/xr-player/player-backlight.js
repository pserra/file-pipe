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
    },

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
    },

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
    },

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
    },

    setBacklightSegmentStatic(segmentMesh, color, opacity) {
      const material = segmentMesh?.material;
      if (!material) return;
      const staticMaterial = this.useBacklightStaticMaterial(segmentMesh);
      staticMaterial.color.setRGB(color.r, color.g, color.b);
      staticMaterial.opacity = opacity * backlightOpacityScale(segmentMesh.userData.backlightSegment || {});
    },

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
    },

    updateBacklightSegmentRenderState(segmentMesh, camera) {
      const material = segmentMesh?.material;
      if (!material?.uniforms?.sampleRegion) return;
      const sampleCamera = this.xrSession ? null : camera;
      const region = this.videoSampleRegionForSegment(segmentMesh.userData.backlightSegment || {}, sampleCamera);
      material.uniforms.sampleRegion.value.set(region.x0, region.y0, region.x1, region.y1);
    },

    useBacklightStaticMaterial(segmentMesh) {
      let material = segmentMesh.userData.staticMaterial;
      if (!material) {
        material = createBacklightStaticMaterial(this.backlightTexture);
        segmentMesh.userData.staticMaterial = material;
      }
      if (segmentMesh.material !== material) segmentMesh.material = material;
      return material;
    },

    useBacklightVideoMaterial(segmentMesh) {
      let material = segmentMesh.userData.videoMaterial;
      if (!material) {
        material = createBacklightSegmentMaterial(this.backlightTexture, this.videoTexture);
        segmentMesh.userData.videoMaterial = material;
      }
      if (segmentMesh.material !== material) segmentMesh.material = material;
      return material;
    },

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
    },

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
    },

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
    },

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
    },

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
    },

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
    },

    setBacklightSampleStatus(status) {
      this.backlightSampleStatus = status;
      this.updateBacklightDebugLabel();
    },

    updateBacklightDebugLabel() {
      if (!this.backlightDebug) return;
      this.backlightDebug.hidden = this.settings.backlightMode !== "video";
      if (!this.backlightDebug.hidden) {
        this.backlightDebug.textContent = `Sample ${this.backlightSampleStatus || "idle"}`;
      }
    }
  });
})();
