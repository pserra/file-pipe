const WATCH_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const WATCH_SESSION_STORAGE_PREFIX = "filePipeWatchSession:";

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
    acknowledgementAccepted: false,
    pendingVideoRequest: false,
    pendingVideoRequestTimer: null,
    receiving: false,
    receivedBytes: 0,
    verifiedMd5: "",
    videoUrl: "",
    viewerHls: null,
    viewerXrPlayer: null,
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
    viewerSeekControlTimer: null,
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
      if (["range", "hls"].includes(session.selectedPlaybackMode)) {
        this.selectedPlaybackMode = session.selectedPlaybackMode;
      }
      this.acknowledgementAccepted = Boolean(session.acknowledgementAccepted);
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
      return result;
    },

    canSwitchPlaybackModes() {
      return this.availablePlaybackModes().length > 1;
    },

    isPlaybackModeAvailable(mode) {
      return Boolean(this.availablePlaybackModes().find((item) => item.id === mode && !item.disabled));
    },

    playbackModeLabel() {
      return this.selectedPlaybackMode === "hls" ? "Stream" : "Watch";
    },

    playbackModeHelpText() {
      const selected = this.availablePlaybackModes().find((mode) => mode.id === this.selectedPlaybackMode);
      if (selected?.description) return selected.description;
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

    async waitForOfferAndAnswer() {
      for (let attempt = 0; attempt < 300; attempt += 1) {
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
          this.status = "Connected. Confirm the acknowledgement to receive video.";
          this.clearPendingVideoReconnect();
          this.logWatchEvent("channel-open", "Data channel opened.");
          this.publishViewerVoiceState("channel-open");
          this.publishViewerMediaCapabilities("channel-open");
          if (this.pendingVideoRequest) {
            this.requestVideo();
          }
        };
        this.channelMessageQueue = Promise.resolve();
        this.channel.onmessage = (eventMessage) => this.queueChannelMessage(eventMessage);
        this.channel.onclose = () => {
          this.channelReady = false;
          this.status = "Host disconnected. Requesting a fresh peer connection...";
          this.logWatchEvent("channel-close", "Data channel closed.");
          setTimeout(() => this.reconnectToHost({ preservePendingRequest: this.pendingVideoRequest }), 1500);
        };
      };
      this.peer.onconnectionstatechange = () => {
        this.logWatchEvent("peer-state", this.peer.connectionState);
        if (["failed", "disconnected"].includes(this.peer.connectionState)) {
          this.channelReady = false;
          this.status = "Peer connection interrupted. Requesting recovery...";
          setTimeout(() => this.reconnectToHost({ preservePendingRequest: this.pendingVideoRequest }), 1500);
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
        await this.waitForOfferAndAnswer();
        this.recoveryStatus = "Reconnected to signaling. Waiting for peer connection.";
        this.logWatchEvent("reconnect-complete", "Fresh answer published.");
        if (this.pendingVideoRequest) this.schedulePendingVideoReconnect();
      } catch (error) {
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
        this.error = error.message;
        this.logWatchEvent("reconnect-error", error.message);
      } finally {
        this.reconnecting = false;
      }
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
    },

    prepareViewerVideoMedia() {
      const video = document.getElementById("viewer-video-player");
      if (!video) return;
      video.muted = false;
      video.volume = this.mediaVolume;
      this.attachViewerXrPlayer(video);
      this.setViewerAudioOutput();
      this.inspectViewerVideoAudio();
    },

    attachViewerHlsPlayer(video = document.getElementById("viewer-video-player")) {
      if (!video || !this.videoUrl) return false;
      this.teardownViewerHlsPlayer();
      if (window.Hls?.isSupported?.()) {
        this.viewerHls = new Hls(hlsBufferConfig());
        this.viewerHls.on(Hls.Events.ERROR, (_event, data) => {
          if (this.recoverViewerHlsAppendError(data)) return;
          if (data?.fatal) {
            this.error = data.details || "The live stream player failed.";
            this.status = "";
          }
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
      this.viewerXrPlayer = window.FilePipeXrPlayer.attach(video, {
        panelSelector: ".xr-side-panel",
        storageKey: "filePipeViewerXrPlayer",
      });
    },

    detachViewerXrPlayer() {
      if (!this.viewerXrPlayer) return;
      this.viewerXrPlayer.dispose();
      this.viewerXrPlayer = null;
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
        this.videoUrl = `/watch-media/${this.roomId}/${fileName}?mode=${hlsStream ? "hls" : "range"}&v=${sourceVersion}`;
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
      const registration = await navigator.serviceWorker.register("/bigscreen-sw.js?v=9", { scope: "/" });
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
      }
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
      if (!sendChannelJson(this.channel, {
        type: "hls-segment-request",
        requestId: message.requestId,
        segmentIndex: message.segmentIndex,
        sourceVersion: this.sourceVersion,
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
          const ciphertext = message.binary || base64UrlDecode(message.data || "");
          const plaintext = exactArrayBuffer(await this.decryptPayload(message.iv, ciphertext));
          const workerBytes = plaintext.slice(0);
          this.pendingHlsBytes[message.requestId] = (this.pendingHlsBytes[message.requestId] || 0) + plaintext.byteLength;
          this.receivedBytes += plaintext.byteLength;
          if (shouldUpdateChannelUi(this)) {
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
          const ciphertext = message.binary || base64UrlDecode(message.data);
          const plaintext = exactArrayBuffer(await this.decryptPayload(message.iv, ciphertext));
          const rangeMd5 = this.pendingRangeMd5[message.requestId];
          if (rangeMd5) rangeMd5.append(plaintext);
          this.pendingRangeBytes[message.requestId] = (this.pendingRangeBytes[message.requestId] || 0) + plaintext.byteLength;
          this.receivedBytes += plaintext.byteLength;
          if (shouldUpdateChannelUi(this)) {
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

    applySourceUpdate(message) {
      this.metadata = message.metadata || this.metadata;
      this.sourceVersion = Number(this.metadata?.sourceVersion || this.sourceVersion || 0);
      this.selectedPlaybackMode = this.defaultPlaybackMode();
      this.teardownViewerHlsPlayer();
      this.teardownViewerProgressiveMsePlayer();
      this.detachViewerXrPlayer();
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
      this.rangePlayerPromoted = false;
      this.status = message.reason || "Host switched video source for compatibility.";
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
        const apparentLatency = clamp(Date.now() - message.sentAt, 0, MAX_SYNC_LATENCY_COMPENSATION_MS);
        targetTime += apparentLatency / 1000 * baseRate;
      }
      const driftSeconds = targetTime - (video.currentTime || 0);
      const drift = Math.abs(driftSeconds);
      const gentleTimeSync = message.reason === "time" && !message.paused;
      if (gentleTimeSync && drift > 0.75 && drift <= 3.5) {
        const nudge = Math.min(0.08, Math.max(0.025, drift * 0.035));
        video.playbackRate = clamp(baseRate + Math.sign(driftSeconds) * nudge, 0.92, 1.08);
      } else {
        const correctionThreshold = gentleTimeSync ? 3.5 : 0.5;
        if (drift > correctionThreshold || message.reason === "seek") {
          seekVideoTo(video, targetTime);
        }
        video.playbackRate = baseRate;
      }
      if (message.paused) {
        video.pause();
      } else {
        video.play().catch(() => {
          this.status = "Host is playing. Press play if browser autoplay is blocked.";
        });
      }
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
      const relativeDelay = Number(message.resumeDelayMs);
      const delay = Number.isFinite(relativeDelay)
        ? Math.max(0, relativeDelay)
        : Math.max(0, Number(message.resumeAt || Date.now()) - Date.now());
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

const P2P_CONFIG = {
  ...(window.FILE_PIPE_P2P_CONFIG || { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }),
};

function p2pConfigHasTurn(config = P2P_CONFIG) {
  return (config.iceServers || []).some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((url) => String(url || "").startsWith("turn:") || String(url || "").startsWith("turns:"));
  });
}

const CHANNEL_UI_UPDATE_INTERVAL_MS = 500;
const MSE_MAX_BUFFER_AHEAD_SECONDS = 24;
const MSE_BACK_BUFFER_SECONDS = 8;
const SYNC_BUFFER_SECONDS = 3;
const SYNC_RELAXED_BUFFER_SECONDS = 1;
const SYNC_RELAX_AFTER_MS = 3500;
const SYNC_FORCE_AFTER_MS = 7000;
const SYNC_READY_POLL_MS = 250;
const SEEK_CONTROL_DEBOUNCE_MS = 450;
const MAX_SYNC_LATENCY_COMPENSATION_MS = 1500;

async function readChannelMessage(data) {
  if (typeof data === "string") return JSON.parse(data);
  const buffer = data instanceof ArrayBuffer
    ? data
    : typeof Blob !== "undefined" && data instanceof Blob
      ? await data.arrayBuffer()
      : exactArrayBuffer(data);
  const view = new DataView(buffer);
  const headerLength = view.getUint32(0);
  const headerStart = 4;
  const payloadStart = headerStart + headerLength;
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, headerStart, headerLength)));
  header.binary = buffer.slice(payloadStart);
  return header;
}

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function detectMediaAudio(video) {
  if (video.audioTracks) {
    return { known: true, hasAudio: video.audioTracks.length > 0 };
  }
  if (typeof video.mozHasAudio === "boolean") {
    return { known: true, hasAudio: video.mozHasAudio };
  }
  if (typeof video.webkitAudioDecodedByteCount === "number" && video.webkitAudioDecodedByteCount > 0) {
    return { known: true, hasAudio: true };
  }
  return { known: false, hasAudio: false };
}

function sendChannelJson(channel, payload) {
  if (channel?.readyState !== "open") return false;
  try {
    channel.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    if (
      error?.name === "InvalidStateError"
      || String(error?.message || "").includes("RTCDataChannel.readyState")
      || String(error?.message || "").includes("readyState is not 'open'")
    ) {
      return false;
    }
    throw error;
  }
}

function shouldUpdateChannelUi(target, intervalMs = CHANNEL_UI_UPDATE_INTERVAL_MS) {
  const now = Date.now();
  if (now - Number(target.lastChannelUiUpdate || 0) < intervalMs) return false;
  target.lastChannelUiUpdate = now;
  return true;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function seekVideoTo(video, targetTime) {
  if (!video) return;
  const target = Math.max(0, Number(targetTime || 0));
  const apply = () => {
    try {
      const duration = Number.isFinite(video.duration) ? video.duration : null;
      video.currentTime = duration ? Math.min(target, Math.max(0, duration - 0.05)) : target;
    } catch (error) {
      // Some mobile browsers reject seeks before metadata is ready; retry when it is.
    }
  };
  if (video.readyState === HTMLMediaElement.HAVE_NOTHING) {
    video.addEventListener("loadedmetadata", apply, { once: true });
  } else {
    apply();
  }
}

function playVideoWhenReady(video, timeoutMs = 5000, options = {}) {
  if (!video) return Promise.reject(new Error("Video element is unavailable."));
  const tryPlay = () => video.play();
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return tryPlay();
  }
  if (options.load !== false) video.load();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
      clearTimeout(timer);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onReady = () => {
      tryPlay().then(
        () => finish(resolve),
        (error) => finish(reject, error),
      );
    };
    const onError = () => finish(reject, new Error("Video failed while loading."));
    const timer = setTimeout(() => finish(reject, new Error("Timed out waiting for video data.")), timeoutMs);
    video.addEventListener("canplay", onReady, { once: true });
    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

function hlsBufferConfig() {
  return {
    enableWorker: true,
    lowLatencyMode: false,
    startFragPrefetch: true,
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    backBufferLength: 30,
    maxBufferHole: 0.75,
    appendErrorMaxRetry: 20,
    fragLoadingMaxRetry: 8,
    fragLoadingRetryDelay: 500,
    fragLoadingMaxRetryTimeout: 8000,
  };
}

function mediaSourceConstructor() {
  return window.MediaSource || window.ManagedMediaSource || null;
}

function stableMp4MseMimeType(mediaInfo = {}) {
  const MediaSourceClass = mediaSourceConstructor();
  if (!MediaSourceClass?.isTypeSupported) return "";
  const hasAudio = Boolean(mediaInfo?.defaultAudio || mediaInfo?.audio?.length || mediaInfo?.audioTracks?.length);
  const candidates = hasAudio
    ? [
        'video/mp4; codecs="avc1.4d4029, mp4a.40.2"',
        'video/mp4; codecs="avc1.4d401f, mp4a.40.2"',
        'video/mp4; codecs="avc1.42e01e, mp4a.40.2"',
      ]
    : [
        'video/mp4; codecs="avc1.4d4029"',
        'video/mp4; codecs="avc1.4d401f"',
        'video/mp4; codecs="avc1.42e01e"',
      ];
  candidates.push("video/mp4");
  return candidates.find((candidate) => MediaSourceClass.isTypeSupported(candidate)) || "";
}

function createMediaSourceAppender(mediaSource, mimeType, onError, mediaElementProvider = () => null) {
  let sourceBuffer = null;
  let opening = true;
  let closed = false;
  let chain = Promise.resolve();

  const openPromise = new Promise((resolve, reject) => {
    const open = () => {
      if (closed) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        opening = false;
        resolve(sourceBuffer);
      } catch (error) {
        reject(error);
      }
    };
    if (mediaSource.readyState === "open") open();
    else mediaSource.addEventListener("sourceopen", open, { once: true });
  });

  const enqueue = (task) => {
    chain = chain.then(task).catch((error) => {
      if (!closed && onError) onError(error);
    });
    return chain;
  };

  return {
    append(buffer) {
      const chunk = exactArrayBuffer(buffer);
      return enqueue(async () => {
        if (closed || !chunk.byteLength) return;
        const bufferRef = sourceBuffer || await openPromise;
        await appendSourceBuffer(bufferRef, chunk, mediaElementProvider());
      });
    },
    end() {
      enqueue(async () => {
        if (closed) return;
        await openPromise;
        if (mediaSource.readyState === "open" && !sourceBuffer?.updating) {
          try {
            mediaSource.endOfStream();
          } catch {
            // The media source may already be closing after the final append.
          }
        }
      });
    },
    error(message) {
      if (onError) onError(new Error(message));
      this.abort();
    },
    abort() {
      closed = true;
      if (opening && mediaSource.readyState === "closed") return;
      if (mediaSource.readyState === "open") {
        try {
          mediaSource.endOfStream("network");
        } catch {
          // Ignore abort races while the element is detaching.
        }
      }
    },
  };
}

async function appendSourceBuffer(sourceBuffer, buffer, mediaElement = null) {
  const chunk = exactArrayBuffer(buffer);
  while (true) {
    await waitForMseAppendBudget(sourceBuffer, mediaElement);
    try {
      await appendSourceBufferOnce(sourceBuffer, chunk);
      return;
    } catch (error) {
      if (!isMseQuotaError(error)) throw error;
      const evicted = await evictMseBackBuffer(sourceBuffer, mediaElement);
      if (!evicted) await sleep(500);
    }
  }
}

function appendSourceBufferOnce(sourceBuffer, buffer) {
  return new Promise((resolve, reject) => {
    if (!sourceBuffer || sourceBuffer.updating || sourceBuffer.removed) {
      reject(new Error("Stable MP4 SourceBuffer is unavailable."));
      return;
    }
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", onUpdateEnd);
      sourceBuffer.removeEventListener("error", onError);
    };
    const onUpdateEnd = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Browser could not append Stable MP4 bytes."));
    };
    try {
      sourceBuffer.addEventListener("updateend", onUpdateEnd, { once: true });
      sourceBuffer.addEventListener("error", onError, { once: true });
      sourceBuffer.appendBuffer(buffer);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function waitForMseAppendBudget(sourceBuffer, mediaElement) {
  while (mediaElement && sourceBuffer?.buffered?.length) {
    const ahead = mseBufferedAhead(sourceBuffer, mediaElement.currentTime || 0);
    if (ahead <= MSE_MAX_BUFFER_AHEAD_SECONDS) return;
    await sleep(250);
  }
}

async function evictMseBackBuffer(sourceBuffer, mediaElement) {
  if (!sourceBuffer || sourceBuffer.updating || !mediaElement) return false;
  const removeEnd = Math.max(0, (mediaElement.currentTime || 0) - MSE_BACK_BUFFER_SECONDS);
  if (removeEnd <= 0) return false;
  return new Promise((resolve) => {
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", onDone);
      sourceBuffer.removeEventListener("error", onDone);
    };
    const onDone = () => {
      cleanup();
      resolve(true);
    };
    try {
      sourceBuffer.addEventListener("updateend", onDone, { once: true });
      sourceBuffer.addEventListener("error", onDone, { once: true });
      sourceBuffer.remove(0, removeEnd);
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

function mseBufferedAhead(sourceBuffer, currentTime) {
  for (let index = 0; index < sourceBuffer.buffered.length; index += 1) {
    const start = sourceBuffer.buffered.start(index);
    const end = sourceBuffer.buffered.end(index);
    if (start <= currentTime + 0.25 && end >= currentTime) return end - currentTime;
  }
  return 0;
}

function isMseQuotaError(error) {
  return error?.name === "QuotaExceededError" || String(error?.message || "").toLowerCase().includes("sourcebuffer is full");
}

function isRecoverableHlsAppendError(data) {
  const detail = String(data?.details || data?.error?.message || data?.reason || "").toLowerCase();
  return Boolean(data?.fatal) && (detail.includes("append") || detail.includes("sourcebuffer") || detail.includes("buffer"));
}

function createRequestId() {
  return crypto.getRandomValues(new Uint32Array(4)).join("-");
}

function formatByteOffset(value) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value || 0);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function mediaBufferedUntil(video, targetTime) {
  if (!video) return 0;
  const target = Math.max(0, Number(targetTime || 0));
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (start <= target + 0.25 && end >= target) return end;
  }
  if (video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
    return Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
  }
  return 0;
}

function mediaHasBufferedTarget(video, targetTime, secondsAhead) {
  const target = Math.max(0, Number(targetTime || 0));
  const seconds = Math.max(0, Number(secondsAhead || 0));
  const duration = Number.isFinite(video?.duration) ? video.duration : Number.POSITIVE_INFINITY;
  const requiredEnd = Math.min(duration, target + seconds);
  return mediaBufferedUntil(video, target) >= requiredEnd;
}

function mediaHasCurrentTarget(video, targetTime) {
  const target = Math.max(0, Number(targetTime || 0));
  if (video?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && Math.abs((video.currentTime || 0) - target) < 0.75) {
    return true;
  }
  return mediaBufferedUntil(video, target) >= target;
}

function mediaHasResumeBuffer(video, targetTime, secondsAhead, startedAt) {
  if (mediaHasBufferedTarget(video, targetTime, secondsAhead)) return true;
  const elapsed = Date.now() - Number(startedAt || Date.now());
  if (elapsed >= SYNC_RELAX_AFTER_MS && mediaHasBufferedTarget(video, targetTime, SYNC_RELAXED_BUFFER_SECONDS)) return true;
  if (elapsed >= SYNC_FORCE_AFTER_MS && mediaHasCurrentTarget(video, targetTime)) return true;
  return false;
}

function detectMediaPlaybackCapabilities() {
  const video = document.createElement("video");
  const canPlay = (tests) => tests.some((type) => {
    const result = video.canPlayType(type);
    return result === "probably" || result === "maybe";
  });
  return {
    videoCodecs: {
      h264: canPlay([
        'video/mp4; codecs="avc1.42E01E"',
        'video/mp4; codecs="avc1.4D401E"',
      ]),
      hevc: canPlay([
        'video/mp4; codecs="hvc1"',
        'video/mp4; codecs="hev1"',
        'video/mp4; codecs="hvc1.1.6.L93.B0"',
      ]),
    },
    audioCodecs: {
      aac: canPlay(['audio/mp4; codecs="mp4a.40.2"', 'video/mp4; codecs="mp4a.40.2"']),
      mp3: canPlay(['audio/mpeg', 'audio/mp3']),
    },
    containers: {
      mp4: canPlay(["video/mp4"]),
      hls: canPlay(["application/vnd.apple.mpegurl"]) || Boolean(window.Hls?.isSupported?.()),
    },
  };
}

async function requestAudioInputStream(deviceId) {
  const selectedDeviceId = String(deviceId || "").trim();
  if (!selectedDeviceId) {
    return {
      stream: await navigator.mediaDevices.getUserMedia({ audio: true }),
      deviceId: "",
      usedFallback: false,
    };
  }
  try {
    return {
      stream: await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: selectedDeviceId } } }),
      deviceId: selectedDeviceId,
      usedFallback: false,
    };
  } catch (error) {
    if (!isRecoverableAudioConstraintError(error)) throw error;
    return {
      stream: await navigator.mediaDevices.getUserMedia({ audio: true }),
      deviceId: "",
      usedFallback: true,
    };
  }
}

function isRecoverableAudioConstraintError(error) {
  const name = error?.name || "";
  const message = String(error?.message || "").toLowerCase();
  return [
    "OverconstrainedError",
    "ConstraintNotSatisfiedError",
    "NotFoundError",
    "TypeError",
  ].includes(name) || message.includes("invalid constraint") || message.includes("device");
}

function isRecoverableAudioOutputError(error) {
  const name = error?.name || "";
  const message = String(error?.message || "").toLowerCase();
  return [
    "NotFoundError",
    "OverconstrainedError",
    "ConstraintNotSatisfiedError",
    "TypeError",
  ].includes(name) || message.includes("invalid") || message.includes("device");
}

function createVoiceActivityMeter(stream, onLevel, onError) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || !stream) return { stop() {} };
  let context;
  let source;
  let frame = 0;
  try {
    context = new AudioContextClass();
    source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / samples.length);
      onLevel(clamp(rms * 3.5, 0, 1));
      frame = requestAnimationFrame(tick);
    };
    context.resume?.().catch(() => {});
    tick();
  } catch (error) {
    if (onError) onError(error);
  }
  return {
    stop() {
      if (frame) cancelAnimationFrame(frame);
      if (source) source.disconnect();
      if (context && context.state !== "closed") context.close().catch(() => {});
      onLevel(0);
    },
  };
}

function plainData(value) {
  return JSON.parse(JSON.stringify(value));
}

function serviceWorkerSetupMessage(error) {
  const message = error?.message || String(error);
  if (message.toLowerCase().includes("certificate")) {
    return `${message} Trust the File Pipe local HTTPS certificate on this device, or serve File Pipe with a publicly trusted HTTPS certificate. Browsers will not install service workers over an untrusted certificate.`;
  }
  return message;
}

async function waitForIceGatheringComplete(peer) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", checkState);
      resolve();
    }, 10000);
    const checkState = () => {
      if (peer.iceGatheringState === "complete") {
        clearTimeout(timeout);
        peer.removeEventListener("icegatheringstatechange", checkState);
        resolve();
      }
    };
    peer.addEventListener("icegatheringstatechange", checkState);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
