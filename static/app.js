document.addEventListener("alpine:init", () => {
  Alpine.data("filePipe", () => ({
    connectorUrl: localStorage.getItem("filePipeConnectorUrl") || "https://127.0.0.1:8765",
    connectorPassword: "",
    connectorToken: localStorage.getItem("filePipeConnectorToken") || "",
    connectorAuthRequired: false,
    connectorAuthenticated: false,
    connectorSecure: false,
    connectorReady: false,
    connectorRestoreAttempted: false,
    servers: [],
    selectedServer: null,
    selectedServerId: "",
    items: [],
    history: [],
    currentObjectId: "0",
    currentPathLabel: "",
    connectorDirectories: [],
    loadingServers: false,
    loadingDirectories: false,
    loadingItems: false,
    sharingItemId: null,
    transcodeItemId: null,
    transcodeProgress: 0,
    transcodeStatus: "",
    fileMediaStatus: {},
    transcodePlaybackMode: localStorage.getItem("filePipeTranscodePlaybackMode") || "full",
    shareProgress: 0,
    shareStatus: "",
    shareLink: "",
    localFile: null,
    localFileName: "",
    localFileSize: 0,
    localFileType: "",
    outgoingTransfers: [],
    previewLoading: false,
    previewUrl: "",
    previewType: "",
    previewItemName: "",
    playerUrl: "",
    playerType: "",
    playerTitle: "",
    playerSource: null,
    playerConnectorLaunch: null,
    playerSourceVersion: 0,
    hostMediaCapabilities: detectMediaPlaybackCapabilities(),
    playerCompatibilitySwitching: false,
    hostHls: null,
    hostXrPlayer: null,
    playerRoomLink: "",
    playerRoomQrDataUrl: "",
    playerRoomId: "",
    qrModalOpen: false,
    qrModalTitle: "",
    qrModalUrl: "",
    qrModalDataUrl: "",
    qrModalStatus: "",
    playerStatus: "",
    playerAudioStatus: "",
    playerLoading: false,
    playerTranscodeAvailablePercent: 0,
    playerTranscodeComplete: false,
    playerPeers: {},
    playerShareProgress: 0,
    playerMd5: "",
    playerRoomKey: null,
    playerRoomKeyText: "",
    playerRoomMetadata: null,
    playerPollActive: false,
    playerPollToken: 0,
    playerRoomCreating: false,
    hostSyncBarrier: null,
    suppressHostPlayerEvents: false,
    hostSeekSyncTimer: null,
    bigscreenLink: "",
    bigscreenSessionId: "",
    bigscreenStatus: "",
    bigscreenProgress: 0,
    bigscreenTransfer: null,
    voiceEnabled: false,
    audioInputs: [],
    audioOutputs: [],
    voiceInputId: "",
    voiceOutputId: "",
    mediaVolume: 1,
    participantVolume: 1,
    hostMicStream: null,
    hostMicDeviceId: "",
    selfMuted: false,
    hostVoiceLevel: 0,
    hostVoiceMeter: null,
    hostVoiceElements: {},
    hostParticipantVoiceMeters: {},
    voiceStatus: "",
    networkOnline: navigator.onLine,
    recoveryStatus: "",
    error: "",

    initApp() {
      window.addEventListener("offline", () => {
        this.networkOnline = false;
        this.recoveryStatus = "You are offline. Peer connections may pause or disconnect.";
        for (const peer of Object.values(this.playerPeers)) {
          if (peer.status !== "Complete") peer.status = "Offline";
        }
      });
      window.addEventListener("online", async () => {
        this.networkOnline = true;
        this.recoveryStatus = "Back online. Rechecking connector and watch-room signaling...";
        await this.checkConnector();
        if (this.playerRoomId) {
          this.recoveryStatus = "Back online. Rebuilding disconnected viewer connections as needed.";
          this.pollWatchRoomParticipants();
        }
      });
      window.addEventListener("hashchange", () => this.applyHashRoute());
      this.refreshAudioDevices();
      this.checkConnector();
      window.setTimeout(() => {
        this.initHashNavigation();
        this.applyHashRoute();
      }, 0);
    },

    async copyToClipboard(text) {
      if (!text) return;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
        }
        this.recoveryStatus = "Link copied to clipboard.";
        window.setTimeout(() => {
          if (this.recoveryStatus === "Link copied to clipboard.") this.recoveryStatus = "";
        }, 2500);
      } catch (error) {
        this.error = "Could not copy the link. Select it and copy manually.";
      }
    },

    async openQrModal(title, url) {
      if (!url) return;
      this.qrModalTitle = title;
      this.qrModalUrl = url;
      this.qrModalDataUrl = "";
      this.qrModalStatus = this.hasQrGenerator() ? "Generating QR code..." : "QR code generation is unavailable.";
      this.qrModalOpen = true;
      if (!this.hasQrGenerator()) return;
      try {
        this.qrModalDataUrl = await this.renderQrCode(url, 340);
        this.qrModalStatus = "";
      } catch (error) {
        this.qrModalStatus = "Could not generate the QR code.";
      }
    },

    closeQrModal() {
      this.qrModalOpen = false;
    },

    hasQrGenerator() {
      return Boolean(window.QRCode?.toDataURL || window.qrcode);
    },

    async renderQrCode(value, width = 280) {
      if (!value) return "";
      if (window.QRCode?.toDataURL) {
        return window.QRCode.toDataURL(value, {
          errorCorrectionLevel: "M",
          margin: 1,
          width,
        });
      }
      if (window.qrcode) {
        const qr = window.qrcode(0, "M");
        qr.addData(value);
        qr.make();
        const cellSize = Math.max(2, Math.floor(width / qr.getModuleCount()));
        return qr.createDataURL(cellSize, 1);
      }
      return "";
    },

    saveConnectorUrl() {
      const previousUrl = localStorage.getItem("filePipeConnectorUrl") || "";
      this.connectorUrl = this.connectorUrl.replace(/\/+$/, "");
      if (previousUrl && previousUrl !== this.connectorUrl) {
        this.connectorRestoreAttempted = false;
      }
      localStorage.setItem("filePipeConnectorUrl", this.connectorUrl);
    },

    setConnectorUrl(url) {
      this.connectorUrl = url;
      this.saveConnectorUrl();
      this.checkConnector();
    },

    connectorUrlWithScheme(scheme) {
      try {
        const url = new URL(this.connectorUrl);
        url.protocol = `${scheme}:`;
        return url.toString().replace(/\/+$/, "");
      } catch (error) {
        return `${scheme}://127.0.0.1:8765`;
      }
    },

    connectorHealthUrl() {
      return `${this.connectorUrl.replace(/\/+$/, "")}/health`;
    },

    connectorCommand() {
      return [
        "python -m venv .venv",
        "source .venv/bin/activate",
        "pip install -r requirements.txt",
        'python local_connector.py --adhoc-tls --password "choose-a-password"',
      ].join("\n");
    },

    connectorDirectUrl(path) {
      const url = new URL(`${this.connectorUrl}${path}`);
      if (this.connectorToken) url.searchParams.set("access_token", this.connectorToken);
      return url.toString();
    },

    connectorHeaders(extraHeaders = {}) {
      const headers = { ...extraHeaders };
      if (this.connectorToken) {
        headers.Authorization = `Bearer ${this.connectorToken}`;
      }
      return headers;
    },

    async request(path, options = {}) {
      const response = await fetch(`${this.connectorUrl}${path}`, {
        ...options,
        headers: this.connectorHeaders(options.headers || {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) {
          this.connectorAuthRequired = true;
          this.connectorAuthenticated = false;
          this.connectorReady = false;
        }
        const error = new Error(payload.error || `Request failed with ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    },

    async checkConnector() {
      this.saveConnectorUrl();
      this.error = "";
      try {
        const health = await this.request("/health");
        this.connectorAuthRequired = Boolean(health.authRequired);
        this.connectorAuthenticated = Boolean(health.authenticated);
        this.connectorSecure = Boolean(health.secure);
        this.connectorReady = !this.connectorAuthRequired || this.connectorAuthenticated;
        if (this.connectorReady) {
          await this.loadConnectorDirectories();
          await this.restoreLastBrowseSelection();
        }
      } catch (error) {
        this.connectorReady = false;
        this.connectorAuthenticated = false;
        if (this.connectorUrl.startsWith("https://")) {
          this.error = `Cannot reach the connector at ${this.connectorUrl}. Accept the local HTTPS certificate from setup, or switch to HTTP testing if the connector is running without TLS.`;
        } else {
          this.error = `Cannot reach the connector at ${this.connectorUrl}. Start local_connector.py, or switch to HTTPS if it was started with --adhoc-tls.`;
        }
      }
    },

    async loginConnector() {
      this.saveConnectorUrl();
      this.error = "";
      try {
        const payload = await this.request("/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: this.connectorPassword }),
        });
        this.connectorToken = payload.token || "";
        localStorage.setItem("filePipeConnectorToken", this.connectorToken);
        this.connectorPassword = "";
        await this.checkConnector();
      } catch (error) {
        this.error = error.message;
      }
    },

    forgetConnectorAuth() {
      this.connectorToken = "";
      this.connectorAuthenticated = false;
      this.connectorReady = !this.connectorAuthRequired;
      localStorage.removeItem("filePipeConnectorToken");
    },

    async discoverServers() {
      this.loadingServers = true;
      this.error = "";
      try {
        await this.checkConnector();
        const payload = await this.request("/servers");
        this.servers = payload.servers || [];
        if (this.selectedServerId && !this.servers.some((server) => server.id === this.selectedServerId)) {
          this.selectedServer = null;
          this.selectedServerId = "";
          this.items = [];
          this.clearLastBrowseSelection();
        }
      } catch (error) {
        this.error = error.message;
      } finally {
        this.loadingServers = false;
      }
    },

    async loadConnectorDirectories() {
      if (!this.connectorReady) return;
      this.loadingDirectories = true;
      try {
        const payload = await this.request("/directories");
        this.connectorDirectories = payload.directories || [];
      } catch (error) {
        if (error.status !== 404) this.connectorDirectories = [];
      } finally {
        this.loadingDirectories = false;
      }
    },

    async selectServer(server) {
      this.selectedServer = server;
      this.selectedServerId = server.id;
      this.history = [];
      this.currentPathLabel = "";
      this.clearPreview();
      await this.browse("0");
    },

    async selectServerById() {
      const server = this.servers.find((candidate) => candidate.id === this.selectedServerId);
      if (!server) {
        this.selectedServer = null;
        this.items = [];
        this.clearLastBrowseSelection();
        return;
      }
      await this.selectServer(server);
    },

    async browse(objectId) {
      if (!this.selectedServer) return;
      this.loadingItems = true;
      this.error = "";
      try {
        const params = new URLSearchParams({ object_id: objectId });
        const payload = await this.request(`/servers/${this.selectedServer.id}/browse?${params}`);
        this.currentObjectId = payload.objectId;
        this.currentPathLabel = payload.pathLabel || "";
        this.items = payload.items || [];
        this.saveLastBrowseSelection();
        this.refreshVisibleMediaStatus();
      } catch (error) {
        this.error = error.message;
      } finally {
        this.loadingItems = false;
      }
    },

    async openItem(item) {
      if (item.type !== "container") return;
      this.history.push(this.currentObjectId);
      await this.browse(item.id);
    },

    async refreshVisibleMediaStatus() {
      const videos = this.items.filter((item) => item.type === "item" && this.isVideoItem(item) && item.resources?.[0]?.proxyPath);
      await Promise.all(
        videos.slice(0, 40).map(async (item) => {
          const resource = item.resources[0];
          const key = this.mediaStatusKey(item);
          this.fileMediaStatus = { ...this.fileMediaStatus, [key]: { status: "loading", label: "Checking media status", icon: "bi-hourglass-split", className: "text-secondary" } };
          try {
            const mediaInfo = await this.request(`${resource.proxyPath}/media-info`);
            this.fileMediaStatus = { ...this.fileMediaStatus, [key]: this.mediaStatusFromInfo(mediaInfo) };
          } catch (error) {
            this.fileMediaStatus = { ...this.fileMediaStatus, [key]: { status: "unknown", label: "Media status unavailable", icon: "bi-question-circle", className: "text-secondary" } };
          }
        }),
      );
    },

    mediaStatusKey(item) {
      return item.resources?.[0]?.id || item.id;
    },

    mediaStatusFromInfo(mediaInfo) {
      const playbackDecision = this.mediaPlaybackDecision(
        mediaInfo,
        contentTypeFromProtocol(mediaInfo?.resource?.protocolInfo || ""),
      );
      if (mediaInfo.transcodedCached) {
        return { status: "cached", label: "Browser-safe transcode cached", icon: "bi-cpu-fill", className: "text-success" };
      }
      if (mediaInfo.ok && !playbackDecision.shouldTranscode) {
        return { status: "playable", label: "Browser-playable original", icon: "bi-play-circle-fill", className: "text-success" };
      }
      if (mediaInfo.ok && playbackDecision.shouldTranscode && mediaInfo.ffmpegAvailable) {
        return { status: "needsTranscode", label: "Needs browser-safe transcode", icon: "bi-cpu", className: "text-warning" };
      }
      if (mediaInfo.ok && playbackDecision.shouldTranscode) {
        return { status: "notPlayable", label: "Needs transcode, but ffmpeg is unavailable", icon: "bi-exclamation-triangle-fill", className: "text-danger" };
      }
      return { status: "unknown", label: mediaInfo.error || "Media status unavailable", icon: "bi-question-circle", className: "text-secondary" };
    },

    mediaPlaybackDecision(mediaInfo, contentType = "") {
      return mediaPlaybackDecisionForCapabilities(mediaInfo, contentType, this.hostMediaCapabilities);
    },

    mediaStatusForItem(item) {
      return this.fileMediaStatus[this.mediaStatusKey(item)] || null;
    },

    savedBrowseSelection() {
      try {
        const saved = JSON.parse(localStorage.getItem("filePipeLastBrowseSelection") || "null");
        if (!saved || typeof saved !== "object") return null;
        return saved;
      } catch (error) {
        localStorage.removeItem("filePipeLastBrowseSelection");
        return null;
      }
    },

    saveLastBrowseSelection() {
      if (!this.selectedServer || !this.currentObjectId) return;
      localStorage.setItem(
        "filePipeLastBrowseSelection",
        JSON.stringify({
          connectorUrl: this.connectorUrl.replace(/\/+$/, ""),
          serverId: this.selectedServer.id,
          serverName: this.selectedServer.friendlyName,
          sourceType: this.selectedServer.sourceType || "dlna",
          objectId: this.currentObjectId,
          pathLabel: this.currentPathLabel || "",
          history: this.history.slice(-50),
          savedAt: new Date().toISOString(),
        }),
      );
    },

    clearLastBrowseSelection() {
      localStorage.removeItem("filePipeLastBrowseSelection");
    },

    async restoreLastBrowseSelection() {
      if (this.connectorRestoreAttempted || !this.connectorReady) return;
      this.connectorRestoreAttempted = true;
      const saved = this.savedBrowseSelection();
      if (!saved || saved.connectorUrl !== this.connectorUrl.replace(/\/+$/, "") || !saved.serverId) return;

      try {
        if (this.servers.length === 0) {
          const payload = await this.request("/servers");
          this.servers = payload.servers || [];
        }
        const server = this.servers.find((candidate) => candidate.id === saved.serverId);
        if (!server) return;

        this.selectedServer = server;
        this.selectedServerId = server.id;
        this.history = Array.isArray(saved.history) ? saved.history : [];
        this.currentPathLabel = saved.pathLabel || "";
        await this.browse(saved.objectId || "0");
      } catch (error) {
        this.error = error.message;
      }
    },

    async shareItem(item) {
      const resource = item.resources && item.resources[0];
      if (!resource || !resource.proxyPath) {
        this.error = "This file does not have a shareable connector resource.";
        return;
      }

      this.sharingItemId = item.id;
      await this.createPeerShare({
        title: item.title,
        type: contentTypeFromProtocol(resource.protocolInfo),
        size: Number(resource.size || 0),
        sourceLabel: this.sourceLabel(this.selectedServer),
        openStream: async () => {
          const response = await fetch(`${this.connectorUrl}${resource.proxyPath}`, {
            headers: this.connectorHeaders(),
          });
          if (!response.ok) throw new Error(`Connector returned ${response.status}.`);
          const totalBytes = Number(response.headers.get("Content-Length") || resource.size || 0);
          return {
            totalBytes,
            stream: response.body,
            arrayBuffer: () => response.arrayBuffer(),
          };
        },
      });
      this.sharingItemId = null;
    },

    async transcodeForLater(item) {
      const resource = item.resources && item.resources[0];
      if (!resource || !resource.proxyPath || !this.isVideoItem(item)) {
        this.error = "Choose a video file to transcode.";
        return;
      }

      this.transcodeItemId = item.id;
      this.transcodeProgress = 0;
      this.transcodeStatus = `Preparing browser-safe transcode for ${item.title}...`;
      this.error = "";
      const poller = this.pollTranscodeProgress(resource, item.title, "list");
      try {
        const payload = await this.request(`${resource.proxyPath}/transcode`, {
          method: "POST",
        });
        this.transcodeProgress = 100;
        this.transcodeStatus = `${item.title} is transcoded and cached (${this.formatBytes(payload.size || 0)}).`;
        this.fileMediaStatus = {
          ...this.fileMediaStatus,
          [this.mediaStatusKey(item)]: { status: "cached", label: "Browser-safe transcode cached", icon: "bi-cpu-fill", className: "text-success" },
        };
      } catch (error) {
        this.error = error.message;
        this.transcodeStatus = "";
      } finally {
        poller.stop();
        this.transcodeItemId = null;
      }
    },

    pollTranscodeProgress(resource, title, target = "list") {
      let stopped = false;
      const run = async () => {
        while (!stopped) {
          try {
            const progress = await this.request(`${resource.proxyPath}/transcode-status`);
            const percent = Number(progress.percent || 0);
            if (percent > 0) {
              const status = progress.status === "finalizing" ? "Finalizing" : "Transcoding";
              if (target === "player") {
                this.playerStatus = `${status} ${title}... ${percent}%`;
                this.playerTranscodeAvailablePercent = percent;
                if (this.playerSource && progress.size) this.playerSource.transcodedAvailableBytes = Number(progress.size);
                this.broadcastTranscodeProgress(percent, Number(progress.size || 0));
                if (progress.cached || progress.complete || percent >= 100) {
                  this.playerStatus = `${title} is fully transcoded.`;
                  this.playerTranscodeAvailablePercent = 100;
                  this.playerTranscodeComplete = true;
                  if (this.playerSource?.progressiveTranscode) {
                    this.playerSource.progressiveTranscode = false;
                    this.playerSource.shareDisabledReason = "";
                    this.playerSource.size = Number(progress.size || this.playerSource.size || 0);
                    this.playerSource.transcodedAvailableBytes = this.playerSource.size;
                  }
                  this.broadcastTranscodeProgress(100, Number(progress.size || this.playerSource?.size || 0));
                  setTimeout(() => {
                    if (this.playerStatus === `${title} is fully transcoded.`) this.playerStatus = "";
                  }, 10000);
                  stopped = true;
                }
              } else {
                this.transcodeProgress = percent;
                this.transcodeStatus = `${status} ${title}... ${percent}%`;
              }
            }
          } catch (error) {
            // Progress is best-effort; the main transcode request reports final errors.
          }
          await sleep(1000);
        }
      };
      run();
      return { stop: () => { stopped = true; } };
    },

    async setTranscodePlaybackMode(mode) {
      const nextMode = mode === "segmented" ? "segmented" : "full";
      const changed = this.transcodePlaybackMode !== nextMode;
      this.transcodePlaybackMode = nextMode;
      localStorage.setItem("filePipeTranscodePlaybackMode", this.transcodePlaybackMode);
      if (changed && this.playerConnectorLaunch && !this.playerLoading) {
        await this.reloadCurrentConnectorVideoForTranscodeMode();
      }
    },

    async reloadCurrentConnectorVideoForTranscodeMode() {
      const launch = this.playerConnectorLaunch;
      if (!launch?.item || !launch?.resource || !launch?.mediaInfo?.shouldTranscode) return;
      this.error = "";
      this.playerLoading = true;
      this.resetWatchRoom();
      if (this.bigscreenTransfer?.channel) this.bigscreenTransfer.channel.close();
      if (this.bigscreenTransfer?.peer) this.bigscreenTransfer.peer.close();
      this.bigscreenLink = "";
      this.bigscreenSessionId = "";
      this.bigscreenStatus = "";
      this.bigscreenProgress = 0;
      this.bigscreenTransfer = null;
      try {
        if (this.transcodePlaybackMode === "segmented") {
          await this.launchSegmentedConnectorVideo(launch.item, launch.resource, launch.mediaInfo, launch.transcodeParts);
        } else {
          await this.launchFullTranscodedConnectorVideo(launch.item, launch.resource, launch.mediaInfo, launch.transcodeParts);
        }
      } catch (error) {
        this.error = error.message;
        this.playerStatus = "";
      } finally {
        this.playerLoading = false;
      }
    },

    selectLocalFile(event) {
      const file = event.target.files && event.target.files[0];
      this.localFile = file || null;
      this.localFileName = file ? file.name : "";
      this.localFileSize = file ? file.size : 0;
      this.localFileType = file ? file.type || "application/octet-stream" : "";
      this.shareLink = "";
      this.shareStatus = "";
    },

    async shareLocalFile() {
      if (!this.localFile) {
        this.error = "Choose a file from this computer first.";
        return;
      }

      const file = this.localFile;
      await this.createPeerShare({
        title: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        sourceLabel: "Local file",
        openStream: async () => ({
          totalBytes: file.size,
          stream: file.stream ? file.stream() : null,
          arrayBuffer: () => file.arrayBuffer(),
        }),
      });
    },

    async createPeerShare(source) {
      this.error = "";
      this.shareLink = "";
      this.shareProgress = 0;
      this.shareStatus = "Preparing peer-to-peer share...";
      const transfer = {
        id: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        title: source.title,
        source: source.sourceLabel,
        status: "Preparing",
        progress: 0,
        bytesSent: 0,
        totalBytes: Number(source.size || 0),
        shareLink: "",
        startedAt: new Date().toISOString(),
        mode: "P2P",
      };
      this.outgoingTransfers.unshift(transfer);

      try {
        if (!window.SparkMD5) {
          throw new Error("MD5 support is unavailable. Reload the page and try again.");
        }
        if (!hasWebCrypto()) {
          throw new Error(webCryptoRequiredMessage("Encrypted file sharing"));
        }

        this.shareStatus = "Hashing file for recipient acknowledgement...";
        transfer.status = "Hashing";
        const hashSource = await source.openStream();
        const hashResult = await computeSourceMd5(hashSource, source.size, (bytesRead, totalBytes) => {
          transfer.bytesSent = 0;
          transfer.progress = totalBytes ? Math.round((bytesRead / totalBytes) * 100) : 0;
          this.shareProgress = transfer.progress;
        });

        const key = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"],
        );
        const rawKey = await crypto.subtle.exportKey("raw", key);
        const keyText = base64UrlEncode(new Uint8Array(rawKey));

        const created = await fetch("/api/p2p/shares", { method: "POST" }).then((response) => response.json());
        if (!created.shareId) throw new Error("Could not create share.");

        const metadata = {
          name: source.title,
          type: source.type || "application/octet-stream",
          size: hashResult.totalBytes,
          md5: hashResult.md5,
          source: source.sourceLabel,
          mode: "P2P WebRTC",
          sharedAt: new Date().toISOString(),
        };
        const metadataIv = crypto.getRandomValues(new Uint8Array(12));
        const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
        const encryptedMetadata = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: metadataIv },
          key,
          metadataBytes,
        );

        const peer = new RTCPeerConnection(P2P_CONFIG);
        const channel = peer.createDataChannel("file-pipe", { ordered: true });
        channel.binaryType = "arraybuffer";
        channel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFER_LOW_THRESHOLD;
        transfer.peer = peer;
        transfer.channel = channel;
        transfer.key = key;
        transfer.status = "Creating offer";
        transfer.progress = 0;
        transfer.bytesSent = 0;
        this.shareProgress = 0;

        let startedSending = false;
        channel.onopen = () => {
          transfer.status = "Recipient connected";
          this.shareStatus = "Recipient connected. Waiting for their acknowledgement...";
        };
        channel.onmessage = async (event) => {
          const message = JSON.parse(event.data);
          if (message.type !== "ready" || startedSending) return;
          startedSending = true;
          await this.streamPeerShare(source, key, channel, transfer, metadata);
        };
        channel.onclose = () => {
          if (!["Complete", "Failed"].includes(transfer.status)) {
            transfer.status = "Disconnected";
          }
        };
        channel.onerror = () => {
          transfer.status = "Failed";
          this.error = "Peer data channel failed.";
        };

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIceGatheringComplete(peer);

        const offered = await fetch(`/api/p2p/shares/${created.shareId}/offer`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offer: peer.localDescription,
            metadata: {
              iv: base64UrlEncode(metadataIv),
              ciphertext: base64UrlEncode(new Uint8Array(encryptedMetadata)),
            },
          }),
        });
        if (!offered.ok) {
          const payload = await offered.json().catch(() => ({}));
          throw new Error(payload.error || `Share signaling failed with ${offered.status}.`);
        }

        this.shareProgress = 0;
        this.shareStatus = "P2P link ready. Keep this tab open while the recipient downloads.";
        this.shareLink = `${window.location.origin}/share/${created.shareId}#key=${keyText}`;
        transfer.status = "Waiting for recipient";
        transfer.progress = 0;
        transfer.bytesSent = 0;
        transfer.totalBytes = hashResult.totalBytes;
        transfer.shareLink = this.shareLink;
        transfer.md5 = metadata.md5;
        this.waitForPeerAnswer(created.shareId, peer, transfer);
      } catch (error) {
        this.error = error.message;
        this.shareStatus = "";
        transfer.status = "Failed";
      }
    },

    async waitForPeerAnswer(shareId, peer, transfer) {
      try {
        for (let attempt = 0; attempt < 900; attempt += 1) {
          const signal = await fetch(`/api/p2p/shares/${shareId}`).then((response) => response.json());
          if (signal.answer) {
            await peer.setRemoteDescription(signal.answer);
            transfer.status = "Waiting for acknowledgement";
            return;
          }
          await sleep(1000);
        }
        transfer.status = "Expired";
      } catch (error) {
        transfer.status = "Failed";
        this.error = error.message;
      }
    },

    async streamPeerShare(source, key, channel, transfer, metadata) {
      try {
        transfer.status = "Sending";
        this.shareStatus = "Streaming encrypted file peer-to-peer...";
        if (!sendChannelJson(channel, { type: "start", metadata })) throw dataChannelDisconnectedError();
        const opened = await source.openStream();
        const totalBytes = Number(opened.totalBytes || source.size || metadata.size || 0);
        let sentBytes = 0;
        let chunkIndex = 0;

        const sendPlainChunk = async (plainChunk) => {
          for (const part of splitArrayBuffer(exactArrayBuffer(plainChunk), 48 * 1024)) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, part);
            if (!sendChannelJson(channel, {
              type: "chunk",
              index: chunkIndex,
              iv: base64UrlEncode(iv),
              data: base64UrlEncode(new Uint8Array(ciphertext)),
              plainSize: part.byteLength,
            })) throw dataChannelDisconnectedError();
            if (!(await waitForDataChannelBuffer(channel))) throw dataChannelDisconnectedError();
            sentBytes += part.byteLength;
            chunkIndex += 1;
            transfer.bytesSent = sentBytes;
            transfer.progress = totalBytes ? Math.round((sentBytes / totalBytes) * 100) : 0;
            this.shareProgress = transfer.progress;
          }
        };

        if (opened.stream) {
          const reader = opened.stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength) {
              await sendPlainChunk(value);
            }
          }
        } else {
          const buffer = await opened.arrayBuffer();
          await sendPlainChunk(buffer);
        }

        if (!sendChannelJson(channel, { type: "done", md5: metadata.md5, chunkCount: chunkIndex })) {
          throw dataChannelDisconnectedError();
        }
        transfer.status = "Complete";
        transfer.progress = 100;
        transfer.bytesSent = totalBytes || sentBytes;
        transfer.finishedAt = new Date().toISOString();
        this.shareProgress = 100;
        this.shareStatus = "Peer-to-peer transfer complete.";
      } catch (error) {
        if (isDataChannelClosedError(error)) {
          transfer.status = "Disconnected";
          this.shareStatus = "Peer disconnected before the transfer completed.";
        } else {
          transfer.status = "Failed";
          this.error = error.message;
        }
      }
    },

    async previewItem(item) {
      const resource = item.resources && item.resources[0];
      if (!resource || !resource.proxyPath) {
        this.error = "This file does not have a previewable connector resource.";
        return;
      }

      this.previewLoading = true;
      this.error = "";
      this.clearPreview(false);
      try {
        const response = await fetch(`${this.connectorUrl}${resource.proxyPath}`, {
          headers: this.connectorHeaders(),
        });
        if (!response.ok) throw new Error(`Preview failed with ${response.status}.`);
        const type = response.headers.get("Content-Type") || contentTypeFromProtocol(resource.protocolInfo);
        const blob = await response.blob();
        this.previewUrl = URL.createObjectURL(blob);
        this.previewType = type || "application/octet-stream";
        this.previewItemName = item.title;
      } catch (error) {
        this.error = error.message;
      } finally {
        this.previewLoading = false;
      }
    },

    async launchFullTranscodedConnectorVideo(item, resource, mediaInfo, transcodeParts) {
      const transcodePath = `${resource.proxyPath}/transcoded`;
      this.playerStatus = `Transcoding ${transcodeParts.join(" and ")} until enough video is ready...`;
      this.playerTranscodeAvailablePercent = 0;
      const poller = this.pollTranscodeProgress(resource, item.title, "player");
      let transcodeInfo;
      try {
        transcodeInfo = await this.request(`${resource.proxyPath}/transcoded-info?progressive=1`);
      } finally {
        if (!transcodeInfo || transcodeInfo.complete) poller.stop();
      }
      const progress = transcodeInfo.progress || {};
      this.playerTranscodeAvailablePercent = transcodeInfo.complete ? 100 : Number(progress.percent || 0);
      const transcodeSize = Number(transcodeInfo.size || 0);
      this.teardownHostHlsPlayer();
      this.playerUrl = this.connectorDirectUrl(`${transcodePath}?progressive=1`);
      this.playerType = "video/mp4";
      this.playerTitle = item.title;
      this.playerTranscodeComplete = Boolean(transcodeInfo.complete);
      this.playerSource = {
        title: item.title,
        type: "video/mp4",
        size: transcodeSize,
        sourceLabel: `${this.sourceLabel(this.selectedServer)} video transcoded to MP4/AAC`,
        mediaInfo,
        playbackProfile: stableMp4PlaybackProfile(mediaInfo),
        progressiveTranscode: !transcodeInfo.complete,
        progressiveTranscodePercent: this.playerTranscodeAvailablePercent,
        transcodedAvailableBytes: transcodeSize,
        estimatedFinalSize: Number(mediaInfo?.size || resource.size || transcodeSize || 0),
        shareDisabledReason: "",
        checksumPath: `${transcodePath}/checksum`,
        readRange: async (start, endExclusive) => {
          const response = await fetch(`${this.connectorUrl}${transcodePath}${this.playerSource?.progressiveTranscode ? "?progressive=1" : ""}`, {
            headers: this.connectorHeaders({
              Range: `bytes=${start}-${Math.max(start, endExclusive - 1)}`,
            }),
          });
          if (!response.ok && response.status !== 206) {
            throw new Error(`Connector returned ${response.status} for transcoded range.`);
          }
          return response.arrayBuffer();
        },
        openStream: async () => {
          const response = await fetch(`${this.connectorUrl}${transcodePath}${this.playerSource?.progressiveTranscode ? "?progressive=1" : ""}`, {
            headers: this.connectorHeaders(),
          });
          if (!response.ok) throw new Error(`Connector returned ${response.status} for transcoded video.`);
          const totalBytes = Number(response.headers.get("Content-Length") || transcodeSize || 0);
          return {
            totalBytes,
            stream: response.body,
            arrayBuffer: () => response.arrayBuffer(),
          };
        },
      };
      this.playerStatus = transcodeInfo.complete
        ? `Video ready with browser-safe ${transcodeParts.join(" and ")}.`
        : "Playing while transcoding continues. Scrubbing is limited to the transcoded portion.";
      setTimeout(() => {
        this.prepareHostPlayerMedia();
      }, 0);
      this.showBootstrapTab("player-tab");
    },

    async launchSegmentedConnectorVideo(item, resource, mediaInfo, transcodeParts) {
      const hlsInfo = await this.request(`${resource.proxyPath}/hls-info`);
      const playlistPath = hlsInfo.playlistPath || `${resource.proxyPath}/hls/playlist.m3u8`;
      const playlistUrl = this.connectorDirectUrl(playlistPath);
      this.teardownHostHlsPlayer();
      this.playerUrl = playlistUrl;
      this.playerType = "application/vnd.apple.mpegurl";
      this.playerTitle = item.title;
      this.playerTranscodeComplete = false;
      this.playerSource = {
        title: item.title,
        type: "application/vnd.apple.mpegurl",
        size: Number(mediaInfo?.size || hlsInfo?.mediaInfo?.size || resource.size || 0),
        sourceLabel: `${this.sourceLabel(this.selectedServer)} video segmented transcode`,
        mediaInfo: hlsInfo.mediaInfo || mediaInfo,
        playbackProfile: {
          sourceKind: "hls-segmented",
          containerType: "application/vnd.apple.mpegurl",
          videoCodec: "h264",
          audioCodec: "aac",
          universal: false,
        },
        hls: true,
        shareDisabledReason: "Segmented playback is a local preview mode. Switch Transcode to Stable MP4 cache before creating watch or Bigscreen links.",
      };
      this.playerStatus = `Segmented player ready with browser-safe ${transcodeParts.join(" and ")}.`;
      setTimeout(() => this.attachHostHlsPlayer(), 0);
      this.showBootstrapTab("player-tab");
    },

    teardownHostHlsPlayer() {
      if (this.hostHls) {
        this.hostHls.destroy();
        this.hostHls = null;
      }
    },

    attachHostHlsPlayer() {
      const video = document.getElementById("host-video-player");
      if (!video || this.playerType !== "application/vnd.apple.mpegurl" || !this.playerUrl) return;
      this.teardownHostHlsPlayer();
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = this.playerUrl;
        video.load();
        this.prepareHostPlayerMedia();
        return;
      }
      if (window.Hls?.isSupported()) {
        this.hostHls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
        });
        this.hostHls.on(Hls.Events.ERROR, (_event, data) => {
          if (data?.fatal) {
            this.error = data.details || "The segmented media player failed.";
          }
        });
        this.hostHls.loadSource(this.playerUrl);
        this.hostHls.attachMedia(video);
        this.hostHls.on(Hls.Events.MANIFEST_PARSED, () => {
          this.prepareHostPlayerMedia();
        });
        return;
      }
      this.error = "This browser cannot play segmented HLS streams. Switch Transcode to Stable MP4 cache.";
    },

    async launchVideoItem(item) {
      const resource = item.resources && item.resources[0];
      if (!resource || !resource.proxyPath || !this.isVideoItem(item)) {
        this.error = "Choose a video file to launch in the player.";
        return;
      }

      this.clearPlayer();
      this.playerLoading = true;
      this.playerTitle = item.title;
      this.playerType = "Preparing video";
      this.playerStatus = "Inspecting media tracks...";
      this.showBootstrapTab("player-tab");
      try {
        const mediaInfo = await this.request(`${resource.proxyPath}/media-info`).catch((error) => ({
          ok: false,
          error: error.status === 405
            ? "The running local connector does not support audio probing yet. Restart local_connector.py to enable automatic audio codec detection and transcoding; playing the original file for now."
            : `Could not inspect audio tracks with ffprobe: ${error.message}`,
        }));
        const sourceType = contentTypeFromProtocol(resource.protocolInfo);
        const playbackDecision = this.mediaPlaybackDecision(mediaInfo, sourceType);
        const audioCodec = mediaInfo?.audioCodec || "";
        const fallbackTranscodeParts = [];
        if (mediaInfo?.shouldTranscode) {
          if (!mediaInfo.audioPlayable) fallbackTranscodeParts.push(`${audioCodec ? audioCodec.toUpperCase() : "audio"} to AAC`);
          if (!mediaInfo.videoPlayable) fallbackTranscodeParts.push(`${mediaInfo.videoCodec ? mediaInfo.videoCodec.toUpperCase() : "video"} to H.264`);
        }
        if (playbackDecision.shouldTranscode && mediaInfo.ffmpegAvailable) {
          const transcodeParts = fallbackTranscodeParts.length ? fallbackTranscodeParts : ["video to H.264"];
          this.playerConnectorLaunch = { item, resource, mediaInfo, transcodeParts };
          if (this.transcodePlaybackMode === "segmented") {
            await this.launchSegmentedConnectorVideo(item, resource, mediaInfo, transcodeParts);
          } else {
            await this.launchFullTranscodedConnectorVideo(item, resource, mediaInfo, transcodeParts);
          }
          return;
        }

        this.playerStatus = "Loading video from connector...";
        const response = await fetch(`${this.connectorUrl}${resource.proxyPath}`, {
          headers: this.connectorHeaders(),
        });
        if (!response.ok) throw new Error(`Player load failed with ${response.status}.`);
        const type = response.headers.get("Content-Type") || contentTypeFromProtocol(resource.protocolInfo);
        const blob = await response.blob();
        this.teardownHostHlsPlayer();
      this.playerUrl = URL.createObjectURL(blob);
      this.playerType = type || "video/mp4";
      this.playerTitle = item.title;
      this.playerTranscodeComplete = false;
        this.playerSource = {
          title: item.title,
          type: this.playerType,
          size: blob.size || Number(resource.size || 0),
          sourceLabel: `${this.sourceLabel(this.selectedServer)} video`,
          mediaInfo,
          playbackProfile: playbackProfileFromMediaInfo(mediaInfo, this.playerType, "original"),
          checksumPath: `${resource.proxyPath}/checksum`,
          readRange: async (start, endExclusive) => blob.slice(start, endExclusive).arrayBuffer(),
          openStream: async () => ({
            totalBytes: blob.size,
            stream: blob.stream ? blob.stream() : null,
            arrayBuffer: () => blob.arrayBuffer(),
          }),
        };
        this.playerConnectorLaunch = mediaInfo?.shouldTranscode && mediaInfo.ffmpegAvailable
          ? { item, resource, mediaInfo, transcodeParts: fallbackTranscodeParts.length ? fallbackTranscodeParts : ["video to H.264"] }
          : null;
        if (playbackDecision.shouldTranscode && !mediaInfo.ffmpegAvailable) {
          this.playerStatus = "Video loaded without audio transcoding because ffmpeg is not available to the connector.";
        } else {
          this.playerStatus = playbackDecision.reason === "hevc-supported"
            ? "Video loaded. This browser reports HEVC support for the original file."
            : "Video loaded.";
        }
        setTimeout(() => {
          this.prepareHostPlayerMedia();
        }, 0);
        this.showBootstrapTab("player-tab");
      } catch (error) {
        this.error = error.message;
        this.playerStatus = "";
      } finally {
        this.playerLoading = false;
      }
    },

    launchLocalVideo() {
      if (!this.localFile || !this.localFileType.startsWith("video/")) {
        this.error = "Choose a local video file first.";
        return;
      }
      this.clearPlayer();
      this.teardownHostHlsPlayer();
      this.playerUrl = URL.createObjectURL(this.localFile);
      this.playerType = this.localFile.type || "video/mp4";
      this.playerTitle = this.localFile.name;
      this.playerTranscodeComplete = false;
      this.playerSource = {
        title: this.localFile.name,
        type: this.playerType,
        size: this.localFile.size,
        sourceLabel: "Local video",
        playbackProfile: {
          sourceKind: "local",
          containerType: this.playerType,
          videoCodec: "",
          audioCodec: "",
          universal: false,
        },
        readRange: async (start, endExclusive) => this.localFile.slice(start, endExclusive).arrayBuffer(),
        openStream: async () => ({
          totalBytes: this.localFile.size,
          stream: this.localFile.stream ? this.localFile.stream() : null,
          arrayBuffer: () => this.localFile.arrayBuffer(),
        }),
      };
      this.playerConnectorLaunch = null;
      this.playerStatus = "Video loaded.";
      setTimeout(() => {
        this.prepareHostPlayerMedia();
      }, 0);
      this.showBootstrapTab("player-tab");
    },

    clearPlayer() {
      if (this.hostXrPlayer) {
        this.hostXrPlayer.dispose();
        this.hostXrPlayer = null;
      }
      this.teardownHostHlsPlayer();
      if (this.playerUrl && this.playerUrl.startsWith("blob:")) URL.revokeObjectURL(this.playerUrl);
      this.resetWatchRoom();
      if (this.bigscreenTransfer?.channel) this.bigscreenTransfer.channel.close();
      if (this.bigscreenTransfer?.peer) this.bigscreenTransfer.peer.close();
      this.playerUrl = "";
      this.playerType = "";
      this.playerTitle = "";
      this.playerSource = null;
      this.playerConnectorLaunch = null;
      this.playerSourceVersion = 0;
      this.playerCompatibilitySwitching = false;
      this.playerAudioStatus = "";
      this.playerLoading = false;
      this.playerTranscodeAvailablePercent = 0;
      this.playerTranscodeComplete = false;
      this.bigscreenLink = "";
      this.bigscreenSessionId = "";
      this.bigscreenStatus = "";
      this.bigscreenProgress = 0;
      this.bigscreenTransfer = null;
      this.closeQrModal();
    },

    resetWatchRoom() {
      this.playerPollToken += 1;
      this.playerPollActive = false;
      for (const peer of Object.values(this.playerPeers)) {
        if (peer.channel) peer.channel.close();
        if (peer.peer) peer.peer.close();
        this.removeHostVoiceElement(peer.id);
      }
      this.playerRoomLink = "";
      this.playerRoomQrDataUrl = "";
      this.playerRoomId = "";
      this.playerStatus = "";
      this.playerPeers = {};
      this.playerShareProgress = 0;
      this.playerMd5 = "";
      this.playerRoomKey = null;
      this.playerRoomKeyText = "";
      this.playerRoomMetadata = null;
      if (this.qrModalUrl) this.closeQrModal();
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

    async enableHostVoice() {
      if (!navigator.mediaDevices?.getUserMedia) {
        this.voiceStatus = "Microphone access is not supported in this browser.";
        return;
      }
      if (this.hostMicStream && this.hostMicDeviceId === this.voiceInputId) {
        this.setHostSelfMuted(false);
        this.voiceStatus = "Microphone unmuted.";
        return;
      }
      try {
        const requestedInputId = this.voiceInputId;
        const requested = await requestAudioInputStream(requestedInputId);
        if (this.hostMicStream) {
          this.stopHostVoiceMeter();
          this.hostMicStream.getTracks().forEach((track) => track.stop());
        }
        this.hostMicStream = requested.stream;
        this.hostMicDeviceId = requested.deviceId;
        this.voiceInputId = requested.deviceId;
        this.selfMuted = false;
        this.setHostMicTrackEnabled();
        this.startHostVoiceMeter();
        this.voiceEnabled = true;
        this.voiceStatus = requested.usedFallback
          ? "Selected microphone was unavailable, so voice is using the default microphone. Existing viewer connections will refresh."
          : "Voice is enabled. Existing viewer connections will refresh.";
        await this.refreshAudioDevices();
        await this.requestAllViewerReconnects();
      } catch (error) {
        this.voiceEnabled = false;
        this.hostMicStream = null;
        this.hostMicDeviceId = "";
        this.hostVoiceLevel = 0;
        this.stopHostVoiceMeter();
        this.voiceStatus = error.message;
      }
    },

    async changeHostVoiceInput() {
      if (this.hostMicStream) {
        await this.enableHostVoice();
      }
    },

    async stopHostVoice() {
      this.setHostSelfMuted(true);
      this.voiceStatus = this.hostMicStream
        ? "Microphone muted."
        : "Microphone is already muted.";
    },

    async requestAllViewerReconnects() {
      if (!this.playerRoomId) return;
      const participants = Object.values(this.playerPeers);
      await Promise.all(participants.map(async (peer) => {
        try {
          if (peer.channel) peer.channel.close();
          if (peer.peer) peer.peer.close();
          this.removeHostVoiceElement(peer.id);
          peer.status = "Reconnecting";
          await fetch(`/api/watch/rooms/${this.playerRoomId}/participants/${peer.id}/reconnect`, {
            method: "POST",
          });
        } catch (error) {
          peer.status = "Reconnect failed";
        }
      }));
    },

    setHostSelfMuted(muted) {
      this.selfMuted = Boolean(muted);
      this.setHostMicTrackEnabled();
      this.voiceEnabled = Boolean(this.hostMicStream) && !this.selfMuted;
      this.broadcastHostVoiceState();
    },

    setHostMicTrackEnabled() {
      if (!this.hostMicStream) return;
      const enabled = !this.selfMuted;
      this.hostMicStream.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
      if (!enabled) this.hostVoiceLevel = 0;
    },

    hostVoiceLabel() {
      if (this.hostMicStream && !this.selfMuted) return "Mic on";
      if (this.hostMicStream) return "Muted";
      return "Muted";
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

    startHostVoiceMeter() {
      this.stopHostVoiceMeter();
      if (!this.hostMicStream) return;
      this.hostVoiceMeter = createVoiceActivityMeter(
        this.hostMicStream,
        (level) => {
          this.hostVoiceLevel = this.selfMuted ? 0 : level;
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

    attachHostVoiceToPeer(peer) {
      const tracks = this.hostMicStream ? this.hostMicStream.getAudioTracks() : [];
      if (tracks.length > 0) {
        this.setHostMicTrackEnabled();
        tracks.forEach((track) => peer.addTrack(track, this.hostMicStream));
      } else if (peer.addTransceiver) {
        peer.addTransceiver("audio", { direction: "recvonly" });
      }
    },

    handleHostIncomingVoice(record, event) {
      const stream = event.streams?.[0];
      if (!stream) return;
      this.removeHostVoiceElement(record.id);
      const audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.srcObject = stream;
      audio.dataset.participantId = record.id;
      audio.className = "d-none";
      document.body.appendChild(audio);
      this.hostVoiceElements[record.id] = audio;
      record.voiceAvailable = true;
      this.startHostParticipantVoiceMeter(record, stream);
      this.applyHostVoiceElementState(record);
      this.setMediaSink(audio, this.voiceOutputId);
      audio.play().catch(() => {
        this.voiceStatus = "Participant voice is ready. Browser autoplay may require one click.";
      });
    },

    removeHostVoiceElement(participantId) {
      const audio = this.hostVoiceElements[participantId];
      this.stopHostParticipantVoiceMeter(participantId);
      if (!audio) return;
      audio.srcObject = null;
      audio.remove();
      delete this.hostVoiceElements[participantId];
    },

    startHostParticipantVoiceMeter(record, stream) {
      this.stopHostParticipantVoiceMeter(record.id);
      record.voiceLevel = 0;
      this.hostParticipantVoiceMeters[record.id] = createVoiceActivityMeter(
        stream,
        (level) => {
          record.voiceLevel = record.localVoiceMuted || record.micMuted ? 0 : level;
        },
        (error) => {
          this.voiceStatus = error.message;
        },
      );
    },

    stopHostParticipantVoiceMeter(participantId) {
      const meter = this.hostParticipantVoiceMeters[participantId];
      if (meter) meter.stop();
      delete this.hostParticipantVoiceMeters[participantId];
      if (this.playerPeers[participantId]) this.playerPeers[participantId].voiceLevel = 0;
    },

    async setHostAudioOutput() {
      const hostVideo = document.getElementById("host-video-player");
      await this.setMediaSink(hostVideo, this.voiceOutputId);
      await Promise.all(Object.values(this.hostVoiceElements).map((audio) => this.setMediaSink(audio, this.voiceOutputId)));
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

    applyHostVolumes() {
      const video = document.getElementById("host-video-player");
      if (video) video.volume = this.mediaVolume;
      for (const [participantId, audio] of Object.entries(this.hostVoiceElements)) {
        audio.volume = this.participantVolume;
        audio.muted = Boolean(this.playerPeers[participantId]?.localVoiceMuted);
      }
    },

    applyHostVoiceElementState(record) {
      const audio = this.hostVoiceElements[record.id];
      if (!audio) return;
      audio.volume = this.participantVolume;
      audio.muted = Boolean(record.localVoiceMuted);
      if (record.localVoiceMuted) record.voiceLevel = 0;
    },

    toggleParticipantAudioMute(record) {
      if (!record) return;
      record.localVoiceMuted = !record.localVoiceMuted;
      this.applyHostVoiceElementState(record);
    },

    toggleParticipantMicMute(record) {
      if (!record || record.status === "Kicked") return;
      if (!record.channel || record.channel.readyState !== "open") {
        record.status = "Voice control unavailable";
        return;
      }
      const muted = !record.remoteMicMuted;
      if (!sendChannelJson(record.channel, {
        type: "voice-control",
        action: muted ? "mute" : "allow-unmute",
      })) {
        record.status = "Voice control unavailable";
        return;
      }
      record.remoteMicMuted = muted;
      if (muted) record.micMuted = true;
      record.status = muted ? "Mic muted by host" : "Mic allowed";
    },

    updateParticipantVoiceState(record, message) {
      record.voiceAvailable = Boolean(message.micAvailable);
      record.micMuted = Boolean(message.muted);
      if (record.micMuted) record.voiceLevel = 0;
      if (message.mutedByHost) record.remoteMicMuted = true;
    },

    sendHostVoiceState(channel) {
      if (!channel || channel.readyState !== "open") return;
      sendChannelJson(channel, {
        type: "voice-state",
        role: "host",
        micAvailable: Boolean(this.hostMicStream),
        muted: !this.hostMicStream || this.selfMuted,
      });
    },

    broadcastHostVoiceState() {
      for (const record of Object.values(this.playerPeers)) {
        this.sendHostVoiceState(record.channel);
      }
    },

    prepareHostPlayerMedia() {
      const video = document.getElementById("host-video-player");
      if (!video) return;
      video.muted = false;
      video.volume = this.mediaVolume;
      this.attachHostXrPlayer(video);
      this.setHostAudioOutput();
      this.inspectHostPlayerAudio();
    },

    attachHostXrPlayer(video) {
      if (!window.FilePipeXrPlayer || !video) return;
      this.hostXrPlayer = window.FilePipeXrPlayer.attach(video, {
        panelSelector: ".xr-side-panel",
        storageKey: "filePipeHostXrPlayer",
      });
    },

    inspectHostPlayerAudio() {
      const video = document.getElementById("host-video-player");
      if (!video) return;
      const mediaInfo = this.playerSource?.mediaInfo;
      if (mediaInfo && mediaInfo.ok === false) {
        this.playerAudioStatus = mediaInfo.error || "Could not inspect audio tracks with ffprobe.";
        return;
      }
      const profile = this.playerSource?.playbackProfile;
      if (profile?.sourceKind === "original" && isHevcCodec(profile.videoCodec)) {
        this.playerAudioStatus = "Direct-playing the original HEVC stream because this browser reports HEVC support.";
        return;
      }
      if (profile?.sourceKind !== "original" && mediaInfo?.shouldTranscode && mediaInfo.ffmpegAvailable) {
        const audioCodec = mediaInfo.audioCodec ? mediaInfo.audioCodec.toUpperCase() : "the original audio codec";
        const videoCodec = mediaInfo.videoCodec ? mediaInfo.videoCodec.toUpperCase() : "the original video codec";
        const reasons = [];
        if (!mediaInfo.audioPlayable) reasons.push(`${audioCodec} audio to AAC`);
        if (!mediaInfo.videoPlayable) reasons.push(`${videoCodec} video to H.264`);
        this.playerAudioStatus = `This stream is transcoding ${reasons.join(" and ")} for browser playback.`;
        return;
      }
      if (mediaInfo?.shouldTranscode && !mediaInfo.ffmpegAvailable) {
        const audioCodec = mediaInfo.audioCodec ? mediaInfo.audioCodec.toUpperCase() : "the original audio codec";
        const videoCodec = mediaInfo.videoCodec ? mediaInfo.videoCodec.toUpperCase() : "the original video codec";
        this.playerAudioStatus = `This file needs browser-safe transcoding (${videoCodec} / ${audioCodec}), but ffmpeg is not available.`;
        return;
      }
      if (mediaInfo?.defaultAudio && mediaInfo.audioPlayable) {
        const codec = mediaInfo.audioCodec ? mediaInfo.audioCodec.toUpperCase() : "audio";
        this.playerAudioStatus = `Default audio uses ${codec}, which should be browser-playable.`;
        return;
      }
      if (mediaInfo?.ok && !mediaInfo.defaultAudio) {
        this.playerAudioStatus = "No default audio track was found in this video.";
        return;
      }
      const audioInfo = detectMediaAudio(video);
      if (audioInfo.known && audioInfo.hasAudio) {
        this.playerAudioStatus = "Audio track detected. If it is still silent, check the media volume and output device.";
      } else if (audioInfo.known) {
        this.playerAudioStatus = "No browser-decodable audio track was detected. This often means the file uses an unsupported audio codec such as AC3, E-AC-3, or DTS.";
      } else {
        this.playerAudioStatus = "Audio track detection is limited in this browser. If this video is silent, try an MP4 with AAC audio or transcode the audio track.";
      }
    },

    async getPlayerSourceChecksum(label, onProgress = null) {
      if (this.playerSource?.progressiveTranscode) {
        if (onProgress) onProgress(Math.max(1, Number(this.playerTranscodeAvailablePercent || 0)));
        return {
          md5: "",
          totalBytes: Number(this.playerSource.estimatedFinalSize || this.playerSource.size || 0),
          originalBytes: Number(this.playerSource.estimatedFinalSize || this.playerSource.size || 0),
          provisional: true,
          source: "progressive-transcode",
        };
      }
      if (this.playerSource?.checksumPath) {
        try {
          const checksum = await this.request(this.playerSource.checksumPath);
          if (checksum?.md5) {
            if (onProgress) onProgress(100);
            return {
              md5: checksum.md5,
              totalBytes: Number(checksum.size || this.playerSource.size || 0),
              source: "connector",
            };
          }
        } catch (error) {
          this.playerStatus = `Connector checksum failed; hashing in browser for ${label}...`;
          this.bigscreenStatus = `Connector checksum failed; hashing in browser for ${label}...`;
        }
      }

      const hashSource = await this.playerSource.openStream();
      return computeSourceMd5(hashSource, this.playerSource.size, (bytesRead, totalBytes) => {
        if (onProgress) onProgress(totalBytes ? Math.round((bytesRead / totalBytes) * 100) : 0);
      });
    },

    async publishCurrentWatchRoomMetadata(label = "viewer acknowledgement") {
      if (!this.playerRoomId || !this.playerRoomKey || !this.playerSource) {
        throw new Error("Create a watch room before publishing source metadata.");
      }
      const hashResult = await this.getPlayerSourceChecksum(label, (progress) => {
        this.playerShareProgress = progress;
      });
      this.playerSourceVersion += 1;
      this.playerRoomMetadata = {
        name: this.playerSource.title,
        type: this.playerSource.type || "video/mp4",
        size: hashResult.totalBytes,
        md5: hashResult.md5,
        originalMd5: hashResult.provisional ? hashResult.md5 : "",
        originalSize: hashResult.originalBytes || 0,
        checksumKind: hashResult.provisional ? "original-source" : "stream",
        provisional: Boolean(hashResult.provisional),
        source: this.playerSource.sourceLabel,
        mode: "Encrypted WebRTC watch room",
        sharedAt: new Date().toISOString(),
        playbackProfile: this.playerSource.playbackProfile || null,
        mediaInfo: mediaInfoSummary(this.playerSource.mediaInfo),
        hostCapabilities: this.hostMediaCapabilities,
        sourceVersion: this.playerSourceVersion,
        progressiveTranscode: this.playerSource.progressiveTranscode ? {
          percent: Number(this.playerTranscodeAvailablePercent || 0),
          availableBytes: Number(this.playerSource.transcodedAvailableBytes || this.playerSource.size || 0),
          complete: false,
        } : null,
      };
      const metadataIv = crypto.getRandomValues(new Uint8Array(12));
      const encryptedMetadata = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: metadataIv },
        this.playerRoomKey,
        new TextEncoder().encode(JSON.stringify(this.playerRoomMetadata)),
      );
      const response = await fetch(`/api/watch/rooms/${this.playerRoomId}/metadata`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          metadata: {
            iv: base64UrlEncode(metadataIv),
            ciphertext: base64UrlEncode(new Uint8Array(encryptedMetadata)),
          },
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Could not publish room metadata: ${response.status}`);
      }
      this.playerMd5 = this.playerRoomMetadata.md5;
      return this.playerRoomMetadata;
    },

    async createWatchRoom() {
      if (!this.playerSource) {
        this.error = "Load a video in the player first.";
        return;
      }
      if (this.playerSource.shareDisabledReason || !this.playerSource.openStream) {
        this.error = this.playerSource.shareDisabledReason || "This video source cannot be shared as a watch room.";
        return;
      }
      if (this.playerRoomCreating) return;
      if (!window.SparkMD5) {
        this.error = "MD5 support is unavailable. Reload the page and try again.";
        return;
      }
      if (!hasWebCrypto()) {
        this.error = webCryptoRequiredMessage("Encrypted watch rooms");
        return;
      }

      this.error = "";
      if (this.playerRoomId || Object.keys(this.playerPeers).length > 0) {
        this.resetWatchRoom();
      }
      this.playerRoomCreating = true;
      this.playerStatus = this.playerSource.checksumPath
        ? "Requesting video checksum from the connector..."
        : "Hashing video for viewer acknowledgement...";
      try {
        this.playerRoomKey = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"],
        );
        const rawKey = await crypto.subtle.exportKey("raw", this.playerRoomKey);
        this.playerRoomKeyText = base64UrlEncode(new Uint8Array(rawKey));

        const createdResponse = await fetch("/api/watch/rooms", {
          method: "POST",
        });
        const created = await createdResponse.json().catch(() => ({}));
        if (!createdResponse.ok) throw new Error(created.error || `Could not create watch room: ${createdResponse.status}`);
        if (!created.roomId) throw new Error("Could not create watch room.");

        this.playerRoomId = created.roomId;
        this.playerRoomLink = `${window.location.origin}/watch/${created.roomId}#key=${this.playerRoomKeyText}`;
        await this.renderPlayerRoomQr();
        this.playerStatus = "Watch room link ready. Publishing stream metadata...";
        await this.publishCurrentWatchRoomMetadata("viewer acknowledgement");
        this.playerStatus = "Watch room ready. Keep this tab open while viewers watch.";
        this.pollWatchRoomParticipants();
      } catch (error) {
        this.error = error.message;
        this.playerStatus = "";
      } finally {
        this.playerRoomCreating = false;
      }
    },

    async renderPlayerRoomQr() {
      this.playerRoomQrDataUrl = "";
      const value = this.playerRoomLink;
      this.playerRoomQrDataUrl = await this.renderQrCode(value);
    },

    async createBigscreenLink() {
      if (!this.playerSource) {
        this.error = "Load a video in the player first.";
        return;
      }
      if (this.playerSource.shareDisabledReason) {
        this.error = this.playerSource.shareDisabledReason;
        return;
      }
      if (!this.playerSource.readRange) {
        this.error = "This video source does not support random-access range streaming.";
        return;
      }
      if (!window.SparkMD5) {
        this.error = "MD5 support is unavailable. Reload the page and try again.";
        return;
      }
      if (!hasWebCrypto()) {
        this.error = webCryptoRequiredMessage("Bigscreen links");
        return;
      }

      this.error = "";
      this.bigscreenStatus = this.playerSource.checksumPath
        ? "Requesting video checksum from the connector..."
        : "Hashing video for Bigscreen acknowledgement...";
      this.bigscreenProgress = 0;
      try {
        if (this.bigscreenTransfer?.channel) this.bigscreenTransfer.channel.close();
        if (this.bigscreenTransfer?.peer) this.bigscreenTransfer.peer.close();

        const hashResult = await this.getPlayerSourceChecksum("Bigscreen acknowledgement", (progress) => {
          this.bigscreenProgress = progress;
        });

        const key = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"],
        );
        const rawKey = await crypto.subtle.exportKey("raw", key);
        const keyText = base64UrlEncode(new Uint8Array(rawKey));
        const created = await fetch("/api/bigscreen/sessions", { method: "POST" }).then((response) => response.json());
        if (!created.sessionId) throw new Error("Could not create Bigscreen session.");

        const metadata = {
          name: this.playerSource.title,
          type: this.playerSource.type || "video/mp4",
          size: hashResult.totalBytes,
          md5: hashResult.md5,
          originalMd5: hashResult.provisional ? hashResult.md5 : "",
          originalSize: hashResult.originalBytes || 0,
          checksumKind: hashResult.provisional ? "original-source" : "stream",
          provisional: Boolean(hashResult.provisional),
          source: this.playerSource.sourceLabel,
          mode: "Bigscreen P2P range stream",
          sharedAt: new Date().toISOString(),
          playbackProfile: this.playerSource.playbackProfile || null,
          mediaInfo: mediaInfoSummary(this.playerSource.mediaInfo),
          progressiveTranscode: this.playerSource.progressiveTranscode ? {
            percent: Number(this.playerTranscodeAvailablePercent || 0),
            availableBytes: Number(this.playerSource.transcodedAvailableBytes || this.playerSource.size || 0),
            complete: false,
          } : null,
        };
        const metadataIv = crypto.getRandomValues(new Uint8Array(12));
        const encryptedMetadata = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: metadataIv },
          key,
          new TextEncoder().encode(JSON.stringify(metadata)),
        );

        const peer = new RTCPeerConnection(P2P_CONFIG);
        const channel = peer.createDataChannel("file-pipe-bigscreen", { ordered: true });
        channel.binaryType = "arraybuffer";
        channel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFER_LOW_THRESHOLD;
        const transfer = {
          id: created.sessionId,
          peer,
          channel,
          key,
          metadata,
          cancelledRanges: new Set(),
          status: "Creating offer",
        };
        this.bigscreenTransfer = transfer;

        channel.onopen = () => {
          transfer.status = "Connected";
          this.bigscreenStatus = "Bigscreen player connected. Range streaming is ready.";
        };
        channel.onmessage = async (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "range-request") {
            await this.streamBigscreenRange(message, transfer);
          } else if (message.type === "range-cancel") {
            transfer.cancelledRanges.add(message.requestId);
          }
        };
        channel.onclose = () => {
          if (transfer.status !== "Failed") {
            transfer.status = "Disconnected";
            this.bigscreenStatus = "Bigscreen player disconnected.";
          }
        };
        channel.onerror = () => {
          transfer.status = "Failed";
          this.bigscreenStatus = "Bigscreen data channel failed.";
        };

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIceGatheringComplete(peer);

        const offered = await fetch(`/api/bigscreen/sessions/${created.sessionId}/offer`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offer: peer.localDescription,
            metadata: {
              iv: base64UrlEncode(metadataIv),
              ciphertext: base64UrlEncode(new Uint8Array(encryptedMetadata)),
            },
          }),
        });
        if (!offered.ok) {
          const payload = await offered.json().catch(() => ({}));
          throw new Error(payload.error || `Bigscreen signaling failed with ${offered.status}.`);
        }

        this.bigscreenSessionId = created.sessionId;
        this.bigscreenLink = `${window.location.origin}/bigscreen/${created.sessionId}#key=${keyText}`;
        this.bigscreenStatus = "Bigscreen link ready. Keep this launcher tab open.";
        this.bigscreenProgress = 0;
        this.waitForBigscreenAnswer(created.sessionId, peer, transfer);
      } catch (error) {
        this.error = error.message;
        this.bigscreenStatus = "";
        this.bigscreenProgress = 0;
      }
    },

    async waitForBigscreenAnswer(sessionId, peer, transfer) {
      try {
        for (let attempt = 0; attempt < 900; attempt += 1) {
          if (this.bigscreenSessionId !== sessionId) return;
          const signal = await fetch(`/api/bigscreen/sessions/${sessionId}`).then((response) => response.json());
          if (signal.answer) {
            await peer.setRemoteDescription(signal.answer);
            transfer.status = "Connected";
            this.bigscreenStatus = "Bigscreen player answered. Waiting for video range requests.";
            return;
          }
          await sleep(1000);
        }
        transfer.status = "Expired";
        this.bigscreenStatus = "Bigscreen link expired before the player connected.";
      } catch (error) {
        transfer.status = "Failed";
        this.error = error.message;
      }
    },

    async streamBigscreenRange(message, transfer) {
      const channel = transfer.channel;
      if (!channel || channel.readyState !== "open") return;
      const totalSize = Number(transfer.metadata.size || this.playerSource.size || 0);
      const start = Math.max(0, Number(message.start || 0));
      const end = Math.min(totalSize - 1, Number(message.end ?? totalSize - 1));
      const requestId = message.requestId;
      const chunkSize = RANGE_STREAM_CHUNK_SIZE;
      try {
        transfer.cancelledRanges.delete(requestId);
        for (let offset = start; offset <= end; offset += chunkSize) {
          if (transfer.cancelledRanges.has(requestId)) break;
          const nextEnd = Math.min(offset + chunkSize - 1, end);
          const plainChunk = await this.playerSource.readRange(offset, nextEnd + 1);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            transfer.key,
            exactArrayBuffer(plainChunk),
          );
          if (!sendChannelBinaryJson(channel, {
            type: "range-chunk",
            requestId,
            start: offset,
            end: nextEnd,
            iv: base64UrlEncode(iv),
          }, ciphertext)) throw dataChannelDisconnectedError();
          if (!(await waitForDataChannelBuffer(channel))) throw dataChannelDisconnectedError();
          if (shouldUpdateChannelUi(transfer)) {
            this.bigscreenProgress = totalSize ? Math.round((nextEnd / totalSize) * 100) : 0;
            this.bigscreenStatus = `Streaming Bigscreen range ${formatRange(start, end)}.`;
          }
        }
        if (!transfer.cancelledRanges.has(requestId)) {
          if (!sendChannelJson(channel, { type: "range-done", requestId })) throw dataChannelDisconnectedError();
        }
        transfer.cancelledRanges.delete(requestId);
      } catch (error) {
        if (isDataChannelClosedError(error)) {
          transfer.status = "Disconnected";
          this.bigscreenStatus = "Bigscreen viewer disconnected.";
        } else {
          sendChannelJson(channel, {
            type: "range-error",
            requestId,
            error: error.message,
          });
        }
      }
    },

    broadcastTranscodeProgress(percent, availableBytes = 0) {
      if (!this.playerRoomId || !this.playerRoomMetadata?.progressiveTranscode) return;
      const normalizedPercent = Math.max(0, Math.min(100, Number(percent || 0)));
      const normalizedBytes = Math.max(0, Number(availableBytes || this.playerSource?.transcodedAvailableBytes || 0));
      this.playerRoomMetadata.progressiveTranscode = {
        percent: normalizedPercent,
        availableBytes: normalizedBytes,
        complete: normalizedPercent >= 100,
      };
      for (const record of this.connectedWatchPeers()) {
        sendChannelJson(record.channel, {
          type: "transcode-progress",
          percent: normalizedPercent,
          availableBytes: normalizedBytes,
          complete: normalizedPercent >= 100,
        });
      }
    },

    async pollWatchRoomParticipants() {
      if (!this.playerRoomId) return;
      const token = this.playerPollToken + 1;
      this.playerPollToken = token;
      this.playerPollActive = true;
      const roomId = this.playerRoomId;
      try {
        while (roomId && this.playerRoomId === roomId && this.playerPollToken === token) {
          try {
            const state = await fetch(`/api/watch/rooms/${roomId}`).then((response) => response.json());
            for (const participant of state.participants || []) {
              if (participant.kicked) {
                const kicked = this.playerPeers[participant.id];
                if (kicked) kicked.status = "Kicked";
                continue;
              }
              const existing = this.playerPeers[participant.id];
              if (!existing || existing.generation !== participant.generation) {
                if (existing) {
                  if (existing.channel) existing.channel.close();
                  if (existing.peer) existing.peer.close();
                  this.removeHostVoiceElement(existing.id);
                }
                this.playerPeers[participant.id] = {
                  id: participant.id,
                  name: participant.name,
                  status: "Connecting",
                  sentBytes: 0,
                  generation: participant.generation,
                  cancelledRanges: new Set(),
                  readySyncId: "",
                  allowControl: Boolean(existing?.allowControl),
                  localVoiceMuted: Boolean(existing?.localVoiceMuted),
                  remoteMicMuted: Boolean(existing?.remoteMicMuted),
                  voiceAvailable: Boolean(existing?.voiceAvailable),
                  micMuted: Boolean(existing?.micMuted),
                  mediaCapabilities: existing?.mediaCapabilities || null,
                };
                this.connectWatchParticipant(participant);
              } else if (participant.kicked) {
                this.playerPeers[participant.id].status = "Kicked";
              } else if (participant.answer && !this.playerPeers[participant.id].remoteSet) {
                await this.playerPeers[participant.id].peer.setRemoteDescription(participant.answer);
                this.playerPeers[participant.id].remoteSet = true;
                this.playerPeers[participant.id].status = "Connected";
              }
            }
          } catch (error) {
            this.error = error.message;
          }
          await sleep(1000);
        }
      } finally {
        if (this.playerPollToken === token) {
          this.playerPollActive = false;
        }
      }
    },

    async connectWatchParticipant(participant) {
      const record = this.playerPeers[participant.id];
      try {
        const peer = new RTCPeerConnection(P2P_CONFIG);
        const channel = peer.createDataChannel("file-pipe-watch", { ordered: true });
        channel.binaryType = "arraybuffer";
        channel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFER_LOW_THRESHOLD;
        record.peer = peer;
        record.channel = channel;
        this.attachHostVoiceToPeer(peer);
        peer.ontrack = (event) => this.handleHostIncomingVoice(record, event);

        channel.onopen = () => {
          record.status = "Connected";
          this.sendPlayerState(channel, "state");
          this.sendHostVoiceState(channel);
          sendChannelJson(channel, {
            type: "control-permission",
            allowed: record.allowControl,
          });
          if (record.remoteMicMuted) {
            sendChannelJson(channel, {
              type: "voice-control",
              action: "mute",
            });
          }
        };
        channel.onmessage = async (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "voice-state") {
            this.updateParticipantVoiceState(record, message);
            return;
          }
          if (message.type === "media-capabilities") {
            record.mediaCapabilities = message.capabilities || null;
            this.ensureWatchRoomCompatibleWithPeer(record);
            return;
          }
          if (message.type === "range-request") {
            record.status = "Range streaming";
            await this.streamWatchRange(message, record);
            return;
          }
          if (message.type === "range-cancel") {
            record.cancelledRanges?.add(message.requestId);
            return;
          }
          if (message.type === "segment-ready") {
            this.markViewerSegmentReady(record, message);
            return;
          }
          if (message.type === "participant-control") {
            this.handleParticipantControl(record, message);
            return;
          }
          if (message.type === "ready") {
            if (record.videoStreaming) {
              record.status = "Already streaming";
              return;
            }
            if (record.videoComplete) {
              this.sendPlayerState(channel, "state");
              return;
            }
            record.status = "Streaming";
            await this.streamVideoToViewer(record);
            this.sendPlayerState(channel, "state");
          }
        };
        channel.onclose = () => {
          if (record.status !== "Complete") record.status = "Disconnected";
        };
        channel.onerror = () => {
          record.status = "Failed";
        };
        peer.onconnectionstatechange = () => {
          if (["failed", "disconnected"].includes(peer.connectionState) && record.status !== "Complete") {
            record.status = "Disconnected";
          }
          if (peer.connectionState === "connected") {
            record.status = "Connected";
          }
        };

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await waitForIceGatheringComplete(peer);
        const response = await fetch(`/api/watch/rooms/${this.playerRoomId}/participants/${participant.id}/offer`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offer: peer.localDescription }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || `Could not publish viewer offer: ${response.status}`);
        }
        record.status = "Waiting for answer";
      } catch (error) {
        record.status = "Failed";
        this.error = error.message;
      }
    },

    async streamVideoToViewer(record) {
      const channel = record.channel;
      record.videoStreaming = true;
      record.videoComplete = false;
      const streamMd5 = new SparkMD5.ArrayBuffer();
      try {
        if (!sendChannelJson(channel, { type: "video-start", metadata: this.playerRoomMetadata })) {
          throw dataChannelDisconnectedError();
        }
        const opened = await this.playerSource.openStream();
        let sentBytes = 0;
        let chunkIndex = 0;
        const sendPlainChunk = async (plainChunk) => {
          for (const part of splitArrayBuffer(exactArrayBuffer(plainChunk), 48 * 1024)) {
            streamMd5.append(part);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.playerRoomKey, part);
            if (!sendChannelJson(channel, {
              type: "video-chunk",
              index: chunkIndex,
              iv: base64UrlEncode(iv),
              data: base64UrlEncode(new Uint8Array(ciphertext)),
              plainSize: part.byteLength,
            })) throw dataChannelDisconnectedError();
            if (!(await waitForDataChannelBuffer(channel))) throw dataChannelDisconnectedError();
            sentBytes += part.byteLength;
            chunkIndex += 1;
            record.sentBytes = sentBytes;
            record.status = this.playerRoomMetadata.size
              ? `Streaming ${Math.round((sentBytes / this.playerRoomMetadata.size) * 100)}%`
              : "Streaming";
          }
        };

        if (opened.stream) {
          const reader = opened.stream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength) await sendPlainChunk(value);
          }
        } else {
          await sendPlainChunk(await opened.arrayBuffer());
        }
        const md5 = streamMd5.end();
        if (!sendChannelJson(channel, {
          type: "video-done",
          md5,
          expectedMd5: this.playerRoomMetadata.checksumKind === "original-source" ? "" : this.playerRoomMetadata.md5,
          chunkCount: chunkIndex,
          sentBytes,
        })) throw dataChannelDisconnectedError();
        const hashMatches = this.playerRoomMetadata.checksumKind === "original-source" || md5 === this.playerRoomMetadata.md5;
        record.status = hashMatches ? "Complete" : "Hash mismatch";
        record.videoComplete = hashMatches;
      } catch (error) {
        if (isDataChannelClosedError(error)) {
          record.status = "Disconnected";
        } else {
          record.status = "Failed";
          this.error = error.message;
        }
        if (!isDataChannelClosedError(error) && isDataChannelOpen(channel)) {
          sendChannelJson(channel, { type: "video-error", error: error.message });
        }
      } finally {
        record.videoStreaming = false;
      }
    },

    async streamWatchRange(message, record) {
      const channel = record.channel;
      if (!channel || channel.readyState !== "open") return;
      const sourceVersion = Number(this.playerRoomMetadata?.sourceVersion || 0);
      if (message.sourceVersion && Number(message.sourceVersion) !== sourceVersion) {
        sendChannelJson(channel, {
          type: "range-error",
          requestId: message.requestId,
          sourceVersion: message.sourceVersion,
          error: "The host switched video sources. Reloading the viewer stream.",
        });
        return;
      }
      const source = this.playerSource;
      const totalSize = Number(this.playerRoomMetadata?.size || source?.size || 0);
      const start = Math.max(0, Number(message.start || 0));
      const end = Math.min(totalSize - 1, Number(message.end ?? totalSize - 1));
      const requestId = message.requestId;
      const chunkSize = RANGE_STREAM_CHUNK_SIZE;
      const rangeMd5 = new SparkMD5.ArrayBuffer();
      let sentBytes = 0;
      try {
        record.cancelledRanges?.delete(requestId);
        if (source?.progressiveTranscode) {
          const ready = await this.waitForProgressiveTranscodeOffset(start, record, requestId);
          if (!ready) return;
        }
        for (let offset = start; offset <= end; offset += chunkSize) {
          if (record.cancelledRanges?.has(requestId)) break;
          const nextEnd = Math.min(offset + chunkSize - 1, end);
          if (source?.progressiveTranscode) {
            const ready = await this.waitForProgressiveTranscodeOffset(nextEnd, record, requestId);
            if (!ready) break;
          }
          const plainChunk = exactArrayBuffer(await source.readRange(offset, nextEnd + 1));
          rangeMd5.append(plainChunk);
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            this.playerRoomKey,
            plainChunk,
          );
          if (!sendChannelBinaryJson(channel, {
            type: "range-chunk",
            requestId,
            start: offset,
            end: nextEnd,
            sourceVersion,
            iv: base64UrlEncode(iv),
          }, ciphertext)) throw dataChannelDisconnectedError();
          if (!(await waitForDataChannelBuffer(channel))) throw dataChannelDisconnectedError();
          sentBytes += plainChunk.byteLength;
          record.sentBytes = (record.sentBytes || 0) + plainChunk.byteLength;
          if (shouldUpdateChannelUi(record)) {
            record.status = `Buffered ${formatRange(start, end)}`;
          }
        }
        if (!record.cancelledRanges?.has(requestId)) {
          if (!sendChannelJson(channel, {
            type: "range-done",
            requestId,
            sourceVersion,
            md5: rangeMd5.end(),
            sentBytes,
          })) throw dataChannelDisconnectedError();
        }
      } catch (error) {
        if (isDataChannelClosedError(error)) {
          record.status = "Disconnected";
        } else {
          record.status = "Range failed";
          this.error = error.message;
        }
        if (!isDataChannelClosedError(error) && isDataChannelOpen(channel)) {
          sendChannelJson(channel, {
            type: "range-error",
            requestId,
            sourceVersion,
            error: error.message,
          });
        }
      } finally {
        record.cancelledRanges?.delete(requestId);
      }
    },

    async waitForProgressiveTranscodeOffset(offset, record, requestId) {
      const totalSize = Number(this.playerRoomMetadata?.size || this.playerSource?.estimatedFinalSize || this.playerSource?.size || 0);
      if (!totalSize || offset <= 0) return true;
      const requiredPercent = Math.min(100, ((offset + 1) / totalSize) * 100);
      while (this.playerSource?.progressiveTranscode && !this.progressiveTranscodeOffsetReady(offset, requiredPercent)) {
        if (record.cancelledRanges?.has(requestId)) return false;
        if (!isDataChannelOpen(record.channel)) return false;
        record.status = `Waiting for transcode ${Math.ceil(requiredPercent)}%`;
        await sleep(500);
      }
      return true;
    },

    progressiveTranscodeOffsetReady(offset, requiredPercent) {
      const availableBytes = Number(this.playerSource?.transcodedAvailableBytes || this.playerRoomMetadata?.progressiveTranscode?.availableBytes || 0);
      if (availableBytes > 0) return availableBytes > offset;
      return Number(this.playerTranscodeAvailablePercent || 0) + 0.25 >= requiredPercent;
    },

    toggleParticipantControl(record) {
      record.allowControl = !record.allowControl;
      if (record.channel?.readyState === "open") {
        sendChannelJson(record.channel, {
          type: "control-permission",
          allowed: record.allowControl,
        });
      }
      record.status = record.allowControl ? "Control allowed" : "Connected";
    },

    async kickParticipant(record) {
      if (!record || !this.playerRoomId) return;
      try {
        if (record.channel?.readyState === "open") {
          sendChannelJson(record.channel, {
            type: "kicked",
            reason: "The host removed you from the watch room.",
          });
        }
        await fetch(`/api/watch/rooms/${this.playerRoomId}/participants/${record.id}`, {
          method: "DELETE",
        });
      } catch (error) {
        this.error = error.message;
      } finally {
        if (record.channel) record.channel.close();
        if (record.peer) record.peer.close();
        this.removeHostVoiceElement(record.id);
        record.status = "Kicked";
      }
    },

    async ensureWatchRoomCompatibleWithPeer(record) {
      if (!this.playerRoomId || !this.playerRoomMetadata || !record?.mediaCapabilities) return;
      const profile = this.playerRoomMetadata.playbackProfile;
      if (canCapabilitiesPlayProfile(record.mediaCapabilities, profile)) {
        record.mediaStatus = "Compatible";
        return;
      }
      record.mediaStatus = "Needs Stable MP4";
      if (profile?.sourceKind === "stable-mp4") {
        record.status = "Codec unsupported";
        this.playerStatus = `${record.name} reports this browser cannot play the current Stable MP4 source.`;
        return;
      }
      if (!this.playerConnectorLaunch?.mediaInfo?.ffmpegAvailable) {
        record.status = "Codec unsupported";
        this.playerStatus = `${record.name} cannot play ${playbackProfileLabel(profile)}, and Stable MP4 transcode is unavailable.`;
        return;
      }
      await this.switchWatchRoomToStableMp4ForCompatibility(`${record.name} cannot play ${playbackProfileLabel(profile)}.`);
    },

    async switchWatchRoomToStableMp4ForCompatibility(reason) {
      if (this.playerCompatibilitySwitching) return;
      const launch = this.playerConnectorLaunch;
      if (!launch?.item || !launch?.resource || !launch?.mediaInfo?.ffmpegAvailable) return;
      this.playerCompatibilitySwitching = true;
      const video = document.getElementById("host-video-player");
      const resumeTime = video?.currentTime || 0;
      const wasPaused = !video || video.paused;
      const playbackRate = video?.playbackRate || 1;
      this.hostSyncBarrier = null;
      this.clearPendingHostSeekSync();
      this.playerStatus = `Switching room to Stable MP4. ${reason}`;
      try {
        await this.launchFullTranscodedConnectorVideo(launch.item, launch.resource, launch.mediaInfo, launch.transcodeParts);
        this.playerConnectorLaunch = launch;
        const switchedVideo = document.getElementById("host-video-player");
        if (switchedVideo) {
          this.suppressHostPlayerEvents = true;
          switchedVideo.pause();
          switchedVideo.currentTime = resumeTime;
          switchedVideo.playbackRate = playbackRate;
          setTimeout(() => {
            this.suppressHostPlayerEvents = false;
          }, 1000);
        }
        await this.publishCurrentWatchRoomMetadata("compatibility fallback");
        for (const peer of this.connectedWatchPeers()) {
          peer.videoComplete = false;
          peer.readySyncId = "";
          peer.cancelledRanges?.clear();
          sendChannelJson(peer.channel, {
            type: "source-update",
            reason: "A participant could not play the original stream, so the room switched to Stable MP4.",
            metadata: this.playerRoomMetadata,
          });
        }
        this.playerStatus = "Room switched to Stable MP4 for participant compatibility.";
        if (!wasPaused) {
          setTimeout(() => this.prepareSynchronizedResume("source-switch", resumeTime), 1200);
        }
      } catch (error) {
        this.error = error.message;
        this.playerStatus = "";
      } finally {
        this.playerCompatibilitySwitching = false;
      }
    },

    handleParticipantControl(record, message) {
      if (!record.allowControl) {
        if (record.channel?.readyState === "open") {
          sendChannelJson(record.channel, {
            type: "control-denied",
            reason: "Shared playback control is not enabled for you.",
          });
        }
        return;
      }
      const video = document.getElementById("host-video-player");
      if (!video) return;
      const currentTime = Number.isFinite(message.currentTime) ? Math.max(0, message.currentTime) : video.currentTime || 0;
      record.status = "Controlling playback";
      if (message.action === "pause") {
        this.hostSyncBarrier = null;
        this.suppressHostPlayerEvents = true;
        video.currentTime = currentTime;
        video.pause();
        setTimeout(() => {
          this.suppressHostPlayerEvents = false;
        }, 600);
        this.broadcastPlayerState("participant-pause");
        return;
      }
      if (message.action === "seek" || message.action === "play") {
        this.suppressHostPlayerEvents = true;
        video.currentTime = currentTime;
        video.pause();
        setTimeout(() => {
          this.suppressHostPlayerEvents = false;
        }, 600);
        if (message.action === "seek") {
          this.scheduleSynchronizedResume(`participant-${message.action}`, currentTime);
        } else {
          this.prepareSynchronizedResume(`participant-${message.action}`, currentTime);
        }
      }
    },

    handleHostPlayerPlay() {
      if (this.suppressHostPlayerEvents) return;
      if (this.playerRoomId && this.connectedWatchPeers().length > 0) {
        this.prepareSynchronizedResume("play");
        return;
      }
      this.broadcastPlayerState("play");
    },

    handleHostPlayerSeeked() {
      if (this.suppressHostPlayerEvents) return;
      if (this.playerRoomId && this.connectedWatchPeers().length > 0) {
        const video = document.getElementById("host-video-player");
        this.scheduleSynchronizedResume("seek", video?.currentTime || 0);
        return;
      }
      this.broadcastPlayerState("seek");
    },

    handleHostPlayerSeeking() {
      const video = document.getElementById("host-video-player");
      if (!video || !this.playerSource?.progressiveTranscode) return;
      const percent = Number(this.playerTranscodeAvailablePercent || 0);
      if (!Number.isFinite(video.duration) || percent <= 0 || percent >= 100) return;
      const maxTime = Math.max(0, (video.duration * percent / 100) - 2);
      if (video.currentTime > maxTime) {
        this.suppressHostPlayerEvents = true;
        video.currentTime = maxTime;
        this.playerStatus = `Still transcoding. Scrubbing is available up to ${percent}%.`;
        setTimeout(() => {
          this.suppressHostPlayerEvents = false;
        }, 300);
      }
    },

    handleHostPlayerPause() {
      if (this.suppressHostPlayerEvents) return;
      this.hostSyncBarrier = null;
      this.clearPendingHostSeekSync();
      this.broadcastPlayerState("pause");
    },

    connectedWatchPeers() {
      return Object.values(this.playerPeers).filter((record) => record.channel?.readyState === "open");
    },

    scheduleSynchronizedResume(reason, currentTime = null) {
      this.clearPendingHostSeekSync();
      const video = document.getElementById("host-video-player");
      const targetTime = Number.isFinite(currentTime) ? Math.max(0, currentTime) : video?.currentTime || 0;
      this.hostSyncBarrier = null;
      this.playerStatus = "Scrub target selected. Waiting briefly for the final position...";
      this.hostSeekSyncTimer = setTimeout(() => {
        this.hostSeekSyncTimer = null;
        this.prepareSynchronizedResume(reason, targetTime);
      }, SEEK_SYNC_DEBOUNCE_MS);
    },

    clearPendingHostSeekSync() {
      if (!this.hostSeekSyncTimer) return;
      clearTimeout(this.hostSeekSyncTimer);
      this.hostSeekSyncTimer = null;
    },

    prepareSynchronizedResume(reason, requestedTime = null) {
      const video = document.getElementById("host-video-player");
      if (!video) return;
      const peers = this.connectedWatchPeers();
      if (peers.length === 0) {
        this.broadcastPlayerState(reason);
        return;
      }
      const syncId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const currentTime = Number.isFinite(requestedTime) ? Math.max(0, requestedTime) : video.currentTime || 0;
      this.hostSyncBarrier = {
        syncId,
        currentTime,
        reason,
        startedAt: Date.now(),
        bufferSeconds: SYNC_BUFFER_SECONDS,
        hostReady: false,
        peerIds: new Set(peers.map((peer) => peer.id)),
      };
      const restoreHostEvents = !this.suppressHostPlayerEvents;
      this.suppressHostPlayerEvents = true;
      video.pause();
      if (restoreHostEvents) {
        setTimeout(() => {
          this.suppressHostPlayerEvents = false;
        }, 600);
      }
      for (const record of peers) {
        record.readySyncId = "";
        record.status = "Buffering sync segment";
        sendChannelJson(record.channel, {
          type: "sync-hold",
          syncId,
          reason,
          currentTime,
          bufferSeconds: SYNC_BUFFER_SECONDS,
          playbackRate: video.playbackRate || 1,
        });
      }
      this.playerStatus = `Waiting for host and viewers to buffer ${SYNC_BUFFER_SECONDS} seconds...`;
      this.waitForHostResumeBuffer(syncId);
      setTimeout(() => {
        if (this.hostSyncBarrier?.syncId !== syncId) return;
        this.hostSyncBarrier.hostReady = true;
        this.playerStatus = "Host buffer did not report enough data while paused. Resuming from the seek target.";
        this.finishSynchronizedResumeIfReady(syncId);
      }, SYNC_FORCE_AFTER_MS);
      setTimeout(() => {
        if (this.hostSyncBarrier?.syncId === syncId) {
          this.playerStatus = "Still waiting for a viewer to report the seek target is ready.";
        }
      }, SYNC_READY_TIMEOUT_MS);
    },

    async waitForHostResumeBuffer(syncId) {
      const video = document.getElementById("host-video-player");
      while (this.hostSyncBarrier?.syncId === syncId) {
        if (video && mediaHasResumeBuffer(
          video,
          this.hostSyncBarrier.currentTime,
          this.hostSyncBarrier.bufferSeconds,
          this.hostSyncBarrier.startedAt,
        )) {
          this.hostSyncBarrier.hostReady = true;
          this.finishSynchronizedResumeIfReady(syncId);
          return;
        }
        await sleep(SYNC_READY_POLL_MS);
      }
    },

    markViewerSegmentReady(record, message) {
      record.readySyncId = message.syncId;
      record.bufferedUntil = message.bufferedUntil;
      record.status = "Ready";
      this.finishSynchronizedResumeIfReady(message.syncId);
    },

    finishSynchronizedResumeIfReady(syncId) {
      if (!this.hostSyncBarrier || this.hostSyncBarrier.syncId !== syncId) return;
      if (!this.hostSyncBarrier.hostReady) return;
      const peers = this.connectedWatchPeers().filter((peer) => this.hostSyncBarrier.peerIds.has(peer.id));
      if (peers.every((peer) => peer.readySyncId === syncId)) {
        this.finishSynchronizedResume(syncId);
      }
    },

    finishSynchronizedResume(syncId) {
      if (!this.hostSyncBarrier || this.hostSyncBarrier.syncId !== syncId) return;
      const video = document.getElementById("host-video-player");
      if (!video) return;
      const resumeDelayMs = SYNC_RESUME_DELAY_MS;
      const payload = {
        type: "resume-at",
        syncId,
        currentTime: this.hostSyncBarrier.currentTime,
        bufferSeconds: this.hostSyncBarrier.bufferSeconds,
        playbackRate: video.playbackRate || 1,
        resumeDelayMs,
        resumeAt: Date.now() + resumeDelayMs,
      };
      const resumePeers = this.connectedWatchPeers().filter((peer) => this.hostSyncBarrier.peerIds.has(peer.id));
      for (const record of resumePeers) {
        sendChannelJson(record.channel, payload);
        record.status = "Synced";
      }
      this.playerStatus = "Synchronized playback resumed.";
      this.hostSyncBarrier = null;
      setTimeout(() => {
        this.suppressHostPlayerEvents = true;
        video.currentTime = payload.currentTime;
        video.play().catch(() => {
          this.playerStatus = "Playback is synced, but this browser blocked automatic host playback. Press play to resume locally.";
        });
        setTimeout(() => {
          this.suppressHostPlayerEvents = false;
        }, 1500);
      }, resumeDelayMs);
    },

    broadcastPlayerState(reason) {
      if (!this.playerRoomId) return;
      if (this.hostSyncBarrier && reason === "time") return;
      for (const record of Object.values(this.playerPeers)) {
        if (record.channel && record.channel.readyState === "open") {
          this.sendPlayerState(record.channel, reason);
        }
      }
    },

    sendPlayerState(channel, reason) {
      const video = document.getElementById("host-video-player");
      if (!video || channel.readyState !== "open") return;
      sendChannelJson(channel, {
        type: "sync",
        reason,
        currentTime: video.currentTime || 0,
        paused: video.paused,
        playbackRate: video.playbackRate || 1,
        sentAt: Date.now(),
      });
    },

    clearPreview(resetName = true) {
      if (this.previewUrl) {
        URL.revokeObjectURL(this.previewUrl);
      }
      this.previewUrl = "";
      this.previewType = "";
      if (resetName) this.previewItemName = "";
    },

    async goUp() {
      const previous = this.history.pop();
      if (previous === undefined) return;
      await this.browse(previous);
    },

    pathLabel() {
      if (!this.selectedServer) return "Choose a media source to browse.";
      if (this.currentPathLabel) return this.currentPathLabel;
      if (this.currentObjectId === "0") return "Root";
      return `Object ${this.currentObjectId}`;
    },

    sourceLabel(source = this.selectedServer) {
      if (!source) return "Connector";
      return source.sourceType === "local_directory" ? "Local folder" : "DLNA";
    },

    sourceIcon(source) {
      return source?.sourceType === "local_directory" ? "bi-folder2-open" : "bi-hdd-network";
    },

    resourceOpenUrl(item) {
      const resource = item.resources && item.resources[0];
      if (!resource) return "#";
      if (resource.proxyPath) return this.connectorDirectUrl(resource.proxyPath);
      return resource.url || "#";
    },

    iconForItem(item) {
      const type = contentTypeFromProtocol(item.resources?.[0]?.protocolInfo || "");
      if (type.startsWith("image/")) return "bi-file-earmark-image text-info";
      if (type.startsWith("video/")) return "bi-file-earmark-play text-danger";
      if (type.startsWith("audio/")) return "bi-file-earmark-music text-primary";
      return "bi-file-earmark text-secondary";
    },

    isPreviewableType(type) {
      return type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/");
    },

    isVideoItem(item) {
      return contentTypeFromProtocol(item.resources?.[0]?.protocolInfo || "").startsWith("video/");
    },

    initHashNavigation() {
      document.querySelectorAll("#filePipeTabs [data-bs-toggle='tab']").forEach((tab) => {
        tab.addEventListener("shown.bs.tab", (event) => {
          this.updateHashForTab(event.target.id);
        });
      });
      document.querySelectorAll("#shareOptionTabs [data-bs-toggle='pill']").forEach((tab) => {
        tab.addEventListener("shown.bs.tab", (event) => {
          this.updateHashForTab(event.target.id);
        });
      });
    },

    applyHashRoute() {
      const route = window.location.hash.replace(/^#\/?/, "");
      if (!route) return;
      const [mainRoute, childRoute] = route.split("/");
      const mainTabId = APP_TAB_ROUTES[mainRoute];
      if (!mainTabId) return;
      this.showBootstrapTab(mainTabId, false);
      if (mainRoute === "sharing" && childRoute) {
        const shareTabId = SHARE_TAB_ROUTES[childRoute];
        if (shareTabId) {
          window.setTimeout(() => this.showBootstrapTab(shareTabId, false), 0);
        }
      }
    },

    updateHashForTab(tabId) {
      const route = TAB_ID_ROUTES[tabId];
      if (!route) return;
      let nextHash = `#${route}`;
      if (tabId === "sharing-tab") {
        const activeShareTab = document.querySelector("#shareOptionTabs .nav-link.active");
        const shareRoute = activeShareTab ? TAB_ID_ROUTES[activeShareTab.id] : "";
        if (shareRoute && shareRoute !== "sharing/dlna") {
          nextHash = `#${shareRoute}`;
        }
      }
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
      }
    },

    showBootstrapTab(tabId) {
      const tab = document.getElementById(tabId);
      if (tab && window.bootstrap) {
        window.bootstrap.Tab.getOrCreateInstance(tab).show();
      }
    },

    activeTransferCount() {
      const activeStatuses = new Set([
        "Preparing",
        "Hashing",
        "Creating offer",
        "Waiting for recipient",
        "Waiting for acknowledgement",
        "Recipient connected",
        "Sending",
      ]);
      return this.outgoingTransfers.filter((transfer) => activeStatuses.has(transfer.status)).length;
    },

    badgeForTransfer(transfer) {
      if (transfer.status === "Ready") return "text-bg-success";
      if (transfer.status === "Failed") return "text-bg-danger";
      return "text-bg-primary";
    },

    formatBytes(bytes) {
      if (!bytes) return "0 B";
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

const APP_TAB_ROUTES = {
  explorer: "explorer-tab",
  sharing: "sharing-tab",
  player: "player-tab",
  activity: "activity-tab",
  connector: "connector-tab",
  "local-connector": "connector-tab",
};

const SHARE_TAB_ROUTES = {
  dlna: "share-dlna-tab",
  local: "share-local-tab",
};

const TAB_ID_ROUTES = {
  "explorer-tab": "explorer",
  "sharing-tab": "sharing",
  "player-tab": "player",
  "activity-tab": "activity",
  "connector-tab": "connector",
  "share-dlna-tab": "sharing/dlna",
  "share-local-tab": "sharing/local",
};

const P2P_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};
const DATA_CHANNEL_BUFFER_LOW_THRESHOLD = 2 * 1024 * 1024;
const RANGE_STREAM_CHUNK_SIZE = 96 * 1024;
const CHANNEL_UI_UPDATE_INTERVAL_MS = 500;
const SYNC_BUFFER_SECONDS = 3;
const SYNC_RELAXED_BUFFER_SECONDS = 1;
const SYNC_RELAX_AFTER_MS = 3500;
const SYNC_FORCE_AFTER_MS = 7000;
const SYNC_READY_POLL_MS = 250;
const SYNC_READY_TIMEOUT_MS = 20000;
const SYNC_RESUME_DELAY_MS = 1200;
const SEEK_SYNC_DEBOUNCE_MS = 450;

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function contentTypeFromProtocol(protocolInfo) {
  const parts = (protocolInfo || "").split(":");
  return parts.length >= 3 && parts[2] ? parts[2] : "application/octet-stream";
}

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

async function computeSourceMd5(opened, fallbackSize, onProgress) {
  const md5 = new SparkMD5.ArrayBuffer();
  let bytesRead = 0;
  const totalBytes = Number(opened.totalBytes || fallbackSize || 0);

  const appendChunk = (chunk) => {
    const buffer = exactArrayBuffer(chunk);
    md5.append(buffer);
    bytesRead += buffer.byteLength;
    if (onProgress) onProgress(bytesRead, totalBytes);
  };

  if (opened.stream) {
    const reader = opened.stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) appendChunk(value);
    }
  } else {
    const buffer = await opened.arrayBuffer();
    appendChunk(buffer);
  }

  return {
    md5: md5.end(),
    totalBytes: totalBytes || bytesRead,
  };
}

function splitArrayBuffer(buffer, size) {
  const chunks = [];
  for (let offset = 0; offset < buffer.byteLength; offset += size) {
    chunks.push(buffer.slice(offset, offset + size));
  }
  return chunks;
}

function sendChannelJson(channel, payload) {
  if (!isDataChannelOpen(channel)) return false;
  try {
    channel.send(JSON.stringify(payload));
    return true;
  } catch (error) {
    if (isDataChannelClosedError(error)) return false;
    throw error;
  }
}

function sendChannelBinaryJson(channel, header, payload) {
  if (!isDataChannelOpen(channel)) return false;
  try {
    channel.send(encodeChannelBinaryJson(header, payload));
    return true;
  } catch (error) {
    if (isDataChannelClosedError(error)) return false;
    throw error;
  }
}

function encodeChannelBinaryJson(header, payload) {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const payloadBytes = new Uint8Array(exactArrayBuffer(payload));
  const frame = new Uint8Array(4 + headerBytes.byteLength + payloadBytes.byteLength);
  new DataView(frame.buffer).setUint32(0, headerBytes.byteLength);
  frame.set(headerBytes, 4);
  frame.set(payloadBytes, 4 + headerBytes.byteLength);
  return frame.buffer;
}

function isDataChannelOpen(channel) {
  return channel?.readyState === "open";
}

function dataChannelDisconnectedError() {
  const error = new Error("Peer disconnected.");
  error.code = "DATA_CHANNEL_CLOSED";
  return error;
}

function isDataChannelClosedError(error) {
  if (!error) return false;
  return (
    error.code === "DATA_CHANNEL_CLOSED"
    || error.name === "InvalidStateError"
    || String(error.message || "").includes("RTCDataChannel.readyState")
    || String(error.message || "").includes("readyState is not 'open'")
  );
}

function shouldUpdateChannelUi(target, intervalMs = CHANNEL_UI_UPDATE_INTERVAL_MS) {
  const now = Date.now();
  if (now - Number(target.lastChannelUiUpdate || 0) < intervalMs) return false;
  target.lastChannelUiUpdate = now;
  return true;
}

function hasWebCrypto() {
  return Boolean(globalThis.crypto?.subtle);
}

function webCryptoRequiredMessage(feature) {
  return `${feature} require Web Crypto, but this browser only exposes it on secure origins. Open File Pipe over HTTPS, or use http://localhost / http://127.0.0.1 for local development. Current origin: ${window.location.origin}`;
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

function formatRange(start, end) {
  return `${formatByteOffset(start)}-${formatByteOffset(end)}`;
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

function mediaPlaybackDecisionForCapabilities(mediaInfo, contentType = "", capabilities = detectMediaPlaybackCapabilities()) {
  if (!mediaInfo?.ok) {
    return {
      shouldTranscode: false,
      audioPlayable: true,
      videoPlayable: true,
      reason: "unknown",
    };
  }
  const audioCodec = codecName(mediaInfo.audioCodec);
  const videoCodec = codecName(mediaInfo.videoCodec);
  const hasAudio = Boolean(mediaInfo.defaultAudio);
  const hasVideo = Boolean(mediaInfo.defaultVideo);
  const audioPlayable = !hasAudio || Boolean(mediaInfo.audioPlayable);
  let videoPlayable = !hasVideo || Boolean(mediaInfo.videoPlayable);
  let reason = videoPlayable ? "native" : "unsupported";
  if (!videoPlayable && isHevcCodec(videoCodec) && isMp4LikeContentType(contentType) && capabilities?.videoCodecs?.hevc) {
    videoPlayable = true;
    reason = "hevc-supported";
  }
  return {
    shouldTranscode: (hasAudio && !audioPlayable) || (hasVideo && !videoPlayable),
    audioPlayable,
    videoPlayable,
    reason,
  };
}

function playbackProfileFromMediaInfo(mediaInfo, contentType = "", sourceKind = "original") {
  const videoCodec = codecName(mediaInfo?.videoCodec);
  const audioCodec = codecName(mediaInfo?.audioCodec);
  return {
    sourceKind,
    containerType: contentType || "application/octet-stream",
    videoCodec,
    audioCodec,
    universal: sourceKind === "stable-mp4" || (videoCodec === "h264" && ["", "aac", "mp3"].includes(audioCodec) && isMp4LikeContentType(contentType)),
  };
}

function stableMp4PlaybackProfile(mediaInfo) {
  return {
    sourceKind: "stable-mp4",
    containerType: "video/mp4",
    videoCodec: "h264",
    audioCodec: mediaInfo?.defaultAudio ? "aac" : "",
    universal: true,
  };
}

function mediaInfoSummary(mediaInfo) {
  if (!mediaInfo) return null;
  return {
    ok: mediaInfo.ok,
    audioCodec: mediaInfo.audioCodec || "",
    videoCodec: mediaInfo.videoCodec || "",
    audioPlayable: Boolean(mediaInfo.audioPlayable),
    videoPlayable: Boolean(mediaInfo.videoPlayable),
    shouldTranscode: Boolean(mediaInfo.shouldTranscode),
    defaultAudio: mediaInfo.defaultAudio ? {
      codec_name: mediaInfo.defaultAudio.codec_name,
      profile: mediaInfo.defaultAudio.profile,
    } : null,
    defaultVideo: mediaInfo.defaultVideo ? {
      codec_name: mediaInfo.defaultVideo.codec_name,
      profile: mediaInfo.defaultVideo.profile,
      pix_fmt: mediaInfo.defaultVideo.pix_fmt,
      width: mediaInfo.defaultVideo.width,
      height: mediaInfo.defaultVideo.height,
    } : null,
  };
}

function canCapabilitiesPlayProfile(capabilities, profile) {
  if (!profile || profile.universal || profile.sourceKind === "stable-mp4") return true;
  const videoCodec = codecName(profile.videoCodec);
  if (isHevcCodec(videoCodec)) {
    return Boolean(capabilities?.videoCodecs?.hevc) && isMp4LikeContentType(profile.containerType);
  }
  if (videoCodec === "h264" || videoCodec === "avc1") {
    return capabilities?.videoCodecs?.h264 !== false;
  }
  return true;
}

function playbackProfileLabel(profile) {
  if (!profile) return "the current source";
  const videoCodec = profile.videoCodec ? profile.videoCodec.toUpperCase() : "video";
  const container = profile.containerType || "unknown container";
  return `${videoCodec} in ${container}`;
}

function codecName(value) {
  const codec = String(value || "").toLowerCase().trim();
  if (codec === "h265") return "hevc";
  if (codec === "avc" || codec === "avc1") return "h264";
  return codec;
}

function isHevcCodec(codec) {
  return ["hevc", "h265", "hvc1", "hev1"].includes(codecName(codec));
}

function isMp4LikeContentType(contentType) {
  const type = String(contentType || "").toLowerCase();
  return type.includes("mp4") || type.includes("quicktime") || type.includes("x-m4v");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

async function waitForDataChannelBuffer(channel) {
  if (!isDataChannelOpen(channel)) return false;
  if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return true;
  return new Promise((resolve) => {
    let finished = false;
    const cleanup = () => {
      channel.removeEventListener("bufferedamountlow", done);
      channel.removeEventListener("close", done);
      channel.removeEventListener("error", done);
      clearTimeout(timeout);
    };
    const done = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(isDataChannelOpen(channel));
    };
    const timeout = setTimeout(done, 15000);
    channel.addEventListener("bufferedamountlow", done, { once: true });
    channel.addEventListener("close", done, { once: true });
    channel.addEventListener("error", done, { once: true });
  });
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
