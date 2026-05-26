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
const PAUSE_SYNC_SEEK_THRESHOLD_SECONDS = 0.04;

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

function isHlsPlaybackMetadata(metadata) {
  return metadata?.streamMode === "hls"
    || metadata?.playbackProfile?.sourceKind === "hls-live"
    || String(metadata?.type || "").toLowerCase().includes("mpegurl");
}

function serviceWorkerSetupMessage(error) {
  const message = error?.message || String(error);
  if (message.toLowerCase().includes("certificate")) {
    return `${message} Trust the File Pipe local HTTPS certificate on this device, or serve File Pipe with a publicly trusted HTTPS certificate. Browsers will not install service workers over an untrusted certificate.`;
  }
  return message;
}

function stereo3dModeDescription(mode = {}) {
  if (mode.localStereoProcessor || mode.playbackProfile?.localStereoProcessor) {
    return "Experimental browser WebGPU depth for XR/headsets; the normal video remains 2D";
  }
  const layout = mode.targetVideoLayout || mode.videoLayout || mode.playbackProfile?.targetVideoLayout || mode.playbackProfile?.videoLayout;
  const scale = mode.resolutionScale || mode.hls?.resolutionScale || mode.playbackProfile?.resolutionScale || "";
  const scaleLabel = scale && scale !== "1" ? ` at ${scale}x` : "";
  return layout === "full-sbs" ? `Generated Full SBS stream${scaleLabel} for XR/headsets` : `Generated Half SBS stream${scaleLabel} for XR/headsets`;
}

function xrSourceLayoutFromProfile(profile = {}) {
  if (profile.localStereoProcessor) return null;
  return ["half-sbs", "full-sbs"].includes(profile.videoLayout) ? profile.videoLayout : null;
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
