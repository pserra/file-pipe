import datetime as dt
import json
from ipaddress import ip_address
from pathlib import Path
from typing import Dict, List

from flask import Blueprint, Response, jsonify, request
from werkzeug.security import generate_password_hash

import local_connector
from standalone_config import normalize_config, public_config


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


def transcode_files() -> List[Dict[str, object]]:
    directory = cache_dir()
    if not directory.exists():
        return []
    entries = []
    for path in sorted(directory.iterdir(), key=lambda item: item.stat().st_mtime if item.exists() else 0, reverse=True):
        if not path.is_file():
            continue
        if path.suffix not in {".mp4", ".part"}:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        entries.append(
            {
                "name": path.name,
                "path": str(path),
                "size": stat.st_size,
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
    if path.suffix not in {".mp4", ".part"}:
        raise ValueError("Invalid cache file.")
    return path


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
                "config": public_config(runtime.config),
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
                size = path.stat().st_size
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
        size = path.stat().st_size
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
        security.allow_insecure_password = bool(updated["allowInsecurePassword"])
        runtime.save_config(updated)
        if cache_changed:
            local_connector.TRANSCODE_CACHE_DIR = Path(updated["cacheDir"]).expanduser()
        if network_changed:
            runtime.mark_restart_required()
        return jsonify(
            {
                "ok": True,
                "config": public_config(runtime.config),
                "restartRequired": runtime.restart_required,
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
        --bg: #f4f6f8;
        --panel: #ffffff;
        --muted: #667085;
        --text: #172033;
        --border: #d8e0ea;
        --soft: #eef2f6;
        --primary: #2563eb;
        --danger: #c0392b;
        --success: #16845b;
      }

      * {
        box-sizing: border-box;
      }

      body {
        background: var(--bg);
        color: var(--text);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
      }

      header {
        align-items: center;
        background: var(--panel);
        border-bottom: 1px solid var(--border);
        display: flex;
        flex-wrap: wrap;
        gap: 1rem;
        justify-content: space-between;
        padding: 1rem clamp(1rem, 3vw, 2rem);
        position: sticky;
        top: 0;
        z-index: 2;
      }

      h1, h2, h3, p {
        margin-top: 0;
      }

      h1 {
        font-size: 1.35rem;
        margin-bottom: 0.15rem;
      }

      h2 {
        font-size: 1rem;
        margin-bottom: 0.8rem;
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
        justify-content: center;
        min-height: 2.4rem;
        padding: 0.5rem 0.85rem;
      }

      button.secondary {
        background: #ffffff;
        border-color: var(--border);
        color: var(--text);
      }

      button.danger {
        background: #ffffff;
        border-color: #f0b7ae;
        color: var(--danger);
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

      input[type="checkbox"] {
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
        gap: 1rem;
        margin: 0 auto;
        max-width: 1180px;
        padding: 1rem clamp(1rem, 3vw, 2rem) 2rem;
      }

      .muted {
        color: var(--muted);
      }

      .topline {
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 800;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      .pill {
        border: 1px solid var(--border);
        border-radius: 999px;
        display: inline-flex;
        font-size: 0.85rem;
        font-weight: 800;
        min-height: 2.2rem;
        padding: 0.45rem 0.8rem;
        white-space: nowrap;
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

      .grid {
        display: grid;
        gap: 1rem;
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .columns {
        display: grid;
        gap: 1rem;
        grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 1rem;
      }

      .stat {
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 8px;
        min-width: 0;
        padding: 1rem;
      }

      .stat strong {
        display: block;
        font-size: 1.25rem;
        overflow-wrap: anywhere;
      }

      .form-grid {
        display: grid;
        gap: 0.85rem;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .check-row {
        align-items: center;
        display: flex;
        gap: 0.55rem;
        min-height: 2.4rem;
      }

      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.6rem;
        margin-top: 1rem;
      }

      table {
        border-collapse: collapse;
        width: 100%;
      }

      th, td {
        border-bottom: 1px solid var(--soft);
        font-size: 0.9rem;
        padding: 0.7rem 0.55rem;
        text-align: left;
        vertical-align: middle;
      }

      th {
        color: #475467;
        font-size: 0.75rem;
        text-transform: uppercase;
      }

      td:last-child, th:last-child {
        text-align: right;
      }

      .scroll-table {
        overflow-x: auto;
      }

      .path {
        color: var(--muted);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.8rem;
        overflow-wrap: anywhere;
      }

      .notice {
        background: #eef4ff;
        border: 1px solid #cfe0ff;
        border-radius: 8px;
        color: #1d4ed8;
        display: none;
        margin-bottom: 1rem;
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

      @media (max-width: 920px) {
        .grid, .columns, .form-grid {
          grid-template-columns: 1fr;
        }

        header {
          align-items: stretch;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div>
        <div class="topline">Local connector</div>
        <h1>File Pipe Connector</h1>
        <div class="muted" id="connector-url">Starting...</div>
      </div>
      <span class="pill" id="status-pill">Checking</span>
    </header>

    <main>
      <div class="notice" id="restart-notice">Restart the connector to apply host, port, or TLS changes.</div>

      <section class="grid" aria-label="Connector status">
        <div class="stat">
          <span class="muted">Cached files</span>
          <strong id="cache-count">0</strong>
          <span id="cache-size" class="muted">0 B</span>
        </div>
        <div class="stat">
          <span class="muted">DLNA servers</span>
          <strong id="server-count">0</strong>
          <span id="resource-count" class="muted">0 resources</span>
        </div>
        <div class="stat">
          <span class="muted">Auth</span>
          <strong id="auth-state">Off</strong>
          <span id="session-count" class="muted">0 sessions</span>
        </div>
        <div class="stat">
          <span class="muted">Transcoding</span>
          <strong id="ffmpeg-state">Unknown</strong>
          <span id="ffprobe-state" class="muted">Checking tools</span>
        </div>
      </section>

      <section class="columns">
        <div class="panel">
          <h2>Settings</h2>
          <div class="form-grid">
            <label>Host
              <input id="host" autocomplete="off">
            </label>
            <label>Port
              <input id="port" type="number" min="1" max="65535">
            </label>
            <label>Cache folder
              <input id="cache-dir" autocomplete="off">
            </label>
            <label>New password
              <input id="password" type="password" autocomplete="new-password">
            </label>
          </div>
          <div class="form-grid" style="margin-top: 0.85rem;">
            <label class="check-row">
              <input id="use-tls" type="checkbox">
              HTTPS connector
            </label>
            <label class="check-row">
              <input id="open-browser" type="checkbox">
              Open UI on launch
            </label>
            <label class="check-row">
              <input id="allow-insecure-password" type="checkbox">
              Allow password over HTTP
            </label>
            <label class="check-row">
              <input id="clear-password" type="checkbox">
              Remove password
            </label>
          </div>
          <div class="actions">
            <button id="save-config" type="button">Save settings</button>
            <button class="secondary" id="copy-url" type="button">Copy connector URL</button>
            <button class="danger" id="quit-app" type="button">Quit connector</button>
          </div>
          <p class="path" id="config-path"></p>
        </div>

        <div class="panel">
          <h2>Connections</h2>
          <div class="actions" style="margin-top: 0;">
            <button id="scan" type="button">Scan DLNA</button>
            <button class="secondary" id="refresh" type="button">Refresh</button>
            <button class="danger" id="clear-connections" type="button">Clear remembered</button>
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
                <tr><td colspan="3" class="muted">No servers scanned yet.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="panel">
        <div style="display:flex; flex-wrap:wrap; gap:0.75rem; justify-content:space-between; align-items:center;">
          <h2 style="margin-bottom:0;">Transcode Cache</h2>
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
                <th>Size</th>
                <th>Modified</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="cache-rows">
              <tr><td colspan="4" class="muted">No cached transcodes.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="panel">
        <h2>Activity</h2>
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
        setChecked("use-tls", config.useTls);
        setChecked("open-browser", config.openBrowser);
        setChecked("allow-insecure-password", config.allowInsecurePassword);
        document.getElementById("config-path").textContent = `Config: ${configPath}`;
      }

      function renderServers(servers) {
        const body = document.getElementById("server-rows");
        if (!servers.length) {
          body.innerHTML = '<tr><td colspan="3" class="muted">No servers scanned yet.</td></tr>';
          return;
        }
        body.innerHTML = servers.map((server) => `
          <tr>
            <td>${escapeHtml(server.friendlyName || "")}</td>
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
          body.innerHTML = '<tr><td colspan="4" class="muted">No cached transcodes.</td></tr>';
          return;
        }
        body.innerHTML = cache.files.map((file) => `
          <tr>
            <td class="path">${escapeHtml(file.name)}</td>
            <td>${formatBytes(file.size)}</td>
            <td>${escapeHtml(file.modifiedAt)}</td>
            <td><button class="danger" type="button" data-delete-cache="${encodeURIComponent(file.name)}">Delete</button></td>
          </tr>
        `).join("");
      }

      function renderStatus(payload) {
        document.getElementById("connector-url").textContent = payload.connectorUrl;
        document.getElementById("status-pill").textContent = payload.restartRequired ? "Restart needed" : "Running";
        document.getElementById("status-pill").className = `pill ${payload.restartRequired ? "warn" : "ready"}`;
        document.getElementById("restart-notice").className = `notice ${payload.restartRequired ? "show" : ""}`;
        document.getElementById("server-count").textContent = payload.connections.serverCount || 0;
        document.getElementById("resource-count").textContent = `${payload.connections.resourceCount || 0} resources`;
        document.getElementById("auth-state").textContent = payload.authRequired ? "On" : "Off";
        document.getElementById("session-count").textContent = `${payload.activeSessions || 0} sessions`;
        document.getElementById("ffmpeg-state").textContent = payload.ffmpegAvailable ? "Ready" : "Missing";
        document.getElementById("ffprobe-state").textContent = payload.ffprobeAvailable ? "ffprobe ready" : "ffprobe missing";
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
          useTls: document.getElementById("use-tls").checked,
          openBrowser: document.getElementById("open-browser").checked,
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
      wire("scan", scanServers);
      wire("refresh", async () => {
        await refresh();
        log("Status refreshed.");
      });
      wire("clear-connections", clearConnections);
      wire("refresh-cache", refreshCache);
      wire("clear-cache", clearCache);
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
