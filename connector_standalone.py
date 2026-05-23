import argparse
import os
import secrets
import signal
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path
from typing import Dict, Optional, Tuple

from standalone_config import config_path, default_ssl_dir, load_config, normalize_config, save_config


class StandaloneRuntime:
    def __init__(self, config: Dict[str, object], actual_port: int, scheme: str, shutdown_delay: float = 0.35):
        self.config = normalize_config(config)
        self.bound_host = str(self.config["host"])
        self.actual_port = actual_port
        self.scheme = scheme
        self.shutdown_delay = shutdown_delay
        self.admin_token = secrets.token_urlsafe(32)
        self.started_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        self.config_path = config_path()
        self.restart_required = False
        self.server = None
        self.shutdown_requested = threading.Event()

    @property
    def browser_host(self) -> str:
        if self.bound_host in {"0.0.0.0", "::"}:
            return "127.0.0.1"
        return self.bound_host

    @property
    def connector_url(self) -> str:
        return f"{self.scheme}://{self.browser_host}:{self.actual_port}"

    def save_config(self, config: Dict[str, object]) -> None:
        self.config = save_config(config, self.config_path)

    def mark_restart_required(self) -> None:
        self.restart_required = True

    def request_shutdown(self) -> None:
        self.shutdown_requested.set()
        if not self.server:
            return

        def stop_server():
            time.sleep(self.shutdown_delay)
            self.server.shutdown()

        threading.Thread(target=stop_server, daemon=True).start()


def parse_args():
    parser = argparse.ArgumentParser(description="File Pipe standalone local connector.")
    parser.add_argument("--host", help="Host to bind for this run. Defaults to saved config.")
    parser.add_argument("--port", type=int, help="Port to bind for this run. Defaults to saved config.")
    parser.add_argument("--cache-dir", help="Transcode cache directory for this run.")
    parser.add_argument("--tls", action="store_true", help="Force HTTPS for this run.")
    parser.add_argument("--no-tls", action="store_true", help="Force HTTP for this run.")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the management UI automatically.")
    parser.add_argument("--no-tray", action="store_true", help="Run in the foreground without a tray/menu-bar icon.")
    return parser.parse_args()


def apply_cli_overrides(config: Dict[str, object], args) -> Dict[str, object]:
    updated = normalize_config(config)
    if args.host:
        updated["host"] = args.host
    if args.port:
        updated["port"] = args.port
    if args.cache_dir:
        updated["cacheDir"] = str(Path(args.cache_dir).expanduser())
    if args.tls:
        updated["useTls"] = True
    if args.no_tls:
        updated["useTls"] = False
    if args.no_browser:
        updated["openBrowser"] = False
    return normalize_config(updated)


def build_server(host: str, port: int, app, ssl_context) -> Tuple[int, object]:
    from werkzeug.serving import make_server

    attempts = [port]
    attempts.extend(candidate for candidate in range(8765, 8786) if candidate != port)
    last_error: Optional[OSError] = None
    for candidate in attempts:
        if not can_bind(host, candidate):
            last_error = OSError(f"{host}:{candidate} is already in use")
            continue
        try:
            server = make_server(
                host,
                candidate,
                app,
                threaded=True,
                ssl_context=ssl_context,
            )
            return candidate, server
        except OSError as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise OSError("Could not start the local connector.")


def can_bind(host: str, port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((host, port))
    except OSError:
        return False
    return True


def install_signal_handlers(runtime: StandaloneRuntime) -> None:
    def stop(_signum, _frame):
        runtime.request_shutdown()

    signal.signal(signal.SIGINT, stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop)


def open_admin_ui(runtime: StandaloneRuntime) -> None:
    webbrowser.open(f"{runtime.connector_url}/admin")


def create_tray_image():
    from PIL import Image, ImageDraw

    size = 64
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((8, 8, 56, 56), radius=12, fill=(37, 99, 235, 255))
    draw.line((22, 22, 42, 22, 42, 42, 22, 42, 22, 22), fill=(255, 255, 255, 255), width=5)
    draw.line((28, 32, 50, 32), fill=(255, 255, 255, 255), width=5)
    return image


def run_with_tray(runtime: StandaloneRuntime) -> int:
    try:
        import pystray
    except Exception as exc:
        print(f"Tray icon is unavailable; running in foreground instead: {exc}", flush=True)
        return run_foreground(runtime)

    server_thread = threading.Thread(target=runtime.server.serve_forever, name="file-pipe-connector", daemon=True)
    server_thread.start()

    def open_item(_icon=None, _item=None):
        open_admin_ui(runtime)

    def exit_item(icon, _item=None):
        runtime.request_shutdown()
        icon.stop()

    def stop_icon_after_shutdown():
        runtime.shutdown_requested.wait()
        time.sleep(runtime.shutdown_delay + 0.1)
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("Open File Pipe Connector", open_item, default=True),
        pystray.MenuItem(f"Service: {runtime.connector_url}", open_item, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Exit", exit_item),
    )
    icon = pystray.Icon(
        "file-pipe-connector",
        create_tray_image(),
        "File Pipe Connector",
        menu,
    )

    threading.Thread(target=stop_icon_after_shutdown, name="file-pipe-tray-shutdown", daemon=True).start()

    try:
        icon.run()
    finally:
        runtime.request_shutdown()
        server_thread.join(timeout=3)
        runtime.server.server_close()
    return 0


def run_foreground(runtime: StandaloneRuntime) -> int:
    try:
        runtime.server.serve_forever()
    finally:
        runtime.server.server_close()
    return 0


def main() -> int:
    args = parse_args()
    config = apply_cli_overrides(load_config(), args)

    os.environ.setdefault("FILE_PIPE_SSL_DIR", str(default_ssl_dir()))
    os.environ["FILE_PIPE_TRANSCODE_CACHE_DIR"] = str(Path(config["cacheDir"]).expanduser())

    import local_connector
    from local_connector import ConnectorSecurity, create_connector_app
    from local_tls import ensure_local_certificate
    from standalone_admin import create_admin_blueprint

    local_connector.TRANSCODE_CACHE_DIR = Path(config["cacheDir"]).expanduser()
    local_connector.TRANSCODE_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    ssl_context = ensure_local_certificate(str(config["host"])) if config["useTls"] else None
    scheme = "https" if ssl_context else "http"
    security = ConnectorSecurity(
        password_hash=config.get("passwordHash"),
        allow_insecure_password=bool(config["allowInsecurePassword"]),
    )

    runtime = StandaloneRuntime(config, int(config["port"]), scheme)
    app = create_connector_app(security)
    app.register_blueprint(create_admin_blueprint(security, runtime))

    try:
        actual_port, server = build_server(str(config["host"]), int(config["port"]), app, ssl_context)
    except OSError as exc:
        print(f"File Pipe Connector could not start: {exc}", file=sys.stderr, flush=True)
        return 1

    runtime.actual_port = actual_port
    runtime.server = server
    install_signal_handlers(runtime)

    if actual_port != int(config["port"]):
        runtime.mark_restart_required()
        print(
            f"Configured port {config['port']} was unavailable; using {actual_port} for this run.",
            flush=True,
        )

    admin_url = f"{runtime.connector_url}/admin"
    print(f"File Pipe Connector running at {runtime.connector_url}", flush=True)
    print(f"Management UI: {admin_url}", flush=True)
    print(f"Config: {runtime.config_path}", flush=True)

    if config["openBrowser"]:
        threading.Timer(0.6, lambda: open_admin_ui(runtime)).start()

    if args.no_tray:
        return run_foreground(runtime)
    return run_with_tray(runtime)


if __name__ == "__main__":
    raise SystemExit(main())
