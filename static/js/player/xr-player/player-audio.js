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
    },

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
    },

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
    },

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
    },

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
    },

    enableAudioPassthrough() {
      const graph = this.spatialAudioGraph || AUDIO_GRAPH_BY_VIDEO.get(this.video);
      if (!graph) return;
      this.disconnectSpatialAudioGraph(graph);
      this.connectAudioPassthrough(graph);
      this.spatialAudioStatus = "Spatial audio off.";
      this.syncOverlayControls();
      this.updateInlineStatus();
    },

    connectAudioPassthrough(graph) {
      if (!graph) return;
      safeDisconnect(graph.source);
      safeDisconnect(graph.passthroughGain);
      graph.source.connect(graph.passthroughGain);
      graph.passthroughGain.connect(graph.context.destination);
      graph.mode = "passthrough";
      this.updateSpatialAudioVolume();
    },

    updateSpatialAudioVolume() {
      const graph = this.spatialAudioGraph || AUDIO_GRAPH_BY_VIDEO.get(this.video);
      if (!graph) return;
      const gain = this.video.muted ? 0 : clampNumber(Number(this.video.volume), 0, 1, 1);
      setAudioParamValue(graph.masterGain?.gain, gain, graph.context);
      setAudioParamValue(graph.passthroughGain?.gain, gain, graph.context);
    },

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
    },

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
    },

    audioListenerCamera() {
      if (this.renderer?.xr?.isPresenting) {
        const xrCamera = this.renderer.xr.getCamera(this.camera);
        if (xrCamera) return xrCamera;
      }
      return this.camera;
    },

    spatialAudioMediaInfo() {
      return this.mediaInfo();
    },

    mediaInfo() {
      try {
        return typeof this.options.mediaInfo === "function" ? this.options.mediaInfo() : this.options.mediaInfo;
      } catch (error) {
        return null;
      }
    },

    spatialAudioChannelCount() {
      const mediaInfo = this.spatialAudioMediaInfo() || {};
      const defaultAudio = mediaInfo.defaultAudio || {};
      const count = Number(mediaInfo.audioChannels || defaultAudio.channels || 0);
      if (Number.isFinite(count) && count > 0) return clampNumber(Math.round(count), 1, 8, 2);
      return 8;
    },

    spatialAudioChannelLabels(channelCount = this.spatialAudioChannelCount()) {
      const mediaInfo = this.spatialAudioMediaInfo() || {};
      const labels = Array.isArray(mediaInfo.audioChannelLabels) ? mediaInfo.audioChannelLabels : [];
      if (labels.length) return labels.slice(0, channelCount).map((label) => normalizeSpeakerChannel(label));
      return DEFAULT_AUDIO_CHANNEL_LABELS.slice(0, channelCount);
    },

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
    },

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
    },

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
    },

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
    },

    spatialAudioStatusText(channelCount, speakers) {
      const mediaInfo = this.spatialAudioMediaInfo() || {};
      const layout = mediaInfo.audioChannelLayout || `${channelCount}ch`;
      const source = mediaInfo.spatialAudioCandidate || channelCount > 2 ? layout : `${layout}; stereo/mono source`;
      const themed = speakers.some((speaker) => speaker.themeProvided);
      const mode = this.inTheater ? "XR spatial audio" : "Headphone spatial audio";
      return `${mode} on: ${source}${themed ? "; theme speaker layout" : "; default speaker layout"}.`;
    }
  });
})();
