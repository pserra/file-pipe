document.addEventListener("alpine:init", () => {
  Alpine.data("bigscreenPlayer", (sessionId) => ({
    sessionId,
    key: null,
    metadata: null,
    peer: null,
    channel: null,
    channelMessageQueue: Promise.resolve(),
    channelReady: false,
    acknowledgementAccepted: false,
    playerStarted: false,
    xrPlayer: null,
    status: "Loading Bigscreen link...",
    error: "",

    async initBigscreen() {
      navigator.serviceWorker?.addEventListener("message", (event) => this.handleWorkerMessage(event));
      try {
        const keyText = new URLSearchParams(window.location.hash.slice(1)).get("key");
        if (!keyText) throw new Error("This Bigscreen link is missing its decryption key.");
        this.key = await crypto.subtle.importKey(
          "raw",
          base64UrlDecode(keyText),
          { name: "AES-GCM" },
          false,
          ["decrypt"],
        );
        if (navigator.serviceWorker) {
          await this.registerServiceWorker();
        }
        await this.loadSessionAndAnswer();
      } catch (error) {
        this.error = error.message;
        this.status = "";
      }
    },

    async loadSessionAndAnswer() {
      const signal = await this.waitForOffer();
      if (!signal.metadata) throw new Error("The launcher has not published metadata yet.");
      const metadataBytes = await this.decryptPayload(
        signal.metadata.iv,
        base64UrlDecode(signal.metadata.ciphertext),
      );
      this.metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
      this.status = "Connecting to launcher...";
      await this.answerOffer(signal.offer);
    },

    async waitForOffer() {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const response = await fetch(`/api/bigscreen/sessions/${this.sessionId}`);
        const signal = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(signal.error || `Bigscreen session lookup failed: ${response.status}`);
        if (signal.offer) return signal;
        await sleep(1000);
      }
      throw new Error("The launcher did not create a Bigscreen offer.");
    },

    async answerOffer(offer) {
      if (this.peer) this.peer.close();
      this.peer = new RTCPeerConnection(P2P_CONFIG);
      this.peer.ondatachannel = (event) => {
        this.channel = event.channel;
        this.channel.binaryType = "arraybuffer";
        this.channel.onopen = () => {
          this.channelReady = true;
          this.status = "Connected. Acknowledge the file to start playback.";
        };
        this.channelMessageQueue = Promise.resolve();
        this.channel.onmessage = (eventMessage) => this.queueChannelMessage(eventMessage);
        this.channel.onclose = () => {
          this.channelReady = false;
          this.status = "Launcher disconnected. Reload when the launcher is back online.";
        };
      };
      this.peer.onconnectionstatechange = () => {
        if (["failed", "disconnected"].includes(this.peer.connectionState)) {
          this.channelReady = false;
          this.status = "Peer connection interrupted. Reload to reconnect.";
        }
      };
      await this.peer.setRemoteDescription(offer);
      const answer = await this.peer.createAnswer();
      await this.peer.setLocalDescription(answer);
      await waitForIceGatheringComplete(this.peer);
      const response = await fetch(`/api/bigscreen/sessions/${this.sessionId}/answer`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: this.peer.localDescription }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Could not publish Bigscreen answer: ${response.status}`);
      }
      this.status = "Answer sent. Waiting for data channel...";
    },

    async startPlayer() {
      if (!this.channelReady || !this.metadata) return;
      if (!navigator.serviceWorker) {
        this.error = "This browser does not support service workers, which are required for Bigscreen range playback.";
        return;
      }

      try {
        this.error = "";
        this.status = "Preparing range streaming player...";
        await this.registerServiceWorker();
        navigator.serviceWorker.controller.postMessage({
          type: "bigscreen-metadata",
          sessionId: this.sessionId,
          metadata: plainData(this.metadata),
        });
        this.playerStarted = true;
        await this.$nextTick();
        const video = document.getElementById("bigscreen-video");
        this.attachXrPlayer(video);
        const fileName = encodeURIComponent(this.metadata.name || "video");
        video.src = `/bigscreen-media/${this.sessionId}/${fileName}`;
        video.load();
        video.play().catch(() => {
          this.status = "Player is ready. Press play if autoplay is blocked.";
        });
        this.status = "Streaming from launcher. Scrubbing uses encrypted P2P range requests.";
      } catch (error) {
        this.error = error.message;
        this.status = "";
      }
    },

    attachXrPlayer(video) {
      if (!window.FilePipeXrPlayer || !video) return;
      this.xrPlayer = window.FilePipeXrPlayer.attach(video, {
        fill: true,
        storageKey: "filePipeBigscreenXrPlayer",
      });
    },

    async registerServiceWorker() {
      const registration = await navigator.serviceWorker.register("/bigscreen-sw.js?v=6", { scope: "/" });
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
        throw new Error("Reloading once so the Bigscreen service worker can control this page.");
      }
    },

    handleWorkerMessage(event) {
      const message = event.data || {};
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
          error: "Launcher data channel is not connected.",
        });
        return;
      }
      if (!sendChannelJson(this.channel, {
        type: "range-request",
        requestId: message.requestId,
        start: message.start,
        end: message.end,
      })) {
        this.postWorkerMessage({
          type: "range-error",
          requestId: message.requestId,
          error: "Launcher data channel is not connected.",
        });
      }
    },

    async handleChannelMessage(event) {
      try {
        const message = await readChannelMessage(event.data);
        if (message.type === "range-chunk") {
          const ciphertext = message.binary || base64UrlDecode(message.data);
          const plaintext = await this.decryptPayload(message.iv, ciphertext);
          this.postWorkerMessage(
            {
              type: "range-chunk",
              requestId: message.requestId,
              bytes: plaintext,
            },
            [plaintext],
          );
          return;
        }
        if (message.type === "range-done") {
          this.postWorkerMessage({
            type: "range-done",
            requestId: message.requestId,
          });
          return;
        }
        if (message.type === "range-error") {
          this.postWorkerMessage({
            type: "range-error",
            requestId: message.requestId,
            error: message.error || "Launcher range request failed.",
          });
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

    postWorkerMessage(message, transfer = []) {
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage(message, transfer);
      }
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

function plainData(value) {
  return JSON.parse(JSON.stringify(value));
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
