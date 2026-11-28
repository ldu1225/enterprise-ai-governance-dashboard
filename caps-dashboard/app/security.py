"""Security primitives: scrypt auth, hardened sessions, CSRF, rate limiting, headers, and input validators.

TODO(security): For multi-admin enterprise production deployments, integrate Google OAuth 2.0 / OIDC
(or Cloud Run IAP), enforce Multi-Factor Authentication (MFA), and validate new admin passwords
against a leaked-password service (e.g., k-anonymity HIBP check).
"""

from __future__ import annotations

import collections
import datetime as dt
import hashlib
import hmac
import http.cookies
import math
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any

SESSION_COOKIE_NAME = "__Host-caps_session"
PRE_AUTH_CSRF_COOKIE_NAME = "__Host-caps_csrf"

SESSION_IDLE_SECONDS = 30 * 60       # 30 minutes inactivity timeout
SESSION_ABSOLUTE_SECONDS = 8 * 3600  # 8 hours maximum session lifetime
MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 128

VALID_SERVICES = ("antigravity", "gemini_platform", "gemini_enterprise")
VALID_CAP_TYPES = ("limit", "allow", "block")
VALID_CAP_SCOPES = ("total", "per_project")
VALID_PERIODS = ("daily", "weekly", "monthly")
VALID_ENFORCEMENT_MODES = ("auto", "manual")
VALID_RULE_MODES = ("unrestricted", "allow_list", "deny_list", "inherit")
VALID_VIOLATION_ACTIONS = ("block_service", "notify")

PRINCIPAL_RE = re.compile(r"^[A-Za-z0-9._%+:\/@-]{3,200}$")
MODEL_PATTERN_RE = re.compile(r"^(\*|[A-Za-z0-9][A-Za-z0-9._/*:-]{0,127})$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
PROJECT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")

SECURITY_HEADERS: tuple[tuple[str, str], ...] = (
    (
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    ),
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Permissions-Policy", "camera=(), microphone=(), geolocation=()"),
    ("Referrer-Policy", "no-referrer"),
)


class ValidationError(ValueError):
    """Raised when untrusted client input fails allow-list validation."""


# ---------------------------------------------------------------------------
# Password strength & memory-hard scrypt hashing
# ---------------------------------------------------------------------------

def validate_password_strength(password: str) -> str:
    if not isinstance(password, str):
        raise ValidationError("Password must be a string.")
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValidationError(f"비밀번호는 최소 {MIN_PASSWORD_LENGTH}자 이상이어야 합니다.")
    if len(password) > MAX_PASSWORD_LENGTH:
        raise ValidationError(f"비밀번호는 최대 {MAX_PASSWORD_LENGTH}자 이하여야 합니다.")
    if password.strip() == "":
        raise ValidationError("비밀번호는 공백만으로 구성할 수 없습니다.")
    return password


def hash_password(password: str) -> str:
    validate_password_strength(password)
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded_hash: str) -> bool:
    if not isinstance(password, str) or not isinstance(encoded_hash, str):
        return False
    parts = encoded_hash.split("$")
    if len(parts) != 3 or parts[0] != "scrypt":
        return False
    try:
        salt = bytes.fromhex(parts[1])
        expected = bytes.fromhex(parts[2])
    except ValueError:
        return False
    if len(salt) < 16 or len(expected) != 32:
        return False
    actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return hmac.compare_digest(actual, expected)


# ---------------------------------------------------------------------------
# Sliding-window per-IP rate limiter
# ---------------------------------------------------------------------------

class RateLimiter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._buckets: dict[tuple[str, str], collections.deque[float]] = {}

    def allow(self, client_ip: str, bucket: str, *, limit: int, window_seconds: int = 60) -> tuple[bool, int]:
        now = time.monotonic()
        cutoff = now - window_seconds
        key = (client_ip or "unknown", bucket)
        with self._lock:
            dq = self._buckets.get(key)
            if dq is None:
                dq = collections.deque()
                self._buckets[key] = dq
            while dq and dq[0] <= cutoff:
                dq.popleft()
            if len(dq) >= limit:
                retry_after = max(1, int(math.ceil(dq[0] + window_seconds - now)))
                return False, retry_after
            dq.append(now)
            return True, 0


# ---------------------------------------------------------------------------
# Session, Auth & CSRF manager
# ---------------------------------------------------------------------------

class AuthManager:
    def __init__(
        self,
        *,
        session_secret: str,
        base_dir: Path,
        is_cloud_run: bool,
        env_password_hash: str | None = None,
        env_password_plain: str | None = None,
    ) -> None:
        self._secret_bytes = session_secret.encode("utf-8")
        self._base_dir = base_dir.resolve()
        self._is_cloud_run = is_cloud_run
        self._lock = threading.Lock()
        self._sessions: dict[str, dict[str, Any]] = {}
        self._hash_file = (self._base_dir / ".local_admin_hash").resolve()
        sandbox_prefix = str(self._base_dir) + os.sep
        if not str(self._hash_file).startswith(sandbox_prefix):
            raise ValueError("Resolved admin hash path escapes workspace boundary.")

        self._password_hash: str | None = None
        if env_password_hash:
            if not env_password_hash.startswith("scrypt$") or len(env_password_hash.split("$")) != 3:
                raise ValueError("DASHBOARD_ADMIN_PASSWORD_HASH must be in scrypt$<salt>$<hash> format.")
            self._password_hash = env_password_hash
        elif env_password_plain:
            self._password_hash = hash_password(env_password_plain)
        elif not is_cloud_run and self._hash_file.is_file():
            stored = self._hash_file.read_text(encoding="utf-8").strip()
            if stored.startswith("scrypt$") and len(stored.split("$")) == 3:
                self._password_hash = stored

    @property
    def needs_setup(self) -> bool:
        with self._lock:
            return self._password_hash is None and not self._is_cloud_run

    @property
    def configured(self) -> bool:
        with self._lock:
            return self._password_hash is not None

    def setup_local_password(self, password: str) -> None:
        if self._is_cloud_run:
            raise ValidationError("Production deployments must configure DASHBOARD_ADMIN_PASSWORD_HASH via Secret Manager.")
        encoded = hash_password(password)
        with self._lock:
            if self._password_hash is not None:
                raise ValidationError("관리자 비밀번호가 이미 설정되어 있습니다.")
            fd = os.open(str(self._hash_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, (encoded + "\n").encode("utf-8"))
            finally:
                os.close(fd)
            self._password_hash = encoded

    def authenticate_password(self, password: str) -> bool:
        with self._lock:
            stored = self._password_hash
        if not stored:
            return False
        return verify_password(password, stored)

    def create_session(self) -> tuple[str, str]:
        now = time.time()
        sid = secrets.token_urlsafe(32)
        csrf_token = secrets.token_urlsafe(32)
        with self._lock:
            self._prune_expired_locked(now)
            self._sessions[sid] = {
                "created_at": now,
                "last_seen": now,
                "csrf_token": csrf_token,
                "role": "admin",
            }
        return sid, csrf_token

    def get_session(self, sid: str | None) -> dict[str, Any] | None:
        if not sid or len(sid) < 20:
            return None
        now = time.time()
        with self._lock:
            sess = self._sessions.get(sid)
            if sess is None:
                return None
            if (now - sess["last_seen"]) > SESSION_IDLE_SECONDS or (now - sess["created_at"]) > SESSION_ABSOLUTE_SECONDS:
                del self._sessions[sid]
                return None
            sess["last_seen"] = now
            return dict(sess)

    def invalidate_all_sessions(self) -> None:
        with self._lock:
            self._sessions.clear()

    def _prune_expired_locked(self, now: float) -> None:
        expired = [
            k
            for k, v in self._sessions.items()
            if (now - v["last_seen"]) > SESSION_IDLE_SECONDS or (now - v["created_at"]) > SESSION_ABSOLUTE_SECONDS
        ]
        for k in expired:
            del self._sessions[k]

    # Pre-auth signed CSRF token (used exclusively for login / first-time setup)
    def issue_pre_auth_csrf(self) -> str:
        nonce = secrets.token_urlsafe(24)
        ts = str(int(time.time()))
        sig = hmac.new(self._secret_bytes, f"{nonce}.{ts}".encode("utf-8"), hashlib.sha256).hexdigest()
        return f"{nonce}.{ts}.{sig}"

    def verify_pre_auth_csrf(self, cookie_token: str | None, header_token: str | None) -> bool:
        if not cookie_token or not header_token:
            return False
        if not hmac.compare_digest(cookie_token, header_token):
            return False
        parts = cookie_token.split(".")
        if len(parts) != 3:
            return False
        nonce, ts_str, sig = parts
        try:
            ts = int(ts_str)
        except ValueError:
            return False
        if abs(time.time() - ts) > 3600:
            return False
        expected = hmac.new(self._secret_bytes, f"{nonce}.{ts_str}".encode("utf-8"), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, expected)

    @staticmethod
    def verify_session_csrf(session: dict[str, Any], header_token: str | None) -> bool:
        expected = str(session.get("csrf_token") or "")
        if not expected or not header_token:
            return False
        return hmac.compare_digest(expected, header_token)


def parse_cookies(cookie_header: str | None) -> dict[str, str]:
    if not cookie_header:
        return {}
    jar: http.cookies.SimpleCookie = http.cookies.SimpleCookie()
    try:
        jar.load(cookie_header)
    except http.cookies.CookieError:
        return {}
    return {k: v.value for k, v in jar.items()}


def format_cookie(name: str, value: str, *, max_age: int) -> str:
    # Hardened __Host- cookie: HttpOnly, Secure, SameSite=Strict, Path=/, no Domain.
    return f"{name}={value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={max_age}"


# ---------------------------------------------------------------------------
# Strict Input Validators (Allow-List Enforcement)
# ---------------------------------------------------------------------------

def validate_principal(value: Any, field: str = "email") -> str:
    if not isinstance(value, str):
        raise ValidationError(f"Field '{field}' must be a string.")
    clean = value.strip()
    if not clean or ".." in clean or not PRINCIPAL_RE.match(clean):
        raise ValidationError(f"유효하지 않은 사용자 식별자({field}) 형식입니다.")
    return clean


def validate_project(value: Any, allowed_projects: tuple[str, ...], *, allow_all: bool = False) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValidationError("Project ID must be a string.")
    clean = value.strip().lower()
    if allow_all and clean == "all":
        return None
    if not PROJECT_ID_RE.match(clean) or clean not in allowed_projects:
        raise ValidationError("허용되지 않은 프로젝트 ID입니다.")
    return clean


def validate_projects_list(value: Any, allowed_projects: tuple[str, ...]) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise ValidationError("projects 필드는 목록이어야 합니다.")
    out: list[str] = []
    for item in value:
        p = validate_project(item, allowed_projects)
        if p and p not in out:
            out.append(p)
    return out if out else None


def validate_services(value: Any, *, required: bool = False) -> list[str] | None:
    if value is None:
        if required:
            raise ValidationError("최소 1개 이상의 서비스를 선택하세요.")
        return None
    if not isinstance(value, list):
        raise ValidationError("services 필드는 목록이어야 합니다.")
    out: list[str] = []
    for s in value:
        if not isinstance(s, str):
            raise ValidationError("서비스 ID는 문자열이어야 합니다.")
        clean = s.strip().lower()
        if clean not in VALID_SERVICES:
            raise ValidationError(f"허용되지 않은 서비스입니다: {clean}")
        if clean not in out:
            out.append(clean)
    if required and not out:
        raise ValidationError("최소 1개 이상의 서비스를 선택하세요.")
    return out


def validate_model_pattern(value: Any) -> str:
    if not isinstance(value, str):
        raise ValidationError("모델 패턴은 문자열이어야 합니다.")
    clean = value.strip().lower()
    if not clean or ".." in clean or not MODEL_PATTERN_RE.match(clean):
        raise ValidationError("유효하지 않은 모델 ID 또는 패턴입니다.")
    return clean


def validate_date_str(value: Any, field: str) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not DATE_RE.match(value.strip()):
        raise ValidationError(f"{field} 날짜는 YYYY-MM-DD 형식이어야 합니다.")
    clean = value.strip()
    try:
        dt.date.fromisoformat(clean)
    except ValueError as exc:
        raise ValidationError(f"유효하지 않은 날짜입니다: {field}") from exc
    return clean


def validate_number(
    value: Any,
    field: str,
    *,
    integer: bool = False,
    min_val: float = 0.0,
    max_val: float = 1e12,
    required: bool = False,
) -> int | float | None:
    if value is None or value == "":
        if required:
            raise ValidationError(f"'{field}' 값은 필수입니다.")
        return None
    if isinstance(value, bool):
        raise ValidationError(f"'{field}' 값은 숫자여야 합니다.")
    try:
        num = int(value) if integer else float(value)
    except (TypeError, ValueError) as exc:
        raise ValidationError(f"'{field}' 값은 유효한 숫자여야 합니다.") from exc
    if not math.isfinite(num) or num < min_val or num > max_val:
        raise ValidationError(f"'{field}' 값이 허용 범위를 벗어났습니다.")
    return int(num) if integer else round(float(num), 6)


def validate_text(value: Any, field: str, *, max_len: int = 200) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValidationError(f"'{field}' 값은 문자열이어야 합니다.")
    clean = value.strip()
    if len(clean) > max_len:
        raise ValidationError(f"'{field}' 값은 {max_len}자 이내여야 합니다.")
    return clean


def validate_rfc3339(value: Any, field: str = "until") -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValidationError(f"'{field}' 값은 RFC3339 형식 문자열이어야 합니다.")
    clean = value.strip()
    try:
        parsed = dt.datetime.fromisoformat(clean.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValidationError(f"'{field}' 형식이 올바르지 않습니다 (예: 2026-12-01T00:00:00Z).") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def validate_model_rule_payload(body: dict[str, Any], *, is_default: bool) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise ValidationError("요청 본문은 JSON 객체여야 합니다.")

    mode = str(body.get("mode") or ("unrestricted" if is_default else "inherit")).strip().lower()
    allowed_modes = [m for m in VALID_RULE_MODES if not (is_default and m == "inherit")]
    if mode not in allowed_modes:
        raise ValidationError(f"mode는 {', '.join(allowed_modes)} 중 하나여야 합니다.")

    raw_models = body.get("models") or []
    if not isinstance(raw_models, list) or len(raw_models) > 100:
        raise ValidationError("models는 최대 100개의 목록이어야 합니다.")
    models: list[str] = []
    for item in raw_models:
        p = validate_model_pattern(item)
        if p not in models:
            models.append(p)

    if mode == "deny_list" and not models:
        raise ValidationError("deny_list 모드에는 차단할 모델 패턴이 최소 1개 필요합니다.")
    if mode == "allow_list" and not models and not bool(body.get("force")):
        raise ValidationError("allow_list 모드에는 허용할 모델 패턴이 최소 1개 필요합니다.")

    raw_limits = body.get("limits") or []
    if not isinstance(raw_limits, list) or len(raw_limits) > 50:
        raise ValidationError("limits는 최대 50개까지 설정할 수 있습니다.")

    limits: list[dict[str, Any]] = []
    for item in raw_limits:
        if not isinstance(item, dict):
            raise ValidationError("각 모델 한도 항목은 객체여야 합니다.")
        model_pat = validate_model_pattern(item.get("model") or "*")
        entry: dict[str, Any] = {"model": model_pat}
        for metric, is_int in (
            ("monthly_cost", False),
            ("monthly_tokens", True),
            ("daily_tokens", True),
            ("monthly_requests", True),
            ("daily_requests", True),
            ("rpm", True),
            ("tpm", True),
        ):
            val = validate_number(item.get(metric), metric, integer=is_int, min_val=0)
            if val is not None:
                entry[metric] = val
        if len(entry) == 1:
            raise ValidationError(f"모델 '{model_pat}'에 최소 1개 이상의 예산/사용량 한도를 입력하세요.")
        limits.append(entry)

    on_violation = str(body.get("on_violation") or "block_service").strip().lower()
    if on_violation not in VALID_VIOLATION_ACTIONS:
        raise ValidationError("on_violation은 block_service 또는 notify여야 합니다.")

    payload: dict[str, Any] = {
        "mode": mode,
        "models": models,
        "limits": limits,
        "on_violation": on_violation,
        "note": validate_text(body.get("note"), "note", max_len=200),
    }
    surfaces = validate_services(body.get("surfaces"))
    if surfaces:
        payload["surfaces"] = surfaces
    block_services = validate_services(body.get("block_services"))
    if block_services:
        payload["block_services"] = block_services
    block_minutes = validate_number(body.get("block_minutes"), "block_minutes", integer=True, min_val=0, max_val=525600)
    if block_minutes is not None:
        payload["block_minutes"] = block_minutes
    until = validate_rfc3339(body.get("until"), "until")
    if until:
        payload["until"] = until
    if body.get("force") is True:
        payload["force"] = True
    return payload
