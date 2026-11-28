"""Secure stdlib HTTP client for gcp-ai-usage-caps-api (v1.3.x).

All calls are made server-side from the BFF so API keys are never exposed to browsers.
Enforces TLS 1.2+ for HTTPS connections and never logs Authorization headers.

Every upstream call is also recorded (method, /v1 path, status, latency, sanitized
request body, truncated response) into a bounded per-session ring buffer so the
governance console can show an "API Call Inspector" proving that every screen is
built purely on the Caps REST API. Request headers (including Authorization) are
never recorded.
"""

from __future__ import annotations

import collections
import contextvars
import datetime as dt
import json
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# Context for the API Call Inspector: which dashboard session (opaque key) and which
# BFF route triggered the upstream call. Propagated into worker threads via
# contextvars.copy_context() in the router's parallel fetch helper.
TRACE_SESSION: contextvars.ContextVar[str | None] = contextvars.ContextVar("caps_trace_session", default=None)
TRACE_ACTION: contextvars.ContextVar[str] = contextvars.ContextVar("caps_trace_action", default="")

_SENSITIVE_KEY_RE = re.compile(r"(authorization|api[_-]?key|secret|password|bearer|credential|csrf)", re.I)
TRACE_RESPONSE_PREVIEW_CHARS = 6000
TRACE_BUFFER_SIZE = 250
TRACE_MAX_SESSIONS = 32


def sanitize_for_trace(value: Any, depth: int = 0) -> Any:
    """Deep-copies JSON data while redacting anything that looks like a credential."""
    if depth > 8:
        return "…"
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            key = str(k)
            out[key] = "[redacted]" if _SENSITIVE_KEY_RE.search(key) else sanitize_for_trace(v, depth + 1)
        return out
    if isinstance(value, list):
        return [sanitize_for_trace(v, depth + 1) for v in value[:200]]
    if isinstance(value, str) and (value.lower().startswith("bearer ") or value.startswith("gcpai_")):
        return "[redacted]"
    return value


class TraceRecorder:
    """Thread-safe bounded per-session ring buffers of upstream API calls."""

    def __init__(self, *, buffer_size: int = TRACE_BUFFER_SIZE, max_sessions: int = TRACE_MAX_SESSIONS) -> None:
        self._lock = threading.Lock()
        self._seq = 0
        self._buffer_size = buffer_size
        self._max_sessions = max_sessions
        self._buffers: collections.OrderedDict[str, collections.deque[dict[str, Any]]] = collections.OrderedDict()

    def record(self, session_key: str | None, entry: dict[str, Any]) -> None:
        if not session_key:
            return
        with self._lock:
            self._seq += 1
            entry["seq"] = self._seq
            buf = self._buffers.get(session_key)
            if buf is None:
                buf = collections.deque(maxlen=self._buffer_size)
                self._buffers[session_key] = buf
            self._buffers.move_to_end(session_key)
            buf.append(entry)
            while len(self._buffers) > self._max_sessions:
                self._buffers.popitem(last=False)

    def since(self, session_key: str | None, since_seq: int = 0, *, limit: int = 150) -> tuple[list[dict[str, Any]], int]:
        with self._lock:
            buf = self._buffers.get(session_key or "")
            items = [dict(e) for e in buf if e["seq"] > since_seq] if buf else []
            last = buf[-1]["seq"] if buf else since_seq
        return items[-limit:], max(last, since_seq)

    def clear(self, session_key: str | None = None) -> None:
        with self._lock:
            if session_key is None:
                self._buffers.clear()
            else:
                self._buffers.pop(session_key, None)


class CapsApiError(Exception):
    def __init__(self, status: int, err_type: str, code: str, message: str):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.err_type = err_type
        self.code = code
        self.message = message


class CapsApiClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: int = 45,
        max_retries: int = 2,
    ):
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries
        self._ssl_ctx = ssl.create_default_context()
        self._ssl_ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        self.tracer = TraceRecorder()

    @property
    def api_host(self) -> str:
        return urllib.parse.urlsplit(self.base_url).netloc

    def _trace(
        self,
        *,
        method: str,
        path_qs: str,
        body: dict[str, Any] | None,
        status: int,
        started: float,
        response: Any = None,
        error_code: str | None = None,
        attempts: int = 1,
    ) -> None:
        session_key = TRACE_SESSION.get()
        if not session_key:
            return
        preview = None
        truncated = False
        if response is not None:
            try:
                text = json.dumps(sanitize_for_trace(response), ensure_ascii=False, indent=1)
            except (TypeError, ValueError):
                text = str(response)
            truncated = len(text) > TRACE_RESPONSE_PREVIEW_CHARS
            preview = text[:TRACE_RESPONSE_PREVIEW_CHARS]
        now = dt.datetime.now(dt.timezone.utc)
        self.tracer.record(
            session_key,
            {
                "ts": now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z",
                "method": method,
                "path": path_qs,
                "status": status,
                "latency_ms": int(round((time.monotonic() - started) * 1000)),
                "action": TRACE_ACTION.get(),
                "request_body": sanitize_for_trace(body) if body is not None else None,
                "response_preview": preview,
                "response_truncated": truncated,
                "error_code": error_code,
                "attempts": attempts,
            },
        )

    @property
    def configured(self) -> bool:
        return bool(self._api_key)

    @staticmethod
    def _quote(seg: str) -> str:
        return urllib.parse.quote(seg, safe="")

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        if not self._api_key:
            raise CapsApiError(
                503,
                "configuration_error",
                "api_key_missing",
                "CAPS_API_KEY is not configured on the dashboard server.",
            )
        if not path.startswith("/v1/"):
            raise ValueError("Upstream API path must start with /v1/.")

        query = ""
        if params:
            clean = {
                k: ("true" if v is True else "false" if v is False else str(v))
                for k, v in params.items()
                if v is not None and v != ""
            }
            if clean:
                query = "?" + urllib.parse.urlencode(clean)

        req_headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
            "User-Agent": "gcp-ai-usage-caps-dashboard/1.0",
        }
        if headers:
            req_headers.update(headers)

        payload: bytes | None = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            req_headers["Content-Type"] = "application/json"

        url = self.base_url + path + query
        use_ssl = self._ssl_ctx if url.startswith("https://") else None
        started = time.monotonic()
        path_qs = path + query

        for attempt in range(self.max_retries + 1):
            req = urllib.request.Request(url, data=payload, headers=req_headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=self.timeout, context=use_ssl) as resp:
                    raw = resp.read().decode("utf-8")
                    data = json.loads(raw) if raw else {}
                    self._trace(method=method, path_qs=path_qs, body=body, status=resp.status,
                                started=started, response=data, attempts=attempt + 1)
                    return data
            except urllib.error.HTTPError as err:
                raw = err.read().decode("utf-8", "replace")
                if err.code == 429 and attempt < self.max_retries:
                    retry_after = err.headers.get("Retry-After")
                    delay = min(10, int(retry_after)) if retry_after and retry_after.isdigit() else 2 ** attempt
                    time.sleep(delay)
                    continue
                parsed: Any = None
                try:
                    parsed = json.loads(raw)
                    e = parsed.get("error") if isinstance(parsed, dict) else {}
                    if not isinstance(e, dict):
                        e = {}
                except ValueError:
                    e = {}
                code = str(e.get("code") or f"http_{err.code}")
                self._trace(method=method, path_qs=path_qs, body=body, status=err.code, started=started,
                            response=parsed if isinstance(parsed, (dict, list)) else None,
                            error_code=code, attempts=attempt + 1)
                raise CapsApiError(
                    err.code,
                    str(e.get("type") or "api_error"),
                    code,
                    str(e.get("message") or "Upstream API request failed.")[:400],
                ) from err
            except urllib.error.URLError as err:
                self._trace(method=method, path_qs=path_qs, body=body, status=502, started=started,
                            error_code="upstream_unreachable", attempts=attempt + 1)
                raise CapsApiError(
                    502,
                    "upstream_error",
                    "upstream_unreachable",
                    "Could not reach gcp-ai-usage-caps-api.",
                ) from err

        raise CapsApiError(429, "rate_limit_error", "rate_limited", "Upstream rate limit retries exhausted.")

    def paginate_all(self, path: str, *, max_pages: int = 5, **params: Any) -> dict[str, Any]:
        cursor: str | None = None
        items: list[Any] = []
        last_page: dict[str, Any] = {}
        for _ in range(max_pages):
            page_params = dict(params)
            if cursor:
                page_params["cursor"] = cursor
            page = self.request("GET", path, params=page_params)
            last_page = page
            items.extend(page.get("data") or [])
            if not page.get("has_more") or not page.get("next_cursor"):
                break
            cursor = str(page["next_cursor"])
        result = dict(last_page)
        result["data"] = items
        result["total"] = len(items)
        return result

    # --- System & Readiness ---------------------------------------------------
    def health(self) -> dict[str, Any]:
        return self.request("GET", "/v1/health")

    # --- Usage & Pricing ------------------------------------------------------
    def list_user_usage(self, **params: Any) -> dict[str, Any]:
        return self.paginate_all("/v1/usage/users", limit=500, **params)

    def user_usage(self, email: str, **params: Any) -> dict[str, Any]:
        return self.request("GET", f"/v1/usage/users/{self._quote(email)}", params=params)

    def user_projects(self, email: str, **params: Any) -> dict[str, Any]:
        return self.request("GET", f"/v1/users/{self._quote(email)}/projects", params=params)

    def list_model_usage(self, **params: Any) -> dict[str, Any]:
        return self.paginate_all("/v1/usage/models", limit=500, **params)

    def pricing(self, model: str | None = None) -> dict[str, Any]:
        return self.request("GET", "/v1/pricing", params={"model": model} if model else None)

    # --- Ledger-style collection (v1.4.0) -------------------------------------
    def list_facts(self, **params: Any) -> dict[str, Any]:
        return self.paginate_all("/v1/usage/facts", limit=1000, **params)

    def list_exports(self, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/v1/usage/exports", params=params or None)

    def download_export(self, export_id: str) -> tuple[str, dict[str, str]]:
        """JSONL body + selected response headers of GET /v1/usage/exports/{id}/download (not JSON)."""
        if not self._api_key:
            raise CapsApiError(503, "configuration_error", "api_key_missing",
                               "CAPS_API_KEY is not configured on the dashboard server.")
        path = f"/v1/usage/exports/{self._quote(export_id)}/download"
        url = self.base_url + path
        req = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self._api_key}", "Accept": "application/x-ndjson",
            "User-Agent": "gcp-ai-usage-caps-dashboard/1.0"}, method="GET")
        started = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=max(self.timeout, 120),
                                        context=self._ssl_ctx if url.startswith("https://") else None) as resp:
                body = resp.read().decode("utf-8")
                headers = {k: v for k, v in resp.headers.items()
                           if k.lower().startswith("x-usage-export") or k.lower() == "x-data-refreshed-at"}
                self._trace(method="GET", path_qs=path, body=None, status=resp.status, started=started,
                            response={"lines": body.count("\n"), **headers}, attempts=1)
                return body, headers
        except urllib.error.HTTPError as err:
            self._trace(method="GET", path_qs=path, body=None, status=err.code, started=started,
                        error_code=f"http_{err.code}", attempts=1)
            raise CapsApiError(err.code, "api_error", f"http_{err.code}", "Export download failed.") from err
        except urllib.error.URLError as err:
            raise CapsApiError(502, "upstream_error", "upstream_unreachable",
                               "Could not reach gcp-ai-usage-caps-api.") from err

    # --- Spend Caps & Policy --------------------------------------------------
    def get_cap_policy(self) -> dict[str, Any]:
        return self.request("GET", "/v1/caps/policy")

    def update_cap_policy(self, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("PUT", "/v1/caps/policy", body=body)

    def list_user_caps(self, **params: Any) -> dict[str, Any]:
        return self.paginate_all("/v1/caps/users", limit=500, **params)

    def get_user_cap(self, email: str, *, fresh: bool = False) -> dict[str, Any]:
        return self.request("GET", f"/v1/caps/users/{self._quote(email)}", params={"fresh": fresh})

    def set_user_cap(self, email: str, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("PUT", f"/v1/caps/users/{self._quote(email)}", body=body)

    def delete_user_cap(self, email: str) -> dict[str, Any]:
        return self.request("DELETE", f"/v1/caps/users/{self._quote(email)}")

    def enforce_caps(self, *, dry_run: bool = True) -> dict[str, Any]:
        return self.request("POST", "/v1/caps/enforce", body={"dryRun": dry_run})

    # --- User Block / Unblock -------------------------------------------------
    def block_user(self, email: str, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", f"/v1/users/{self._quote(email)}/block", body=body)

    def unblock_user(self, email: str, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", f"/v1/users/{self._quote(email)}/unblock", body=body)

    # --- Project Spend Caps & Gemini Platform Inference Logging ---------------
    def list_project_caps(self) -> dict[str, Any]:
        return self.request("GET", "/v1/caps/projects")

    def set_project_cap(self, project_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("PUT", f"/v1/caps/projects/{self._quote(project_id)}", body=body)

    def lift_project_cap(self, project_id: str) -> dict[str, Any]:
        return self.request("POST", f"/v1/caps/projects/{self._quote(project_id)}/lift", body={})

    def get_inference_logging(self, project_id: str) -> dict[str, Any]:
        return self.request("GET", f"/v1/projects/{self._quote(project_id)}/vertex-logging")

    def enable_inference_logging(self, project_id: str, *, dry_run: bool = False) -> dict[str, Any]:
        return self.request(
            "POST",
            f"/v1/projects/{self._quote(project_id)}/vertex-logging/enable",
            body={"dryRun": dry_run},
        )

    # --- Dynamic Models, Model Rules (Budgets) & Org Policy Access ------------
    def list_models(self, **params: Any) -> dict[str, Any]:
        return self.paginate_all("/v1/models", limit=500, **params)

    def list_model_access(self) -> dict[str, Any]:
        return self.paginate_all("/v1/model-access", limit=200)

    def allow_project_model(self, project_id: str, model_id: str, *, dry_run: bool = False, reason: str = "") -> dict[str, Any]:
        return self.request(
            "POST",
            f"/v1/model-access/projects/{self._quote(project_id)}/models/{self._quote(model_id)}/allow",
            body={"dryRun": dry_run, "reason": reason},
        )

    def restrict_project_model(
        self,
        project_id: str,
        model_id: str,
        *,
        dry_run: bool = False,
        force: bool = False,
        reason: str = "",
    ) -> dict[str, Any]:
        return self.request(
            "POST",
            f"/v1/model-access/projects/{self._quote(project_id)}/models/{self._quote(model_id)}/restrict",
            body={"dryRun": dry_run, "force": force, "reason": reason},
        )

    def list_model_rules(self) -> dict[str, Any]:
        return self.paginate_all("/v1/model-rules", limit=500)

    def get_default_model_rule(self) -> dict[str, Any]:
        return self.request("GET", "/v1/model-rules/default")

    def set_default_model_rule(self, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("PUT", "/v1/model-rules/default", body=body)

    def delete_default_model_rule(self) -> dict[str, Any]:
        return self.request("DELETE", "/v1/model-rules/default")

    def get_user_model_rules(self, email: str) -> dict[str, Any]:
        return self.request("GET", f"/v1/users/{self._quote(email)}/model-rules")

    def set_user_model_rule(self, email: str, body: dict[str, Any]) -> dict[str, Any]:
        return self.request("PUT", f"/v1/users/{self._quote(email)}/model-rules", body=body)

    def delete_user_model_rule(self, email: str) -> dict[str, Any]:
        return self.request("DELETE", f"/v1/users/{self._quote(email)}/model-rules")

    def evaluate_model_rules(self, *, dry_run: bool = True) -> dict[str, Any]:
        return self.request("POST", "/v1/model-rules/evaluate", body={"dryRun": dry_run})

    def list_model_violations(self, **params: Any) -> dict[str, Any]:
        return self.paginate_all("/v1/model-violations", limit=200, **params)

    # --- Audit Logs -----------------------------------------------------------
    def list_audit_logs(self, **params: Any) -> dict[str, Any]:
        return self.request("GET", "/v1/audit-logs", params=params)
