import datetime as dt
import json
import re
import socket
import shutil
import subprocess
import sys
from ipaddress import ip_address
from pathlib import Path
from typing import Dict, List

from flask import Blueprint, Response, jsonify, request
from werkzeug.security import generate_password_hash

import local_connector
from standalone_config import normalize_config, public_config, public_connector_settings


ADMIN_HEADER = "X-File-Pipe-Admin"
CACHE_CATEGORY_LABELS = {
    "stable-mp4": "Stable MP4",
    "stable-mp4-spatial": "Spatial MP4",
    "hls-2d": "HLS 2D",
    "hls-3d-half": "HLS 3D Half SBS",
    "hls-3d-full": "HLS 3D Full SBS",
    "in-progress": "In progress",
    "other": "Other transcodes",
}
CACHE_CATEGORY_ORDER = {
    "hls-3d-full": 0,
    "hls-3d-half": 1,
    "hls-2d": 2,
    "stable-mp4-spatial": 3,
    "stable-mp4": 4,
    "in-progress": 5,
    "other": 6,
}
TRANSCODE_PROFILE_SUFFIX_PARTS = [
    local_connector.TRANSCODE_AUDIO_PROFILE_SPATIAL,
    local_connector.TRANSCODE_VIDEO_PROFILE_STEREO_FULL_SBS,
    local_connector.TRANSCODE_VIDEO_PROFILE_STEREO_SBS,
    *sorted(local_connector.TRANSCODE_STEREO_PROCESSORS, key=len, reverse=True),
]


def is_loopback_address(value: str) -> bool:
    try:
        address = ip_address(value)
    except ValueError:
        return value in {"localhost"}
    if address.is_loopback:
        return True
    mapped = getattr(address, "ipv4_mapped", None)
    return bool(mapped and mapped.is_loopback)


def is_local_admin_address(value: str, bound_host: str = "") -> bool:
    if is_loopback_address(value):
        return True
    if not value:
        return False
    local_addresses = set(system_lan_ips())
    if is_bindable_lan_address(bound_host):
        local_addresses.add(bound_host)
    return value in local_addresses


def system_lan_ip() -> str:
    addresses = system_lan_ips()
    return addresses[0] if addresses else ""


def system_lan_ips() -> List[str]:
    addresses: List[str] = []

    def add(value: str) -> None:
        if is_bindable_lan_address(value) and value not in addresses:
            addresses.append(value)

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            add(sock.getsockname()[0])
    except OSError:
        pass

    try:
        candidates = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET, socket.SOCK_STREAM)
    except OSError:
        return addresses

    for candidate in candidates:
        add(candidate[4][0])
    return addresses


def is_bindable_lan_address(value: str) -> bool:
    try:
        address = ip_address(value)
    except ValueError:
        return False
    return not (address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified)


def format_timestamp(timestamp: float) -> str:
    return dt.datetime.fromtimestamp(timestamp).isoformat(timespec="seconds")


def cache_dir() -> Path:
    return Path(local_connector.TRANSCODE_CACHE_DIR).expanduser()


def path_size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for child in path.rglob("*"):
        if child.is_file():
            try:
                total += child.stat().st_size
            except OSError:
                continue
    return total


def is_hls_cache_dir(path: Path) -> bool:
    name = path.name
    return path.is_dir() and (
        name.endswith("-hls")
        or name.startswith(local_connector.HLS_SEGMENT_CACHE_VERSION)
    )


def processor_label(processor_id: str) -> str:
    for option in local_connector.stereo_processor_options():
        if option.get("id") == processor_id:
            return str(option.get("label") or processor_id)
    return processor_id


def cache_token_decimal(name: str, prefix: str) -> str:
    match = re.search(rf"(?:^|-){re.escape(prefix)}-([0-9]+)(?:-|$)", name)
    if not match:
        return ""
    token = match.group(1)
    if token == "1":
        return "1"
    if len(token) == 1:
        return f"0.{token}"
    return f"{int(token) / (10 ** (len(token) - 1)):g}"


def cache_entry_details(path: Path) -> Dict[str, object]:
    name = path.name
    lower_name = name.lower()
    if path.is_dir():
        segment_count = 0
        last_error = ""
        last_error_at = ""
        try:
            segment_count = sum(1 for child in path.iterdir() if child.is_file() and child.suffix == ".ts")
        except OSError:
            segment_count = 0
        try:
            error_payload = json.loads((path / ".last-error.json").read_text(encoding="utf-8"))
            last_error = str(error_payload.get("error") or "")
            updated_at = error_payload.get("updatedAt")
            if updated_at:
                last_error_at = format_timestamp(float(updated_at))
        except (FileNotFoundError, OSError, ValueError, TypeError, json.JSONDecodeError):
            last_error = ""
            last_error_at = ""
        layout = "2d"
        category = "hls-2d"
        profile_label = "HLS 2D"
        if local_connector.TRANSCODE_VIDEO_PROFILE_STEREO_FULL_SBS in lower_name:
            layout = "full-sbs"
            category = "hls-3d-full"
            profile_label = "Full SBS"
        elif local_connector.TRANSCODE_VIDEO_PROFILE_STEREO_SBS in lower_name:
            layout = "half-sbs"
            category = "hls-3d-half"
            profile_label = "Half SBS"
        processor = ""
        if layout != "2d":
            processor = local_connector.TRANSCODE_STEREO_PROCESSOR_FFMPEG_SHIFT
            for option in sorted(
                local_connector.stereo_processor_options(),
                key=lambda item: len(str(item.get("id") or "")),
                reverse=True,
            ):
                candidate = str(option.get("id") or "")
                if candidate and candidate in lower_name:
                    processor = candidate
                    break
            output_scale = cache_token_decimal(lower_name, "scale")
            inference_scale = cache_token_decimal(lower_name, "infer")
            crop_percent = cache_token_decimal(lower_name, "crop")
            if output_scale:
                profile_label = f"{profile_label} / {output_scale}x output"
            processor_suffix = []
            if processor != local_connector.TRANSCODE_STEREO_PROCESSOR_FFMPEG_SHIFT and inference_scale:
                processor_suffix.append(f"{inference_scale}x depth")
            if crop_percent:
                processor_suffix.append(f"{crop_percent}% crop")
            processor_display = processor_label(processor)
            if processor_suffix:
                processor_display = f"{processor_display} ({', '.join(processor_suffix)})"
        else:
            processor_display = ""
        return {
            "kind": "HLS segments",
            "category": category,
            "categoryLabel": CACHE_CATEGORY_LABELS[category],
            "profileLabel": profile_label,
            "layout": layout,
            "processor": processor,
            "processorLabel": processor_display,
            "segmentCount": segment_count,
            "lastError": last_error,
            "lastErrorAt": last_error_at,
            "errorCount": 1 if last_error else 0,
        }
    if ".part" in lower_name:
        return {
            "kind": "In progress",
            "category": "in-progress",
            "categoryLabel": CACHE_CATEGORY_LABELS["in-progress"],
            "profileLabel": "Partial transcode",
            "layout": "",
            "processor": "",
            "processorLabel": "",
            "segmentCount": 0,
        }
    if lower_name.endswith(".mp4"):
        category = "stable-mp4-spatial" if "-spatial-" in lower_name or lower_name.endswith("-spatial.mp4") else "stable-mp4"
        return {
            "kind": "Stable MP4",
            "category": category,
            "categoryLabel": CACHE_CATEGORY_LABELS[category],
            "profileLabel": CACHE_CATEGORY_LABELS[category],
            "layout": "2d",
            "processor": "",
            "processorLabel": "",
            "segmentCount": 0,
        }
    return {
        "kind": "Transcode",
        "category": "other",
        "categoryLabel": CACHE_CATEGORY_LABELS["other"],
        "profileLabel": "Transcode",
        "layout": "",
        "processor": "",
        "processorLabel": "",
        "segmentCount": 0,
    }


def cache_entry_video_key(path: Path) -> Dict[str, str]:
    name = path.name
    base = name
    for suffix in (".mp4.part", ".part", ".mp4"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    if base.endswith("-hls"):
        base = base[:-4]
    if base.startswith("md5-"):
        parts = base.split("-")
        fingerprint = ""
        if len(parts) >= 2 and parts[-1] not in {local_connector.HLS_SEGMENT_CACHE_VERSION, f"{local_connector.HLS_SEGMENT_SECONDS}s"}:
            fingerprint = parts[-1]
        label = f"MD5 {fingerprint[:12]}" if fingerprint else "MD5 source"
        return {"videoKey": f"md5:{fingerprint or base}", "videoLabel": label}
    normalized = base
    changed = True
    while changed:
        changed = False
        for part in TRANSCODE_PROFILE_SUFFIX_PARTS:
            suffix = f"-{part}"
            if normalized.endswith(suffix):
                normalized = normalized[: -len(suffix)]
                changed = True
                break
    return {"videoKey": normalized or base, "videoLabel": normalized or base}


def transcode_files() -> List[Dict[str, object]]:
    directory = cache_dir()
    if not directory.exists():
        return []
    entries = []
    for path in sorted(directory.iterdir(), key=lambda item: item.stat().st_mtime if item.exists() else 0, reverse=True):
        if not path.is_file() and not path.is_dir():
            continue
        if path.is_file() and path.suffix not in {".mp4", ".part"}:
            continue
        if path.is_dir() and not is_hls_cache_dir(path):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        size = path_size(path)
        entry = {
            "name": path.name,
            "path": str(path),
            "size": size,
            "modifiedAt": format_timestamp(stat.st_mtime),
        }
        entry.update(cache_entry_details(path))
        entry.update(cache_entry_video_key(path))
        entries.append(entry)
    return entries


def cache_payload() -> Dict[str, object]:
    entries = transcode_files()
    max_cache_bytes = int(getattr(local_connector, "TRANSCODE_CACHE_MAX_BYTES", 0) or 0)
    size = sum(int(entry["size"]) for entry in entries)
    groups: Dict[str, Dict[str, object]] = {}
    for entry in entries:
        category = str(entry.get("category") or "other")
        group = groups.setdefault(
            category,
            {
                "category": category,
                "label": str(entry.get("categoryLabel") or CACHE_CATEGORY_LABELS.get(category, category)),
                "count": 0,
                "size": 0,
                "segmentCount": 0,
                "errorCount": 0,
            },
        )
        group["count"] = int(group["count"]) + 1
        group["size"] = int(group["size"]) + int(entry.get("size") or 0)
        group["segmentCount"] = int(group["segmentCount"]) + int(entry.get("segmentCount") or 0)
        group["errorCount"] = int(group.get("errorCount") or 0) + int(entry.get("errorCount") or 0)
    return {
        "cacheDir": str(cache_dir()),
        "files": entries,
        "groups": sorted(groups.values(), key=lambda item: CACHE_CATEGORY_ORDER.get(str(item["category"]), 99)),
        "count": len(entries),
        "size": size,
        "maxCacheBytes": max_cache_bytes,
        "availableBytes": max(0, max_cache_bytes - size) if max_cache_bytes else 0,
        "limitEnabled": max_cache_bytes > 0,
    }


def safe_cache_path(name: str) -> Path:
    directory = cache_dir().resolve()
    path = (directory / name).resolve()
    if path.parent != directory:
        raise ValueError("Invalid cache file.")
    if path.is_dir():
        if not is_hls_cache_dir(path):
            raise ValueError("Invalid cache entry.")
        return path
    if path.suffix not in {".mp4", ".part"}:
        raise ValueError("Invalid cache file.")
    return path


def cache_background_work_busy() -> bool:
    stats = local_connector.background_work_stats()
    return any(
        int(stats.get(key) or 0) > 0
        for key in ("transcodeActive", "transcodeQueued", "hlsPrefetchActive", "hlsPrefetchQueued", "runningTranscodes", "hlsPrefetching")
    )


def move_cache_directory(current_dir: Path, target_dir: Path) -> Dict[str, object]:
    current = current_dir.expanduser().resolve()
    target = target_dir.expanduser().resolve()
    if current == target:
        return {"moved": False, "bytesMoved": 0, "entryCount": 0}
    if current in target.parents:
        raise ValueError("Choose a cache folder outside the current cache folder.")
    if target.exists() and any(target.iterdir()):
        raise ValueError("Choose an empty folder for the cache move.")
    target.mkdir(parents=True, exist_ok=True)
    bytes_moved = path_size(current) if current.exists() else 0
    entry_count = 0
    if current.exists():
        for child in current.iterdir():
            shutil.move(str(child), str(target / child.name))
            entry_count += 1
        try:
            current.rmdir()
        except OSError:
            shutil.rmtree(current)
    return {"moved": True, "bytesMoved": bytes_moved, "entryCount": entry_count}


def applescript_quote(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def choose_directory(current_path: str = ""):
    initial = Path(current_path or str(cache_dir())).expanduser()
    if not initial.exists():
        initial = initial.parent if initial.parent.exists() else Path.home()

    if sys.platform == "darwin":
        script = (
            'POSIX path of (choose folder with prompt "Choose File Pipe transcode cache folder" '
            f'default location POSIX file "{applescript_quote(str(initial))}")'
        )
        completed = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if completed.returncode == 0:
            return completed.stdout.strip().rstrip("/")
        if "User canceled" in completed.stderr:
            return None
        raise RuntimeError((completed.stderr or completed.stdout or "Folder picker failed.").strip())

    if sys.platform == "win32":
        powershell = shutil.which("powershell.exe") or shutil.which("pwsh")
        if not powershell:
            raise RuntimeError("PowerShell is required to open the Windows folder picker.")
        selected_path = str(initial).replace("'", "''")
        script = f"""
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose File Pipe transcode cache folder'
$dialog.SelectedPath = '{selected_path}'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
  [Console]::Write($dialog.SelectedPath)
}} else {{
  exit 2
}}
"""
        completed = subprocess.run(
            [powershell, "-NoProfile", "-STA", "-Command", script],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if completed.returncode == 0:
            return completed.stdout.strip()
        if completed.returncode == 2:
            return None
        raise RuntimeError((completed.stderr or completed.stdout or "Folder picker failed.").strip())

    for command in ("zenity", "kdialog"):
        executable = shutil.which(command)
        if not executable:
            continue
        if command == "zenity":
            args = [executable, "--file-selection", "--directory", "--filename", f"{initial}/"]
        else:
            args = [executable, "--getexistingdirectory", str(initial)]
        completed = subprocess.run(args, capture_output=True, text=True, timeout=300)
        if completed.returncode == 0:
            return completed.stdout.strip()
        if completed.returncode == 1:
            return None
        raise RuntimeError((completed.stderr or completed.stdout or "Folder picker failed.").strip())

    raise RuntimeError("No supported folder picker is available on this system.")


def create_admin_blueprint(security, runtime):
    blueprint = Blueprint("standalone_admin", __name__)

    @blueprint.before_request
    def protect_admin():
        if not is_local_admin_address(request.remote_addr or "", str(runtime.config.get("host") or "")):
            return jsonify({"error": "Admin UI is only available from this computer."}), 403
        if request.path.startswith("/admin/api") and request.headers.get(ADMIN_HEADER) != runtime.admin_token:
            return jsonify({"error": "Admin token is missing or invalid."}), 403
        return None

    @blueprint.get("/admin")
    def admin_index():
        html = ADMIN_HTML.replace("__ADMIN_TOKEN_JSON__", json.dumps(runtime.admin_token))
        return Response(html, mimetype="text/html")

    @blueprint.get("/admin/api/status")
    def admin_status():
        ffprobe_available, ffmpeg_available = local_connector.ffmpeg_tools_available()
        lan_ip = system_lan_ip()
        sessions = {
            token: expires_at
            for token, expires_at in list(local_connector.SESSION_TOKENS.items())
            if expires_at >= dt.datetime.now().timestamp()
        }
        local_connector.SESSION_TOKENS.clear()
        local_connector.SESSION_TOKENS.update(sessions)
        return jsonify(
            {
                "ok": True,
                "startedAt": runtime.started_at,
                "connectorUrl": runtime.connector_url,
                "lanIp": lan_ip,
                "lanConnectorUrl": f"{runtime.scheme}://{lan_ip}:{runtime.actual_port}" if lan_ip else "",
                "healthUrl": f"{runtime.connector_url}/health",
                "configPath": str(runtime.config_path),
                "restartRequired": runtime.restart_required,
                "serviceEnabled": bool(local_connector.CONNECTOR_SERVICE_ENABLED),
                "authRequired": bool(security.password_hash),
                "allowInsecurePassword": bool(security.allow_insecure_password),
                "activeSessions": len(sessions),
                "ffprobeAvailable": ffprobe_available,
                "ffmpegAvailable": ffmpeg_available,
                "stereo3d": {
                    "available": sorted(local_connector.TRANSCODE_VIDEO_PROFILES),
                    "generatedLayouts": {
                        local_connector.TRANSCODE_VIDEO_PROFILE_STEREO_SBS: "half-sbs",
                        local_connector.TRANSCODE_VIDEO_PROFILE_STEREO_FULL_SBS: "full-sbs",
                    },
                    "defaultProcessor": local_connector.normalize_stereo_processor(local_connector.HLS_STEREO3D_PROCESSOR),
                    "defaultRealtimeProcessor": local_connector.normalize_stereo_processor(local_connector.HLS_STEREO3D_REALTIME_PROCESSOR),
                    "defaultPrebuildProcessor": local_connector.normalize_stereo_processor(local_connector.HLS_STEREO3D_PREBUILD_PROCESSOR),
                    "processors": local_connector.stereo_processor_options(),
                    "depthPercent": local_connector.hls_stereo3d_depth_fraction() * 100,
                    "inferenceScales": ["1", "0.75", "0.5", "0.33", "0.25"],
                    "defaultInferenceScale": local_connector.normalize_stereo3d_inference_scale(local_connector.HLS_STEREO3D_INFERENCE_SCALE),
                    "defaultInferenceCropPercent": local_connector.normalize_stereo3d_inference_crop_percent(local_connector.HLS_STEREO3D_INFERENCE_CROP_PERCENT),
                    "defaultPrebuildInferenceScale": local_connector.normalize_stereo3d_inference_scale(local_connector.HLS_STEREO3D_PREBUILD_INFERENCE_SCALE),
                    "defaultPrebuildInferenceCropPercent": local_connector.normalize_stereo3d_inference_crop_percent(local_connector.HLS_STEREO3D_PREBUILD_INFERENCE_CROP_PERCENT),
                },
                "cache": cache_payload(),
                "connections": {
                    "servers": [local_connector.serialize_server(server) for server in local_connector.SERVER_CACHE.values()],
                    "serverCount": len(local_connector.SERVER_CACHE),
                    "resourceCount": len(local_connector.RESOURCE_CACHE),
                },
                "backgroundWork": local_connector.background_work_stats(),
                "readAhead": local_connector.READ_AHEAD_CACHE.stats(),
                "config": public_config(runtime.config),
                "settings": public_connector_settings(runtime.config),
            }
        )

    @blueprint.get("/admin/api/cache")
    def admin_cache():
        return jsonify(cache_payload())

    @blueprint.delete("/admin/api/cache")
    def admin_clear_cache():
        deleted = 0
        bytes_deleted = 0
        for entry in transcode_files():
            try:
                path = safe_cache_path(str(entry["name"]))
                size = path_size(path)
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()
            except OSError:
                continue
            deleted += 1
            bytes_deleted += size
        return jsonify({"ok": True, "deleted": deleted, "bytesDeleted": bytes_deleted, "cache": cache_payload()})

    @blueprint.delete("/admin/api/cache/<path:name>")
    def admin_delete_cache_file(name: str):
        try:
            path = safe_cache_path(name)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        if not path.exists():
            return jsonify({"error": "Cache file not found."}), 404
        size = path_size(path)
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        return jsonify({"ok": True, "deleted": 1, "bytesDeleted": size, "cache": cache_payload()})

    @blueprint.post("/admin/api/cache/prune")
    def admin_prune_cache():
        result = local_connector.enforce_transcode_cache_limit()
        return jsonify({"ok": True, **result, "cache": cache_payload()})

    @blueprint.post("/admin/api/cache/move")
    def admin_move_cache():
        if cache_background_work_busy():
            return jsonify({"error": "Cache work is active. Wait for transcodes, HLS prefetches, and 3D prebuilds to finish before moving the cache."}), 409
        payload = request.get_json(silent=True) or {}
        target = Path(str(payload.get("cacheDir") or payload.get("path") or "")).expanduser()
        if not str(target).strip():
            return jsonify({"error": "Choose a destination cache folder."}), 400
        current = cache_dir()
        try:
            move_result = move_cache_directory(current, target)
        except (OSError, ValueError) as exc:
            return jsonify({"error": f"Could not move cache: {exc}"}), 400
        updated = normalize_config({**runtime.config, "cacheDir": str(target)})
        runtime.save_config(updated)
        local_connector.TRANSCODE_CACHE_DIR = Path(updated["cacheDir"]).expanduser()
        local_connector.CONNECTOR_SETTINGS = public_connector_settings(updated)
        return jsonify(
            {
                "ok": True,
                **move_result,
                "config": public_config(runtime.config),
                "configPath": str(runtime.config_path),
                "settings": public_connector_settings(runtime.config),
                "cache": cache_payload(),
            }
        )

    @blueprint.post("/admin/api/discover")
    def admin_discover():
        servers = local_connector.discover_servers()
        return jsonify({"ok": True, "servers": [local_connector.serialize_server(server) for server in servers]})

    @blueprint.delete("/admin/api/connections")
    def admin_clear_connections():
        local_connector.SERVER_CACHE.clear()
        local_connector.RESOURCE_CACHE.clear()
        local_connector.RESOURCE_METADATA_CACHE.clear()
        return jsonify({"ok": True})

    @blueprint.get("/admin/api/config")
    def admin_get_config():
        return jsonify({"config": public_config(runtime.config), "configPath": str(runtime.config_path)})

    @blueprint.post("/admin/api/pick-directory")
    def admin_pick_directory():
        payload = request.get_json(silent=True) or {}
        try:
            selected = choose_directory(str(payload.get("currentPath") or ""))
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 500
        if not selected:
            return jsonify({"ok": True, "cancelled": True})
        return jsonify({"ok": True, "path": selected})

    @blueprint.put("/admin/api/config")
    def admin_put_config():
        payload = request.get_json(silent=True) or {}
        current = normalize_config(runtime.config)
        updated = normalize_config({**current, **payload})

        password = payload.get("password")
        if payload.get("clearPassword"):
            updated["passwordHash"] = None
            security.password_hash = None
            local_connector.SESSION_TOKENS.clear()
        elif isinstance(password, str) and password:
            updated["passwordHash"] = generate_password_hash(password, method="pbkdf2:sha256")
            security.password_hash = updated["passwordHash"]
            local_connector.SESSION_TOKENS.clear()
        else:
            updated["passwordHash"] = current.get("passwordHash")
            security.password_hash = updated["passwordHash"]

        network_changed = any(
            updated[key] != current.get(key)
            for key in ("host", "port", "useTls")
        )
        cache_changed = updated["cacheDir"] != current.get("cacheDir")
        if cache_changed:
            try:
                Path(updated["cacheDir"]).expanduser().mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                return jsonify({"error": f"Cache folder is unavailable: {exc}"}), 400
        security.allow_insecure_password = bool(updated["allowInsecurePassword"])
        runtime.save_config(updated)
        local_connector.CONNECTOR_SERVICE_ENABLED = bool(updated["serviceEnabled"])
        local_connector.CONNECTOR_SETTINGS = public_connector_settings(updated)
        if cache_changed:
            local_connector.TRANSCODE_CACHE_DIR = Path(updated["cacheDir"]).expanduser()
        local_connector.TRANSCODE_CACHE_MAX_BYTES = int(updated.get("maxCacheBytes") or 0)
        local_connector.HLS_STEREO3D_REALTIME_PROCESSOR = str(updated.get("realtimeStereo3dProcessor") or local_connector.HLS_STEREO3D_REALTIME_PROCESSOR)
        local_connector.HLS_STEREO3D_PROCESSOR = local_connector.HLS_STEREO3D_REALTIME_PROCESSOR
        local_connector.HLS_STEREO3D_PREBUILD_PROCESSOR = str(updated.get("prebuildStereo3dProcessor") or local_connector.HLS_STEREO3D_PREBUILD_PROCESSOR)
        local_connector.HLS_STEREO3D_INFERENCE_SCALE = str(updated.get("realtimeStereo3dInferenceScale") or local_connector.HLS_STEREO3D_INFERENCE_SCALE)
        local_connector.HLS_STEREO3D_INFERENCE_CROP_PERCENT = str(updated.get("realtimeStereo3dInferenceCropPercent") or 0)
        local_connector.HLS_STEREO3D_PREBUILD_INFERENCE_SCALE = str(updated.get("prebuildStereo3dInferenceScale") or local_connector.HLS_STEREO3D_PREBUILD_INFERENCE_SCALE)
        local_connector.HLS_STEREO3D_PREBUILD_INFERENCE_CROP_PERCENT = str(updated.get("prebuildStereo3dInferenceCropPercent") or 0)
        prune_result = local_connector.enforce_transcode_cache_limit()
        if network_changed:
            runtime.mark_restart_required()
        return jsonify(
            {
                "ok": True,
                "config": public_config(runtime.config),
                "restartRequired": runtime.restart_required,
                "serviceEnabled": bool(local_connector.CONNECTOR_SERVICE_ENABLED),
                "settings": public_connector_settings(runtime.config),
                "cache": cache_payload(),
                "cachePrune": prune_result,
            }
        )

    @blueprint.post("/admin/api/shutdown")
    def admin_shutdown():
        runtime.request_shutdown()
        return jsonify({"ok": True})

    return blueprint


ADMIN_HTML = r"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>File Pipe Connector</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f3f5f7;
        --panel: #ffffff;
        --panel-soft: #f8fafc;
        --muted: #667085;
        --text: #172033;
        --text-strong: #0f172a;
        --border: #d8e0ea;
        --soft: #eef2f6;
        --primary: #2563eb;
        --primary-dark: #1d4ed8;
        --danger: #c0392b;
        --success: #16845b;
        --warning: #b7791f;
        --shadow: 0 16px 38px rgba(15, 23, 42, 0.08);
      }

      * {
        box-sizing: border-box;
      }

      body {
        background: linear-gradient(180deg, #fbfcfe 0, var(--bg) 18rem);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        min-height: 100vh;
      }

      header {
        align-items: center;
        background: rgba(255, 255, 255, 0.94);
        border-bottom: 1px solid #e5ebf2;
        display: flex;
        flex-wrap: wrap;
        gap: 1.2rem;
        justify-content: space-between;
        padding: 1rem clamp(1rem, 3vw, 2.2rem);
        position: sticky;
        top: 0;
        z-index: 2;
      }

      h1, h2, h3, p {
        margin-top: 0;
      }

      h1 {
        color: var(--text-strong);
        font-size: 1.4rem;
        line-height: 1.15;
        margin-bottom: 0.15rem;
      }

      h2 {
        color: var(--text-strong);
        font-size: 1rem;
        line-height: 1.2;
        margin-bottom: 0.25rem;
      }

      p {
        margin-bottom: 0;
      }

      button, input {
        font: inherit;
      }

      button {
        align-items: center;
        background: var(--primary);
        border: 1px solid var(--primary);
        border-radius: 8px;
        color: #ffffff;
        cursor: pointer;
        display: inline-flex;
        font-weight: 700;
        gap: 0.35rem;
        justify-content: center;
        min-height: 2.4rem;
        padding: 0.5rem 0.9rem;
      }

      button:hover {
        background: var(--primary-dark);
        border-color: var(--primary-dark);
        box-shadow: 0 8px 18px rgba(37, 99, 235, 0.18);
      }

      button.secondary {
        background: #ffffff;
        border-color: var(--border);
        color: var(--text);
      }

      button.secondary:hover {
        background: #f8fafc;
        border-color: #b8c4d4;
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.08);
      }

      button.danger {
        background: #ffffff;
        border-color: #f0b7ae;
        color: var(--danger);
      }

      button.danger:hover {
        background: #fff1f0;
        border-color: #ec9285;
        box-shadow: 0 8px 18px rgba(192, 57, 43, 0.12);
      }

      button:disabled {
        cursor: wait;
        opacity: 0.62;
      }

      input {
        border: 1px solid var(--border);
        border-radius: 8px;
        min-height: 2.4rem;
        padding: 0.45rem 0.65rem;
        width: 100%;
      }

      input:focus {
        border-color: #86a8ff;
        box-shadow: 0 0 0 0.22rem rgba(37, 99, 235, 0.14);
        outline: 0;
      }

      input[type="checkbox"] {
        accent-color: var(--primary);
        min-height: 0;
        width: auto;
      }

      label {
        color: #344054;
        display: grid;
        font-size: 0.85rem;
        font-weight: 700;
        gap: 0.35rem;
      }

      main {
        display: grid;
        gap: 1.1rem;
        margin: 0 auto;
        max-width: 1240px;
        padding: 1.15rem clamp(1rem, 3vw, 2.2rem) 2.2rem;
      }

      .muted {
        color: var(--muted);
      }

      .brand {
        align-items: center;
        display: grid;
        gap: 0.85rem;
        grid-template-columns: 2.75rem minmax(0, 1fr);
        min-width: 0;
      }

      .brand-mark {
        align-items: center;
        background: #eaf2ff;
        border: 1px solid #cfe0ff;
        border-radius: 8px;
        color: var(--primary);
        display: grid;
        font-weight: 900;
        height: 2.75rem;
        place-items: center;
        width: 2.75rem;
      }

      .header-actions {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 0.65rem;
      }

      .topline {
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      .pill {
        align-items: center;
        border: 1px solid var(--border);
        border-radius: 999px;
        display: inline-flex;
        font-size: 0.85rem;
        font-weight: 800;
        gap: 0.45rem;
        min-height: 2.2rem;
        padding: 0.45rem 0.8rem;
        white-space: nowrap;
      }

      .pill::before {
        background: currentColor;
        border-radius: 999px;
        content: "";
        height: 0.55rem;
        width: 0.55rem;
      }

      .pill.ready {
        background: #ecfdf5;
        border-color: #b7ead4;
        color: #075e42;
      }

      .pill.warn {
        background: #fff7ed;
        border-color: #fed7aa;
        color: #9a3412;
      }

      .hero {
        align-items: stretch;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: var(--shadow);
        display: grid;
        gap: 1rem;
        grid-template-columns: minmax(0, 1fr) auto;
        padding: 1rem;
      }

      .hero-title {
        align-items: center;
        display: flex;
        flex-wrap: wrap;
        gap: 0.65rem;
      }

      .hero-main {
        min-width: 0;
      }

      .hero-url {
        background: #f8fafc;
        border: 1px solid #e6edf5;
        border-radius: 8px;
        color: #344054;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.85rem;
        margin-top: 0.65rem;
        max-width: 100%;
        overflow-wrap: anywhere;
        padding: 0.65rem 0.75rem;
      }

      .grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
      }

      .status-grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }

      .columns {
        display: grid;
        gap: 1rem;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }

      .settings-layout {
        display: grid;
        gap: 1rem;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 8px 26px rgba(15, 23, 42, 0.045);
        padding: 1rem;
      }

      .panel-head {
        align-items: flex-start;
        display: flex;
        gap: 1rem;
        justify-content: space-between;
        margin-bottom: 0.95rem;
      }

      .section-title {
        border-bottom: 1px solid var(--soft);
        color: var(--text-strong);
        font-size: 0.8rem;
        font-weight: 900;
        letter-spacing: 0;
        margin: 0 0 0.8rem;
        padding-bottom: 0.55rem;
        text-transform: uppercase;
      }

      .panel-subtitle {
        color: var(--muted);
        font-size: 0.86rem;
        margin-top: 0.25rem;
      }

      .tabs {
        background: var(--panel-soft);
        border: 1px solid var(--soft);
        border-radius: 8px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        margin-bottom: 1rem;
        padding: 0.25rem;
      }

      .tab-button {
        background: transparent;
        border: 0;
        border-radius: 6px;
        color: var(--muted);
        min-height: 2.35rem;
      }

      .tab-button:hover {
        background: #ffffff;
        border: 0;
        box-shadow: none;
      }

      .tab-button.active {
        background: #ffffff;
        box-shadow: 0 5px 16px rgba(15, 23, 42, 0.08);
        color: var(--text-strong);
      }

      .tab-panel[hidden] {
        display: none;
      }

      .collapsible {
        border: 1px solid var(--soft);
        border-radius: 8px;
        background: #ffffff;
        overflow: hidden;
      }

      .collapsible + .collapsible {
        margin-top: 0.75rem;
      }

      .collapsible summary {
        align-items: center;
        cursor: pointer;
        display: flex;
        gap: 0.65rem;
        justify-content: space-between;
        list-style: none;
        padding: 0.85rem 0.95rem;
      }

      .collapsible summary::-webkit-details-marker {
        display: none;
      }

      .collapsible summary::after {
        border-bottom: 2px solid #667085;
        border-right: 2px solid #667085;
        content: "";
        height: 0.45rem;
        transform: rotate(45deg);
        transition: transform 0.16s ease;
        width: 0.45rem;
      }

      .collapsible[open] summary::after {
        transform: rotate(225deg);
      }

      .summary-title {
        color: var(--text-strong);
        display: block;
        font-size: 0.92rem;
        font-weight: 900;
      }

      .summary-copy {
        color: var(--muted);
        display: block;
        font-size: 0.8rem;
        font-weight: 600;
        margin-top: 0.16rem;
      }

      .collapsible-body {
        border-top: 1px solid var(--soft);
        padding: 0.95rem;
      }

      .cache-groups {
        display: grid;
        gap: 0.75rem;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        margin: 0.85rem 0;
      }

      .cache-filter {
        align-items: flex-start;
        background: #ffffff;
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text);
        cursor: pointer;
        display: grid;
        gap: 0.22rem;
        min-height: 6rem;
        padding: 0.75rem;
        text-align: left;
      }

      .cache-filter:hover {
        border-color: #9fb2cc;
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.07);
      }

      .cache-filter.active {
        border-color: var(--primary);
        box-shadow: 0 0 0 0.18rem rgba(37, 99, 235, 0.13);
      }

      .cache-filter strong {
        color: var(--text-strong);
        display: block;
        font-size: 1.1rem;
      }

      .cache-entry-list {
        display: grid;
        gap: 0.75rem;
      }

      .cache-video {
        border: 1px solid var(--soft);
        border-radius: 8px;
        overflow: hidden;
      }

      .cache-video summary {
        align-items: center;
        background: #ffffff;
        cursor: pointer;
        display: grid;
        gap: 0.75rem;
        grid-template-columns: minmax(0, 1fr) auto auto;
        list-style: none;
        padding: 0.8rem 0.9rem;
      }

      .cache-video summary::-webkit-details-marker {
        display: none;
      }

      .cache-video-title {
        color: var(--text-strong);
        display: block;
        font-weight: 900;
        overflow-wrap: anywhere;
      }

      .cache-video-body {
        border-top: 1px solid var(--soft);
        padding: 0.75rem;
      }

      .badge {
        background: #eef2f6;
        border: 1px solid #dce4ee;
        border-radius: 999px;
        color: #344054;
        display: inline-flex;
        font-size: 0.72rem;
        font-weight: 900;
        line-height: 1;
        padding: 0.28rem 0.45rem;
        text-transform: uppercase;
      }

      .badge.warn {
        background: #fff7ed;
        border-color: #fed7aa;
        color: #9a3412;
      }

      .profile-line {
        color: var(--muted);
        display: block;
        font-size: 0.78rem;
        margin-top: 0.2rem;
      }

      .profile-line.danger-text {
        color: #b42318;
        max-width: 54rem;
      }

      .info-list {
        display: grid;
        gap: 0.7rem;
      }

      .info-row {
        border-bottom: 1px solid var(--soft);
        display: grid;
        gap: 0.55rem;
        grid-template-columns: minmax(8rem, 0.85fr) minmax(0, 1.7fr) minmax(0, 1fr);
        padding-bottom: 0.7rem;
      }

      .info-row:last-child {
        border-bottom: 0;
        padding-bottom: 0;
      }

      .info-row strong {
        color: var(--text-strong);
      }

      .stat {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.045);
        min-width: 0;
        padding: 1rem;
        position: relative;
      }

      .stat::before {
        background: var(--primary);
        border-radius: 999px;
        content: "";
        height: 0.35rem;
        left: 1rem;
        position: absolute;
        right: 1rem;
        top: 0.65rem;
      }

      .stat.stat-success::before {
        background: var(--success);
      }

      .stat.stat-warning::before {
        background: var(--warning);
      }

      .stat strong {
        color: var(--text-strong);
        display: block;
        font-size: 1.35rem;
        margin-top: 0.45rem;
        overflow-wrap: anywhere;
      }

      .form-grid {
        display: grid;
        gap: 0.85rem;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .form-stack {
        display: grid;
        gap: 0.85rem;
      }

      .path-picker {
        display: grid;
        gap: 0.55rem;
        grid-template-columns: minmax(0, 1fr) auto auto;
      }

      .input-suffix {
        align-self: center;
        color: var(--muted);
        font-size: 0.85rem;
        font-weight: 700;
      }

      .field-hint {
        color: var(--muted);
        display: block;
        font-size: 0.78rem;
        line-height: 1.35;
        margin-top: 0.35rem;
      }

      .check-row {
        align-items: center;
        background: var(--panel-soft);
        border: 1px solid #e6edf5;
        border-radius: 8px;
        display: flex;
        gap: 0.55rem;
        min-height: 2.4rem;
        padding: 0.55rem 0.65rem;
      }

      .toggle-grid {
        display: grid;
        gap: 0.65rem;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .inline-meta {
        align-items: center;
        color: var(--muted);
        display: flex;
        flex-wrap: wrap;
        font-size: 0.85rem;
        gap: 0.5rem;
        margin-top: 0.55rem;
      }

      .code-chip {
        background: #eef2f6;
        border: 1px solid #dce4ee;
        border-radius: 8px;
        color: #344054;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        padding: 0.28rem 0.45rem;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
        margin-top: 1rem;
      }

      table {
        background: #ffffff;
        border-collapse: collapse;
        width: 100%;
      }

      th, td {
        border-bottom: 1px solid var(--soft);
        font-size: 0.9rem;
        padding: 0.78rem 0.65rem;
        text-align: left;
        vertical-align: middle;
      }

      th {
        background: var(--panel-soft);
        color: #475467;
        font-size: 0.75rem;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      tr:hover td {
        background: #fbfdff;
      }

      td:last-child, th:last-child {
        text-align: right;
      }

      .scroll-table {
        border: 1px solid var(--soft);
        border-radius: 8px;
        overflow-x: auto;
      }

      .path {
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.8rem;
        overflow-wrap: anywhere;
      }

      .notice {
        background: #fff7ed;
        border: 1px solid #fed7aa;
        border-radius: 8px;
        color: #9a3412;
        display: none;
        padding: 0.75rem;
      }

      .notice.show {
        display: block;
      }

      .log {
        background: #101828;
        border-radius: 8px;
        color: #eef2f6;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.8rem;
        min-height: 4rem;
        overflow-wrap: anywhere;
        padding: 0.8rem;
      }

      .empty-row {
        color: var(--muted);
        padding: 1.15rem 0.65rem;
        text-align: center !important;
      }

      .cache-file {
        color: var(--text-strong);
        font-weight: 700;
      }

      @media (max-width: 920px) {
        .grid, .status-grid, .columns, .settings-layout, .form-grid, .toggle-grid, .hero, .info-row, .cache-groups, .cache-video summary {
          grid-template-columns: 1fr;
        }

        .path-picker {
          grid-template-columns: 1fr;
        }

        header {
          align-items: stretch;
        }

        .header-actions {
          align-items: stretch;
          flex-direction: column;
          width: 100%;
        }

        .header-actions button,
        .header-actions .pill {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="brand">
        <div class="brand-mark">FP</div>
        <div>
          <div class="topline">Local connector</div>
          <h1>File Pipe Connector</h1>
        </div>
      </div>
      <div class="header-actions">
        <button class="secondary" id="copy-url" type="button">Copy URL</button>
        <span class="pill" id="status-pill">Checking</span>
      </div>
    </header>

    <main>
      <div class="notice" id="restart-notice">Restart the connector to apply host, port, or TLS changes.</div>

      <section class="hero" aria-label="Connector overview">
        <div class="hero-main">
          <div class="topline">Service endpoint</div>
          <div class="hero-title">
            <h2>Connector service</h2>
            <span class="pill" id="protocol-pill">Checking</span>
          </div>
          <div class="hero-url" id="connector-url">Starting...</div>
          <div class="inline-meta">
            <span>Admin UI stays available when the connector is turned off.</span>
            <span class="code-chip" id="health-url">Health check pending</span>
          </div>
        </div>
        <div class="actions" style="margin-top:0;">
          <button id="refresh" type="button">Refresh</button>
          <button class="secondary" id="toggle-service" type="button">Turn off connector</button>
          <button class="danger" id="quit-app" type="button">Quit app</button>
        </div>
      </section>

      <section class="status-grid" aria-label="Connector status">
        <div class="stat">
          <span class="muted">Connector</span>
          <strong id="service-state">On</strong>
          <span id="host-name-state" class="muted">Host name not set</span>
        </div>
        <div class="stat">
          <span class="muted">Cached files</span>
          <strong id="cache-count">0</strong>
          <span id="cache-size" class="muted">0 B</span>
        </div>
        <div class="stat stat-success">
          <span class="muted">DLNA servers</span>
          <strong id="server-count">0</strong>
          <span id="resource-count" class="muted">0 resources</span>
        </div>
        <div class="stat stat-warning">
          <span class="muted">Transcoding</span>
          <strong id="ffmpeg-state">Unknown</strong>
          <span id="ffprobe-state" class="muted">Checking tools</span>
        </div>
        <div class="stat">
          <span class="muted">3D video</span>
          <strong id="stereo-state">SBS ready</strong>
          <span id="stereo-processor-state" class="muted">Processor pending</span>
        </div>
        <div class="stat">
          <span class="muted">Read-ahead</span>
          <strong id="read-ahead-state">Off</strong>
          <span id="read-ahead-size" class="muted">0 B buffered</span>
        </div>
      </section>

      <section class="panel">
        <div class="tabs" role="tablist" aria-label="Connector administration">
          <button class="tab-button active" id="settings-tab" type="button" role="tab" aria-selected="true" aria-controls="settings-tab-panel" data-admin-tab="settings">Connector Settings</button>
          <button class="tab-button" id="connections-tab" type="button" role="tab" aria-selected="false" aria-controls="connections-tab-panel" data-admin-tab="connections">Connections</button>
        </div>

        <div class="tab-panel" id="settings-tab-panel" role="tabpanel" aria-labelledby="settings-tab">
          <div class="panel-head">
            <div>
              <h2>Connector Settings</h2>
              <p class="panel-subtitle">Identity, room behavior, network, cache, and access controls.</p>
            </div>
          </div>
          <details class="collapsible" open>
            <summary>
              <span>
                <span class="summary-title">Room identity</span>
                <span class="summary-copy">How this connector appears to participants and watch rooms.</span>
              </span>
            </summary>
            <div class="collapsible-body form-stack">
              <label>Host name
                <input id="host-name" maxlength="80" autocomplete="name" placeholder="Shown to room participants">
              </label>
              <label class="check-row">
                <input id="pinned-watch-room" type="checkbox">
                Pin watch rooms
              </label>
            </div>
          </details>

          <details class="collapsible" open>
            <summary>
              <span>
                <span class="summary-title">Network and launch</span>
                <span class="summary-copy">Host, port, HTTPS, service state, and startup behavior.</span>
              </span>
            </summary>
            <div class="collapsible-body form-stack">
              <div class="form-grid">
                <label>Host
                  <div class="path-picker">
                    <input id="host" autocomplete="off">
                    <button class="secondary" id="use-lan-host" type="button">Use LAN IP</button>
                  </div>
                  <span class="field-hint" id="lan-host-hint">Detecting LAN IP...</span>
                </label>
                <label>Port
                  <input id="port" type="number" min="1" max="65535">
                </label>
              </div>
              <div class="toggle-grid">
                <label class="check-row">
                  <input id="use-tls" type="checkbox">
                  HTTPS connector
                </label>
                <label class="check-row">
                  <input id="service-enabled" type="checkbox">
                  Connector on
                </label>
                <label class="check-row">
                  <input id="open-browser" type="checkbox">
                  Open UI on launch
                </label>
                <label class="check-row">
                  <input id="allow-insecure-password" type="checkbox">
                  Allow password over HTTP
                </label>
              </div>
            </div>
          </details>

          <details class="collapsible" open>
            <summary>
              <span>
                <span class="summary-title">Cache location</span>
                <span class="summary-copy">Where stable MP4 and HLS segment caches are stored.</span>
              </span>
            </summary>
            <div class="collapsible-body">
              <label>Cache folder
                <div class="path-picker">
                  <input id="cache-dir" autocomplete="off">
                  <button class="secondary" id="choose-cache-dir" type="button">Choose</button>
                  <button class="secondary" id="move-cache" type="button">Move cache here</button>
                </div>
                <span class="field-hint">Use Move cache here to relocate existing cached files and remove the old folder.</span>
              </label>
              <label>Maximum cache size
                <div class="path-picker">
                  <input id="max-cache-gb" type="number" min="0" step="0.1">
                  <span class="input-suffix">GB</span>
                </div>
                <span class="field-hint">Set 0 for no automatic cache limit. When over the limit, older and lower-priority generated files are removed first.</span>
              </label>
            </div>
          </details>

          <details class="collapsible" open>
            <summary>
              <span>
                <span class="summary-title">3D generation defaults</span>
                <span class="summary-copy">Depth processor and internal inference size for real-time and prepared 3D streams.</span>
              </span>
            </summary>
            <div class="collapsible-body form-stack">
              <div class="form-grid">
                <label>Real-time processor
                  <select id="realtime-stereo-processor"></select>
                  <span class="field-hint">Used for generated 3D streams requested during playback.</span>
                </label>
                <label>Real-time inference
                  <select id="realtime-inference-scale">
                    <option value="1">1x internal</option>
                    <option value="0.75">0.75x internal</option>
                    <option value="0.5">0.5x internal</option>
                    <option value="0.33">0.33x internal</option>
                    <option value="0.25">0.25x internal</option>
                  </select>
                  <span class="field-hint">Default is Small at 0.5x while output stays full resolution unless changed in Player.</span>
                </label>
                <label>Prepared-cache processor
                  <select id="prebuild-stereo-processor"></select>
                  <span class="field-hint">Used by Convert to 3D for later when no explicit processor is requested.</span>
                </label>
                <label>Prepared-cache inference
                  <select id="prebuild-inference-scale">
                    <option value="1">1x internal</option>
                    <option value="0.75">0.75x internal</option>
                    <option value="0.5">0.5x internal</option>
                    <option value="0.33">0.33x internal</option>
                    <option value="0.25">0.25x internal</option>
                  </select>
                  <span class="field-hint">Default is Base at 0.75x for better prebuilt depth.</span>
                </label>
                <label>Real-time side crop
                  <div class="path-picker">
                    <input id="realtime-inference-crop" type="number" min="0" max="25" step="0.5">
                    <span class="input-suffix">%</span>
                  </div>
                </label>
                <label>Prepared-cache side crop
                  <div class="path-picker">
                    <input id="prebuild-inference-crop" type="number" min="0" max="25" step="0.5">
                    <span class="input-suffix">%</span>
                  </div>
                  <span class="field-hint">Default trims 7.5% from each side for depth inference, then outputs the full frame.</span>
                </label>
              </div>
            </div>
          </details>

          <details class="collapsible">
            <summary>
              <span>
                <span class="summary-title">Access</span>
                <span class="summary-copy">Optional local password protection for browser access.</span>
              </span>
            </summary>
            <div class="collapsible-body form-grid">
              <label>New password
                <input id="password" type="password" autocomplete="new-password">
              </label>
              <label class="check-row">
                <input id="clear-password" type="checkbox">
                Remove password
              </label>
            </div>
          </details>
          <div class="actions">
            <button id="save-config" type="button">Save settings</button>
          </div>
          <p class="path" id="config-path"></p>
        </div>

        <div class="tab-panel" id="connections-tab-panel" role="tabpanel" aria-labelledby="connections-tab" hidden>
          <div class="panel-head">
            <div>
              <h2>Connections</h2>
              <p class="panel-subtitle">Discovered DLNA servers and browsed resource mappings.</p>
            </div>
            <div class="actions" style="margin-top: 0;">
              <button id="scan" type="button">Scan DLNA</button>
              <button class="danger" id="clear-connections" type="button">Clear</button>
            </div>
          </div>
          <div class="scroll-table">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Model</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody id="server-rows">
                <tr><td colspan="3" class="empty-row">No servers scanned yet.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>3D Video</h2>
            <p class="panel-subtitle">Optional on-the-fly 2D to 3D HLS generation for participants that request SBS playback.</p>
          </div>
        </div>
        <div class="grid">
          <div class="stat">
            <span class="muted">Layouts</span>
            <strong>Half + Full SBS</strong>
            <span class="muted">Per-participant 3D HLS caches</span>
          </div>
          <div class="stat">
            <span class="muted">Default processor</span>
            <strong id="stereo-default-processor">Pending</strong>
            <span id="stereo-depth" class="muted">Depth pending</span>
          </div>
          <div class="stat">
            <span class="muted">Experimental</span>
            <strong>WebGPU</strong>
            <span class="muted">Browser-side where supported</span>
          </div>
        </div>
        <details class="collapsible" open style="margin-top:0.85rem;">
          <summary>
            <span>
              <span class="summary-title">Processor options</span>
              <span class="summary-copy">Quality and latency tradeoffs for M3-class Macs and local/browser processing.</span>
            </span>
          </summary>
          <div class="collapsible-body">
            <div class="info-list" id="stereo-processor-list">
              <div class="muted">Loading processor options...</div>
            </div>
          </div>
        </details>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Transcode Cache</h2>
            <p class="panel-subtitle">Browser-safe media files, HLS segments, and 3D variants generated for playback and sharing.</p>
          </div>
          <div class="actions" style="margin-top:0;">
            <button class="secondary" id="show-all-cache" type="button">Show all</button>
            <button class="secondary" id="refresh-cache" type="button">Refresh cache</button>
            <button class="secondary" id="prune-cache" type="button">Prune to limit</button>
            <button class="danger" id="clear-cache" type="button">Clear all</button>
          </div>
        </div>
        <p class="path" id="cache-path"></p>
        <div class="cache-groups" id="cache-groups"></div>
        <details class="collapsible" open>
          <summary>
            <span>
              <span class="summary-title">Cached entries</span>
              <span class="summary-copy" id="cache-filter-label">Showing all generated files and segment folders.</span>
            </span>
          </summary>
          <div class="collapsible-body">
            <div class="cache-entry-list" id="cache-entries">
              <div class="empty-row">No cached transcodes.</div>
            </div>
          </div>
        </details>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Activity</h2>
            <p class="panel-subtitle">Recent admin actions from this control panel.</p>
          </div>
        </div>
        <div class="log" id="log">Ready.</div>
      </section>
    </main>

    <script>
      const ADMIN_TOKEN = __ADMIN_TOKEN_JSON__;
      const headers = { "X-File-Pipe-Admin": ADMIN_TOKEN };
      const logEl = () => document.getElementById("log");
      let detectedLanIp = "";
      let cacheFilter = "all";
      let activeAdminTab = "settings";

      function log(message) {
        const time = new Date().toLocaleTimeString();
        logEl().textContent = `[${time}] ${message}\n` + logEl().textContent;
      }

      function formatBytes(bytes) {
        const units = ["B", "KB", "MB", "GB", "TB"];
        let value = Number(bytes || 0);
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
          value /= 1024;
          unit += 1;
        }
        return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
      }

      async function api(path, options = {}) {
        const response = await fetch(path, {
          ...options,
          headers: {
            ...headers,
            ...(options.headers || {}),
          },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload.error || `Request failed with ${response.status}`);
        }
        return payload;
      }

      function setValue(id, value) {
        document.getElementById(id).value = value ?? "";
      }

      function setChecked(id, value) {
        document.getElementById(id).checked = Boolean(value);
      }

      function setSelectOptions(id, options, selectedValue) {
        const select = document.getElementById(id);
        if (!select) return;
        const current = selectedValue || select.value;
        select.innerHTML = options.map((option) => `
          <option value="${escapeHtml(option.id)}">${escapeHtml(option.label || option.id)}</option>
        `).join("");
        if (current) select.value = current;
      }

      function useLanHost() {
        if (!detectedLanIp) {
          log("No LAN IP was detected.");
          return;
        }
        document.getElementById("host").value = detectedLanIp;
        log(`Host set to ${detectedLanIp}. Save settings and restart the connector.`);
      }

      function setAdminTab(tab) {
        activeAdminTab = tab === "connections" ? "connections" : "settings";
        for (const button of document.querySelectorAll("[data-admin-tab]")) {
          const selected = button.dataset.adminTab === activeAdminTab;
          button.classList.toggle("active", selected);
          button.setAttribute("aria-selected", selected ? "true" : "false");
        }
        document.getElementById("settings-tab-panel").hidden = activeAdminTab !== "settings";
        document.getElementById("connections-tab-panel").hidden = activeAdminTab !== "connections";
      }

      function renderConfig(config, configPath) {
        setValue("host", config.host);
        setValue("port", config.port);
        setValue("cache-dir", config.cacheDir);
        setValue("max-cache-gb", config.maxCacheBytes ? (Number(config.maxCacheBytes) / (1024 ** 3)).toFixed(1).replace(/\.0$/, "") : "0");
        setValue("host-name", config.hostName);
        setValue("realtime-stereo-processor", config.realtimeStereo3dProcessor);
        setValue("realtime-inference-scale", config.realtimeStereo3dInferenceScale);
        setValue("realtime-inference-crop", config.realtimeStereo3dInferenceCropPercent);
        setValue("prebuild-stereo-processor", config.prebuildStereo3dProcessor);
        setValue("prebuild-inference-scale", config.prebuildStereo3dInferenceScale);
        setValue("prebuild-inference-crop", config.prebuildStereo3dInferenceCropPercent);
        setChecked("use-tls", config.useTls);
        setChecked("service-enabled", config.serviceEnabled);
        setChecked("open-browser", config.openBrowser);
        setChecked("pinned-watch-room", config.pinnedWatchRoom);
        setChecked("allow-insecure-password", config.allowInsecurePassword);
        document.getElementById("config-path").textContent = `Config: ${configPath}`;
      }

      function renderServers(servers) {
        const body = document.getElementById("server-rows");
        if (!servers.length) {
          body.innerHTML = '<tr><td colspan="3" class="empty-row">No servers scanned yet.</td></tr>';
          return;
        }
        body.innerHTML = servers.map((server) => `
          <tr>
            <td><strong>${escapeHtml(server.friendlyName || "")}</strong></td>
            <td>${escapeHtml([server.manufacturer, server.modelName].filter(Boolean).join(" "))}</td>
            <td class="path">${escapeHtml(server.location || "")}</td>
          </tr>
        `).join("");
      }

      function cacheGroupMeta(cache) {
        const groups = new Map((cache.groups || []).map((group) => [group.category, group]));
        return [
          { category: "hls-3d-full", label: "Full SBS", ...(groups.get("hls-3d-full") || {}) },
          { category: "hls-3d-half", label: "Half SBS", ...(groups.get("hls-3d-half") || {}) },
          { category: "hls-2d", label: "HLS 2D", ...(groups.get("hls-2d") || {}) },
          { category: "stable-mp4", label: "Stable MP4", ...(groups.get("stable-mp4") || {}) },
          { category: "stable-mp4-spatial", label: "Spatial MP4", ...(groups.get("stable-mp4-spatial") || {}) },
          { category: "in-progress", label: "In progress", ...(groups.get("in-progress") || {}) },
        ].map((group) => ({
          category: group.category,
          label: group.label,
          count: Number(group.count || 0),
          size: Number(group.size || 0),
          segmentCount: Number(group.segmentCount || 0),
          errorCount: Number(group.errorCount || 0),
        }));
      }

      function renderCacheGroups(cache) {
        const container = document.getElementById("cache-groups");
        container.innerHTML = cacheGroupMeta(cache).map((group) => `
          <button class="cache-filter ${cacheFilter === group.category ? "active" : ""}" type="button" data-cache-filter="${escapeHtml(group.category)}">
            <span class="badge">${escapeHtml(group.label)}</span>
            <strong>${group.count}</strong>
            <span class="muted">${formatBytes(group.size)}</span>
            <span class="muted">${group.segmentCount ? `${group.segmentCount} segments` : "No segments"}</span>
            ${group.errorCount ? `<span class="badge warn">${group.errorCount} failed</span>` : ""}
          </button>
        `).join("");
      }

      function renderCache(cache) {
        document.getElementById("cache-count").textContent = cache.count || 0;
        document.getElementById("cache-size").textContent = formatBytes(cache.size || 0);
        const limit = Number(cache.maxCacheBytes || 0);
        const limitText = limit > 0
          ? `Limit: ${formatBytes(limit)} (${formatBytes(cache.availableBytes || 0)} available)`
          : "Limit: unlimited";
        document.getElementById("cache-path").textContent = `Cache: ${cache.cacheDir} • ${limitText}`;
        renderCacheGroups(cache);
        document.getElementById("cache-filter-label").textContent = cacheFilter === "all"
          ? "Showing all generated files and segment folders."
          : `Showing ${cacheGroupMeta(cache).find((group) => group.category === cacheFilter)?.label || cacheFilter}.`;
        const body = document.getElementById("cache-entries");
        const files = cacheFilter === "all"
          ? (cache.files || [])
          : (cache.files || []).filter((file) => file.category === cacheFilter);
        if (!files.length) {
          body.innerHTML = '<div class="empty-row">No cached transcodes in this group.</div>';
          return;
        }
        const videos = new Map();
        for (const file of files) {
          const key = file.videoKey || file.name;
          if (!videos.has(key)) {
            videos.set(key, { label: file.videoLabel || key, files: [], size: 0, segmentCount: 0, errorCount: 0 });
          }
          const video = videos.get(key);
          video.files.push(file);
          video.size += Number(file.size || 0);
          video.segmentCount += Number(file.segmentCount || 0);
          video.errorCount += Number(file.errorCount || 0);
        }
        body.innerHTML = [...videos.values()].map((video) => `
          <details class="cache-video" open>
            <summary>
              <span>
                <span class="cache-video-title">${escapeHtml(video.label)}</span>
                <span class="profile-line">${video.files.length} cached ${video.files.length === 1 ? "entry" : "entries"}</span>
              </span>
              <span class="muted">${formatBytes(video.size)}</span>
              <span class="muted">${video.segmentCount ? `${video.segmentCount} segments` : ""}</span>
              ${video.errorCount ? `<span class="badge warn">${video.errorCount} failed</span>` : ""}
            </summary>
            <div class="cache-video-body scroll-table">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Group</th>
                    <th>Segments</th>
                    <th>Size</th>
                    <th>Modified</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${video.files.map((file) => `
                    <tr>
                      <td>
                        <span class="cache-file">${escapeHtml(file.name)}</span>
                        <span class="profile-line">${escapeHtml([file.profileLabel, file.processorLabel].filter(Boolean).join(" · "))}</span>
                        ${file.lastError ? `<span class="profile-line danger-text">${escapeHtml(file.lastError)}</span>` : ""}
                      </td>
                      <td>${escapeHtml(file.categoryLabel || file.kind || "Transcode")}</td>
                      <td>${file.segmentCount ? escapeHtml(String(file.segmentCount)) : ""}</td>
                      <td>${formatBytes(file.size)}</td>
                      <td>${escapeHtml(new Date(file.modifiedAt).toLocaleString())}</td>
                      <td><button class="danger" type="button" data-delete-cache="${encodeURIComponent(file.name)}">Delete</button></td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          </details>
        `).join("");
      }

      function renderStereo3d(stereo3d) {
        const processors = stereo3d?.processors || [];
        const defaultProcessor = stereo3d?.defaultRealtimeProcessor || stereo3d?.defaultProcessor || "";
        const prebuildProcessor = stereo3d?.defaultPrebuildProcessor || "";
        const selected = processors.find((processor) => processor.id === defaultProcessor);
        const prepared = processors.find((processor) => processor.id === prebuildProcessor);
        setSelectOptions("realtime-stereo-processor", processors, defaultProcessor);
        setSelectOptions("prebuild-stereo-processor", processors.filter((processor) => !processor.browserOnly), prebuildProcessor);
        document.getElementById("stereo-state").textContent = "Half + Full SBS";
        document.getElementById("stereo-processor-state").textContent = selected?.label || defaultProcessor || "Fast ffmpeg shift";
        document.getElementById("stereo-default-processor").textContent = selected?.label || defaultProcessor || "Fast ffmpeg shift";
        document.getElementById("stereo-depth").textContent = `Real-time ${stereo3d?.defaultInferenceScale || "0.5"}x, prepared ${stereo3d?.defaultPrebuildInferenceScale || "0.75"}x${prepared?.label ? ` via ${prepared.label}` : ""}`;
        const list = document.getElementById("stereo-processor-list");
        if (!processors.length) {
          list.innerHTML = '<div class="muted">No processor metadata available.</div>';
          return;
        }
        list.innerHTML = processors.map((processor) => `
          <div class="info-row">
            <div>
              <strong>${escapeHtml(processor.label || processor.id)}</strong>
              <span class="profile-line">${processor.id === defaultProcessor ? "Default" : ""}${processor.browserOnly ? " Browser/WebGPU" : ""}</span>
            </div>
            <div>${escapeHtml(processor.bestUse || "")}</div>
            <div>
              ${escapeHtml(processor.m3Practicality || "")}
              <span class="profile-line">${processor.requiresCommand ? "Requires local helper command" : "No helper command required"}</span>
            </div>
          </div>
        `).join("");
      }

      function renderStatus(payload) {
        detectedLanIp = payload.lanIp || "";
        document.getElementById("connector-url").textContent = payload.connectorUrl;
        document.getElementById("health-url").textContent = payload.healthUrl;
        document.getElementById("lan-host-hint").textContent = detectedLanIp
          ? `LAN devices can use ${payload.lanConnectorUrl || `${payload.connectorUrl.split("://")[0]}://${detectedLanIp}:${payload.config.port}`}. Save and restart after selecting this address.`
          : "No LAN IP detected. Enter a host manually if needed.";
        document.getElementById("use-lan-host").disabled = !detectedLanIp;
        document.getElementById("protocol-pill").textContent = payload.connectorUrl.startsWith("https://") ? "HTTPS" : "HTTP";
        document.getElementById("protocol-pill").className = `pill ${payload.connectorUrl.startsWith("https://") ? "ready" : "warn"}`;
        document.getElementById("status-pill").textContent = payload.restartRequired ? "Restart needed" : (payload.serviceEnabled ? "Running" : "Off");
        document.getElementById("status-pill").className = `pill ${payload.restartRequired || !payload.serviceEnabled ? "warn" : "ready"}`;
        document.getElementById("restart-notice").className = `notice ${payload.restartRequired ? "show" : ""}`;
        document.getElementById("service-state").textContent = payload.serviceEnabled ? "On" : "Off";
        document.getElementById("host-name-state").textContent = payload.settings?.hostName || "Host name not set";
        document.getElementById("toggle-service").textContent = payload.serviceEnabled ? "Turn off connector" : "Turn on connector";
        document.getElementById("server-count").textContent = payload.connections.serverCount || 0;
        document.getElementById("resource-count").textContent = `${payload.connections.resourceCount || 0} resources`;
        document.getElementById("ffmpeg-state").textContent = payload.ffmpegAvailable ? "Ready" : "Missing";
        document.getElementById("ffprobe-state").textContent = payload.ffprobeAvailable ? "ffprobe ready" : "ffprobe missing";
        document.getElementById("read-ahead-state").textContent = payload.readAhead?.enabled ? "On" : "Off";
        document.getElementById("read-ahead-size").textContent = `${formatBytes(payload.readAhead?.cachedBytes || 0)} buffered`;
        renderStereo3d(payload.stereo3d);
        renderConfig(payload.config, payload.configPath);
        renderServers(payload.connections.servers || []);
        renderCache(payload.cache);
      }

      function escapeHtml(value) {
        const div = document.createElement("div");
        div.textContent = value;
        return div.innerHTML;
      }

      async function refresh() {
        const payload = await api("/admin/api/status");
        renderStatus(payload);
      }

      async function saveConfig() {
        const payload = {
          host: document.getElementById("host").value.trim(),
          port: Number(document.getElementById("port").value),
          cacheDir: document.getElementById("cache-dir").value.trim(),
          maxCacheBytes: Math.max(0, Number(document.getElementById("max-cache-gb").value || 0)) * (1024 ** 3),
          hostName: document.getElementById("host-name").value.trim(),
          useTls: document.getElementById("use-tls").checked,
          serviceEnabled: document.getElementById("service-enabled").checked,
          openBrowser: document.getElementById("open-browser").checked,
          pinnedWatchRoom: document.getElementById("pinned-watch-room").checked,
          realtimeStereo3dProcessor: document.getElementById("realtime-stereo-processor").value,
          realtimeStereo3dInferenceScale: document.getElementById("realtime-inference-scale").value,
          realtimeStereo3dInferenceCropPercent: Number(document.getElementById("realtime-inference-crop").value || 0),
          prebuildStereo3dProcessor: document.getElementById("prebuild-stereo-processor").value,
          prebuildStereo3dInferenceScale: document.getElementById("prebuild-inference-scale").value,
          prebuildStereo3dInferenceCropPercent: Number(document.getElementById("prebuild-inference-crop").value || 0),
          allowInsecurePassword: document.getElementById("allow-insecure-password").checked,
          clearPassword: document.getElementById("clear-password").checked,
        };
        const password = document.getElementById("password").value;
        if (password) payload.password = password;
        const result = await api("/admin/api/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        document.getElementById("password").value = "";
        document.getElementById("clear-password").checked = false;
        renderCache(result.cache);
        await refresh();
        if (result.cachePrune?.deleted) {
          log(`Settings saved. Pruned ${result.cachePrune.deleted} cache entr${result.cachePrune.deleted === 1 ? "y" : "ies"} (${formatBytes(result.cachePrune.bytesDeleted || 0)}).`);
        } else {
          log("Settings saved.");
        }
      }

      async function chooseCacheDir() {
        log("Opening folder picker...");
        const payload = await api("/admin/api/pick-directory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPath: document.getElementById("cache-dir").value }),
        });
        if (payload.cancelled) {
          log("Folder selection cancelled.");
          return;
        }
        document.getElementById("cache-dir").value = payload.path || "";
        log("Cache folder selected. Use Move cache here to relocate existing cached files, or Save settings to switch without moving.");
      }

      async function moveCache() {
        const cacheDir = document.getElementById("cache-dir").value.trim();
        if (!cacheDir) {
          log("Choose a cache folder first.");
          return;
        }
        if (!confirm("Move the existing transcode cache to this folder and remove the old cache folder?")) return;
        const payload = await api("/admin/api/cache/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cacheDir }),
        });
        renderConfig(payload.config, payload.configPath || document.getElementById("config-path").textContent.replace(/^Config: /, ""));
        renderCache(payload.cache);
        log(payload.moved
          ? `Moved ${payload.entryCount || 0} cache entr${payload.entryCount === 1 ? "y" : "ies"} (${formatBytes(payload.bytesMoved || 0)}).`
          : "Cache folder is already current.");
      }

      async function scanServers() {
        log("Scanning for DLNA servers...");
        const payload = await api("/admin/api/discover", { method: "POST" });
        renderServers(payload.servers || []);
        await refresh();
        log(`Scan complete. Found ${(payload.servers || []).length} server(s).`);
      }

      async function clearConnections() {
        await api("/admin/api/connections", { method: "DELETE" });
        await refresh();
        log("Remembered connections cleared.");
      }

      async function refreshCache() {
        const cache = await api("/admin/api/cache");
        renderCache(cache);
        log("Cache refreshed.");
      }

      async function clearCache() {
        const payload = await api("/admin/api/cache", { method: "DELETE" });
        renderCache(payload.cache);
        log(`Deleted ${payload.deleted} cached file(s).`);
      }

      async function pruneCache() {
        const payload = await api("/admin/api/cache/prune", { method: "POST" });
        renderCache(payload.cache);
        log(payload.deleted
          ? `Pruned ${payload.deleted} cache entr${payload.deleted === 1 ? "y" : "ies"} (${formatBytes(payload.bytesDeleted || 0)}).`
          : "Cache is already within the configured limit.");
      }

      async function deleteCacheFile(name) {
        const payload = await api(`/admin/api/cache/${name}`, { method: "DELETE" });
        renderCache(payload.cache);
        log("Cached file deleted.");
      }

      async function toggleService() {
        const enabled = !document.getElementById("service-enabled").checked;
        document.getElementById("service-enabled").checked = enabled;
        await saveConfig();
        log(enabled ? "Connector turned on." : "Connector turned off. The admin UI remains available.");
      }

      function wire(id, handler) {
        document.getElementById(id).addEventListener("click", async (event) => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await handler(event);
          } catch (error) {
            log(error.message);
          } finally {
            button.disabled = false;
          }
        });
      }

      wire("save-config", saveConfig);
      wire("use-lan-host", useLanHost);
      wire("choose-cache-dir", chooseCacheDir);
      wire("move-cache", moveCache);
      wire("scan", scanServers);
      wire("refresh", async () => {
        await refresh();
        log("Status refreshed.");
      });
      wire("clear-connections", clearConnections);
      wire("refresh-cache", refreshCache);
      wire("prune-cache", pruneCache);
      wire("clear-cache", clearCache);
      wire("show-all-cache", async () => {
        cacheFilter = "all";
        await refreshCache();
      });
      wire("toggle-service", toggleService);
      wire("copy-url", async () => {
        await navigator.clipboard.writeText(document.getElementById("connector-url").textContent);
        log("Connector URL copied.");
      });
      wire("quit-app", async () => {
        await api("/admin/api/shutdown", { method: "POST" });
        log("Connector shutdown requested.");
      });

      document.getElementById("cache-entries").addEventListener("click", async (event) => {
        const button = event.target.closest("[data-delete-cache]");
        if (!button) return;
        button.disabled = true;
        try {
          await deleteCacheFile(button.dataset.deleteCache);
        } catch (error) {
          log(error.message);
        } finally {
          button.disabled = false;
        }
      });

      document.getElementById("cache-groups").addEventListener("click", async (event) => {
        const button = event.target.closest("[data-cache-filter]");
        if (!button) return;
        cacheFilter = button.dataset.cacheFilter || "all";
        await refreshCache();
      });

      document.querySelectorAll("[data-admin-tab]").forEach((button) => {
        button.addEventListener("click", () => setAdminTab(button.dataset.adminTab));
      });

      refresh().catch((error) => log(error.message));
      window.setInterval(() => refresh().catch(() => {}), 5000);
    </script>
  </body>
</html>
"""
