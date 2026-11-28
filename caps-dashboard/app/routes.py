"""HTTP BFF router and static asset handler for the Hub-and-Spoke AI Caps Dashboard.

Allow-lists ONLY GET and POST methods, validates all inputs against strict schemas,
authenticates every /api/* endpoint, enforces CSRF tokens on all state changes,
rate-limits all API calls, and sets strict security headers on every response.
"""

from __future__ import annotations

import concurrent.futures
import contextvars
import datetime as dt
import hashlib
import http.server
import json
import logging
import os
import urllib.parse
from pathlib import Path
from typing import Any

from .caps_client import TRACE_ACTION, TRACE_SESSION, CapsApiClient, CapsApiError
from .config import DashboardConfig
from .security import (
    PRE_AUTH_CSRF_COOKIE_NAME,
    SECURITY_HEADERS,
    SESSION_ABSOLUTE_SECONDS,
    SESSION_COOKIE_NAME,
    VALID_CAP_SCOPES,
    VALID_CAP_TYPES,
    VALID_ENFORCEMENT_MODES,
    VALID_PERIODS,
    AuthManager,
    RateLimiter,
    ValidationError,
    format_cookie,
    parse_cookies,
    validate_date_str,
    validate_model_pattern,
    validate_model_rule_payload,
    validate_number,
    validate_principal,
    validate_project,
    validate_projects_list,
    validate_rfc3339,
    validate_services,
    validate_text,
)

LOG = logging.getLogger("caps_dashboard.routes")

MAX_BODY_BYTES = 128 * 1024  # 128 KB JSON payload limit

STATIC_ASSETS: dict[str, tuple[str, str]] = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}


class DashboardContext:
    def __init__(self, config: DashboardConfig, client: CapsApiClient, auth: AuthManager) -> None:
        self.config = config
        self.client = client
        self.auth = auth
        self.limiter = RateLimiter()
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=8)

    def shutdown(self) -> None:
        self.executor.shutdown(wait=False)


def _parallel_fetch(executor: concurrent.futures.ThreadPoolExecutor, tasks: dict[str, Any]) -> tuple[dict[str, Any], dict[str, str]]:
    # Each task runs in its own copy of the caller's context so the API Call Inspector
    # can attribute upstream calls made from worker threads to the calling session.
    futures = {name: executor.submit(contextvars.copy_context().run, fn) for name, fn in tasks.items()}
    results: dict[str, Any] = {}
    errors: dict[str, str] = {}
    for name, fut in futures.items():
        try:
            results[name] = fut.result(timeout=45)
        except CapsApiError as err:
            results[name] = None
            errors[name] = f"{err.code}: {err.message}"
        except Exception:  # pylint: disable=broad-except
            LOG.exception("Unexpected error fetching upstream task '%s'", name)
            results[name] = None
            errors[name] = "upstream_fetch_failed"
    return results, errors


def _trace_key(sid: str | None) -> str | None:
    """Opaque, non-reversible per-session key for the API Call Inspector ring buffer."""
    if not sid:
        return None
    return hashlib.sha256(sid.encode("utf-8")).hexdigest()[:32]


def _default_date_range() -> tuple[str, str]:
    today = dt.datetime.now(dt.timezone.utc).date()
    start = today.replace(day=1)
    return start.isoformat(), today.isoformat()


def _merge_users(
    usage_rows: list[dict[str, Any]],
    cap_rows: list[dict[str, Any]],
    model_rules_resp: dict[str, Any] | None,
    managed_projects: tuple[str, ...],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    usage_by_email = {str(r.get("email") or "").lower(): r for r in usage_rows if r.get("email")}
    cap_by_email = {str(r.get("email") or "").lower(): r for r in cap_rows if r.get("email")}

    user_model_rules: dict[str, dict[str, Any]] = {}
    default_model_rule = None
    if isinstance(model_rules_resp, dict):
        default_model_rule = model_rules_resp.get("default")
        for item in model_rules_resp.get("data") or []:
            em = str(item.get("email") or "").lower()
            if em:
                user_model_rules[em] = item.get("rule") or item

    project_totals: dict[str, dict[str, Any]] = {
        p: {
            "project_id": p,
            "active_users": 0,
            "blocked_users": 0,
            "requests": 0,
            "total_tokens": 0,
            "estimated_cost": 0.0,
        }
        for p in managed_projects
    }

    all_emails = sorted(set(usage_by_email) | set(cap_by_email) | set(user_model_rules))
    merged: list[dict[str, Any]] = []

    for key in all_emails:
        u = usage_by_email.get(key) or {}
        c = cap_by_email.get(key) or {}
        email = str(u.get("email") or c.get("email") or key)

        u_projects_map: dict[str, dict[str, Any]] = {}
        for bp in u.get("by_project") or []:
            pid = str(bp.get("project") or "")
            if pid:
                u_projects_map[pid] = {
                    "project": pid,
                    "requests": int(bp.get("requests") or 0),
                    "total_tokens": int(bp.get("total_tokens") or 0),
                    "estimated_cost": round(float(bp.get("estimated_cost") or 0.0), 6),
                }

        c_projects_map: dict[str, dict[str, Any]] = {}
        for cp in c.get("projects") or []:
            pid = str(cp.get("project") or "")
            if pid:
                c_projects_map[pid] = cp

        # Aggregate per-project stats for managed Hub & Spoke cards
        for pid in set(u_projects_map) | set(c_projects_map):
            if pid not in project_totals:
                continue
            up = u_projects_map.get(pid) or {}
            cp = c_projects_map.get(pid) or {}
            reqs = int(up.get("requests") or 0)
            toks = int(up.get("total_tokens") or 0)
            cost = float(up.get("estimated_cost") or 0.0)
            if reqs > 0 or toks > 0 or cost > 0:
                project_totals[pid]["active_users"] += 1
            project_totals[pid]["requests"] += reqs
            project_totals[pid]["total_tokens"] += toks
            project_totals[pid]["estimated_cost"] = round(project_totals[pid]["estimated_cost"] + cost, 6)
            if cp.get("status") in ("blocked", "suspended"):
                project_totals[pid]["blocked_users"] += 1

        projects_list = sorted(set(u.get("projects") or []) | set(u_projects_map) | set(c_projects_map))
        user_rule = user_model_rules.get(key)
        effective_model_rule = user_rule or default_model_rule
        model_rule_source = "user" if user_rule else ("default" if default_model_rule else "none")

        usage_obj = u if u else (c.get("usage") or {})
        merged.append(
            {
                "email": email,
                "uid": u.get("uid") or c.get("uid") or "",
                "is_service_account": email.endswith(".gserviceaccount.com"),
                "projects": projects_list,
                "multi_project": len(projects_list) > 1 or bool(u.get("multi_project") or c.get("multi_project")),
                "by_project": [
                    {
                        "project": pid,
                        "requests": (u_projects_map.get(pid) or {}).get("requests", 0),
                        "total_tokens": (u_projects_map.get(pid) or {}).get("total_tokens", 0),
                        "estimated_cost": (u_projects_map.get(pid) or {}).get("estimated_cost", 0.0),
                        "status": (c_projects_map.get(pid) or {}).get("status", c.get("status", "active")),
                        "limit": (c_projects_map.get(pid) or {}).get("limit"),
                        "utilization_pct": (c_projects_map.get(pid) or {}).get("utilization_pct"),
                        "blocked_services": (c_projects_map.get(pid) or {}).get("blocked_services") or [],
                        "enforcement_status": (c_projects_map.get(pid) or {}).get("enforcement_status") or "none",
                    }
                    for pid in projects_list
                ],
                "surfaces": u.get("surfaces") or [],
                "requests": int(usage_obj.get("requests") or 0),
                "input_tokens": int(usage_obj.get("input_tokens") or 0),
                "output_tokens": int(usage_obj.get("output_tokens") or 0),
                "cached_tokens": int(usage_obj.get("cached_tokens") or 0),
                "total_tokens": int(usage_obj.get("total_tokens") or 0),
                "estimated_cost": round(float(usage_obj.get("estimated_cost") or 0.0), 6),
                "currency": usage_obj.get("currency") or "USD",
                "by_model": u.get("by_model") or [],
                "last_active": usage_obj.get("last_active"),
                "status": c.get("status") or "active",
                "status_scope": c.get("status_scope"),
                "block_source": c.get("block_source"),
                "blocked_services": c.get("blocked_services") or [],
                "blocked_projects": c.get("blocked_projects") or {},
                "enforcement_status": c.get("enforcement_status") or "none",
                "pending_blocked_services": c.get("pending_blocked_services") or [],
                "pending_blocked_projects": c.get("pending_blocked_projects") or {},
                "over_cap": bool(c.get("over_cap")),
                "over_cap_reasons": c.get("over_cap_reasons") or [],
                "utilization_pct": c.get("utilization_pct"),
                "cap_scope": c.get("cap_scope") or "total",
                "limit": c.get("limit") or {},
                "cap_usage": c.get("usage") or {},
                "remaining": c.get("remaining") or {},
                "rule_source": c.get("rule_source") or "policy",
                "cap_rule": c.get("rule"),
                "restore_at": c.get("restore_at"),
                "user_model_rule": user_rule,
                "effective_model_rule": effective_model_rule,
                "model_rule_source": model_rule_source,
            }
        )

    merged.sort(key=lambda row: (-float(row["estimated_cost"]), -int(row["requests"]), row["email"]))
    return merged, project_totals


def make_handler(ctx: DashboardContext) -> type[http.server.BaseHTTPRequestHandler]:
    class DashboardHandler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            # Sanitized request logging without query strings or sensitive headers.
            path_only = urllib.parse.urlsplit(self.path).path
            LOG.info("%s %s %s", self.client_address[0], self.command, path_only)

        def _client_ip(self) -> str:
            if ctx.config.is_cloud_run:
                xff = self.headers.get("X-Forwarded-For", "")
                if xff:
                    return xff.split(",")[0].strip()
            return self.client_address[0]

        def _send_headers_common(self, *, is_api: bool) -> None:
            for k, v in SECURITY_HEADERS:
                self.send_header(k, v)
            if is_api:
                self.send_header("Cache-Control", "no-store")
                self.send_header("Pragma", "no-cache")
            else:
                self.send_header("Cache-Control", "no-cache")

        def _send_json(
            self,
            status: int,
            payload: dict[str, Any],
            *,
            extra_headers: list[tuple[str, str]] | None = None,
        ) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._send_headers_common(is_api=True)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            for k, v in extra_headers or []:
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(raw)

        def _send_error_json(self, status: int, code: str, message: str, *, extra_headers: list[tuple[str, str]] | None = None) -> None:
            self._send_json(status, {"error": {"code": code, "message": message}}, extra_headers=extra_headers)

        def _read_json_body(self) -> dict[str, Any]:
            raw_len = self.headers.get("Content-Length")
            if raw_len is None:
                return {}
            try:
                length = int(raw_len)
            except ValueError as exc:
                raise ValidationError("Invalid Content-Length header.") from exc
            if length < 0 or length > MAX_BODY_BYTES:
                raise ValidationError("요청 본문 크기가 허용 한도를 초과했습니다.")
            if length == 0:
                return {}
            body_bytes = self.rfile.read(length)
            try:
                data = json.loads(body_bytes.decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as exc:
                raise ValidationError("유효한 JSON 본문이 아닙니다.") from exc
            if not isinstance(data, dict):
                raise ValidationError("요청 본문은 JSON 객체여야 합니다.")
            return data

        def _check_rate_limit(self, bucket: str, limit: int) -> bool:
            ok, retry_after = ctx.limiter.allow(self._client_ip(), bucket, limit=limit, window_seconds=60)
            if not ok:
                self._send_error_json(
                    429,
                    "rate_limited",
                    "요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
                    extra_headers=[("Retry-After", str(retry_after))],
                )
            return ok

        def _require_auth(self, *, require_csrf: bool = False) -> dict[str, Any] | None:
            cookies = parse_cookies(self.headers.get("Cookie"))
            sid = cookies.get(SESSION_COOKIE_NAME)
            session = ctx.auth.get_session(sid)
            if session is None:
                self._send_error_json(401, "unauthorized", "로그인이 필요합니다.")
                return None
            if require_csrf:
                header_csrf = self.headers.get("X-CSRF-Token")
                if not ctx.auth.verify_session_csrf(session, header_csrf):
                    self._send_error_json(403, "csrf_invalid", "유효하지 않은 CSRF 토큰입니다. 페이지를 새로고침하세요.")
                    return None
            # API Call Inspector attribution: opaque per-session key + BFF route label.
            TRACE_SESSION.set(_trace_key(sid))
            TRACE_ACTION.set(f"{self.command} {urllib.parse.urlsplit(self.path).path}")
            return session

        def _serve_static(self, path: str) -> None:
            asset = STATIC_ASSETS.get(path)
            if asset is None:
                self._send_error_json(404, "not_found", "페이지를 찾을 수 없습니다.")
                return
            filename, content_type = asset
            safe_name = os.path.basename(filename)
            target = (ctx.config.web_dir / safe_name).resolve()
            sandbox_prefix = str(ctx.config.web_dir.resolve()) + os.sep
            if not str(target).startswith(sandbox_prefix) or not target.is_file():
                self._send_error_json(404, "not_found", "리소스를 찾을 수 없습니다.")
                return
            data = target.read_bytes()
            self.send_response(200)
            self._send_headers_common(is_api=False)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        # --- Reject all HTTP methods outside GET / POST -----------------------
        def _method_not_allowed(self) -> None:
            self._send_error_json(
                405,
                "method_not_allowed",
                "허용되지 않은 HTTP 메서드입니다.",
                extra_headers=[("Allow", "GET, POST")],
            )

        do_PUT = _method_not_allowed
        do_DELETE = _method_not_allowed
        do_PATCH = _method_not_allowed
        do_TRACE = _method_not_allowed
        do_OPTIONS = _method_not_allowed
        do_HEAD = _method_not_allowed

        # --- GET Routing ------------------------------------------------------
        def do_GET(self) -> None:
            TRACE_SESSION.set(None)
            TRACE_ACTION.set("")
            parsed = urllib.parse.urlsplit(self.path)
            path = parsed.path
            qs = {k: v[-1] for k, v in urllib.parse.parse_qs(parsed.query, keep_blank_values=False).items()}

            if not path.startswith("/api/"):
                self._serve_static(path)
                return

            # The inspector feed is polled after every console action; give it its own bucket
            # so it can never starve real data requests.
            if path == "/api/_trace":
                if not self._check_rate_limit("api_trace", limit=300):
                    return
            elif not self._check_rate_limit("api_get", limit=120):
                return

            try:
                if path == "/api/auth/status":
                    self._handle_auth_status()
                    return

                session = self._require_auth(require_csrf=False)
                if session is None:
                    return

                if path == "/api/overview":
                    self._handle_overview(qs)
                elif path == "/api/user/detail":
                    self._handle_user_detail(qs)
                elif path == "/api/user/cap":
                    self._handle_user_cap(qs)
                elif path == "/api/costs":
                    self._handle_costs(qs)
                elif path == "/api/models/catalog":
                    self._handle_models_catalog(qs)
                elif path == "/api/projects/overview":
                    self._handle_projects_overview()
                elif path == "/api/audit":
                    self._handle_audit(qs)
                elif path == "/api/_trace":
                    self._handle_trace(qs)
                else:
                    self._send_error_json(404, "not_found", "알 수 없는 API 엔드포인트입니다.")
            except ValidationError as err:
                self._send_error_json(400, "validation_error", str(err))
            except CapsApiError as err:
                status = err.status if 400 <= err.status < 600 else 502
                self._send_error_json(status, err.code, err.message)
            except Exception:  # pylint: disable=broad-except
                LOG.exception("Unhandled error in GET %s", path)
                self._send_error_json(500, "internal_error", "요청을 처리하는 중 내부 오류가 발생했습니다.")

        # --- POST Routing -----------------------------------------------------
        def do_POST(self) -> None:
            TRACE_SESSION.set(None)
            TRACE_ACTION.set("")
            parsed = urllib.parse.urlsplit(self.path)
            path = parsed.path
            if not path.startswith("/api/"):
                self._send_error_json(404, "not_found", "알 수 없는 엔드포인트입니다.")
                return

            is_auth_route = path in ("/api/auth/login", "/api/auth/setup")
            if not self._check_rate_limit("auth" if is_auth_route else "api_post", limit=10 if is_auth_route else 40):
                return

            try:
                body = self._read_json_body()
                if path == "/api/auth/setup":
                    self._handle_auth_setup(body)
                    return
                if path == "/api/auth/login":
                    self._handle_auth_login(body)
                    return

                session = self._require_auth(require_csrf=True)
                if session is None:
                    return

                if path == "/api/auth/logout":
                    self._handle_auth_logout()
                elif path == "/api/caps/policy":
                    self._handle_update_policy(body)
                elif path == "/api/caps/enforce":
                    self._handle_enforce_caps(body)
                elif path == "/api/caps/users/set":
                    self._handle_set_user_cap(body)
                elif path == "/api/caps/users/delete":
                    self._handle_delete_user_cap(body)
                elif path == "/api/users/block":
                    self._handle_block_user(body)
                elif path == "/api/users/unblock":
                    self._handle_unblock_user(body)
                elif path == "/api/model-rules/default/set":
                    self._handle_set_default_model_rule(body)
                elif path == "/api/model-rules/default/delete":
                    self._handle_delete_default_model_rule()
                elif path == "/api/model-rules/user/set":
                    self._handle_set_user_model_rule(body)
                elif path == "/api/model-rules/user/delete":
                    self._handle_delete_user_model_rule(body)
                elif path == "/api/model-rules/evaluate":
                    self._handle_evaluate_model_rules(body)
                elif path == "/api/model-access/toggle":
                    self._handle_toggle_model_access(body)
                elif path == "/api/caps/projects/set":
                    self._handle_set_project_cap(body)
                elif path == "/api/caps/projects/lift":
                    self._handle_lift_project_cap(body)
                elif path == "/api/projects/inference-logging/enable":
                    self._handle_enable_inference_logging(body)
                else:
                    self._send_error_json(404, "not_found", "알 수 없는 API 엔드포인트입니다.")
            except ValidationError as err:
                self._send_error_json(400, "validation_error", str(err))
            except CapsApiError as err:
                status = err.status if 400 <= err.status < 600 else 502
                self._send_error_json(status, err.code, err.message)
            except Exception:  # pylint: disable=broad-except
                LOG.exception("Unhandled error in POST %s", path)
                self._send_error_json(500, "internal_error", "요청을 처리하는 중 내부 오류가 발생했습니다.")

        # --- Auth Handlers ----------------------------------------------------
        def _handle_auth_status(self) -> None:
            cookies = parse_cookies(self.headers.get("Cookie"))
            session = ctx.auth.get_session(cookies.get(SESSION_COOKIE_NAME))
            if session is not None:
                self._send_json(
                    200,
                    {
                        "authenticated": True,
                        "needs_setup": False,
                        "api_configured": ctx.client.configured,
                        "hub_project": ctx.config.hub_project,
                        "spoke_projects": list(ctx.config.spoke_projects),
                        "managed_projects": list(ctx.config.managed_projects),
                        "csrf_token": session["csrf_token"],
                    },
                )
                return

            pre_csrf = ctx.auth.issue_pre_auth_csrf()
            self._send_json(
                200,
                {
                    "authenticated": False,
                    "needs_setup": ctx.auth.needs_setup,
                    "auth_configured": ctx.auth.configured,
                    "api_configured": ctx.client.configured,
                    "hub_project": ctx.config.hub_project,
                    "spoke_projects": list(ctx.config.spoke_projects),
                    "managed_projects": list(ctx.config.managed_projects),
                    "csrf_token": pre_csrf,
                },
                extra_headers=[
                    ("Set-Cookie", format_cookie(PRE_AUTH_CSRF_COOKIE_NAME, pre_csrf, max_age=3600)),
                ],
            )

        def _verify_pre_auth_csrf(self) -> bool:
            cookies = parse_cookies(self.headers.get("Cookie"))
            ok = ctx.auth.verify_pre_auth_csrf(
                cookies.get(PRE_AUTH_CSRF_COOKIE_NAME),
                self.headers.get("X-CSRF-Token"),
            )
            if not ok:
                self._send_error_json(403, "csrf_invalid", "유효하지 않은 CSRF 토큰입니다. 페이지를 새로고침하세요.")
            return ok

        def _handle_auth_setup(self, body: dict[str, Any]) -> None:
            if not self._verify_pre_auth_csrf():
                return
            password = body.get("password")
            confirm = body.get("confirm_password")
            if not isinstance(password, str) or password != confirm:
                raise ValidationError("비밀번호와 비밀번호 확인이 일치하지 않습니다.")
            ctx.auth.setup_local_password(password)
            sid, csrf_token = ctx.auth.create_session()
            self._send_json(
                200,
                {"authenticated": True, "csrf_token": csrf_token},
                extra_headers=[
                    ("Set-Cookie", format_cookie(SESSION_COOKIE_NAME, sid, max_age=SESSION_ABSOLUTE_SECONDS)),
                    ("Set-Cookie", format_cookie(PRE_AUTH_CSRF_COOKIE_NAME, "", max_age=0)),
                ],
            )

        def _handle_auth_login(self, body: dict[str, Any]) -> None:
            if not self._verify_pre_auth_csrf():
                return
            if not ctx.auth.configured:
                self._send_error_json(503, "auth_not_configured", "관리자 비밀번호가 아직 설정되지 않았습니다.")
                return
            password = body.get("password")
            if not isinstance(password, str) or not ctx.auth.authenticate_password(password):
                # Never log credentials even on failed attempts.
                self._send_error_json(401, "invalid_credentials", "비밀번호가 올바르지 않습니다.")
                return
            sid, csrf_token = ctx.auth.create_session()
            self._send_json(
                200,
                {"authenticated": True, "csrf_token": csrf_token},
                extra_headers=[
                    ("Set-Cookie", format_cookie(SESSION_COOKIE_NAME, sid, max_age=SESSION_ABSOLUTE_SECONDS)),
                    ("Set-Cookie", format_cookie(PRE_AUTH_CSRF_COOKIE_NAME, "", max_age=0)),
                ],
            )

        def _handle_auth_logout(self) -> None:
            ctx.auth.invalidate_all_sessions()
            ctx.client.tracer.clear()
            self._send_json(
                200,
                {"authenticated": False},
                extra_headers=[
                    ("Set-Cookie", format_cookie(SESSION_COOKIE_NAME, "", max_age=0)),
                ],
            )

        # --- Dashboard GET Handlers -------------------------------------------
        def _handle_overview(self, qs: dict[str, str]) -> None:
            default_start, default_end = _default_date_range()
            start = validate_date_str(qs.get("start"), "start") or default_start
            end = validate_date_str(qs.get("end"), "end") or default_end
            project = validate_project(qs.get("project"), ctx.config.managed_projects, allow_all=True)
            fresh = qs.get("fresh", "").lower() == "true"

            usage_params: dict[str, Any] = {"start": start, "end": end, "fresh": fresh}
            cap_params: dict[str, Any] = {"fresh": fresh}
            if project:
                usage_params["project"] = project
                cap_params["project"] = project

            results, errors = _parallel_fetch(
                ctx.executor,
                {
                    "health": ctx.client.health,
                    "policy": ctx.client.get_cap_policy,
                    "usage_users": lambda: ctx.client.list_user_usage(**usage_params),
                    "caps_users": lambda: ctx.client.list_user_caps(**cap_params),
                    "usage_models": lambda: ctx.client.list_model_usage(**usage_params),
                    "model_rules": ctx.client.list_model_rules,
                    "project_caps": ctx.client.list_project_caps,
                },
            )

            usage_resp = results.get("usage_users") or {}
            caps_resp = results.get("caps_users") or {}
            models_resp = results.get("usage_models") or {}

            merged_users, project_totals = _merge_users(
                usage_resp.get("data") or [],
                caps_resp.get("data") or [],
                results.get("model_rules"),
                ctx.config.managed_projects,
            )

            self._send_json(
                200,
                {
                    "hub_project": ctx.config.hub_project,
                    "spoke_projects": list(ctx.config.spoke_projects),
                    "managed_projects": list(ctx.config.managed_projects),
                    "range": {"start": start, "end": end, "project": project or "all", "fresh": fresh},
                    "health": results.get("health"),
                    "policy": results.get("policy"),
                    "summary": usage_resp.get("summary") or {},
                    "caps_summary": caps_resp.get("summary") or {},
                    "caps_period": caps_resp.get("period") or {},
                    "pricing_source": usage_resp.get("pricing_source") or {},
                    "telemetry": usage_resp.get("telemetry") or {},
                    "project_totals": list(project_totals.values()),
                    "project_caps": (results.get("project_caps") or {}).get("data") or [],
                    "users": merged_users,
                    "top_models": (models_resp.get("data") or [])[:12],
                    "default_model_rule": (results.get("model_rules") or {}).get("default"),
                    "partial_errors": errors,
                },
            )

        def _handle_user_detail(self, qs: dict[str, str]) -> None:
            email = validate_principal(qs.get("email"), "email")
            default_start, default_end = _default_date_range()
            start = validate_date_str(qs.get("start"), "start") or default_start
            end = validate_date_str(qs.get("end"), "end") or default_end
            fresh = qs.get("fresh", "").lower() == "true"

            results, errors = _parallel_fetch(
                ctx.executor,
                {
                    "usage": lambda: ctx.client.user_usage(email, start=start, end=end, fresh=fresh),
                    "projects": lambda: ctx.client.user_projects(email, start=start, end=end),
                    "cap": lambda: ctx.client.get_user_cap(email, fresh=fresh),
                    "model_rules": lambda: ctx.client.get_user_model_rules(email),
                    "audit": lambda: ctx.client.list_audit_logs(target=email, limit=25),
                },
            )
            self._send_json(
                200,
                {
                    "email": email,
                    "range": {"start": start, "end": end},
                    "usage": results.get("usage"),
                    "projects": results.get("projects"),
                    "cap": results.get("cap"),
                    "model_rules": results.get("model_rules"),
                    "audit_logs": (results.get("audit") or {}).get("data") or [],
                    "partial_errors": errors,
                },
            )

        def _handle_user_cap(self, qs: dict[str, str]) -> None:
            """Lightweight per-user cap/enforcement status (used for propagating -> enforced polling)."""
            email = validate_principal(qs.get("email"), "email")
            fresh = qs.get("fresh", "").lower() == "true"
            cap = ctx.client.get_user_cap(email, fresh=fresh)
            self._send_json(200, {"email": email, "cap": cap})

        def _handle_costs(self, qs: dict[str, str]) -> None:
            default_start, default_end = _default_date_range()
            start = validate_date_str(qs.get("start"), "start") or default_start
            end = validate_date_str(qs.get("end"), "end") or default_end
            if start > end:
                raise ValidationError("시작일은 종료일보다 이후일 수 없습니다.")
            project = validate_project(qs.get("project"), ctx.config.managed_projects, allow_all=True)
            usage_params: dict[str, Any] = {"start": start, "end": end}
            if project:
                usage_params["project"] = project
            results, errors = _parallel_fetch(
                ctx.executor,
                {
                    "users": lambda: ctx.client.list_user_usage(**usage_params),
                    "models": lambda: ctx.client.list_model_usage(**usage_params),
                    "pricing": ctx.client.pricing,
                },
            )
            users_resp = results.get("users") or {}
            self._send_json(
                200,
                {
                    "range": {"start": start, "end": end, "project": project or "all"},
                    "hub_project": ctx.config.hub_project,
                    "spoke_projects": list(ctx.config.spoke_projects),
                    "summary": users_resp.get("summary") or {},
                    "pricing_source": users_resp.get("pricing_source") or {},
                    "users": users_resp.get("data") or [],
                    "models": (results.get("models") or {}).get("data") or [],
                    "pricing": (results.get("pricing") or {}).get("data") or [],
                    "partial_errors": errors,
                },
            )

        def _handle_trace(self, qs: dict[str, str]) -> None:
            """API Call Inspector feed: upstream Caps API calls made for this session only."""
            since = validate_number(qs.get("since") or 0, "since", integer=True, min_val=0, max_val=10**12)
            cookies = parse_cookies(self.headers.get("Cookie"))
            calls, last_seq = ctx.client.tracer.since(_trace_key(cookies.get(SESSION_COOKIE_NAME)), int(since or 0))
            self._send_json(
                200,
                {
                    "api_host": ctx.client.api_host,
                    "auth": "Authorization: Bearer (BFF 서버 측에서만 주입 · 브라우저 미노출)",
                    "calls": calls,
                    "last_seq": last_seq,
                },
            )

        def _handle_models_catalog(self, qs: dict[str, str]) -> None:
            default_start, default_end = _default_date_range()
            start = validate_date_str(qs.get("start"), "start") or default_start
            end = validate_date_str(qs.get("end"), "end") or default_end
            project = validate_project(qs.get("project"), ctx.config.managed_projects, allow_all=True)

            usage_params: dict[str, Any] = {"start": start, "end": end}
            if project:
                usage_params["project"] = project

            results, errors = _parallel_fetch(
                ctx.executor,
                {
                    "catalog": lambda: ctx.client.list_models(),
                    "usage": lambda: ctx.client.list_model_usage(**usage_params),
                    "pricing": ctx.client.pricing,
                    "model_rules": ctx.client.list_model_rules,
                    "model_access": ctx.client.list_model_access,
                },
            )
            self._send_json(
                200,
                {
                    "range": {"start": start, "end": end, "project": project or "all"},
                    "catalog": (results.get("catalog") or {}).get("data") or [],
                    "catalog_meta": (results.get("catalog") or {}).get("catalog") or {},
                    "usage": (results.get("usage") or {}).get("data") or [],
                    "pricing": results.get("pricing") or {},
                    "default_rule": (results.get("model_rules") or {}).get("default"),
                    "user_rules": (results.get("model_rules") or {}).get("data") or [],
                    "model_access": (results.get("model_access") or {}).get("data") or [],
                    "partial_errors": errors,
                },
            )

        def _handle_projects_overview(self) -> None:
            tasks: dict[str, Any] = {
                "policy": ctx.client.get_cap_policy,
                "project_caps": ctx.client.list_project_caps,
                "model_access": ctx.client.list_model_access,
            }
            for pid in ctx.config.managed_projects:
                tasks[f"logging:{pid}"] = (lambda p=pid: ctx.client.get_inference_logging(p))

            results, errors = _parallel_fetch(ctx.executor, tasks)
            logging_by_project = {pid: results.get(f"logging:{pid}") for pid in ctx.config.managed_projects}

            self._send_json(
                200,
                {
                    "hub_project": ctx.config.hub_project,
                    "spoke_projects": list(ctx.config.spoke_projects),
                    "managed_projects": list(ctx.config.managed_projects),
                    "policy": results.get("policy"),
                    "project_caps": results.get("project_caps"),
                    "model_access": (results.get("model_access") or {}).get("data") or [],
                    "inference_logging": logging_by_project,
                    "partial_errors": errors,
                },
            )

        def _handle_audit(self, qs: dict[str, str]) -> None:
            limit = validate_number(qs.get("limit") or 100, "limit", integer=True, min_val=1, max_val=200)
            audit_params: dict[str, Any] = {"limit": limit}
            for f in ("action", "actor", "target"):
                val = validate_text(qs.get(f), f, max_len=200)
                if val:
                    audit_params[f] = val
            results, errors = _parallel_fetch(
                ctx.executor,
                {
                    "violations": lambda: ctx.client.list_model_violations(),
                    "audit_logs": lambda: ctx.client.list_audit_logs(**audit_params),
                },
            )
            self._send_json(
                200,
                {
                    "violations": (results.get("violations") or {}).get("data") or [],
                    "audit_logs": (results.get("audit_logs") or {}).get("data") or [],
                    "partial_errors": errors,
                },
            )

        # --- Dashboard POST Control Handlers ----------------------------------
        def _handle_update_policy(self, body: dict[str, Any]) -> None:
            payload: dict[str, Any] = {}
            for field, is_int in (("cost_cap", False), ("token_cap", True), ("request_cap", True)):
                if field in body:
                    val = validate_number(body.get(field), field, integer=is_int, min_val=0)
                    payload[field] = 0 if val is None else val

            if "period" in body and body["period"]:
                period = str(body["period"]).strip().lower()
                if period not in VALID_PERIODS:
                    raise ValidationError("period는 daily, weekly, monthly 중 하나여야 합니다.")
                payload["period"] = period

            if "enforcement_mode" in body and body["enforcement_mode"]:
                mode = str(body["enforcement_mode"]).strip().lower()
                if mode not in VALID_ENFORCEMENT_MODES:
                    raise ValidationError("enforcement_mode는 auto 또는 manual이어야 합니다.")
                payload["enforcement_mode"] = mode

            if "cap_scope" in body and body["cap_scope"]:
                scope = str(body["cap_scope"]).strip().lower()
                if scope not in VALID_CAP_SCOPES:
                    raise ValidationError("cap_scope는 total 또는 per_project여야 합니다.")
                payload["cap_scope"] = scope

            if "default_block_services" in body:
                payload["default_block_services"] = validate_services(body.get("default_block_services"), required=True)

            if "project_defaults" in body:
                raw_pd = body.get("project_defaults")
                if not isinstance(raw_pd, dict):
                    raise ValidationError("project_defaults는 프로젝트별 객체여야 합니다.")
                clean_pd: dict[str, dict[str, Any]] = {}
                for pid, caps in raw_pd.items():
                    valid_pid = validate_project(pid, ctx.config.managed_projects)
                    if not valid_pid or not isinstance(caps, dict):
                        continue
                    triplet: dict[str, Any] = {}
                    for f, is_int in (("cost_cap", False), ("token_cap", True), ("request_cap", True)):
                        v = validate_number(caps.get(f), f, integer=is_int, min_val=0)
                        if v is not None and v > 0:
                            triplet[f] = v
                    if triplet:
                        clean_pd[valid_pid] = triplet
                payload["project_defaults"] = clean_pd

            if not payload:
                raise ValidationError("변경할 정책 항목이 없습니다.")

            updated = ctx.client.update_cap_policy(payload)
            self._send_json(200, {"ok": True, "policy": updated})

        def _handle_enforce_caps(self, body: dict[str, Any]) -> None:
            dry_run = bool(body.get("dryRun", True))
            res = ctx.client.enforce_caps(dry_run=dry_run)
            self._send_json(200, {"ok": True, "result": res})

        def _handle_set_user_cap(self, body: dict[str, Any]) -> None:
            email = validate_principal(body.get("email"), "email")
            cap_type = str(body.get("type") or "limit").strip().lower()
            if cap_type not in VALID_CAP_TYPES:
                raise ValidationError("type은 limit, allow, block 중 하나여야 합니다.")

            payload: dict[str, Any] = {
                "type": cap_type,
                "note": validate_text(body.get("note"), "note", max_len=200),
            }
            if cap_type == "limit":
                cost_cap = validate_number(body.get("cost_cap"), "cost_cap", integer=False, min_val=0)
                token_cap = validate_number(body.get("token_cap"), "token_cap", integer=True, min_val=0)
                request_cap = validate_number(body.get("request_cap"), "request_cap", integer=True, min_val=0)
                if cost_cap is not None:
                    payload["cost_cap"] = cost_cap
                if token_cap is not None:
                    payload["token_cap"] = token_cap
                if request_cap is not None:
                    payload["request_cap"] = request_cap

                scope = str(body.get("scope") or "total").strip().lower()
                if scope not in VALID_CAP_SCOPES:
                    raise ValidationError("scope는 total 또는 per_project여야 합니다.")
                payload["scope"] = scope

                raw_pc = body.get("project_caps")
                if isinstance(raw_pc, dict):
                    clean_pc: dict[str, dict[str, Any]] = {}
                    for pid, caps in raw_pc.items():
                        valid_pid = validate_project(pid, ctx.config.managed_projects)
                        if not valid_pid or not isinstance(caps, dict):
                            continue
                        triplet: dict[str, Any] = {}
                        for f, is_int in (("cost_cap", False), ("token_cap", True), ("request_cap", True)):
                            v = validate_number(caps.get(f), f, integer=is_int, min_val=0)
                            if v is not None and v > 0:
                                triplet[f] = v
                        if triplet:
                            clean_pc[valid_pid] = triplet
                    if clean_pc:
                        payload["project_caps"] = clean_pc

                if not any(k in payload for k in ("cost_cap", "token_cap", "request_cap", "project_caps")):
                    raise ValidationError("금액(cost_cap), 토큰, 요청 수 또는 프로젝트별 예산 중 최소 1개를 입력하세요.")
            elif cap_type == "block":
                services = validate_services(body.get("services"))
                if services:
                    payload["services"] = services
                projects = validate_projects_list(body.get("projects"), ctx.config.managed_projects)
                if projects:
                    payload["projects"] = projects

            until = validate_rfc3339(body.get("until"), "until")
            if until:
                payload["until"] = until

            saved = ctx.client.set_user_cap(email, payload)
            self._send_json(200, {"ok": True, "cap": saved})

        def _handle_delete_user_cap(self, body: dict[str, Any]) -> None:
            email = validate_principal(body.get("email"), "email")
            res = ctx.client.delete_user_cap(email)
            self._send_json(200, {"ok": True, "result": res})

        def _handle_block_user(self, body: dict[str, Any]) -> None:
            email = validate_principal(body.get("email"), "email")
            services = validate_services(body.get("services"), required=True)
            projects = validate_projects_list(body.get("projects"), ctx.config.managed_projects)
            reason = validate_text(body.get("reason"), "reason", max_len=200)
            until = validate_rfc3339(body.get("until"), "until")

            payload: dict[str, Any] = {"services": services, "reason": reason, "until": until}
            if projects is not None:
                payload["projects"] = projects
            res = ctx.client.block_user(email, payload)
            self._send_json(200, {"ok": True, "result": res})

        def _handle_unblock_user(self, body: dict[str, Any]) -> None:
            email = validate_principal(body.get("email"), "email")
            services = validate_services(body.get("services"))
            projects = validate_projects_list(body.get("projects"), ctx.config.managed_projects)
            reason = validate_text(body.get("reason"), "reason", max_len=200)

            payload: dict[str, Any] = {"reason": reason}
            if services is not None:
                payload["services"] = services
            if projects is not None:
                payload["projects"] = projects
            res = ctx.client.unblock_user(email, payload)
            self._send_json(200, {"ok": True, "result": res})

        def _handle_set_default_model_rule(self, body: dict[str, Any]) -> None:
            payload = validate_model_rule_payload(body, is_default=True)
            res = ctx.client.set_default_model_rule(payload)
            self._send_json(200, {"ok": True, "rule": res})

        def _handle_delete_default_model_rule(self) -> None:
            res = ctx.client.delete_default_model_rule()
            self._send_json(200, {"ok": True, "result": res})

        def _handle_set_user_model_rule(self, body: dict[str, Any]) -> None:
            email = validate_principal(body.get("email"), "email")
            payload = validate_model_rule_payload(body, is_default=False)
            res = ctx.client.set_user_model_rule(email, payload)
            self._send_json(200, {"ok": True, "rule": res})

        def _handle_delete_user_model_rule(self, body: dict[str, Any]) -> None:
            email = validate_principal(body.get("email"), "email")
            res = ctx.client.delete_user_model_rule(email)
            self._send_json(200, {"ok": True, "result": res})

        def _handle_evaluate_model_rules(self, body: dict[str, Any]) -> None:
            dry_run = bool(body.get("dryRun", True))
            res = ctx.client.evaluate_model_rules(dry_run=dry_run)
            self._send_json(200, {"ok": True, "result": res})

        def _handle_toggle_model_access(self, body: dict[str, Any]) -> None:
            project_id = validate_project(body.get("project_id"), ctx.config.managed_projects)
            if not project_id:
                raise ValidationError("대상 프로젝트를 선택하세요.")
            model_id = validate_model_pattern(body.get("model_id"))
            action = str(body.get("action") or "").strip().lower()
            if action not in ("allow", "restrict"):
                raise ValidationError("action은 allow 또는 restrict여야 합니다.")
            dry_run = bool(body.get("dryRun", True))
            force = bool(body.get("force", False))
            reason = validate_text(body.get("reason"), "reason", max_len=200)

            if action == "allow":
                res = ctx.client.allow_project_model(project_id, model_id, dry_run=dry_run, reason=reason)
            else:
                res = ctx.client.restrict_project_model(project_id, model_id, dry_run=dry_run, force=force, reason=reason)
            self._send_json(200, {"ok": True, "result": res})

        def _handle_set_project_cap(self, body: dict[str, Any]) -> None:
            project_id = validate_project(body.get("project_id"), ctx.config.managed_projects)
            if not project_id:
                raise ValidationError("프로젝트 ID가 필요합니다.")
            monthly_usd = validate_number(body.get("monthly_usd"), "monthly_usd", integer=False, min_val=0, required=True)
            action = str(body.get("action") or "hard_cap").strip().lower()
            if action not in ("hard_cap", "notify"):
                raise ValidationError("action은 hard_cap 또는 notify여야 합니다.")
            dry_run = bool(body.get("dryRun", False))
            apply_now = bool(body.get("apply", True))
            res = ctx.client.set_project_cap(
                project_id,
                {"monthly_usd": monthly_usd, "action": action, "apply": apply_now, "dryRun": dry_run},
            )
            self._send_json(200, {"ok": True, "result": res})

        def _handle_lift_project_cap(self, body: dict[str, Any]) -> None:
            project_id = validate_project(body.get("project_id"), ctx.config.managed_projects)
            if not project_id:
                raise ValidationError("프로젝트 ID가 필요합니다.")
            res = ctx.client.lift_project_cap(project_id)
            self._send_json(200, {"ok": True, "result": res})

        def _handle_enable_inference_logging(self, body: dict[str, Any]) -> None:
            project_id = validate_project(body.get("project_id"), ctx.config.managed_projects)
            if not project_id:
                raise ValidationError("프로젝트 ID가 필요합니다.")
            dry_run = bool(body.get("dryRun", False))
            res = ctx.client.enable_inference_logging(project_id, dry_run=dry_run)
            self._send_json(200, {"ok": True, "result": res})

    return DashboardHandler
