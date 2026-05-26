import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional


APP_NAME = "File Pipe"
CONFIG_FILE_NAME = "connector-config.json"


def user_data_dir() -> Path:
    override = os.environ.get("FILE_PIPE_HOME")
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        root = os.environ.get("APPDATA")
        if root:
            return Path(root) / APP_NAME
        return Path.home() / "AppData" / "Roaming" / APP_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    root = os.environ.get("XDG_CONFIG_HOME")
    if root:
        return Path(root) / "file-pipe"
    return Path.home() / ".config" / "file-pipe"


def default_cache_dir() -> Path:
    return user_data_dir() / "transcodes"


def default_ssl_dir() -> Path:
    return user_data_dir() / "ssl"


def config_path() -> Path:
    return user_data_dir() / CONFIG_FILE_NAME


def default_config() -> Dict[str, Any]:
    return {
        "host": "127.0.0.1",
        "port": 8765,
        "useTls": True,
        "serviceEnabled": True,
        "openBrowser": True,
        "allowInsecurePassword": False,
        "cacheDir": str(default_cache_dir()),
        "maxCacheBytes": 0,
        "realtimeStereo3dProcessor": "depth-anything-v2-small",
        "realtimeStereo3dInferenceScale": "0.5",
        "realtimeStereo3dInferenceCropPercent": 0,
        "prebuildStereo3dProcessor": "depth-anything-v2-base",
        "prebuildStereo3dInferenceScale": "0.75",
        "prebuildStereo3dInferenceCropPercent": 7.5,
        "passwordHash": None,
        "hostName": "",
        "pinnedWatchRoom": False,
    }


def normalize_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    if value is None:
        return default
    return bool(value)


def normalize_port(value: Any, default: int = 8765) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError):
        return default
    if port < 1 or port > 65535:
        return default
    return port


def normalize_path(value: Any, default: Path) -> str:
    text = str(value or "").strip()
    if not text:
        return str(default)
    return str(Path(text).expanduser())


def normalize_byte_size(value: Any, default: int = 0) -> int:
    if value is None or value == "":
        return max(0, int(default))
    if isinstance(value, (int, float)):
        return max(0, int(value))
    text = str(value).strip().lower().replace(" ", "")
    multipliers = {
        "k": 1024,
        "kb": 1024,
        "m": 1024**2,
        "mb": 1024**2,
        "g": 1024**3,
        "gb": 1024**3,
        "t": 1024**4,
        "tb": 1024**4,
    }
    suffix = ""
    for candidate in sorted(multipliers, key=len, reverse=True):
        if text.endswith(candidate):
            suffix = candidate
            text = text[: -len(candidate)]
            break
    try:
        number = float(text)
    except ValueError:
        return max(0, int(default))
    return max(0, int(number * multipliers.get(suffix, 1)))


def normalize_stereo3d_processor(value: Any, default: str = "depth-anything-v2-small") -> str:
    processor = str(value or "").strip().lower().replace("_", "-")
    aliases = {
        "": default,
        "shift": "ffmpeg-shift",
        "ffmpeg": "ffmpeg-shift",
        "ffmpeg-shift": "ffmpeg-shift",
        "depth-anything-small": "depth-anything-v2-small",
        "da-v2-small": "depth-anything-v2-small",
        "depth-anything-v2-small": "depth-anything-v2-small",
        "depth-anything-base": "depth-anything-v2-base",
        "da-v2-base": "depth-anything-v2-base",
        "depth-anything-v2-base": "depth-anything-v2-base",
        "coreml": "coreml-depth-anything-v2-small",
        "coreml-small": "coreml-depth-anything-v2-small",
        "apple-coreml": "coreml-depth-anything-v2-small",
        "coreml-depth-anything-v2-small": "coreml-depth-anything-v2-small",
        "webgpu": "webgpu-depth-anything-v2-small",
        "webgpu-small": "webgpu-depth-anything-v2-small",
        "webgpu-depth-anything-v2-small": "webgpu-depth-anything-v2-small",
    }
    return aliases.get(processor, default)


def normalize_scale(value: Any, default: str = "0.5") -> str:
    text = str(value or "").strip().lower().replace("x", "").replace("%", "")
    if not text:
        text = default
    try:
        number = float(text)
    except ValueError:
        number = float(default)
    if number > 1:
        number /= 100.0
    number = max(0.1, min(1.0, number))
    if abs(number - 1.0) < 0.001:
        return "1"
    return f"{round(number, 2):.2f}".rstrip("0").rstrip(".")


def normalize_percent(value: Any, default: float = 0.0) -> float:
    if value is None or value == "":
        number = default
    else:
        try:
            number = float(str(value).strip().replace("%", ""))
        except ValueError:
            number = default
    return round(max(0.0, min(25.0, number)), 2)


def normalize_config(raw: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    raw = raw or {}
    defaults = default_config()
    config = defaults.copy()
    host = str(raw.get("host") or defaults["host"]).strip()
    config["host"] = host or defaults["host"]
    config["port"] = normalize_port(raw.get("port"), defaults["port"])
    config["useTls"] = normalize_bool(raw.get("useTls", raw.get("tls")), defaults["useTls"])
    config["serviceEnabled"] = normalize_bool(raw.get("serviceEnabled"), defaults["serviceEnabled"])
    config["openBrowser"] = normalize_bool(raw.get("openBrowser"), defaults["openBrowser"])
    config["allowInsecurePassword"] = normalize_bool(
        raw.get("allowInsecurePassword"),
        defaults["allowInsecurePassword"],
    )
    config["cacheDir"] = normalize_path(raw.get("cacheDir"), default_cache_dir())
    config["maxCacheBytes"] = normalize_byte_size(raw.get("maxCacheBytes", raw.get("maxCacheSize")), defaults["maxCacheBytes"])
    config["realtimeStereo3dProcessor"] = normalize_stereo3d_processor(
        raw.get("realtimeStereo3dProcessor", raw.get("stereo3dProcessor")),
        defaults["realtimeStereo3dProcessor"],
    )
    config["realtimeStereo3dInferenceScale"] = normalize_scale(
        raw.get("realtimeStereo3dInferenceScale", raw.get("stereo3dInferenceScale")),
        defaults["realtimeStereo3dInferenceScale"],
    )
    config["realtimeStereo3dInferenceCropPercent"] = normalize_percent(
        raw.get("realtimeStereo3dInferenceCropPercent", raw.get("stereo3dInferenceCropPercent")),
        defaults["realtimeStereo3dInferenceCropPercent"],
    )
    config["prebuildStereo3dProcessor"] = normalize_stereo3d_processor(
        raw.get("prebuildStereo3dProcessor"),
        defaults["prebuildStereo3dProcessor"],
    )
    config["prebuildStereo3dInferenceScale"] = normalize_scale(
        raw.get("prebuildStereo3dInferenceScale"),
        defaults["prebuildStereo3dInferenceScale"],
    )
    config["prebuildStereo3dInferenceCropPercent"] = normalize_percent(
        raw.get("prebuildStereo3dInferenceCropPercent"),
        defaults["prebuildStereo3dInferenceCropPercent"],
    )
    config["hostName"] = str(raw.get("hostName") or "").strip()[:80]
    config["pinnedWatchRoom"] = normalize_bool(raw.get("pinnedWatchRoom"), defaults["pinnedWatchRoom"])
    password_hash = raw.get("passwordHash")
    config["passwordHash"] = password_hash if isinstance(password_hash, str) and password_hash else None
    return config


def load_config(path: Optional[Path] = None) -> Dict[str, Any]:
    path = path or config_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return normalize_config()
    except (OSError, json.JSONDecodeError):
        return normalize_config()
    if not isinstance(raw, dict):
        return normalize_config()
    return normalize_config(raw)


def save_config(config: Dict[str, Any], path: Optional[Path] = None) -> Dict[str, Any]:
    normalized = normalize_config(config)
    path = path or config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(normalized, indent=2, sort_keys=True), encoding="utf-8")
    return normalized


def public_config(config: Dict[str, Any]) -> Dict[str, Any]:
    payload = normalize_config(config)
    payload["passwordProtected"] = bool(payload.pop("passwordHash", None))
    return payload


def public_connector_settings(config: Dict[str, Any]) -> Dict[str, Any]:
    payload = normalize_config(config)
    return {
        "hostName": payload["hostName"],
        "pinnedWatchRoom": payload["pinnedWatchRoom"],
    }
