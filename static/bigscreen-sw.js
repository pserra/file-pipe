const pendingRanges = new Map();
const sessionMetadata = new Map();
const prefetchTasks = new Map();
const MEDIA_CACHE_NAME = "file-pipe-media-cache-v1";
const MEDIA_CACHE_CHUNK_SIZE = 512 * 1024;
const MEDIA_CACHE_TTL_MS = 12 * 24 * 60 * 60 * 1000;
const MAX_CACHED_RANGE_ASSEMBLY_BYTES = 24 * 1024 * 1024;
const MAX_STREAM_CACHE_BYTES = 8 * 1024 * 1024;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  event.waitUntil(handleWorkerMessage(event));
});

async function handleWorkerMessage(event) {
  const message = event.data || {};
  if (message.type === "claim") {
    event.waitUntil?.(self.clients.claim());
    return;
  }
  if ((message.type === "bigscreen-metadata" || message.type === "watch-metadata") && message.sessionId && message.metadata) {
    sessionMetadata.set(mediaKey(message.type === "watch-metadata" ? "watch" : "bigscreen", message.sessionId), message.metadata);
    cleanupMediaCache().catch(() => {});
    return;
  }
  if (message.type === "prefetch-range" && message.sessionId) {
    await startRangePrefetch(event.source, message);
    return;
  }
  if (message.type === "prefetch-hls-segments" && message.sessionId) {
    await startHlsPrefetch(event.source, message);
    return;
  }

  const pending = pendingRanges.get(message.requestId);
  if (!pending) return;

  if (message.type === "range-error") {
    if (pending.mode === "prefetch") {
      pending.reject?.(new Error(message.error || "Range request failed."));
    } else {
      pending.controller.error(new Error(message.error || "Range request failed."));
    }
    pendingRanges.delete(message.requestId);
    return;
  }

  if (message.type === "range-chunk" && message.bytes) {
    const chunk = new Uint8Array(message.bytes);
    if (pending.mode === "prefetch") {
      pending.chunks.push(chunk);
      return;
    }
    pending.controller.enqueue(chunk);
    if (pending.cacheInfo && pending.cachedBytes + chunk.byteLength <= MAX_STREAM_CACHE_BYTES) {
      pending.cachedBytes += chunk.byteLength;
      pending.chunks.push(chunk.slice());
    } else {
      pending.cacheInfo = null;
      pending.chunks = [];
    }
    return;
  }

  if (message.type === "range-done") {
    if (pending.mode === "prefetch") {
      try {
        const bytes = concatUint8Arrays(pending.chunks);
        await storeCacheEntry(pending.cacheInfo, bytes);
        pending.resolve?.(bytes.byteLength);
      } catch (error) {
        pending.reject?.(error);
      }
      pendingRanges.delete(message.requestId);
      return;
    }
    pending.controller.close();
    if (pending.cacheInfo && pending.chunks.length) {
      const bytes = concatUint8Arrays(pending.chunks);
      storeCacheEntry(pending.cacheInfo, bytes).catch(() => {});
    }
    pendingRanges.delete(message.requestId);
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith("/bigscreen-media/") && !url.pathname.startsWith("/watch-media/")) return;
  event.respondWith(handleBigscreenMedia(event, url));
});

async function handleBigscreenMedia(event, url) {
  const pathParts = url.pathname.split("/");
  const kind = pathParts[1] === "watch-media" ? "watch" : "bigscreen";
  const sessionId = pathParts[2];
  const metadata = await waitForMetadata(kind, sessionId);
  if (!metadata) {
    return new Response("Media metadata is not ready.", { status: 503 });
  }

  const client = await getRequestClient(event, kind, sessionId);
  if (!client) {
    return new Response("Player page is not available.", { status: 409 });
  }

  if (kind === "watch" && isHlsMetadata(metadata)) {
    return handleWatchHlsMedia(event, url, client, sessionId, metadata);
  }

  if (kind === "watch" && isLinearProgressiveMetadata(metadata)) {
    return handleWatchLinearMedia(event, url, client, sessionId, metadata);
  }

  const totalSize = Number(metadata.size || 0);
  const range = parseRange(event.request.headers.get("Range"), totalSize, metadata);
  const cachedRange = await cachedRangeResponse(kind, metadata, range, metadata.type || "video/mp4");
  if (cachedRange) return cachedRange;

  const requestId = createRequestId();
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Type": metadata.type || "video/mp4",
  };

  if (range.partial) {
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${totalSize}`;
    headers["Content-Length"] = String(range.end - range.start + 1);
  } else if (totalSize) {
    headers["Content-Length"] = String(totalSize);
  }

  const stream = new ReadableStream({
    start(controller) {
      pendingRanges.set(requestId, {
        mode: "stream",
        controller,
        clientId: client.id,
        cacheInfo: range.partial ? rangeCacheInfo(kind, metadata, range.start, range.end, metadata.type || "video/mp4") : null,
        chunks: [],
        cachedBytes: 0,
      });
      client.postMessage({
        type: "range-request",
        requestId,
        sessionId,
        mediaKind: kind,
        start: range.start,
        end: range.end,
      });
    },
    cancel() {
      pendingRanges.delete(requestId);
      client.postMessage({ type: "range-cancel", requestId, sessionId, mediaKind: kind });
    },
  });

  event.request.signal?.addEventListener("abort", () => {
    pendingRanges.delete(requestId);
    client.postMessage({ type: "range-cancel", requestId, sessionId, mediaKind: kind });
  });

  return new Response(stream, {
    status: range.partial ? 206 : 200,
    headers,
  });
}

async function handleWatchHlsMedia(event, url, client, sessionId, metadata) {
  if (url.pathname.endsWith(".m3u8")) {
    return new Response(buildHlsPlaylist(metadata), {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/vnd.apple.mpegurl",
      },
    });
  }

  const segmentIndex = hlsSegmentIndex(url.pathname);
  if (segmentIndex < 0) {
    return new Response("Unknown HLS stream path.", { status: 404 });
  }
  const cachedSegment = await cachedHlsSegmentResponse(metadata, segmentIndex);
  if (cachedSegment) return cachedSegment;

  const requestId = createRequestId();
  const stream = new ReadableStream({
    start(controller) {
      pendingRanges.set(requestId, {
        mode: "stream",
        controller,
        clientId: client.id,
        cacheInfo: hlsCacheInfo(metadata, segmentIndex, "video/mp2t"),
        chunks: [],
        cachedBytes: 0,
      });
      client.postMessage({
        type: "hls-segment-request",
        requestId,
        sessionId,
        mediaKind: "watch",
        segmentIndex,
        videoProfile: hlsVideoProfile(metadata),
        stereoProcessor: hlsStereoProcessor(metadata),
      });
    },
    cancel() {
      pendingRanges.delete(requestId);
      client.postMessage({ type: "range-cancel", requestId, sessionId, mediaKind: "watch" });
    },
  });

  event.request.signal?.addEventListener("abort", () => {
    pendingRanges.delete(requestId);
    client.postMessage({ type: "range-cancel", requestId, sessionId, mediaKind: "watch" });
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "video/mp2t",
    },
  });
}

function handleWatchLinearMedia(event, url, client, sessionId, metadata) {
  const requestId = createRequestId();
  const stream = new ReadableStream({
    start(controller) {
      pendingRanges.set(requestId, { mode: "stream", controller, clientId: client.id, chunks: [], cachedBytes: 0 });
      client.postMessage({
        type: "range-request",
        requestId,
        sessionId,
        mediaKind: "watch",
        start: 0,
        end: null,
        linear: true,
      });
    },
    cancel() {
      pendingRanges.delete(requestId);
      client.postMessage({ type: "range-cancel", requestId, sessionId, mediaKind: "watch" });
    },
  });

  event.request.signal?.addEventListener("abort", () => {
    pendingRanges.delete(requestId);
    client.postMessage({ type: "range-cancel", requestId, sessionId, mediaKind: "watch" });
  });

  const headers = {
    "Cache-Control": "no-store",
    "Content-Type": metadata.type || "video/mp4",
  };
  const duration = Number(metadata.progressiveTranscode?.duration || metadata.mediaInfo?.duration || 0);
  if (duration > 0) headers["X-Content-Duration"] = duration.toFixed(3);

  return new Response(stream, {
    status: 200,
    headers,
  });
}

function startRangePrefetch(client, message) {
  if (!client?.postMessage) return;
  const kind = message.mediaKind === "bigscreen" ? "bigscreen" : "watch";
  const metadata = message.metadata || sessionMetadata.get(mediaKey(kind, message.sessionId)) || {};
  const totalSize = Number(metadata.size || message.size || 0);
  if (!totalSize) return;
  const key = prefetchKey(kind, message.sessionId, metadata);
  const previous = prefetchTasks.get(key);
  if (previous) previous.cancelled = true;
  const task = { cancelled: false };
  prefetchTasks.set(key, task);
  task.promise = runRangePrefetch(task, client, {
    kind,
    sessionId: message.sessionId,
    metadata,
    start: Math.max(0, Number(message.start || 0)),
    end: Math.min(totalSize - 1, Number(message.end ?? totalSize - 1)),
    chunkSize: MEDIA_CACHE_CHUNK_SIZE,
  }).finally(() => {
    if (prefetchTasks.get(key) === task) prefetchTasks.delete(key);
  });
  return task.promise;
}

async function runRangePrefetch(task, client, options) {
  const { kind, sessionId, metadata, start, end, chunkSize } = options;
  const totalBytes = Math.max(1, end - start + 1);
  let cachedBytes = 0;
  for (let offset = start; offset <= end && !task.cancelled; offset += chunkSize) {
    const chunkStart = alignChunkStart(offset, chunkSize);
    const chunkEnd = Math.min(chunkStart + chunkSize - 1, end);
    const info = rangeCacheInfo(kind, metadata, chunkStart, chunkEnd, metadata.type || "video/mp4");
    if (await cacheHas(info)) {
      cachedBytes += chunkEnd - chunkStart + 1;
      postPrefetchProgress(client, kind, sessionId, "range", cachedBytes, totalBytes);
      continue;
    }
    try {
      const received = await requestAndCache(client, {
        type: "range-request",
        sessionId,
        mediaKind: kind,
        start: chunkStart,
        end: chunkEnd,
        prefetch: true,
        sourceVersion: metadata.sourceVersion || 0,
      }, info);
      cachedBytes += received || (chunkEnd - chunkStart + 1);
      postPrefetchProgress(client, kind, sessionId, "range", cachedBytes, totalBytes);
    } catch (error) {
      postPrefetchError(client, kind, sessionId, error);
      if (isCacheQuotaError(error)) break;
      await sleep(1000);
    }
  }
  if (!task.cancelled) {
    client.postMessage({ type: "prefetch-complete", mediaKind: kind, sessionId, mode: "range" });
  }
}

function startHlsPrefetch(client, message) {
  if (!client?.postMessage) return;
  const metadata = message.metadata || sessionMetadata.get(mediaKey("watch", message.sessionId)) || {};
  const hls = metadata.hls || {};
  const duration = Math.max(0, Number(hls.duration || 0));
  const segmentDuration = Math.max(1, Number(hls.segmentDuration || 8));
  const segmentCount = Math.max(1, Number(hls.segmentCount || Math.ceil(duration / segmentDuration) || 1));
  const startIndex = Math.max(0, Number(message.startIndex || 0));
  const endIndex = Math.min(segmentCount - 1, Number(message.endIndex ?? segmentCount - 1));
  const key = prefetchKey("watch", message.sessionId, metadata);
  const previous = prefetchTasks.get(key);
  if (previous) previous.cancelled = true;
  const task = { cancelled: false };
  prefetchTasks.set(key, task);
  task.promise = runHlsPrefetch(task, client, {
    sessionId: message.sessionId,
    metadata,
    startIndex,
    endIndex,
  }).finally(() => {
    if (prefetchTasks.get(key) === task) prefetchTasks.delete(key);
  });
  return task.promise;
}

async function runHlsPrefetch(task, client, options) {
  const { sessionId, metadata, startIndex, endIndex } = options;
  const totalSegments = Math.max(1, endIndex - startIndex + 1);
  let cachedSegments = 0;
  for (let segmentIndex = startIndex; segmentIndex <= endIndex && !task.cancelled; segmentIndex += 1) {
    const info = hlsCacheInfo(metadata, segmentIndex, "video/mp2t");
    if (await cacheHas(info)) {
      cachedSegments += 1;
      postPrefetchProgress(client, "watch", sessionId, "hls", cachedSegments, totalSegments);
      continue;
    }
    try {
      await requestAndCache(client, {
        type: "hls-segment-request",
        sessionId,
        mediaKind: "watch",
        segmentIndex,
        prefetch: true,
        sourceVersion: metadata.sourceVersion || 0,
        videoProfile: hlsVideoProfile(metadata),
        stereoProcessor: hlsStereoProcessor(metadata),
      }, info);
      cachedSegments += 1;
      postPrefetchProgress(client, "watch", sessionId, "hls", cachedSegments, totalSegments);
    } catch (error) {
      postPrefetchError(client, "watch", sessionId, error);
      if (isCacheQuotaError(error)) break;
      await sleep(1000);
    }
  }
  if (!task.cancelled) {
    client.postMessage({ type: "prefetch-complete", mediaKind: "watch", sessionId, mode: "hls" });
  }
}

function requestAndCache(client, requestMessage, cacheInfo) {
  const requestId = createRequestId();
  return new Promise((resolve, reject) => {
    pendingRanges.set(requestId, {
      mode: "prefetch",
      chunks: [],
      cacheInfo,
      resolve,
      reject,
    });
    client.postMessage({ ...requestMessage, requestId });
  });
}

function postPrefetchProgress(client, kind, sessionId, mode, cached, total) {
  client.postMessage({
    type: "prefetch-progress",
    mediaKind: kind,
    sessionId,
    mode,
    cached,
    total,
    percent: total ? Math.min(100, Math.round((cached / total) * 100)) : 0,
  });
}

function postPrefetchError(client, kind, sessionId, error) {
  client.postMessage({
    type: "prefetch-error",
    mediaKind: kind,
    sessionId,
    error: error?.message || "Media prefetch failed.",
  });
}

function buildHlsPlaylist(metadata) {
  const hls = metadata.hls || {};
  const duration = Math.max(0, Number(hls.duration || 0));
  const segmentDuration = Math.max(1, Number(hls.segmentDuration || 8));
  const segmentCount = Math.max(1, Number(hls.segmentCount || Math.ceil(duration / segmentDuration) || 1));
  const sourceVersion = metadata.sourceVersion ? encodeURIComponent(String(metadata.sourceVersion)) : "";
  const segmentQuery = sourceVersion ? `?v=${sourceVersion}` : "";
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${Math.ceil(segmentDuration)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  for (let index = 0; index < segmentCount; index += 1) {
    const startTime = index * segmentDuration;
    const segmentLength = duration > 0
      ? Math.max(0.1, Math.min(segmentDuration, duration - startTime))
      : segmentDuration;
    if (index > 0) lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXTINF:${segmentLength.toFixed(3)},`);
    lines.push(`segments/${index}.ts${segmentQuery}`);
  }
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

function hlsSegmentIndex(pathname) {
  const match = pathname.match(/\/segments\/(\d+)\.ts$/);
  return match ? Number(match[1]) : -1;
}

function isHlsMetadata(metadata) {
  return metadata?.streamMode === "hls"
    || metadata?.playbackProfile?.sourceKind === "hls-live"
    || String(metadata?.type || "").toLowerCase().includes("mpegurl");
}

function hlsVideoProfile(metadata = {}) {
  const profile = String(metadata.videoProfile || metadata.playbackProfile?.videoProfile || "").toLowerCase();
  if (["full-sbs", "fsbs", "3d-full", "full-3d", "3d-full-sbs", "stereo-full-sbs"].includes(profile)) return "3d-full-sbs";
  return ["3d", "3d-sbs", "sbs", "half-sbs", "stereo-sbs"].includes(profile) ? "3d-sbs" : "2d";
}

function hlsStereoProcessor(metadata = {}) {
  return String(metadata.stereoProcessor || metadata.playbackProfile?.stereoProcessor || "");
}

function isLinearProgressiveMetadata(metadata) {
  const progress = metadata?.progressiveTranscode || metadata?.availableModes?.range?.progressiveTranscode;
  return metadata?.streamMode === "range" && progress && !progress.complete;
}

function parseRange(rangeHeader, totalSize, metadata = {}) {
  if (!totalSize) {
    return {
      start: 0,
      end: 0,
      partial: false,
    };
  }
  if (!rangeHeader) {
    const availableBytes = Number(metadata.progressiveTranscode?.availableBytes || 0);
    const bootstrapBytes = availableBytes > 0
      ? Math.min(Math.max(availableBytes, 256 * 1024), 2 * 1024 * 1024)
      : 2 * 1024 * 1024;
    return {
      start: 0,
      end: Math.min(totalSize - 1, bootstrapBytes - 1),
      partial: true,
    };
  }

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return {
      start: 0,
      end: totalSize - 1,
      partial: false,
    };
  }

  let start;
  let end;
  if (!match[1] && match[2]) {
    const suffixLength = Number(match[2]);
    start = Math.max(totalSize - suffixLength, 0);
    end = totalSize - 1;
  } else {
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Number(match[2]) : totalSize - 1;
  }
  start = Math.max(0, Math.min(start, totalSize - 1));
  end = Math.max(start, Math.min(end, totalSize - 1));
  return { start, end, partial: true };
}

async function cachedHlsSegmentResponse(metadata, segmentIndex) {
  const info = hlsCacheInfo(metadata, segmentIndex, "video/mp2t");
  const cached = await cachedResponse(info);
  if (!cached) return null;
  return new Response(await cached.arrayBuffer(), {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": info.contentType,
      "X-File-Pipe-Cache": "hit",
    },
  });
}

async function cachedRangeResponse(kind, metadata, range, contentType) {
  if (!range.partial) return null;
  const totalSize = Number(metadata.size || 0);
  const requestedBytes = range.end - range.start + 1;
  if (!totalSize || requestedBytes <= 0 || requestedBytes > MAX_CACHED_RANGE_ASSEMBLY_BYTES) return null;

  const chunkSize = MEDIA_CACHE_CHUNK_SIZE;
  const firstChunkStart = alignChunkStart(range.start, chunkSize);
  const chunks = [];
  for (let chunkStart = firstChunkStart; chunkStart <= range.end; chunkStart += chunkSize) {
    const chunkEnd = Math.min(chunkStart + chunkSize - 1, totalSize - 1);
    const info = rangeCacheInfo(kind, metadata, chunkStart, chunkEnd, contentType);
    const cached = await cachedResponse(info);
    if (!cached) return null;
    chunks.push(new Uint8Array(await cached.arrayBuffer()));
  }

  const combined = concatUint8Arrays(chunks);
  const offset = range.start - firstChunkStart;
  const body = combined.slice(offset, offset + requestedBytes);
  return new Response(body, {
    status: 206,
    headers: {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(body.byteLength),
      "Content-Range": `bytes ${range.start}-${range.end}/${totalSize}`,
      "Content-Type": contentType,
      "X-File-Pipe-Cache": "hit",
    },
  });
}

async function cachedResponse(info) {
  if (!self.caches || !info?.url) return null;
  const cache = await caches.open(MEDIA_CACHE_NAME);
  const response = await cache.match(info.url);
  if (!response) return null;
  const cachedAt = Number(response.headers.get("X-File-Pipe-Cached-At") || 0);
  if (cachedAt && Date.now() - cachedAt > MEDIA_CACHE_TTL_MS) {
    await cache.delete(info.url);
    return null;
  }
  return response;
}

async function cacheHas(info) {
  return Boolean(await cachedResponse(info));
}

async function storeCacheEntry(info, bytes) {
  if (!self.caches || !info?.url || !bytes?.byteLength) return;
  if (info.kind === "range" && info.end > info.start) {
    if (info.start % MEDIA_CACHE_CHUNK_SIZE !== 0) return;
    await storeRangeCacheChunks(info, new Uint8Array(bytes));
    return;
  }
  const cache = await caches.open(MEDIA_CACHE_NAME);
  await cache.put(info.url, new Response(exactArrayBuffer(bytes), {
    status: 200,
    headers: {
      "Cache-Control": `max-age=${Math.floor(MEDIA_CACHE_TTL_MS / 1000)}`,
      "Content-Length": String(bytes.byteLength),
      "Content-Type": info.contentType || "application/octet-stream",
      "X-File-Pipe-Cached-At": String(Date.now()),
    },
  }));
}

async function storeRangeCacheChunks(info, bytes) {
  const cache = await caches.open(MEDIA_CACHE_NAME);
  let byteOffset = 0;
  for (let chunkStart = info.start; chunkStart <= info.end && byteOffset < bytes.byteLength; chunkStart += MEDIA_CACHE_CHUNK_SIZE) {
    const chunkEnd = Math.min(chunkStart + MEDIA_CACHE_CHUNK_SIZE - 1, info.end);
    const expectedLength = chunkEnd - chunkStart + 1;
    const chunkBytes = bytes.slice(byteOffset, byteOffset + expectedLength);
    byteOffset += chunkBytes.byteLength;
    if (chunkBytes.byteLength !== expectedLength) break;
    const chunkInfo = rangeCacheInfo(info.mediaKind, info.metadata, chunkStart, chunkEnd, info.contentType);
    await cache.put(chunkInfo.url, new Response(exactArrayBuffer(chunkBytes), {
      status: 200,
      headers: {
        "Cache-Control": `max-age=${Math.floor(MEDIA_CACHE_TTL_MS / 1000)}`,
        "Content-Length": String(chunkBytes.byteLength),
        "Content-Type": info.contentType || "application/octet-stream",
        "X-File-Pipe-Cached-At": String(Date.now()),
      },
    }));
  }
}

async function cleanupMediaCache() {
  if (!self.caches) return;
  const cache = await caches.open(MEDIA_CACHE_NAME);
  const requests = await cache.keys();
  const now = Date.now();
  await Promise.all(requests.map(async (request) => {
    const response = await cache.match(request);
    const cachedAt = Number(response?.headers.get("X-File-Pipe-Cached-At") || 0);
    if (cachedAt && now - cachedAt > MEDIA_CACHE_TTL_MS) {
      await cache.delete(request);
    }
  }));
}

function rangeCacheInfo(kind, metadata, start, end, contentType) {
  return {
    kind: "range",
    mediaKind: kind,
    metadata,
    start,
    end,
    url: `https://file-pipe-cache.local/${kind}/${mediaIdentity(metadata)}/v${cacheVersion(metadata)}/range/${start}-${end}`,
    contentType,
  };
}

function hlsCacheInfo(metadata, segmentIndex, contentType) {
  return {
    kind: "hls",
    url: `https://file-pipe-cache.local/watch/${mediaIdentity(metadata)}/v${cacheVersion(metadata)}/hls/${segmentIndex}`,
    contentType,
  };
}

function mediaIdentity(metadata = {}) {
  const identity = metadata.md5
    || metadata.originalMd5
    || metadata.contentKey
    || metadata.cacheKey
    || `${metadata.name || "media"}-${metadata.size || 0}-${metadata.sourceVersion || 0}`;
  return encodeURIComponent(String(identity));
}

function cacheVersion(metadata = {}) {
  return encodeURIComponent(String(metadata.sourceVersion || metadata.sharedAt || 0));
}

function prefetchKey(kind, sessionId, metadata) {
  return `${kind}:${sessionId}:${mediaIdentity(metadata)}:${cacheVersion(metadata)}`;
}

function alignChunkStart(offset, chunkSize = MEDIA_CACHE_CHUNK_SIZE) {
  return Math.floor(Math.max(0, Number(offset || 0)) / chunkSize) * chunkSize;
}

function concatUint8Arrays(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const combined = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return combined;
}

function exactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}

function isCacheQuotaError(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || "").toLowerCase();
  return name === "QuotaExceededError" || message.includes("quota");
}

async function waitForMetadata(kind, sessionId) {
  const key = mediaKey(kind, sessionId);
  if (sessionMetadata.has(key)) return sessionMetadata.get(key);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(100);
    if (sessionMetadata.has(key)) return sessionMetadata.get(key);
  }
  return null;
}

async function getRequestClient(event, kind = "", sessionId = "") {
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) return client;
  }
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const expectedPath = kind && sessionId ? `/${kind}/${sessionId}` : "";
  if (expectedPath) {
    const matched = clients.find((client) => {
      const pathname = new URL(client.url).pathname;
      return pathname === expectedPath || (kind === "watch" && pathname === `/watch-audio/${sessionId}`);
    });
    if (matched) return matched;
  }
  return clients.find((client) => client.url.includes("/bigscreen/") || client.url.includes("/watch/") || client.url.includes("/watch-audio/")) || clients[0] || null;
}

function mediaKey(kind, sessionId) {
  return `${kind}:${sessionId}`;
}

function createRequestId() {
  if (self.crypto?.randomUUID) return self.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
