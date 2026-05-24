import argparse
import base64
import hashlib
import html
import json
import math
import mimetypes
import os
import secrets
import shutil
import socket
import subprocess
import threading
import time
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin

import requests
from flask import Flask, Response, jsonify, make_response, request, stream_with_context
from werkzeug.security import check_password_hash, generate_password_hash

from local_tls import ensure_local_certificate


SSDP_ADDR = ("239.255.255.250", 1900)
CONTENT_DIRECTORY_PREFIX = "urn:schemas-upnp-org:service:ContentDirectory:"


@dataclass
class ContentDirectory:
    control_url: str
    service_type: str


@dataclass
class DlnaServer:
    id: str
    usn: str
    location: str
    friendly_name: str
    manufacturer: str
    model_name: str
    content_directory: ContentDirectory


@dataclass
class ReadAheadEntry:
    signature: Tuple[int, int]
    start: int
    data: bytes
    last_access: float

    @property
    def end(self) -> int:
        return self.start + len(self.data)


@dataclass
class ReadAheadRequestState:
    last_end: Optional[int] = None
    last_seen: float = 0.0


class ReadAheadFileCache:
    def __init__(
        self,
        window_bytes: int,
        max_bytes: int,
        min_trigger_bytes: int,
        sequential_gap_bytes: int,
    ):
        self.window_bytes = max(0, window_bytes)
        self.max_bytes = max(0, max_bytes)
        self.min_trigger_bytes = max(0, min_trigger_bytes)
        self.sequential_gap_bytes = max(0, sequential_gap_bytes)
        self.entries: Dict[str, ReadAheadEntry] = {}
        self.inflight: Dict[str, Tuple[Tuple[int, int], int]] = {}
        self.request_state: Dict[str, ReadAheadRequestState] = {}
        self.lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.window_bytes > 0 and self.max_bytes > 0

    def cache_key(self, path: Path) -> str:
        return str(path.resolve())

    def signature(self, path: Path, file_size: Optional[int] = None) -> Tuple[int, int]:
        stat = path.stat()
        return stat.st_mtime_ns, file_size if file_size is not None else stat.st_size

    def read(self, key: str, signature: Tuple[int, int], start: int, length: int) -> bytes:
        if not self.enabled or length <= 0:
            return b""
        with self.lock:
            entry = self.entries.get(key)
            if not entry or entry.signature != signature:
                return b""
            if start < entry.start or start >= entry.end:
                return b""
            offset = start - entry.start
            entry.last_access = time.monotonic()
            return entry.data[offset : offset + length]

    def should_prefetch(self, key: str, start: int, end: int, content_length: int, ranged: bool) -> bool:
        if not self.enabled or not ranged or content_length <= 0:
            return False
        now = time.monotonic()
        with self.lock:
            state = self.request_state.setdefault(key, ReadAheadRequestState())
            previous_end = state.last_end
            state.last_end = end
            state.last_seen = now

        starts_stream = start == 0 and content_length >= self.min_trigger_bytes
        follows_previous = (
            previous_end is not None
            and start <= previous_end + 1 + self.sequential_gap_bytes
            and end >= previous_end
        )
        return starts_stream or follows_previous

    def prefetch(self, path: Path, key: str, signature: Tuple[int, int], start: int, file_size: int) -> None:
        if not self.enabled or start >= file_size:
            return
        start = max(0, start)
        length = min(self.window_bytes, file_size - start, self.max_bytes)
        if length <= 0:
            return

        with self.lock:
            existing = self.entries.get(key)
            if existing and existing.signature == signature and start >= existing.start and start < existing.end:
                return
            inflight = self.inflight.get(key)
            if inflight and inflight == (signature, start):
                return
            self.inflight[key] = (signature, start)

        thread = threading.Thread(
            target=self._prefetch_worker,
            args=(path, key, signature, start, length),
            daemon=True,
            name="file-pipe-read-ahead",
        )
        thread.start()

    def stats(self) -> Dict[str, object]:
        with self.lock:
            cached_bytes = sum(len(entry.data) for entry in self.entries.values())
            return {
                "enabled": self.enabled,
                "windowBytes": self.window_bytes,
                "maxBytes": self.max_bytes,
                "cachedBytes": cached_bytes,
                "entryCount": len(self.entries),
                "inflightCount": len(self.inflight),
            }

    def _prefetch_worker(self, path: Path, key: str, signature: Tuple[int, int], start: int, length: int) -> None:
        try:
            with path.open("rb") as file:
                file.seek(start)
                data = file.read(length)
        except OSError:
            data = b""

        with self.lock:
            if self.inflight.get(key) != (signature, start):
                return
            self.inflight.pop(key, None)
            if not data:
                return
            try:
                current_signature = self.signature(path)
            except OSError:
                return
            if current_signature != signature:
                return
            self.entries[key] = ReadAheadEntry(
                signature=signature,
                start=start,
                data=data,
                last_access=time.monotonic(),
            )
            self._evict_locked()

    def _evict_locked(self) -> None:
        total = sum(len(entry.data) for entry in self.entries.values())
        while total > self.max_bytes and self.entries:
            evict_key, evict_entry = min(self.entries.items(), key=lambda item: item[1].last_access)
            total -= len(evict_entry.data)
            self.entries.pop(evict_key, None)


SERVER_CACHE: Dict[str, DlnaServer] = {}
RESOURCE_CACHE: Dict[str, object] = {}
RESOURCE_METADATA_CACHE: Dict[str, Dict[str, object]] = {}
CHECKSUM_CACHE: Dict[str, Dict[str, object]] = {}
MEDIA_INFO_CACHE: Dict[str, Dict[str, object]] = {}
LOCAL_DIRECTORY_FILE = Path(os.environ.get("FILE_PIPE_DIRECTORIES_FILE", "instance/served_directories.json"))
PLAYABLE_BROWSER_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis", "flac", "alac"}
PLAYABLE_BROWSER_VIDEO_CODECS = {"h264"}
READ_AHEAD_BYTES = int(os.environ.get("FILE_PIPE_READ_AHEAD_BYTES", str(25 * 1024 * 1024)))
READ_AHEAD_MAX_BYTES = int(os.environ.get("FILE_PIPE_READ_AHEAD_MAX_BYTES", str(128 * 1024 * 1024)))
READ_AHEAD_MIN_TRIGGER_BYTES = int(os.environ.get("FILE_PIPE_READ_AHEAD_MIN_TRIGGER_BYTES", str(512 * 1024)))
READ_AHEAD_SEQUENTIAL_GAP_BYTES = int(os.environ.get("FILE_PIPE_READ_AHEAD_SEQUENTIAL_GAP_BYTES", str(1024 * 1024)))
TRANSCODE_CACHE_VERSION = "v5"
TRANSCODE_CACHE_DIR = Path(os.environ.get("FILE_PIPE_TRANSCODE_CACHE_DIR", "instance/transcodes"))
HLS_SEGMENT_SECONDS = int(os.environ.get("FILE_PIPE_HLS_SEGMENT_SECONDS", "6"))
HLS_PREFETCH_SEGMENTS = int(os.environ.get("FILE_PIPE_HLS_PREFETCH_SEGMENTS", "2"))
HLS_ACCURATE_SEEK_WINDOW_SECONDS = float(os.environ.get("FILE_PIPE_HLS_ACCURATE_SEEK_WINDOW_SECONDS", "8"))
HLS_SEGMENT_CACHE_VERSION = "hls-v2"
PROGRESSIVE_TRANSCODE_START_PERCENT = int(os.environ.get("FILE_PIPE_PROGRESSIVE_TRANSCODE_START_PERCENT", "3"))
PROGRESSIVE_TRANSCODE_MIN_BYTES = int(os.environ.get("FILE_PIPE_PROGRESSIVE_TRANSCODE_MIN_BYTES", str(2 * 1024 * 1024)))
TRANSCODE_LOCKS: Dict[str, threading.Lock] = {}
TRANSCODE_PROGRESS: Dict[str, Dict[str, object]] = {}
HLS_PREFETCHING: set[str] = set()
HLS_PREFETCH_LOCK = threading.Lock()
MEDIA_TOOL_DIRS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    r"C:\ffmpeg\bin",
    r"C:\Program Files\ffmpeg\bin",
    r"C:\Program Files (x86)\ffmpeg\bin",
]
READ_AHEAD_CACHE = ReadAheadFileCache(
    READ_AHEAD_BYTES,
    READ_AHEAD_MAX_BYTES,
    READ_AHEAD_MIN_TRIGGER_BYTES,
    READ_AHEAD_SEQUENTIAL_GAP_BYTES,
)


@dataclass
class ConnectorSecurity:
    password_hash: Optional[str] = None
    allow_insecure_password: bool = False
    session_ttl_seconds: int = 12 * 60 * 60


SESSION_TOKENS: Dict[str, float] = {}


def add_cors_headers(response):
    if request.path.startswith("/admin"):
        return response
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET,POST,PATCH,DELETE,OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Range"
    response.headers["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges"
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


def token_from_request() -> str:
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return header.removeprefix("Bearer ").strip()
    return request.args.get("access_token", "").strip()


def is_valid_token(token: str) -> bool:
    if not token:
        return False
    expires_at = SESSION_TOKENS.get(token)
    if not expires_at:
        return False
    if expires_at < time.time():
        SESSION_TOKENS.pop(token, None)
        return False
    return True


def auth_state(security: ConnectorSecurity) -> Dict[str, bool]:
    return {
        "authRequired": bool(security.password_hash),
        "authenticated": not security.password_hash or is_valid_token(token_from_request()),
        "secure": request.is_secure,
    }


def require_auth(security: ConnectorSecurity):
    if not security.password_hash:
        return None
    if is_valid_token(token_from_request()):
        return None
    return jsonify({"error": "Connector password required.", **auth_state(security)}), 401


def parse_ssdp_response(raw: bytes) -> Dict[str, str]:
    lines = raw.decode("utf-8", errors="ignore").splitlines()
    headers = {}
    for line in lines[1:]:
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    return headers


def encode_object_id(relative_path: str) -> str:
    if not relative_path or relative_path == ".":
        return "0"
    raw = relative_path.replace(os.sep, "/").encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_object_id(object_id: str) -> str:
    if object_id in {"", "0"}:
        return "."
    padded = object_id + "=" * (-len(object_id) % 4)
    try:
        relative = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        raise ValueError("Invalid folder id.")
    normalized = Path(relative)
    if normalized.is_absolute() or ".." in normalized.parts:
        raise ValueError("Invalid folder path.")
    return relative or "."


def safe_child_path(root: Path, object_id: str) -> Path:
    relative = decode_object_id(object_id)
    candidate = (root / relative).resolve()
    root_resolved = root.resolve()
    if candidate != root_resolved and root_resolved not in candidate.parents:
        raise ValueError("Folder is outside the served directory.")
    return candidate


def load_local_directories() -> List[Dict[str, object]]:
    try:
        payload = json.loads(LOCAL_DIRECTORY_FILE.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    directories = payload if isinstance(payload, list) else payload.get("directories", [])
    if not isinstance(directories, list):
        return []
    cleaned = []
    for entry in directories:
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("path") or "").strip()
        if not path:
            continue
        directory_id = entry.get("id") or local_directory_id(path)
        cleaned.append(
            {
                "id": directory_id,
                "path": path,
                "label": str(entry.get("label") or Path(path).name or path),
                "enabled": bool(entry.get("enabled", True)),
                "createdAt": entry.get("createdAt") or int(time.time()),
            }
        )
    return cleaned


def save_local_directories(directories: List[Dict[str, object]]):
    LOCAL_DIRECTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    LOCAL_DIRECTORY_FILE.write_text(json.dumps({"directories": directories}, indent=2), "utf-8")


def local_directory_id(path: str) -> str:
    resolved = str(Path(path).expanduser().resolve())
    return f"local-{uuid.uuid5(uuid.NAMESPACE_URL, f'file-pipe-local-directory:{resolved}')}"


def serialize_local_directory(entry: Dict[str, object], include_path: bool = True) -> Dict[str, object]:
    path = Path(str(entry.get("path", ""))).expanduser()
    exists = path.exists() and path.is_dir()
    payload = {
        "id": str(entry["id"]),
        "label": str(entry.get("label") or path.name or path),
        "enabled": bool(entry.get("enabled", True)),
        "exists": exists,
        "createdAt": entry.get("createdAt"),
    }
    if include_path:
        payload["path"] = str(path)
    return payload


def local_directory_sources() -> List[Dict[str, object]]:
    sources = []
    for entry in load_local_directories():
        path = Path(str(entry["path"])).expanduser()
        if not entry.get("enabled", True) or not path.exists() or not path.is_dir():
            continue
        sources.append(
            {
                "id": str(entry["id"]),
                "friendlyName": str(entry.get("label") or path.name or path),
                "manufacturer": "File Pipe Connector",
                "modelName": "Local folder",
                "location": str(path),
                "sourceType": "local_directory",
            }
        )
    return sources


def get_local_directory_entry(source_id: str) -> Optional[Dict[str, object]]:
    for entry in load_local_directories():
        if entry.get("id") == source_id:
            return entry
    return None


def register_local_resource(path: Path) -> str:
    resolved = path.resolve()
    resource_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"file://{resolved}"))
    content_type = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
    size = resolved.stat().st_size
    RESOURCE_CACHE[resource_id] = {
        "kind": "file",
        "path": str(resolved),
        "contentType": content_type,
    }
    RESOURCE_METADATA_CACHE[resource_id] = {
        "protocolInfo": f"http-get:*:{content_type}:*",
        "size": str(size),
    }
    return resource_id


def browse_local_directory(source_id: str, object_id: str) -> Dict[str, object]:
    entry = get_local_directory_entry(source_id)
    if not entry or not entry.get("enabled", True):
        raise FileNotFoundError("Unknown local folder source.")
    root = Path(str(entry["path"])).expanduser().resolve()
    folder = safe_child_path(root, object_id)
    if not folder.exists() or not folder.is_dir():
        raise FileNotFoundError("Folder does not exist.")

    items = []
    children = sorted(folder.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
    for child in children:
        if child.name.startswith("."):
            continue
        try:
            stat = child.stat()
        except OSError:
            continue
        relative = child.resolve().relative_to(root).as_posix()
        if child.is_dir():
            child_count = "0"
            try:
                child_count = str(sum(1 for grandchild in child.iterdir() if not grandchild.name.startswith(".")))
            except OSError:
                pass
            items.append(
                {
                    "id": encode_object_id(relative),
                    "parentId": object_id,
                    "type": "container",
                    "title": child.name,
                    "class": "object.container.storageFolder",
                    "childCount": child_count,
                    "resources": [],
                }
            )
            continue
        if not child.is_file():
            continue
        content_type = mimetypes.guess_type(child.name)[0] or "application/octet-stream"
        resource_id = register_local_resource(child)
        items.append(
            {
                "id": encode_object_id(relative),
                "parentId": object_id,
                "type": "item",
                "title": child.name,
                "class": f"object.item.{content_type.split('/', 1)[0]}Item",
                "childCount": "0",
                "resources": [
                    {
                        "id": resource_id,
                        "url": f"/resources/{resource_id}",
                        "proxyPath": f"/resources/{resource_id}",
                        "protocolInfo": f"http-get:*:{content_type}:*",
                        "size": str(stat.st_size),
                        "duration": "",
                    }
                ],
            }
        )

    if folder == root:
        path_label = "Root"
    else:
        path_label = folder.relative_to(root).as_posix()
    return {
        "objectId": object_id,
        "pathLabel": path_label,
        "sourceType": "local_directory",
        "items": items,
    }


def discover_locations(timeout: float = 3.0) -> List[Dict[str, str]]:
    message = "\r\n".join(
        [
            "M-SEARCH * HTTP/1.1",
            "HOST: 239.255.255.250:1900",
            'MAN: "ssdp:discover"',
            "MX: 2",
            "ST: urn:schemas-upnp-org:device:MediaServer:1",
            "",
            "",
        ]
    ).encode("ascii")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.settimeout(0.35)
    sock.sendto(message, SSDP_ADDR)

    started = time.monotonic()
    responses = {}
    try:
        while time.monotonic() - started < timeout:
            try:
                data, _ = sock.recvfrom(65507)
            except socket.timeout:
                continue
            headers = parse_ssdp_response(data)
            location = headers.get("location")
            if location:
                responses[location] = headers
    finally:
        sock.close()

    return list(responses.values())


def ns_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def child_text(node: ET.Element, name: str) -> str:
    for child in node:
        if ns_name(child.tag) == name:
            return child.text or ""
    return ""


def parse_float(value: object) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_int(value: object) -> Optional[int]:
    try:
        if value is None or value == "":
            return None
        return int(float(value))
    except (TypeError, ValueError):
        return None


def find_first(node: ET.Element, name: str) -> Optional[ET.Element]:
    for element in node.iter():
        if ns_name(element.tag) == name:
            return element
    return None


def find_content_directory(root: ET.Element, base_url: str) -> Optional[ContentDirectory]:
    for service in root.iter():
        if ns_name(service.tag) != "service":
            continue
        service_type = child_text(service, "serviceType")
        if not service_type.startswith(CONTENT_DIRECTORY_PREFIX):
            continue
        control_url = child_text(service, "controlURL")
        if control_url:
            return ContentDirectory(
                control_url=urljoin(base_url, control_url),
                service_type=service_type,
            )
    return None


def load_server(headers: Dict[str, str]) -> Optional[DlnaServer]:
    location = headers.get("location")
    usn = headers.get("usn", location or str(uuid.uuid4()))
    if not location:
        return None

    response = requests.get(location, timeout=5)
    response.raise_for_status()
    root = ET.fromstring(response.content)
    device = find_first(root, "device")
    if device is None:
        return None

    content_directory = find_content_directory(root, location)
    if content_directory is None:
        return None

    server_id = str(uuid.uuid5(uuid.NAMESPACE_URL, usn))
    return DlnaServer(
        id=server_id,
        usn=usn,
        location=location,
        friendly_name=child_text(device, "friendlyName") or location,
        manufacturer=child_text(device, "manufacturer"),
        model_name=child_text(device, "modelName"),
        content_directory=content_directory,
    )


def discover_servers() -> List[DlnaServer]:
    servers = []
    for headers in discover_locations():
        try:
            server = load_server(headers)
        except (requests.RequestException, ET.ParseError):
            continue
        if server is None:
            continue
        SERVER_CACHE[server.id] = server
        servers.append(server)
    return servers


def soap_browse(server: DlnaServer, object_id: str) -> ET.Element:
    envelope = f"""<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Browse xmlns:u="{server.content_directory.service_type}">
      <ObjectID>{html.escape(object_id)}</ObjectID>
      <BrowseFlag>BrowseDirectChildren</BrowseFlag>
      <Filter>*</Filter>
      <StartingIndex>0</StartingIndex>
      <RequestedCount>0</RequestedCount>
      <SortCriteria></SortCriteria>
    </u:Browse>
  </s:Body>
</s:Envelope>"""
    response = requests.post(
        server.content_directory.control_url,
        data=envelope.encode("utf-8"),
        headers={
            "Content-Type": 'text/xml; charset="utf-8"',
            "SOAPACTION": f'"{server.content_directory.service_type}#Browse"',
        },
        timeout=15,
    )
    response.raise_for_status()
    root = ET.fromstring(response.content)
    result_node = find_first(root, "Result")
    if result_node is None or not result_node.text:
        return ET.Element("DIDL-Lite")
    return ET.fromstring(result_node.text.encode("utf-8"))


def parse_didl(didl: ET.Element) -> List[Dict[str, object]]:
    items = []
    for node in list(didl):
        kind = ns_name(node.tag)
        if kind not in {"container", "item"}:
            continue

        resources = []
        for child in node:
            if ns_name(child.tag) != "res":
                continue
            url = child.text or ""
            resource_id = str(uuid.uuid5(uuid.NAMESPACE_URL, url)) if url else ""
            if url:
                RESOURCE_CACHE[resource_id] = url
                RESOURCE_METADATA_CACHE[resource_id] = {
                    "protocolInfo": child.attrib.get("protocolInfo", ""),
                    "size": child.attrib.get("size"),
                    "duration": child.attrib.get("duration"),
                }
            resources.append(
                {
                    "id": resource_id,
                    "url": url,
                    "proxyPath": f"/resources/{resource_id}" if resource_id else "",
                    "protocolInfo": child.attrib.get("protocolInfo", ""),
                    "size": child.attrib.get("size"),
                    "duration": child.attrib.get("duration"),
                }
            )

        items.append(
            {
                "id": node.attrib.get("id", ""),
                "parentId": node.attrib.get("parentID", ""),
                "type": kind,
                "title": child_text(node, "title") or "(untitled)",
                "class": child_text(node, "class"),
                "childCount": node.attrib.get("childCount"),
                "resources": resources,
            }
        )
    return items


def serialize_server(server: DlnaServer) -> Dict[str, str]:
    return {
        "id": server.id,
        "friendlyName": server.friendly_name,
        "manufacturer": server.manufacturer,
        "modelName": server.model_name,
        "location": server.location,
        "sourceType": "dlna",
    }


def connector_admin_page() -> str:
    return """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>File Pipe Connector</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css" rel="stylesheet">
    <script defer src="https://unpkg.com/alpinejs@3.x.x/dist/cdn.min.js"></script>
    <style>
      body { background: #f6f8fb; color: #1f2937; }
      .connector-shell { margin: 0 auto; max-width: 1120px; padding: 24px; }
      .brand-mark { align-items: center; background: #145c9e; border-radius: 8px; color: #fff; display: inline-flex; height: 42px; justify-content: center; width: 42px; }
      .card { border-color: #d8dee8; border-radius: 8px; box-shadow: 0 8px 24px rgba(16, 24, 40, 0.06); }
      .path-text { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: .85rem; word-break: break-all; }
    </style>
  </head>
  <body x-data="connectorAdmin()" x-init="init()">
    <main class="connector-shell">
      <header class="d-flex flex-column flex-lg-row gap-3 align-items-lg-center justify-content-between mb-4">
        <div class="d-flex gap-3 align-items-center">
          <span class="brand-mark"><i class="bi bi-bezier2"></i></span>
          <div>
            <div class="text-uppercase text-secondary fw-semibold small">Local media bridge</div>
            <h1 class="h3 mb-0">File Pipe Connector</h1>
          </div>
        </div>
        <div class="d-flex gap-2 align-items-center">
          <span class="badge" :class="health.ok ? 'text-bg-success' : 'text-bg-secondary'" x-text="health.ok ? 'Online' : 'Checking'"></span>
          <span class="badge" :class="health.secure ? 'text-bg-primary' : 'text-bg-warning'" x-text="health.secure ? 'HTTPS' : 'HTTP'"></span>
        </div>
      </header>

      <template x-if="error">
        <div class="alert alert-danger d-flex justify-content-between gap-3">
          <span x-text="error"></span>
          <button class="btn-close" type="button" @click="error = ''"></button>
        </div>
      </template>

      <div class="row g-4">
        <section class="col-12 col-lg-5">
          <div class="card">
            <div class="card-header fw-semibold">Connection</div>
            <div class="card-body">
              <div class="list-group list-group-flush mb-3">
                <div class="list-group-item d-flex justify-content-between px-0">
                  <span>Authentication</span>
                  <span class="badge" :class="health.authRequired ? 'text-bg-warning' : 'text-bg-success'" x-text="health.authRequired ? 'Password required' : 'Open'"></span>
                </div>
                <div class="list-group-item d-flex justify-content-between px-0">
                  <span>Session</span>
                  <span class="badge" :class="authenticated ? 'text-bg-success' : 'text-bg-secondary'" x-text="authenticated ? 'Unlocked' : 'Locked'"></span>
                </div>
              </div>

              <form x-show="health.authRequired && !authenticated" @submit.prevent="login()">
                <label class="form-label">Connector password</label>
                <div class="input-group">
                  <input class="form-control" type="password" x-model="password" autocomplete="current-password">
                  <button class="btn btn-primary" type="submit">Unlock</button>
                </div>
                <div class="form-text text-danger" x-show="!health.secure">Password login requires HTTPS unless insecure testing is enabled.</div>
              </form>

              <button class="btn btn-outline-danger" type="button" x-show="authenticated && health.authRequired" @click="forget()">Forget session</button>
            </div>
          </div>
        </section>

        <section class="col-12 col-lg-7">
          <div class="card">
            <div class="card-header d-flex align-items-center justify-content-between">
              <span class="fw-semibold">Served directories</span>
              <button class="btn btn-sm btn-outline-primary" type="button" @click="loadDirectories()">
                <i class="bi bi-arrow-clockwise"></i> Refresh
              </button>
            </div>
            <div class="card-body">
              <form class="row g-2 mb-4" @submit.prevent="addDirectory()">
                <div class="col-12 col-md-4">
                  <label class="form-label">Name</label>
                  <input class="form-control" type="text" x-model="newLabel" placeholder="Movies">
                </div>
                <div class="col-12 col-md-8">
                  <label class="form-label">Folder path</label>
                  <div class="input-group">
                    <input class="form-control" type="text" x-model="newPath" placeholder="/Users/name/Videos">
                    <button class="btn btn-primary" type="submit">Add</button>
                  </div>
                </div>
              </form>

              <template x-if="directories.length === 0">
                <div class="text-center text-secondary border rounded p-4">
                  <i class="bi bi-folder-plus display-6 d-block mb-2"></i>
                  <span>No local folders are served yet.</span>
                </div>
              </template>

              <div class="list-group">
                <template x-for="directory in directories" :key="directory.id">
                  <div class="list-group-item">
                    <div class="d-flex flex-column flex-md-row gap-2 justify-content-between">
                      <div class="min-w-0">
                        <div class="fw-semibold" x-text="directory.label"></div>
                        <div class="path-text text-secondary" x-text="directory.path"></div>
                        <div class="mt-1">
                          <span class="badge" :class="directory.enabled ? 'text-bg-success' : 'text-bg-secondary'" x-text="directory.enabled ? 'Available in File Pipe' : 'Disabled'"></span>
                          <span class="badge" :class="directory.exists ? 'text-bg-primary' : 'text-bg-danger'" x-text="directory.exists ? 'Found' : 'Missing'"></span>
                        </div>
                      </div>
                      <div class="btn-group align-self-start">
                        <button class="btn btn-sm" :class="directory.enabled ? 'btn-outline-secondary' : 'btn-outline-primary'" type="button" @click="toggleDirectory(directory)">
                          <i class="bi" :class="directory.enabled ? 'bi-pause-circle' : 'bi-play-circle'"></i>
                        </button>
                        <button class="btn btn-sm btn-outline-danger" type="button" @click="removeDirectory(directory)">
                          <i class="bi bi-trash"></i>
                        </button>
                      </div>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>

    <script>
      function connectorAdmin() {
        return {
          health: {},
          directories: [],
          password: "",
          token: localStorage.getItem("filePipeConnectorAdminToken") || "",
          authenticated: false,
          newLabel: "",
          newPath: "",
          error: "",
          headers(extra = {}) {
            const headers = { ...extra };
            if (this.token) headers.Authorization = `Bearer ${this.token}`;
            return headers;
          },
          async request(path, options = {}) {
            const response = await fetch(path, { ...options, headers: this.headers(options.headers || {}) });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.error || `Request failed with ${response.status}`);
            return payload;
          },
          async init() {
            await this.checkHealth();
            if (this.authenticated) await this.loadDirectories();
          },
          async checkHealth() {
            this.health = await this.request("/health");
            this.authenticated = !this.health.authRequired || this.health.authenticated;
          },
          async login() {
            try {
              const payload = await this.request("/auth/session", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ password: this.password }),
              });
              this.token = payload.token || "";
              localStorage.setItem("filePipeConnectorAdminToken", this.token);
              this.password = "";
              await this.checkHealth();
              await this.loadDirectories();
            } catch (error) {
              this.error = error.message;
            }
          },
          forget() {
            this.token = "";
            this.authenticated = false;
            localStorage.removeItem("filePipeConnectorAdminToken");
          },
          async loadDirectories() {
            try {
              const payload = await this.request("/directories");
              this.directories = payload.directories || [];
            } catch (error) {
              this.error = error.message;
            }
          },
          async addDirectory() {
            try {
              await this.request("/directories", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: this.newPath, label: this.newLabel }),
              });
              this.newPath = "";
              this.newLabel = "";
              await this.loadDirectories();
            } catch (error) {
              this.error = error.message;
            }
          },
          async toggleDirectory(directory) {
            try {
              await this.request(`/directories/${directory.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ enabled: !directory.enabled }),
              });
              await this.loadDirectories();
            } catch (error) {
              this.error = error.message;
            }
          },
          async removeDirectory(directory) {
            try {
              await this.request(`/directories/${directory.id}`, { method: "DELETE" });
              await this.loadDirectories();
            } catch (error) {
              this.error = error.message;
            }
          },
        };
      }
    </script>
  </body>
</html>"""


def find_media_tool(name: str) -> Optional[str]:
    found = shutil.which(name)
    if found:
        return found
    executable = f"{name}.exe" if os.name == "nt" else name
    for directory in MEDIA_TOOL_DIRS:
        candidate = Path(directory) / executable
        if candidate.exists():
            return str(candidate)
    return None


def ffmpeg_tools_available() -> Tuple[bool, bool]:
    return bool(find_media_tool("ffprobe")), bool(find_media_tool("ffmpeg"))


def media_info_cache_key(url: str) -> str:
    path = Path(url)
    if path.exists():
        stat = path.stat()
        return f"file:{path.resolve()}:{stat.st_mtime_ns}:{stat.st_size}"
    return f"url:{url}"


def cached_probe_media(url: str) -> Dict[str, object]:
    key = media_info_cache_key(url)
    cached = MEDIA_INFO_CACHE.get(key)
    if cached:
        return cached
    media_info = probe_media(url)
    MEDIA_INFO_CACHE[key] = media_info
    return media_info


def probe_media(url: str) -> Dict[str, object]:
    ffprobe_path = find_media_tool("ffprobe")
    ffmpeg_available = bool(find_media_tool("ffmpeg"))
    if not ffprobe_path:
        return {
            "ok": False,
            "error": "ffprobe is not installed or is not on PATH.",
            "ffprobeAvailable": False,
            "ffmpegAvailable": ffmpeg_available,
        }

    command = [
        ffprobe_path,
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,codec_name,profile,pix_fmt,width,height,level,disposition:stream_tags=language,title:format=duration,size",
        "-of",
        "json",
        url,
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=25,
        check=True,
    )
    payload = json.loads(completed.stdout or "{}")
    format_payload = payload.get("format") or {}
    streams = payload.get("streams") or []
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    default_audio = next(
        (
            stream
            for stream in audio_streams
            if (stream.get("disposition") or {}).get("default") == 1
        ),
        audio_streams[0] if audio_streams else None,
    )
    default_video = video_streams[0] if video_streams else None
    audio_codec = (default_audio or {}).get("codec_name") or ""
    video_codec = (default_video or {}).get("codec_name") or ""
    audio_playable = not default_audio or audio_codec in PLAYABLE_BROWSER_AUDIO_CODECS
    video_playable = is_browser_video_compatible(default_video)
    should_transcode = bool((default_audio and not audio_playable) or (default_video and not video_playable))

    return {
        "ok": True,
        "ffprobeAvailable": True,
        "ffmpegAvailable": ffmpeg_available,
        "defaultAudio": default_audio,
        "defaultVideo": default_video,
        "audioCodec": audio_codec,
        "videoCodec": video_codec,
        "audioPlayable": audio_playable,
        "videoPlayable": video_playable,
        "shouldTranscode": should_transcode,
        "duration": parse_float(format_payload.get("duration")),
        "size": parse_int(format_payload.get("size")),
        "playableAudioCodecs": sorted(PLAYABLE_BROWSER_AUDIO_CODECS),
        "playableVideoCodecs": sorted(PLAYABLE_BROWSER_VIDEO_CODECS),
    }


def is_browser_video_compatible(video_stream: Optional[Dict[str, object]]) -> bool:
    if not video_stream:
        return True
    codec = (video_stream.get("codec_name") or "").lower()
    pix_fmt = (video_stream.get("pix_fmt") or "").lower()
    profile = (video_stream.get("profile") or "").lower()
    level = video_stream.get("level")
    if codec not in PLAYABLE_BROWSER_VIDEO_CODECS:
        return False
    if pix_fmt and pix_fmt != "yuv420p":
        return False
    if "10" in profile:
        return False
    if profile and profile not in {"baseline", "constrained baseline", "main"}:
        return False
    if isinstance(level, int) and level > 41:
        return False
    return True


def build_transcode_command(
    url: str,
    probe: Dict[str, object],
    output_path: str,
    ffmpeg_path: str = "ffmpeg",
    force_video_transcode: bool = True,
    fragmented: bool = False,
) -> List[str]:
    default_audio = probe.get("defaultAudio") or {}
    default_video = probe.get("defaultVideo") or {}
    audio_index = default_audio.get("index")
    video_index = default_video.get("index")
    video_codec = (default_video.get("codec_name") or "").lower()
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        url,
    ]
    if video_index is not None:
        command.extend(["-map", f"0:{video_index}"])
    if audio_index is not None:
        command.extend(["-map", f"0:{audio_index}"])
    if video_index is not None:
        if is_browser_video_compatible(default_video) and not force_video_transcode:
            command.extend(["-c:v", "copy"])
        else:
            command.extend(
                [
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-pix_fmt",
                    "yuv420p",
                    "-profile:v",
                    "main",
                    "-level",
                    "4.1",
                    "-vf",
                    "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
                ]
            )
    if audio_index is not None:
        command.extend(["-c:a", "aac", "-ac", "2", "-b:a", "192k"])
    duration = parse_float(probe.get("duration"))
    if fragmented and duration and duration > 0:
        command.extend(["-t", f"{duration:.3f}"])
    movflags = "+frag_keyframe+empty_moov+default_base_moof" if fragmented else "+faststart"
    command.extend(["-movflags", movflags, "-f", "mp4", output_path])
    return command


def default_stream_indexes(probe: Dict[str, object]) -> Tuple[Optional[int], Optional[int]]:
    default_audio = probe.get("defaultAudio") or {}
    default_video = probe.get("defaultVideo") or {}
    return default_video.get("index"), default_audio.get("index")


def build_hls_segment_command(
    url: str,
    probe: Dict[str, object],
    output_path: str,
    start_time: float,
    duration: float,
    ffmpeg_path: str = "ffmpeg",
) -> List[str]:
    video_index, audio_index = default_stream_indexes(probe)
    input_seek = max(0.0, float(start_time) - max(0.0, HLS_ACCURATE_SEEK_WINDOW_SECONDS))
    accurate_seek = max(0.0, float(start_time) - input_seek)
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
    ]
    if input_seek > 0:
        command.extend(["-ss", f"{input_seek:.3f}"])
    command.extend(["-i", url])
    if accurate_seek > 0:
        command.extend(["-ss", f"{accurate_seek:.3f}"])
    command.extend(["-t", f"{duration:.3f}"])
    if video_index is not None:
        command.extend(["-map", f"0:{video_index}"])
    if audio_index is not None:
        command.extend(["-map", f"0:{audio_index}"])
    command.extend(["-sn", "-dn"])
    if video_index is not None:
        command.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-profile:v",
                "main",
                "-level",
                "4.1",
                "-vf",
                "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
            ]
        )
    if audio_index is not None:
        command.extend(["-c:a", "aac", "-ac", "2", "-b:a", "192k"])
    command.extend(
        [
            "-avoid_negative_ts",
            "make_zero",
            "-muxdelay",
            "0",
            "-muxpreload",
            "0",
            "-f",
            "mpegts",
            output_path,
        ]
    )
    return command


def transcode_cache_path(resource_id: str, url: str) -> Path:
    url_hash = hashlib.sha256(f"{TRANSCODE_CACHE_VERSION}:{url}".encode("utf-8")).hexdigest()[:16]
    return TRANSCODE_CACHE_DIR / f"{resource_id}-{url_hash}.mp4"


def transcode_part_path(resource_id: str, url: str) -> Path:
    return transcode_cache_path(resource_id, url).with_suffix(".part.mp4")


def transcoded_file_cached(resource_id: str, url: str) -> bool:
    path = transcode_cache_path(resource_id, url)
    return path.exists() and path.stat().st_size > 0


def hls_cache_dir(resource_id: str, url: str) -> Path:
    url_hash = hashlib.sha256(f"{TRANSCODE_CACHE_VERSION}:{HLS_SEGMENT_CACHE_VERSION}:{HLS_SEGMENT_SECONDS}:{url}".encode("utf-8")).hexdigest()[:16]
    return TRANSCODE_CACHE_DIR / f"{resource_id}-{url_hash}-hls"


def hls_segment_path(resource_id: str, url: str, segment_index: int) -> Path:
    return hls_cache_dir(resource_id, url) / f"segment-{segment_index:06d}.ts"


def hls_duration_info(media_info: Dict[str, object]) -> Dict[str, object]:
    duration = parse_float(media_info.get("duration"))
    if not duration or duration <= 0:
        raise RuntimeError("Cannot use segmented transcoding because ffprobe did not report a finite duration.")
    segment_count = max(1, int(math.ceil(duration / HLS_SEGMENT_SECONDS)))
    return {
        "duration": duration,
        "segmentDuration": HLS_SEGMENT_SECONDS,
        "segmentCount": segment_count,
    }


def hls_playlist(resource_id: str, media_info: Dict[str, object], access_token: str = "") -> str:
    info = hls_duration_info(media_info)
    duration = float(info["duration"])
    segment_duration = int(info["segmentDuration"])
    segment_count = int(info["segmentCount"])
    token_query = f"?access_token={access_token}" if access_token else ""
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{segment_duration}",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-INDEPENDENT-SEGMENTS",
    ]
    for index in range(segment_count):
        start_time = index * segment_duration
        segment_length = max(0.1, min(segment_duration, duration - start_time))
        lines.append(f"#EXTINF:{segment_length:.3f},")
        lines.append(f"segments/{index}.ts{token_query}")
    lines.append("#EXT-X-ENDLIST")
    return "\n".join(lines) + "\n"


def ensure_hls_segment(resource_id: str, url: str, media_info: Dict[str, object], segment_index: int) -> Dict[str, object]:
    artifact = create_hls_segment(resource_id, url, media_info, segment_index)
    prefetch_hls_segments(resource_id, url, media_info, segment_index + 1)
    return artifact


def create_hls_segment(resource_id: str, url: str, media_info: Dict[str, object], segment_index: int) -> Dict[str, object]:
    ffmpeg_path = find_media_tool("ffmpeg")
    if not ffmpeg_path:
        raise RuntimeError("ffmpeg is not installed or is not on PATH.")
    info = hls_duration_info(media_info)
    segment_count = int(info["segmentCount"])
    if segment_index < 0 or segment_index >= segment_count:
        raise IndexError("Segment is outside the video duration.")
    duration = float(info["duration"])
    segment_duration = int(info["segmentDuration"])
    start_time = segment_index * segment_duration
    segment_length = max(0.1, min(segment_duration, duration - start_time))
    path = hls_segment_path(resource_id, url, segment_index)
    lock = lock_for_transcode(path)
    with lock:
        if not path.exists() or path.stat().st_size == 0:
            path.parent.mkdir(parents=True, exist_ok=True)
            temp_path = path.with_suffix(f".{os.getpid()}.part")
            if temp_path.exists():
                temp_path.unlink()
            command = build_hls_segment_command(url, media_info, str(temp_path), start_time, segment_length, ffmpeg_path)
            try:
                subprocess.run(command, capture_output=True, text=True, check=True)
                temp_path.replace(path)
            except subprocess.CalledProcessError as exc:
                if temp_path.exists():
                    temp_path.unlink()
                detail = (exc.stderr or exc.stdout or str(exc)).strip()
                raise RuntimeError(f"ffmpeg could not create HLS segment {segment_index}: {detail}") from exc
            except Exception:
                if temp_path.exists():
                    temp_path.unlink()
                raise
    stat = path.stat()
    return {
        "path": str(path),
        "size": stat.st_size,
        "contentType": "video/mp2t",
        "cached": True,
        "segmentIndex": segment_index,
        **info,
    }


def prefetch_hls_segments(resource_id: str, url: str, media_info: Dict[str, object], start_index: int) -> None:
    if HLS_PREFETCH_SEGMENTS <= 0:
        return
    try:
        segment_count = int(hls_duration_info(media_info)["segmentCount"])
    except RuntimeError:
        return
    for segment_index in range(start_index, min(segment_count, start_index + HLS_PREFETCH_SEGMENTS)):
        path = hls_segment_path(resource_id, url, segment_index)
        try:
            if path.exists() and path.stat().st_size > 0:
                continue
        except OSError:
            continue
        key = str(path)
        with HLS_PREFETCH_LOCK:
            if key in HLS_PREFETCHING:
                continue
            HLS_PREFETCHING.add(key)

        def worker(index=segment_index, prefetch_key=key) -> None:
            try:
                create_hls_segment(resource_id, url, media_info, index)
            except Exception:
                pass
            finally:
                with HLS_PREFETCH_LOCK:
                    HLS_PREFETCHING.discard(prefetch_key)

        threading.Thread(target=worker, daemon=True, name="file-pipe-hls-prefetch").start()


def lock_for_transcode(path: Path) -> threading.Lock:
    key = str(path)
    if key not in TRANSCODE_LOCKS:
        TRANSCODE_LOCKS[key] = threading.Lock()
    return TRANSCODE_LOCKS[key]


def update_transcode_progress(resource_id: str, **values) -> None:
    current = TRANSCODE_PROGRESS.get(resource_id, {})
    current.update(values)
    current["updatedAt"] = int(time.time())
    TRANSCODE_PROGRESS[resource_id] = current


def estimate_transcode_final_size(resource_id: str, fallback_size: Optional[int] = None) -> int:
    status = TRANSCODE_PROGRESS.get(resource_id, {})
    current_size = parse_int(status.get("size")) or 0
    estimated_size = parse_int(status.get("estimatedFinalSize")) or 0
    duration = parse_float(status.get("duration"))
    seconds = parse_float(status.get("seconds"))
    if duration and duration > 0 and seconds and seconds > 0 and current_size > 0:
        estimated_size = max(estimated_size, int(math.ceil(current_size * duration / seconds)))
    if fallback_size:
        estimated_size = max(estimated_size, int(fallback_size))
    return max(estimated_size, current_size)


def progressive_transcode_details(resource_id: str, fallback_size: Optional[int] = None) -> Dict[str, object]:
    status = TRANSCODE_PROGRESS.get(resource_id, {})
    estimated_size = estimate_transcode_final_size(resource_id, fallback_size)
    details = {
        "duration": parse_float(status.get("duration")),
        "estimatedFinalSize": estimated_size,
    }
    if status:
        details["progress"] = status
    return details


def transcode_artifact(resource_id: str, url: str) -> Optional[Dict[str, object]]:
    path = transcode_cache_path(resource_id, url)
    if path.exists() and path.stat().st_size > 0:
        stat = path.stat()
        return {
            "path": str(path),
            "size": stat.st_size,
            "contentType": "video/mp4",
            "cached": True,
            "complete": True,
        }
    part_path = transcode_part_path(resource_id, url)
    if part_path.exists() and part_path.stat().st_size > 0:
        stat = part_path.stat()
        return {
            "path": str(part_path),
            "size": stat.st_size,
            "contentType": "video/mp4",
            "cached": False,
            "complete": False,
        }
    return None


def run_transcode_command(command: List[str], temp_path: Path, resource_id: str, duration: Optional[float]) -> None:
    progress_command = [*command[:-1], "-progress", "pipe:1", "-nostats", command[-1]]
    process = subprocess.Popen(
        progress_command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    stderr_lines = []
    try:
        assert process.stdout is not None
        for raw_line in process.stdout:
            line = raw_line.strip()
            if not line or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key == "out_time_ms":
                try:
                    seconds = int(value) / 1_000_000
                except ValueError:
                    continue
                percent = 0
                if duration and duration > 0:
                    percent = max(0, min(99, int((seconds / duration) * 100)))
                size = temp_path.stat().st_size if temp_path.exists() else 0
                progress = {
                    "status": "running",
                    "seconds": seconds,
                    "percent": percent,
                    "size": size,
                }
                if duration and duration > 0 and seconds > 0 and size > 0:
                    progress["estimatedFinalSize"] = int(math.ceil(size * duration / seconds))
                update_transcode_progress(resource_id, **progress)
            elif key == "progress" and value == "end":
                update_transcode_progress(resource_id, status="finalizing", percent=99)
        assert process.stderr is not None
        stderr_text = process.stderr.read()
        if stderr_text:
            stderr_lines.append(stderr_text.strip())
        return_code = process.wait()
    except Exception:
        process.kill()
        raise
    if return_code != 0:
        detail = "\n".join(stderr_lines).strip() or f"ffmpeg exited with {return_code}"
        update_transcode_progress(resource_id, status="error", error=detail)
        if temp_path.exists():
            temp_path.unlink()
        raise RuntimeError(f"ffmpeg could not transcode this resource: {detail}")


def remux_fragmented_mp4_to_faststart(source_path: Path, output_path: Path, ffmpeg_path: str = "ffmpeg") -> None:
    temp_path = output_path.with_suffix(f".{os.getpid()}.final.mp4")
    if temp_path.exists():
        temp_path.unlink()
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source_path),
        "-map",
        "0",
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        "-f",
        "mp4",
        str(temp_path),
    ]
    try:
        subprocess.run(command, capture_output=True, text=True, check=True)
        temp_path.replace(output_path)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or str(exc)).strip()
        raise RuntimeError(f"ffmpeg could not finalize Stable MP4: {detail}") from exc
    finally:
        if temp_path.exists():
            temp_path.unlink()


def start_transcoded_file(resource_id: str, url: str, media_info: Dict[str, object]) -> Dict[str, object]:
    ffmpeg_path = find_media_tool("ffmpeg")
    if not ffmpeg_path:
        raise RuntimeError("ffmpeg is not installed or is not on PATH.")
    path = transcode_cache_path(resource_id, url)
    part_path = transcode_part_path(resource_id, url)
    cached = transcode_artifact(resource_id, url)
    if cached and cached.get("complete"):
        update_transcode_progress(resource_id, status="cached", percent=100, size=cached["size"])
        return cached
    status = TRANSCODE_PROGRESS.get(resource_id, {})
    if status.get("status") in {"running", "finalizing"}:
        artifact = transcode_artifact(resource_id, url)
        if artifact:
            return artifact
        return {
            "path": str(part_path),
            "size": 0,
            "contentType": "video/mp4",
            "cached": False,
            "complete": False,
        }

    TRANSCODE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    if part_path.exists():
        part_path.unlink()
    command = build_transcode_command(url, media_info, str(part_path), ffmpeg_path, fragmented=True)
    update_transcode_progress(
        resource_id,
        status="running",
        percent=0,
        seconds=0,
        duration=parse_float(media_info.get("duration")),
        size=0,
        estimatedFinalSize=parse_int(media_info.get("size")) or 0,
        error="",
        progressive=True,
    )

    def worker() -> None:
        lock = lock_for_transcode(path)
        with lock:
            try:
                run_transcode_command(command, part_path, resource_id, parse_float(media_info.get("duration")))
                update_transcode_progress(resource_id, status="finalizing", percent=99, size=part_path.stat().st_size)
                remux_fragmented_mp4_to_faststart(part_path, path, ffmpeg_path)
                if part_path.exists():
                    part_path.unlink()
                stat = path.stat()
                update_transcode_progress(resource_id, status="complete", percent=100, size=stat.st_size, progressive=False)
            except Exception:
                if part_path.exists():
                    part_path.unlink()

    threading.Thread(target=worker, daemon=True).start()
    return {
        "path": str(part_path),
        "size": 0,
        "contentType": "video/mp4",
        "cached": False,
        "complete": False,
    }


def wait_for_progressive_transcode(resource_id: str, url: str, timeout: float = 45.0) -> Dict[str, object]:
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        artifact = transcode_artifact(resource_id, url)
        status = TRANSCODE_PROGRESS.get(resource_id, {})
        if artifact and (
            artifact.get("complete")
            or artifact.get("size", 0) >= PROGRESSIVE_TRANSCODE_MIN_BYTES
            or int(status.get("percent") or 0) >= PROGRESSIVE_TRANSCODE_START_PERCENT
        ):
            return artifact
        if status.get("status") == "error":
            raise RuntimeError(str(status.get("error") or "ffmpeg could not transcode this resource."))
        time.sleep(0.25)
    raise RuntimeError("Timed out waiting for enough transcoded video to start playback.")


def ensure_transcoded_file(resource_id: str, url: str, media_info: Dict[str, object]) -> Dict[str, object]:
    ffmpeg_path = find_media_tool("ffmpeg")
    if not ffmpeg_path:
        raise RuntimeError("ffmpeg is not installed or is not on PATH.")
    path = transcode_cache_path(resource_id, url)
    lock = lock_for_transcode(path)
    with lock:
        if path.exists() and path.stat().st_size > 0:
            stat = path.stat()
            update_transcode_progress(resource_id, status="cached", percent=100, size=stat.st_size)
            return {
                "path": str(path),
                "size": stat.st_size,
                "contentType": "video/mp4",
                "cached": True,
            }

        if not path.exists() or path.stat().st_size == 0:
            TRANSCODE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            temp_path = transcode_part_path(resource_id, url)
            if temp_path.exists():
                temp_path.unlink()
            command = build_transcode_command(url, media_info, str(temp_path), ffmpeg_path, fragmented=False)
            update_transcode_progress(
                resource_id,
                status="running",
                percent=0,
                seconds=0,
                duration=parse_float(media_info.get("duration")),
                size=0,
                error="",
            )
            try:
                run_transcode_command(command, temp_path, resource_id, parse_float(media_info.get("duration")))
                temp_path.replace(path)
            except Exception:
                if temp_path.exists():
                    temp_path.unlink()
                raise

    stat = path.stat()
    result = {
        "path": str(path),
        "size": stat.st_size,
        "contentType": "video/mp4",
        "cached": True,
    }
    update_transcode_progress(resource_id, status="complete", percent=100, size=stat.st_size)
    return result


def checksum_cache_key(kind: str, value: str) -> str:
    return hashlib.sha256(f"{kind}:{value}".encode("utf-8")).hexdigest()


def checksum_file(path: Path) -> Dict[str, object]:
    stat = path.stat()
    cache_key = checksum_cache_key("file", f"{path.resolve()}:{stat.st_mtime_ns}:{stat.st_size}")
    cached = CHECKSUM_CACHE.get(cache_key)
    if cached:
        return cached
    md5 = hashlib.md5()
    with path.open("rb") as file:
        while True:
            chunk = file.read(1024 * 1024)
            if not chunk:
                break
            md5.update(chunk)
    result = {
        "ok": True,
        "md5": md5.hexdigest(),
        "size": stat.st_size,
        "cached": False,
    }
    CHECKSUM_CACHE[cache_key] = {**result, "cached": True}
    return result


def checksum_url(url: str, expected_size: Optional[object] = None) -> Dict[str, object]:
    cache_key = checksum_cache_key("url", f"{url}:{expected_size or ''}")
    cached = CHECKSUM_CACHE.get(cache_key)
    if cached:
        return cached
    md5 = hashlib.md5()
    total_bytes = 0
    with requests.get(url, stream=True, timeout=20) as response:
        response.raise_for_status()
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            if not chunk:
                continue
            md5.update(chunk)
            total_bytes += len(chunk)
    result = {
        "ok": True,
        "md5": md5.hexdigest(),
        "size": total_bytes,
        "cached": False,
    }
    CHECKSUM_CACHE[cache_key] = {**result, "cached": True}
    return result


def checksum_resource(resource_id: str) -> Optional[Dict[str, object]]:
    descriptor = resource_descriptor(resource_id)
    if not descriptor:
        return None
    if descriptor.get("kind") == "file":
        path = Path(str(descriptor["path"]))
        if not path.exists() or not path.is_file():
            raise FileNotFoundError("Local file is no longer available.")
        return checksum_file(path)
    metadata = RESOURCE_METADATA_CACHE.get(resource_id, {})
    return checksum_url(str(descriptor["url"]), metadata.get("size"))


def parse_range_header(range_header: str, file_size: int) -> Optional[Tuple[int, int]]:
    if not range_header or not range_header.startswith("bytes="):
        return None
    range_value = range_header.removeprefix("bytes=").split(",", 1)[0].strip()
    if "-" not in range_value:
        return None
    start_text, end_text = range_value.split("-", 1)
    if start_text == "":
        suffix_length = int(end_text) if end_text.isdigit() else 0
        if suffix_length <= 0:
            return None
        start = max(file_size - suffix_length, 0)
        end = file_size - 1
    else:
        if not start_text.isdigit():
            return None
        start = int(start_text)
        end = int(end_text) if end_text.isdigit() else file_size - 1
    if start >= file_size or end < start:
        return None
    return start, min(end, file_size - 1)


def serve_file_with_range(path: Path, content_type: str):
    file_size = path.stat().st_size
    requested_range = parse_range_header(request.headers.get("Range", ""), file_size)
    if request.headers.get("Range") and requested_range is None:
        return Response(
            "",
            status=416,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Range": f"bytes */{file_size}",
            },
            content_type=content_type,
        )

    start, end = requested_range or (0, file_size - 1)
    content_length = end - start + 1
    chunk_size = 1024 * 256
    read_ahead_key = READ_AHEAD_CACHE.cache_key(path)
    read_ahead_signature = READ_AHEAD_CACHE.signature(path, file_size)
    is_ranged_response = requested_range is not None

    def generate():
        position = start
        file = None
        try:
            remaining = content_length
            while remaining > 0:
                read_size = min(chunk_size, remaining)
                chunk = READ_AHEAD_CACHE.read(read_ahead_key, read_ahead_signature, position, read_size)
                if not chunk:
                    if file is None:
                        file = path.open("rb")
                    file.seek(position)
                    chunk = file.read(read_size)
                if not chunk:
                    break
                position += len(chunk)
                remaining -= len(chunk)
                yield chunk
        finally:
            if file is not None:
                file.close()
            if position > start:
                served_end = position - 1
                served_length = position - start
                if READ_AHEAD_CACHE.should_prefetch(
                    read_ahead_key,
                    start,
                    served_end,
                    served_length,
                    is_ranged_response,
                ):
                    READ_AHEAD_CACHE.prefetch(
                        path,
                        read_ahead_key,
                        read_ahead_signature,
                        served_end + 1,
                        file_size,
                    )

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(content_length),
    }
    status = 200
    if requested_range is not None:
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{file_size}"
    return Response(
        stream_with_context(generate()),
        status=status,
        headers=headers,
        content_type=content_type,
    )


def transcode_running(resource_id: str) -> bool:
    return TRANSCODE_PROGRESS.get(resource_id, {}).get("status") in {"running", "finalizing"}


def parse_open_range_header(range_header: str) -> Optional[Tuple[int, Optional[int]]]:
    if not range_header or not range_header.startswith("bytes="):
        return None
    range_value = range_header.removeprefix("bytes=").split(",", 1)[0].strip()
    if "-" not in range_value:
        return None
    start_text, end_text = range_value.split("-", 1)
    if not start_text.isdigit():
        return None
    start = int(start_text)
    end = int(end_text) if end_text.isdigit() else None
    if end is not None and end < start:
        return None
    return start, end


def serve_growing_file_with_range(
    path: Path,
    content_type: str,
    resource_id: str,
    total_size: Optional[int] = None,
    duration: Optional[float] = None,
):
    open_range = parse_open_range_header(request.headers.get("Range", ""))
    chunk_size = 1024 * 256
    total_size = int(total_size or 0)
    duration = parse_float(duration)

    def current_file_size() -> int:
        return path.stat().st_size if path.exists() else 0

    def content_range_total(current_size: int) -> str:
        if total_size > 0 and transcode_running(resource_id):
            return str(max(total_size, current_size))
        if current_size > 0:
            return str(current_size)
        if total_size > 0:
            return str(total_size)
        return "*"

    def range_not_ready_response(current_size: int, status: int = 503) -> Response:
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes */{content_range_total(current_size)}",
            "Cache-Control": "no-store",
            "X-Available-Bytes": str(current_size),
        }
        if duration and duration > 0:
            headers["X-Content-Duration"] = f"{duration:.3f}"
        if status == 503:
            headers["Retry-After"] = "1"
        return Response(
            "Requested transcode range is not ready yet." if status == 503 else "",
            status=status,
            headers=headers,
            content_type=content_type,
        )

    if open_range is None and request.headers.get("Range"):
        return Response("", status=416, headers={"Accept-Ranges": "bytes"}, content_type=content_type)

    synthetic_range = open_range is None and total_size > 0
    start = open_range[0] if open_range else 0
    requested_end = open_range[1] if open_range else None
    running = transcode_running(resource_id)
    if total_size > 0 and requested_end is not None and not running:
        requested_end = min(requested_end, total_size - 1)
    if total_size > 0 and start >= total_size and not running:
        current_size = current_file_size()
        return Response(
            "",
            status=416,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Range": f"bytes */{current_size or total_size}",
                "Cache-Control": "no-store",
            },
            content_type=content_type,
        )

    def wait_for_size(min_size: int, timeout: float = 30.0) -> bool:
        started = time.monotonic()
        while time.monotonic() - started < timeout:
            if current_file_size() >= min_size:
                return True
            if not transcode_running(resource_id):
                return current_file_size() >= min_size
            time.sleep(0.1)
        return False

    if not wait_for_size(start + 1):
        current_size = current_file_size()
        pending_known_range = total_size > 0 and start < total_size and transcode_running(resource_id)
        return range_not_ready_response(
            current_size,
            503 if pending_known_range or (total_size <= 0 and transcode_running(resource_id)) else 416,
        )

    if requested_end is None:
        requested_end = max(start, current_file_size() - 1)

    if requested_end is not None:
        if transcode_running(resource_id) and not wait_for_size(requested_end + 1):
            return range_not_ready_response(current_file_size(), 503)
        current_size = current_file_size()
        if requested_end >= current_size:
            if transcode_running(resource_id):
                return range_not_ready_response(current_size, 503)
            requested_end = current_size - 1
        if requested_end < start:
            return range_not_ready_response(current_size, 416)

    def generate():
        position = start
        with path.open("rb") as file:
            file.seek(start)
            while True:
                current_size = current_file_size()
                if requested_end is not None and position > requested_end:
                    break
                available_end = current_size - 1
                if requested_end is not None:
                    available_end = min(available_end, requested_end)
                available = available_end - position + 1
                if available > 0:
                    chunk = file.read(min(chunk_size, available))
                    if chunk:
                        position += len(chunk)
                        yield chunk
                        continue
                if not transcode_running(resource_id):
                    break
                time.sleep(0.1)

    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "X-Available-Bytes": str(path.stat().st_size if path.exists() else 0),
    }
    if duration and duration > 0:
        headers["X-Content-Duration"] = f"{duration:.3f}"
    status = 200
    if open_range is not None or synthetic_range:
        status = 206
        current_size = current_file_size()
        end = requested_end if requested_end is not None else max(start, current_size - 1)
        headers["Content-Range"] = f"bytes {start}-{end}/{content_range_total(current_size)}"
        if end >= start:
            headers["Content-Length"] = str(end - start + 1)
    return Response(stream_with_context(generate()), status=status, headers=headers, content_type=content_type)


def resource_descriptor(resource_id: str) -> Optional[Dict[str, object]]:
    value = RESOURCE_CACHE.get(resource_id)
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    return {"kind": "url", "url": str(value)}


def resource_probe_target(resource_id: str) -> Optional[str]:
    descriptor = resource_descriptor(resource_id)
    if not descriptor:
        return None
    if descriptor.get("kind") == "file":
        return str(descriptor.get("path"))
    return str(descriptor.get("url"))


def create_connector_app(security: Optional[ConnectorSecurity] = None):
    security = security or ConnectorSecurity()
    app = Flask(__name__)
    app.after_request(add_cors_headers)

    @app.route("/<path:_path>", methods=["OPTIONS"])
    @app.route("/", methods=["OPTIONS"])
    def options(_path=None):
        return add_cors_headers(make_response("", 204))

    @app.get("/")
    def connector_home():
        return connector_admin_page()

    @app.get("/health")
    def health():
        return jsonify(
            {
                "ok": True,
                "service": "file-pipe-local-connector",
                **auth_state(security),
            }
        )

    @app.get("/directories")
    def directories():
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        return jsonify({"directories": [serialize_local_directory(entry) for entry in load_local_directories()]})

    @app.post("/directories")
    def add_directory():
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        payload = request.get_json(silent=True) or {}
        raw_path = str(payload.get("path") or "").strip()
        if not raw_path:
            return jsonify({"error": "Folder path is required."}), 400
        path = Path(raw_path).expanduser().resolve()
        if not path.exists() or not path.is_dir():
            return jsonify({"error": "Folder path does not exist or is not a directory."}), 400
        directories = load_local_directories()
        directory_id = local_directory_id(str(path))
        if any(entry.get("id") == directory_id for entry in directories):
            return jsonify({"error": "This folder is already served."}), 409
        entry = {
            "id": directory_id,
            "path": str(path),
            "label": str(payload.get("label") or path.name or path),
            "enabled": True,
            "createdAt": int(time.time()),
        }
        directories.append(entry)
        save_local_directories(directories)
        return jsonify({"directory": serialize_local_directory(entry)}), 201

    @app.patch("/directories/<directory_id>")
    def update_directory(directory_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        payload = request.get_json(silent=True) or {}
        directories = load_local_directories()
        for entry in directories:
            if entry.get("id") != directory_id:
                continue
            if "label" in payload:
                entry["label"] = str(payload.get("label") or Path(str(entry["path"])).name or entry["path"])
            if "enabled" in payload:
                entry["enabled"] = bool(payload.get("enabled"))
            save_local_directories(directories)
            return jsonify({"directory": serialize_local_directory(entry)})
        return jsonify({"error": "Unknown served directory."}), 404

    @app.delete("/directories/<directory_id>")
    def delete_directory(directory_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        directories = load_local_directories()
        remaining = [entry for entry in directories if entry.get("id") != directory_id]
        if len(remaining) == len(directories):
            return jsonify({"error": "Unknown served directory."}), 404
        save_local_directories(remaining)
        return jsonify({"ok": True})

    @app.post("/auth/session")
    def auth_session():
        if not security.password_hash:
            return jsonify({"token": "", **auth_state(security)})
        if not request.is_secure and not security.allow_insecure_password:
            return (
                jsonify(
                    {
                        "error": "Password login requires HTTPS. Start the connector with --cert and --key, or use --adhoc-tls for local testing.",
                        **auth_state(security),
                    }
                ),
                426,
            )

        payload = request.get_json(silent=True) or {}
        password = payload.get("password", "")
        if not password or not check_password_hash(security.password_hash, password):
            return jsonify({"error": "Invalid connector password.", **auth_state(security)}), 401

        token = secrets.token_urlsafe(32)
        SESSION_TOKENS[token] = time.time() + security.session_ttl_seconds
        return jsonify({"token": token, **auth_state(security), "authenticated": True})

    @app.get("/servers")
    def servers():
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        dlna_servers = [serialize_server(server) for server in discover_servers()]
        return jsonify({"servers": [*dlna_servers, *local_directory_sources()]})

    @app.get("/servers/<server_id>/browse")
    def browse(server_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        server = SERVER_CACHE.get(server_id)
        if server is None and server_id.startswith("local-"):
            object_id = request.args.get("object_id", "0")
            try:
                return jsonify(browse_local_directory(server_id, object_id))
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400
            except FileNotFoundError as exc:
                return jsonify({"error": str(exc)}), 404
        if server is None:
            discover_servers()
            server = SERVER_CACHE.get(server_id)
        if server is None:
            return jsonify({"error": "Unknown server. Run discovery again."}), 404

        object_id = request.args.get("object_id", "0")
        try:
            didl = soap_browse(server, object_id)
        except (requests.RequestException, ET.ParseError) as exc:
            return jsonify({"error": str(exc)}), 502

        return jsonify({"objectId": object_id, "items": parse_didl(didl)})

    @app.get("/resources/<resource_id>")
    def resource(resource_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        descriptor = resource_descriptor(resource_id)
        if not descriptor:
            return jsonify({"error": "Unknown resource. Browse the file again."}), 404

        if descriptor.get("kind") == "file":
            path = Path(str(descriptor["path"]))
            if not path.exists() or not path.is_file():
                return jsonify({"error": "Local file is no longer available."}), 404
            return serve_file_with_range(path, str(descriptor.get("contentType") or "application/octet-stream"))

        try:
            request_headers = {}
            if request.headers.get("Range"):
                request_headers["Range"] = request.headers["Range"]
            upstream = requests.get(str(descriptor["url"]), headers=request_headers, stream=True, timeout=15)
            upstream.raise_for_status()
        except requests.RequestException as exc:
            return jsonify({"error": str(exc)}), 502

        def generate():
            with upstream:
                for chunk in upstream.iter_content(chunk_size=1024 * 256):
                    if chunk:
                        yield chunk

        headers = {}
        if upstream.headers.get("Content-Length"):
            headers["Content-Length"] = upstream.headers["Content-Length"]
        if upstream.headers.get("Accept-Ranges"):
            headers["Accept-Ranges"] = upstream.headers["Accept-Ranges"]
        if upstream.headers.get("Content-Range"):
            headers["Content-Range"] = upstream.headers["Content-Range"]

        return Response(
            stream_with_context(generate()),
            status=upstream.status_code,
            headers=headers,
            content_type=upstream.headers.get("Content-Type", "application/octet-stream"),
        )

    @app.get("/resources/<resource_id>/media-info")
    def resource_media_info(resource_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        url = resource_probe_target(resource_id)
        if not url:
            return jsonify({"error": "Unknown resource. Browse the file again."}), 404

        try:
            media_info = cached_probe_media(url)
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Timed out while probing media tracks."}), 504
        except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
            return jsonify({"error": f"Could not probe media tracks: {exc}"}), 502

        media_info["resource"] = RESOURCE_METADATA_CACHE.get(resource_id, {})
        media_info["transcodedCached"] = transcoded_file_cached(resource_id, url)
        media_info["transcodeStatus"] = TRANSCODE_PROGRESS.get(resource_id, {})
        return jsonify(media_info)

    @app.get("/resources/<resource_id>/transcode-status")
    def resource_transcode_status(resource_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        url = resource_probe_target(resource_id)
        if not url:
            return jsonify({"error": "Unknown resource. Browse the file again."}), 404
        cached = transcoded_file_cached(resource_id, url)
        status = TRANSCODE_PROGRESS.get(resource_id, {})
        if cached:
            path = transcode_cache_path(resource_id, url)
            stat = path.stat()
            return jsonify({"ok": True, "status": "cached", "cached": True, "percent": 100, "size": stat.st_size})
        artifact = transcode_artifact(resource_id, url)
        if artifact:
            status = {
                **status,
                "size": artifact["size"],
                "complete": artifact["complete"],
                **progressive_transcode_details(resource_id, RESOURCE_METADATA_CACHE.get(resource_id, {}).get("size")),
            }
        return jsonify({"ok": True, "status": status.get("status", "idle"), "cached": False, **status})

    @app.get("/resources/<resource_id>/checksum")
    def resource_checksum(resource_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        try:
            result = checksum_resource(resource_id)
        except FileNotFoundError as exc:
            return jsonify({"error": str(exc)}), 404
        except requests.RequestException as exc:
            return jsonify({"error": str(exc)}), 502
        if result is None:
            return jsonify({"error": "Unknown resource. Browse the file again."}), 404
        return jsonify(result)

    @app.get("/resources/<resource_id>/hls-info")
    def resource_hls_info(resource_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        url = resource_probe_target(resource_id)
        if not url:
            return jsonify({"error": "Unknown resource. Browse the file again."}), 404
        try:
            media_info = cached_probe_media(url)
            info = hls_duration_info(media_info)
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Timed out while probing media tracks."}), 504
        except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
            return jsonify({"error": f"Could not probe media tracks: {exc}"}), 502
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 422
        return jsonify(
            {
                "ok": True,
                "type": "application/vnd.apple.mpegurl",
                "playlistPath": f"/resources/{resource_id}/hls/playlist.m3u8",
                "mediaInfo": media_info,
                **info,
            }
        )

    @app.get("/resources/<resource_id>/hls/playlist.m3u8")
    def resource_hls_playlist(resource_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        url = resource_probe_target(resource_id)
        if not url:
            return jsonify({"error": "Unknown resource. Browse the file again."}), 404
        try:
            media_info = cached_probe_media(url)
            playlist = hls_playlist(resource_id, media_info, request.args.get("access_token", ""))
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Timed out while probing media tracks."}), 504
        except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
            return jsonify({"error": f"Could not probe media tracks: {exc}"}), 502
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 422
        return Response(
            playlist,
            headers={"Cache-Control": "no-store"},
            content_type="application/vnd.apple.mpegurl",
        )

    @app.get("/resources/<resource_id>/hls/segments/<int:segment_index>.ts")
    def resource_hls_segment(resource_id: str, segment_index: int):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        url = resource_probe_target(resource_id)
        if not url:
            return jsonify({"error": "Unknown resource. Browse the file again."}), 404
        try:
            media_info = cached_probe_media(url)
            artifact = ensure_hls_segment(resource_id, url, media_info, segment_index)
        except IndexError as exc:
            return jsonify({"error": str(exc)}), 416
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Timed out while probing media tracks."}), 504
        except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
            return jsonify({"error": f"Could not probe media tracks: {exc}"}), 502
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 502
        return serve_file_with_range(Path(artifact["path"]), artifact["contentType"])

    @app.get("/resources/<resource_id>/transcoded-info")
    def resource_transcoded_info(resource_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        url = resource_probe_target(resource_id)
        if not url:
            return jsonify({"error": "Unknown resource. Browse the file again."}), 404

        try:
            media_info = cached_probe_media(url)
            if request.args.get("progressive") == "1":
                start_transcoded_file(resource_id, url, media_info)
                artifact = wait_for_progressive_transcode(resource_id, url)
            else:
                artifact = ensure_transcoded_file(resource_id, url, media_info)
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Timed out while probing media tracks."}), 504
        except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
            return jsonify({"error": f"Could not probe media tracks: {exc}"}), 502
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 502

        return jsonify(
            {
                "ok": True,
                "type": artifact["contentType"],
                "size": artifact["size"],
                "cached": artifact["cached"],
                "complete": artifact.get("complete", artifact["cached"]),
                "progress": TRANSCODE_PROGRESS.get(resource_id, {}),
                **progressive_transcode_details(resource_id, media_info.get("size")),
                "mediaInfo": media_info,
            }
        )

    @app.post("/resources/<resource_id>/transcode")
    def resource_transcode_for_later(resource_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        url = resource_probe_target(resource_id)
        if not url:
            return jsonify({"error": "Unknown resource. Browse the file again."}), 404

        try:
            media_info = cached_probe_media(url)
            artifact = ensure_transcoded_file(resource_id, url, media_info)
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Timed out while probing media tracks."}), 504
        except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
            return jsonify({"error": f"Could not probe media tracks: {exc}"}), 502
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 502

        return jsonify(
            {
                "ok": True,
                "type": artifact["contentType"],
                "size": artifact["size"],
                "cached": artifact["cached"],
                "mediaInfo": media_info,
                "message": "Browser-safe transcode is cached and ready.",
            }
        )

    @app.get("/resources/<resource_id>/transcoded")
    def resource_transcoded(resource_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        url = resource_probe_target(resource_id)
        if not url:
            return jsonify({"error": "Unknown resource. Browse the file again."}), 404

        try:
            artifact = transcode_artifact(resource_id, url)
            if not artifact:
                media_info = cached_probe_media(url)
                if request.args.get("progressive") == "1":
                    start_transcoded_file(resource_id, url, media_info)
                    artifact = wait_for_progressive_transcode(resource_id, url)
                else:
                    artifact = ensure_transcoded_file(resource_id, url, media_info)
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Timed out while probing media tracks."}), 504
        except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
            return jsonify({"error": f"Could not probe media tracks: {exc}"}), 502
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 502

        artifact_path = Path(artifact["path"])
        if request.args.get("progressive") == "1" and not artifact.get("complete", artifact.get("cached", False)):
            media_info = cached_probe_media(url)
            details = progressive_transcode_details(resource_id, media_info.get("size"))
            return serve_growing_file_with_range(
                artifact_path,
                artifact["contentType"],
                resource_id,
                total_size=parse_int(details.get("estimatedFinalSize")),
                duration=parse_float(details.get("duration")) or parse_float(media_info.get("duration")),
            )
        return serve_file_with_range(artifact_path, artifact["contentType"])

    @app.get("/resources/<resource_id>/transcoded/checksum")
    def resource_transcoded_checksum(resource_id: str):
        auth_error = require_auth(security)
        if auth_error:
            return auth_error
        url = resource_probe_target(resource_id)
        if not url:
            return jsonify({"error": "Unknown resource. Browse the file again."}), 404

        try:
            path = transcode_cache_path(resource_id, url)
            if not path.exists() or path.stat().st_size == 0:
                media_info = cached_probe_media(url)
                artifact = ensure_transcoded_file(resource_id, url, media_info)
                path = Path(artifact["path"])
            return jsonify(checksum_file(path))
        except subprocess.TimeoutExpired:
            return jsonify({"error": "Timed out while probing media tracks."}), 504
        except (subprocess.CalledProcessError, json.JSONDecodeError) as exc:
            return jsonify({"error": f"Could not probe media tracks: {exc}"}), 502
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 502

    return app


def main():
    parser = argparse.ArgumentParser(description="Local media connector for File Pipe.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--password", default=os.environ.get("FILE_PIPE_CONNECTOR_PASSWORD"))
    parser.add_argument("--cert", help="TLS certificate file for HTTPS.")
    parser.add_argument("--key", help="TLS private key file for HTTPS.")
    parser.add_argument("--no-tls", action="store_true", help="Serve plain HTTP. Use only for isolated local testing.")
    parser.add_argument(
        "--adhoc-tls",
        action="store_true",
        help="Use a generated self-signed HTTPS certificate for local testing.",
    )
    parser.add_argument(
        "--allow-insecure-password",
        action="store_true",
        help="Allow password login over plain HTTP. Use only for isolated local testing.",
    )
    args = parser.parse_args()

    ssl_context = None
    if args.cert or args.key:
        if not args.cert or not args.key:
            parser.error("--cert and --key must be provided together.")
        ssl_context = (args.cert, args.key)
    elif args.adhoc_tls:
        ssl_context = "adhoc"
    elif not args.no_tls:
        ssl_context = ensure_local_certificate(args.host)

    security = ConnectorSecurity(
        password_hash=generate_password_hash(args.password, method="pbkdf2:sha256") if args.password else None,
        allow_insecure_password=args.allow_insecure_password,
    )
    scheme = "https" if ssl_context else "http"
    print(f"File Pipe local connector listening at {scheme}://{args.host}:{args.port}", flush=True)
    if ssl_context == "adhoc":
        print(
            f"Using a generated self-signed certificate. Open https://{args.host}:{args.port}/health directly in the browser and accept the warning once before connecting from the hosted page.",
            flush=True,
        )
    elif ssl_context:
        print(
            f"Using local certificate {ssl_context[0]}. Open https://{args.host}:{args.port}/health directly in the browser and accept or trust the certificate once.",
            flush=True,
        )
    if args.password and not ssl_context and not args.allow_insecure_password:
        print(
            "Password login will be rejected over plain HTTP. Restart with --adhoc-tls or provide --cert and --key.",
            flush=True,
        )
    create_connector_app(security).run(
        host=args.host,
        port=args.port,
        debug=args.debug,
        ssl_context=ssl_context,
    )


if __name__ == "__main__":
    main()
