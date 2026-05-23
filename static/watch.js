document.addEventListener("alpine:init", () => {
  Alpine.data("watchRoom", (roomId) => ({
    roomId,
    viewerName: "",
    participantId: "",
    key: null,
    metadata: null,
    sourceVersion: 0,
    peer: null,
    channel: null,
    channelMessageQueue: Promise.resolve(),
    channelReady: false,
    remoteControlAllowed: false,
    suppressViewerControlEvents: false,
    acknowledgementAccepted: false,
    pendingVideoRequest: false,
    pendingVideoRequestTimer: null,
    receiving: false,
    receivedBytes: 0,
    verifiedMd5: "",
    videoUrl: "",
    viewerXrPlayer: null,
    streamingReady: false,
    videoAudioStatus: "",
    progress: 0,
    playbackBufferSeconds: 0,
    playbackBufferPercent: 0,
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
    pendingSegmentSync: null,
    viewerSeekControlTimer: null,
    error: "",

    initWatchRoom() {
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
        throw new Error(message);
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
        this.status = "Enter your name to join the room.";
      } catch (error) {
        this.error = error.message;
        this.status = "";
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
        if (participant.kicked) throw new Error("The host removed you from this watch room.");
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
      this.logWatchEvent("answer-sent", "Published WebRTC answer.");
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
        if (!response.ok) throw new Error(payload.error || `Reconnect failed: ${response.status}`);
        this.status = "Reconnect requested. Waiting for host offer...";
        await this.waitForOfferAndAnswer();
        this.recoveryStatus = "Reconnected to signaling. Waiting for peer connection.";
        this.logWatchEvent("reconnect-complete", "Fresh answer published.");
        if (this.pendingVideoRequest) this.schedulePendingVideoReconnect();
      } catch (error) {
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

    sendViewerControl(action) {
      if (this.suppressViewerControlEvents) return;
      if (!this.videoUrl || !["play", "pause", "seek"].includes(action)) return;
      const video = document.getElementById("viewer-video-player");
      if (!video) return;
      if (!this.remoteControlAllowed) {
        this.status = "Shared playback control is not enabled for you right now.";
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
      this.status = "Sent playback control to host.";
    },

    scheduleViewerSeekControl(video) {
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
        this.status = "Sent scrub position to host.";
      }, SEEK_CONTROL_DEBOUNCE_MS);
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
        this.status = "Range streaming is already active.";
        return;
      }
      if (this.videoUrl) {
        this.status = "Range player is already ready.";
        return;
      }
      if (!this.acknowledgementAccepted) this.acknowledgementAccepted = true;
      if (!this.metadata?.md5 && this.metadata?.checksumKind !== "original-source") {
        this.error = "The host has not published an MD5 for this video yet.";
        this.logWatchEvent("video-request-blocked", "Missing MD5 metadata.");
        return;
      }
      if (this.metadata?.progressiveTranscode && !this.metadata.progressiveTranscode.complete) {
        this.pendingVideoRequest = true;
        this.error = "";
        const percent = Math.round(Number(this.metadata.progressiveTranscode.percent || 0));
        this.status = percent > 0
          ? `Stable MP4 is still transcoding (${percent}%). Playback will start when it is ready.`
          : "Stable MP4 is still transcoding. Playback will start when it is ready.";
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
        this.progress = 0;
        this.status = "Preparing encrypted range player...";
        await this.registerServiceWorker();
        navigator.serviceWorker.controller.postMessage({
          type: "watch-metadata",
          sessionId: this.roomId,
          metadata: plainData(this.metadata),
        });
        const fileName = encodeURIComponent(this.metadata.name || "video");
        this.videoUrl = `/watch-media/${this.roomId}/${fileName}`;
        this.streamingReady = true;
        await sleep(0);
        const video = document.getElementById("viewer-video-player");
        if (video) {
          video.src = this.videoUrl;
          video.load();
        }
        this.status = "Range player ready. Playback will stay synced with the host.";
        this.logWatchEvent("range-player-ready", "Service worker range player is ready.");
        if (this.pendingSync) setTimeout(() => this.applySync(this.pendingSync), 250);
      } catch (error) {
        this.error = serviceWorkerSetupMessage(error);
        this.receiving = false;
        this.logWatchEvent("range-player-error", this.error);
      }
    },

    async registerServiceWorker() {
      const registration = await navigator.serviceWorker.register("/bigscreen-sw.js?v=3", { scope: "/" });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
          registration.active?.postMessage({ type: "claim" });
          setTimeout(resolve, 1500);
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
      } else if (message.type === "range-cancel" && this.channel?.readyState === "open") {
        sendChannelJson(this.channel, {
          type: "range-cancel",
          requestId: message.requestId,
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
      if (this.receiving) return "Range player ready";
      if (this.metadata?.progressiveTranscode && !this.metadata.progressiveTranscode.complete) return "Waiting for Stable MP4";
      if (this.pendingVideoRequest) return "Retry host connection";
      if (this.videoUrl) return "Video ready";
      if (!this.acknowledgementAccepted) return "Confirm acknowledgement";
      return "Acknowledge and start streaming";
    },

    receiveDisabledReason() {
      if (!this.metadata?.md5 && this.metadata?.checksumKind !== "original-source") return "Waiting for the host to publish the required MD5 checksum.";
      if (this.metadata?.progressiveTranscode && !this.metadata.progressiveTranscode.complete) return "The host is still preparing the Stable MP4 stream. Playback will start automatically when it is ready.";
      if (!this.acknowledgementAccepted) return "Check the acknowledgement box before starting the video.";
      if (this.pendingVideoRequest) return "Waiting for the host peer connection to open. File Pipe will retry automatically; click Retry to force it now.";
      if (!this.channelReady) return "You can request the video now; File Pipe will start it when the host connection opens.";
      return "";
    },

    async handleChannelMessage(event) {
      try {
        const message = await readChannelMessage(event.data);
        if (message.type === "range-chunk") {
          if (message.sourceVersion && Number(message.sourceVersion) !== this.sourceVersion) return;
          const ciphertext = message.binary || base64UrlDecode(message.data);
          const plaintext = exactArrayBuffer(await this.decryptPayload(message.iv, ciphertext));
          const workerBytes = plaintext.slice(0);
          const rangeMd5 = this.pendingRangeMd5[message.requestId];
          if (rangeMd5) rangeMd5.append(plaintext);
          this.pendingRangeBytes[message.requestId] = (this.pendingRangeBytes[message.requestId] || 0) + plaintext.byteLength;
          this.receivedBytes += plaintext.byteLength;
          if (shouldUpdateChannelUi(this)) {
            this.status = `Buffered encrypted range ${formatByteOffset(message.start)}-${formatByteOffset(message.end)}.`;
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
          this.postWorkerMessage({
            type: "range-done",
            requestId: message.requestId,
          });
          if (this.pendingSegmentSync) this.checkPendingSegmentReadiness();
          return;
        }
        if (message.type === "range-error") {
          if (message.sourceVersion && Number(message.sourceVersion) !== this.sourceVersion) return;
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
          this.status = this.remoteControlAllowed
            ? "Shared playback control is enabled for you."
            : "Shared playback control is disabled for you.";
          return;
        }
        if (message.type === "control-denied") {
          this.remoteControlAllowed = false;
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
          return;
        }
        if (message.type === "video-start") {
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
          if (this.pendingSync) setTimeout(() => this.applySync(this.pendingSync), 250);
          return;
        }
        if (message.type === "video-error") {
          throw new Error(message.error || "The host could not stream the video.");
        }
        if (message.type === "sync") {
          this.pendingSync = message;
          this.lastSyncLabel = new Date().toLocaleTimeString();
          if (this.videoUrl) this.applySync(message);
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
      this.pendingRangeMd5 = {};
      this.pendingRangeBytes = {};
      this.pendingSegmentSync = null;
      this.pendingSync = null;
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
        complete: Boolean(message.complete) || percent >= 100,
      };
      this.clampViewerProgressiveSeek();
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
      this.suppressViewerControlsBriefly();
      const baseRate = message.playbackRate || 1;
      let targetTime = Number.isFinite(message.currentTime) ? Math.max(0, message.currentTime) : 0;
      if (!message.paused && Number.isFinite(message.sentAt)) {
        targetTime += Math.max(0, Date.now() - message.sentAt) / 1000 * baseRate;
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
          video.currentTime = targetTime;
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
        return;
      }
      this.pendingSegmentSync = message;
      this.lastSyncLabel = "Buffering segment";
      this.suppressViewerControlsBriefly();
      video.pause();
      if (Number.isFinite(message.currentTime)) {
        video.currentTime = Math.max(0, message.currentTime);
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
        return;
      }
      this.pendingSegmentSync = null;
      if (Number.isFinite(message.currentTime)) {
        this.suppressViewerControlsBriefly(1800);
        video.currentTime = Math.max(0, message.currentTime);
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
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};
const CHANNEL_UI_UPDATE_INTERVAL_MS = 500;
const SYNC_BUFFER_SECONDS = 3;
const SYNC_RELAXED_BUFFER_SECONDS = 1;
const SYNC_RELAX_AFTER_MS = 3500;
const SYNC_FORCE_AFTER_MS = 7000;
const SYNC_READY_POLL_MS = 250;
const SEEK_CONTROL_DEBOUNCE_MS = 450;

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
      hls: canPlay(["application/vnd.apple.mpegurl"]),
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
