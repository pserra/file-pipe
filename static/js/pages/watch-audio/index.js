const AUDIO_OUTPUT_STORAGE_PREFIX = "filePipeWatchAudioOutput:";
const WATCH_AUDIO_RECONNECT_BASE_DELAY_MS = 1500;
const WATCH_AUDIO_RECONNECT_MAX_DELAY_MS = 30000;
const WATCH_AUDIO_SYNC_BUFFER_SECONDS = 2;
const WATCH_AUDIO_SYNC_RELAX_AFTER_MS = 2500;
const WATCH_AUDIO_SYNC_FORCE_AFTER_MS = 6000;
const WATCH_AUDIO_SYNC_READY_POLL_MS = 200;
const WATCH_AUDIO_MAX_SYNC_LATENCY_MS = 1500;
const WATCH_AUDIO_SEEK_THRESHOLD_SECONDS = 0.12;
const DEFAULT_AUDIO_LABELS = ["L", "R", "C", "LFE", "SL", "SR", "BL", "BR"];

document.addEventListener("alpine:init", () => {
  Alpine.data("watchAudioOutput", (roomId) => ({
    roomId,
    key: null,
    keyText: "",
    targetPeerId: "host",
    targetLabel: "Host",
    channelLabel: "LFE",
    participantId: "",
    metadata: null,
    selectedPlaybackMode: "",
    sourceVersion: 0,
    peer: null,
    channel: null,
    channelReady: false,
    channelMessageQueue: Promise.resolve(),
    mediaCapabilities: detectMediaPlaybackCapabilities(),
    pendingRangeBytes: {},
    pendingHlsBytes: {},
    pendingSync: null,
    pendingSegmentSync: null,
    hostClockOffsetMs: 0,
    hostClockRttMs: 0,
    hostClockSynced: false,
    reconnecting: false,
    reconnectRetryTimer: null,
    reconnectRetryDelayMs: WATCH_AUDIO_RECONNECT_BASE_DELAY_MS,
    hls: null,
    videoUrl: "",
    outputReady: false,
    outputStarted: false,
    starting: false,
    audioGraph: null,
    lastSyncLabel: "",
    status: "Loading room metadata...",
    error: "",
    castStatus: "",
    remotePlaybackState: "",
    volume: 1,
    outputDelayMs: 0,

    initAudioOutput() {
      this.loadLinkSettings();
      this.loadStoredSettings();
      navigator.serviceWorker?.addEventListener("message", (event) => this.handleWorkerMessage(event));
      window.addEventListener("online", () => this.reconnectToHost({ preserveOutput: this.outputStarted || Boolean(this.videoUrl) }));
      this.loadRoom().then(() => {
        setTimeout(() => this.startOutput(), 250);
      });
      setTimeout(() => this.initializeCastControls(), 0);
    },

    storageKey() {
      return `${AUDIO_OUTPUT_STORAGE_PREFIX}${this.roomId}:${this.targetPeerId}:${this.channelLabel}`;
    },

    loadStoredSettings() {
      try {
        const stored = JSON.parse(localStorage.getItem(this.storageKey()) || "{}");
        const volume = Number(stored.volume);
        const delay = Number(stored.outputDelayMs);
        if (Number.isFinite(volume)) this.volume = clamp(volume, 0, 1);
        if (Number.isFinite(delay)) this.outputDelayMs = clamp(delay, -750, 750);
      } catch {
        // Ignore unavailable storage.
      }
    },

    saveStoredSettings() {
      try {
        localStorage.setItem(this.storageKey(), JSON.stringify({
          volume: this.volume,
          outputDelayMs: this.outputDelayMs,
        }));
      } catch {
        // Ignore unavailable storage.
      }
    },

    loadLinkSettings() {
      const params = new URLSearchParams(window.location.hash.slice(1));
      this.keyText = params.get("key") || "";
      this.targetPeerId = params.get("target") || "host";
      this.channelLabel = normalizeAudioChannel(params.get("channel") || "LFE") || "LFE";
      this.targetLabel = params.get("targetName") || (this.targetPeerId === "host" ? "Host" : "Selected participant");
      const delay = Number(params.get("delayMs"));
      if (Number.isFinite(delay)) this.outputDelayMs = clamp(delay, -750, 750);
    },

    async appJson(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.headers || {}),
        },
      });
      const contentType = response.headers.get("Content-Type") || "";
      const payload = contentType.includes("application/json")
        ? await response.json().catch(() => ({}))
        : {};
      if (!response.ok) {
        const error = new Error(payload.error || `Request failed with ${response.status}.`);
        error.status = response.status;
        error.path = path;
        throw error;
      }
      return payload;
    },

    async loadRoom() {
      try {
        if (!this.keyText) throw new Error("This audio output link is missing its room key.");
        this.key = await crypto.subtle.importKey(
          "raw",
          base64UrlDecode(this.keyText),
          { name: "AES-GCM" },
          false,
          ["decrypt"],
        );
        const room = await this.appJson(`/api/watch/rooms/${this.roomId}`);
        if (!room.metadata) {
          this.status = "Waiting for host metadata...";
          return;
        }
        const metadataBytes = await this.decryptPayload(room.metadata.iv, base64UrlDecode(room.metadata.ciphertext));
        this.metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
        this.sourceVersion = Number(this.metadata.sourceVersion || 0);
        this.selectedPlaybackMode = this.defaultPlaybackMode();
        this.status = "Room metadata loaded. Connecting to host...";
      } catch (error) {
        this.error = this.audioOutputErrorMessage(error);
        this.status = "";
      }
    },

    defaultPlaybackMode(metadata = this.metadata) {
      if (!metadata) return "range";
      const modes = metadata.availableModes || {};
      const rangeProgress = modes.range?.progressiveTranscode || metadata.progressiveTranscode;
      if (modes.range && !(rangeProgress && !rangeProgress.complete)) return "range";
      if (modes.hls) return "hls";
      if (metadata.streamMode === "hls" || String(metadata.type || "").includes("mpegurl")) return "hls";
      return "range";
    },

    playbackMetadata() {
      const metadata = this.metadata || {};
      const mode = this.selectedPlaybackMode || this.defaultPlaybackMode(metadata);
      const modes = metadata.availableModes || {};
      if (mode === "hls" && modes.hls) {
        return {
          ...metadata,
          ...modes.hls,
          name: metadata.name,
          md5: "",
          checksumKind: "hls-segments",
          streamMode: "hls",
          hls: modes.hls.hls || metadata.hls,
          progressiveTranscode: null,
          availableModes: modes,
          sourceVersion: metadata.sourceVersion,
        };
      }
      if (mode === "range" && modes.range) {
        return {
          ...metadata,
          ...modes.range,
          name: metadata.name,
          streamMode: "range",
          hls: null,
          progressiveTranscode: modes.range.progressiveTranscode || metadata.progressiveTranscode,
          availableModes: modes,
          sourceVersion: metadata.sourceVersion,
        };
      }
      return metadata;
    },

    async startOutput() {
      this.outputStarted = true;
      this.starting = true;
      this.error = "";
      try {
        if (!this.metadata) await this.loadRoom();
        if (!this.metadata) return;
        if (!this.participantId) await this.joinRoom();
        if (!this.channelReady) {
          this.status = "Waiting for host peer connection...";
          return;
        }
        await this.requestMedia();
      } catch (error) {
        this.error = this.audioOutputErrorMessage(error);
      } finally {
        this.starting = false;
      }
    },

    stopOutput() {
      const video = this.mediaElement();
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      this.teardownHls();
      this.disconnectAudioGraph(false);
      if (this.videoUrl && this.videoUrl.startsWith("blob:")) URL.revokeObjectURL(this.videoUrl);
      this.videoUrl = "";
      this.outputReady = false;
      this.status = "Audio output stopped.";
    },

    initializeCastControls() {
      const video = this.mediaElement();
      if (!video) return;
      if (video.remote?.watchAvailability) {
        video.remote.watchAvailability((available) => {
          this.remotePlaybackState = available ? "available" : "unavailable";
        }).catch(() => {
          this.remotePlaybackState = "";
        });
      }
      if (video.remote) {
        video.remote.onconnect = () => {
          this.castStatus = "Remote playback connected. If the device is silent, use this page directly on the audio device instead.";
        };
        video.remote.ondisconnect = () => {
          this.castStatus = "Remote playback disconnected.";
        };
        video.remote.onconnecting = () => {
          this.castStatus = "Connecting to remote playback device...";
        };
      }
    },

    async castOutput() {
      const video = this.mediaElement();
      if (!video) return;
      this.castStatus = "";
      try {
        if (!this.outputReady && !this.videoUrl) await this.startOutput();
        if (video.remote?.prompt) {
          this.castStatus = "Opening the browser's remote playback picker. Cast devices may not be able to fetch this encrypted peer stream directly.";
          await video.remote.prompt();
          return;
        }
        if (video.webkitShowPlaybackTargetPicker) {
          this.castStatus = "Opening the AirPlay picker. AirPlay may play the media element rather than the local LFE-only Web Audio mix.";
          video.webkitShowPlaybackTargetPicker();
          return;
        }
        this.castStatus = "This browser does not expose a page-level Cast picker for this stream. Use the browser's Cast tab option, or open this audio-output link directly on the browser connected to the audio device.";
      } catch (error) {
        this.castStatus = error?.name === "NotFoundError"
          ? "No remote playback device was selected."
          : `Could not start remote playback: ${error.message || "unsupported by this browser."}`;
      }
    },

    async joinRoom() {
      const response = await fetch(`/api/watch/rooms/${this.roomId}/participants`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${this.channelLabel} output for ${this.targetLabel}`.slice(0, 80),
          role: "audio-output",
          audioOutput: {
            channel: this.channelLabel,
            targetPeerId: this.targetPeerId,
            targetLabel: this.targetLabel,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || `Could not join room: ${response.status}`);
        error.status = response.status;
        error.path = `/api/watch/rooms/${this.roomId}/participants`;
        throw error;
      }
      this.participantId = payload.participantId;
      this.status = "Waiting for host connection offer...";
      await this.waitForOfferAndAnswer();
    },

    async waitForOfferAndAnswer(maxAttempts = 300) {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        let participant;
        try {
          participant = await this.appJson(`/api/watch/rooms/${this.roomId}/participants/${this.participantId}`);
        } catch (error) {
          if (error.status === 404) {
            this.participantId = "";
            this.status = "Audio output registration expired. Rejoining the room...";
            await this.joinRoom();
            return;
          }
          throw error;
        }
        if (participant.kicked) throw new Error("The host removed this audio output from the room.");
        if (participant.offer) {
          await this.answerOffer(participant.offer);
          return;
        }
        await sleep(1000);
      }
      throw new Error("The host did not create a peer connection offer.");
    },

    async answerOffer(offer) {
      if (this.peer) this.peer.close();
      this.peer = new RTCPeerConnection(P2P_CONFIG);
      this.peer.ondatachannel = (event) => {
        this.channel = event.channel;
        this.channel.binaryType = "arraybuffer";
        this.channel.onopen = () => {
          this.channelReady = true;
          this.reconnectRetryDelayMs = WATCH_AUDIO_RECONNECT_BASE_DELAY_MS;
          this.clearReconnectRetry();
          this.status = "Connected to host. Preparing audio output...";
          this.publishMediaCapabilities("channel-open");
          if (this.outputStarted) this.requestMedia();
        };
        this.channel.onmessage = (eventMessage) => this.queueChannelMessage(eventMessage);
        this.channel.onclose = () => {
          this.channelReady = false;
          this.status = "Host disconnected. Playback will resume when the host reconnects.";
          this.scheduleReconnectToHost({ preserveOutput: this.outputStarted || Boolean(this.videoUrl) });
        };
      };
      this.peer.onconnectionstatechange = () => {
        if (["failed", "disconnected"].includes(this.peer.connectionState)) {
          this.channelReady = false;
          this.scheduleReconnectToHost({ preserveOutput: this.outputStarted || Boolean(this.videoUrl) });
        }
      };
      await this.peer.setRemoteDescription(offer);
      const answer = await this.peer.createAnswer();
      await this.peer.setLocalDescription(answer);
      await waitForIceGatheringComplete(this.peer);
      const response = await fetch(`/api/watch/rooms/${this.roomId}/participants/${this.participantId}/answer`, {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ answer: this.peer.localDescription }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Could not publish answer: ${response.status}`);
      }
      this.status = "Answer sent. Waiting for peer connection.";
    },

    audioOutputErrorMessage(error) {
      if (error?.status === 404) {
        return "This audio output link points to a watch room that is no longer active on this File Pipe server. Create a fresh LFE output link from the active host or participant page and open that new link on the audio device.";
      }
      return error?.message || "Audio output failed.";
    },

    async reconnectToHost(options = {}) {
      if (!this.participantId || this.reconnecting) return;
      this.clearReconnectRetry();
      this.reconnecting = true;
      try {
        if (this.channel) this.channel.close();
        if (this.peer) this.peer.close();
        this.channel = null;
        this.peer = null;
        this.channelReady = false;
        const response = await fetch(`/api/watch/rooms/${this.roomId}/participants/${this.participantId}/reconnect`, {
          method: "POST",
          headers: { Accept: "application/json" },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Reconnect failed: ${response.status}`);
        this.status = "Reconnect requested. Waiting for host offer...";
        await this.waitForOfferAndAnswer(45);
        if (options.preserveOutput) setTimeout(() => this.startOutput(), 250);
      } catch (error) {
        this.status = `Waiting for host to return. Last reconnect attempt: ${error.message}`;
        this.scheduleReconnectToHost(options);
      } finally {
        this.reconnecting = false;
      }
    },

    scheduleReconnectToHost(options = {}) {
      if (!this.participantId || this.reconnectRetryTimer) return;
      const delay = this.reconnectRetryDelayMs || WATCH_AUDIO_RECONNECT_BASE_DELAY_MS;
      this.reconnectRetryDelayMs = Math.min(delay * 1.6, WATCH_AUDIO_RECONNECT_MAX_DELAY_MS);
      this.reconnectRetryTimer = setTimeout(() => {
        this.reconnectRetryTimer = null;
        this.reconnectToHost(options);
      }, delay);
    },

    clearReconnectRetry() {
      if (!this.reconnectRetryTimer) return;
      clearTimeout(this.reconnectRetryTimer);
      this.reconnectRetryTimer = null;
    },

    publishMediaCapabilities(reason = "") {
      if (!this.channel || this.channel.readyState !== "open") return;
      sendChannelJson(this.channel, {
        type: "media-capabilities",
        role: "audio-output",
        reason,
        capabilities: this.mediaCapabilities,
      });
    },

    async requestMedia() {
      if (!this.channel || this.channel.readyState !== "open") {
        this.status = "Waiting for host data channel.";
        return;
      }
      const playbackMetadata = this.playbackMetadata();
      const hlsStream = isHlsPlaybackMetadata(playbackMetadata);
      const linearProgressive = !hlsStream && playbackMetadata?.progressiveTranscode && !playbackMetadata.progressiveTranscode.complete;
      this.pendingRangeBytes = {};
      this.pendingHlsBytes = {};
      this.status = hlsStream
        ? "Preparing encrypted live audio stream..."
        : linearProgressive
          ? "Preparing linear audio output while Stable MP4 continues transcoding..."
          : "Preparing encrypted range audio stream...";
      await this.registerServiceWorker();
      navigator.serviceWorker.controller.postMessage({
        type: "watch-metadata",
        sessionId: this.roomId,
        metadata: plainData(playbackMetadata),
      });
      const fileName = hlsStream ? "playlist.m3u8" : encodeURIComponent(playbackMetadata.name || "video");
      const sourceVersion = encodeURIComponent(String(playbackMetadata.sourceVersion || this.sourceVersion || 0));
      this.videoUrl = `/watch-media/${this.roomId}/${fileName}?mode=${hlsStream ? "hls" : "range"}&v=${sourceVersion}&audioOutput=1`;
      const video = this.mediaElement();
      if (!video) throw new Error("Audio media element is unavailable.");
      video.addEventListener("loadedmetadata", () => this.prepareOutputMedia(), { once: true });
      video.addEventListener("canplay", () => this.checkPendingSegmentReadiness());
      video.addEventListener("progress", () => this.checkPendingSegmentReadiness());
      if (hlsStream) {
        if (!this.attachHlsPlayer(video)) return;
      } else {
        video.src = this.videoUrl;
        video.load();
      }
      this.outputReady = true;
      this.notifyOutputReady();
      this.applyPendingPlaybackState(250);
    },

    attachHlsPlayer(video) {
      this.teardownHls();
      if (window.Hls?.isSupported?.()) {
        this.hls = new Hls(hlsBufferConfig());
        this.hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data?.fatal) this.error = data.details || "The live audio stream failed.";
        });
        this.hls.loadSource(this.videoUrl);
        this.hls.attachMedia(video);
        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
          this.prepareOutputMedia();
          this.applyPendingPlaybackState(100);
        });
        return true;
      }
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = this.videoUrl;
        video.load();
        return true;
      }
      this.error = "This browser cannot play HLS live streams.";
      return false;
    },

    teardownHls() {
      if (this.hls) this.hls.destroy();
      this.hls = null;
    },

    async prepareOutputMedia() {
      const video = this.mediaElement();
      if (!video) return;
      video.muted = false;
      video.volume = 1;
      await this.ensureAudioGraph();
      this.applyOutputVolume();
      await this.audioGraph?.context?.resume?.().catch(() => {});
      video.play().catch(() => {
        this.status = "Audio output is ready. Press Start output if browser autoplay was blocked.";
      });
      this.status = `${this.channelLabel} output ready. Following ${this.targetLabel}.`;
      this.notifyOutputReady();
    },

    mediaElement() {
      return document.getElementById("watch-audio-output-media");
    },

    async ensureAudioGraph() {
      const video = this.mediaElement();
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!video || !AudioContextClass) throw new Error("Web Audio is unavailable in this browser.");
      if (!this.audioGraph) {
        const context = new AudioContextClass();
        const source = context.createMediaElementSource(video);
        source.channelInterpretation = "discrete";
        this.audioGraph = { context, source, splitter: null, gain: null, filter: null };
      }
      this.disconnectAudioGraph(false);
      const graph = this.audioGraph;
      const channelCount = this.audioChannelCount();
      const channelIndex = this.outputChannelIndex(channelCount);
      graph.splitter = graph.context.createChannelSplitter(channelCount);
      graph.splitter.channelInterpretation = "discrete";
      graph.gain = graph.context.createGain();
      graph.source.connect(graph.splitter);
      graph.splitter.connect(graph.gain, channelIndex);
      if (this.channelLabel === "LFE") {
        graph.filter = graph.context.createBiquadFilter();
        graph.filter.type = "lowpass";
        graph.filter.frequency.value = 120;
        graph.gain.connect(graph.filter);
        graph.filter.connect(graph.context.destination);
      } else {
        graph.gain.connect(graph.context.destination);
      }
    },

    disconnectAudioGraph(clear = true) {
      const graph = this.audioGraph;
      if (!graph) return;
      safeDisconnect(graph.source);
      safeDisconnect(graph.splitter);
      safeDisconnect(graph.gain);
      safeDisconnect(graph.filter);
      graph.splitter = null;
      graph.gain = null;
      graph.filter = null;
      if (clear && graph.context?.state !== "closed") {
        graph.context.close().catch(() => {});
        this.audioGraph = null;
      }
    },

    applyOutputVolume() {
      this.saveStoredSettings();
      const graph = this.audioGraph;
      if (!graph?.gain) return;
      graph.gain.gain.value = clamp(Number(this.volume), 0, 1);
    },

    applyOutputDelay() {
      this.outputDelayMs = clamp(Number(this.outputDelayMs || 0), -750, 750);
      this.saveStoredSettings();
      this.applyPendingPlaybackState();
    },

    audioChannelCount() {
      const mediaInfo = this.playbackMetadata()?.mediaInfo || this.metadata?.mediaInfo || {};
      const count = Number(mediaInfo.audioChannels || mediaInfo.defaultAudio?.channels || 0);
      if (Number.isFinite(count) && count > 0) return Math.max(1, Math.min(8, Math.round(count)));
      return 8;
    },

    audioChannelLabels() {
      const mediaInfo = this.playbackMetadata()?.mediaInfo || this.metadata?.mediaInfo || {};
      const labels = Array.isArray(mediaInfo.audioChannelLabels) ? mediaInfo.audioChannelLabels : [];
      return labels.length ? labels.map((label) => normalizeAudioChannel(label)) : DEFAULT_AUDIO_LABELS.slice(0, this.audioChannelCount());
    },

    outputChannelIndex(channelCount = this.audioChannelCount()) {
      const labels = this.audioChannelLabels();
      const index = labels.findIndex((label) => normalizeAudioChannel(label) === this.channelLabel);
      if (index >= 0 && index < channelCount) return index;
      if (this.channelLabel === "LFE" && channelCount >= 4) return 3;
      return Math.max(0, Math.min(channelCount - 1, 0));
    },

    audioLayoutLabel() {
      const metadata = this.playbackMetadata() || this.metadata || {};
      const mediaInfo = metadata.mediaInfo || {};
      const layout = mediaInfo.audioChannelLayout || `${this.audioChannelCount()}ch`;
      return `${layout} (${this.audioChannelLabels().join(", ") || "unknown channels"})`;
    },

    async registerServiceWorker() {
      try {
        const registration = await navigator.serviceWorker.register("/bigscreen-sw.js?v=12", { scope: "/" });
        await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await new Promise((resolve) => {
            navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
            registration.active?.postMessage({ type: "claim" });
            setTimeout(resolve, 4000);
          });
        }
        if (!navigator.serviceWorker.controller) {
          window.location.reload();
          throw new Error("Reloading once so the range-streaming service worker can control this page.");
        }
      } catch (error) {
        throw new Error(serviceWorkerSetupMessage(error));
      }
    },

    handleWorkerMessage(event) {
      const message = event.data || {};
      if (message.mediaKind && message.mediaKind !== "watch") return;
      if (message.type === "range-request") {
        this.sendRangeRequest(message);
      } else if (message.type === "hls-segment-request") {
        this.sendHlsSegmentRequest(message);
      } else if (message.type === "range-cancel" && this.channel?.readyState === "open") {
        sendChannelJson(this.channel, { type: "range-cancel", requestId: message.requestId });
      }
    },

    sendRangeRequest(message) {
      if (!this.channel || this.channel.readyState !== "open") {
        this.postWorkerMessage({ type: "range-error", requestId: message.requestId, error: "Host data channel is not connected." });
        return;
      }
      this.pendingRangeBytes[message.requestId] = 0;
      sendChannelJson(this.channel, {
        type: "range-request",
        requestId: message.requestId,
        start: message.start,
        end: message.end,
        sourceVersion: this.sourceVersion,
        prefetch: Boolean(message.prefetch),
      });
    },

    sendHlsSegmentRequest(message) {
      if (!this.channel || this.channel.readyState !== "open") {
        this.postWorkerMessage({ type: "range-error", requestId: message.requestId, error: "Host data channel is not connected." });
        return;
      }
      this.pendingHlsBytes[message.requestId] = 0;
      sendChannelJson(this.channel, {
        type: "hls-segment-request",
        requestId: message.requestId,
        segmentIndex: message.segmentIndex,
        sourceVersion: this.sourceVersion,
        prefetch: Boolean(message.prefetch),
      });
    },

    postWorkerMessage(message, transfer = []) {
      navigator.serviceWorker?.controller?.postMessage(message, transfer);
    },

    async handleChannelMessage(event) {
      try {
        const message = await readChannelMessage(event.data);
        if (message.type === "hls-chunk" || message.type === "range-chunk") {
          if (message.sourceVersion && Number(message.sourceVersion) !== this.sourceVersion) return;
          const ciphertext = message.binary || base64UrlDecode(message.data || "");
          const plaintext = exactArrayBuffer(await this.decryptPayload(message.iv, ciphertext));
          const byteMap = message.type === "hls-chunk" ? this.pendingHlsBytes : this.pendingRangeBytes;
          byteMap[message.requestId] = (byteMap[message.requestId] || 0) + plaintext.byteLength;
          const workerBytes = plaintext.slice(0);
          this.postWorkerMessage({ type: "range-chunk", requestId: message.requestId, bytes: workerBytes }, [workerBytes]);
          return;
        }
        if (message.type === "hls-done" || message.type === "range-done") {
          if (message.sourceVersion && Number(message.sourceVersion) !== this.sourceVersion) return;
          delete this.pendingHlsBytes[message.requestId];
          delete this.pendingRangeBytes[message.requestId];
          this.postWorkerMessage({ type: "range-done", requestId: message.requestId });
          if (this.pendingSegmentSync) this.checkPendingSegmentReadiness();
          return;
        }
        if (message.type === "hls-error" || message.type === "range-error") {
          this.postWorkerMessage({
            type: "range-error",
            requestId: message.requestId,
            error: message.error || "Host media request failed.",
          });
          return;
        }
        if (message.type === "sync") {
          this.pendingSync = message;
          this.lastSyncLabel = new Date().toLocaleTimeString();
          if (this.videoUrl) this.applyPendingPlaybackState();
          return;
        }
        if (message.type === "sync-hold") {
          this.applySyncHold(message);
          return;
        }
        if (message.type === "resume-at") {
          this.applyResumeAt(message);
          return;
        }
        if (message.type === "clock-ping") {
          this.handleClockPing(message);
          return;
        }
        if (message.type === "clock-sync") {
          this.hostClockOffsetMs = Number(message.viewerClockOffsetMs || 0);
          this.hostClockRttMs = Math.max(0, Number(message.rttMs || 0));
          this.hostClockSynced = true;
          return;
        }
        if (message.type === "source-update") {
          await this.applySourceUpdate(message);
          return;
        }
        if (message.type === "kicked") {
          this.error = message.reason || "The host removed this audio output from the watch room.";
          this.stopOutput();
        }
      } catch (error) {
        this.error = error.message;
      }
    },

    queueChannelMessage(event) {
      const data = event.data;
      this.channelMessageQueue = this.channelMessageQueue
        .then(() => this.handleChannelMessage({ data }))
        .catch((error) => {
          this.error = error.message;
        });
    },

    handleClockPing(message) {
      if (!this.channel || this.channel.readyState !== "open") return;
      const viewerReceivedAt = Date.now();
      sendChannelJson(this.channel, {
        type: "clock-pong",
        hostSentAt: Number(message.sentAt || 0),
        viewerReceivedAt,
        viewerSentAt: Date.now(),
      });
    },

    estimatedHostNow() {
      return this.hostClockSynced ? Date.now() - this.hostClockOffsetMs : Date.now();
    },

    async applySourceUpdate(message) {
      this.metadata = message.metadata || this.metadata;
      this.sourceVersion = Number(this.metadata?.sourceVersion || this.sourceVersion || 0);
      this.selectedPlaybackMode = this.defaultPlaybackMode();
      this.pendingSync = null;
      this.pendingSegmentSync = null;
      this.stopOutput();
      this.status = message.reason || "Host updated the room source. Restarting audio output.";
      if (this.outputStarted) {
        setTimeout(() => this.startOutput(), 250);
      }
    },

    applySync(message) {
      const video = this.mediaElement();
      if (!video || !this.videoUrl) {
        this.pendingSync = message;
        return;
      }
      const baseRate = Number(message.playbackRate || 1);
      let targetTime = Number.isFinite(message.currentTime) ? Math.max(0, message.currentTime) : 0;
      if (!message.paused && Number.isFinite(message.sentAt)) {
        const apparentLatency = clamp(this.estimatedHostNow() - message.sentAt, 0, WATCH_AUDIO_MAX_SYNC_LATENCY_MS);
        targetTime += apparentLatency / 1000 * baseRate;
      }
      targetTime = Math.max(0, targetTime - Number(this.outputDelayMs || 0) / 1000);
      const driftSeconds = targetTime - (video.currentTime || 0);
      const drift = Math.abs(driftSeconds);
      if (message.paused) {
        video.pause();
        video.playbackRate = baseRate;
        if (drift > 0.04 || String(message.reason || "").includes("seek")) seekVideoTo(video, targetTime);
        return;
      }
      if (drift > WATCH_AUDIO_SEEK_THRESHOLD_SECONDS || String(message.reason || "").includes("seek")) {
        seekVideoTo(video, targetTime);
        video.playbackRate = baseRate;
      } else if (drift > 0.025) {
        const nudge = Math.min(0.08, Math.max(0.015, drift * 0.08));
        video.playbackRate = clamp(baseRate + Math.sign(driftSeconds) * nudge, 0.92, 1.08);
      } else {
        video.playbackRate = baseRate;
      }
      video.play().catch(() => {
        this.status = "Audio output is synced but autoplay was blocked. Press Start output.";
      });
    },

    applySyncHold(message) {
      const video = this.mediaElement();
      if (!video || !this.videoUrl) {
        this.pendingSync = message;
        return;
      }
      this.pendingSegmentSync = message;
      video.pause();
      if (Number.isFinite(message.currentTime)) seekVideoTo(video, Math.max(0, message.currentTime));
      const bufferSeconds = Number(message.bufferSeconds || WATCH_AUDIO_SYNC_BUFFER_SECONDS);
      message.bufferStartedAt = Date.now();
      this.status = `Buffering ${bufferSeconds} seconds before synchronized resume.`;
      this.waitForOutputBuffer(message.syncId, message.currentTime || 0, bufferSeconds, message.bufferStartedAt);
    },

    async waitForOutputBuffer(syncId, targetTime, bufferSeconds = WATCH_AUDIO_SYNC_BUFFER_SECONDS, startedAt = Date.now()) {
      const video = this.mediaElement();
      if (!video) return;
      for (let attempt = 0; this.pendingSegmentSync?.syncId === syncId; attempt += 1) {
        if (mediaHasResumeBuffer(video, targetTime, bufferSeconds, startedAt)) {
          this.sendSegmentReady(syncId, targetTime, mediaBufferedUntil(video, targetTime));
          return;
        }
        await sleep(WATCH_AUDIO_SYNC_READY_POLL_MS);
      }
    },

    checkPendingSegmentReadiness() {
      if (!this.pendingSegmentSync) return;
      const video = this.mediaElement();
      const bufferSeconds = Number(this.pendingSegmentSync.bufferSeconds || WATCH_AUDIO_SYNC_BUFFER_SECONDS);
      if (video && mediaHasResumeBuffer(video, this.pendingSegmentSync.currentTime || 0, bufferSeconds, this.pendingSegmentSync.bufferStartedAt || Date.now())) {
        this.sendSegmentReady(this.pendingSegmentSync.syncId, this.pendingSegmentSync.currentTime || 0, mediaBufferedUntil(video, this.pendingSegmentSync.currentTime || 0));
      }
    },

    sendSegmentReady(syncId, targetTime, bufferedUntil = 0) {
      if (!this.pendingSegmentSync || this.pendingSegmentSync.syncId !== syncId) return;
      this.pendingSegmentSync = null;
      this.status = "Ready for synchronized audio resume.";
      sendChannelJson(this.channel, {
        type: "segment-ready",
        syncId,
        currentTime: targetTime,
        bufferedUntil,
      });
    },

    applyResumeAt(message) {
      const video = this.mediaElement();
      if (!video || !this.videoUrl) {
        this.pendingSync = message;
        return;
      }
      this.pendingSegmentSync = null;
      const targetTime = Math.max(0, Number(message.currentTime || video.currentTime || 0) - Number(this.outputDelayMs || 0) / 1000);
      seekVideoTo(video, targetTime);
      video.playbackRate = Number(message.playbackRate || 1);
      const absoluteDelay = Number(message.resumeAt) - this.estimatedHostNow();
      const fallbackDelay = Number(message.resumeDelayMs || 0);
      const delay = Number.isFinite(absoluteDelay) && absoluteDelay >= -250 && absoluteDelay <= Math.max(500, fallbackDelay + 750)
        ? Math.max(0, absoluteDelay)
        : Math.max(0, fallbackDelay - 350);
      this.lastSyncLabel = new Date().toLocaleTimeString();
      this.status = "Synchronized audio resume scheduled.";
      setTimeout(() => {
        video.play().catch(() => {
          this.status = "Audio output is ready. Press Start output if autoplay was blocked.";
        });
      }, delay);
    },

    applyPendingPlaybackState(delay = 0) {
      const run = () => {
        if (!this.pendingSync || !this.videoUrl) return;
        const message = this.pendingSync;
        this.pendingSync = null;
        if (message.type === "sync-hold") this.applySyncHold(message);
        else if (message.type === "resume-at") this.applyResumeAt(message);
        else this.applySync(message);
      };
      if (delay > 0) setTimeout(run, delay);
      else run();
    },

    notifyOutputReady() {
      if (this.channel?.readyState !== "open") return;
      sendChannelJson(this.channel, {
        type: "viewer-player-ready",
        mode: `audio-output:${this.channelLabel}`,
        sourceVersion: this.sourceVersion,
      });
    },

    async decryptPayload(ivText, ciphertext) {
      return crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64UrlDecode(ivText) },
        this.key,
        ciphertext,
      );
    },
  }));
});
