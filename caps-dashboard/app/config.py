"""Configuration loader for the Hub-and-Spoke AI Usage & Model Budget Dashboard.

100% pure customer-side REST API client configuration: reads ONLY environment
variables (and an optional gitignored local .env file during local dev).
Never invokes gcloud, GCP SDKs, BigQuery, GCS, or IAM directly.
"""

from __future__ import annotations

import dataclasses
import logging
import os
import re
import secrets
import urllib.parse
from pathlib import Path

LOG = logging.getLogger("caps_dashboard.config")

PROJECT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")

DEFAULT_API_BASE_URL = "https://gcp-ai-usage-caps-api-484712896449.asia-northeast3.run.app"
DEFAULT_HUB_PROJECT = "duleetest"
DEFAULT_SPOKE_PROJECTS = ("dulee-ai-test",)


@dataclasses.dataclass(frozen=True)
class DashboardConfig:
    api_base_url: str
    api_key: str
    hub_project: str
    spoke_projects: tuple[str, ...]
    host: str
    port: int
    session_secret: str
    is_cloud_run: bool
    base_dir: Path
    web_dir: Path
    admin_password_hash: str | None
    admin_password_plain: str | None
    allow_loopback_http: bool = False

    @property
    def managed_projects(self) -> tuple[str, ...]:
        out: list[str] = [self.hub_project]
        for p in self.spoke_projects:
            if p not in out:
                out.append(p)
        return tuple(out)


def _validate_project_id(project_id: str, label: str) -> str:
    val = project_id.strip().lower()
    if not PROJECT_ID_RE.match(val):
        raise ValueError(f"Invalid GCP project ID for {label}.")
    return val


def validate_api_base_url(raw_url: str, *, allow_loopback_http: bool = False) -> str:
    url = raw_url.strip().rstrip("/")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme == "https" and parsed.netloc:
        return url
    if allow_loopback_http and parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost"):
        return url
    raise ValueError("CAPS_API_BASE_URL must use https:// (or loopback http:// only in local test mode).")


def _load_local_dotenv(base_dir: Path) -> dict[str, str]:
    """Reads optional gitignored .env file strictly within base_dir (local dev only)."""
    env_file = (base_dir / ".env").resolve()
    sandbox_prefix = str(base_dir.resolve()) + os.sep
    if not str(env_file).startswith(sandbox_prefix) or not env_file.is_file():
        return {}
    parsed: dict[str, str] = {}
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        if key:
            parsed[key] = val
    return parsed


def _get_setting(name: str, dotenv: dict[str, str], default: str = "") -> str:
    env_val = os.environ.get(name)
    if env_val is not None and env_val.strip() != "":
        return env_val.strip()
    file_val = dotenv.get(name)
    if file_val is not None and file_val.strip() != "":
        return file_val.strip()
    return default


def _resolve_session_secret(base_dir: Path, dotenv: dict[str, str], is_cloud_run: bool) -> str:
    configured = _get_setting("DASHBOARD_SESSION_SECRET", dotenv)
    if configured:
        if len(configured) < 32:
            raise ValueError("DASHBOARD_SESSION_SECRET must be at least 32 characters.")
        return configured

    if is_cloud_run:
        raise RuntimeError(
            "DASHBOARD_SESSION_SECRET is required in Cloud Run production deployments."
        )

    # Local dev multi-tiered resolution: local restricted file -> ephemeral CSPRNG + warning.
    secret_file = (base_dir / ".session_secret").resolve()
    sandbox_prefix = str(base_dir.resolve()) + os.sep
    if not str(secret_file).startswith(sandbox_prefix):
        raise ValueError("Invalid session secret path.")
    if secret_file.is_file():
        stored = secret_file.read_text(encoding="utf-8").strip()
        if len(stored) >= 32:
            return stored

    LOG.warning(
        "DASHBOARD_SESSION_SECRET is not set; generating ephemeral instance-isolated session secret "
        "(sessions will reset on restart and will not scale horizontally)."
    )
    return secrets.token_hex(32)


def load_config(base_dir: Path | None = None) -> DashboardConfig:
    root = (base_dir or Path(__file__).resolve().parent.parent).resolve()
    web_dir = (root / "web").resolve()
    is_cloud_run = bool(os.environ.get("K_SERVICE", "").strip())
    dotenv = {} if is_cloud_run else _load_local_dotenv(root)
    allow_loopback_http = _get_setting("CAPS_ALLOW_LOOPBACK_HTTP", dotenv) == "1" and not is_cloud_run

    hub_project = _validate_project_id(
        _get_setting("HUB_PROJECT", dotenv, DEFAULT_HUB_PROJECT),
        "HUB_PROJECT",
    )
    raw_spokes = _get_setting("SPOKE_PROJECTS", dotenv, ",".join(DEFAULT_SPOKE_PROJECTS))
    spoke_projects = tuple(
        _validate_project_id(p, "SPOKE_PROJECTS")
        for p in raw_spokes.split(",")
        if p.strip()
    )

    api_base_url = validate_api_base_url(
        _get_setting("CAPS_API_BASE_URL", dotenv, DEFAULT_API_BASE_URL),
        allow_loopback_http=allow_loopback_http,
    )

    api_key = _get_setting("CAPS_API_KEY", dotenv)
    if is_cloud_run and not api_key:
        raise RuntimeError("CAPS_API_KEY must be injected via Secret Manager in Cloud Run.")

    # Local/testing servers MUST bind to 127.0.0.1 (never 0.0.0.0).
    # Cloud Run requires listening on 0.0.0.0:$PORT behind Google's HTTPS front-end.
    default_host = "0.0.0.0" if is_cloud_run else "127.0.0.1"
    host = _get_setting("HOST", dotenv, default_host) or default_host
    if not is_cloud_run and host not in ("127.0.0.1", "localhost"):
        LOG.warning("Refusing non-loopback local host '%s'; forcing 127.0.0.1.", host)
        host = "127.0.0.1"

    try:
        port = int(_get_setting("PORT", dotenv, "8090"))
    except ValueError as exc:
        raise ValueError("PORT must be an integer.") from exc
    if not (1 <= port <= 65535):
        raise ValueError("PORT must be between 1 and 65535.")

    session_secret = _resolve_session_secret(root, dotenv, is_cloud_run)

    admin_password_hash = _get_setting("DASHBOARD_ADMIN_PASSWORD_HASH", dotenv) or None
    admin_password_plain = _get_setting("DASHBOARD_ADMIN_PASSWORD", dotenv) or None

    return DashboardConfig(
        api_base_url=api_base_url,
        api_key=api_key,
        hub_project=hub_project,
        spoke_projects=spoke_projects,
        host=host,
        port=port,
        session_secret=session_secret,
        is_cloud_run=is_cloud_run,
        base_dir=root,
        web_dir=web_dir,
        admin_password_hash=admin_password_hash,
        admin_password_plain=admin_password_plain,
        allow_loopback_http=allow_loopback_http,
    )
