import argparse
import hmac
import json
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import urlparse

from flask import Flask, abort, jsonify, redirect, render_template, request, session, url_for

from local_tls import ensure_local_certificate


SHARE_ID_BYTES = 18
P2P_SHARES: Dict[str, dict] = {}
WATCH_ROOMS: Dict[str, dict] = {}
BIGSCREEN_SESSIONS: Dict[str, dict] = {}
LOGIN_ATTEMPTS: Dict[str, list] = {}
PUBLIC_ACCESS_ATTEMPTS: Dict[str, list] = {}
PUBLIC_WATCH_ENDPOINTS = {
    "watch",
    "bigscreen_service_worker",
    "watch_media_fallback",
    "get_watch_room_state",
    "join_watch_room",
    "reconnect_watch_participant",
    "put_watch_answer",
    "add_watch_participant_event",
    "get_watch_participant",
    "xr_themes",
}
XR_THEME_FOLDER = "xr-themes"


def load_dotenv(path: str = ".env") -> None:
    dotenv_path = Path(path)
    if not dotenv_path.exists():
        return
    for raw_line in dotenv_path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("\"'")
        if key and key not in os.environ:
            os.environ[key] = value


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def env_csv(name: str, default: str = "") -> list[str]:
    value = os.environ.get(name, default)
    return [part.strip() for part in value.split(",") if part.strip()]


def rtc_peer_config_from_env() -> dict:
    raw_config = os.environ.get("FILE_PIPE_ICE_SERVERS_JSON", "").strip()
    if raw_config:
        try:
            parsed = json.loads(raw_config)
            if isinstance(parsed, dict):
                return parsed
            if isinstance(parsed, list):
                return {"iceServers": parsed}
        except json.JSONDecodeError:
            pass

    ice_servers = [{"urls": url} for url in env_csv("FILE_PIPE_STUN_URLS", "stun:stun.l.google.com:19302")]
    turn_urls = env_csv("FILE_PIPE_TURN_URLS")
    if turn_urls:
        turn_server = {"urls": turn_urls if len(turn_urls) > 1 else turn_urls[0]}
        turn_username = os.environ.get("FILE_PIPE_TURN_USERNAME", "").strip()
        turn_credential = os.environ.get("FILE_PIPE_TURN_CREDENTIAL", "").strip()
        if turn_username:
            turn_server["username"] = turn_username
        if turn_credential:
            turn_server["credential"] = turn_credential
        ice_servers.append(turn_server)

    config = {"iceServers": ice_servers}
    ice_policy = os.environ.get("FILE_PIPE_ICE_TRANSPORT_POLICY", "all").strip().lower()
    if ice_policy in {"all", "relay"}:
        config["iceTransportPolicy"] = ice_policy
    pool_size = env_int("FILE_PIPE_ICE_CANDIDATE_POOL_SIZE", 0)
    if pool_size > 0:
        config["iceCandidatePoolSize"] = min(pool_size, 255)
    return config


@dataclass(frozen=True)
class AuthConfig:
    username: str
    password: str
    disabled: bool
    rate_limit_disabled: bool
    rate_limit_attempts: int
    rate_limit_window_seconds: int
    public_rate_limit_disabled: bool
    public_rate_limit_attempts: int
    public_rate_limit_window_seconds: int

    @property
    def configured(self) -> bool:
        return bool(self.username and self.password)


load_dotenv()


def valid_share_id(share_id: str) -> bool:
    return share_id.replace("-", "").replace("_", "").isalnum()


def get_p2p_share(share_id: str) -> dict:
    if not valid_share_id(share_id):
        abort(404)
    share = P2P_SHARES.get(share_id)
    if share is None:
        abort(404)
    return share


def get_watch_room(room_id: str) -> dict:
    if not valid_share_id(room_id):
        abort(404)
    room = WATCH_ROOMS.get(room_id)
    if room is None:
        abort(404)
    return room


def get_bigscreen_session(session_id: str) -> dict:
    if not valid_share_id(session_id):
        abort(404)
    session = BIGSCREEN_SESSIONS.get(session_id)
    if session is None:
        abort(404)
    return session


def auth_config_from_env() -> AuthConfig:
    return AuthConfig(
        username=os.environ.get("FILE_PIPE_AUTH_USERNAME", ""),
        password=os.environ.get("FILE_PIPE_AUTH_PASSWORD", ""),
        disabled=env_bool("FILE_PIPE_AUTH_DISABLED"),
        rate_limit_disabled=env_bool("FILE_PIPE_LOGIN_RATE_LIMIT_DISABLED"),
        rate_limit_attempts=max(1, env_int("FILE_PIPE_LOGIN_RATE_LIMIT", 5)),
        rate_limit_window_seconds=max(1, env_int("FILE_PIPE_LOGIN_RATE_WINDOW_SECONDS", 300)),
        public_rate_limit_disabled=env_bool("FILE_PIPE_PUBLIC_ACCESS_RATE_LIMIT_DISABLED"),
        public_rate_limit_attempts=max(1, env_int("FILE_PIPE_PUBLIC_ACCESS_RATE_LIMIT", 120)),
        public_rate_limit_window_seconds=max(1, env_int("FILE_PIPE_PUBLIC_ACCESS_RATE_WINDOW_SECONDS", 60)),
    )


def is_authenticated(auth_config: AuthConfig) -> bool:
    return auth_config.disabled or session.get("file_pipe_authenticated") is True


def wants_json_response() -> bool:
    return request.path.startswith("/api/") or request.accept_mimetypes.best == "application/json"


def safe_next_url(value: str) -> str:
    if not value:
        return url_for("index")
    parsed = urlparse(value)
    if parsed.scheme or parsed.netloc:
        return url_for("index")
    if not value.startswith("/"):
        return url_for("index")
    return value


def login_rate_key() -> str:
    return request.remote_addr or "unknown"


def login_rate_limited(auth_config: AuthConfig) -> int:
    if auth_config.rate_limit_disabled:
        return 0
    now = time.time()
    key = login_rate_key()
    window_start = now - auth_config.rate_limit_window_seconds
    attempts = [timestamp for timestamp in LOGIN_ATTEMPTS.get(key, []) if timestamp >= window_start]
    LOGIN_ATTEMPTS[key] = attempts
    if len(attempts) >= auth_config.rate_limit_attempts:
        oldest = min(attempts)
        return max(1, int(auth_config.rate_limit_window_seconds - (now - oldest)))
    return 0


def record_login_failure(auth_config: AuthConfig) -> None:
    if auth_config.rate_limit_disabled:
        return
    LOGIN_ATTEMPTS.setdefault(login_rate_key(), []).append(time.time())


def clear_login_failures() -> None:
    LOGIN_ATTEMPTS.pop(login_rate_key(), None)


def public_access_rate_limited(auth_config: AuthConfig) -> int:
    if auth_config.public_rate_limit_disabled:
        return 0
    now = time.time()
    key = login_rate_key()
    window_start = now - auth_config.public_rate_limit_window_seconds
    attempts = [timestamp for timestamp in PUBLIC_ACCESS_ATTEMPTS.get(key, []) if timestamp >= window_start]
    attempts.append(now)
    PUBLIC_ACCESS_ATTEMPTS[key] = attempts
    if len(attempts) > auth_config.public_rate_limit_attempts:
        oldest = min(attempts)
        return max(1, int(auth_config.public_rate_limit_window_seconds - (now - oldest)))
    return 0


def rate_limit_public_access(auth_config: AuthConfig):
    retry_after = public_access_rate_limited(auth_config)
    if not retry_after:
        return None
    payload = {"error": f"Too many requests. Try again in {retry_after} seconds."}
    if wants_json_response():
        return jsonify(payload), 429, {"Retry-After": str(retry_after)}
    return render_template("rate_limited.html", retry_after=retry_after), 429, {"Retry-After": str(retry_after)}


def parse_yaml_scalar(value: str):
    value = value.strip()
    if not value:
        return ""
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    lowered = value.lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [parse_yaml_scalar(part.strip()) for part in inner.split(",")]
    try:
        if "." in value:
            return float(value)
        return int(value)
    except ValueError:
        return value


def parse_simple_yaml(text: str):
    lines = []
    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        lines.append((indent, raw_line.strip()))

    def parse_block(index: int, indent: int):
        if index >= len(lines):
            return {}, index
        return parse_list(index, indent) if lines[index][1].startswith("- ") else parse_dict(index, indent)

    def parse_dict(index: int, indent: int):
        output = {}
        while index < len(lines):
            line_indent, line = lines[index]
            if line_indent < indent or line.startswith("- "):
                break
            if line_indent > indent:
                index += 1
                continue
            if ":" not in line:
                index += 1
                continue
            key, value = line.split(":", 1)
            key = key.strip()
            value = value.strip()
            index += 1
            if value:
                output[key] = parse_yaml_scalar(value)
            else:
                child, index = parse_block(index, lines[index][0] if index < len(lines) else indent + 2)
                output[key] = child
        return output, index

    def parse_list(index: int, indent: int):
        output = []
        while index < len(lines):
            line_indent, line = lines[index]
            if line_indent < indent or not line.startswith("- "):
                break
            item_text = line[2:].strip()
            index += 1
            if not item_text:
                child, index = parse_block(index, lines[index][0] if index < len(lines) else indent + 2)
                output.append(child)
                continue
            if ":" in item_text:
                key, value = item_text.split(":", 1)
                item = {key.strip(): parse_yaml_scalar(value.strip()) if value.strip() else {}}
                while index < len(lines) and lines[index][0] > line_indent:
                    child, index = parse_dict(index, lines[index][0])
                    if isinstance(child, dict):
                        item.update(child)
                output.append(item)
            else:
                output.append(parse_yaml_scalar(item_text))
        return output, index

    parsed, _index = parse_block(0, lines[0][0] if lines else 0)
    return parsed


def normalize_xr_theme(theme_dir: Path) -> Optional[dict]:
    yaml_path = next((theme_dir / name for name in ("theme.yaml", "theme.yml") if (theme_dir / name).is_file()), None)
    if not yaml_path:
        return None
    try:
        data = parse_simple_yaml(yaml_path.read_text(encoding="utf-8"))
    except OSError:
        return None
    if not isinstance(data, dict):
        return None
    theme_id = str(data.get("id") or theme_dir.name).strip() or theme_dir.name
    assets = data.get("assets") if isinstance(data.get("assets"), list) else []
    normalized_assets = []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        file_name = str(asset.get("file") or "").strip()
        if not file_name or ".." in Path(file_name).parts:
            continue
        asset_path = theme_dir / file_name
        if not asset_path.is_file():
            continue
        normalized_assets.append(
            {
                **asset,
                "url": url_for("static", filename=f"{XR_THEME_FOLDER}/{theme_dir.name}/{file_name}"),
            }
        )
    return {
        **data,
        "id": theme_id,
        "name": str(data.get("name") or theme_id),
        "assets": normalized_assets,
        "baseUrl": url_for("static", filename=f"{XR_THEME_FOLDER}/{theme_dir.name}/"),
    }


def create_app():
    app = Flask(__name__)
    app.config["TEMPLATES_AUTO_RELOAD"] = True
    app.jinja_env.auto_reload = True
    app.secret_key = os.environ.get("FILE_PIPE_SECRET_KEY") or secrets.token_urlsafe(32)
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=env_bool("FILE_PIPE_SESSION_COOKIE_SECURE"),
    )
    auth_config = auth_config_from_env()

    @app.template_global()
    def local_static_or_cdn(filename: str, cdn_url: str) -> str:
        static_root = Path(app.static_folder or "static")
        if (static_root / filename).is_file():
            return url_for("static", filename=filename)
        return cdn_url

    @app.template_global()
    def p2p_config() -> dict:
        return rtc_peer_config_from_env()

    @app.before_request
    def require_site_auth():
        if auth_config.disabled:
            return None
        if request.endpoint in {"health", "login", "login_post", "static"}:
            return None
        if is_authenticated(auth_config):
            return None
        if request.endpoint in PUBLIC_WATCH_ENDPOINTS:
            return rate_limit_public_access(auth_config)
        if not auth_config.configured:
            if wants_json_response():
                return jsonify({"error": "File Pipe authentication is not configured."}), 503
            return (
                render_template(
                    "login.html",
                    auth_missing=True,
                    next_url=request.full_path if request.query_string else request.path,
                    rate_limit_disabled=auth_config.rate_limit_disabled,
                ),
                503,
            )
        if wants_json_response():
            return jsonify({"error": "Authentication required."}), 401
        return (
            render_template(
                "login.html",
                next_url=request.full_path if request.query_string else request.path,
                rate_limit_disabled=auth_config.rate_limit_disabled,
            ),
            401,
        )

    @app.get("/login")
    def login():
        if auth_config.disabled or is_authenticated(auth_config):
            return redirect(safe_next_url(request.args.get("next", "")))
        return render_template(
            "login.html",
            next_url=request.args.get("next", ""),
            rate_limit_disabled=auth_config.rate_limit_disabled,
        )

    @app.post("/login")
    def login_post():
        if auth_config.disabled:
            return redirect(safe_next_url(request.form.get("next", "")))
        if not auth_config.configured:
            return render_template("login.html", auth_missing=True, rate_limit_disabled=auth_config.rate_limit_disabled), 503

        retry_after = login_rate_limited(auth_config)
        if retry_after:
            response = render_template(
                "login.html",
                error=f"Too many failed attempts. Try again in {retry_after} seconds.",
                next_url=request.form.get("next", ""),
                retry_after=retry_after,
                rate_limit_disabled=auth_config.rate_limit_disabled,
            )
            return response, 429, {"Retry-After": str(retry_after)}

        username = request.form.get("username", "")
        password = request.form.get("password", "")
        valid_username = hmac.compare_digest(username, auth_config.username)
        valid_password = hmac.compare_digest(password, auth_config.password)
        if not valid_username or not valid_password:
            record_login_failure(auth_config)
            return (
                render_template(
                    "login.html",
                    error="Invalid username or password.",
                    next_url=request.form.get("next", ""),
                    rate_limit_disabled=auth_config.rate_limit_disabled,
                ),
                401,
            )

        clear_login_failures()
        session.clear()
        session["file_pipe_authenticated"] = True
        session["file_pipe_username"] = auth_config.username
        return redirect(safe_next_url(request.form.get("next", "")))

    @app.post("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    @app.get("/health")
    def health():
        return jsonify({"ok": True, "service": "file-pipe"})

    @app.get("/api/xr/themes")
    def xr_themes():
        static_root = Path(app.static_folder or "static")
        themes_root = static_root / XR_THEME_FOLDER
        themes = []
        if themes_root.is_dir():
            for theme_dir in sorted(path for path in themes_root.iterdir() if path.is_dir()):
                theme = normalize_xr_theme(theme_dir)
                if theme:
                    themes.append(theme)
        return jsonify({"themes": themes})

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/share/<share_id>")
    def share(share_id: str):
        return render_template("share.html", share_id=share_id)

    @app.get("/watch/<room_id>")
    def watch(room_id: str):
        return render_template("watch.html", room_id=room_id)

    @app.get("/bigscreen/<session_id>")
    def bigscreen(session_id: str):
        return render_template("bigscreen.html", session_id=session_id)

    @app.get("/bigscreen-sw.js")
    def bigscreen_service_worker():
        response = app.send_static_file("bigscreen-sw.js")
        response.headers["Service-Worker-Allowed"] = "/"
        return response

    @app.get("/bigscreen-media/<session_id>/<path:_filename>")
    def bigscreen_media_fallback(session_id: str, _filename: str):
        get_bigscreen_session(session_id)
        return (
            jsonify(
                {
                    "error": "This media URL is served by the browser service worker over WebRTC. Open the Bigscreen player page first."
                }
            ),
            409,
        )

    @app.get("/watch-media/<room_id>/<path:_filename>")
    def watch_media_fallback(room_id: str, _filename: str):
        get_watch_room(room_id)
        return (
            jsonify(
                {
                    "error": "This media URL is served by the browser service worker over encrypted WebRTC range requests. Open the watch room page first."
                }
            ),
            409,
        )

    @app.post("/api/p2p/shares")
    def create_p2p_share():
        share_id = secrets.token_urlsafe(SHARE_ID_BYTES)
        P2P_SHARES[share_id] = {
            "id": share_id,
            "createdAt": int(time.time()),
            "offer": None,
            "answer": None,
            "metadata": None,
        }
        return jsonify({"shareId": share_id})

    @app.put("/api/p2p/shares/<share_id>/offer")
    def put_p2p_offer(share_id: str):
        share = get_p2p_share(share_id)
        payload = request.get_json(force=True, silent=True) or {}
        offer = payload.get("offer")
        metadata = payload.get("metadata")
        if not offer or not metadata:
            return jsonify({"error": "Missing offer or encrypted metadata."}), 400
        share["offer"] = offer
        share["metadata"] = metadata
        return jsonify({"ok": True})

    @app.put("/api/p2p/shares/<share_id>/answer")
    def put_p2p_answer(share_id: str):
        share = get_p2p_share(share_id)
        payload = request.get_json(force=True, silent=True) or {}
        answer = payload.get("answer")
        if not answer:
            return jsonify({"error": "Missing answer."}), 400
        share["answer"] = answer
        return jsonify({"ok": True})

    @app.get("/api/p2p/shares/<share_id>")
    def get_p2p_signal(share_id: str):
        share = get_p2p_share(share_id)
        return jsonify(
            {
                "id": share["id"],
                "createdAt": share["createdAt"],
                "offer": share["offer"],
                "answer": share["answer"],
                "metadata": share["metadata"],
            }
        )

    @app.post("/api/bigscreen/sessions")
    def create_bigscreen_session():
        session_id = secrets.token_urlsafe(SHARE_ID_BYTES)
        BIGSCREEN_SESSIONS[session_id] = {
            "id": session_id,
            "createdAt": int(time.time()),
            "offer": None,
            "answer": None,
            "metadata": None,
        }
        return jsonify({"sessionId": session_id})

    @app.put("/api/bigscreen/sessions/<session_id>/offer")
    def put_bigscreen_offer(session_id: str):
        session = get_bigscreen_session(session_id)
        payload = request.get_json(force=True, silent=True) or {}
        offer = payload.get("offer")
        metadata = payload.get("metadata")
        if not offer or not metadata:
            return jsonify({"error": "Missing offer or encrypted metadata."}), 400
        session["offer"] = offer
        session["answer"] = None
        session["metadata"] = metadata
        return jsonify({"ok": True})

    @app.put("/api/bigscreen/sessions/<session_id>/answer")
    def put_bigscreen_answer(session_id: str):
        session = get_bigscreen_session(session_id)
        payload = request.get_json(force=True, silent=True) or {}
        answer = payload.get("answer")
        if not answer:
            return jsonify({"error": "Missing answer."}), 400
        session["answer"] = answer
        return jsonify({"ok": True})

    @app.get("/api/bigscreen/sessions/<session_id>")
    def get_bigscreen_signal(session_id: str):
        session = get_bigscreen_session(session_id)
        return jsonify(
            {
                "id": session["id"],
                "createdAt": session["createdAt"],
                "offer": session["offer"],
                "answer": session["answer"],
                "metadata": session["metadata"],
            }
        )

    @app.route("/api/shares/<path:_path>", methods=["GET", "POST", "PUT", "DELETE"])
    @app.post("/api/shares")
    def removed_server_storage(_path=None):
        return (
            jsonify(
                {
                    "error": "Server-side file storage is disabled. Shares use WebRTC peer-to-peer signaling only."
                }
            ),
            410,
        )

    @app.post("/api/watch/rooms")
    def create_watch_room():
        room_id = secrets.token_urlsafe(SHARE_ID_BYTES)
        WATCH_ROOMS[room_id] = {
            "id": room_id,
            "createdAt": int(time.time()),
            "metadata": None,
            "participants": {},
        }
        return jsonify({"roomId": room_id})

    @app.put("/api/watch/rooms/<room_id>/metadata")
    def put_watch_metadata(room_id: str):
        room = get_watch_room(room_id)
        payload = request.get_json(force=True, silent=True) or {}
        metadata = payload.get("metadata")
        if not metadata:
            return jsonify({"error": "Missing encrypted metadata."}), 400
        room["metadata"] = metadata
        return jsonify({"ok": True})

    @app.get("/api/watch/rooms/<room_id>")
    def get_watch_room_state(room_id: str):
        room = get_watch_room(room_id)
        participants = [
            {
                "id": participant["id"],
                "name": participant["name"],
                "joinedAt": participant["joinedAt"],
                "generation": participant.get("generation", 0),
                "offer": participant.get("offer"),
                "answer": participant.get("answer"),
                "kicked": bool(participant.get("kicked")),
                "events": participant.get("events", [])[-10:],
            }
            for participant in room["participants"].values()
        ]
        return jsonify(
            {
                "id": room["id"],
                "createdAt": room["createdAt"],
                "metadata": room["metadata"],
                "participants": participants,
            }
        )

    @app.post("/api/watch/rooms/<room_id>/participants")
    def join_watch_room(room_id: str):
        room = get_watch_room(room_id)
        payload = request.get_json(force=True, silent=True) or {}
        name = (payload.get("name") or "").strip()
        if not name:
            return jsonify({"error": "Name is required."}), 400
        participant_id = secrets.token_urlsafe(12)
        room["participants"][participant_id] = {
            "id": participant_id,
            "name": name[:80],
            "joinedAt": int(time.time()),
            "generation": 0,
            "offer": None,
            "answer": None,
            "kicked": False,
            "events": [],
        }
        return jsonify({"participantId": participant_id})

    @app.put("/api/watch/rooms/<room_id>/participants/<participant_id>/offer")
    def put_watch_offer(room_id: str, participant_id: str):
        room = get_watch_room(room_id)
        participant = room["participants"].get(participant_id)
        if participant is None:
            abort(404)
        if participant.get("kicked"):
            return jsonify({"error": "Participant was removed from the room."}), 410
        payload = request.get_json(force=True, silent=True) or {}
        offer = payload.get("offer")
        if not offer:
            return jsonify({"error": "Missing offer."}), 400
        participant["offer"] = offer
        return jsonify({"ok": True})

    @app.post("/api/watch/rooms/<room_id>/participants/<participant_id>/reconnect")
    def reconnect_watch_participant(room_id: str, participant_id: str):
        room = get_watch_room(room_id)
        participant = room["participants"].get(participant_id)
        if participant is None:
            abort(404)
        if participant.get("kicked"):
            return jsonify({"error": "Participant was removed from the room."}), 410
        participant["generation"] = int(participant.get("generation", 0)) + 1
        participant["offer"] = None
        participant["answer"] = None
        participant["reconnectedAt"] = int(time.time())
        return jsonify({"ok": True, "generation": participant["generation"]})

    @app.put("/api/watch/rooms/<room_id>/participants/<participant_id>/answer")
    def put_watch_answer(room_id: str, participant_id: str):
        room = get_watch_room(room_id)
        participant = room["participants"].get(participant_id)
        if participant is None:
            abort(404)
        if participant.get("kicked"):
            return jsonify({"error": "Participant was removed from the room."}), 410
        payload = request.get_json(force=True, silent=True) or {}
        answer = payload.get("answer")
        if not answer:
            return jsonify({"error": "Missing answer."}), 400
        participant["answer"] = answer
        return jsonify({"ok": True})

    @app.delete("/api/watch/rooms/<room_id>/participants/<participant_id>")
    def kick_watch_participant(room_id: str, participant_id: str):
        room = get_watch_room(room_id)
        participant = room["participants"].get(participant_id)
        if participant is None:
            abort(404)
        participant["kicked"] = True
        participant["generation"] = int(participant.get("generation", 0)) + 1
        participant["offer"] = None
        participant["answer"] = None
        participant["kickedAt"] = int(time.time())
        return jsonify({"ok": True})

    @app.post("/api/watch/rooms/<room_id>/participants/<participant_id>/events")
    def add_watch_participant_event(room_id: str, participant_id: str):
        room = get_watch_room(room_id)
        participant = room["participants"].get(participant_id)
        if participant is None:
            abort(404)
        payload = request.get_json(force=True, silent=True) or {}
        event = {
            "at": int(time.time()),
            "event": str(payload.get("event") or "unknown")[:80],
            "detail": str(payload.get("detail") or "")[:300],
            "channelState": str(payload.get("channelState") or "")[:40],
            "peerState": str(payload.get("peerState") or "")[:40],
            "pendingVideoRequest": bool(payload.get("pendingVideoRequest")),
            "receiving": bool(payload.get("receiving")),
        }
        participant.setdefault("events", []).append(event)
        participant["events"] = participant["events"][-30:]
        return jsonify({"ok": True})

    @app.get("/api/watch/rooms/<room_id>/participants/<participant_id>")
    def get_watch_participant(room_id: str, participant_id: str):
        room = get_watch_room(room_id)
        participant = room["participants"].get(participant_id)
        if participant is None:
            abort(404)
        return jsonify(
            {
                "id": participant["id"],
                "name": participant["name"],
                "joinedAt": participant["joinedAt"],
                "generation": participant.get("generation", 0),
                "offer": participant.get("offer"),
                "answer": participant.get("answer"),
                "kicked": bool(participant.get("kicked")),
                "events": participant.get("events", [])[-10:],
                "metadata": room["metadata"],
            }
        )

    return app


app = create_app()


def main():
    parser = argparse.ArgumentParser(description="File Pipe web app.")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", default=6500, type=int)
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--cert", help="TLS certificate file for HTTPS.")
    parser.add_argument("--key", help="TLS private key file for HTTPS.")
    parser.add_argument("--no-tls", action="store_true", help="Serve plain HTTP. Use only for localhost development.")
    parser.add_argument(
        "--adhoc-tls",
        action="store_true",
        help="Use a generated self-signed HTTPS certificate for local/LAN testing.",
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

    scheme = "https" if ssl_context else "http"
    print(f"File Pipe web app listening at {scheme}://{args.host}:{args.port}", flush=True)
    if ssl_context == "adhoc":
        print(
            "Using a generated self-signed certificate. Open the HTTPS URL in the browser and accept the warning once before using share/watch/Bigscreen features.",
            flush=True,
        )
    elif ssl_context:
        print(
            f"Using local certificate {ssl_context[0]}. Open the HTTPS URL in the browser and accept or trust the certificate once.",
            flush=True,
        )

    app.run(
        host=args.host,
        port=args.port,
        debug=args.debug,
        ssl_context=ssl_context,
    )


if __name__ == "__main__":
    main()
