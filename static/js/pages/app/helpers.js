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
  ...(window.FILE_PIPE_P2P_CONFIG || { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }),
};
const DATA_CHANNEL_BUFFER_LOW_THRESHOLD = 2 * 1024 * 1024;
const RANGE_STREAM_CHUNK_SIZE = 96 * 1024;
const CHANNEL_UI_UPDATE_INTERVAL_MS = 500;
const CLOCK_SYNC_INTERVAL_MS = 5000;
const MSE_MAX_BUFFER_AHEAD_SECONDS = 24;
const MSE_BACK_BUFFER_SECONDS = 8;
const SYNC_BUFFER_SECONDS = 3;
const SYNC_RELAXED_BUFFER_SECONDS = 1;
const SYNC_RELAX_AFTER_MS = 3500;
const SYNC_FORCE_AFTER_MS = 7000;
const SYNC_READY_POLL_MS = 250;
const SYNC_READY_TIMEOUT_MS = 9000;
const SYNC_RESUME_DELAY_MS = 700;
const SEEK_SYNC_DEBOUNCE_MS = 450;

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
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
      hls: canPlay(["application/vnd.apple.mpegurl"]) || Boolean(window.Hls?.isSupported?.()),
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
  const audioChannels = Number(mediaInfo?.audioChannels || mediaInfo?.defaultAudio?.channels || 0);
  return {
    sourceKind,
    containerType: contentType || "application/octet-stream",
    videoCodec,
    audioCodec,
    audioChannels,
    audioChannelLayout: mediaInfo?.audioChannelLayout || mediaInfo?.defaultAudio?.channel_layout || "",
    audioChannelLabels: Array.isArray(mediaInfo?.audioChannelLabels) ? mediaInfo.audioChannelLabels : [],
    spatialAudioReady: mediaInfoSpatialAudioReady(mediaInfo),
    universal: sourceKind === "stable-mp4" || (videoCodec === "h264" && ["", "aac", "mp3"].includes(audioCodec) && isMp4LikeContentType(contentType)),
  };
}

function stableMp4PlaybackProfile(mediaInfo, audioProfile = "stereo") {
  const spatial = audioProfile === "spatial";
  const sourceChannels = Number(mediaInfo?.audioChannels || mediaInfo?.defaultAudio?.channels || 0);
  return {
    sourceKind: "stable-mp4",
    containerType: "video/mp4",
    videoCodec: "h264",
    audioCodec: mediaInfo?.defaultAudio ? "aac" : "",
    audioChannels: spatial ? sourceChannels : Math.min(2, sourceChannels || 2),
    audioChannelLayout: spatial ? (mediaInfo?.audioChannelLayout || mediaInfo?.defaultAudio?.channel_layout || "") : "stereo",
    audioChannelLabels: spatial && Array.isArray(mediaInfo?.audioChannelLabels) ? mediaInfo.audioChannelLabels : ["L", "R"],
    spatialAudioReady: spatial,
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
    audioChannels: Number(mediaInfo.audioChannels || mediaInfo.defaultAudio?.channels || 0),
    audioChannelLayout: mediaInfo.audioChannelLayout || mediaInfo.defaultAudio?.channel_layout || "",
    audioChannelLabels: Array.isArray(mediaInfo.audioChannelLabels) ? mediaInfo.audioChannelLabels : [],
    spatialAudioCandidate: Boolean(mediaInfo.spatialAudioCandidate || mediaInfoSpatialAudioCandidate(mediaInfo)),
    stereo3dCandidate: Boolean(mediaInfo.stereo3dCandidate || mediaInfoStereo3dCandidate(mediaInfo)),
    stereo3dProfiles: mediaInfo.stereo3dProfiles || null,
    transcodeVideoProfiles: mediaInfo.transcodeVideoProfiles || null,
    defaultAudio: mediaInfo.defaultAudio ? {
      codec_name: mediaInfo.defaultAudio.codec_name,
      profile: mediaInfo.defaultAudio.profile,
      channels: mediaInfo.defaultAudio.channels,
      channel_layout: mediaInfo.defaultAudio.channel_layout,
    } : null,
    defaultVideo: mediaInfo.defaultVideo ? {
      codec_name: mediaInfo.defaultVideo.codec_name,
      profile: mediaInfo.defaultVideo.profile,
      pix_fmt: mediaInfo.defaultVideo.pix_fmt,
      width: mediaInfo.defaultVideo.width,
      height: mediaInfo.defaultVideo.height,
    } : null,
    audioStreams: Array.isArray(mediaInfo.audioStreams) ? mediaInfo.audioStreams.map((stream) => ({
      codec_name: stream.codec_name,
      profile: stream.profile,
      channels: stream.channels,
      channel_layout: stream.channel_layout,
      tags: stream.tags || null,
    })) : [],
    videoStreams: Array.isArray(mediaInfo.videoStreams) ? mediaInfo.videoStreams.map((stream) => ({
      codec_name: stream.codec_name,
      profile: stream.profile,
      pix_fmt: stream.pix_fmt,
      width: stream.width,
      height: stream.height,
    })) : [],
  };
}

function mediaInfoSpatialAudioCandidate(mediaInfo) {
  const channels = Number(mediaInfo?.audioChannels || mediaInfo?.defaultAudio?.channels || 0);
  return channels > 2;
}

function mediaInfoStereo3dCandidate(mediaInfo) {
  return Boolean(mediaInfo?.stereo3dCandidate || mediaInfo?.defaultVideo || mediaInfo?.videoCodec);
}

function normalizeTranscodeVideoProfile(value) {
  const profile = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["full-sbs", "fsbs", "3d-full", "full-3d", "3d-full-sbs", "stereo-full-sbs"].includes(profile)) {
    return "3d-full-sbs";
  }
  if (["1", "true", "yes", "on", "3d", "sbs", "half-sbs", "stereo-sbs", "sbs-3d", "3d-sbs", "stereoscopic"].includes(profile)) {
    return "3d-sbs";
  }
  return "2d";
}

function isStereoVideoProfile(value) {
  return normalizeTranscodeVideoProfile(value) !== "2d";
}

function normalizeStereo3dLayout(value) {
  const layout = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["full", "full-sbs", "fsbs", "3d-full-sbs"].includes(layout)) return "full-sbs";
  return "half-sbs";
}

function videoProfileForStereo3dLayout(value) {
  return normalizeStereo3dLayout(value) === "full-sbs" ? "3d-full-sbs" : "3d-sbs";
}

function videoLayoutForTranscodeProfile(value) {
  const profile = normalizeTranscodeVideoProfile(value);
  if (profile === "3d-full-sbs") return "full-sbs";
  if (profile === "3d-sbs") return "half-sbs";
  return "mono";
}

function videoLayoutLabel(value) {
  return normalizeStereo3dLayout(value) === "full-sbs" ? "Full SBS" : "Half SBS";
}

function normalizeStereo3dResolutionScale(value) {
  const scale = String(value || "").trim().toLowerCase().replace(/x$/, "");
  if (["1", "1.0", "100", "100%"].includes(scale)) return "1";
  if (["0.75", ".75", "075", "75", "75%"].includes(scale)) return "0.75";
  if (["0.5", ".5", "05", "50", "50%"].includes(scale)) return "0.5";
  return "1";
}

function normalizeStereo3dInferenceScale(value) {
  const text = String(value || "").trim().toLowerCase().replace(/x$/, "").replace(/%$/, "");
  let number = Number(text || 0.5);
  if (!Number.isFinite(number)) number = 0.5;
  if (number > 1) number /= 100;
  number = Math.max(0.1, Math.min(1, number));
  if (Math.abs(number - 1) < 0.001) return "1";
  return String(Math.round(number * 100) / 100).replace(/^0(?=\.)/, "0");
}

function normalizeStereo3dInferenceCropPercent(value) {
  let number = Number(String(value ?? "").replace("%", ""));
  if (!Number.isFinite(number)) number = 0;
  number = Math.max(0, Math.min(25, number));
  return String(Math.round(number * 100) / 100);
}

function normalizeStereo3dPipeline(value) {
  return String(value || "").trim().toLowerCase() === "local" ? "local" : "remote";
}

function normalizeStereo3dDepthStrength(value) {
  let number = Number(String(value ?? "").replace("%", ""));
  if (!Number.isFinite(number)) number = 72;
  if (number <= 2) number *= 100;
  number = Math.max(0, Math.min(200, number));
  return String(Math.round(number));
}

function normalizeStereo3dTemporalSmoothing(value) {
  let number = Number(String(value ?? "").replace("%", ""));
  if (!Number.isFinite(number)) number = 55;
  if (number <= 1) number *= 100;
  number = Math.max(0, Math.min(92, number));
  return String(Math.round(number));
}

function normalizeStereo3dProcessor(value) {
  const processor = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  const aliases = {
    "": "ffmpeg-shift",
    "0": "ffmpeg-shift",
    "false": "ffmpeg-shift",
    shift: "ffmpeg-shift",
    ffmpeg: "ffmpeg-shift",
    "ffmpeg-shift": "ffmpeg-shift",
    "depth-anything-small": "depth-anything-v2-small",
    "da-v2-small": "depth-anything-v2-small",
    "depth-anything-v2-small": "depth-anything-v2-small",
    "depth-anything-base": "depth-anything-v2-base",
    "da-v2-base": "depth-anything-v2-base",
    "depth-anything-v2-base": "depth-anything-v2-base",
    coreml: "coreml-depth-anything-v2-small",
    "coreml-small": "coreml-depth-anything-v2-small",
    "apple-coreml": "coreml-depth-anything-v2-small",
    "coreml-depth-anything-v2-small": "coreml-depth-anything-v2-small",
    midas: "midas-small-onnx",
    "midas-small": "midas-small-onnx",
    "midas-small-onnx": "midas-small-onnx",
    fastdepth: "fastdepth-mobilenet-onnx",
    "fastdepth-mobilenet": "fastdepth-mobilenet-onnx",
    "fastdepth-mobilenet-onnx": "fastdepth-mobilenet-onnx",
    "depth-anything-v2-tiny": "depth-anything-v2-tiny-onnx",
    "depth-anything-v2-tiny-onnx": "depth-anything-v2-tiny-onnx",
    "depth-anything-v2-small-onnx": "depth-anything-v2-small-onnx",
    webgpu: "webgpu-depth-anything-v2-small",
    "webgpu-small": "webgpu-depth-anything-v2-small",
    "webgpu-depth-anything-v2-small": "webgpu-depth-anything-v2-small",
  };
  return aliases[processor] || "ffmpeg-shift";
}

function isLocalStereo3dProcessor(value) {
  return [
    "midas-small-onnx",
    "fastdepth-mobilenet-onnx",
    "depth-anything-v2-tiny-onnx",
    "depth-anything-v2-small-onnx",
    "webgpu-depth-anything-v2-small",
  ].includes(normalizeStereo3dProcessor(value));
}

function defaultStereo3dProcessorForPipeline(pipeline) {
  return normalizeStereo3dPipeline(pipeline) === "local" ? "midas-small-onnx" : "depth-anything-v2-small";
}

function stereo3dProcessorOptions() {
  return [
    {
      id: "ffmpeg-shift",
      label: "Fast ffmpeg shift",
      bestUse: "Near real-time fallback",
      m3Practicality: "Excellent",
      pipeline: "remote",
    },
    {
      id: "depth-anything-v2-small",
      label: "Depth Anything V2 Small",
      bestUse: "Quality with lower latency",
      m3Practicality: "Good",
      pipeline: "remote",
    },
    {
      id: "depth-anything-v2-base",
      label: "Depth Anything V2 Base",
      bestUse: "Quality/cache-ahead",
      m3Practicality: "Moderate",
      pipeline: "remote",
    },
    {
      id: "coreml-depth-anything-v2-small",
      label: "Apple Core ML Depth Anything V2 Small",
      bestUse: "Apple Silicon local inference",
      m3Practicality: "Excellent",
      pipeline: "remote",
    },
    {
      id: "midas-small-onnx",
      label: "Local MiDaS Small ONNX",
      bestUse: "Browser real-time depth",
      m3Practicality: "Quest/iPhone friendly",
      pipeline: "local",
      browserOnly: true,
    },
    {
      id: "fastdepth-mobilenet-onnx",
      label: "Local FastDepth MobileNet ONNX",
      bestUse: "Lowest-latency local depth",
      m3Practicality: "Good when model is installed",
      pipeline: "local",
      browserOnly: true,
    },
    {
      id: "depth-anything-v2-tiny-onnx",
      label: "Local Depth Anything V2 Tiny ONNX",
      bestUse: "Better depth if device allows",
      m3Practicality: "Experimental",
      pipeline: "local",
      browserOnly: true,
    },
    {
      id: "depth-anything-v2-small-onnx",
      label: "Local Depth Anything V2 Small ONNX",
      bestUse: "Higher quality local depth",
      m3Practicality: "High-end browser only",
      pipeline: "local",
      browserOnly: true,
    },
    {
      id: "webgpu-depth-anything-v2-small",
      label: "Legacy local WebGPU Depth Anything",
      bestUse: "Viewer-side XR depth",
      m3Practicality: "Compatibility alias",
      pipeline: "local",
      browserOnly: true,
    },
  ];
}

function xrSourceLayoutFromProfile(profile = {}) {
  if (profile.localStereoProcessor) return null;
  return ["half-sbs", "full-sbs"].includes(profile.videoLayout) ? profile.videoLayout : null;
}

function mediaInfoSpatialAudioReady(mediaInfo) {
  if (!mediaInfoSpatialAudioCandidate(mediaInfo)) return false;
  const codec = codecName(mediaInfo?.audioCodec || mediaInfo?.defaultAudio?.codec_name);
  return Boolean(mediaInfo?.audioPlayable) && ["aac", "opus", "flac", "alac"].includes(codec);
}

function canCapabilitiesPlayProfile(capabilities, profile) {
  if (!profile || profile.universal || profile.sourceKind === "stable-mp4") return true;
  if (profile.sourceKind === "hls-live" || String(profile.containerType || "").includes("mpegurl")) {
    return Boolean(capabilities?.containers?.hls);
  }
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

function seekVideoTo(video, targetTime) {
  if (!video) return;
  const target = Math.max(0, Number(targetTime || 0));
  const apply = () => {
    try {
      const duration = Number.isFinite(video.duration) ? video.duration : null;
      video.currentTime = duration ? Math.min(target, Math.max(0, duration - 0.05)) : target;
    } catch (error) {
      // Some browsers reject seeks before metadata is ready; retry when it is.
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
    manifestLoadingTimeOut: 60000,
    levelLoadingTimeOut: 60000,
    fragLoadingTimeOut: 180000,
    maxBufferLength: 60,
    maxMaxBufferLength: 120,
    backBufferLength: 30,
    maxBufferHole: 0.75,
    appendErrorMaxRetry: 20,
    manifestLoadingMaxRetry: 6,
    manifestLoadingRetryDelay: 1000,
    manifestLoadingMaxRetryTimeout: 15000,
    levelLoadingMaxRetry: 6,
    levelLoadingRetryDelay: 1000,
    levelLoadingMaxRetryTimeout: 15000,
    fragLoadingMaxRetry: 12,
    fragLoadingRetryDelay: 1000,
    fragLoadingMaxRetryTimeout: 30000,
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

async function pipeFetchToMediaSource({ mediaSource, mimeType, signal, mediaElement, openStream, onBytes, onEnded, onError }) {
  try {
    const stream = await openStream();
    if (!stream) throw new Error("Linear Stable MP4 stream is unavailable.");
    const reader = stream.getReader();
    const sourceBuffer = await addMediaSourceBuffer(mediaSource, mimeType, signal);
    let bytesRead = 0;
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      await appendSourceBuffer(sourceBuffer, exactArrayBuffer(value), signal, mediaElement);
      bytesRead += value.byteLength;
      if (onBytes) onBytes(bytesRead);
    }
    if (!signal?.aborted && mediaSource.readyState === "open" && !sourceBuffer.updating) {
      try {
        mediaSource.endOfStream();
      } catch {
        // Some browsers close the media source themselves after final append.
      }
    }
    if (!signal?.aborted && onEnded) onEnded();
  } catch (error) {
    if (!signal?.aborted && onError) onError(error);
  }
}

function addMediaSourceBuffer(mediaSource, mimeType, signal) {
  return new Promise((resolve, reject) => {
    const create = () => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      try {
        resolve(mediaSource.addSourceBuffer(mimeType));
      } catch (error) {
        reject(error);
      }
    };
    if (mediaSource.readyState === "open") {
      create();
      return;
    }
    mediaSource.addEventListener("sourceopen", create, { once: true });
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
}

async function appendSourceBuffer(sourceBuffer, buffer, signal, mediaElement = null) {
  const chunk = exactArrayBuffer(buffer);
  while (!signal?.aborted) {
    await waitForMseAppendBudget(sourceBuffer, mediaElement, signal);
    try {
      await appendSourceBufferOnce(sourceBuffer, chunk, signal);
      return;
    } catch (error) {
      if (!isMseQuotaError(error)) throw error;
      const evicted = await evictMseBackBuffer(sourceBuffer, mediaElement, signal);
      if (!evicted) await sleep(500);
    }
  }
}

function appendSourceBufferOnce(sourceBuffer, buffer, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
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

async function waitForMseAppendBudget(sourceBuffer, mediaElement, signal) {
  while (!signal?.aborted && mediaElement && sourceBuffer?.buffered?.length) {
    const ahead = mseBufferedAhead(sourceBuffer, mediaElement.currentTime || 0);
    if (ahead <= MSE_MAX_BUFFER_AHEAD_SECONDS) return;
    await sleep(250);
  }
}

async function evictMseBackBuffer(sourceBuffer, mediaElement, signal) {
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
    signal?.addEventListener("abort", () => {
      cleanup();
      resolve(false);
    }, { once: true });
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
