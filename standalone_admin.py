import datetime as dt
import json
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


def is_loopback_address(value: str) -> bool:
    try:
        address = ip_address(value)
    except ValueError:
        return value in {"localhost"}
    if address.is_loopback:
        return True
    mapped = getattr(address, "ipv4_mapped", None)
    return bool(mapped and mapped.is_loopback)


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


def cache_entry_kind(path: Path) -> str:
    name = path.name
    if path.is_dir():
        return "HLS segments"
    if ".part" in name:
        return "In progress"
    if name.endswith(".mp4"):
        return "Stable MP4"
    return "Transcode"


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
        if path.is_dir() and not path.name.startswith(local_connector.HLS_SEGMENT_CACHE_VERSION):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        size = path_size(path)
        entries.append(
            {
                "name": path.name,
                "path": str(path),
                "kind": cache_entry_kind(path),
                "size": size,
                "modifiedAt": format_timestamp(stat.st_mtime),
            }
        )
    return entries


def cache_payload() -> Dict[str, object]:
    entries = transcode_files()
    return {
        "cacheDir": str(cache_dir()),
        "files": entries,
        "count": len(entries),
        "size": sum(int(entry["size"]) for entry in entries),
    }


def safe_cache_path(name: str) -> Path:
    directory = cache_dir().resolve()
    path = (directory / name).resolve()
    if path.parent != directory:
        raise ValueError("Invalid cache file.")
    if path.is_dir():
        if not path.name.startswith(local_connector.HLS_SEGMENT_CACHE_VERSION):
            raise ValueError("Invalid cache entry.")
        return path
    if path.suffix not in {".mp4", ".part"}:
        raise ValueError("Invalid cache file.")
    return path


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
        if not is_loopback_address(request.remote_addr or ""):
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
                "healthUrl": f"{runtime.connector_url}/health",
                "configPath": str(runtime.config_path),
                "restartRequired": runtime.restart_required,
                "serviceEnabled": bool(local_connector.CONNECTOR_SERVICE_ENABLED),
                "authRequired": bool(security.password_hash),
                "allowInsecurePassword": bool(security.allow_insecure_password),
                "activeSessions": len(sessions),
                "ffprobeAvailable": ffprobe_available,
                "ffmpegAvailable": ffmpeg_available,
                "cache": cache_payload(),
                "connections": {
                    "servers": [local_connector.serialize_server(server) for server in local_connector.SERVER_CACHE.values()],
                    "serverCount": len(local_connector.SERVER_CACHE),
                    "resourceCount": len(local_connector.RESOURCE_CACHE),
                },
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
        grid-template-columns: minmax(0, 1fr) auto;
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
        .grid, .columns, .settings-layout, .form-grid, .toggle-grid, .hero {
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

      <section class="grid" aria-label="Connector status">
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
        <div class="stat">
          <span class="muted">Auth</span>
          <strong id="auth-state">Off</strong>
          <span id="session-count" class="muted">0 sessions</span>
        </div>
        <div class="stat stat-warning">
          <span class="muted">Transcoding</span>
          <strong id="ffmpeg-state">Unknown</strong>
          <span id="ffprobe-state" class="muted">Checking tools</span>
        </div>
        <div class="stat">
          <span class="muted">Read-ahead</span>
          <strong id="read-ahead-state">Off</strong>
          <span id="read-ahead-size" class="muted">0 B buffered</span>
        </div>
      </section>

      <section class="columns">
        <div class="panel">
          <div class="panel-head">
            <div>
              <h2>Connector Settings</h2>
              <p class="panel-subtitle">Identity, room behavior, network, cache, and access controls.</p>
            </div>
          </div>
          <div class="settings-layout">
            <div class="form-stack">
              <div>
                <div class="section-title">Room identity</div>
                <div class="form-stack">
                  <label>Host name
                    <input id="host-name" maxlength="80" autocomplete="name" placeholder="Shown to room participants">
                  </label>
                  <label class="check-row">
                    <input id="pinned-watch-room" type="checkbox">
                    Pin watch rooms
                  </label>
                </div>
              </div>

              <div>
                <div class="section-title">Cache</div>
                <label>Cache folder
                  <div class="path-picker">
                    <input id="cache-dir" autocomplete="off">
                    <button class="secondary" id="choose-cache-dir" type="button">Choose</button>
                  </div>
                </label>
              </div>
            </div>

            <div class="form-stack">
              <div>
                <div class="section-title">Network</div>
                <div class="form-grid">
                  <label>Host
                    <input id="host" autocomplete="off">
                  </label>
                  <label>Port
                    <input id="port" type="number" min="1" max="65535">
                  </label>
                </div>
                <div class="toggle-grid" style="margin-top: 0.85rem;">
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

              <div>
                <div class="section-title">Access</div>
                <div class="form-grid">
                  <label>New password
                    <input id="password" type="password" autocomplete="new-password">
                  </label>
                  <label class="check-row">
                    <input id="clear-password" type="checkbox">
                    Remove password
                  </label>
                </div>
              </div>
            </div>
          </div>
          <div class="actions">
            <button id="save-config" type="button">Save settings</button>
          </div>
          <p class="path" id="config-path"></p>
        </div>

        <div class="panel">
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
            <h2>Transcode Cache</h2>
            <p class="panel-subtitle">Browser-safe media files generated by ffmpeg for playback and sharing.</p>
          </div>
          <div class="actions" style="margin-top:0;">
            <button class="secondary" id="refresh-cache" type="button">Refresh cache</button>
            <button class="danger" id="clear-cache" type="button">Clear all</button>
          </div>
        </div>
        <p class="path" id="cache-path"></p>
        <div class="scroll-table">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Type</th>
                <th>Size</th>
                <th>Modified</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="cache-rows">
              <tr><td colspan="5" class="empty-row">No cached transcodes.</td></tr>
            </tbody>
          </table>
        </div>
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

      function renderConfig(config, configPath) {
        setValue("host", config.host);
        setValue("port", config.port);
        setValue("cache-dir", config.cacheDir);
        setValue("host-name", config.hostName);
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

      function renderCache(cache) {
        document.getElementById("cache-count").textContent = cache.count || 0;
        document.getElementById("cache-size").textContent = formatBytes(cache.size || 0);
        document.getElementById("cache-path").textContent = `Cache: ${cache.cacheDir}`;
        const body = document.getElementById("cache-rows");
        if (!cache.files.length) {
          body.innerHTML = '<tr><td colspan="5" class="empty-row">No cached transcodes.</td></tr>';
          return;
        }
        body.innerHTML = cache.files.map((file) => `
          <tr>
            <td><span class="cache-file">${escapeHtml(file.name)}</span></td>
            <td>${escapeHtml(file.kind || "Transcode")}</td>
            <td>${formatBytes(file.size)}</td>
            <td>${escapeHtml(file.modifiedAt)}</td>
            <td><button class="danger" type="button" data-delete-cache="${encodeURIComponent(file.name)}">Delete</button></td>
          </tr>
        `).join("");
      }

      function renderStatus(payload) {
        document.getElementById("connector-url").textContent = payload.connectorUrl;
        document.getElementById("health-url").textContent = payload.healthUrl;
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
        document.getElementById("auth-state").textContent = payload.authRequired ? "On" : "Off";
        document.getElementById("session-count").textContent = `${payload.activeSessions || 0} sessions`;
        document.getElementById("ffmpeg-state").textContent = payload.ffmpegAvailable ? "Ready" : "Missing";
        document.getElementById("ffprobe-state").textContent = payload.ffprobeAvailable ? "ffprobe ready" : "ffprobe missing";
        document.getElementById("read-ahead-state").textContent = payload.readAhead?.enabled ? "On" : "Off";
        document.getElementById("read-ahead-size").textContent = `${formatBytes(payload.readAhead?.cachedBytes || 0)} buffered`;
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
          hostName: document.getElementById("host-name").value.trim(),
          useTls: document.getElementById("use-tls").checked,
          serviceEnabled: document.getElementById("service-enabled").checked,
          openBrowser: document.getElementById("open-browser").checked,
          pinnedWatchRoom: document.getElementById("pinned-watch-room").checked,
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
        log("Settings saved.");
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
        log("Cache folder selected. Save settings to apply it.");
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
      wire("choose-cache-dir", chooseCacheDir);
      wire("scan", scanServers);
      wire("refresh", async () => {
        await refresh();
        log("Status refreshed.");
      });
      wire("clear-connections", clearConnections);
      wire("refresh-cache", refreshCache);
      wire("clear-cache", clearCache);
      wire("toggle-service", toggleService);
      wire("copy-url", async () => {
        await navigator.clipboard.writeText(document.getElementById("connector-url").textContent);
        log("Connector URL copied.");
      });
      wire("quit-app", async () => {
        await api("/admin/api/shutdown", { method: "POST" });
        log("Connector shutdown requested.");
      });

      document.getElementById("cache-rows").addEventListener("click", async (event) => {
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

      refresh().catch((error) => log(error.message));
      window.setInterval(() => refresh().catch(() => {}), 5000);
    </script>
  </body>
</html>
"""
