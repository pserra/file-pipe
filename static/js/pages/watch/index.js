const WATCH_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const WATCH_SESSION_STORAGE_PREFIX = "filePipeWatchSession:";
const WATCH_RECONNECT_BASE_DELAY_MS = 1500;
const WATCH_RECONNECT_MAX_DELAY_MS = 30000;

document.addEventListener("alpine:init", () => {
  Alpine.data("watchRoom", (roomId) => ({
    roomId,
    viewerName: "",
    participantId: "",
    sessionRestoreAttempted: false,
    key: null,
    metadata: null,
    selectedPlaybackMode: "",
    sourceVersion: 0,
    peer: null,
    channel: null,
    channelMessageQueue: Promise.resolve(),
    channelReady: false,
    remoteControlAllowed: false,
    suppressViewerControlEvents: false,
    pendingViewerControlAction: "",
    pendingViewerControlSentAt: 0,
    pendingViewerControlUntil: 0,
    hostClockOffsetMs: 0,
    hostClockRttMs: 0,
    hostClockSynced: false,
    acknowledgementAccepted: false,
    acceptedSourceVersion: 0,
    acceptedContentKey: "",
    pendingVideoRequest: false,
    pendingVideoRequestTimer: null,
    receiving: false,
    receivedBytes: 0,
    verifiedMd5: "",
    videoUrl: "",
    viewerHls: null,
    viewerXrPlayer: null,
    viewerProgressTracker: null,
    viewerProgressiveMse: null,
    streamingReady: false,
    rangePlayerPromoted: false,
    videoAudioStatus: "",
    progress: 0,
    playbackBufferSeconds: 0,
    playbackBufferPercent: 0,
    viewerLinearPlaybackTime: 0,
    mediaCapabilities: detectMediaPlaybackCapabilities(),
    status: "Loading room metadata...",
    lastSyncLabel: "",
    pendingSync: null,
    networkOnline: navigator.onLine,
    recoveryStatus: "",
    reconnecting: false,
    reconnectRetryTimer: null,
    reconnectRetryDelayMs: WATCH_RECONNECT_BASE_DELAY_MS,
    voiceEnabled: false,
    audioInputs: [],
    audioOutputs: [],
    voiceInputId: "",
    voiceOutputId: "",
    mediaVolume: 1,
    participantVolume: 1,
    micStream: null,
    micDeviceId: "",
    selfMuted: false,
    selfVoiceLevel: 0,
    selfVoiceMeter: null,
    voiceMutedByHost: false,
    hostVoiceMuted: false,
    hostVoiceAvailable: false,
    hostVoiceSelfMuted: false,
    hostVoiceLevel: 0,
    hostVoiceMeter: null,
    voiceStatus: "",
    controlUnlockTimer: null,
    pendingRangeMd5: {},
    pendingRangeBytes: {},
    pendingHlsBytes: {},
    pendingSegmentSync: null,
    mediaPrefetchStatus: "",
    viewerSeekControlTimer: null,
    lastPlaybackStateSentAt: 0,
    audioOutputLink: "",
    audioOutputStatus: "",
    error: "",

    initWatchRoom() {
      this.loadStoredWatchSession();
      this.registerWatchSessionPersistence();
      navigator.serviceWorker?.addEventListener("message", (event) => this.handleWorkerMessage(event));
      window.addEventListener("offline", () => {
        this.networkOnline = false;
        this.channelReady = false;
        this.recoveryStatus = "You are offline. The watch connection will need to reconnect.";
      });
      window.addEventListener("online", async () => {
        this.networkOnline = true;
        this.recoveryStatus = "Back online. Reconnecting to the host...";
        await this.reconnectToHost();
      });
      this.refreshAudioDevices();
      this.startReceiveControlUnlocker();
      this.loadRoom();
    },

    registerWatchSessionPersistence() {
      if (!this.$watch) return;
      [
        "viewerName",
        "selectedPlaybackMode",
        "acknowledgementAccepted",
        "acceptedSourceVersion",
        "acceptedContentKey",
        "mediaVolume",
        "participantVolume",
        "voiceInputId",
        "voiceOutputId",
        "hostVoiceMuted",
      ].forEach((property) => this.$watch(property, () => this.saveWatchSession()));
    },

    watchSessionStorageKey() {
      return `${WATCH_SESSION_STORAGE_PREFIX}${this.roomId}`;
    },

    loadStoredWatchSession() {
      try {
        const raw = window.localStorage?.getItem(this.watchSessionStorageKey());
        if (!raw) return;
        const session = JSON.parse(raw);
        if (!session || Number(session.expiresAt || 0) <= Date.now()) {
          this.clearStoredWatchSession();
          return;
        }
        this.applyStoredWatchSession(session);
      } catch {
        this.clearStoredWatchSession();
      }
    },

    applyStoredWatchSession(session) {
      if (typeof session.viewerName === "string") this.viewerName = session.viewerName.slice(0, 80);
      if (typeof session.participantId === "string") this.participantId = session.participantId;
      if (["range", "hls", "hls3d"].includes(session.selectedPlaybackMode)) {
        this.selectedPlaybackMode = session.selectedPlaybackMode;
      }
      this.acknowledgementAccepted = Boolean(session.acknowledgementAccepted);
      this.acceptedSourceVersion = Number(session.acceptedSourceVersion || 0);
      if (typeof session.acceptedContentKey === "string") this.acceptedContentKey = session.acceptedContentKey;
      const mediaVolume = Number(session.mediaVolume);
      const participantVolume = Number(session.participantVolume);
      if (Number.isFinite(mediaVolume)) this.mediaVolume = clamp(mediaVolume, 0, 1);
      if (Number.isFinite(participantVolume)) this.participantVolume = clamp(participantVolume, 0, 1);
      if (typeof session.voiceInputId === "string") this.voiceInputId = session.voiceInputId;
      if (typeof session.voiceOutputId === "string") this.voiceOutputId = session.voiceOutputId;
      this.hostVoiceMuted = Boolean(session.hostVoiceMuted);
      this.sessionRestoreAttempted = false;
    },

    saveWatchSession() {
      try {
        if (!this.viewerName && !this.participantId) return;
        window.localStorage?.setItem(this.watchSessionStorageKey(), JSON.stringify({
          version: 1,
          savedAt: Date.now(),
          expiresAt: Date.now() + WATCH_SESSION_TTL_MS,
          participantId: this.participantId,
          viewerName: this.viewerName,
          selectedPlaybackMode: this.selectedPlaybackMode,
          acknowledgementAccepted: this.acknowledgementAccepted,
          acceptedSourceVersion: this.acceptedSourceVersion,
          acceptedContentKey: this.acceptedContentKey,
          mediaVolume: this.mediaVolume,
          participantVolume: this.participantVolume,
          voiceInputId: this.voiceInputId,
          voiceOutputId: this.voiceOutputId,
          hostVoiceMuted: this.hostVoiceMuted,
        }));
      } catch {
        // Storage can be unavailable in private browsing or locked-down embeds.
      }
    },

    clearStoredWatchSession() {
      try {
        window.localStorage?.removeItem(this.watchSessionStorageKey());
      } catch {
        // Ignore storage failures; reconnect can still proceed without persistence.
      }
    },

    startReceiveControlUnlocker() {
      this.forceReceiveControlsInteractive();
      this.controlUnlockTimer = setInterval(() => this.forceReceiveControlsInteractive(), 500);
    },

    forceReceiveControlsInteractive() {
      const acknowledgement = document.getElementById("watch-acknowledgement");
      if (acknowledgement) acknowledgement.disabled = false;
      const receiveButton = document.querySelector(".card.border-warning .btn.btn-primary");
      if (receiveButton) receiveButton.disabled = false;
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
        const message = response.status === 401
          ? "Authentication expired. Reload the watch page and sign in again."
          : payload.error || `Request failed with ${response.status}.`;
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      if (!contentType.includes("application/json")) {
        throw new Error(`Expected JSON from ${path}, but received ${contentType || "a non-JSON response"}.`);
      }
      return payload;
    },

    async loadRoom() {
      try {
        const keyText = new URLSearchParams(window.location.hash.slice(1)).get("key");
        if (!keyText) throw new Error("This watch link is missing its decryption key.");
        this.key = await crypto.subtle.importKey(
          "raw",
          base64UrlDecode(keyText),
          { name: "AES-GCM" },
          false,
          ["decrypt"],
        );
        const room = await this.appJson(`/api/watch/rooms/${this.roomId}`);
        if (!room.metadata) {
          this.status = "Waiting for host metadata...";
          return;
        }
        const metadataBytes = await this.decryptPayload(
          room.metadata.iv,
          base64UrlDecode(room.metadata.ciphertext),
        );
        this.metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
        this.sourceVersion = Number(this.metadata.sourceVersion || 0);
        const contentKey = this.metadata.contentKey || String(this.sourceVersion || "");
        const acceptedKey = this.acceptedContentKey || String(this.acceptedSourceVersion || "");
        if (this.acknowledgementAccepted && acceptedKey && acceptedKey !== contentKey) {
          this.acknowledgementAccepted = false;
          this.acceptedSourceVersion = 0;
          this.acceptedContentKey = "";
        }
        if (!this.isPlaybackModeAvailable(this.selectedPlaybackMode)) {
          this.selectedPlaybackMode = this.defaultPlaybackMode();
        }
        if (this.participantId) {
          this.status = "Restoring your watch session...";
          this.saveWatchSession();
          if (!this.sessionRestoreAttempted) {
            this.sessionRestoreAttempted = true;
            setTimeout(() => {
              this.reconnectToHost({
                preservePendingRequest: this.pendingVideoRequest,
                restoringSession: true,
              });
            }, 0);
          }
          return;
        }
        this.status = "Enter your name to join the room.";
      } catch (error) {
        this.error = error.message;
        this.status = "";
      }
    },

    defaultPlaybackMode(metadata = this.metadata) {
      if (!metadata) return "range";
      const modes = metadata.availableModes || {};
      if (metadata.streamMode === "hls" || metadata.playbackProfile?.sourceKind === "hls-live" || String(metadata.type || "").includes("mpegurl")) {
        return "hls";
      }
      if (metadata.streamMode === "range") {
        return "range";
      }
      const rangeProgress = modes.range?.progressiveTranscode || metadata.progressiveTranscode;
      if (modes.hls && rangeProgress && !rangeProgress.complete) {
        return "hls";
      }
      return "range";
    },

    availablePlaybackModes() {
      if (!this.metadata) return [];
      const modes = this.metadata.availableModes || {};
      const result = [];
      if (modes.range || this.defaultPlaybackMode(this.metadata) === "range") {
        const progress = modes.range?.progressiveTranscode || this.metadata.progressiveTranscode;
        const rangeIncomplete = progress && !progress.complete;
        result.push({
          id: "range",
          label: "Watch",
          description: rangeIncomplete ? "Stable MP4 unlocks when the transcode completes" : "More metadata and scrubbing",
          disabled: Boolean(rangeIncomplete),
        });
      }
      if (modes.hls || this.defaultPlaybackMode(this.metadata) === "hls") {
        result.push({ id: "hls", label: "Stream", description: "More compatible playback" });
      }
      if (modes.hls3d) {
        const localStereo = Boolean(modes.hls3d.localStereoProcessor || modes.hls3d.playbackProfile?.localStereoProcessor);
        result.push({
          id: "hls3d",
          label: localStereo ? "WebGPU XR 3D" : "3D Stream",
          description: stereo3dModeDescription(modes.hls3d),
        });
      }
      return result;
    },

    canSwitchPlaybackModes() {
      return this.availablePlaybackModes().length > 1;
    },

    isPlaybackModeAvailable(mode) {
      return Boolean(this.availablePlaybackModes().find((item) => item.id === mode && !item.disabled));
    },

    playbackModeLabel() {
      if (this.selectedPlaybackMode === "hls3d") {
        const mode = this.availablePlaybackModes().find((item) => item.id === "hls3d");
        return mode?.label || "3D Stream";
      }
      return this.selectedPlaybackMode === "hls" ? "Stream" : "Watch";
    },

    playbackModeHelpText() {
      const selected = this.availablePlaybackModes().find((mode) => mode.id === this.selectedPlaybackMode);
      if (selected?.description) return selected.description;
      if (this.selectedPlaybackMode === "hls3d") {
        return stereo3dModeDescription(this.playbackMetadata());
      }
      return this.selectedPlaybackMode === "hls"
        ? "Stream mode favors compatibility and steadier playback."
        : "Watch mode favors metadata, range requests, and scrubbing.";
    },

    viewerProgressivePlaybackLocked() {
      const metadata = this.playbackMetadata();
      return this.selectedPlaybackMode === "range"
        && Boolean(metadata?.progressiveTranscode)
        && !metadata.progressiveTranscode.complete;
    },

    progressivePlaybackLabel(progress = this.playbackMetadata()?.progressiveTranscode) {
      const percent = Math.max(0, Math.min(99, Math.round(Number(progress?.percent || 0))));
      if (percent > 0) return `Linear playback while Stable MP4 is ${percent}% ready. Scrubbing unlocks at 100%.`;
      return "Linear playback is available while Stable MP4 prepares. Scrubbing unlocks at 100%.";
    },

    playbackMetadata() {
      const metadata = this.metadata || {};
      const mode = this.selectedPlaybackMode || this.defaultPlaybackMode(metadata);
      const modes = metadata.availableModes || {};
      if (mode === "hls3d" && modes.hls3d) {
        return {
          ...metadata,
          ...modes.hls3d,
          name: metadata.name,
          md5: "",
          checksumKind: "hls-segments",
          streamMode: "hls",
          hls: modes.hls3d.hls || metadata.hls,
          progressiveTranscode: null,
          availableModes: modes,
          sourceVersion: metadata.sourceVersion,
        };
      }
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

    setPlaybackMode(mode) {
      const selected = this.availablePlaybackModes().find((item) => item.id === mode);
      if (!selected || selected.disabled || this.selectedPlaybackMode === mode) return;
      this.selectedPlaybackMode = mode;
      this.teardownViewerHlsPlayer();
      this.teardownViewerProgressiveMsePlayer();
      this.detachViewerXrPlayer();
      this.detachViewerPlaybackProgress();
      const video = document.getElementById("viewer-video-player");
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      if (this.videoUrl && this.videoUrl.startsWith("blob:")) URL.revokeObjectURL(this.videoUrl);
      this.videoUrl = "";
      this.streamingReady = false;
      this.receiving = false;
      this.receivedBytes = 0;
      this.progress = 0;
      this.pendingRangeMd5 = {};
      this.pendingRangeBytes = {};
      this.pendingHlsBytes = {};
      this.viewerLinearPlaybackTime = 0;
      this.rangePlayerPromoted = false;
      this.status = `${this.playbackModeLabel()} mode selected.`;
      this.saveWatchSession();
      if (this.acknowledgementAccepted && this.channelReady) {
        setTimeout(() => this.requestVideo(), 100);
      }
    },

    async joinRoom() {
      this.error = "";
      try {
        const response = await fetch(`/api/watch/rooms/${this.roomId}/participants`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ name: this.viewerName }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Could not join room: ${response.status}`);
        this.participantId = payload.participantId;
        this.sessionRestoreAttempted = true;
        this.saveWatchSession();
        this.logWatchEvent("joined", "Participant joined room.");
        this.status = "Waiting for host connection offer...";
        await this.waitForOfferAndAnswer();
      } catch (error) {
        this.error = error.message;
      }
    },

    async waitForOfferAndAnswer(maxAttempts = 300) {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const participant = await this.appJson(`/api/watch/rooms/${this.roomId}/participants/${this.participantId}`);
        if (participant.kicked) {
          this.clearStoredWatchSession();
          this.participantId = "";
          const kickedError = new Error("The host removed you from this watch room.");
          kickedError.status = 410;
          throw kickedError;
        }
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
      this.stopHostVoiceMeter();
      this.peer = new RTCPeerConnection(P2P_CONFIG);
      this.peer.ondatachannel = (event) => {
        this.channel = event.channel;
        this.channel.binaryType = "arraybuffer";
        this.channel.onopen = () => {
          this.channelReady = true;
          this.reconnectRetryDelayMs = WATCH_RECONNECT_BASE_DELAY_MS;
          this.clearReconnectRetry();
          this.status = "Connected. Confirm the acknowledgement to receive video.";
          this.recoveryStatus = "";
          this.clearPendingVideoReconnect();
          this.logWatchEvent("channel-open", "Data channel opened.");
          this.publishViewerVoiceState("channel-open");
          this.publishViewerMediaCapabilities("channel-open");
          if (this.pendingVideoRequest) {
            this.requestVideo();
          } else if (this.videoUrl && this.streamingReady) {
            this.notifyViewerPlayerReady();
            this.applyPendingPlaybackState(250);
            setTimeout(() => this.startMediaPrefetch(this.playbackMetadata()), 1500);
          }
        };
        this.channelMessageQueue = Promise.resolve();
        this.channel.onmessage = (eventMessage) => this.queueChannelMessage(eventMessage);
        this.channel.onclose = () => {
          if (this.reconnecting) return;
          this.channelReady = false;
          this.status = "Host disconnected. Waiting for the host to return...";
          this.recoveryStatus = "Host connection lost. Playback can continue from cached data; sync will resume when the host reconnects.";
          this.logWatchEvent("channel-close", "Data channel closed.");
          this.scheduleReconnectToHost({ preservePendingRequest: this.pendingVideoRequest || Boolean(this.videoUrl) });
        };
      };
      this.peer.onconnectionstatechange = () => {
        this.logWatchEvent("peer-state", this.peer.connectionState);
        if (this.reconnecting) return;
        if (["failed", "disconnected"].includes(this.peer.connectionState)) {
          this.channelReady = false;
          this.status = "Peer connection interrupted. Waiting for the host to return...";
          this.recoveryStatus = "Peer connection interrupted. Playback can continue from cached data; sync will resume when the host reconnects.";
          this.scheduleReconnectToHost({ preservePendingRequest: this.pendingVideoRequest || Boolean(this.videoUrl) });
        }
      };
      this.peer.ontrack = (event) => this.handleViewerRemoteVoice(event);
      await this.peer.setRemoteDescription(offer);
      if (this.micStream) {
        this.setViewerMicTrackEnabled();
        this.micStream.getAudioTracks().forEach((track) => this.peer.addTrack(track, this.micStream));
      }
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
      this.channelReady = false;
      this.status = "Answer sent. You can acknowledge the video while the peer connection finishes.";
      this.saveWatchSession();
      this.logWatchEvent("answer-sent", "Published WebRTC answer.");
      const answeredPeer = this.peer;
      setTimeout(() => {
        if (this.peer !== answeredPeer || this.channelReady) return;
        this.status = p2pConfigHasTurn()
          ? "Still connecting to the host through the relay. Keep this page open."
          : "Still connecting to the host. Cellular and strict networks usually need a TURN relay configured.";
      }, 10000);
      if (this.pendingVideoRequest) this.schedulePendingVideoReconnect();
    },

    async reconnectToHost(options = {}) {
      if (!this.participantId || this.reconnecting) {
        if (!this.participantId) await this.loadRoom();
        return;
      }
      this.clearReconnectRetry();
      this.reconnecting = true;
      this.error = "";
      this.logWatchEvent("reconnect-start", options.preservePendingRequest ? "Preserving queued video request." : "");
      try {
        if (this.channel) this.channel.close();
        if (this.peer) this.peer.close();
        this.stopHostVoiceMeter();
        this.channel = null;
        this.peer = null;
        this.channelReady = false;
        if (!this.receiving && !options.preservePendingRequest) {
          this.pendingVideoRequest = false;
          this.clearPendingVideoReconnect();
        }
        const response = await fetch(`/api/watch/rooms/${this.roomId}/participants/${this.participantId}/reconnect`, {
          method: "POST",
          headers: { Accept: "application/json" },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const reconnectError = new Error(payload.error || `Reconnect failed: ${response.status}`);
          reconnectError.status = response.status;
          throw reconnectError;
        }
        this.status = "Reconnect requested. Waiting for host offer...";
        await this.waitForOfferAndAnswer(45);
        this.recoveryStatus = "Reconnected to signaling. Waiting for peer connection.";
        this.logWatchEvent("reconnect-complete", "Fresh answer published.");
        if (this.pendingVideoRequest) this.schedulePendingVideoReconnect();
      } catch (error) {
        if (error.status === 410) {
          this.clearStoredWatchSession();
          this.participantId = "";
          this.channelReady = false;
          this.pendingVideoRequest = false;
          this.clearPendingVideoReconnect();
          this.clearReconnectRetry();
          this.status = "The host removed you from this watch room.";
          this.error = this.status;
          this.logWatchEvent("reconnect-removed", error.message);
          return;
        }
        if (options.restoringSession && [404, 410].includes(error.status)) {
          this.clearStoredWatchSession();
          this.participantId = "";
          this.channelReady = false;
          this.pendingVideoRequest = false;
          this.clearPendingVideoReconnect();
          this.status = "Enter your name to join the room.";
          this.error = error.status === 410
            ? "The host removed your previous session. Enter a name to rejoin."
            : "";
          this.logWatchEvent("session-restore-missing", error.message);
          return;
        }
        this.error = "";
        this.recoveryStatus = `Waiting for host to return. Last reconnect attempt: ${error.message}`;
        this.logWatchEvent("reconnect-error", error.message);
        this.scheduleReconnectToHost({
          preservePendingRequest: options.preservePendingRequest || this.pendingVideoRequest || Boolean(this.videoUrl),
        });
      } finally {
        this.reconnecting = false;
      }
    },

    scheduleReconnectToHost(options = {}) {
      if (!this.participantId || this.reconnectRetryTimer) return;
      const delay = this.reconnectRetryDelayMs || WATCH_RECONNECT_BASE_DELAY_MS;
      this.reconnectRetryDelayMs = Math.min(delay * 1.6, WATCH_RECONNECT_MAX_DELAY_MS);
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

    async refreshAudioDevices() {
      if (!navigator.mediaDevices?.enumerateDevices) {
        this.voiceStatus = "Audio device selection is not supported in this browser.";
        return;
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        this.audioInputs = devices.filter((device) => device.kind === "audioinput");
        this.audioOutputs = devices.filter((device) => device.kind === "audiooutput");
        if (this.voiceInputId && !this.audioInputs.some((device) => device.deviceId === this.voiceInputId)) {
          this.voiceInputId = "";
        }
        if (this.voiceOutputId && !this.audioOutputs.some((device) => device.deviceId === this.voiceOutputId)) {
          this.voiceOutputId = "";
        }
      } catch (error) {
        this.voiceStatus = error.message;
      }
    },

    async enableViewerVoice() {
      if (!navigator.mediaDevices?.getUserMedia) {
        this.voiceStatus = "Microphone access is not supported in this browser.";
        return;
      }
      if (this.voiceMutedByHost) {
        this.voiceStatus = "The host muted your microphone.";
        return;
      }
      if (this.micStream && this.micDeviceId === this.voiceInputId) {
        this.setViewerSelfMuted(false);
        this.voiceStatus = "Microphone unmuted.";
        return;
      }
      try {
        const requestedInputId = this.voiceInputId;
        const requested = await requestAudioInputStream(requestedInputId);
        if (this.micStream) {
          this.stopViewerVoiceMeter();
          this.micStream.getTracks().forEach((track) => track.stop());
        }
        this.micStream = requested.stream;
        this.micDeviceId = requested.deviceId;
        this.voiceInputId = requested.deviceId;
        this.selfMuted = false;
        this.setViewerMicTrackEnabled();
        this.startViewerVoiceMeter();
        this.voiceEnabled = true;
        this.voiceStatus = requested.usedFallback
          ? "Selected microphone was unavailable, so voice is using the default microphone. Reconnecting..."
          : "Voice is enabled. Reconnecting to include your microphone...";
        await this.refreshAudioDevices();
        this.saveWatchSession();
        if (this.participantId) await this.reconnectToHost();
      } catch (error) {
        this.voiceEnabled = false;
        this.micStream = null;
        this.micDeviceId = "";
        this.selfVoiceLevel = 0;
        this.stopViewerVoiceMeter();
        this.voiceStatus = error.message;
      }
    },

    async changeViewerVoiceInput() {
      this.saveWatchSession();
      if (this.micStream) {
        await this.enableViewerVoice();
      }
    },

    async stopViewerVoice() {
      this.setViewerSelfMuted(true);
      this.voiceStatus = this.micStream
        ? "Microphone muted."
        : "Microphone is already muted.";
    },

    handleViewerRemoteVoice(event) {
      const stream = event.streams?.[0];
      if (!stream) return;
      const audio = document.getElementById("viewer-voice-audio");
      if (!audio) return;
      audio.srcObject = stream;
      this.hostVoiceAvailable = true;
      this.startHostVoiceMeter(stream);
      this.applyViewerVolumes();
      this.setMediaSink(audio, this.voiceOutputId);
      audio.play().catch(() => {
        this.voiceStatus = "Participant voice is ready. Browser autoplay may require one click.";
      });
    },

    async setViewerAudioOutput() {
      const video = document.getElementById("viewer-video-player");
      const audio = document.getElementById("viewer-voice-audio");
      await this.setMediaSink(video, this.voiceOutputId);
      await this.setMediaSink(audio, this.voiceOutputId);
      this.saveWatchSession();
    },

    async setMediaSink(element, deviceId) {
      if (!element || !element.setSinkId) {
        if (deviceId) this.voiceStatus = "This browser does not support selecting an audio output device.";
        return;
      }
      try {
        await element.setSinkId(deviceId || "");
      } catch (error) {
        if (deviceId && isRecoverableAudioOutputError(error)) {
          try {
            await element.setSinkId("");
            this.voiceOutputId = "";
            this.voiceStatus = "Selected audio output was unavailable, so audio is using the default output.";
            return;
          } catch (fallbackError) {
            this.voiceStatus = fallbackError.message;
            return;
          }
        }
        this.voiceStatus = error.message;
      }
    },

    applyViewerVolumes() {
      const video = document.getElementById("viewer-video-player");
      const audio = document.getElementById("viewer-voice-audio");
      if (video) video.volume = this.mediaVolume;
      if (audio) {
        audio.volume = this.participantVolume;
        audio.muted = this.hostVoiceMuted;
      }
      if (this.hostVoiceMuted) this.hostVoiceLevel = 0;
      this.saveWatchSession();
    },

    setViewerSelfMuted(muted) {
      this.selfMuted = Boolean(muted);
      this.setViewerMicTrackEnabled();
      this.voiceEnabled = Boolean(this.micStream) && !this.selfMuted && !this.voiceMutedByHost;
      this.publishViewerVoiceState(this.selfMuted ? "self-muted" : "self-unmuted");
    },

    setViewerMicTrackEnabled() {
      if (!this.micStream) return;
      const enabled = !this.selfMuted && !this.voiceMutedByHost;
      this.micStream.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
      if (!enabled) this.selfVoiceLevel = 0;
    },

    voiceLevelStyle(level) {
      const width = Math.round(clamp(Number(level || 0), 0, 1) * 100);
      return `width: ${width}%`;
    },

    voiceActivityIconClass(level, muted = false, available = true) {
      if (!available) return "bi-mic text-secondary";
      if (muted) return "bi-mic-mute text-secondary";
      return Number(level || 0) > 0.08 ? "bi-mic-fill text-success" : "bi-mic text-secondary";
    },

    startViewerVoiceMeter() {
      this.stopViewerVoiceMeter();
      if (!this.micStream) return;
      this.selfVoiceMeter = createVoiceActivityMeter(
        this.micStream,
        (level) => {
          this.selfVoiceLevel = this.selfMuted || this.voiceMutedByHost ? 0 : level;
        },
        (error) => {
          this.voiceStatus = error.message;
        },
      );
    },

    stopViewerVoiceMeter() {
      if (this.selfVoiceMeter) this.selfVoiceMeter.stop();
      this.selfVoiceMeter = null;
      this.selfVoiceLevel = 0;
    },

    startHostVoiceMeter(stream) {
      this.stopHostVoiceMeter();
      this.hostVoiceMeter = createVoiceActivityMeter(
        stream,
        (level) => {
          this.hostVoiceLevel = this.hostVoiceMuted || this.hostVoiceSelfMuted ? 0 : level;
        },
        (error) => {
          this.voiceStatus = error.message;
        },
      );
    },

    stopHostVoiceMeter() {
      if (this.hostVoiceMeter) this.hostVoiceMeter.stop();
      this.hostVoiceMeter = null;
      this.hostVoiceLevel = 0;
    },

    toggleHostAudioMute() {
      this.hostVoiceMuted = !this.hostVoiceMuted;
      this.applyViewerVolumes();
      this.voiceStatus = this.hostVoiceMuted
        ? "Host voice muted locally."
        : "Host voice unmuted locally.";
      this.saveWatchSession();
    },

    publishViewerVoiceState(reason = "") {
      if (!this.channel || this.channel.readyState !== "open") return;
      sendChannelJson(this.channel, {
        type: "voice-state",
        role: "participant",
        reason,
        micAvailable: Boolean(this.micStream),
        muted: !this.micStream || this.selfMuted || this.voiceMutedByHost,
        mutedByHost: this.voiceMutedByHost,
      });
    },

    publishViewerMediaCapabilities(reason = "") {
      if (!this.channel || this.channel.readyState !== "open") return;
      sendChannelJson(this.channel, {
        type: "media-capabilities",
        role: "participant",
        reason,
        capabilities: this.mediaCapabilities,
      });
    },

    handleHostVoiceState(message) {
      this.hostVoiceAvailable = Boolean(message.micAvailable);
      this.hostVoiceSelfMuted = Boolean(message.muted);
      if (this.hostVoiceSelfMuted) this.hostVoiceLevel = 0;
    },

    handleVoiceControl(message) {
      if (message.action === "mute") {
        this.voiceMutedByHost = true;
        this.setViewerSelfMuted(true);
        this.voiceStatus = "The host muted your microphone.";
        return;
      }
      if (message.action === "allow-unmute") {
        this.voiceMutedByHost = false;
        this.setViewerMicTrackEnabled();
        this.voiceEnabled = Boolean(this.micStream) && !this.selfMuted;
        this.publishViewerVoiceState("host-allowed-unmute");
        this.voiceStatus = "The host allowed your microphone. Use Enable voice when ready.";
      }
    },

    viewerVoiceLabel() {
      if (this.voiceMutedByHost) return "Muted by host";
      if (this.micStream && !this.selfMuted) return "Mic on";
      return "Muted";
    },

    suppressViewerControlsBriefly(delay = 600) {
      this.suppressViewerControlEvents = true;
      setTimeout(() => {
        this.suppressViewerControlEvents = false;
      }, delay);
    },

    rememberViewerControl(action) {
      if (!["play", "pause", "seek"].includes(action)) return;
      this.pendingViewerControlAction = action;
      this.pendingViewerControlSentAt = Date.now();
      this.pendingViewerControlUntil = this.pendingViewerControlSentAt + 3000;
    },

    clearPendingViewerControl() {
      this.pendingViewerControlAction = "";
      this.pendingViewerControlSentAt = 0;
      this.pendingViewerControlUntil = 0;
    },

    clearViewerControlIfAcknowledged(message) {
      if (!this.pendingViewerControlAction) return;
      if (this.pendingViewerControlAction === "pause" && message.paused) {
        this.clearPendingViewerControl();
      } else if (this.pendingViewerControlAction === "play" && !message.paused) {
        this.clearPendingViewerControl();
      } else if (this.pendingViewerControlAction === "seek" && String(message.reason || "").includes("seek")) {
        this.clearPendingViewerControl();
      }
    },

    shouldIgnoreStaleHostSync(message) {
      if (!this.pendingViewerControlAction || Date.now() > this.pendingViewerControlUntil) return false;
      const sentAt = Number(message.sentAt || 0);
      const fromBeforeControl = sentAt > 0 && sentAt < this.pendingViewerControlSentAt + 250;
      if (this.pendingViewerControlAction === "pause" && !message.paused) {
        return fromBeforeControl || ["time", "state", "viewer-ready"].includes(message.reason);
      }
      if (this.pendingViewerControlAction === "play" && message.paused) {
        return fromBeforeControl || ["time", "state", "viewer-ready"].includes(message.reason);
      }
      return false;
    },

    sendViewerControl(action) {
      if (this.suppressViewerControlEvents && action !== "pause") return;
      if (!this.videoUrl || !["play", "pause", "seek"].includes(action)) return;
      const video = document.getElementById("viewer-video-player");
      if (!video) return;
      if (!this.remoteControlAllowed) {
        if (!this.viewerProgressivePlaybackLocked() || action === "seek") {
          this.status = "Shared playback control is not enabled for you right now.";
        }
        return;
      }
      if (!this.channel || this.channel.readyState !== "open") {
        this.status = "Cannot control playback until the host peer connection is open.";
        return;
      }
      if (action === "seek") {
        this.scheduleViewerSeekControl(video);
        return;
      }
      if (!sendChannelJson(this.channel, {
        type: "participant-control",
        action,
        currentTime: video.currentTime || 0,
        paused: video.paused,
        playbackRate: video.playbackRate || 1,
        sentAt: Date.now(),
      })) {
        this.status = "Cannot control playback because the host peer connection closed.";
        return;
      }
      this.rememberViewerControl(action);
      this.status = "Sent playback control to host.";
    },

    publishViewerPlaybackState(reason = "state") {
      if (!this.channel || this.channel.readyState !== "open" || !this.videoUrl) return;
      const video = document.getElementById("viewer-video-player");
      if (!video) return;
      if (reason === "time" && Date.now() - Number(this.lastPlaybackStateSentAt || 0) < 500) return;
      this.lastPlaybackStateSentAt = Date.now();
      sendChannelJson(this.channel, {
        type: "peer-playback-state",
        reason,
        currentTime: video.currentTime || 0,
        paused: video.paused,
        playbackRate: video.playbackRate || 1,
        sourceVersion: this.sourceVersion,
        sentAt: Date.now(),
      });
    },

    scheduleViewerSeekControl(video) {
      if (this.viewerProgressivePlaybackLocked()) {
        this.status = "Scrubbing unlocks when Stable MP4 is complete.";
        return;
      }
      if (this.viewerSeekControlTimer) clearTimeout(this.viewerSeekControlTimer);
      const currentTime = video.currentTime || 0;
      const paused = video.paused;
      const playbackRate = video.playbackRate || 1;
      this.status = "Scrub target selected. Sending the final position shortly.";
      this.viewerSeekControlTimer = setTimeout(() => {
        this.viewerSeekControlTimer = null;
        if (!this.channel || this.channel.readyState !== "open") {
          this.status = "Cannot control playback because the host peer connection closed.";
          return;
        }
        if (!sendChannelJson(this.channel, {
          type: "participant-control",
          action: "seek",
          currentTime,
          paused,
          playbackRate,
          sentAt: Date.now(),
        })) {
          this.status = "Cannot control playback because the host peer connection closed.";
          return;
        }
        this.rememberViewerControl("seek");
        this.status = "Sent scrub position to host.";
      }, SEEK_CONTROL_DEBOUNCE_MS);
    },

    toggleViewerLinearPlayback() {
      const video = document.getElementById("viewer-video-player");
      if (!video) return;
      if (video.paused) {
        this.status = "Starting linear playback as Stable MP4 bytes arrive...";
        playVideoWhenReady(video, 20000, { load: !this.viewerProgressiveMse }).catch(() => {
          this.status = "Playback is still preparing. Try again once the first bytes are buffered.";
        });
      } else {
        video.pause();
      }
    },

    updateViewerLinearPlaybackTime() {
      const video = document.getElementById("viewer-video-player");
      if (!video || video.seeking) return;
      this.viewerLinearPlaybackTime = video.currentTime || 0;
      this.publishViewerPlaybackState("time");
    },

    handleViewerSeeking() {
      if (!this.viewerProgressivePlaybackLocked()) {
        this.clampViewerProgressiveSeek();
        return;
      }
      const video = document.getElementById("viewer-video-player");
      if (!video) return;
      this.suppressViewerControlsBriefly();
      seekVideoTo(video, this.viewerLinearPlaybackTime || 0);
      this.status = "Scrubbing unlocks when Stable MP4 is complete.";
    },

    handleViewerSeeked() {
      if (this.viewerProgressivePlaybackLocked()) {
        this.updateViewerPlaybackBuffer();
        return;
      }
      this.sendViewerControl("seek");
      this.updateViewerPlaybackBuffer();
      this.publishViewerPlaybackState("seek");
    },

    prepareViewerVideoMedia() {
      const video = document.getElementById("viewer-video-player");
      if (!video) return;
      video.muted = false;
      video.volume = this.mediaVolume;
      this.attachViewerPlaybackProgress(video);
      this.attachViewerXrPlayer(video);
      this.setViewerAudioOutput();
      this.inspectViewerVideoAudio();
      this.publishViewerPlaybackState("metadata");
    },

    viewerPlaybackMd5() {
      const metadata = this.playbackMetadata() || this.metadata || {};
      return metadata.md5 || this.verifiedMd5 || "";
    },

    attachViewerPlaybackProgress(video) {
      if (!window.FilePipePlaybackProgress || !video) return;
      const trackerMd5 = this.viewerPlaybackMd5();
      if (this.viewerProgressTracker) {
        this.viewerProgressTracker.refresh(trackerMd5);
        return;
      }
      this.viewerProgressTracker = window.FilePipePlaybackProgress.attach(video, {
        md5: () => this.viewerPlaybackMd5(),
        name: () => this.playbackMetadata()?.name || this.metadata?.name || "",
      });
    },

    attachViewerHlsPlayer(video = document.getElementById("viewer-video-player")) {
      if (!video || !this.videoUrl) return false;
      this.teardownViewerHlsPlayer();
      if (window.Hls?.isSupported?.()) {
        this.viewerHls = new Hls(hlsBufferConfig());
        this.viewerHls.on(Hls.Events.ERROR, (_event, data) => {
          if (this.recoverViewerHlsAppendError(data)) return;
          if (data?.fatal) {
            this.error = `${data.details || data.type || "The live stream player failed."}${data.error?.message ? `: ${data.error.message}` : ""}`;
            this.status = "";
          } else if (data?.details) {
            this.status = `Live stream is recovering: ${data.details}.`;
          }
        });
        this.viewerHls.on(Hls.Events.FRAG_LOADING, (_event, data) => {
          const metadata = this.playbackMetadata();
          const prefix = metadata?.videoProfile && metadata.videoProfile !== "2d" ? "Generating 3D" : "Loading";
          this.status = `${prefix} live segment ${Number(data?.frag?.sn || 0) + 1}...`;
        });
        this.viewerHls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
          const metadata = this.playbackMetadata();
          const prefix = metadata?.videoProfile && metadata.videoProfile !== "2d" ? "Buffered 3D" : "Buffered";
          this.status = `${prefix} live segment ${Number(data?.frag?.sn || 0) + 1}.`;
        });
        this.viewerHls.loadSource(this.videoUrl);
        this.viewerHls.attachMedia(video);
        this.viewerHls.on(Hls.Events.MANIFEST_PARSED, () => {
          this.prepareViewerVideoMedia();
          this.updateViewerPlaybackBuffer();
          this.applyPendingPlaybackState(100);
        });
        return true;
      }
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.addEventListener("loadedmetadata", () => this.applyPendingPlaybackState(100), { once: true });
        video.src = this.videoUrl;
        video.load();
        this.prepareViewerVideoMedia();
        return true;
      }
      this.error = "This browser cannot play HLS live streams.";
      return false;
    },

    recoverViewerHlsAppendError(data) {
      if (!this.viewerHls || !isRecoverableHlsAppendError(data)) return false;
      this.status = "Recovering live stream buffer...";
      try {
        this.viewerHls.recoverMediaError();
        this.viewerHls.startLoad();
        return true;
      } catch (error) {
        this.error = error.message;
        return false;
      }
    },

    teardownViewerHlsPlayer() {
      if (this.viewerHls) {
        this.viewerHls.destroy();
        this.viewerHls = null;
      }
    },

    teardownViewerProgressiveMsePlayer() {
      if (!this.viewerProgressiveMse) return;
      const requestId = this.viewerProgressiveMse.requestId;
      this.viewerProgressiveMse.appender?.abort();
      if (this.viewerProgressiveMse.objectUrl) URL.revokeObjectURL(this.viewerProgressiveMse.objectUrl);
      this.viewerProgressiveMse = null;
      if (requestId && this.channel?.readyState === "open") {
        sendChannelJson(this.channel, {
          type: "range-cancel",
          requestId,
        });
      }
    },

    attachViewerXrPlayer(video) {
      if (!window.FilePipeXrPlayer || !video) return;
      const profile = this.playbackMetadata()?.playbackProfile || {};
      this.viewerXrPlayer = window.FilePipeXrPlayer.attach(video, {
        panelSelector: ".xr-side-panel",
        storageKey: "filePipeViewerXrPlayer",
        mediaInfo: () => this.playbackMetadata()?.mediaInfo || this.metadata?.mediaInfo || null,
        playbackProfile: profile,
        sourceLayout: xrSourceLayoutFromProfile(profile),
        localDepthProcessor: profile.localStereoProcessor ? profile.stereoProcessor : "",
        localDepthTargetLayout: profile.targetVideoLayout || "",
      });
    },

    detachViewerXrPlayer() {
      if (!this.viewerXrPlayer) return;
      this.viewerXrPlayer.dispose();
      this.viewerXrPlayer = null;
    },

    detachViewerPlaybackProgress() {
      if (!this.viewerProgressTracker) return;
      this.viewerProgressTracker.detach();
      this.viewerProgressTracker = null;
    },

    isHlsStream() {
      const metadata = this.playbackMetadata();
      return metadata?.streamMode === "hls"
        || metadata?.playbackProfile?.sourceKind === "hls-live"
        || String(metadata?.type || "").includes("mpegurl");
    },

    async waitForViewerVideoElement(timeoutMs = 2000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const video = document.getElementById("viewer-video-player");
        if (video) return video;
        await sleep(25);
      }
      return null;
    },

    inspectViewerVideoAudio() {
      const video = document.getElementById("viewer-video-player");
      if (!video) return;
      const audioInfo = detectMediaAudio(video);
      if (audioInfo.known && audioInfo.hasAudio) {
        this.videoAudioStatus = "Audio track detected. If it is still silent, check the media volume and output device.";
      } else if (audioInfo.known) {
        this.videoAudioStatus = "No browser-decodable audio track was detected. The file may use an unsupported audio codec such as AC3, E-AC-3, or DTS.";
      } else {
        this.videoAudioStatus = "Audio track detection is limited in this browser. If the video is silent, the audio codec may not be browser-compatible.";
      }
    },

    async requestVideo() {
      this.logWatchEvent("video-request-clicked", "Receive button clicked.");
      if (this.receiving) {
        this.status = this.isHlsStream() ? "Live streaming is already active." : "Range streaming is already active.";
        return;
      }
      if (this.videoUrl) {
        this.status = this.isHlsStream() ? "Live stream player is already ready." : "Range player is already ready.";
        return;
      }
      if (!this.acknowledgementAccepted) {
        this.acknowledgementAccepted = true;
        this.acceptedSourceVersion = this.sourceVersion;
        this.acceptedContentKey = this.metadata?.contentKey || String(this.sourceVersion || "");
        this.saveWatchSession();
      }
      const hlsStream = this.isHlsStream();
      const playbackMetadata = this.playbackMetadata();
      if (!hlsStream && !playbackMetadata?.md5 && playbackMetadata?.checksumKind !== "original-source") {
        this.error = "The host has not published an MD5 for this video yet.";
        this.logWatchEvent("video-request-blocked", "Missing MD5 metadata.");
        return;
      }
      if (!this.channel || this.channel.readyState !== "open") {
        if (this.pendingVideoRequest) {
          this.status = "Retrying host peer connection...";
          this.reconnectToHost({ preservePendingRequest: true });
        } else {
          this.pendingVideoRequest = true;
          this.error = "";
          this.status = "Video request queued. Waiting for the host peer connection...";
          this.logWatchEvent("video-request-queued", "Waiting for data channel to open.");
          this.schedulePendingVideoReconnect();
        }
        return;
      }
      if (!navigator.serviceWorker) {
        this.error = "This browser does not support service workers, which are required for encrypted range playback.";
        return;
      }
      try {
        this.pendingVideoRequest = false;
        this.clearPendingVideoReconnect();
        this.receiving = true;
        this.error = "";
        this.receivedBytes = 0;
        this.verifiedMd5 = "";
        this.videoAudioStatus = "";
        this.pendingRangeMd5 = {};
        this.pendingRangeBytes = {};
        this.pendingHlsBytes = {};
        this.rangePlayerPromoted = false;
        this.progress = 0;
        if (this.shouldUseViewerProgressiveMse(playbackMetadata)) {
          await this.startViewerProgressiveMsePlayer(playbackMetadata);
          return;
        }
        this.status = hlsStream ? "Preparing encrypted live stream player..." : "Preparing encrypted range player...";
        await this.registerServiceWorker();
        navigator.serviceWorker.controller.postMessage({
          type: "watch-metadata",
          sessionId: this.roomId,
          metadata: plainData(playbackMetadata),
        });
        const fileName = hlsStream ? "playlist.m3u8" : encodeURIComponent(playbackMetadata.name || "video");
        const sourceVersion = encodeURIComponent(String(playbackMetadata.sourceVersion || this.sourceVersion || 0));
        const videoParams = new URLSearchParams({
          mode: hlsStream ? "hls" : "range",
          v: sourceVersion,
        });
        if (hlsStream) {
          const videoProfile = playbackMetadata.videoProfile || playbackMetadata.playbackProfile?.videoProfile || "2d";
          const stereoProcessor = playbackMetadata.stereoProcessor || playbackMetadata.playbackProfile?.stereoProcessor || "";
          const resolutionScale = playbackMetadata.resolutionScale || playbackMetadata.hls?.resolutionScale || playbackMetadata.playbackProfile?.resolutionScale || "1";
          const inferenceScale = playbackMetadata.inferenceScale || playbackMetadata.hls?.inferenceScale || playbackMetadata.playbackProfile?.inferenceScale || "1";
          const inferenceCropPercent = playbackMetadata.inferenceCropPercent ?? playbackMetadata.hls?.inferenceCropPercent ?? playbackMetadata.playbackProfile?.inferenceCropPercent ?? "0";
          if (videoProfile && videoProfile !== "2d") videoParams.set("video_profile", videoProfile);
          if (stereoProcessor) videoParams.set("stereo_processor", stereoProcessor);
          if (videoProfile && videoProfile !== "2d") {
            videoParams.set("stereo_scale", resolutionScale);
            if (stereoProcessor && stereoProcessor !== "ffmpeg-shift") {
              videoParams.set("inference_scale", inferenceScale);
              if (String(inferenceCropPercent) !== "0") videoParams.set("inference_crop", inferenceCropPercent);
            }
          }
        }
        this.videoUrl = `/watch-media/${this.roomId}/${fileName}?${videoParams.toString()}`;
        this.streamingReady = true;
        const video = await this.waitForViewerVideoElement();
        if (!video) throw new Error("The video player did not initialize. Reload the watch page and try again.");
        if (hlsStream) {
          if (!this.attachViewerHlsPlayer(video)) {
            this.receiving = false;
            return;
          }
        } else {
          video.addEventListener("loadedmetadata", () => this.applyPendingPlaybackState(100), { once: true });
          video.src = this.videoUrl;
          video.load();
        }
        this.status = hlsStream
          ? "Live stream player ready. Segments will transcode on demand."
          : "Range player ready. Playback will stay synced with the host.";
        this.logWatchEvent(hlsStream ? "hls-player-ready" : "range-player-ready", "Service worker player is ready.");
        this.notifyViewerPlayerReady();
        this.applyPendingPlaybackState(250);
        setTimeout(() => this.startMediaPrefetch(playbackMetadata), 2500);
      } catch (error) {
        this.error = serviceWorkerSetupMessage(error);
        this.receiving = false;
        this.logWatchEvent("range-player-error", this.error);
      }
    },

    shouldUseViewerProgressiveMse(playbackMetadata) {
      return this.selectedPlaybackMode === "range"
        && Boolean(playbackMetadata?.progressiveTranscode)
        && !playbackMetadata.progressiveTranscode.complete
        && Boolean(stableMp4MseMimeType(playbackMetadata.mediaInfo || this.metadata?.mediaInfo));
    },

    async startViewerProgressiveMsePlayer(playbackMetadata) {
      if (!this.channel || this.channel.readyState !== "open") {
        throw new Error("Host data channel is not connected.");
      }
      this.teardownViewerProgressiveMsePlayer();
      const mimeType = stableMp4MseMimeType(playbackMetadata.mediaInfo || this.metadata?.mediaInfo);
      if (!mimeType) throw new Error("This browser cannot play in-progress Stable MP4 streams.");
      const MediaSourceClass = mediaSourceConstructor();
      const mediaSource = new MediaSourceClass();
      const objectUrl = URL.createObjectURL(mediaSource);
      const requestId = createRequestId();
      const appender = createMediaSourceAppender(mediaSource, mimeType, (error) => {
        this.error = error.message;
        this.receiving = false;
        this.logWatchEvent("viewer-mse-error", error.message);
      }, () => document.getElementById("viewer-video-player"));
      this.viewerProgressiveMse = {
        mediaSource,
        objectUrl,
        requestId,
        appender,
      };
      this.pendingRangeMd5[requestId] = new SparkMD5.ArrayBuffer();
      this.pendingRangeBytes[requestId] = 0;
      this.videoUrl = objectUrl;
      this.streamingReady = true;
      this.status = "Preparing linear Stable MP4 player...";
      const video = await this.waitForViewerVideoElement();
      if (!video) throw new Error("The video player did not initialize. Reload the watch page and try again.");
      video.src = objectUrl;
      video.load();
      this.prepareViewerVideoMedia();
      if (!sendChannelJson(this.channel, {
        type: "range-request",
        requestId,
        start: 0,
        end: null,
        linear: true,
        sourceVersion: this.sourceVersion,
      })) {
        throw new Error("Host data channel is not connected.");
      }
      this.status = "Linear Stable MP4 player ready. Playback will start as bytes arrive.";
      this.logWatchEvent("viewer-mse-ready", "Linear Stable MP4 MSE player is ready.");
      this.notifyViewerPlayerReady();
      this.applyPendingPlaybackState(250);
    },

    async registerServiceWorker() {
      const registration = await navigator.serviceWorker.register("/bigscreen-sw.js?v=14", { scope: "/" });
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
    },

    handleWorkerMessage(event) {
      const message = event.data || {};
      if (message.mediaKind && message.mediaKind !== "watch") return;
      if (message.type === "range-request") {
        this.sendRangeRequest(message);
      } else if (message.type === "hls-segment-request") {
        this.sendHlsSegmentRequest(message);
      } else if (message.type === "range-cancel" && this.channel?.readyState === "open") {
        sendChannelJson(this.channel, {
          type: "range-cancel",
          requestId: message.requestId,
        });
      } else if (message.type === "prefetch-progress") {
        this.mediaPrefetchStatus = `Cached ${message.percent || 0}% for smooth scrubbing.`;
      } else if (message.type === "prefetch-complete") {
        this.mediaPrefetchStatus = "Video cached locally for smooth scrubbing.";
      } else if (message.type === "prefetch-error") {
        this.mediaPrefetchStatus = message.error || "Background video cache paused.";
      }
    },

    startMediaPrefetch(playbackMetadata) {
      if (!navigator.serviceWorker?.controller || !playbackMetadata) return;
      const metadata = plainData(playbackMetadata);
      const hlsStream = this.isHlsStream() || isHlsPlaybackMetadata(metadata);
      if (hlsStream) {
        const videoProfile = metadata.videoProfile || metadata.playbackProfile?.videoProfile || "2d";
        if (videoProfile && videoProfile !== "2d") {
          this.mediaPrefetchStatus = "3D segments are generated and cached on demand.";
          return;
        }
        const hls = metadata.hls || {};
        const duration = Math.max(0, Number(hls.duration || 0));
        const segmentDuration = Math.max(1, Number(hls.segmentDuration || 8));
        const segmentCount = Math.max(1, Number(hls.segmentCount || Math.ceil(duration / segmentDuration) || 1));
        navigator.serviceWorker.controller.postMessage({
          type: "prefetch-hls-segments",
          mediaKind: "watch",
          sessionId: this.roomId,
          metadata,
          startIndex: 0,
          endIndex: segmentCount - 1,
          sourceVersion: metadata.sourceVersion || this.sourceVersion || 0,
        });
        this.mediaPrefetchStatus = "Caching stream segments for smooth scrubbing.";
        return;
      }
      const totalSize = Number(metadata.size || metadata.availableModes?.range?.size || 0);
      if (!totalSize) return;
      navigator.serviceWorker.controller.postMessage({
        type: "prefetch-range",
        mediaKind: "watch",
        sessionId: this.roomId,
        metadata,
        start: 0,
        end: totalSize - 1,
        chunkSize: 512 * 1024,
        sourceVersion: metadata.sourceVersion || this.sourceVersion || 0,
      });
      this.mediaPrefetchStatus = "Caching video locally for smooth scrubbing.";
    },

    sendHlsSegmentRequest(message) {
      if (!this.channel || this.channel.readyState !== "open") {
        this.postWorkerMessage({
          type: "range-error",
          requestId: message.requestId,
          error: "Host data channel is not connected.",
        });
        return;
      }
      this.pendingHlsBytes[message.requestId] = 0;
      const metadata = this.playbackMetadata();
      if (!sendChannelJson(this.channel, {
        type: "hls-segment-request",
        requestId: message.requestId,
        segmentIndex: message.segmentIndex,
        sourceVersion: this.sourceVersion,
        videoProfile: message.videoProfile || metadata?.videoProfile || metadata?.playbackProfile?.videoProfile || "2d",
        stereoProcessor: message.stereoProcessor || metadata?.stereoProcessor || metadata?.playbackProfile?.stereoProcessor || "",
        resolutionScale: message.resolutionScale || metadata?.resolutionScale || metadata?.hls?.resolutionScale || metadata?.playbackProfile?.resolutionScale || "1",
        inferenceScale: message.inferenceScale || metadata?.inferenceScale || metadata?.hls?.inferenceScale || metadata?.playbackProfile?.inferenceScale || "1",
        inferenceCropPercent: message.inferenceCropPercent ?? metadata?.inferenceCropPercent ?? metadata?.hls?.inferenceCropPercent ?? metadata?.playbackProfile?.inferenceCropPercent ?? "0",
        prefetch: Boolean(message.prefetch),
      })) {
        this.postWorkerMessage({
          type: "range-error",
          requestId: message.requestId,
          error: "Host data channel is not connected.",
        });
      }
    },

    sendRangeRequest(message) {
      if (!this.channel || this.channel.readyState !== "open") {
        this.postWorkerMessage({
          type: "range-error",
          requestId: message.requestId,
          error: "Host data channel is not connected.",
        });
        return;
      }
      this.pendingRangeMd5[message.requestId] = new SparkMD5.ArrayBuffer();
      this.pendingRangeBytes[message.requestId] = 0;
      if (!sendChannelJson(this.channel, {
        type: "range-request",
        requestId: message.requestId,
        start: message.start,
        end: message.end,
        linear: Boolean(message.linear),
        sourceVersion: this.sourceVersion,
        prefetch: Boolean(message.prefetch),
      })) {
        this.postWorkerMessage({
          type: "range-error",
          requestId: message.requestId,
          error: "Host data channel is not connected.",
        });
      }
    },

    postWorkerMessage(message, transfer = []) {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage(message, transfer);
      }
    },

    schedulePendingVideoReconnect() {
      this.clearPendingVideoReconnect();
      this.pendingVideoRequestTimer = setTimeout(() => {
        if (!this.pendingVideoRequest || this.receiving || this.videoUrl) return;
        if (this.channel && this.channel.readyState === "open") {
          this.requestVideo();
          return;
        }
        this.status = "Host peer connection did not open. Requesting a fresh offer...";
        this.logWatchEvent("video-request-timeout", "Data channel did not open before retry timer.");
        this.reconnectToHost({ preservePendingRequest: true });
      }, 8000);
    },

    clearPendingVideoReconnect() {
      if (this.pendingVideoRequestTimer) {
        clearTimeout(this.pendingVideoRequestTimer);
        this.pendingVideoRequestTimer = null;
      }
    },

    logWatchEvent(event, detail = "") {
      if (!this.participantId) return;
      fetch(`/api/watch/rooms/${this.roomId}/participants/${this.participantId}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event,
          detail,
          channelState: this.channel?.readyState || "",
          peerState: this.peer?.connectionState || "",
          pendingVideoRequest: this.pendingVideoRequest,
          receiving: this.receiving,
        }),
      }).catch(() => {});
    },

    clearAcknowledgementError() {
      if (this.acknowledgementAccepted && this.error === "Accept the viewing acknowledgement first.") {
        this.error = "";
      }
      if (this.acknowledgementAccepted && this.status === "Check the acknowledgement box, then start the video.") {
        this.status = this.channelReady
          ? "Connected. Start the encrypted video stream when ready."
          : "Acknowledgement accepted. You can request the video while the host connection opens.";
      }
    },

    receiveButtonLabel() {
      const hlsStream = this.isHlsStream();
      const playbackMetadata = this.playbackMetadata();
      if (this.receiving) return hlsStream ? "Live stream ready" : "Range player ready";
      if (this.pendingVideoRequest) return "Retry host connection";
      if (this.videoUrl) return "Video ready";
      if (!this.acknowledgementAccepted) return "Confirm acknowledgement";
      if (hlsStream) return "Acknowledge and start live stream";
      if (playbackMetadata?.progressiveTranscode && !playbackMetadata.progressiveTranscode.complete) return "Stable MP4 preparing";
      return "Acknowledge and start streaming";
    },

    receiveDisabledReason() {
      const hlsStream = this.isHlsStream();
      const playbackMetadata = this.playbackMetadata();
      if (!hlsStream && playbackMetadata?.progressiveTranscode && !playbackMetadata.progressiveTranscode.complete) return "Stable MP4 is still preparing. Switch to Stream for immediate playback; Watch unlocks when the file is complete.";
      if (!hlsStream && !playbackMetadata?.md5 && playbackMetadata?.checksumKind !== "original-source") return "Waiting for the host to publish the required MD5 checksum.";
      if (hlsStream) return "Live stream segments transcode on demand, so the first play or a scrub may take a moment.";
      if (!this.acknowledgementAccepted) return "Check the acknowledgement box before starting the video.";
      if (this.pendingVideoRequest) return "Waiting for the host peer connection to open. File Pipe will retry automatically; click Retry to force it now.";
      if (!this.channelReady) return "You can request the video now; File Pipe will start it when the host connection opens.";
      return "";
    },

    async handleChannelMessage(event) {
      try {
        const message = await readChannelMessage(event.data);
        if (message.type === "hls-chunk") {
          if (message.sourceVersion && Number(message.sourceVersion) !== this.sourceVersion) return;
          const isPrefetch = Boolean(message.prefetch);
          const ciphertext = message.binary || base64UrlDecode(message.data || "");
          const plaintext = exactArrayBuffer(await this.decryptPayload(message.iv, ciphertext));
          const workerBytes = plaintext.slice(0);
          this.pendingHlsBytes[message.requestId] = (this.pendingHlsBytes[message.requestId] || 0) + plaintext.byteLength;
          this.receivedBytes += plaintext.byteLength;
          if (!isPrefetch && shouldUpdateChannelUi(this)) {
            this.status = `Buffered live segment ${Number(message.segmentIndex || 0) + 1}.`;
            this.updateViewerPlaybackBuffer();
          }
          this.postWorkerMessage(
            {
              type: "range-chunk",
              requestId: message.requestId,
              bytes: workerBytes,
            },
            [workerBytes],
          );
          return;
        }
        if (message.type === "hls-done") {
          if (message.sourceVersion && Number(message.sourceVersion) !== this.sourceVersion) return;
          const hlsBytes = this.pendingHlsBytes[message.requestId] || 0;
          delete this.pendingHlsBytes[message.requestId];
          if (message.sentBytes && message.sentBytes !== hlsBytes) {
            throw new Error(`Live segment ${Number(message.segmentIndex || 0) + 1} received ${hlsBytes} bytes, but host reported ${message.sentBytes} bytes.`);
          }
          this.postWorkerMessage({
            type: "range-done",
            requestId: message.requestId,
          });
          if (this.pendingSegmentSync) this.checkPendingSegmentReadiness();
          return;
        }
        if (message.type === "hls-error") {
          if (message.sourceVersion && Number(message.sourceVersion) !== this.sourceVersion) return;
          delete this.pendingHlsBytes[message.requestId];
          this.postWorkerMessage({
            type: "range-error",
            requestId: message.requestId,
            error: message.error || "Host live segment request failed.",
          });
          return;
        }
        if (message.type === "range-chunk") {
          if (message.sourceVersion && Number(message.sourceVersion) !== this.sourceVersion) return;
          const isPrefetch = Boolean(message.prefetch);
          const ciphertext = message.binary || base64UrlDecode(message.data);
          const plaintext = exactArrayBuffer(await this.decryptPayload(message.iv, ciphertext));
          const rangeMd5 = this.pendingRangeMd5[message.requestId];
          if (rangeMd5) rangeMd5.append(plaintext);
          this.pendingRangeBytes[message.requestId] = (this.pendingRangeBytes[message.requestId] || 0) + plaintext.byteLength;
          this.receivedBytes += plaintext.byteLength;
          if (!isPrefetch && shouldUpdateChannelUi(this)) {
            this.status = `Buffered encrypted range ${formatByteOffset(message.start)}-${formatByteOffset(message.end)}.`;
            this.updateViewerPlaybackBuffer();
          }
          if (this.viewerProgressiveMse?.requestId === message.requestId) {
            await this.viewerProgressiveMse.appender.append(plaintext);
            return;
          }
          const workerBytes = plaintext.slice(0);
          this.postWorkerMessage(
            {
              type: "range-chunk",
              requestId: message.requestId,
              bytes: workerBytes,
            },
            [workerBytes],
          );
          return;
        }
        if (message.type === "range-done") {
          if (message.sourceVersion && Number(message.sourceVersion) !== this.sourceVersion) return;
          const rangeMd5 = this.pendingRangeMd5[message.requestId];
          const md5 = rangeMd5 ? rangeMd5.end() : "";
          const rangeBytes = this.pendingRangeBytes[message.requestId] || 0;
          delete this.pendingRangeMd5[message.requestId];
          delete this.pendingRangeBytes[message.requestId];
          if (message.sentBytes && message.sentBytes !== rangeBytes) {
            throw new Error(`Encrypted range ${message.requestId} received ${rangeBytes} bytes, but host reported ${message.sentBytes} bytes.`);
          }
          if (message.md5 && md5 && message.md5 !== md5) {
            throw new Error(`Encrypted range ${message.requestId} failed MD5 verification. viewer=${md5} host=${message.md5} bytes=${rangeBytes}`);
          }
          if (this.viewerProgressiveMse?.requestId === message.requestId) {
            this.viewerProgressiveMse.appender.end();
            this.receiving = false;
            this.status = "Stable MP4 linear stream is complete.";
            return;
          }
          this.postWorkerMessage({
            type: "range-done",
            requestId: message.requestId,
          });
          if (this.pendingSegmentSync) this.checkPendingSegmentReadiness();
          return;
        }
        if (message.type === "range-error") {
          if (message.sourceVersion && Number(message.sourceVersion) !== this.sourceVersion) return;
          if (this.viewerProgressiveMse?.requestId === message.requestId) {
            this.viewerProgressiveMse.appender.error(message.error || "Host range request failed.");
            return;
          }
          this.postWorkerMessage({
            type: "range-error",
            requestId: message.requestId,
            error: message.error || "Host range request failed.",
          });
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
        if (message.type === "source-update") {
          this.applySourceUpdate(message);
          return;
        }
        if (message.type === "transcode-progress") {
          this.applyTranscodeProgress(message);
          return;
        }
        if (message.type === "control-permission") {
          this.remoteControlAllowed = Boolean(message.allowed);
          if (!this.remoteControlAllowed) this.clearPendingViewerControl();
          this.status = this.remoteControlAllowed
            ? "Shared playback control is enabled for you."
            : "Shared playback control is disabled for you.";
          return;
        }
        if (message.type === "control-denied") {
          this.remoteControlAllowed = false;
          this.clearPendingViewerControl();
          this.status = message.reason || "The host has not enabled playback control for you.";
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
        if (message.type === "voice-state" && message.role === "host") {
          this.handleHostVoiceState(message);
          return;
        }
        if (message.type === "voice-control") {
          this.handleVoiceControl(message);
          return;
        }
        if (message.type === "kicked") {
          this.error = message.reason || "The host removed you from this watch room.";
          this.status = "";
          this.remoteControlAllowed = false;
          if (this.channel) this.channel.close();
          if (this.peer) this.peer.close();
          this.stopHostVoiceMeter();
          this.clearStoredWatchSession();
          this.participantId = "";
          return;
        }
        if (message.type === "video-start") {
          this.teardownViewerHlsPlayer();
          this.teardownViewerProgressiveMsePlayer();
          this.detachViewerXrPlayer();
          this.detachViewerPlaybackProgress();
          this.receivedParts = [];
          this.receivedBytes = 0;
          this.verifiedMd5 = "";
          this.videoUrl = "";
          this.videoAudioStatus = "";
          this.md5 = new SparkMD5.ArrayBuffer();
          this.progress = 0;
          this.receiving = true;
          this.status = "Receiving encrypted video stream...";
          return;
        }
        if (message.type === "video-chunk") {
          const plaintext = await this.decryptPayload(message.iv, base64UrlDecode(message.data));
          this.md5.append(plaintext);
          this.receivedParts.push(plaintext);
          this.receivedBytes += plaintext.byteLength;
          this.progress = this.metadata.size
            ? Math.round((this.receivedBytes / this.metadata.size) * 100)
            : 0;
          this.status = `Receiving ${this.progress}%`;
          return;
        }
        if (message.type === "video-done") {
          const md5 = this.md5.end();
          this.logWatchEvent(
            "video-done-received",
            `viewer=${md5} host=${message.md5 || ""} expected=${message.expectedMd5 || this.metadata.md5} bytes=${this.receivedBytes}`,
          );
          if (message.expectedMd5 && message.md5 !== message.expectedMd5) {
            throw new Error(`The host streamed bytes with MD5 ${message.md5}, but the room metadata expected ${message.expectedMd5}.`);
          }
          if (message.sentBytes && message.sentBytes !== this.receivedBytes) {
            throw new Error(`The transfer ended after ${this.receivedBytes} decrypted bytes, but the host reported ${message.sentBytes} bytes.`);
          }
          if (this.metadata.checksumKind !== "original-source" && (md5 !== this.metadata.md5 || md5 !== message.md5)) {
            throw new Error(`The decrypted video MD5 ${md5} does not match the room metadata ${this.metadata.md5} or host stream ${message.md5}.`);
          }
          this.verifiedMd5 = md5;
          const blob = new Blob(this.receivedParts, { type: this.metadata.type || "video/mp4" });
          this.videoUrl = URL.createObjectURL(blob);
          this.receiving = false;
          this.progress = 100;
          this.status = "Video verified and ready. Playback will follow the host.";
          setTimeout(() => {
            this.prepareViewerVideoMedia();
          }, 0);
          this.notifyViewerPlayerReady();
          this.applyPendingPlaybackState(250);
          return;
        }
        if (message.type === "video-error") {
          throw new Error(message.error || "The host could not stream the video.");
        }
        if (message.type === "sync") {
          this.pendingSync = message;
          this.lastSyncLabel = new Date().toLocaleTimeString();
          if (this.videoUrl) this.applyPendingPlaybackState();
          else this.requestVideoIfAcknowledged();
        }
      } catch (error) {
        this.error = error.message;
        this.receiving = false;
        this.logWatchEvent("viewer-error", error.message);
      }
    },

    queueChannelMessage(event) {
      const data = event.data;
      this.channelMessageQueue = this.channelMessageQueue
        .then(() => this.handleChannelMessage({ data }))
        .catch((error) => {
          this.error = error.message;
          this.receiving = false;
          this.logWatchEvent("viewer-error", error.message);
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

    applySourceUpdate(message) {
      this.metadata = message.metadata || this.metadata;
      this.sourceVersion = Number(this.metadata?.sourceVersion || this.sourceVersion || 0);
      this.selectedPlaybackMode = this.defaultPlaybackMode();
      const contentKey = this.metadata?.contentKey || String(this.sourceVersion || "");
      if (message.requiresAcknowledgement || (this.acceptedContentKey && this.acceptedContentKey !== contentKey)) {
        this.acknowledgementAccepted = false;
        this.acceptedSourceVersion = 0;
        this.acceptedContentKey = "";
      } else if (this.acknowledgementAccepted) {
        this.acceptedSourceVersion = this.sourceVersion;
        this.acceptedContentKey = contentKey;
      }
      this.teardownViewerHlsPlayer();
      this.teardownViewerProgressiveMsePlayer();
      this.detachViewerXrPlayer();
      this.detachViewerPlaybackProgress();
      const video = document.getElementById("viewer-video-player");
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      if (this.videoUrl && this.videoUrl.startsWith("blob:")) URL.revokeObjectURL(this.videoUrl);
      this.videoUrl = "";
      this.streamingReady = false;
      this.receiving = false;
      this.receivedBytes = 0;
      this.verifiedMd5 = "";
      this.videoAudioStatus = "";
      this.progress = 0;
      this.playbackBufferSeconds = 0;
      this.playbackBufferPercent = 0;
      this.viewerLinearPlaybackTime = 0;
      this.pendingRangeMd5 = {};
      this.pendingRangeBytes = {};
      this.pendingHlsBytes = {};
      this.pendingSegmentSync = null;
      this.pendingSync = null;
      this.pendingVideoRequest = false;
      this.rangePlayerPromoted = false;
      this.status = this.acknowledgementAccepted
        ? (message.reason || "Host updated the room source.")
        : (message.reason || "Host switched video source. Confirm the new content before playback.");
      this.saveWatchSession();
      if (this.acknowledgementAccepted) {
        this.pendingVideoRequest = true;
        setTimeout(() => this.requestVideo(), 250);
      }
    },

    applyTranscodeProgress(message) {
      if (!this.metadata) return;
      const percent = Math.max(0, Math.min(100, Number(message.percent || 0)));
      const wasIncomplete = this.metadata.progressiveTranscode && !this.metadata.progressiveTranscode.complete;
      this.metadata.progressiveTranscode = {
        percent,
        availableBytes: Math.max(0, Number(message.availableBytes || 0)),
        estimatedFinalSize: Math.max(0, Number(message.estimatedFinalSize || this.metadata.progressiveTranscode?.estimatedFinalSize || this.metadata.size || 0)),
        duration: Math.max(0, Number(message.duration || this.metadata.progressiveTranscode?.duration || this.metadata.mediaInfo?.duration || 0)),
        complete: Boolean(message.complete) || percent >= 100,
      };
      if (this.metadata.availableModes?.range) {
        this.metadata.availableModes.range.progressiveTranscode = this.metadata.progressiveTranscode;
        if (this.metadata.progressiveTranscode.estimatedFinalSize) {
          this.metadata.availableModes.range.size = this.metadata.progressiveTranscode.estimatedFinalSize;
        }
      }
      this.clampViewerProgressiveSeek();
      if (this.metadata.progressiveTranscode.complete && this.selectedPlaybackMode === "range" && this.videoUrl) {
        this.status = "Stable MP4 is complete. Scrubbing is unlocked.";
        this.refreshWatchServiceWorkerMetadata();
        this.promoteCompletedViewerRangePlayer().catch((error) => {
          this.error = error.message;
        });
      }
      if (wasIncomplete && this.metadata.progressiveTranscode.complete && this.pendingVideoRequest && !this.videoUrl) {
        this.status = "Stable MP4 is ready. Starting playback...";
        setTimeout(() => this.requestVideo(), 250);
      }
    },

    clampViewerProgressiveSeek() {
      const video = document.getElementById("viewer-video-player");
      const progress = this.metadata?.progressiveTranscode;
      if (!video || !progress || progress.complete) return;
      const percent = Number(progress.percent || 0);
      if (!Number.isFinite(video.duration) || percent <= 0) return;
      const maxTime = Math.max(0, (video.duration * percent / 100) - 2);
      if (video.currentTime > maxTime) {
        this.suppressViewerControlsBriefly();
        video.currentTime = maxTime;
        this.status = `Still transcoding. Scrubbing is available up to ${Math.round(percent)}%.`;
      }
    },

    applySync(message) {
      const video = document.getElementById("viewer-video-player");
      if (!video) return;
      if (this.shouldIgnoreStaleHostSync(message)) return;
      this.clearViewerControlIfAcknowledged(message);
      this.suppressViewerControlsBriefly();
      const baseRate = message.playbackRate || 1;
      let targetTime = Number.isFinite(message.currentTime) ? Math.max(0, message.currentTime) : 0;
      if (!message.paused && Number.isFinite(message.sentAt)) {
        const apparentLatency = clamp(this.estimatedHostNow() - message.sentAt, 0, MAX_SYNC_LATENCY_COMPENSATION_MS);
        targetTime += apparentLatency / 1000 * baseRate;
      }
      const driftSeconds = targetTime - (video.currentTime || 0);
      const drift = Math.abs(driftSeconds);
      if (message.paused) {
        video.pause();
        video.playbackRate = baseRate;
        if (drift > PAUSE_SYNC_SEEK_THRESHOLD_SECONDS || message.reason === "seek" || String(message.reason || "").includes("pause")) {
          seekVideoTo(video, targetTime);
        }
        return;
      }
      const gentleTimeSync = message.reason === "time" && !message.paused;
      if (gentleTimeSync && drift > 0.25 && drift <= 1.25) {
        const nudge = Math.min(0.1, Math.max(0.025, drift * 0.06));
        video.playbackRate = clamp(baseRate + Math.sign(driftSeconds) * nudge, 0.9, 1.1);
      } else {
        const correctionThreshold = gentleTimeSync ? 1.25 : 0.35;
        if (drift > correctionThreshold || message.reason === "seek") {
          seekVideoTo(video, targetTime);
        }
        video.playbackRate = baseRate;
      }
      video.play().catch(() => {
        this.status = "Host is playing. Press play if browser autoplay is blocked.";
      });
    },

    updateViewerPlaybackBuffer() {
      const video = document.getElementById("viewer-video-player");
      if (!video || !this.videoUrl) {
        this.playbackBufferSeconds = 0;
        this.playbackBufferPercent = 0;
        return;
      }
      const currentTime = video.currentTime || 0;
      const bufferedUntil = mediaBufferedUntil(video, currentTime);
      const seconds = Number.isFinite(bufferedUntil)
        ? Math.max(0, bufferedUntil - currentTime)
        : SYNC_BUFFER_SECONDS;
      this.playbackBufferSeconds = Math.round(seconds * 10) / 10;
      this.playbackBufferPercent = Math.max(0, Math.min(100, Math.round((seconds / SYNC_BUFFER_SECONDS) * 100)));
    },

    applySyncHold(message) {
      const video = document.getElementById("viewer-video-player");
      if (!video || !this.videoUrl) {
        this.pendingSync = message;
        this.requestVideoIfAcknowledged();
        return;
      }
      this.pendingSegmentSync = message;
      this.lastSyncLabel = "Buffering segment";
      this.suppressViewerControlsBriefly();
      video.pause();
      if (Number.isFinite(message.currentTime)) {
        seekVideoTo(video, Math.max(0, message.currentTime));
      }
      const bufferSeconds = Number(message.bufferSeconds || SYNC_BUFFER_SECONDS);
      message.bufferStartedAt = Date.now();
      this.status = `Buffering ${bufferSeconds} seconds before synchronized resume.`;
      this.waitForViewerBuffer(message.syncId, message.currentTime || 0, bufferSeconds, message.bufferStartedAt);
    },

    async waitForViewerBuffer(syncId, targetTime, bufferSeconds = SYNC_BUFFER_SECONDS, startedAt = Date.now()) {
      const video = document.getElementById("viewer-video-player");
      if (!video) return;
      for (let attempt = 0; this.pendingSegmentSync?.syncId === syncId; attempt += 1) {
        if (!this.pendingSegmentSync || this.pendingSegmentSync.syncId !== syncId) return;
        if (mediaHasResumeBuffer(video, targetTime, bufferSeconds, startedAt)) {
          this.sendSegmentReady(syncId, targetTime, mediaBufferedUntil(video, targetTime));
          return;
        }
        if (attempt > 0 && attempt % 16 === 0) {
          const elapsed = Date.now() - startedAt;
          this.status = elapsed >= SYNC_RELAX_AFTER_MS
            ? "Waiting for the seek target to become playable."
            : `Still buffering ${bufferSeconds} seconds before synchronized resume.`;
        }
        await sleep(SYNC_READY_POLL_MS);
      }
    },

    checkPendingSegmentReadiness() {
      if (!this.pendingSegmentSync) return;
      const video = document.getElementById("viewer-video-player");
      const bufferSeconds = Number(this.pendingSegmentSync.bufferSeconds || SYNC_BUFFER_SECONDS);
      if (video && mediaHasResumeBuffer(
        video,
        this.pendingSegmentSync.currentTime || 0,
        bufferSeconds,
        this.pendingSegmentSync.bufferStartedAt || Date.now(),
      )) {
        this.sendSegmentReady(
          this.pendingSegmentSync.syncId,
          this.pendingSegmentSync.currentTime || 0,
          mediaBufferedUntil(video, this.pendingSegmentSync.currentTime || 0),
        );
      }
    },

    sendSegmentReady(syncId, targetTime, bufferedUntil = 0) {
      if (!this.pendingSegmentSync || this.pendingSegmentSync.syncId !== syncId) return;
      this.pendingSegmentSync = null;
      this.lastSyncLabel = "Ready";
      this.status = "Ready for synchronized playback.";
      if (this.channel?.readyState === "open") {
        sendChannelJson(this.channel, {
          type: "segment-ready",
          syncId,
          currentTime: targetTime,
          bufferedUntil,
        });
      }
      this.logWatchEvent("segment-ready", `sync=${syncId} time=${targetTime}`);
    },

    applyResumeAt(message) {
      const video = document.getElementById("viewer-video-player");
      if (!video) {
        this.pendingSync = message;
        this.requestVideoIfAcknowledged();
        return;
      }
      this.pendingSegmentSync = null;
      if (Number.isFinite(message.currentTime)) {
        this.suppressViewerControlsBriefly(1800);
        seekVideoTo(video, Math.max(0, message.currentTime));
      }
      video.playbackRate = message.playbackRate || 1;
      this.updateViewerPlaybackBuffer();
      const targetTime = Number.isFinite(message.currentTime) ? Math.max(0, message.currentTime) : video.currentTime || 0;
      const bufferSeconds = Number(message.bufferSeconds || SYNC_BUFFER_SECONDS);
      if (!mediaHasResumeBuffer(video, targetTime, bufferSeconds, Date.now() - SYNC_RELAX_AFTER_MS)) {
        this.status = `Resume delayed locally until ${bufferSeconds} seconds are buffered.`;
        this.waitForLocalResumeBuffer(message, targetTime, bufferSeconds, Date.now());
        return;
      }
      const absoluteResumeAt = Number(message.resumeAt);
      const relativeDelay = Number(message.resumeDelayMs);
      const absoluteDelay = Number.isFinite(absoluteResumeAt) ? absoluteResumeAt - this.estimatedHostNow() : NaN;
      const delay = Number.isFinite(absoluteDelay) && absoluteDelay >= -250 && absoluteDelay <= Math.max(500, relativeDelay + 750)
        ? Math.max(0, absoluteDelay)
        : Math.max(0, Number.isFinite(relativeDelay) ? relativeDelay - 350 : 0);
      this.lastSyncLabel = new Date().toLocaleTimeString();
      this.status = "Synchronized resume scheduled.";
      setTimeout(() => {
        this.suppressViewerControlsBriefly(1800);
        video.play().catch(() => {
          this.status = "Host resumed. Press play if browser autoplay is blocked.";
        });
        this.updateViewerPlaybackBuffer();
      }, delay);
    },

    async waitForLocalResumeBuffer(message, targetTime, bufferSeconds, startedAt = Date.now()) {
      const video = document.getElementById("viewer-video-player");
      if (!video) return;
      while (this.channel?.readyState === "open" && !mediaHasResumeBuffer(video, targetTime, bufferSeconds, startedAt)) {
        await sleep(SYNC_READY_POLL_MS);
      }
      this.applyResumeAt({
        ...message,
        resumeDelayMs: 0,
        resumeAt: Date.now(),
      });
    },

    applyPendingPlaybackState(delay = 0) {
      const run = () => {
        if (!this.pendingSync || !this.videoUrl) return;
        const message = this.pendingSync;
        this.pendingSync = null;
        if (message.type === "sync-hold") {
          this.applySyncHold(message);
          return;
        }
        if (message.type === "resume-at") {
          this.applyResumeAt(message);
          return;
        }
        this.applySync(message);
      };
      if (delay > 0) {
        setTimeout(run, delay);
      } else {
        run();
      }
    },

    requestVideoIfAcknowledged() {
      if (!this.acknowledgementAccepted || this.videoUrl || this.receiving || this.pendingVideoRequest) return;
      if (!this.channel || this.channel.readyState !== "open") {
        this.pendingVideoRequest = true;
        this.schedulePendingVideoReconnect();
        return;
      }
      this.pendingVideoRequest = true;
      setTimeout(() => this.requestVideo(), 100);
    },

    notifyViewerPlayerReady() {
      if (this.channel?.readyState !== "open") return;
      this.suppressViewerControlsBriefly(1500);
      sendChannelJson(this.channel, {
        type: "viewer-player-ready",
        mode: this.selectedPlaybackMode || this.defaultPlaybackMode(),
        sourceVersion: this.sourceVersion,
      });
      this.publishViewerPlaybackState("viewer-ready");
    },

    participantAudioOutputLink(channel = "LFE") {
      const keyText = new URLSearchParams(window.location.hash.slice(1)).get("key") || "";
      if (!this.participantId || !keyText) return "";
      const params = new URLSearchParams({
        key: keyText,
        target: this.participantId,
        channel,
        targetName: this.viewerName || "Participant",
      });
      return `${window.location.origin}/watch-audio/${this.roomId}#${params.toString()}`;
    },

    async createParticipantAudioOutputLink(channel = "LFE") {
      this.error = "";
      if (!this.participantId) {
        this.audioOutputStatus = "Join the room before creating an audio output link.";
        return;
      }
      try {
        await this.appJson(`/api/watch/rooms/${this.roomId}/participants/${this.participantId}`);
        this.audioOutputLink = this.participantAudioOutputLink(channel);
        this.audioOutputStatus = `${channel} audio output link ready. Open it on the browser connected to the audio device.`;
      } catch (error) {
        if (error.status === 404) {
          this.audioOutputLink = "";
          this.audioOutputStatus = "This watch room is no longer active. Reload the current watch link from the host, then create a fresh audio output link.";
          return;
        }
        this.audioOutputStatus = error.message;
      }
    },

    async copyToClipboard(text) {
      if (!text) return;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const input = document.createElement("input");
          input.value = text;
          document.body.appendChild(input);
          input.select();
          document.execCommand("copy");
          input.remove();
        }
        this.audioOutputStatus = "Audio output link copied.";
      } catch (error) {
        this.audioOutputStatus = "Could not copy the link. Select it and copy manually.";
      }
    },

    refreshWatchServiceWorkerMetadata() {
      if (!navigator.serviceWorker?.controller || !this.metadata) return;
      navigator.serviceWorker.controller.postMessage({
        type: "watch-metadata",
        sessionId: this.roomId,
        metadata: plainData(this.playbackMetadata()),
      });
    },

    async promoteCompletedViewerRangePlayer() {
      if (this.rangePlayerPromoted || this.selectedPlaybackMode !== "range" || !this.videoUrl) return;
      const video = document.getElementById("viewer-video-player");
      if (!video) return;
      this.rangePlayerPromoted = true;
      const currentTime = video.currentTime || 0;
      const wasPaused = video.paused;
      const playbackRate = video.playbackRate || 1;
      this.suppressViewerControlsBriefly(2500);
      this.teardownViewerProgressiveMsePlayer();
      await this.registerServiceWorker();
      this.refreshWatchServiceWorkerMetadata();
      const playbackMetadata = this.playbackMetadata();
      const fileName = encodeURIComponent(playbackMetadata.name || "video");
      const sourceVersion = encodeURIComponent(String(playbackMetadata.sourceVersion || this.sourceVersion || 0));
      this.videoUrl = `/watch-media/${this.roomId}/${fileName}?mode=range&v=${sourceVersion}&complete=${Date.now()}`;
      setTimeout(() => {
        const promoted = document.getElementById("viewer-video-player");
        if (!promoted) return;
        promoted.playbackRate = playbackRate;
        const restorePosition = () => {
          seekVideoTo(promoted, currentTime);
          if (!wasPaused) {
            playVideoWhenReady(promoted, 10000).catch(() => {});
          }
        };
        if (promoted.readyState === HTMLMediaElement.HAVE_NOTHING) {
          promoted.addEventListener("loadedmetadata", restorePosition, { once: true });
          promoted.load();
        } else {
          restorePosition();
        }
      }, 0);
    },

    async decryptPayload(ivText, ciphertext) {
      return crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64UrlDecode(ivText) },
        this.key,
        ciphertext,
      );
    },

    formatBytes(bytes) {
      if (!bytes) return "Unknown size";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let size = Number(bytes);
      let unit = 0;
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
      }
      return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
    },
  }));
});
