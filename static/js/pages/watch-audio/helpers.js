const P2P_CONFIG = {
  ...(window.FILE_PIPE_P2P_CONFIG || { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }),
};

function base64UrlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

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

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function sendChannelJson(channel, payload) {
  if (channel?.readyState !== "open") return false;
  try {
    channel.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function normalizeAudioChannel(value) {
  const channel = String(value || "").trim().toUpperCase().replace(/[\s_-]+/g, "");
  const aliases = {
    LEFT: "L",
    RIGHT: "R",
    CENTER: "C",
    CENTRE: "C",
    SUB: "LFE",
    SUBWOOFER: "LFE",
    LOWFREQUENCY: "LFE",
    LS: "SL",
    RS: "SR",
    LEFTSURROUND: "SL",
    RIGHTSURROUND: "SR",
    LEFTBACK: "BL",
    RIGHTBACK: "BR",
  };
  return aliases[channel] || channel;
}

function safeDisconnect(node) {
  try {
    node?.disconnect?.();
  } catch {
    // Already disconnected.
  }
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

function isHlsPlaybackMetadata(metadata) {
  return metadata?.streamMode === "hls"
    || metadata?.playbackProfile?.sourceKind === "hls-live"
    || String(metadata?.type || "").toLowerCase().includes("mpegurl");
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

function mediaHasResumeBuffer(video, targetTime, secondsAhead, startedAt) {
  const target = Math.max(0, Number(targetTime || 0));
  const seconds = Math.max(0, Number(secondsAhead || 0));
  const duration = Number.isFinite(video?.duration) ? video.duration : Number.POSITIVE_INFINITY;
  const requiredEnd = Math.min(duration, target + seconds);
  if (mediaBufferedUntil(video, target) >= requiredEnd) return true;
  const elapsed = Date.now() - Number(startedAt || Date.now());
  if (elapsed >= WATCH_AUDIO_SYNC_RELAX_AFTER_MS && mediaBufferedUntil(video, target) >= Math.min(duration, target + 0.75)) return true;
  if (elapsed >= WATCH_AUDIO_SYNC_FORCE_AFTER_MS && video?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return true;
  return false;
}

function seekVideoTo(video, targetTime) {
  if (!video) return;
  const target = Math.max(0, Number(targetTime || 0));
  const apply = () => {
    try {
      const duration = Number.isFinite(video.duration) ? video.duration : null;
      video.currentTime = duration ? Math.min(target, Math.max(0, duration - 0.05)) : target;
    } catch {
      // Some browsers reject seeks before metadata is ready.
    }
  };
  if (video.readyState === HTMLMediaElement.HAVE_NOTHING) video.addEventListener("loadedmetadata", apply, { once: true });
  else apply();
}

function detectMediaPlaybackCapabilities() {
  const video = document.createElement("video");
  const canPlay = (tests) => tests.some((type) => {
    const result = video.canPlayType(type);
    return result === "probably" || result === "maybe";
  });
  return {
    videoCodecs: {
      h264: canPlay(['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.4D401E"']),
      hevc: canPlay(['video/mp4; codecs="hvc1"', 'video/mp4; codecs="hev1"']),
    },
    audioCodecs: {
      aac: canPlay(['audio/mp4; codecs="mp4a.40.2"', 'video/mp4; codecs="mp4a.40.2"']),
      mp3: canPlay(["audio/mpeg", "audio/mp3"]),
    },
    containers: {
      mp4: canPlay(["video/mp4"]),
      hls: canPlay(["application/vnd.apple.mpegurl"]) || Boolean(window.Hls?.isSupported?.()),
    },
  };
}

function plainData(value) {
  return JSON.parse(JSON.stringify(value));
}

function serviceWorkerSetupMessage(error) {
  const message = error?.message || String(error);
  const lowerMessage = message.toLowerCase();
  if (
    lowerMessage.includes("certificate")
    || lowerMessage.includes("unknown error occurred when fetching the script")
    || lowerMessage.includes("failed to register a serviceworker")
  ) {
    return `${message} Trust the File Pipe HTTPS certificate on this device for the exact host you are using, or serve File Pipe with a publicly trusted HTTPS certificate. Browsers will not install service workers over an untrusted LAN certificate, even if the page itself was opened after a warning.`;
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
