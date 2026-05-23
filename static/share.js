document.addEventListener("alpine:init", () => {
  Alpine.data("fileShare", (shareId) => ({
    shareId,
    key: null,
    peer: null,
    channel: null,
    metadata: null,
    receivedParts: [],
    receivedBytes: 0,
    downloadUrl: "",
    downloading: false,
    acknowledgementAccepted: false,
    verifiedMd5: "",
    progress: 0,
    status: "",
    error: "",

    async loadManifest() {
      try {
        const keyText = new URLSearchParams(window.location.hash.slice(1)).get("key");
        if (!keyText) {
          throw new Error("This link is missing its decryption key.");
        }

        this.key = await crypto.subtle.importKey(
          "raw",
          base64UrlDecode(keyText),
          { name: "AES-GCM" },
          false,
          ["decrypt"],
        );

        const signal = await this.waitForOffer();
        const metadataBytes = await this.decryptPayload(
          signal.metadata.iv,
          base64UrlDecode(signal.metadata.ciphertext),
        );
        this.metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
        await this.answerPeer(signal.offer);
        this.status = "Waiting for sender connection. Keep this page open.";
      } catch (error) {
        this.error = error.message;
        this.status = "";
      }
    },

    async waitForOffer() {
      for (let attempt = 0; attempt < 180; attempt += 1) {
        const response = await fetch(`/api/p2p/shares/${this.shareId}`);
        const signal = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(signal.error || `Share lookup failed with ${response.status}.`);
        }
        if (signal.offer && signal.metadata) return signal;
        await sleep(1000);
      }
      throw new Error("The sender has not published a peer-to-peer offer yet.");
    },

    async answerPeer(offer) {
      this.peer = new RTCPeerConnection(P2P_CONFIG);
      this.peer.ondatachannel = (event) => {
        this.channel = event.channel;
        this.channel.onopen = () => {
          this.status = "Connected to sender. Confirm the acknowledgement to begin transfer.";
        };
        this.channel.onmessage = (messageEvent) => this.handlePeerMessage(messageEvent);
        this.channel.onclose = () => {
          if (!this.downloadUrl && !this.error) {
            this.status = "Sender disconnected.";
          }
        };
        this.channel.onerror = () => {
          this.error = "Peer data channel failed.";
        };
      };

      await this.peer.setRemoteDescription(offer);
      const answer = await this.peer.createAnswer();
      await this.peer.setLocalDescription(answer);
      await waitForIceGatheringComplete(this.peer);

      const response = await fetch(`/api/p2p/shares/${this.shareId}/answer`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: this.peer.localDescription }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Could not publish WebRTC answer: ${response.status}`);
      }
    },

    async decryptPayload(ivText, ciphertext) {
      return crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64UrlDecode(ivText) },
        this.key,
        ciphertext,
      );
    },

    async download() {
      if (!this.metadata || !this.key) return;
      if (!this.acknowledgementAccepted) {
        this.error = "Confirm the download acknowledgement before continuing.";
        return;
      }
      if (!this.metadata.md5) {
        this.error = "This share does not include an MD5 checksum and cannot be downloaded.";
        return;
      }
      if (!window.SparkMD5) {
        this.error = "MD5 support is unavailable. Reload the page and try again.";
        return;
      }
      if (!this.channel || this.channel.readyState !== "open") {
        this.error = "The sender is not connected yet. Keep both pages open and try again.";
        return;
      }

      this.downloading = true;
      this.downloadUrl = "";
      this.verifiedMd5 = "";
      this.receivedParts = [];
      this.receivedBytes = 0;
      this.md5 = new SparkMD5.ArrayBuffer();
      this.progress = 0;
      this.status = "Requesting encrypted peer-to-peer stream...";
      this.error = "";
      if (!sendChannelJson(this.channel, { type: "ready" })) {
        this.downloading = false;
        this.error = "The sender disconnected before the transfer could start.";
      }
    },

    async handlePeerMessage(event) {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "start") {
          this.status = "Receiving encrypted peer-to-peer stream...";
          return;
        }
        if (message.type === "chunk") {
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
        if (message.type === "done") {
          const decryptedMd5 = this.md5.end();
          if (decryptedMd5 !== this.metadata.md5 || decryptedMd5 !== message.md5) {
            throw new Error("The decrypted file MD5 does not match the shared metadata.");
          }
          this.verifiedMd5 = decryptedMd5;
          const blob = new Blob(this.receivedParts, {
            type: this.metadata.type || "application/octet-stream",
          });
          this.downloadUrl = URL.createObjectURL(blob);
          this.progress = 100;
          this.status = "File verified and received peer-to-peer. Use Save file to download it.";
          this.downloading = false;
        }
      } catch (error) {
        this.error = error.message;
        this.status = "";
        this.downloading = false;
      }
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

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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
