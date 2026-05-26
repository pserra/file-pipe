const HOST_WATCH_ROOM_STORAGE_KEY = "filePipeHostWatchRoom";
const HOST_WATCH_ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const WATCH_LIST_STORAGE_KEY = "filePipeWatchListV1";

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
    connectorSettings: { hostName: "", pinnedWatchRoom: false },
    servers: [],
    selectedServer: null,
    selectedServerId: "",
    items: [],
    history: [],
    currentObjectId: "0",
    currentPathLabel: "",
    selectedResourceIds: {},
    connectorDirectories: [],
    loadingServers: false,
    loadingDirectories: false,
    loadingItems: false,
    sharingItemId: null,
    transcodeItemId: null,
    transcodeProgress: 0,
    transcodeStatus: "",
    fileMediaStatus: {},
    transcodePlaybackMode: localStorage.getItem("filePipeTranscodePlaybackMode") || "segmented",
    hostVideoMode: localStorage.getItem("filePipeHostVideoMode") || "normal",
    stereo3dLayout: localStorage.getItem("filePipeStereo3dLayout") || "half-sbs",
    stereo3dProcessor: localStorage.getItem("filePipeStereo3dProcessor") || "ffmpeg-shift",
    stereo3dProcessorOptions: stereo3dProcessorOptions(),
    shareProgress: 0,
    shareStatus: "",
    shareLink: "",
    shareQrDataUrl: "",
    shareQrStatus: "",
    localFile: null,
    localFileName: "",
    localFileSize: 0,
    localFileType: "",
    outgoingTransfers: [],
    peerShareSessions: {},
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
    hostProgressTracker: null,
    hostProgressiveMse: null,
    playerRoomLink: "",
    playerAudioOutputLink: "",
    playerAudioOutputStatus: "",
    playerRoom3dStatus: "",
    playerRoom3dError: "",
    playerRoomQrDataUrl: "",
    playerRoomId: "",
    playerRoomRestored: false,
    restoredWatchRoomContentKey: "",
    qrModalOpen: false,
    qrModalTitle: "",
    qrModalUrl: "",
    qrModalDataUrl: "",
    qrModalStatus: "",
    playerSettingsModalOpen: false,
    sourceInfoModalOpen: false,
    playerStatus: "",
    playerAudioStatus: "",
    playerLoading: false,
    playerSidePanelOpen: localStorage.getItem("filePipePlayerSidePanelOpen") !== "false",
    playerPanelOpen: {
      playback: true,
      watchList: false,
      watchRoom: false,
      bigscreen: false,
      viewers: false,
      voice: false,
    },
    watchList: [],
    watchListAutoAdvance: localStorage.getItem("filePipeWatchListAutoAdvance") !== "false",
    playerTranscodeAvailablePercent: 0,
    playerTranscodeComplete: false,
    hostLinearPlaybackTime: 0,
    playerPeers: {},
    playerShareProgress: 0,
    playerMd5: "",
    playerRoomKey: null,
    playerRoomKeyText: "",
    playerRoomMetadata: null,
    playerRoomSource: null,
    playerRoomRangeSource: null,
    playerRoomHlsSource: null,
    playerRoomHls3dSource: null,
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
      this.loadWatchList();
      this.refreshAudioDevices();
      this.checkConnector();
      this.restoreStoredWatchRoom();
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

    openPlayerSettingsModal() {
      this.playerSettingsModalOpen = true;
    },

    closePlayerSettingsModal() {
      this.playerSettingsModalOpen = false;
    },

    openSourceInfoModal() {
      if (!this.playerSource && !this.playerRoomMetadata) return;
      this.sourceInfoModalOpen = true;
    },

    closeSourceInfoModal() {
      this.sourceInfoModalOpen = false;
    },

    closeAllPlayerModals() {
      this.closePlayerSettingsModal();
      this.closeSourceInfoModal();
      this.closeQrModal();
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

    async updateShareQrCode(url) {
      this.shareQrDataUrl = "";
      if (!url) {
        this.shareQrStatus = "";
        return;
      }
      if (!this.hasQrGenerator()) {
        this.shareQrStatus = "QR code generation is unavailable.";
        return;
      }
      this.shareQrStatus = "Generating QR code...";
      try {
        this.shareQrDataUrl = await this.renderQrCode(url, 260);
        this.shareQrStatus = "";
      } catch (error) {
        this.shareQrStatus = "Could not generate the QR code.";
      }
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

    connectorDirectUrl(path, params = {}) {
      const url = new URL(`${this.connectorUrl}${path}`);
      Object.entries(params || {}).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
      });
      if (this.connectorToken) url.searchParams.set("access_token", this.connectorToken);
      return url.toString();
    },

    connectorPathWithAudioProfile(path, audioProfile = "stereo") {
      return this.connectorPathWithProfiles(path, { audioProfile });
    },

    connectorPathWithProfiles(path, options = {}) {
      const audioProfile = options.audioProfile === "spatial" ? "spatial" : "stereo";
      const videoProfile = normalizeTranscodeVideoProfile(options.videoProfile);
      const stereoProcessor = normalizeStereo3dProcessor(options.stereoProcessor);
      const stereoscopic = isStereoVideoProfile(videoProfile);
      if (audioProfile !== "spatial" && !stereoscopic) return path;
      const url = new URL(path, "https://file-pipe.local");
      if (audioProfile === "spatial") url.searchParams.set("audio_profile", "spatial");
      if (stereoscopic) {
        url.searchParams.set("video_profile", "3d");
        if (videoProfile === "3d-full-sbs") url.searchParams.set("sbs_layout", "full");
        if (stereoProcessor !== "ffmpeg-shift") url.searchParams.set("stereo_processor", stereoProcessor);
      }
      return `${url.pathname}${url.search}`;
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
          ? "Authentication expired. Reload the host page and sign in again."
          : payload.error || `Request failed with ${response.status}.`;
        const error = new Error(message);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      if (!contentType.includes("application/json")) {
        throw new Error(`Expected JSON from ${path}, but received ${contentType || "a non-JSON response"}.`);
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
        this.connectorSettings = {
          hostName: String(health.settings?.hostName || ""),
          pinnedWatchRoom: Boolean(health.settings?.pinnedWatchRoom),
        };
        this.connectorReady = Boolean(health.serviceEnabled !== false) && (!this.connectorAuthRequired || this.connectorAuthenticated);
        if (health.serviceEnabled === false) {
          this.error = "The local connector is turned off. Open the connector toolbar UI to turn it back on.";
        }
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

    resourceSelectionKey(item) {
      return `${this.selectedServerId || "source"}:${item?.id || ""}`;
    },

    selectedResourceForItem(item) {
      const resources = Array.isArray(item?.resources) ? item.resources : [];
      if (!resources.length) return null;
      const selectedId = this.selectedResourceIds[this.resourceSelectionKey(item)];
      return resources.find((resource) => resource.id === selectedId) || resources[0];
    },

    selectResource(item, resourceId) {
      if (!item || !resourceId) return;
      const key = this.resourceSelectionKey(item);
      this.selectedResourceIds = { ...this.selectedResourceIds, [key]: resourceId };
      if (this.isVideoItem(item)) this.refreshVisibleMediaStatus();
    },

    resourceResolutionLabel(resource, mediaInfo = null) {
      const video = mediaInfo?.defaultVideo || {};
      const value = resource?.resolution || (video.width && video.height ? `${video.width}x${video.height}` : "");
      const match = String(value || "").match(/(\d+)\s*x\s*(\d+)/i);
      if (!match) return "";
      const width = Number(match[1]);
      const height = Number(match[2]);
      if (!width || !height) return "";
      const stereoscopic = width >= height * 3.2 ? " SBS" : "";
      if (height >= 2000) return `4K${stereoscopic}`;
      if (height >= 1300) return `1440p${stereoscopic}`;
      if (height >= 1000) return `1080p${stereoscopic}`;
      if (height >= 700) return `720p${stereoscopic}`;
      if (height >= 450) return `480p${stereoscopic}`;
      return `${width}x${height}`;
    },

    resourceContainerLabel(resource) {
      const contentType = contentTypeFromProtocol(resource?.protocolInfo || "");
      const subtype = contentType.split("/")[1] || "";
      const normalized = subtype.split(";")[0].replace(/^x-/, "");
      const labels = {
        matroska: "MKV",
        quicktime: "MOV",
        mpegurl: "HLS",
        "vnd.apple.mpegurl": "HLS",
        mp4: "MP4",
        jpeg: "JPEG",
        png: "PNG",
        webp: "WEBP",
      };
      return labels[normalized] || normalized.toUpperCase() || "";
    },

    resourceAudioLabel(resource, mediaInfo = null) {
      if (Array.isArray(mediaInfo?.audioStreams) && mediaInfo.audioStreams.length) {
        const labels = mediaInfo.audioStreams.map((stream) => {
          const codec = String(stream.codec_name || "").toUpperCase();
          const channels = Number(stream.channels || 0);
          return [codec, channels ? `${channels}ch` : ""].filter(Boolean).join(" ");
        }).filter(Boolean);
        const uniqueLabels = [...new Set(labels)];
        if (uniqueLabels.length) return uniqueLabels.slice(0, 3).join(" + ");
      }
      const audio = mediaInfo?.defaultAudio || {};
      const codec = String(audio.codec_name || "").toUpperCase();
      const channels = Number(resource?.nrAudioChannels || audio.channels || mediaInfo?.audioChannels || 0);
      const channelLabel = channels ? `${channels}ch` : "";
      return [codec, channelLabel].filter(Boolean).join(" ");
    },

    resourceDetailLabels(resource, mediaInfo = null) {
      const labels = [
        this.resourceResolutionLabel(resource, mediaInfo),
        this.resourceContainerLabel(resource),
        this.resourceAudioLabel(resource, mediaInfo),
        this.formatDurationValue(resource?.duration || mediaInfo?.duration),
        Number(resource?.size || mediaInfo?.size || 0) ? this.formatBytes(Number(resource?.size || mediaInfo?.size || 0)) : "",
      ].filter(Boolean);
      return [...new Set(labels)];
    },

    resourceLabel(resource, mediaInfo = null) {
      const labels = this.resourceDetailLabels(resource, mediaInfo).slice(0, 4);
      return labels.length ? labels.join(" / ") : "Original file";
    },

    itemLooks3d(item, resource = null) {
      const haystack = `${item?.title || ""} ${item?.class || ""} ${resource?.protocolInfo || ""}`.toLowerCase();
      return /\b(3d|sbs|side[\s-]?by[\s-]?side|mvc|stereoscopic)\b/.test(haystack);
    },

    itemMediaBadges(item) {
      if (item?.type === "container") return [];
      const resource = this.selectedResourceForItem(item);
      const labels = this.resourceDetailLabels(resource, this.mediaInfoForItem(item));
      if (this.itemLooks3d(item, resource) && !labels.some((label) => label.includes("SBS") || label === "3D")) {
        labels.splice(1, 0, "3D");
      }
      return labels.slice(0, 4);
    },

    itemMediaSummary(item) {
      if (item?.type === "container") return "Folder";
      const resource = this.selectedResourceForItem(item);
      const labels = this.resourceDetailLabels(resource, this.mediaInfoForItem(item));
      if (this.itemLooks3d(item, resource) && !labels.some((label) => label.includes("SBS") || label === "3D")) {
        labels.splice(1, 0, "3D");
      }
      if (labels.length) return labels.join(" / ");
      return item?.class || resource?.protocolInfo || "";
    },

    itemThumbnailUrl(item) {
      if (!item || item.type === "container") return "";
      if (item.thumbnailProxyPath) return this.connectorDirectUrl(item.thumbnailProxyPath);
      const resource = this.selectedResourceForItem(item);
      if (!resource?.proxyPath) return "";
      const type = contentTypeFromProtocol(resource.protocolInfo || "");
      return type.startsWith("image/") ? this.connectorDirectUrl(resource.proxyPath) : "";
    },

    durationSeconds(value) {
      if (value === null || value === undefined || value === "") return 0;
      if (typeof value === "number") return value > 100000 ? value / 1000 : value;
      const text = String(value).trim();
      const durationMatch = text.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
      if (durationMatch) {
        return (Number(durationMatch[1]) * 3600) + (Number(durationMatch[2]) * 60) + Number(durationMatch[3]);
      }
      const numeric = Number(text);
      if (!Number.isFinite(numeric)) return 0;
      return numeric > 100000 ? numeric / 1000 : numeric;
    },

    formatDurationValue(value) {
      const seconds = this.durationSeconds(value);
      if (!seconds) return "";
      const total = Math.max(0, Math.round(seconds));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const remaining = total % 60;
      if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
      if (minutes) return `${minutes}m ${String(remaining).padStart(2, "0")}s`;
      return `${remaining}s`;
    },

    itemPlaybackPercent(item) {
      const resource = this.selectedResourceForItem(item);
      const playback = item?.playback || {};
      const position = this.durationSeconds(playback.viewOffset || playback.resumeOffset || playback.bookmark || playback.lastPlaybackPosition);
      const duration = this.durationSeconds(resource?.duration || playback.duration || item?.metadata?.duration);
      if (!position || !duration || position >= duration) return 0;
      return Math.max(1, Math.min(99, Math.round((position / duration) * 100)));
    },

    itemPlaybackLabel(item) {
      const playback = item?.playback || {};
      const position = this.durationSeconds(playback.viewOffset || playback.resumeOffset || playback.bookmark || playback.lastPlaybackPosition);
      if (!position) return "";
      return `Resume at ${this.formatDurationValue(position)}`;
    },

    async refreshVisibleMediaStatus() {
      const videos = this.items.filter((item) => {
        const resource = this.selectedResourceForItem(item);
        return item.type === "item" && this.isVideoItem(item) && resource?.proxyPath;
      });
      await Promise.all(
        videos.slice(0, 40).map(async (item) => {
          const resource = this.selectedResourceForItem(item);
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
      return this.selectedResourceForItem(item)?.id || item.id;
    },

    mediaStatusFromInfo(mediaInfo) {
      const withMediaInfo = (status) => ({ ...status, mediaInfo });
      const playbackDecision = this.mediaPlaybackDecision(
        mediaInfo,
        contentTypeFromProtocol(mediaInfo?.resource?.protocolInfo || ""),
      );
      if (mediaInfo.transcodedCached) {
        return withMediaInfo({ status: "cached", label: "Browser-safe transcode cached", icon: "bi-cpu-fill", className: "text-success" });
      }
      if (mediaInfo.ok && !playbackDecision.shouldTranscode) {
        return withMediaInfo({ status: "playable", label: "Browser-playable original", icon: "bi-play-circle-fill", className: "text-success" });
      }
      if (mediaInfo.ok && playbackDecision.shouldTranscode && mediaInfo.ffmpegAvailable) {
        return withMediaInfo({ status: "needsTranscode", label: "Needs browser-safe transcode", icon: "bi-cpu", className: "text-warning" });
      }
      if (mediaInfo.ok && playbackDecision.shouldTranscode) {
        return withMediaInfo({ status: "notPlayable", label: "Needs transcode, but ffmpeg is unavailable", icon: "bi-exclamation-triangle-fill", className: "text-danger" });
      }
      return withMediaInfo({ status: "unknown", label: mediaInfo.error || "Media status unavailable", icon: "bi-question-circle", className: "text-secondary" });
    },

    mediaPlaybackDecision(mediaInfo, contentType = "") {
      return mediaPlaybackDecisionForCapabilities(mediaInfo, contentType, this.hostMediaCapabilities);
    },

    mediaStatusForItem(item) {
      return this.fileMediaStatus[this.mediaStatusKey(item)] || null;
    },

    mediaInfoForItem(item) {
      return this.mediaStatusForItem(item)?.mediaInfo || null;
    },

    transcodePlaybackModeLabel() {
      return this.transcodePlaybackMode === "full" ? "Stable MP4" : "Fast segments";
    },

    stereo3dLayoutLabel() {
      return this.stereo3dLayout === "full-sbs" ? "Full SBS" : "Half SBS";
    },

    stereo3dProcessorLabel() {
      const option = this.stereo3dProcessorOptions.find((candidate) => candidate.id === this.stereo3dProcessor);
      return option?.label || "Fast ffmpeg shift";
    },

    hostSpatialAudioEnabled() {
      return Boolean(this.hostXrPlayer?.settings?.spatialAudio);
    },

    hostSpatialAudioAvailable() {
      const mediaInfo = this.playerSource?.mediaInfo || this.playerConnectorLaunch?.mediaInfo || this.playerRoomMetadata?.mediaInfo;
      return Boolean(mediaInfoSpatialAudioCandidate(mediaInfo));
    },

    playerSettingsSummary() {
      return [
        this.transcodePlaybackModeLabel(),
        this.stereo3dLayoutLabel(),
        this.hostSpatialAudioEnabled() ? "Spatial audio" : "Stereo audio",
      ].join(" / ");
    },

    togglePlayerSidePanel() {
      this.playerSidePanelOpen = !this.playerSidePanelOpen;
      localStorage.setItem("filePipePlayerSidePanelOpen", this.playerSidePanelOpen ? "true" : "false");
    },

    setPlayerSidePanelOpen(open) {
      this.playerSidePanelOpen = Boolean(open);
      localStorage.setItem("filePipePlayerSidePanelOpen", this.playerSidePanelOpen ? "true" : "false");
    },

    togglePlayerPanel(panel) {
      this.playerPanelOpen = {
        ...this.playerPanelOpen,
        [panel]: !this.playerPanelOpen[panel],
      };
    },

    playerSourceInfoRows() {
      const source = this.playerSource || {};
      const mediaInfo = source.mediaInfo || this.playerRoomMetadata?.mediaInfo || {};
      const profile = source.playbackProfile || this.playerRoomMetadata?.playbackProfile || {};
      return [
        ["Title", source.title || this.playerTitle || this.playerRoomMetadata?.name || "No video loaded"],
        ["Source", source.sourceLabel || this.playerRoomMetadata?.source || ""],
        ["Container", source.type || profile.containerType || this.playerType || ""],
        ["Size", Number(source.size || mediaInfo.size || 0) ? this.formatBytes(Number(source.size || mediaInfo.size || 0)) : ""],
        ["Duration", this.formatDurationValue(source.duration || mediaInfo.duration || this.playerRoomMetadata?.duration)],
        ["Playback profile", playbackProfileLabel(profile)],
      ].filter((row) => row[1]);
    },

    playerMediaInfoRows() {
      const mediaInfo = this.playerSource?.mediaInfo || this.playerRoomMetadata?.mediaInfo || {};
      const video = mediaInfo.defaultVideo || {};
      const audio = mediaInfo.defaultAudio || {};
      const videoStreams = Array.isArray(mediaInfo.videoStreams)
        ? mediaInfo.videoStreams.map((stream) => [stream.codec_name, stream.width && stream.height ? `${stream.width}x${stream.height}` : "", stream.profile].filter(Boolean).join(" / ")).filter(Boolean).join("; ")
        : "";
      const audioStreams = Array.isArray(mediaInfo.audioStreams)
        ? mediaInfo.audioStreams.map((stream) => [stream.codec_name, stream.channels ? `${stream.channels}ch` : "", stream.channel_layout || stream.tags?.language].filter(Boolean).join(" / ")).filter(Boolean).join("; ")
        : "";
      return [
        ["Video", [mediaInfo.videoCodec || video.codec_name, video.width && video.height ? `${video.width}x${video.height}` : "", video.profile].filter(Boolean).join(" / ")],
        ["Audio", [mediaInfo.audioCodec || audio.codec_name, Number(mediaInfo.audioChannels || audio.channels || 0) ? `${Number(mediaInfo.audioChannels || audio.channels)}ch` : "", mediaInfo.audioChannelLayout || audio.channel_layout].filter(Boolean).join(" / ")],
        ["Video streams", videoStreams],
        ["Audio streams", audioStreams],
        ["Browser playback", mediaInfo.shouldTranscode ? "Transcode needed" : (mediaInfo.ok ? "Original can play" : "")],
        ["Spatial audio", mediaInfoSpatialAudioCandidate(mediaInfo) ? (this.hostSpatialAudioEnabled() ? "Available and enabled" : "Available") : "Not detected"],
        ["3D", mediaInfoStereo3dCandidate(mediaInfo) ? `${this.stereo3dLayoutLabel()} via ${this.stereo3dProcessorLabel()}` : "Not detected"],
      ].filter((row) => row[1]);
    },

    playerCacheInfoRows() {
      const source = this.playerSource || {};
      const mediaInfo = source.mediaInfo || {};
      return [
        ["Transcode mode", this.transcodePlaybackModeLabel()],
        ["Stable MP4", this.playerTranscodeComplete ? "Ready" : (source.progressiveTranscode ? `${Math.round(Number(this.playerTranscodeAvailablePercent || 0))}% ready` : (mediaInfo.transcodedCached ? "Cached" : ""))],
        ["Segmented stream", source.hlsLive || source.type === "application/vnd.apple.mpegurl" ? "Active" : ""],
        ["Buffering", source.progressiveTranscode ? this.hostProgressivePlaybackLabel() : ""],
        ["Watch-room sharing", source.shareDisabledReason || (source.openStream ? "Available" : "")],
      ].filter((row) => row[1]);
    },

    loadWatchList() {
      try {
        const saved = JSON.parse(localStorage.getItem(WATCH_LIST_STORAGE_KEY) || "[]");
        this.watchList = Array.isArray(saved)
          ? saved.filter((entry) => entry?.resource?.proxyPath).slice(0, 80)
          : [];
      } catch (error) {
        localStorage.removeItem(WATCH_LIST_STORAGE_KEY);
        this.watchList = [];
      }
    },

    persistWatchList() {
      localStorage.setItem(WATCH_LIST_STORAGE_KEY, JSON.stringify(this.watchList.slice(0, 80)));
    },

    toggleWatchListAutoAdvance() {
      localStorage.setItem("filePipeWatchListAutoAdvance", this.watchListAutoAdvance ? "true" : "false");
    },

    watchListResourceKey(entry) {
      return entry?.resource?.proxyPath || entry?.resource?.id || `${entry?.source?.serverId || ""}:${entry?.id || entry?.title || ""}`;
    },

    watchListEntryForItem(item) {
      const resource = this.selectedResourceForItem(item);
      if (!resource?.proxyPath) return null;
      return {
        id: item.id,
        title: item.title,
        class: item.class || "",
        resource: { ...resource },
        thumbnailProxyPath: item.thumbnailProxyPath || "",
        artworkUrl: item.artworkUrl || "",
        metadata: item.metadata || {},
        playback: item.playback || {},
        source: {
          serverId: this.selectedServer?.id || "",
          serverName: this.selectedServer?.friendlyName || "Connector",
          sourceType: this.selectedServer?.sourceType || "dlna",
          pathLabel: this.pathLabel(),
        },
        addedAt: new Date().toISOString(),
      };
    },

    isInWatchList(item) {
      const entry = this.watchListEntryForItem(item);
      if (!entry) return false;
      const key = this.watchListResourceKey(entry);
      return this.watchList.some((candidate) => this.watchListResourceKey(candidate) === key);
    },

    addToWatchList(item) {
      if (!this.isVideoItem(item)) {
        this.error = "Choose a video file to add to the watch list.";
        return;
      }
      const entry = this.watchListEntryForItem(item);
      if (!entry) {
        this.error = "This video does not have a playable connector resource.";
        return;
      }
      const key = this.watchListResourceKey(entry);
      const withoutExisting = this.watchList.filter((candidate) => this.watchListResourceKey(candidate) !== key);
      this.watchList = [...withoutExisting, entry].slice(-80);
      this.persistWatchList();
      this.recoveryStatus = "Added to watch list.";
      window.setTimeout(() => {
        if (this.recoveryStatus === "Added to watch list.") this.recoveryStatus = "";
      }, 2500);
    },

    removeWatchListItem(index) {
      this.watchList = this.watchList.filter((_, candidateIndex) => candidateIndex !== index);
      this.persistWatchList();
    },

    clearWatchList() {
      this.watchList = [];
      this.persistWatchList();
    },

    watchListThumbnailUrl(entry) {
      if (!entry?.thumbnailProxyPath) return "";
      return this.connectorDirectUrl(entry.thumbnailProxyPath);
    },

    watchListEntryLabel(entry) {
      return [
        entry?.source?.serverName,
        this.resourceLabel(entry?.resource),
      ].filter(Boolean).join(" / ");
    },

    currentWatchListIndex() {
      const contentKey = String(this.playerSource?.contentKey || "");
      if (!contentKey) return -1;
      return this.watchList.findIndex((entry) => {
        const proxyPath = entry?.resource?.proxyPath;
        return proxyPath && contentKey.includes(proxyPath);
      });
    },

    async playWatchListItem(entry) {
      if (!entry?.resource?.proxyPath) {
        this.error = "This watch-list entry is missing its connector resource.";
        return;
      }
      const item = {
        id: entry.id || entry.resource.id,
        type: "item",
        title: entry.title || "Queued video",
        class: entry.class || "object.item.videoItem",
        resources: [entry.resource],
        thumbnailProxyPath: entry.thumbnailProxyPath || "",
        artworkUrl: entry.artworkUrl || "",
        metadata: entry.metadata || {},
        playback: entry.playback || {},
      };
      await this.launchVideoItem(item);
    },

    async playNextWatchListItem() {
      if (!this.watchList.length) return;
      const currentIndex = this.currentWatchListIndex();
      const nextIndex = currentIndex >= 0 ? currentIndex + 1 : 0;
      if (nextIndex >= this.watchList.length) {
        this.playerStatus = "Watch list complete.";
        return;
      }
      await this.playWatchListItem(this.watchList[nextIndex]);
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
      const resource = this.selectedResourceForItem(item);
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
      const resource = this.selectedResourceForItem(item);
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

    pollTranscodeProgress(resource, title, target = "list", audioProfile = "stereo") {
      let stopped = false;
      const statusPath = this.connectorPathWithAudioProfile(`${resource.proxyPath}/transcode-status`, audioProfile);
      const run = async () => {
        while (!stopped) {
          try {
            const progress = await this.request(statusPath);
            const percent = Number(progress.percent || 0);
            if (percent > 0) {
              const status = progress.status === "finalizing" ? "Finalizing" : "Transcoding";
              if (target === "player") {
                this.playerStatus = `${status} ${title}... ${percent}%`;
                this.playerTranscodeAvailablePercent = percent;
                if (this.playerSource) this.playerSource.progressiveTranscodePercent = percent;
                if (this.playerSource && progress.size) this.playerSource.transcodedAvailableBytes = Number(progress.size);
                if (this.playerSource && progress.estimatedFinalSize) this.playerSource.estimatedFinalSize = Number(progress.estimatedFinalSize);
                this.broadcastTranscodeProgress(percent, Number(progress.size || 0));
                if (progress.cached || progress.complete || percent >= 100) {
                  this.playerStatus = `${title} is fully transcoded.`;
                  this.playerAudioStatus = "";
                  this.playerTranscodeAvailablePercent = 100;
                  this.playerTranscodeComplete = true;
                  if (this.playerSource?.progressiveTranscode) {
                    this.playerSource.progressiveTranscode = false;
                    this.playerSource.shareDisabledReason = "";
                    this.playerSource.size = Number(progress.size || this.playerSource.size || 0);
                    this.playerSource.transcodedAvailableBytes = this.playerSource.size;
                  }
                  this.broadcastTranscodeProgress(100, Number(progress.size || this.playerSource?.size || 0));
                  this.finalizeProgressiveWatchRoomMetadata();
                  this.promoteCompletedStableMp4Player(resource);
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

    promoteCompletedStableMp4Player(resource) {
      if (!resource?.proxyPath || !this.playerUrl || !this.hostProgressiveMse) return;
      const video = document.getElementById("host-video-player");
      const currentTime = video?.currentTime || 0;
      const wasPaused = !video || video.paused;
      const playbackRate = video?.playbackRate || 1;
      this.suppressHostPlayerEvents = true;
      this.teardownHostProgressiveMsePlayer();
      const audioProfile = this.playerSource?.spatialAudioProfile === "spatial" ? "spatial" : "stereo";
      this.playerUrl = this.connectorDirectUrl(this.connectorPathWithAudioProfile(`${resource.proxyPath}/transcoded`, audioProfile));
      setTimeout(() => {
        const upgraded = document.getElementById("host-video-player");
        if (!upgraded) {
          this.suppressHostPlayerEvents = false;
          return;
        }
        upgraded.playbackRate = playbackRate;
        const restorePosition = () => {
          seekVideoTo(upgraded, currentTime);
          if (!wasPaused) {
            playVideoWhenReady(upgraded, 10000).catch(() => {});
          }
          setTimeout(() => {
            this.suppressHostPlayerEvents = false;
          }, 600);
        };
        if (upgraded.readyState === HTMLMediaElement.HAVE_NOTHING) {
          upgraded.addEventListener("loadedmetadata", restorePosition, { once: true });
          upgraded.load();
        } else {
          restorePosition();
        }
      }, 0);
      setTimeout(() => {
        this.suppressHostPlayerEvents = false;
      }, 5000);
    },

    startHostProgressiveMsePlayer(source, linearUrl) {
      const mimeType = stableMp4MseMimeType(source?.mediaInfo);
      if (!mimeType || !source?.openLinearStream) {
        this.playerUrl = linearUrl;
        return;
      }
      this.teardownHostProgressiveMsePlayer();
      const MediaSourceClass = mediaSourceConstructor();
      const mediaSource = new MediaSourceClass();
      const objectUrl = URL.createObjectURL(mediaSource);
      const abortController = new AbortController();
      this.hostProgressiveMse = {
        mediaSource,
        objectUrl,
        abortController,
      };
      this.playerUrl = objectUrl;
      this.playerStatus = "Preparing linear Stable MP4 playback...";
      setTimeout(() => {
        const video = document.getElementById("host-video-player");
        if (video) {
          video.src = objectUrl;
          video.load();
          this.prepareHostPlayerMedia();
        }
        pipeFetchToMediaSource({
          mediaSource,
          mimeType,
          signal: abortController.signal,
          mediaElement: video,
          openStream: () => source.openLinearStream(abortController.signal),
          onBytes: (bytesRead) => {
            if (shouldUpdateChannelUi(source, 1000)) {
              this.playerStatus = `Buffered linear Stable MP4 ${formatByteOffset(bytesRead)}.`;
            }
          },
          onEnded: () => {
            if (this.hostProgressiveMse?.mediaSource === mediaSource && !this.playerTranscodeComplete) {
              this.playerStatus = "Stable MP4 linear stream ended before completion.";
            }
          },
          onError: (error) => {
            if (abortController.signal.aborted) return;
            this.playerStatus = "";
            this.error = error.message;
          },
        });
      }, 0);
    },

    teardownHostProgressiveMsePlayer() {
      if (!this.hostProgressiveMse) return;
      this.hostProgressiveMse.abortController?.abort();
      if (this.hostProgressiveMse.objectUrl) URL.revokeObjectURL(this.hostProgressiveMse.objectUrl);
      this.hostProgressiveMse = null;
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

    async setStereo3dLayout(layout) {
      const nextLayout = normalizeStereo3dLayout(layout);
      const changed = this.stereo3dLayout !== nextLayout;
      this.stereo3dLayout = nextLayout;
      localStorage.setItem("filePipeStereo3dLayout", this.stereo3dLayout);
      if (changed && this.hostVideoMode === "hls3d" && this.playerSource && !this.playerLoading) {
        await this.launchHostStereo3dStream();
      }
      if (changed) await this.refreshCurrentWatchRoom3dMetadata();
    },

    async setStereo3dProcessor(processor) {
      const nextProcessor = normalizeStereo3dProcessor(processor);
      const changed = this.stereo3dProcessor !== nextProcessor;
      this.stereo3dProcessor = nextProcessor;
      localStorage.setItem("filePipeStereo3dProcessor", this.stereo3dProcessor);
      if (changed && this.hostVideoMode === "hls3d" && this.playerSource && !this.playerLoading) {
        await this.launchHostStereo3dStream();
      }
      if (changed) await this.refreshCurrentWatchRoom3dMetadata();
    },

    async refreshCurrentWatchRoom3dMetadata() {
      if (!this.playerRoomId || !this.playerSource || this.playerRoomCreating) return;
      try {
        await this.publishCurrentWatchRoomMetadata("3D stream settings updated.", this.playerSource);
        this.playerStatus = "3D stream settings updated for this watch room.";
      } catch (error) {
        this.error = error.message;
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
      this.updateShareQrCode("");
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
      this.updateShareQrCode("");
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

        const created = await this.appJson("/api/p2p/shares", { method: "POST" });
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

        this.shareLink = `${window.location.origin}/share/${created.shareId}#key=${keyText}`;
        const shareSession = {
          shareId: created.shareId,
          source,
          key,
          keyText,
          metadata,
          encryptedMetadata: {
            iv: base64UrlEncode(metadataIv),
            ciphertext: base64UrlEncode(new Uint8Array(encryptedMetadata)),
          },
          transfer,
          expiresAt: Number(created.expiresAt || 0) * 1000 || Date.now() + 12 * 60 * 60 * 1000,
          peer: null,
          channel: null,
          generation: 0,
          offerToken: "",
          reofferTimer: null,
        };
        transfer.status = "Waiting for recipient";
        transfer.expiresAt = shareSession.expiresAt;
        await this.updateShareQrCode(this.shareLink);
        transfer.progress = 0;
        transfer.bytesSent = 0;
        transfer.totalBytes = hashResult.totalBytes;
        transfer.shareLink = this.shareLink;
        transfer.md5 = metadata.md5;
        this.peerShareSessions[transfer.id] = shareSession;
        await this.publishPeerShareOffer(shareSession);
      } catch (error) {
        this.error = error.message;
        this.shareStatus = "";
        transfer.status = "Failed";
      }
    },

    async publishPeerShareOffer(shareSession) {
      const { transfer } = shareSession;
      if (this.peerShareExpired(shareSession)) {
        transfer.status = "Expired";
        this.shareStatus = "Encrypted link expired. Create a new share link.";
        return;
      }
      if (shareSession.reofferTimer) {
        window.clearTimeout(shareSession.reofferTimer);
        shareSession.reofferTimer = null;
      }
      try {
        shareSession.peer?.close?.();
      } catch (error) {
        // The old peer may already be closed.
      }

      const offerToken = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      shareSession.offerToken = offerToken;
      const peer = new RTCPeerConnection(P2P_CONFIG);
      const channel = peer.createDataChannel("file-pipe", { ordered: true });
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = DATA_CHANNEL_BUFFER_LOW_THRESHOLD;
      shareSession.peer = peer;
      shareSession.channel = channel;
      transfer.peer = peer;
      transfer.channel = channel;
      transfer.key = shareSession.key;
      transfer.status = "Creating offer";
      transfer.progress = 0;
      transfer.bytesSent = 0;
      this.shareProgress = 0;

      let startedSending = false;
      channel.onopen = () => {
        if (shareSession.offerToken !== offerToken) return;
        transfer.status = "Recipient connected";
        this.shareStatus = "Recipient connected. Waiting for their acknowledgement...";
      };
      channel.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        if (message.type !== "ready" || startedSending || shareSession.offerToken !== offerToken) return;
        startedSending = true;
        await this.streamPeerShare(shareSession, channel, offerToken);
      };
      channel.onclose = () => {
        if (shareSession.offerToken !== offerToken) return;
        if (!startedSending && !["Complete", "Failed", "Expired", "Ready for another download"].includes(transfer.status)) {
          transfer.status = "Disconnected";
          this.scheduleNextPeerShareOffer(shareSession, "Recipient disconnected. Preparing the link for another download...");
        }
      };
      channel.onerror = () => {
        if (shareSession.offerToken !== offerToken) return;
        transfer.status = "Failed";
        this.error = "Peer data channel failed.";
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGatheringComplete(peer);

      const offered = await fetch(`/api/p2p/shares/${shareSession.shareId}/offer`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offer: peer.localDescription,
          metadata: shareSession.encryptedMetadata,
        }),
      });
      const payload = await offered.json().catch(() => ({}));
      if (!offered.ok) {
        throw new Error(payload.error || `Share signaling failed with ${offered.status}.`);
      }

      shareSession.generation = payload.generation || 0;
      transfer.status = "Waiting for recipient";
      transfer.progress = 0;
      transfer.bytesSent = 0;
      this.shareProgress = 0;
      this.shareStatus = `P2P link ready for multiple downloads until ${this.formatShareExpiry(shareSession.expiresAt)}. Keep this tab open; refreshing stops hosting.`;
      this.waitForPeerAnswer(shareSession, peer, shareSession.generation, offerToken);
    },

    scheduleNextPeerShareOffer(shareSession, status, delay = 0) {
      if (this.peerShareExpired(shareSession)) {
        shareSession.transfer.status = "Expired";
        this.shareStatus = "Encrypted link expired. Create a new share link.";
        return;
      }
      this.shareStatus = status;
      if (shareSession.reofferTimer) window.clearTimeout(shareSession.reofferTimer);
      shareSession.reofferTimer = window.setTimeout(() => {
        this.publishPeerShareOffer(shareSession).catch((error) => {
          shareSession.transfer.status = "Failed";
          this.error = error.message;
        });
      }, delay);
    },

    peerShareExpired(shareSession) {
      return Date.now() >= Number(shareSession.expiresAt || 0);
    },

    formatShareExpiry(expiresAt) {
      if (!expiresAt) return "the 12 hour limit";
      return new Date(expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    },

    async waitForPeerAnswer(shareSession, peer, generation, offerToken) {
      const { transfer } = shareSession;
      try {
        while (!this.peerShareExpired(shareSession) && shareSession.offerToken === offerToken) {
          const signal = await this.appJson(`/api/p2p/shares/${shareSession.shareId}`);
          if (signal.generation === generation && signal.answer) {
            await peer.setRemoteDescription(signal.answer);
            transfer.status = "Waiting for acknowledgement";
            return;
          }
          await sleep(1000);
        }
        if (shareSession.offerToken === offerToken) {
          transfer.status = "Expired";
          this.shareStatus = "Encrypted link expired. Create a new share link.";
        }
      } catch (error) {
        if (shareSession.offerToken !== offerToken) return;
        transfer.status = "Failed";
        this.error = error.message;
      }
    },

    async streamPeerShare(shareSession, channel, offerToken) {
      const { source, key, transfer, metadata } = shareSession;
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
        transfer.status = "Ready for another download";
        this.scheduleNextPeerShareOffer(shareSession, "Transfer complete. Preparing the same link for another download...");
      } catch (error) {
        if (shareSession.offerToken !== offerToken) return;
        if (isDataChannelClosedError(error)) {
          transfer.status = "Disconnected";
          this.scheduleNextPeerShareOffer(shareSession, "Peer disconnected before the transfer completed. Preparing the link for another download...");
        } else {
          transfer.status = "Failed";
          this.error = error.message;
        }
      }
    },

    async previewItem(item) {
      const resource = this.selectedResourceForItem(item);
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

    async launchFullTranscodedConnectorVideo(item, resource, mediaInfo, transcodeParts, options = {}) {
      const audioProfile = options.audioProfile === "spatial" ? "spatial" : "stereo";
      const transcodePath = this.connectorPathWithAudioProfile(`${resource.proxyPath}/transcoded`, audioProfile);
      const transcodeInfoPath = this.connectorPathWithAudioProfile(`${resource.proxyPath}/transcoded-info`, audioProfile);
      const transcodeLabel = audioProfile === "spatial" ? "spatial Stable MP4" : "Stable MP4";
      this.playerStatus = `Preparing complete ${transcodeLabel} cache with browser-safe ${transcodeParts.join(" and ")}...`;
      this.playerTranscodeAvailablePercent = 0;
      const poller = this.pollTranscodeProgress(resource, item.title, "player", audioProfile);
      let transcodeInfo;
      try {
        transcodeInfo = await this.request(transcodeInfoPath);
      } finally {
        poller.stop();
      }
      this.playerTranscodeAvailablePercent = 100;
      const transcodeSize = Number(transcodeInfo.size || 0);
      const transcodeDuration = Number(transcodeInfo.duration || mediaInfo?.duration || 0);
      this.teardownHostHlsPlayer();
      this.teardownHostProgressiveMsePlayer();
      const stableMp4Url = this.connectorDirectUrl(transcodePath);
      this.playerUrl = stableMp4Url;
      this.playerType = "video/mp4";
      this.playerTitle = item.title;
      this.playerTranscodeComplete = true;
      const source = {
        title: item.title,
        type: "video/mp4",
        size: transcodeSize,
        contentKey: `connector:${resource.proxyPath}`,
        sourceLabel: `${this.sourceLabel(this.selectedServer)} video transcoded to ${audioProfile === "spatial" ? "multichannel" : "stereo"} MP4/AAC`,
        mediaInfo,
        playbackProfile: stableMp4PlaybackProfile(mediaInfo, audioProfile),
        spatialAudioProfile: audioProfile,
        spatialAudioReady: audioProfile === "spatial",
        progressiveTranscode: false,
        progressiveTranscodePercent: this.playerTranscodeAvailablePercent,
        transcodedAvailableBytes: transcodeSize,
        estimatedFinalSize: transcodeSize,
        duration: transcodeDuration,
        mseType: stableMp4MseMimeType(mediaInfo),
        shareDisabledReason: "",
        checksumPath: this.connectorPathWithAudioProfile(`${resource.proxyPath}/transcoded/checksum`, audioProfile),
      };
      source.readRange = async (start, endExclusive) => {
        const requestedStart = Math.max(0, Number(start || 0));
        const requestedEndExclusive = Math.max(requestedStart, Number(endExclusive || 0));
        const expectedBytes = requestedEndExclusive - requestedStart;
        const response = await fetch(`${this.connectorUrl}${transcodePath}`, {
          headers: this.connectorHeaders({
            Range: `bytes=${requestedStart}-${Math.max(requestedStart, requestedEndExclusive - 1)}`,
          }),
        });
        if (response.status !== 206) {
          throw new Error(`Connector returned ${response.status} for transcoded range; expected 206 Partial Content.`);
        }
        const buffer = await response.arrayBuffer();
        if (expectedBytes && buffer.byteLength !== expectedBytes) {
          throw new Error(`Connector returned ${buffer.byteLength} bytes for a ${expectedBytes}-byte transcoded range.`);
        }
        return buffer;
      };
      source.openStream = async () => {
        const response = await fetch(`${this.connectorUrl}${transcodePath}`, {
          headers: this.connectorHeaders(),
        });
        if (!response.ok) throw new Error(`Connector returned ${response.status} for transcoded video.`);
        const totalBytes = Number(response.headers.get("Content-Length") || source.size || 0);
        return {
          totalBytes,
          stream: response.body,
          arrayBuffer: () => response.arrayBuffer(),
        };
      };
      this.playerSource = source;
      this.playerStatus = `Video ready with browser-safe ${transcodeParts.join(" and ")}${audioProfile === "spatial" ? " and spatial audio channels" : ""}.`;
      setTimeout(() => {
        this.prepareHostPlayerMedia();
      }, 0);
      this.showBootstrapTab("player-tab");
    },

    hlsWatchSourceFromConnector(item, resource, mediaInfo, transcodeParts, hlsInfo, options = {}) {
      const audioProfile = options.audioProfile === "spatial" ? "spatial" : "stereo";
      const videoProfile = normalizeTranscodeVideoProfile(options.videoProfile || hlsInfo?.videoProfile);
      const videoLayout = videoLayoutForTranscodeProfile(videoProfile);
      const generated3d = isStereoVideoProfile(videoProfile);
      const stereoProcessor = generated3d
        ? normalizeStereo3dProcessor(options.stereoProcessor || hlsInfo?.stereoProcessor)
        : "";
      const profileOptions = { audioProfile, videoProfile, stereoProcessor };
      const playlistPath = this.connectorPathWithProfiles(hlsInfo.playlistPath || `${resource.proxyPath}/hls/playlist.m3u8`, profileOptions);
      const segmentPath = (index) => this.connectorPathWithProfiles(`${resource.proxyPath}/hls/segments/${Number(index || 0)}.ts`, profileOptions);
      const sourceLabel = `${this.sourceLabel(this.selectedServer)} ${generated3d ? `${videoLayoutLabel(videoLayout)} generated 3D ` : ""}live segmented transcode`;
      return {
        title: item.title,
        type: "application/vnd.apple.mpegurl",
        size: Number(mediaInfo?.size || hlsInfo?.mediaInfo?.size || resource.size || 0),
        contentKey: `connector:${resource.proxyPath}`,
        variantContentKey: `connector:${resource.proxyPath}:hls:${audioProfile}:${videoProfile}:${stereoProcessor || "none"}`,
        sourceLabel,
        mediaInfo: hlsInfo.mediaInfo || mediaInfo,
        playbackProfile: {
          sourceKind: "hls-live",
          containerType: "application/vnd.apple.mpegurl",
          videoCodec: "h264",
          videoProfile,
          videoLayout,
          stereoscopic: generated3d,
          stereoProcessor,
          audioCodec: "aac",
          audioChannels: audioProfile === "spatial" ? Number(mediaInfo?.audioChannels || mediaInfo?.defaultAudio?.channels || 0) : Math.min(2, Number(mediaInfo?.audioChannels || 2)),
          audioChannelLayout: audioProfile === "spatial" ? (mediaInfo?.audioChannelLayout || "") : "stereo",
          audioChannelLabels: audioProfile === "spatial" ? (mediaInfo?.audioChannelLabels || []) : ["L", "R"],
          spatialAudioReady: audioProfile === "spatial",
          universal: false,
        },
        hlsLive: true,
        hlsInfo: {
          duration: Number(hlsInfo.duration || mediaInfo?.duration || 0),
          segmentDuration: Number(hlsInfo.segmentDuration || 8),
          segmentCount: Number(hlsInfo.segmentCount || 0),
        },
        readHlsSegment: async (segmentIndex) => {
          const response = await fetch(`${this.connectorUrl}${segmentPath(segmentIndex)}`, {
            headers: this.connectorHeaders(),
          });
          if (!response.ok) throw new Error(`Connector returned ${response.status} for HLS segment ${Number(segmentIndex) + 1}.`);
          return {
            bytes: await response.arrayBuffer(),
            contentType: response.headers.get("Content-Type") || "video/mp2t",
          };
        },
        playlistPath,
        playlistUrl: this.connectorDirectUrl(playlistPath),
        transcodeParts,
        videoProfile,
        videoLayout,
        stereoscopic: generated3d,
        stereoProcessor,
        spatialAudioProfile: audioProfile,
        spatialAudioReady: audioProfile === "spatial",
      };
    },

    async liveWatchSourceForCurrentPlayer(options = {}) {
      const requestedVideoProfile = normalizeTranscodeVideoProfile(options.videoProfile);
      const requestedStereoProcessor = isStereoVideoProfile(requestedVideoProfile)
        ? normalizeStereo3dProcessor(options.stereoProcessor || this.stereo3dProcessor)
        : "";
      if (
        this.playerSource?.readHlsSegment
        && normalizeTranscodeVideoProfile(this.playerSource.videoProfile || "2d") === requestedVideoProfile
        && normalizeStereo3dProcessor(this.playerSource.stereoProcessor || "") === normalizeStereo3dProcessor(requestedStereoProcessor)
      ) return this.playerSource;
      const launch = this.playerConnectorLaunch;
      if (!launch?.resource?.proxyPath || !launch?.item) {
        throw new Error("Live stream watch links are available for videos launched from the connector with ffmpeg support.");
      }
      if (launch.mediaInfo && launch.mediaInfo.ffmpegAvailable === false) {
        throw new Error("Live stream watch links require ffmpeg in the local connector.");
      }
      const audioProfile = this.playerSource?.spatialAudioProfile === "spatial" ? "spatial" : "stereo";
      const hlsInfo = await this.request(this.connectorPathWithProfiles(`${launch.resource.proxyPath}/hls-info`, {
        audioProfile,
        videoProfile: requestedVideoProfile,
        stereoProcessor: requestedStereoProcessor,
      }));
      const transcodeParts = launch.transcodeParts?.length ? launch.transcodeParts : ["video to H.264/AAC"];
      return this.hlsWatchSourceFromConnector(
        launch.item,
        launch.resource,
        hlsInfo.mediaInfo || launch.mediaInfo,
        transcodeParts,
        hlsInfo,
        { audioProfile, videoProfile: requestedVideoProfile, stereoProcessor: requestedStereoProcessor },
      );
    },

    localWebGpuHls3dSource(hlsSource, videoProfile) {
      if (!hlsSource?.readHlsSegment) return null;
      const targetVideoProfile = normalizeTranscodeVideoProfile(videoProfile);
      const targetVideoLayout = videoLayoutForTranscodeProfile(targetVideoProfile);
      const stereoProcessor = "webgpu-depth-anything-v2-small";
      return {
        ...hlsSource,
        sourceLabel: `${hlsSource.sourceLabel || "Live stream"} with local WebGPU 3D`,
        variantContentKey: `${hlsSource.variantContentKey || hlsSource.contentKey || "hls"}:local:${stereoProcessor}:${targetVideoProfile}`,
        videoProfile: "2d",
        videoLayout: "mono",
        stereoscopic: false,
        stereoProcessor,
        localStereoProcessor: true,
        targetVideoProfile,
        targetVideoLayout,
        playbackProfile: {
          ...(hlsSource.playbackProfile || {}),
          videoProfile: "2d",
          videoLayout: "mono",
          stereoscopic: false,
          stereoProcessor,
          localStereoProcessor: true,
          targetVideoProfile,
          targetVideoLayout,
        },
      };
    },

    canCreateLiveWatchRoom() {
      return Boolean(
        this.playerSource?.readHlsSegment
        || (this.playerConnectorLaunch?.resource?.proxyPath && this.playerConnectorLaunch?.mediaInfo?.ffmpegAvailable !== false),
      );
    },

    canPlayHostStereo3dStream() {
      const mediaInfo = this.playerSource?.mediaInfo || this.playerConnectorLaunch?.mediaInfo;
      return Boolean(this.canCreateLiveWatchRoom() && mediaInfoStereo3dCandidate(mediaInfo));
    },

    async setHostVideoMode(mode) {
      const nextMode = mode === "hls3d" ? "hls3d" : "normal";
      const changed = this.hostVideoMode !== nextMode;
      this.hostVideoMode = nextMode;
      localStorage.setItem("filePipeHostVideoMode", this.hostVideoMode);
      if (!changed || !this.playerSource || this.playerLoading) return;
      if (nextMode === "hls3d") {
        await this.launchHostStereo3dStream();
      } else {
        await this.restoreHostNormalStream();
      }
    },

    async launchHostStereo3dStream() {
      if (!this.canPlayHostStereo3dStream()) {
        this.hostVideoMode = "normal";
        localStorage.setItem("filePipeHostVideoMode", this.hostVideoMode);
        this.error = "3D host playback is available for connector videos that can create live HLS streams.";
        return;
      }
      const video = document.getElementById("host-video-player");
      const currentTime = Number(video?.currentTime || 0);
      const wasPaused = !video || video.paused;
      const playbackRate = Number(video?.playbackRate || 1);
      const videoProfile = videoProfileForStereo3dLayout(this.stereo3dLayout);
      const stereoProcessor = normalizeStereo3dProcessor(this.stereo3dProcessor);
      if (stereoProcessor === "webgpu-depth-anything-v2-small") {
        this.hostVideoMode = "normal";
        localStorage.setItem("filePipeHostVideoMode", this.hostVideoMode);
        this.error = "Host 3D Stream needs a connector-generated SBS stream. Choose ffmpeg, Depth Anything, or Core ML instead of WebGPU.";
        return;
      }
      this.playerLoading = true;
      this.error = "";
      try {
        const source = await this.liveWatchSourceForCurrentPlayer({ videoProfile, stereoProcessor });
        if (!source?.playlistUrl) throw new Error("Could not prepare the 3D stream for host playback.");
        this.teardownHostHlsPlayer();
        this.playerSource = {
          ...source,
          hls: true,
          shareDisabledReason: "Use Live stream watch link for participants. Bigscreen still requires Stable MP4 or a random-access video source.",
        };
        this.playerUrl = source.playlistUrl;
        this.playerType = "application/vnd.apple.mpegurl";
        this.playerStatus = `Host player switched to ${videoLayoutLabel(source.targetVideoLayout || source.videoLayout)} 3D stream.`;
        setTimeout(() => this.attachHostHlsPlayerAt(currentTime, wasPaused, playbackRate), 0);
        if (this.playerRoomId && this.playerRoomKey) {
          await this.refreshCurrentWatchRoom3dMetadata();
        }
      } catch (error) {
        this.error = error.message;
        this.hostVideoMode = "normal";
        localStorage.setItem("filePipeHostVideoMode", this.hostVideoMode);
      } finally {
        this.playerLoading = false;
      }
    },

    async restoreHostNormalStream() {
      const launch = this.playerConnectorLaunch;
      if (!launch?.item || !launch?.resource || !launch?.mediaInfo) return;
      const video = document.getElementById("host-video-player");
      const currentTime = Number(video?.currentTime || 0);
      const wasPaused = !video || video.paused;
      const playbackRate = Number(video?.playbackRate || 1);
      this.playerLoading = true;
      this.error = "";
      try {
        await this.launchSegmentedConnectorVideo(launch.item, launch.resource, launch.mediaInfo, launch.transcodeParts || ["video to H.264/AAC"]);
        setTimeout(() => this.restoreHostPlaybackPosition(currentTime, wasPaused, playbackRate), 120);
        if (this.playerRoomId && this.playerRoomKey) {
          await this.refreshCurrentWatchRoom3dMetadata();
        }
      } catch (error) {
        this.error = error.message;
      } finally {
        this.playerLoading = false;
      }
    },

    attachHostHlsPlayerAt(currentTime, wasPaused, playbackRate) {
      this.attachHostHlsPlayer();
      setTimeout(() => this.restoreHostPlaybackPosition(currentTime, wasPaused, playbackRate), 120);
    },

    restoreHostPlaybackPosition(currentTime, wasPaused, playbackRate) {
      const video = document.getElementById("host-video-player");
      if (!video) return;
      video.playbackRate = playbackRate || 1;
      const restore = () => {
        seekVideoTo(video, currentTime || 0);
        if (!wasPaused) playVideoWhenReady(video, 10000).catch(() => {});
      };
      if (video.readyState === HTMLMediaElement.HAVE_NOTHING) {
        video.addEventListener("loadedmetadata", restore, { once: true });
        video.load();
      } else {
        restore();
      }
    },

    async launchSegmentedConnectorVideo(item, resource, mediaInfo, transcodeParts, options = {}) {
      if (this.hostVideoMode === "hls3d" && !isStereoVideoProfile(options.videoProfile)) {
        this.hostVideoMode = "normal";
        localStorage.setItem("filePipeHostVideoMode", this.hostVideoMode);
      }
      const audioProfile = options.audioProfile === "spatial" ? "spatial" : "stereo";
      const hlsInfoPath = this.connectorPathWithAudioProfile(`${resource.proxyPath}/hls-info`, audioProfile);
      const hlsInfo = await this.request(hlsInfoPath);
      const hlsSource = this.hlsWatchSourceFromConnector(item, resource, mediaInfo, transcodeParts, hlsInfo, { audioProfile });
      const playlistUrl = hlsSource.playlistUrl;
      this.teardownHostHlsPlayer();
      this.playerUrl = playlistUrl;
      this.playerType = "application/vnd.apple.mpegurl";
      this.playerTitle = item.title;
      this.playerTranscodeComplete = false;
      this.playerSource = {
        ...hlsSource,
        hls: true,
        shareDisabledReason: "Use Live stream watch link for participants. Bigscreen still requires Stable MP4 or a random-access video source.",
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
        this.hostHls = new Hls(hlsBufferConfig());
        this.hostHls.on(Hls.Events.ERROR, (_event, data) => {
          if (this.recoverHostHlsAppendError(data)) return;
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

    recoverHostHlsAppendError(data) {
      if (!this.hostHls || !isRecoverableHlsAppendError(data)) return false;
      this.playerStatus = "Recovering segmented playback buffer...";
      try {
        this.hostHls.recoverMediaError();
        this.hostHls.startLoad();
        return true;
      } catch (error) {
        this.error = error.message;
        return false;
      }
    },

    async launchVideoItem(item) {
      const resource = this.selectedResourceForItem(item);
      if (!resource || !resource.proxyPath || !this.isVideoItem(item)) {
        this.error = "Choose a video file to launch in the player.";
        return;
      }

      const preserveWatchRoom = this.shouldPreserveWatchRoom();
      this.clearPlayer(preserveWatchRoom);
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
          await this.publishPinnedWatchRoomSourceChange("Host switched videos in this pinned room.");
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
          contentKey: `connector:${resource.proxyPath}`,
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
        this.playerConnectorLaunch = mediaInfo?.ffmpegAvailable
          ? { item, resource, mediaInfo, transcodeParts: fallbackTranscodeParts.length ? fallbackTranscodeParts : ["video to H.264/AAC"] }
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
        await this.publishPinnedWatchRoomSourceChange("Host switched videos in this pinned room.");
      } catch (error) {
        this.error = error.message;
        this.playerStatus = "";
      } finally {
        this.playerLoading = false;
      }
    },

    async launchLocalVideo() {
      if (!this.localFile || !this.localFileType.startsWith("video/")) {
        this.error = "Choose a local video file first.";
        return;
      }
      const preserveWatchRoom = this.shouldPreserveWatchRoom();
      this.clearPlayer(preserveWatchRoom);
      this.teardownHostHlsPlayer();
      this.playerUrl = URL.createObjectURL(this.localFile);
      this.playerType = this.localFile.type || "video/mp4";
      this.playerTitle = this.localFile.name;
      this.playerTranscodeComplete = false;
      this.playerSource = {
        title: this.localFile.name,
        type: this.playerType,
        size: this.localFile.size,
        contentKey: `local:${this.localFile.name}:${this.localFile.size}:${this.localFile.lastModified || 0}`,
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
      await this.publishPinnedWatchRoomSourceChange("Host switched videos in this pinned room.");
    },

    clearPlayer(preserveWatchRoom = false) {
      if (this.hostXrPlayer) {
        this.hostXrPlayer.dispose();
        this.hostXrPlayer = null;
      }
      if (this.hostProgressTracker) {
        this.hostProgressTracker.detach();
        this.hostProgressTracker = null;
      }
      this.teardownHostHlsPlayer();
      this.teardownHostProgressiveMsePlayer();
      if (this.playerUrl && this.playerUrl.startsWith("blob:")) URL.revokeObjectURL(this.playerUrl);
      if (!preserveWatchRoom) {
        this.resetWatchRoom();
      }
      if (this.bigscreenTransfer?.channel) this.bigscreenTransfer.channel.close();
      if (this.bigscreenTransfer?.peer) this.bigscreenTransfer.peer.close();
      this.playerUrl = "";
      this.playerType = "";
      this.playerTitle = "";
      this.playerSource = null;
      this.playerConnectorLaunch = null;
      if (!preserveWatchRoom) this.playerSourceVersion = 0;
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
      this.playerAudioOutputLink = "";
      this.playerAudioOutputStatus = "";
      this.playerRoomQrDataUrl = "";
      this.playerRoomId = "";
      this.playerRoomRestored = false;
      this.restoredWatchRoomContentKey = "";
      this.playerStatus = "";
      this.playerPeers = {};
      this.playerShareProgress = 0;
      this.playerMd5 = "";
      this.playerRoomKey = null;
      this.playerRoomKeyText = "";
      this.playerRoomMetadata = null;
      this.playerRoomSource = null;
      this.playerRoomRangeSource = null;
      this.playerRoomHlsSource = null;
      this.playerRoomHls3dSource = null;
      this.clearStoredWatchRoom();
      if (this.qrModalUrl) this.closeQrModal();
    },

    shouldPreserveWatchRoom() {
      return Boolean(this.connectorSettings?.pinnedWatchRoom && this.playerRoomId && this.playerRoomKey);
    },

    shouldResumeRestoredWatchRoom() {
      return Boolean(this.playerRoomRestored && this.playerRoomId && this.playerRoomKey && this.playerSource);
    },

    saveStoredWatchRoom() {
      try {
        if (!this.playerRoomId || !this.playerRoomKeyText || !this.playerRoomLink) return;
        localStorage.setItem(HOST_WATCH_ROOM_STORAGE_KEY, JSON.stringify({
          version: 1,
          savedAt: Date.now(),
          expiresAt: Date.now() + HOST_WATCH_ROOM_TTL_MS,
          roomId: this.playerRoomId,
          roomKeyText: this.playerRoomKeyText,
          roomLink: this.playerRoomLink,
          sourceVersion: this.playerSourceVersion,
          contentKey: this.playerRoomMetadata?.contentKey || this.playerSource?.contentKey || "",
          title: this.playerRoomMetadata?.name || this.playerTitle || "",
        }));
      } catch {
        // Host room recovery is best effort; sharing still works without storage.
      }
    },

    clearStoredWatchRoom() {
      try {
        localStorage.removeItem(HOST_WATCH_ROOM_STORAGE_KEY);
      } catch {
        // Ignore storage failures.
      }
    },

    async restoreStoredWatchRoom() {
      try {
        const raw = localStorage.getItem(HOST_WATCH_ROOM_STORAGE_KEY);
        if (!raw || !hasWebCrypto()) return;
        const stored = JSON.parse(raw);
        if (!stored || Number(stored.expiresAt || 0) <= Date.now()) {
          this.clearStoredWatchRoom();
          return;
        }
        this.playerRoomId = String(stored.roomId || "");
        this.playerRoomKeyText = String(stored.roomKeyText || "");
        this.playerRoomLink = stored.roomLink || (this.playerRoomId && this.playerRoomKeyText
          ? `${window.location.origin}/watch/${this.playerRoomId}#key=${this.playerRoomKeyText}`
          : "");
        this.playerAudioOutputLink = this.hostAudioOutputLink();
        if (!this.playerRoomId || !this.playerRoomKeyText || !this.playerRoomLink) {
          this.clearStoredWatchRoom();
          return;
        }
        this.playerRoomKey = await crypto.subtle.importKey(
          "raw",
          base64UrlDecode(this.playerRoomKeyText),
          { name: "AES-GCM" },
          true,
          ["encrypt", "decrypt"],
        );
        this.playerSourceVersion = Number(stored.sourceVersion || 0);
        this.restoredWatchRoomContentKey = String(stored.contentKey || "");
        this.playerRoomRestored = true;
        await this.renderPlayerRoomQr();
        this.playerStatus = "Previous watch room restored. Load the same video, then resume this room from Share player.";
      } catch {
        this.clearStoredWatchRoom();
        this.playerRoomId = "";
        this.playerRoomKeyText = "";
        this.playerRoomKey = null;
        this.playerRoomLink = "";
        this.playerRoomRestored = false;
      }
    },

    async publishPinnedWatchRoomSourceChange(reason = "Host switched videos in this pinned room.") {
      if (!this.shouldPreserveWatchRoom() || !this.playerSource) return false;
      this.playerStatus = "Updating pinned watch room...";
      await this.publishCurrentWatchRoomMetadata(reason, this.playerSource);
      for (const peer of this.connectedWatchPeers()) {
        peer.videoComplete = false;
        peer.readySyncId = "";
        peer.viewerHasPlayer = false;
        peer.cancelledRanges?.clear();
        if (peer.channel?.readyState === "open") {
          sendChannelJson(peer.channel, {
            type: "source-update",
            reason,
            requiresAcknowledgement: true,
            metadata: this.playerRoomMetadata,
          });
        }
      }
      this.playerStatus = "Pinned watch room updated. Viewers will confirm the new video before playback.";
      return true;
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
      this.updateHostLinearPlaybackTime();
      this.attachHostPlaybackProgress(video);
      this.attachHostXrPlayer(video);
      this.setHostAudioOutput();
      this.inspectHostPlayerAudio();
    },

    hostPlaybackMd5() {
      return this.playerMd5 || this.playerRoomMetadata?.md5 || this.playerSource?.md5 || "";
    },

    attachHostPlaybackProgress(video) {
      if (!window.FilePipePlaybackProgress || !video) return;
      const trackerMd5 = this.hostPlaybackMd5();
      if (this.hostProgressTracker) {
        this.hostProgressTracker.refresh(trackerMd5);
        return;
      }
      this.hostProgressTracker = window.FilePipePlaybackProgress.attach(video, {
        md5: () => this.hostPlaybackMd5(),
        name: () => this.playerTitle || this.playerRoomMetadata?.name || "",
      });
    },

    hostProgressivePlaybackLocked() {
      return Boolean(this.playerSource?.progressiveTranscode) && !this.playerTranscodeComplete;
    },

    hostProgressivePlaybackLabel() {
      const percent = Math.max(0, Math.min(99, Math.round(Number(this.playerTranscodeAvailablePercent || 0))));
      if (percent > 0) return `Linear playback while Stable MP4 is ${percent}% ready. Scrubbing unlocks at 100%.`;
      return "Linear playback is available while Stable MP4 prepares. Scrubbing unlocks at 100%.";
    },

    toggleHostLinearPlayback() {
      const video = document.getElementById("host-video-player");
      if (!video) return;
      if (video.paused) {
        this.playerStatus = "Starting linear playback as Stable MP4 bytes arrive...";
        playVideoWhenReady(video, 20000, { load: !this.hostProgressiveMse }).catch(() => {
          this.playerStatus = "Playback is still preparing. Try again once the first bytes are buffered.";
        });
      } else {
        video.pause();
      }
    },

    updateHostLinearPlaybackTime() {
      const video = document.getElementById("host-video-player");
      if (!video || video.seeking) return;
      this.hostLinearPlaybackTime = video.currentTime || 0;
    },

    attachHostXrPlayer(video) {
      if (!window.FilePipeXrPlayer || !video) return;
      const profile = this.playerSource?.playbackProfile || this.playerRoomMetadata?.playbackProfile || {};
      this.hostXrPlayer = window.FilePipeXrPlayer.attach(video, {
        panelSelector: ".xr-side-panel",
        storageKey: "filePipeHostXrPlayer",
        mediaInfo: () => this.playerSource?.mediaInfo || this.playerRoomMetadata?.mediaInfo || null,
        playbackProfile: profile,
        onSpatialAudioPreference: () => this.ensureHostSpatialAudioSource(),
        sourceLayout: xrSourceLayoutFromProfile(profile),
        localDepthProcessor: profile.localStereoProcessor ? profile.stereoProcessor : "",
        localDepthTargetLayout: profile.targetVideoLayout || "",
      });
    },

    openHostXrTheater() {
      const video = document.getElementById("host-video-player");
      if (!video || !this.playerUrl) {
        this.error = "Load a video before opening XR Theater.";
        return;
      }
      this.attachHostXrPlayer(video);
      if (!this.hostXrPlayer?.openTheater) {
        this.error = "XR Theater is unavailable in this browser.";
        return;
      }
      this.hostXrPlayer.openTheater();
    },

    async toggleHostSpatialAudio(enabled) {
      const nextEnabled = Boolean(enabled);
      const video = document.getElementById("host-video-player");
      if (video) this.attachHostXrPlayer(video);
      if (!this.hostXrPlayer?.setSpatialAudioEnabled) {
        if (nextEnabled) await this.ensureHostSpatialAudioSource();
        return;
      }
      await this.hostXrPlayer.setSpatialAudioEnabled(nextEnabled);
    },

    async ensureHostSpatialAudioSource() {
      const source = this.playerSource;
      const launch = this.playerConnectorLaunch;
      const mediaInfo = source?.mediaInfo || launch?.mediaInfo;
      if (!mediaInfo || !mediaInfoSpatialAudioCandidate(mediaInfo)) return;
      const profile = source?.playbackProfile || {};
      if (
        source?.spatialAudioReady
        || source?.spatialAudioProfile === "spatial"
        || profile.spatialAudioReady
        || (profile.sourceKind === "original" && mediaInfoSpatialAudioReady(mediaInfo))
      ) return;
      if (!launch?.resource?.proxyPath || !launch?.item || mediaInfo.ffmpegAvailable === false) {
        this.playerStatus = "Spatial audio needs a multichannel source or a connector spatial transcode.";
        return;
      }

      const video = document.getElementById("host-video-player");
      const restoreTime = Number(video?.currentTime || 0);
      const wasPaused = !video || video.paused;
      const playbackRate = Number(video?.playbackRate || 1);
      const transcodeParts = launch.transcodeParts?.length ? launch.transcodeParts : ["audio to AAC"];
      this.playerLoading = true;
      try {
        await this.launchFullTranscodedConnectorVideo(
          launch.item,
          launch.resource,
          mediaInfo,
          transcodeParts,
          { audioProfile: "spatial" },
        );
        await this.publishPinnedWatchRoomSourceChange("Host switched this pinned room to a spatial audio source.");
        const nextVideo = document.getElementById("host-video-player");
        if (nextVideo) {
          nextVideo.playbackRate = playbackRate;
          const restorePlayback = () => {
            seekVideoTo(nextVideo, restoreTime);
            if (!wasPaused) playVideoWhenReady(nextVideo, 10000).catch(() => {});
          };
          if (nextVideo.readyState === HTMLMediaElement.HAVE_NOTHING) {
            nextVideo.addEventListener("loadedmetadata", restorePlayback, { once: true });
            nextVideo.load();
          } else {
            restorePlayback();
          }
        }
      } finally {
        this.playerLoading = false;
      }
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
        if (this.playerTranscodeComplete || !this.playerSource?.progressiveTranscode) {
          this.playerAudioStatus = "";
          return;
        }
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
        const channels = Number(mediaInfo.audioChannels || mediaInfo.defaultAudio?.channels || 0);
        const layout = mediaInfo.audioChannelLayout || (channels > 0 ? `${channels}ch` : "");
        this.playerAudioStatus = `Default audio uses ${codec}${layout ? ` ${layout}` : ""}, which should be browser-playable.`;
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

    async getPlayerSourceChecksum(label, onProgress = null, source = this.playerSource) {
      if (source?.progressiveTranscode) {
        if (onProgress) onProgress(Math.max(1, Number(this.playerTranscodeAvailablePercent || 0)));
        return {
          md5: "",
          totalBytes: Number(source.estimatedFinalSize || source.size || 0),
          originalBytes: Number(source.estimatedFinalSize || source.size || 0),
          provisional: true,
          source: "progressive-transcode",
        };
      }
      if (source?.checksumPath) {
        try {
          const checksum = await this.request(source.checksumPath);
          if (checksum?.md5) {
            if (onProgress) onProgress(100);
            return {
              md5: checksum.md5,
              totalBytes: Number(checksum.size || source.size || 0),
              source: "connector",
            };
          }
        } catch (error) {
          this.playerStatus = `Connector checksum failed; hashing in browser for ${label}...`;
          this.bigscreenStatus = `Connector checksum failed; hashing in browser for ${label}...`;
        }
      }

      const hashSource = await source.openStream();
      return computeSourceMd5(hashSource, source.size, (bytesRead, totalBytes) => {
        if (onProgress) onProgress(totalBytes ? Math.round((bytesRead / totalBytes) * 100) : 0);
      });
    },

    async publishCurrentWatchRoomMetadata(label = "viewer acknowledgement", source = this.playerSource, options = {}) {
      if (!this.playerRoomId || !this.playerRoomKey || !source) {
        throw new Error("Create a watch room before publishing source metadata.");
      }
      this.playerRoom3dStatus = "";
      this.playerRoom3dError = "";
      const isHlsLive = Boolean(source.hlsLive && source.readHlsSegment);
      const rangeSource = source.readRange ? source : (this.playerSource?.readRange ? this.playerSource : null);
      let hlsSource = isHlsLive ? source : null;
      if (!hlsSource && this.canCreateLiveWatchRoom()) {
        try {
          hlsSource = await this.liveWatchSourceForCurrentPlayer();
        } catch (error) {
          hlsSource = null;
        }
      }
      let hls3dSource = null;
      const stereo3dVideoProfile = videoProfileForStereo3dLayout(this.stereo3dLayout);
      const stereo3dProcessor = normalizeStereo3dProcessor(this.stereo3dProcessor);
      if (isStereoVideoProfile(hlsSource?.videoProfile)) {
        hls3dSource = hlsSource;
        this.playerRoom3dStatus = `${videoLayoutLabel(hls3dSource.videoLayout || this.stereo3dLayout)} 3D stream is active for this room.`;
      } else if (hlsSource && mediaInfoStereo3dCandidate(hlsSource.mediaInfo || source.mediaInfo) && this.canCreateLiveWatchRoom()) {
        if (stereo3dProcessor === "webgpu-depth-anything-v2-small") {
          hls3dSource = this.localWebGpuHls3dSource(hlsSource, stereo3dVideoProfile);
          this.playerRoom3dStatus = `${videoLayoutLabel(this.stereo3dLayout)} 3D stream will be generated locally with WebGPU on supported viewers.`;
        } else {
          try {
            hls3dSource = await this.liveWatchSourceForCurrentPlayer({
              videoProfile: stereo3dVideoProfile,
              stereoProcessor: stereo3dProcessor,
            });
            this.playerRoom3dStatus = `${videoLayoutLabel(hls3dSource.videoLayout || this.stereo3dLayout)} 3D stream is available via ${this.stereo3dProcessorLabel()}.`;
          } catch (error) {
            hls3dSource = null;
            this.playerRoom3dError = `3D stream is not available: ${error.message}`;
          }
        }
      } else if (hlsSource && this.canCreateLiveWatchRoom()) {
        this.playerRoom3dError = "3D stream is not available for this source because the connector did not detect a video track.";
      }
      this.playerRoomRangeSource = rangeSource;
      this.playerRoomHlsSource = hlsSource;
      this.playerRoomHls3dSource = hls3dSource;
      const hashResult = isHlsLive
        ? {
            md5: "",
            totalBytes: Number(source.size || 0),
            originalBytes: Number(source.size || 0),
            source: "hls-live",
          }
        : await this.getPlayerSourceChecksum(label, (progress) => {
            this.playerShareProgress = progress;
          }, source);
      if (options.preserveSourceVersion) {
        this.playerSourceVersion = Math.max(1, Number(this.playerSourceVersion || 1));
      } else {
        this.playerSourceVersion += 1;
      }
      this.playerRoomSource = source;
      const rangeProgressive = rangeSource?.progressiveTranscode ? {
        percent: Number(this.playerTranscodeAvailablePercent || 0),
        availableBytes: Number(rangeSource.transcodedAvailableBytes || rangeSource.size || 0),
        estimatedFinalSize: Number(rangeSource.estimatedFinalSize || rangeSource.size || 0),
        duration: Number(rangeSource.duration || rangeSource.mediaInfo?.duration || 0),
        complete: false,
      } : null;
      this.playerRoomMetadata = {
        name: source.title,
        type: source.type || "video/mp4",
        size: hashResult.totalBytes,
        md5: hashResult.md5,
        originalMd5: hashResult.provisional ? hashResult.md5 : "",
        originalSize: hashResult.originalBytes || 0,
        contentKey: source.contentKey || `${source.title}|${source.sourceLabel}`,
        checksumKind: isHlsLive ? "hls-segments" : (hashResult.provisional ? "original-source" : "stream"),
        provisional: Boolean(hashResult.provisional),
        source: source.sourceLabel,
        hostName: this.connectorSettings?.hostName || "",
        mode: isHlsLive ? "Encrypted WebRTC live stream" : "Encrypted WebRTC watch room",
        sharedAt: new Date().toISOString(),
        playbackProfile: source.playbackProfile || null,
        mediaInfo: mediaInfoSummary(source.mediaInfo),
        hostCapabilities: this.hostMediaCapabilities,
        sourceVersion: this.playerSourceVersion,
        streamMode: isHlsLive ? "hls" : "range",
        hls: isHlsLive ? {
          duration: Number(source.hlsInfo?.duration || source.mediaInfo?.duration || 0),
          segmentDuration: Number(source.hlsInfo?.segmentDuration || 8),
          segmentCount: Number(source.hlsInfo?.segmentCount || 0),
        } : null,
        progressiveTranscode: rangeProgressive,
        availableModes: {
          range: rangeSource ? {
            label: "Watch",
            streamMode: "range",
            type: rangeSource.type || "video/mp4",
            size: Number(rangeSource.estimatedFinalSize || rangeSource.size || hashResult.totalBytes || 0),
            playbackProfile: rangeSource.playbackProfile || null,
            mediaInfo: mediaInfoSummary(rangeSource.mediaInfo),
            progressiveTranscode: rangeProgressive,
          } : null,
          hls: hlsSource ? {
            label: "Stream",
            streamMode: "hls",
            type: "application/vnd.apple.mpegurl",
            size: Number(hlsSource.size || 0),
            contentKey: hlsSource.variantContentKey || hlsSource.contentKey || source.contentKey || "",
            videoProfile: hlsSource.videoProfile || "2d",
            videoLayout: hlsSource.videoLayout || "mono",
            stereoProcessor: hlsSource.stereoProcessor || "",
            localStereoProcessor: Boolean(hlsSource.localStereoProcessor),
            targetVideoProfile: hlsSource.targetVideoProfile || "",
            targetVideoLayout: hlsSource.targetVideoLayout || "",
            playbackProfile: hlsSource.playbackProfile || null,
            mediaInfo: mediaInfoSummary(hlsSource.mediaInfo),
            hls: {
              duration: Number(hlsSource.hlsInfo?.duration || hlsSource.mediaInfo?.duration || 0),
              segmentDuration: Number(hlsSource.hlsInfo?.segmentDuration || 8),
              segmentCount: Number(hlsSource.hlsInfo?.segmentCount || 0),
            },
          } : null,
          hls3d: hls3dSource ? {
            label: "3D Stream",
            streamMode: "hls",
            type: "application/vnd.apple.mpegurl",
            size: Number(hls3dSource.size || 0),
            contentKey: hls3dSource.variantContentKey || hls3dSource.contentKey || source.contentKey || "",
            videoProfile: hls3dSource.videoProfile || "3d-sbs",
            videoLayout: hls3dSource.videoLayout || "half-sbs",
            stereoProcessor: hls3dSource.stereoProcessor || "",
            localStereoProcessor: Boolean(hls3dSource.localStereoProcessor),
            targetVideoProfile: hls3dSource.targetVideoProfile || "",
            targetVideoLayout: hls3dSource.targetVideoLayout || "",
            playbackProfile: hls3dSource.playbackProfile || null,
            mediaInfo: mediaInfoSummary(hls3dSource.mediaInfo),
            hls: {
              duration: Number(hls3dSource.hlsInfo?.duration || hls3dSource.mediaInfo?.duration || 0),
              segmentDuration: Number(hls3dSource.hlsInfo?.segmentDuration || 8),
              segmentCount: Number(hls3dSource.hlsInfo?.segmentCount || 0),
            },
          } : null,
        },
      };
      const metadataIv = crypto.getRandomValues(new Uint8Array(12));
      const encryptedMetadata = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: metadataIv },
        this.playerRoomKey,
        new TextEncoder().encode(JSON.stringify(this.playerRoomMetadata)),
      );
      const metadataPayload = {
        metadata: {
          iv: base64UrlEncode(metadataIv),
          ciphertext: base64UrlEncode(new Uint8Array(encryptedMetadata)),
        },
      };
      let response = await this.putWatchRoomMetadata(metadataPayload);
      if (response.status === 404) {
        await this.recreateWatchRoomForPublish();
        response = await this.putWatchRoomMetadata(metadataPayload);
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Could not publish room metadata: ${response.status}`);
      }
      this.playerMd5 = this.playerRoomMetadata.md5;
      this.attachHostPlaybackProgress(document.getElementById("host-video-player"));
      this.saveStoredWatchRoom();
      return this.playerRoomMetadata;
    },

    async putWatchRoomMetadata(metadataPayload) {
      return fetch(`/api/watch/rooms/${this.playerRoomId}/metadata`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(metadataPayload),
      });
    },

    async recreateWatchRoomForPublish() {
      const created = await this.appJson("/api/watch/rooms", { method: "POST" });
      if (!created.roomId) throw new Error("Could not recreate watch room after the previous room expired.");
      this.playerRoomId = created.roomId;
      this.playerRoomLink = `${window.location.origin}/watch/${created.roomId}#key=${this.playerRoomKeyText}`;
      this.playerRoomRestored = false;
      this.restoredWatchRoomContentKey = "";
      this.playerPeers = {};
      await this.renderPlayerRoomQr();
      this.saveStoredWatchRoom();
      this.playerStatus = "Previous watch room expired. A fresh watch link was created.";
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
      if (this.shouldResumeRestoredWatchRoom()) {
        this.playerRoomCreating = true;
        try {
          if (this.restoredWatchRoomContentKey && this.playerSource.contentKey && this.playerSource.contentKey !== this.restoredWatchRoomContentKey) {
            throw new Error("This restored watch room was created for a different video. Create a new watch link for the current source.");
          }
          this.playerStatus = "Resuming restored watch room...";
          await this.publishCurrentWatchRoomMetadata("Host resumed this watch room.", this.playerSource, { preserveSourceVersion: true });
          this.playerRoomRestored = false;
          this.restoredWatchRoomContentKey = "";
          this.playerStatus = "Watch room resumed. Viewers will reconnect and continue.";
          if (!this.playerPollActive) this.pollWatchRoomParticipants();
        } catch (error) {
          this.error = error.message;
        } finally {
          this.playerRoomCreating = false;
        }
        return;
      }
      if (this.shouldPreserveWatchRoom()) {
        this.playerRoomCreating = true;
        try {
          await this.publishPinnedWatchRoomSourceChange("Host updated this pinned watch room.");
          if (!this.playerPollActive) this.pollWatchRoomParticipants();
        } catch (error) {
          this.error = error.message;
        } finally {
          this.playerRoomCreating = false;
        }
        return;
      }
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

        const created = await this.appJson("/api/watch/rooms", { method: "POST" });
        if (!created.roomId) throw new Error("Could not create watch room.");

        this.playerRoomId = created.roomId;
        this.playerRoomLink = `${window.location.origin}/watch/${created.roomId}#key=${this.playerRoomKeyText}`;
        this.playerRoomRestored = false;
        this.saveStoredWatchRoom();
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

    async createLiveWatchRoom() {
      if (!this.playerSource) {
        this.error = "Load a video in the player first.";
        return;
      }
      if (this.playerRoomCreating) return;
      if (!hasWebCrypto()) {
        this.error = webCryptoRequiredMessage("Encrypted live watch rooms");
        return;
      }

      this.error = "";
      this.playerRoomCreating = true;
      this.playerStatus = "Preparing live stream watch link...";
      try {
        const liveSource = await this.liveWatchSourceForCurrentPlayer();
        if (this.shouldResumeRestoredWatchRoom()) {
          if (this.restoredWatchRoomContentKey && liveSource.contentKey && liveSource.contentKey !== this.restoredWatchRoomContentKey) {
            throw new Error("This restored watch room was created for a different video. Create a new watch link for the current source.");
          }
          this.playerStatus = "Resuming restored live watch room...";
          await this.publishCurrentWatchRoomMetadata("Host resumed this live watch room.", liveSource, { preserveSourceVersion: true });
          this.playerRoomRestored = false;
          this.restoredWatchRoomContentKey = "";
          this.playerStatus = "Live watch room resumed. Viewers will reconnect and continue.";
          if (!this.playerPollActive) this.pollWatchRoomParticipants();
          return;
        }
        if (this.shouldPreserveWatchRoom()) {
          await this.publishCurrentWatchRoomMetadata("Host updated this pinned stream room.", liveSource);
          for (const peer of this.connectedWatchPeers()) {
            peer.videoComplete = false;
            peer.readySyncId = "";
            peer.viewerHasPlayer = false;
            peer.cancelledRanges?.clear();
            if (peer.channel?.readyState === "open") {
              sendChannelJson(peer.channel, {
                type: "source-update",
                reason: "Host updated this pinned stream room.",
                requiresAcknowledgement: true,
                metadata: this.playerRoomMetadata,
              });
            }
          }
          this.playerStatus = "Pinned stream room updated. Viewers will confirm the new video before playback.";
          if (!this.playerPollActive) this.pollWatchRoomParticipants();
          return;
        }
        if (this.playerRoomId || Object.keys(this.playerPeers).length > 0) {
          this.resetWatchRoom();
        }
        this.playerRoomKey = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"],
        );
        const rawKey = await crypto.subtle.exportKey("raw", this.playerRoomKey);
        this.playerRoomKeyText = base64UrlEncode(new Uint8Array(rawKey));

        const created = await this.appJson("/api/watch/rooms", { method: "POST" });
        if (!created.roomId) throw new Error("Could not create live watch room.");

        this.playerRoomId = created.roomId;
        this.playerRoomLink = `${window.location.origin}/watch/${created.roomId}#key=${this.playerRoomKeyText}`;
        this.playerRoomRestored = false;
        this.saveStoredWatchRoom();
        await this.renderPlayerRoomQr();
        this.playerShareProgress = 100;
        this.playerStatus = "Live stream link ready. Publishing segment metadata...";
        await this.publishCurrentWatchRoomMetadata("live stream metadata", liveSource);
        this.playerStatus = "Live stream watch room ready. Keep this tab open while viewers watch.";
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

    hostAudioOutputLink(channel = "LFE") {
      if (!this.playerRoomId || !this.playerRoomKeyText) return "";
      const params = new URLSearchParams({
        key: this.playerRoomKeyText,
        target: "host",
        channel,
        targetName: this.connectorSettings?.hostName || "Host",
      });
      return `${window.location.origin}/watch-audio/${this.playerRoomId}#${params.toString()}`;
    },

    async createHostAudioOutputLink(channel = "LFE") {
      this.error = "";
      this.playerAudioOutputStatus = "";
      try {
        await this.ensureActiveWatchRoomForAudioOutput();
        if (!this.playerRoomId || !this.playerRoomKeyText) return;
        const audioOutputWarning = await this.ensureWatchRoomSpatialAudioSourceForOutput();
        this.playerAudioOutputLink = this.hostAudioOutputLink(channel);
        this.playerAudioOutputStatus = audioOutputWarning || `${channel} audio output link ready. Open it on the browser connected to the audio device.`;
        if (!this.playerPollActive) this.pollWatchRoomParticipants();
      } catch (error) {
        this.error = error.message;
        this.playerAudioOutputStatus = "";
      }
    },

    async ensureActiveWatchRoomForAudioOutput() {
      if (!this.playerRoomId || !this.playerRoomKeyText) {
        await this.createWatchRoom();
        return;
      }
      let room = null;
      try {
        room = await this.appJson(`/api/watch/rooms/${this.playerRoomId}`);
      } catch (error) {
        if (error.status !== 404) throw error;
        if (!this.playerSource || !this.playerRoomKey) {
          await this.createWatchRoom();
          return;
        }
        await this.publishCurrentWatchRoomMetadata(
          "Host refreshed this watch room for external audio output.",
          this.playerSource,
          { preserveSourceVersion: true },
        );
        this.notifyWatchRoomSourceUpdate("Host refreshed this watch room for external audio output.", false);
        return;
      }
      if (!room?.metadata && this.playerSource && this.playerRoomKey) {
        await this.publishCurrentWatchRoomMetadata(
          "Host published room metadata for external audio output.",
          this.playerSource,
          { preserveSourceVersion: true },
        );
      }
    },

    async ensureWatchRoomSpatialAudioSourceForOutput() {
      const mediaInfo = this.playerSource?.mediaInfo || this.playerRoomMetadata?.mediaInfo;
      if (!mediaInfoSpatialAudioCandidate(mediaInfo)) {
        return "The LFE output link is ready, but the current source does not report multichannel audio.";
      }
      const sourceReady = this.playerSource?.spatialAudioReady
        || this.playerSource?.spatialAudioProfile === "spatial"
        || this.playerSource?.playbackProfile?.spatialAudioReady;
      const roomReady = this.playerRoomMetadata?.playbackProfile?.spatialAudioReady
        || this.playerRoomMetadata?.availableModes?.range?.playbackProfile?.spatialAudioReady
        || this.playerRoomMetadata?.availableModes?.hls?.playbackProfile?.spatialAudioReady;
      if (sourceReady && roomReady) return "";

      const beforeSource = this.playerSource;
      await this.ensureHostSpatialAudioSource();
      const nextReady = this.playerSource?.spatialAudioReady
        || this.playerSource?.spatialAudioProfile === "spatial"
        || this.playerSource?.playbackProfile?.spatialAudioReady;
      if (!nextReady) {
        return "The LFE output link is ready, but this room is not using a spatial audio source yet.";
      }
      if (this.playerRoomId && this.playerRoomKey && (this.playerSource !== beforeSource || !roomReady)) {
        const reason = "Host prepared a multichannel source for external audio output.";
        await this.publishCurrentWatchRoomMetadata(reason, this.playerSource, { preserveSourceVersion: false });
        this.notifyWatchRoomSourceUpdate(reason, false);
      }
      return "";
    },

    notifyWatchRoomSourceUpdate(reason, requiresAcknowledgement = true) {
      for (const peer of this.connectedWatchPeers()) {
        peer.videoComplete = false;
        peer.readySyncId = "";
        peer.viewerHasPlayer = false;
        peer.cancelledRanges?.clear();
        if (peer.channel?.readyState === "open") {
          sendChannelJson(peer.channel, {
            type: "source-update",
            reason,
            requiresAcknowledgement,
            metadata: this.playerRoomMetadata,
          });
        }
      }
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
        const created = await this.appJson("/api/bigscreen/sessions", { method: "POST" });
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
            estimatedFinalSize: Number(this.playerSource.estimatedFinalSize || this.playerSource.size || 0),
            duration: Number(this.playerSource.duration || this.playerSource.mediaInfo?.duration || 0),
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
          source: this.playerSource,
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
          const signal = await this.appJson(`/api/bigscreen/sessions/${sessionId}`);
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
      const source = transfer.source || this.playerSource;
      if (!source?.readRange) {
        sendChannelJson(channel, {
          type: "range-error",
          requestId: message.requestId,
          error: "The Bigscreen source is no longer available. Create a new Bigscreen link.",
        });
        return;
      }
      const totalSize = Number((!source.progressiveTranscode && source.size) || transfer.metadata.size || source.size || 0);
      const start = Math.max(0, Number(message.start || 0));
      const end = Math.min(totalSize - 1, Number(message.end ?? totalSize - 1));
      const requestId = message.requestId;
      const prefetch = Boolean(message.prefetch);
      const chunkSize = RANGE_STREAM_CHUNK_SIZE;
      try {
        transfer.cancelledRanges.delete(requestId);
        for (let offset = start; offset <= end; offset += chunkSize) {
          if (transfer.cancelledRanges.has(requestId)) break;
          const nextEnd = Math.min(offset + chunkSize - 1, end);
          const plainChunk = await source.readRange(offset, nextEnd + 1);
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
            prefetch,
          }, ciphertext)) throw dataChannelDisconnectedError();
          if (!(await waitForDataChannelBuffer(channel))) throw dataChannelDisconnectedError();
          if (shouldUpdateChannelUi(transfer)) {
            this.bigscreenProgress = totalSize ? Math.round((nextEnd / totalSize) * 100) : 0;
            this.bigscreenStatus = `Streaming Bigscreen range ${formatRange(start, end)}.`;
          }
        }
        if (!transfer.cancelledRanges.has(requestId)) {
          if (!sendChannelJson(channel, { type: "range-done", requestId, prefetch })) throw dataChannelDisconnectedError();
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
            prefetch,
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
        estimatedFinalSize: Number(this.playerSource?.estimatedFinalSize || this.playerRoomMetadata?.size || 0),
        duration: Number(this.playerSource?.duration || this.playerRoomMetadata?.mediaInfo?.duration || 0),
        complete: normalizedPercent >= 100,
      };
      if (this.playerRoomMetadata.availableModes?.range) {
        this.playerRoomMetadata.availableModes.range.progressiveTranscode = this.playerRoomMetadata.progressiveTranscode;
        if (this.playerRoomMetadata.progressiveTranscode.estimatedFinalSize) {
          this.playerRoomMetadata.availableModes.range.size = this.playerRoomMetadata.progressiveTranscode.estimatedFinalSize;
        }
      }
      for (const record of this.connectedWatchPeers()) {
        sendChannelJson(record.channel, {
          type: "transcode-progress",
          percent: normalizedPercent,
          availableBytes: normalizedBytes,
          estimatedFinalSize: Number(this.playerSource?.estimatedFinalSize || this.playerRoomMetadata?.size || 0),
          duration: Number(this.playerSource?.duration || this.playerRoomMetadata?.mediaInfo?.duration || 0),
          complete: normalizedPercent >= 100,
        });
      }
    },

    async finalizeProgressiveWatchRoomMetadata() {
      if (!this.playerRoomId || !this.playerRoomKey || !this.playerSource || !this.playerRoomMetadata?.progressiveTranscode) return;
      try {
        this.playerStatus = "Stable MP4 is ready. Publishing final watch metadata...";
        await this.publishCurrentWatchRoomMetadata("Stable MP4 final metadata");
        for (const peer of this.connectedWatchPeers()) {
          peer.videoComplete = false;
          peer.readySyncId = "";
          peer.viewerHasPlayer = false;
          peer.cancelledRanges?.clear();
          sendChannelJson(peer.channel, {
            type: "source-update",
            reason: "Stable MP4 is ready. Restarting viewer playback.",
            metadata: this.playerRoomMetadata,
          });
        }
        this.playerStatus = "Stable MP4 watch stream is ready.";
      } catch (error) {
        this.error = error.message;
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
            const state = await this.appJson(`/api/watch/rooms/${roomId}`);
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
                  role: participant.role || "participant",
                  audioOutput: participant.audioOutput || null,
                  status: "Connecting",
                  sentBytes: 0,
                  generation: participant.generation,
                  cancelledRanges: new Set(),
                  readySyncId: "",
                  viewerHasPlayer: Boolean(existing?.viewerHasPlayer),
                  viewerMode: existing?.viewerMode || "",
                  allowControl: Boolean(existing?.allowControl),
                  localVoiceMuted: Boolean(existing?.localVoiceMuted),
                  remoteMicMuted: Boolean(existing?.remoteMicMuted),
                  voiceAvailable: Boolean(existing?.voiceAvailable),
                  micMuted: Boolean(existing?.micMuted),
                  mediaCapabilities: existing?.mediaCapabilities || null,
                  latestPlaybackState: existing?.latestPlaybackState || null,
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
          this.startPeerClockSync(record);
        };
        channel.onmessage = async (event) => {
          const message = JSON.parse(event.data);
          if (message.type === "clock-pong") {
            this.handlePeerClockPong(record, message);
            return;
          }
          if (message.type === "voice-state") {
            this.updateParticipantVoiceState(record, message);
            return;
          }
          if (message.type === "media-capabilities") {
            record.mediaCapabilities = message.capabilities || null;
            this.ensureWatchRoomCompatibleWithPeer(record);
            return;
          }
          if (message.type === "peer-playback-state") {
            this.updatePeerPlaybackState(record, message);
            return;
          }
          if (message.type === "range-request") {
            record.viewerHasPlayer = true;
            record.viewerMode = "range";
            if (!this.playerRoomRangeSource && this.playerRoomMetadata?.streamMode === "hls") {
              sendChannelJson(record.channel, {
                type: "range-error",
                requestId: message.requestId,
                sourceVersion: Number(this.playerRoomMetadata?.sourceVersion || 0),
                error: "This watch room is using stream mode and does not have a range source.",
              });
              return;
            }
            record.status = "Range streaming";
            await this.streamWatchRange(message, record);
            return;
          }
          if (message.type === "hls-segment-request") {
            record.viewerHasPlayer = true;
            record.viewerMode = "hls";
            record.status = "Live segment streaming";
            await this.streamWatchHlsSegment(message, record);
            return;
          }
          if (message.type === "viewer-player-ready") {
            record.viewerHasPlayer = true;
            record.viewerMode = message.mode || record.viewerMode || "";
            record.readySyncId = "";
            record.status = record.role === "audio-output" ? "Audio output ready" : "Player ready";
            if (this.hostSyncBarrier) {
              this.addPeerToSyncBarrier(record);
            } else if (record.role === "audio-output") {
              this.sendAudioOutputTargetState(record, "audio-output-ready");
            } else {
              this.sendPlayerState(channel, "viewer-ready");
            }
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
          this.stopPeerClockSync(record);
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
          headers: { Accept: "application/json", "Content-Type": "application/json" },
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

    startPeerClockSync(record) {
      this.stopPeerClockSync(record);
      this.sendPeerClockPing(record);
      record.clockSyncTimer = setInterval(() => this.sendPeerClockPing(record), CLOCK_SYNC_INTERVAL_MS);
    },

    stopPeerClockSync(record) {
      if (record?.clockSyncTimer) {
        clearInterval(record.clockSyncTimer);
        record.clockSyncTimer = null;
      }
    },

    sendPeerClockPing(record) {
      if (!record?.channel || record.channel.readyState !== "open") return;
      sendChannelJson(record.channel, {
        type: "clock-ping",
        sentAt: Date.now(),
      });
    },

    handlePeerClockPong(record, message) {
      const hostReceivedAt = Date.now();
      const hostSentAt = Number(message.hostSentAt || 0);
      const viewerReceivedAt = Number(message.viewerReceivedAt || 0);
      const viewerSentAt = Number(message.viewerSentAt || 0);
      if (!hostSentAt || !viewerReceivedAt || !viewerSentAt) return;
      const rttMs = Math.max(0, (hostReceivedAt - hostSentAt) - Math.max(0, viewerSentAt - viewerReceivedAt));
      const viewerClockOffsetMs = ((viewerReceivedAt - hostSentAt) + (viewerSentAt - hostReceivedAt)) / 2;
      record.viewerClockOffsetMs = viewerClockOffsetMs;
      record.clockRttMs = rttMs;
      if (record.channel?.readyState === "open") {
        sendChannelJson(record.channel, {
          type: "clock-sync",
          viewerClockOffsetMs,
          rttMs,
          sentAt: hostReceivedAt,
        });
      }
    },

    updatePeerPlaybackState(record, message) {
      const playbackRate = Number(message.playbackRate || 1);
      const sentAt = Number(message.sentAt || 0);
      const targetSentAtHostClock = sentAt ? sentAt - Number(record.viewerClockOffsetMs || 0) : Date.now();
      let currentTime = Math.max(0, Number(message.currentTime || 0));
      if (!message.paused && Number.isFinite(targetSentAtHostClock)) {
        currentTime += Math.max(0, Date.now() - targetSentAtHostClock) / 1000 * playbackRate;
      }
      record.latestPlaybackState = {
        currentTime,
        paused: Boolean(message.paused),
        playbackRate,
        sourceVersion: Number(message.sourceVersion || this.playerRoomMetadata?.sourceVersion || 0),
        reason: message.reason || "peer-state",
        receivedAt: Date.now(),
      };
      this.forwardPeerPlaybackState(record);
    },

    forwardPeerPlaybackState(sourceRecord) {
      for (const record of this.connectedWatchPeers()) {
        if (record.role !== "audio-output") continue;
        if ((record.audioOutput?.targetPeerId || "host") !== sourceRecord.id) continue;
        this.sendAudioOutputTargetState(record, `peer-${sourceRecord.latestPlaybackState?.reason || "state"}`);
      }
    },

    sendAudioOutputTargetState(record, reason = "state") {
      if (!record?.channel || record.channel.readyState !== "open") return;
      const targetPeerId = record.audioOutput?.targetPeerId || "host";
      if (targetPeerId === "host") {
        this.sendPlayerState(record.channel, reason);
        return;
      }
      const target = this.playerPeers[targetPeerId];
      const state = target?.latestPlaybackState;
      if (!state) {
        this.sendPlayerState(record.channel, "target-pending");
        return;
      }
      this.sendPlayerStateSnapshot(record.channel, reason, {
        currentTime: state.currentTime,
        paused: state.paused,
        playbackRate: state.playbackRate,
      });
    },

    async streamVideoToViewer(record) {
      const channel = record.channel;
      record.videoStreaming = true;
      record.videoComplete = false;
      const streamMd5 = new SparkMD5.ArrayBuffer();
      try {
        if (!this.isWatchRoomKeyReady()) {
          throw new Error("Watch room encryption key is no longer available. Create a new watch link.");
        }
        if (!sendChannelJson(channel, { type: "video-start", metadata: this.playerRoomMetadata })) {
          throw dataChannelDisconnectedError();
        }
        const source = this.playerRoomSource || this.playerSource;
        if (!source?.openStream) throw new Error("The current watch room source cannot be streamed.");
        const opened = await source.openStream();
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

    async streamWatchHlsSegment(message, record) {
      const channel = record.channel;
      if (!channel || channel.readyState !== "open") return;
      if (!this.isWatchRoomKeyReady()) {
        sendChannelJson(channel, {
          type: "hls-error",
          requestId: message.requestId,
          sourceVersion: Number(this.playerRoomMetadata?.sourceVersion || 0),
          error: "Watch room encryption key is no longer available. Create a new live watch link.",
        });
        return;
      }
      const sourceVersion = Number(this.playerRoomMetadata?.sourceVersion || 0);
      if (message.sourceVersion && Number(message.sourceVersion) !== sourceVersion) {
        sendChannelJson(channel, {
          type: "hls-error",
          requestId: message.requestId,
          sourceVersion: message.sourceVersion,
          error: "The host switched video sources. Reloading the viewer stream.",
        });
        return;
      }
      const wants3d = isStereoVideoProfile(message.videoProfile);
      const source = wants3d
        ? this.playerRoomHls3dSource
        : (this.playerRoomHlsSource || (this.playerRoomSource?.readHlsSegment ? this.playerRoomSource : null));
      const requestId = message.requestId;
      const segmentIndex = Math.max(0, Number(message.segmentIndex || 0));
      const prefetch = Boolean(message.prefetch);
      const chunkSize = RANGE_STREAM_CHUNK_SIZE;
      let sentBytes = 0;
      try {
        if (!source?.readHlsSegment) throw new Error("The current watch room source does not support live HLS segments.");
        record.cancelledRanges?.delete(requestId);
        const segment = await source.readHlsSegment(segmentIndex);
        const bytes = exactArrayBuffer(segment.bytes);
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
          if (record.cancelledRanges?.has(requestId)) break;
          const plainChunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength));
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = await crypto.subtle.encrypt(
            { name: "AES-GCM", iv },
            this.playerRoomKey,
            plainChunk,
          );
          if (!sendChannelBinaryJson(channel, {
            type: "hls-chunk",
            requestId,
            segmentIndex,
            offset,
            sourceVersion,
            iv: base64UrlEncode(iv),
            prefetch,
          }, ciphertext)) throw dataChannelDisconnectedError();
          if (!(await waitForDataChannelBuffer(channel))) throw dataChannelDisconnectedError();
          sentBytes += plainChunk.byteLength;
          record.sentBytes = (record.sentBytes || 0) + plainChunk.byteLength;
          if (shouldUpdateChannelUi(record)) {
            record.status = `Live segment ${segmentIndex + 1}`;
          }
        }
        if (!record.cancelledRanges?.has(requestId)) {
          if (!sendChannelJson(channel, {
            type: "hls-done",
            requestId,
            segmentIndex,
            sourceVersion,
            sentBytes,
            contentType: segment.contentType || "video/mp2t",
            prefetch,
          })) throw dataChannelDisconnectedError();
        }
      } catch (error) {
        if (isDataChannelClosedError(error)) {
          record.status = "Disconnected";
        } else {
          record.status = "Live segment failed";
          this.error = error.message;
        }
        if (!isDataChannelClosedError(error) && isDataChannelOpen(channel)) {
          sendChannelJson(channel, {
            type: "hls-error",
            requestId,
            segmentIndex,
            sourceVersion,
            error: error.message,
            prefetch,
          });
        }
      } finally {
        record.cancelledRanges?.delete(requestId);
      }
    },

    async streamWatchRange(message, record) {
      const channel = record.channel;
      if (!channel || channel.readyState !== "open") return;
      if (!this.isWatchRoomKeyReady()) {
        sendChannelJson(channel, {
          type: "range-error",
          requestId: message.requestId,
          sourceVersion: Number(this.playerRoomMetadata?.sourceVersion || 0),
          error: "Watch room encryption key is no longer available. Create a new watch link.",
        });
        return;
      }
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
      const source = this.playerRoomRangeSource || (this.playerRoomSource?.readRange ? this.playerRoomSource : null);
      if (message.linear && source?.progressiveTranscode) {
        await this.streamWatchLinearProgressive(message, record, source, sourceVersion);
        return;
      }
      const totalSize = Number(
        (!source?.progressiveTranscode && source?.size)
        || this.playerRoomMetadata?.availableModes?.range?.size
        || this.playerRoomMetadata?.size
        || source?.estimatedFinalSize
        || source?.size
        || 0,
      );
      const start = Math.max(0, Number(message.start || 0));
      const end = Math.min(totalSize - 1, Number(message.end ?? totalSize - 1));
      const requestId = message.requestId;
      const prefetch = Boolean(message.prefetch);
      const chunkSize = RANGE_STREAM_CHUNK_SIZE;
      const rangeMd5 = new SparkMD5.ArrayBuffer();
      let sentBytes = 0;
      try {
        if (!source?.readRange) {
          throw new Error("The current watch room source does not support byte-range playback. Use the Live stream watch link or create a new Stable MP4 watch link.");
        }
        record.cancelledRanges?.delete(requestId);
        if (source?.progressiveTranscode) {
          const ready = await this.waitForProgressiveTranscodeOffset(start, record, requestId, source);
          if (!ready) return;
        }
        for (let offset = start; offset <= end; offset += chunkSize) {
          if (record.cancelledRanges?.has(requestId)) break;
          const nextEnd = Math.min(offset + chunkSize - 1, end);
          if (source?.progressiveTranscode) {
            const ready = await this.waitForProgressiveTranscodeOffset(nextEnd, record, requestId, source);
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
            prefetch,
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
            prefetch,
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
            prefetch,
          });
        }
      } finally {
        record.cancelledRanges?.delete(requestId);
      }
    },

    async streamWatchLinearProgressive(message, record, source, sourceVersion) {
      const channel = record.channel;
      const requestId = message.requestId;
      const chunkSize = RANGE_STREAM_CHUNK_SIZE;
      const rangeMd5 = new SparkMD5.ArrayBuffer();
      let offset = 0;
      let sentBytes = 0;
      try {
        if (!source?.readRange) {
          throw new Error("The current watch room source does not support linear Stable MP4 playback.");
        }
        record.cancelledRanges?.delete(requestId);
        while (!record.cancelledRanges?.has(requestId)) {
          if (!isDataChannelOpen(channel)) throw dataChannelDisconnectedError();
          const progress = this.playerRoomMetadata?.availableModes?.range?.progressiveTranscode
            || this.playerRoomMetadata?.progressiveTranscode
            || {};
          const complete = !source.progressiveTranscode || this.playerTranscodeComplete || Boolean(progress.complete);
          const availableBytes = Math.max(
            Number(source.transcodedAvailableBytes || 0),
            Number(progress.availableBytes || 0),
            complete ? Number(source.size || 0) : 0,
          );
          if (offset >= availableBytes) {
            if (complete) break;
            record.status = `Waiting for Stable MP4 byte ${formatByteOffset(offset)}`;
            await sleep(250);
            continue;
          }
          const nextEndExclusive = Math.min(offset + chunkSize, availableBytes);
          const plainChunk = exactArrayBuffer(await source.readRange(offset, nextEndExclusive));
          if (!plainChunk.byteLength) {
            if (complete) break;
            await sleep(250);
            continue;
          }
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
            end: offset + plainChunk.byteLength - 1,
            sourceVersion,
            iv: base64UrlEncode(iv),
          }, ciphertext)) throw dataChannelDisconnectedError();
          if (!(await waitForDataChannelBuffer(channel))) throw dataChannelDisconnectedError();
          offset += plainChunk.byteLength;
          sentBytes += plainChunk.byteLength;
          record.sentBytes = (record.sentBytes || 0) + plainChunk.byteLength;
          if (shouldUpdateChannelUi(record)) {
            record.status = `Linear Stable MP4 ${formatByteOffset(sentBytes)}`;
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
          record.status = "Linear playback failed";
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

    async waitForProgressiveTranscodeOffset(offset, record, requestId, source = this.playerRoomRangeSource || this.playerSource) {
      const rangeMetadata = this.playerRoomMetadata?.availableModes?.range || this.playerRoomMetadata || {};
      const totalSize = Number(rangeMetadata.size || source?.estimatedFinalSize || source?.size || 0);
      if (!totalSize || offset <= 0) return true;
      const requiredPercent = Math.min(100, ((offset + 1) / totalSize) * 100);
      while (source?.progressiveTranscode && !this.progressiveTranscodeOffsetReady(offset, requiredPercent, source, rangeMetadata)) {
        if (record.cancelledRanges?.has(requestId)) return false;
        if (!isDataChannelOpen(record.channel)) return false;
        record.status = `Waiting for transcode ${Math.ceil(requiredPercent)}%`;
        await sleep(500);
      }
      return true;
    },

    progressiveTranscodeOffsetReady(offset, requiredPercent, source = this.playerRoomRangeSource || this.playerSource, rangeMetadata = this.playerRoomMetadata?.availableModes?.range || this.playerRoomMetadata || {}) {
      const progress = rangeMetadata.progressiveTranscode || this.playerRoomMetadata?.progressiveTranscode || {};
      const availableBytes = Number(source?.transcodedAvailableBytes || progress.availableBytes || 0);
      if (availableBytes > 0) return availableBytes > offset;
      return Number(source?.progressiveTranscodePercent || progress.percent || this.playerTranscodeAvailablePercent || 0) + 0.25 >= requiredPercent;
    },

    isWatchRoomKeyReady() {
      return Boolean(this.playerRoomKey && this.playerRoomKey.type === "secret");
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
          peer.viewerHasPlayer = false;
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
      if (this.hostProgressivePlaybackLocked() && message.action === "seek") {
        if (record.channel?.readyState === "open") {
          sendChannelJson(record.channel, {
            type: "control-denied",
            reason: "Scrubbing unlocks when Stable MP4 is complete.",
          });
        }
        record.status = "Seek blocked";
        return;
      }
      const currentTime = this.hostProgressivePlaybackLocked()
        ? video.currentTime || 0
        : (Number.isFinite(message.currentTime) ? Math.max(0, message.currentTime) : video.currentTime || 0);
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
      if (this.hostProgressivePlaybackLocked()) {
        this.playerStatus = "Scrubbing unlocks when Stable MP4 is complete.";
        return;
      }
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
      if (this.hostProgressivePlaybackLocked()) {
        this.suppressHostPlayerEvents = true;
        seekVideoTo(video, this.hostLinearPlaybackTime || 0);
        this.playerStatus = "Scrubbing unlocks when Stable MP4 is complete.";
        setTimeout(() => {
          this.suppressHostPlayerEvents = false;
        }, 300);
        return;
      }
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

    syncEligibleWatchPeers(peers = this.connectedWatchPeers()) {
      return peers.filter((record) => record.viewerHasPlayer || record.videoComplete);
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
      const syncPeers = this.syncEligibleWatchPeers(peers);
      if (syncPeers.length === 0) {
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
        peerIds: new Set(syncPeers.map((peer) => peer.id)),
      };
      const restoreHostEvents = !this.suppressHostPlayerEvents;
      this.suppressHostPlayerEvents = true;
      video.pause();
      if (restoreHostEvents) {
        setTimeout(() => {
          this.suppressHostPlayerEvents = false;
        }, 600);
      }
      for (const record of peers.filter((peer) => !this.hostSyncBarrier.peerIds.has(peer.id))) {
        this.sendPlayerStateSnapshot(record.channel, reason, {
          currentTime,
          paused: false,
          playbackRate: video.playbackRate || 1,
        });
      }
      for (const record of syncPeers) {
        record.readySyncId = "";
        record.status = "Buffering sync segment";
        this.sendSyncHoldToPeer(record);
      }
      this.playerStatus = `Waiting for host and ${syncPeers.length} viewer${syncPeers.length === 1 ? "" : "s"} to buffer ${SYNC_BUFFER_SECONDS} seconds...`;
      this.waitForHostResumeBuffer(syncId);
      setTimeout(() => {
        if (this.hostSyncBarrier?.syncId !== syncId) return;
        this.hostSyncBarrier.hostReady = true;
        this.playerStatus = "Host buffer did not report enough data while paused. Resuming from the seek target.";
        this.finishSynchronizedResumeIfReady(syncId);
      }, SYNC_FORCE_AFTER_MS);
      setTimeout(() => {
        if (this.hostSyncBarrier?.syncId === syncId) {
          this.releaseUnreadySyncViewers(syncId);
        }
      }, SYNC_READY_TIMEOUT_MS);
    },

    sendSyncHoldToPeer(record) {
      if (!this.hostSyncBarrier || !record.channel || record.channel.readyState !== "open") return;
      sendChannelJson(record.channel, {
        type: "sync-hold",
        syncId: this.hostSyncBarrier.syncId,
        reason: this.hostSyncBarrier.reason,
        currentTime: this.hostSyncBarrier.currentTime,
        bufferSeconds: this.hostSyncBarrier.bufferSeconds,
        playbackRate: document.getElementById("host-video-player")?.playbackRate || 1,
      });
    },

    addPeerToSyncBarrier(record) {
      if (!this.hostSyncBarrier || !record?.channel || record.channel.readyState !== "open") return;
      if (this.hostSyncBarrier.peerIds.has(record.id)) return;
      this.hostSyncBarrier.peerIds.add(record.id);
      record.readySyncId = "";
      record.status = "Buffering sync segment";
      this.sendSyncHoldToPeer(record);
    },

    releaseUnreadySyncViewers(syncId) {
      if (!this.hostSyncBarrier || this.hostSyncBarrier.syncId !== syncId) return;
      const peers = this.connectedWatchPeers().filter((peer) => this.hostSyncBarrier.peerIds.has(peer.id));
      const unready = peers.filter((peer) => peer.readySyncId !== syncId);
      for (const peer of unready) {
        peer.readySyncId = syncId;
        peer.status = "Sync timed out";
      }
      if (unready.length > 0) {
        this.playerStatus = `${unready.length} viewer${unready.length === 1 ? "" : "s"} did not report enough buffered data. Resuming playback anyway.`;
      }
      this.finishSynchronizedResumeIfReady(syncId);
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
      const sentAt = Date.now();
      const payload = {
        type: "resume-at",
        syncId,
        currentTime: this.hostSyncBarrier.currentTime,
        bufferSeconds: this.hostSyncBarrier.bufferSeconds,
        playbackRate: video.playbackRate || 1,
        resumeDelayMs,
        resumeAt: sentAt + resumeDelayMs,
        sentAt,
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
          if (record.role === "audio-output" && (record.audioOutput?.targetPeerId || "host") !== "host") {
            this.sendAudioOutputTargetState(record, reason);
          } else {
            this.sendPlayerState(record.channel, reason);
          }
        }
      }
    },

    sendPlayerState(channel, reason) {
      const video = document.getElementById("host-video-player");
      if (!video || channel.readyState !== "open") return;
      this.sendPlayerStateSnapshot(channel, reason, {
        currentTime: video.currentTime || 0,
        paused: video.paused,
        playbackRate: video.playbackRate || 1,
      });
    },

    sendPlayerStateSnapshot(channel, reason, state = {}) {
      if (!channel || channel.readyState !== "open") return;
      sendChannelJson(channel, {
        type: "sync",
        reason,
        currentTime: Math.max(0, Number(state.currentTime || 0)),
        paused: Boolean(state.paused),
        playbackRate: Number(state.playbackRate || 1),
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
      const resource = this.selectedResourceForItem(item);
      if (!resource) return "#";
      if (resource.proxyPath) return this.connectorDirectUrl(resource.proxyPath);
      return resource.url || "#";
    },

    iconForItem(item) {
      const resource = this.selectedResourceForItem(item);
      const type = contentTypeFromProtocol(resource?.protocolInfo || "");
      if (type.startsWith("image/")) return "bi-file-earmark-image text-info";
      if (type.startsWith("video/")) return "bi-file-earmark-play text-danger";
      if (type.startsWith("audio/")) return "bi-file-earmark-music text-primary";
      return "bi-file-earmark text-secondary";
    },

    isPreviewableType(type) {
      return type.startsWith("image/") || type.startsWith("video/") || type.startsWith("audio/");
    },

    isVideoItem(item) {
      return (item.resources || []).some((resource) => contentTypeFromProtocol(resource.protocolInfo || "").startsWith("video/"));
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

    copyTransferLink(transfer) {
      if (!transfer?.shareLink) return;
      this.copyToClipboard(transfer.shareLink);
    },

    stopShareTransfer(transfer) {
      if (!transfer) return;
      const session = this.peerShareSessions[transfer.id];
      if (session?.reofferTimer) window.clearTimeout(session.reofferTimer);
      try {
        session?.channel?.close?.();
        session?.peer?.close?.();
        transfer.channel?.close?.();
        transfer.peer?.close?.();
      } catch (error) {
        // The peer may already be closed.
      }
      if (!["Expired", "Failed"].includes(transfer.status)) {
        transfer.status = "Stopped";
      }
      delete this.peerShareSessions[transfer.id];
      this.shareStatus = "Share link stopped.";
    },

    removeShareTransfer(transfer) {
      if (!transfer) return;
      this.stopShareTransfer(transfer);
      this.outgoingTransfers = this.outgoingTransfers.filter((candidate) => candidate.id !== transfer.id);
      if (this.shareLink === transfer.shareLink) {
        this.shareLink = "";
        this.updateShareQrCode("");
      }
    },

    badgeForTransfer(transfer) {
      if (["Ready", "Ready for another download", "Complete"].includes(transfer.status)) return "text-bg-success";
      if (transfer.status === "Failed") return "text-bg-danger";
      if (["Expired", "Stopped"].includes(transfer.status)) return "text-bg-secondary";
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
