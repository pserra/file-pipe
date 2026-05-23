const pendingRanges = new Map();
const sessionMetadata = new Map();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const message = event.data || {};
  if ((message.type === "bigscreen-metadata" || message.type === "watch-metadata") && message.sessionId && message.metadata) {
    sessionMetadata.set(mediaKey(message.type === "watch-metadata" ? "watch" : "bigscreen", message.sessionId), message.metadata);
    return;
  }

  const pending = pendingRanges.get(message.requestId);
  if (!pending) return;

  if (message.type === "range-error") {
    pending.controller.error(new Error(message.error || "Range request failed."));
    pendingRanges.delete(message.requestId);
    return;
  }

  if (message.type === "range-chunk" && message.bytes) {
    pending.controller.enqueue(new Uint8Array(message.bytes));
    return;
  }

  if (message.type === "range-done") {
    pending.controller.close();
    pendingRanges.delete(message.requestId);
  }
});

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

  const client = await getRequestClient(event);
  if (!client) {
    return new Response("Player page is not available.", { status: 409 });
  }

  const totalSize = Number(metadata.size || 0);
  const range = parseRange(event.request.headers.get("Range"), totalSize);
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
      pendingRanges.set(requestId, { controller, clientId: client.id });
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

function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader || !totalSize) {
    return {
      start: 0,
      end: totalSize ? totalSize - 1 : 0,
      partial: false,
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

async function waitForMetadata(kind, sessionId) {
  const key = mediaKey(kind, sessionId);
  if (sessionMetadata.has(key)) return sessionMetadata.get(key);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sleep(100);
    if (sessionMetadata.has(key)) return sessionMetadata.get(key);
  }
  return null;
}

async function getRequestClient(event) {
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) return client;
  }
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return clients.find((client) => client.url.includes("/bigscreen/") || client.url.includes("/watch/")) || clients[0] || null;
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
