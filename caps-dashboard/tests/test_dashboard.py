"""Unit, integration, and security test suite for caps-dashboard.

All test servers bind strictly to 127.0.0.1 (never 0.0.0.0).
"""

from __future__ import annotations

import http.client
import http.server
import json
import re
import secrets
import sys
import tempfile
import threading
import unittest
import urllib.parse
from pathlib import Path

DASHBOARD_DIR = Path(__file__).resolve().parent.parent
if str(DASHBOARD_DIR) not in sys.path:
    sys.path.insert(0, str(DASHBOARD_DIR))

from app.config import DashboardConfig, validate_api_base_url
from app.security import hash_password, verify_password
from server import build_server


class FakeCapsApiState:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict | None]] = []
        self.policy = {
            "object": "cap_policy",
            "cost_cap": 100.0,
            "token_cap": 0,
            "request_cap": 0,
            "currency": "USD",
            "period": "monthly",
            "enforcement_mode": "auto",
            "enforcement_backend": "iam_deny",
            "cap_scope": "total",
            "default_block_services": ["antigravity", "gemini_platform", "gemini_enterprise"],
            "project_defaults": {},
        }
        self.default_model_rule = None
        self.user_model_rules: dict[str, dict] = {}
        self.user_caps: dict[str, dict] = {}


def start_fake_upstream(expected_api_key: str) -> tuple[http.server.ThreadingHTTPServer, FakeCapsApiState, int]:
    state = FakeCapsApiState()

    class FakeHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            return

        def _check_auth(self) -> bool:
            if self.headers.get("Authorization") != f"Bearer {expected_api_key}":
                self._json(401, {"error": {"type": "auth_error", "code": "unauthorized", "message": "Bad key"}})
                return False
            return True

        def _read_body(self) -> dict | None:
            length = int(self.headers.get("Content-Length") or "0")
            if length == 0:
                return None
            return json.loads(self.rfile.read(length).decode("utf-8"))

        def _json(self, status: int, data: dict) -> None:
            raw = json.dumps(data).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:
            if not self._check_auth():
                return
            parsed = urllib.parse.urlsplit(self.path)
            path = parsed.path
            state.calls.append(("GET", path, None))

            if path == "/v1/health":
                self._json(200, {"status": "ok", "version": "1.3.0", "enforcement": {"mode": "auto", "backend": "iam_deny"}})
            elif path == "/v1/caps/policy":
                self._json(200, state.policy)
            elif path == "/v1/usage/users":
                self._json(200, {
                    "object": "list",
                    "has_more": False,
                    "data": [
                        {
                            "email": "alice@example.com",
                            "uid": "u1",
                            "surfaces": ["gemini_platform", "antigravity"],
                            "projects": ["duleetest", "dulee-ai-test"],
                            "multi_project": True,
                            "requests": 120,
                            "input_tokens": 500000,
                            "output_tokens": 100000,
                            "cached_tokens": 50000,
                            "total_tokens": 600000,
                            "estimated_cost": 12.5,
                            "currency": "USD",
                            "by_project": [
                                {"project": "duleetest", "requests": 80, "total_tokens": 400000, "estimated_cost": 8.0},
                                {"project": "dulee-ai-test", "requests": 40, "total_tokens": 200000, "estimated_cost": 4.5},
                            ],
                            "by_model": [
                                {"model": "gemini-4-argon", "surface": "gemini_platform", "requests": 120, "total_tokens": 600000, "estimated_cost": 12.5},
                            ],
                            "last_active": "2026-11-27T08:00:00Z",
                        }
                    ],
                    "summary": {"active_users": 1, "multi_project_users": 1, "total_requests": 120, "total_tokens": 600000, "total_estimated_cost": 12.5, "unattributed_requests": 0},
                    "pricing_source": {"official_sku_models": 46, "catalog_synced_at": "2026-11-27T03:00:00Z"},
                    "telemetry": {"telemetry_ok": True},
                })
            elif path == "/v1/caps/users":
                self._json(200, {
                    "object": "list",
                    "has_more": False,
                    "data": [
                        {
                            "email": "alice@example.com",
                            "uid": "u1",
                            "status": "active",
                            "enforcement_status": "none",
                            "pending_blocked_services": [],
                            "pending_blocked_projects": {},
                            "cap_scope": "total",
                            "utilization_pct": 12.5,
                            "limit": {"cost_cap": 100.0, "currency": "USD"},
                            "usage": {"requests": 120, "total_tokens": 600000, "estimated_cost": 12.5},
                            "remaining": {"cost": 87.5},
                            "projects": [
                                {"project": "duleetest", "status": "active", "blocked_services": [], "enforcement_status": "none"},
                                {"project": "dulee-ai-test", "status": "active", "blocked_services": [], "enforcement_status": "none"},
                            ],
                            "rule_source": "policy",
                            "rule": state.user_caps.get("alice@example.com"),
                        }
                    ],
                    "summary": {"total": 1, "active": 1, "over_cap": 0, "suspended": 0, "blocked": 0},
                    "period": {"start": "2026-11-01T00:00:00Z", "end": "2026-12-01T00:00:00Z"},
                })
            elif path.startswith("/v1/usage/users/"):
                self._json(200, {
                    "object": "user_usage",
                    "user": {"email": "alice@example.com", "requests": 120, "total_tokens": 600000, "estimated_cost": 12.5, "by_model": []},
                    "timeseries": [{"date": "2026-11-26", "requests": 50, "total_tokens": 250000}, {"date": "2026-11-27", "requests": 70, "total_tokens": 350000}],
                })
            elif path.startswith("/v1/users/") and path.endswith("/projects"):
                self._json(200, {
                    "object": "user_projects",
                    "data": [
                        {"project": "duleetest", "requests": 80, "total_tokens": 400000, "estimated_cost": 8.0, "cap": {"status": "active"}},
                        {"project": "dulee-ai-test", "requests": 40, "total_tokens": 200000, "estimated_cost": 4.5, "cap": {"status": "active"}},
                    ],
                })
            elif path.startswith("/v1/caps/users/"):
                self._json(200, {"email": "alice@example.com", "status": "active", "enforcement_status": "none", "rule_source": "policy"})
            elif path.startswith("/v1/users/") and path.endswith("/model-rules"):
                self._json(200, {"effective_rule": state.default_model_rule, "effective_source": "default"})
            elif path == "/v1/usage/models":
                self._json(200, {
                    "object": "list",
                    "has_more": False,
                    "data": [
                        {"model": "gemini-4-argon", "publisher": "google", "projects": ["duleetest", "dulee-ai-test"], "active_users": 1, "requests": 120, "total_tokens": 600000, "estimated_cost": 12.5, "lifecycle_stage": "ga"}
                    ],
                })
            elif path == "/v1/models":
                self._json(200, {
                    "object": "list",
                    "has_more": False,
                    "data": [
                        {"id": "gemini-4-argon", "publisher": "google", "pricing": {"input_per_1m_tokens": 1.25, "output_per_1m_tokens": 10.0}, "lifecycle": {"stage": "ga"}}
                    ],
                    "catalog": {"model_garden_models": 1, "observed_only_models": 0},
                })
            elif path == "/v1/pricing":
                self._json(200, {
                    "object": "pricing_table",
                    "data": [
                        {
                            "model": "gemini-4-argon",
                            "model_key": "gemini-4-argon",
                            "model_ids": ["gemini-4-argon"],
                            "input": 1.25,
                            "output": 10.0,
                            "input_per_1m_tokens": 1.25,
                            "output_per_1m_tokens": 10.0,
                        }
                    ],
                })
            elif path == "/v1/model-rules":
                self._json(200, {
                    "object": "list",
                    "has_more": False,
                    "default": state.default_model_rule,
                    "data": [{"email": k, "rule": v} for k, v in state.user_model_rules.items()],
                })
            elif path == "/v1/model-access":
                self._json(200, {
                    "object": "list",
                    "has_more": False,
                    "data": [
                        {"scope_type": "projects", "scope_id": "duleetest", "mode": "inherit", "allowed_values": [], "denied_values": []},
                        {"scope_type": "projects", "scope_id": "dulee-ai-test", "mode": "inherit", "allowed_values": [], "denied_values": []},
                    ],
                })
            elif path == "/v1/caps/projects":
                self._json(200, {
                    "object": "list",
                    "billing_sync": {"status": "ok", "message": None, "billing_account": "012345-6789AB-CDEF01", "required_role": None, "remediation": None},
                    "data": [
                        {"project_id": "duleetest", "configured": {"monthly_usd": 3000, "action": "hard_cap"}},
                        {"project_id": "dulee-ai-test", "configured": {"monthly_usd": 5000, "action": "hard_cap"}},
                    ],
                })
            elif path.endswith("/vertex-logging"):
                pid = path.split("/")[3]
                self._json(200, {"project": pid, "enabled": True, "state": "ENABLED"})
            elif path == "/v1/model-violations":
                self._json(200, {"object": "list", "has_more": False, "data": []})
            elif path == "/v1/audit-logs":
                self._json(200, {"object": "list", "has_more": False, "data": [{"timestamp": "2026-11-27T08:00:00Z", "action": "policy.updated", "target": "global", "actor": "admin"}]})
            else:
                self._json(404, {"error": {"code": "not_found", "message": path}})

        def do_PUT(self) -> None:
            if not self._check_auth():
                return
            path = urllib.parse.urlsplit(self.path).path
            body = self._read_body()
            state.calls.append(("PUT", path, body))
            if path == "/v1/caps/policy":
                state.policy.update(body or {})
                self._json(200, state.policy)
            elif path == "/v1/model-rules/default":
                state.default_model_rule = body
                self._json(200, {"rule": body})
            elif path.startswith("/v1/users/") and path.endswith("/model-rules"):
                email = urllib.parse.unquote(path.split("/")[3])
                state.user_model_rules[email] = body or {}
                self._json(200, {"email": email, "rule": body})
            elif path.startswith("/v1/caps/users/"):
                email = urllib.parse.unquote(path.split("/")[4])
                state.user_caps[email] = body or {}
                self._json(200, {"email": email, "rule": body})
            elif path.startswith("/v1/caps/projects/"):
                self._json(200, {"ok": True, "configured": body})
            else:
                self._json(200, {"ok": True})

        def do_POST(self) -> None:
            if not self._check_auth():
                return
            path = urllib.parse.urlsplit(self.path).path
            body = self._read_body()
            state.calls.append(("POST", path, body))
            if path == "/v1/caps/enforce":
                self._json(200, {
                    "result": "success",
                    "dry_run": bool((body or {}).get("dryRun")),
                    "gates": [
                        {"id": "G1_POLICY_READABLE", "status": "pass", "detail": "ok"},
                        {"id": "G2_ANY_DETERMINATE", "status": "pass", "detail": "ok"},
                    ],
                    "plan": {"suspend": [], "block": [], "restore": [], "review": []},
                })
            elif path == "/v1/model-rules/evaluate":
                self._json(200, {"evaluated": 1, "violations": [{"email": "alice@example.com", "model": "gemini-4-argon", "metric": "monthly_cost", "observed": 12.5, "limit": 5.0}], "blocked": ["alice@example.com"], "dry_run": bool((body or {}).get("dryRun"))})
            elif "/model-access/projects/" in path:
                self._json(200, {"status": "dry_run" if (body or {}).get("dryRun") else "applied", "impact": {"affected_users": 1, "catalog_models_allowed": 52, "catalog_models_total": 53}})
            else:
                self._json(200, {"ok": True, "body": body})

        def do_DELETE(self) -> None:
            if not self._check_auth():
                return
            path = urllib.parse.urlsplit(self.path).path
            state.calls.append(("DELETE", path, None))
            if path == "/v1/model-rules/default":
                state.default_model_rule = None
            elif path.startswith("/v1/users/") and path.endswith("/model-rules"):
                state.user_model_rules.pop(urllib.parse.unquote(path.split("/")[3]), None)
            elif path.startswith("/v1/caps/users/"):
                state.user_caps.pop(urllib.parse.unquote(path.split("/")[4]), None)
            self._json(200, {"deleted": True})

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeHandler)
    port = srv.server_address[1]
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    return srv, state, port


class DashboardTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.api_key = "gcpai_test_" + secrets.token_hex(12)
        self.upstream_srv, self.upstream_state, self.upstream_port = start_fake_upstream(self.api_key)

        cfg = DashboardConfig(
            api_base_url=f"http://127.0.0.1:{self.upstream_port}",
            api_key=self.api_key,
            hub_project="duleetest",
            spoke_projects=("dulee-ai-test",),
            host="127.0.0.1",
            port=0,
            session_secret=secrets.token_hex(32),
            is_cloud_run=False,
            base_dir=Path(self.tmpdir.name),
            web_dir=DASHBOARD_DIR / "web",
            admin_password_hash=None,
            admin_password_plain=None,
            allow_loopback_http=True,
        )
        self.srv, self.ctx = build_server(cfg)
        self.port = self.srv.server_address[1]
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.srv.shutdown()
        self.srv.server_close()
        self.ctx.shutdown()
        self.upstream_srv.shutdown()
        self.upstream_srv.server_close()
        self.tmpdir.cleanup()

    def _req(
        self,
        method: str,
        path: str,
        *,
        body: dict | None = None,
        cookies: dict[str, str] | None = None,
        csrf: str | None = None,
    ) -> tuple[int, dict[str, str], list[str], bytes]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers: dict[str, str] = {"Accept": "application/json"}
        if cookies:
            headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in cookies.items())
        if csrf:
            headers["X-CSRF-Token"] = csrf
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        hdrs = {k.lower(): v for k, v in resp.getheaders()}
        set_cookies = [v for k, v in resp.getheaders() if k.lower() == "set-cookie"]
        conn.close()
        return resp.status, hdrs, set_cookies, raw

    def _extract_cookies(self, set_cookies: list[str]) -> dict[str, str]:
        jar: dict[str, str] = {}
        for line in set_cookies:
            first = line.split(";", 1)[0]
            if "=" in first:
                k, v = first.split("=", 1)
                jar[k.strip()] = v.strip()
        return jar

    def _setup_and_login(self, password: str = "SuperStrongPassphrase!2026") -> tuple[dict[str, str], str]:
        status, _, set_cookies, raw = self._req("GET", "/api/auth/status")
        self.assertEqual(status, 200)
        info = json.loads(raw)
        self.assertTrue(info["needs_setup"])
        pre_cookies = self._extract_cookies(set_cookies)
        pre_csrf = info["csrf_token"]

        status, _, set_cookies, raw = self._req(
            "POST",
            "/api/auth/setup",
            body={"password": password, "confirm_password": password},
            cookies=pre_cookies,
            csrf=pre_csrf,
        )
        self.assertEqual(status, 200)
        data = json.loads(raw)
        self.assertTrue(data["authenticated"])

        # Verify hardened __Host- cookie flags
        session_cookie_header = next(c for c in set_cookies if c.startswith("__Host-caps_session="))
        self.assertIn("HttpOnly", session_cookie_header)
        self.assertIn("Secure", session_cookie_header)
        self.assertIn("SameSite=Strict", session_cookie_header)
        self.assertIn("Path=/", session_cookie_header)
        self.assertNotIn("Domain=", session_cookie_header)

        return self._extract_cookies(set_cookies), data["csrf_token"]

    # --- Security Tests -------------------------------------------------------
    def test_security_headers_methods_and_path_traversal(self) -> None:
        status, hdrs, _, raw = self._req("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("default-src 'self'", hdrs["content-security-policy"])
        self.assertNotIn("unsafe-inline", hdrs["content-security-policy"])
        self.assertNotIn("unsafe-eval", hdrs["content-security-policy"])
        self.assertEqual(hdrs["x-content-type-options"], "nosniff")
        self.assertEqual(hdrs["x-frame-options"], "DENY")
        self.assertIn("camera=()", hdrs["permissions-policy"])
        self.assertIn(b"GCP AI Usage", raw)

        # Reject disallowed HTTP methods
        for bad_method in ("PUT", "DELETE", "PATCH", "TRACE"):
            st, _, _, _ = self._req(bad_method, "/api/overview")
            self.assertEqual(st, 405)

        # Reject path traversal
        for bad_path in ("/../../etc/passwd", "/../server.py", "/%2e%2e/server.py"):
            st, _, _, _ = self._req("GET", bad_path)
            self.assertEqual(st, 404)

    def test_unauthenticated_and_csrf_enforcement(self) -> None:
        # All data APIs fail closed without auth
        st, hdrs, _, _ = self._req("GET", "/api/overview")
        self.assertEqual(st, 401)
        self.assertEqual(hdrs["cache-control"], "no-store")

        # Setup without CSRF rejected
        st, _, _, _ = self._req("POST", "/api/auth/setup", body={"password": "StrongPassword!2026", "confirm_password": "StrongPassword!2026"})
        self.assertEqual(st, 403)

        # Weak password rejected
        _, _, sc, raw = self._req("GET", "/api/auth/status")
        pre_cookies = self._extract_cookies(sc)
        pre_csrf = json.loads(raw)["csrf_token"]
        st, _, _, _ = self._req("POST", "/api/auth/setup", body={"password": "short", "confirm_password": "short"}, cookies=pre_cookies, csrf=pre_csrf)
        self.assertEqual(st, 400)

        # Valid setup + authenticated write without CSRF rejected
        cookies, csrf = self._setup_and_login()
        st, _, _, _ = self._req("POST", "/api/caps/enforce", body={"dryRun": True}, cookies=cookies)
        self.assertEqual(st, 403)
        st, _, _, _ = self._req("POST", "/api/caps/enforce", body={"dryRun": True}, cookies=cookies, csrf="wrong-token")
        self.assertEqual(st, 403)

    def test_logout_invalidates_all_sessions(self) -> None:
        pw = "AnotherStrongPassword!2026"
        cookies1, csrf1 = self._setup_and_login(pw)

        # Create second session
        _, _, sc, raw = self._req("GET", "/api/auth/status")
        pre_c = self._extract_cookies(sc)
        pre_csrf = json.loads(raw)["csrf_token"]
        st, _, sc2, raw2 = self._req("POST", "/api/auth/login", body={"password": pw}, cookies=pre_c, csrf=pre_csrf)
        self.assertEqual(st, 200)
        cookies2 = self._extract_cookies(sc2)

        # Logout session 1 -> session 2 must also be invalidated
        st, _, _, _ = self._req("POST", "/api/auth/logout", body={}, cookies=cookies1, csrf=csrf1)
        self.assertEqual(st, 200)
        st, _, _, _ = self._req("GET", "/api/overview", cookies=cookies2)
        self.assertEqual(st, 401)

    def test_rate_limiting_on_auth(self) -> None:
        _, _ = self._setup_and_login("ValidLongPassword#2026")
        _, _, sc, raw = self._req("GET", "/api/auth/status")
        pre_c = self._extract_cookies(sc)
        pre_csrf = json.loads(raw)["csrf_token"]

        hit_429 = False
        for _ in range(12):
            st, hdrs, _, _ = self._req("POST", "/api/auth/login", body={"password": "WrongPassword!2026"}, cookies=pre_c, csrf=pre_csrf)
            if st == 429:
                self.assertIn("retry-after", hdrs)
                hit_429 = True
                break
        self.assertTrue(hit_429, "Expected auth rate limiter to trigger HTTP 429.")

    def test_https_enforcement_and_scrypt_hashing(self) -> None:
        with self.assertRaises(ValueError):
            validate_api_base_url("http://gcp-ai-usage-caps-api.example.com", allow_loopback_http=False)
        self.assertEqual(
            validate_api_base_url("https://gcp-ai-usage-caps-api.example.com/", allow_loopback_http=False),
            "https://gcp-ai-usage-caps-api.example.com",
        )
        h1 = hash_password("MyStrongPassphrase123")
        h2 = hash_password("MyStrongPassphrase123")
        self.assertNotEqual(h1, h2)  # unique per-user salt
        self.assertTrue(verify_password("MyStrongPassphrase123", h1))
        self.assertFalse(verify_password("WrongPassphrase123", h1))

    def test_frontend_static_security_and_naming_audit(self) -> None:
        web_files = [DASHBOARD_DIR / "web" / name for name in ("index.html", "styles.css", "app.js")]
        forbidden_patterns = [
            r"\.innerHTML\b",
            r"\.outerHTML\b",
            r"document\.write\(",
            r"insertAdjacentHTML\(",
            r"\b(?:window\.)?(?:alert|confirm|prompt)\(",
            r"\blocalStorage\b",
            r"\bsessionStorage\b",
            r"\bonclick\s*=",
        ]
        for wf in web_files:
            content = wf.read_text(encoding="utf-8")
            for pat in forbidden_patterns:
                self.assertIsNone(re.search(pat, content), f"Forbidden pattern '{pat}' found in {wf.name}")

    # --- Hub & Spoke Functional E2E Tests -------------------------------------
    def test_hub_spoke_tracking_and_controls(self) -> None:
        cookies, csrf = self._setup_and_login()

        # 1) Overview merges user usage + caps + Hub/Spoke project totals
        st, _, _, raw = self._req("GET", "/api/overview?start=2026-11-01&end=2026-11-27", cookies=cookies)
        self.assertEqual(st, 200)
        ov = json.loads(raw)
        self.assertEqual(ov["hub_project"], "duleetest")
        self.assertEqual(ov["spoke_projects"], ["dulee-ai-test"])
        self.assertEqual(len(ov["users"]), 1)
        self.assertEqual(ov["users"][0]["email"], "alice@example.com")
        totals_by_proj = {p["project_id"]: p for p in ov["project_totals"]}
        self.assertAlmostEqual(totals_by_proj["duleetest"]["estimated_cost"], 8.0)
        self.assertAlmostEqual(totals_by_proj["dulee-ai-test"]["estimated_cost"], 4.5)

        # 2) Reject unmanaged project ID
        st, _, _, _ = self._req("GET", "/api/overview?project=unmanaged-proj", cookies=cookies)
        self.assertEqual(st, 400)

        # 3) User detail
        st, _, _, raw = self._req("GET", "/api/user/detail?email=alice%40example.com", cookies=cookies)
        self.assertEqual(st, 200)
        detail = json.loads(raw)
        self.assertEqual(len(detail["usage"]["timeseries"]), 2)

        # 4) Set per-user spend cap with separate Hub & Spoke budgets
        st, _, _, _ = self._req(
            "POST",
            "/api/caps/users/set",
            body={
                "email": "alice@example.com",
                "type": "limit",
                "cost_cap": 50,
                "scope": "total",
                "project_caps": {"duleetest": {"cost_cap": 30}, "dulee-ai-test": {"cost_cap": 20}},
            },
            cookies=cookies,
            csrf=csrf,
        )
        self.assertEqual(st, 200)
        self.assertEqual(self.upstream_state.user_caps["alice@example.com"]["project_caps"]["dulee-ai-test"]["cost_cap"], 20.0)

        # 5) Block user on Spoke project only
        st, _, _, _ = self._req(
            "POST",
            "/api/users/block",
            body={
                "email": "alice@example.com",
                "services": ["gemini_platform", "antigravity"],
                "projects": ["dulee-ai-test"],
                "reason": "Spoke budget exceeded",
            },
            cookies=cookies,
            csrf=csrf,
        )
        self.assertEqual(st, 200)
        block_call = next(c for c in self.upstream_state.calls if c[1] == "/v1/users/alice%40example.com/block")
        self.assertEqual(block_call[2]["projects"], ["dulee-ai-test"])

        # 6) Set default model budget rule ($5/mo on gemini-4-argon -> auto block) and evaluate
        st, _, _, _ = self._req(
            "POST",
            "/api/model-rules/default/set",
            body={
                "mode": "unrestricted",
                "models": [],
                "limits": [{"model": "gemini-4-argon", "monthly_cost": 5.0}],
                "on_violation": "block_service",
                "note": "Cap expensive model at $5/mo",
            },
            cookies=cookies,
            csrf=csrf,
        )
        self.assertEqual(st, 200)
        self.assertEqual(self.upstream_state.default_model_rule["limits"][0]["monthly_cost"], 5.0)

        st, _, _, raw = self._req("POST", "/api/model-rules/evaluate", body={"dryRun": True}, cookies=cookies, csrf=csrf)
        self.assertEqual(st, 200)
        eval_res = json.loads(raw)["result"]
        self.assertEqual(eval_res["blocked"], ["alice@example.com"])

        # 7) Set per-user model rule + delete
        st, _, _, _ = self._req(
            "POST",
            "/api/model-rules/user/set",
            body={
                "email": "alice@example.com",
                "mode": "inherit",
                "limits": [{"model": "claude-*", "monthly_cost": 15.0, "rpm": 20}],
                "on_violation": "block_service",
            },
            cookies=cookies,
            csrf=csrf,
        )
        self.assertEqual(st, 200)
        self.assertIn("alice@example.com", self.upstream_state.user_model_rules)

        # 8) Project Org Policy model restrict preview on Spoke
        st, _, _, raw = self._req(
            "POST",
            "/api/model-access/toggle",
            body={"project_id": "dulee-ai-test", "model_id": "gemini-4-argon", "action": "restrict", "dryRun": True},
            cookies=cookies,
            csrf=csrf,
        )
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(raw)["result"]["status"], "dry_run")

        # 9) Global policy + project overview + audit
        st, _, _, _ = self._req(
            "POST",
            "/api/caps/policy",
            body={"cost_cap": 80, "period": "monthly", "enforcement_mode": "auto", "cap_scope": "per_project", "project_defaults": {"dulee-ai-test": {"cost_cap": 25}}},
            cookies=cookies,
            csrf=csrf,
        )
        self.assertEqual(st, 200)
        self.assertEqual(self.upstream_state.policy["project_defaults"]["dulee-ai-test"]["cost_cap"], 25.0)

        st, _, _, raw = self._req("GET", "/api/projects/overview", cookies=cookies)
        self.assertEqual(st, 200)
        proj_ov = json.loads(raw)
        self.assertTrue(proj_ov["inference_logging"]["duleetest"]["enabled"])
        self.assertEqual(proj_ov["project_caps"]["billing_sync"]["status"], "ok")

        st, _, _, raw = self._req("GET", "/api/audit", cookies=cookies)
        self.assertEqual(st, 200)
        self.assertEqual(len(json.loads(raw)["audit_logs"]), 1)

    # --- API Call Inspector, fresh cap polling, cost explorer --------------------
    def test_api_call_inspector_trace_feed(self) -> None:
        cookies, csrf = self._setup_and_login()

        # Unauthenticated access to the trace feed fails closed.
        st, _, _, _ = self._req("GET", "/api/_trace")
        self.assertEqual(st, 401)

        st, _, _, raw = self._req("GET", "/api/_trace?since=0", cookies=cookies)
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(raw)["calls"], [])

        self._req("GET", "/api/overview", cookies=cookies)
        self._req(
            "POST", "/api/users/block",
            body={"email": "alice@example.com", "services": ["gemini_platform"], "projects": ["duleetest"], "reason": "trace"},
            cookies=cookies, csrf=csrf,
        )
        st, _, _, raw = self._req("GET", "/api/_trace?since=0", cookies=cookies)
        self.assertEqual(st, 200)
        feed = json.loads(raw)
        self.assertEqual(feed["api_host"], f"127.0.0.1:{self.upstream_port}")
        paths = {c["path"].split("?")[0] for c in feed["calls"]}
        self.assertIn("/v1/usage/users", paths)
        self.assertIn("/v1/caps/users", paths)  # parallel worker-thread calls are attributed
        block = next(c for c in feed["calls"] if c["path"] == "/v1/users/alice%40example.com/block")
        self.assertEqual(block["method"], "POST")
        self.assertEqual(block["status"], 200)
        self.assertEqual(block["action"], "POST /api/users/block")
        self.assertEqual(block["request_body"]["projects"], ["duleetest"])
        self.assertIsInstance(block["latency_ms"], int)
        # The M2M key / Authorization header must never appear in the feed.
        self.assertNotIn(self.api_key.encode(), raw)
        self.assertNotIn(b"Bearer gcpai", raw)

        # Incremental polling with since=last_seq returns nothing new.
        st, _, _, raw2 = self._req("GET", f"/api/_trace?since={feed['last_seq']}", cookies=cookies)
        self.assertEqual(json.loads(raw2)["calls"], [])

        # A second session cannot see the first session's calls.
        _, _, sc, raw3 = self._req("GET", "/api/auth/status")
        pre_c = self._extract_cookies(sc)
        st, _, sc2, _ = self._req("POST", "/api/auth/login", body={"password": "SuperStrongPassphrase!2026"}, cookies=pre_c, csrf=json.loads(raw3)["csrf_token"])
        self.assertEqual(st, 200)
        st, _, _, raw4 = self._req("GET", "/api/_trace?since=0", cookies=self._extract_cookies(sc2))
        self.assertEqual(json.loads(raw4)["calls"], [])

        # Invalid cursor rejected.
        st, _, _, _ = self._req("GET", "/api/_trace?since=abc", cookies=cookies)
        self.assertEqual(st, 400)

    def test_trace_sanitizer_redacts_credentials(self) -> None:
        from app.caps_client import sanitize_for_trace
        out = sanitize_for_trace({"api_key": "x", "nested": {"Authorization": "Bearer abc", "total_tokens": 5}, "v": "gcpai_secret"})
        self.assertEqual(out["api_key"], "[redacted]")
        self.assertEqual(out["nested"]["Authorization"], "[redacted]")
        self.assertEqual(out["nested"]["total_tokens"], 5)
        self.assertEqual(out["v"], "[redacted]")

    def test_fresh_cap_polling_costs_and_audit_filters(self) -> None:
        cookies, _ = self._setup_and_login()
        st, _, _, raw = self._req("GET", "/api/user/cap?email=alice%40example.com&fresh=true", cookies=cookies)
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(raw)["cap"]["enforcement_status"], "none")
        self.assertTrue(any(c[0] == "GET" and c[1] == "/v1/caps/users/alice%40example.com" for c in self.upstream_state.calls))

        st, _, _, _ = self._req("GET", "/api/user/cap?email=..%2F..%2Fetc", cookies=cookies)
        self.assertEqual(st, 400)

        st, _, _, raw = self._req("GET", "/api/costs?start=2026-11-01&end=2026-11-27&project=dulee-ai-test", cookies=cookies)
        self.assertEqual(st, 200)
        costs = json.loads(raw)
        self.assertEqual(costs["users"][0]["email"], "alice@example.com")
        self.assertEqual(costs["models"][0]["model"], "gemini-4-argon")
        self.assertEqual(costs["pricing"][0]["input_per_1m_tokens"], 1.25)
        self.assertEqual(costs["range"]["project"], "dulee-ai-test")
        st, _, _, _ = self._req("GET", "/api/costs?start=2026-11-27&end=2026-11-01", cookies=cookies)
        self.assertEqual(st, 400)
        st, _, _, _ = self._req("GET", "/api/costs?project=unmanaged-proj", cookies=cookies)
        self.assertEqual(st, 400)

        st, _, _, raw = self._req("GET", "/api/user/detail?email=alice%40example.com", cookies=cookies)
        self.assertEqual(st, 200)
        self.assertIn("audit_logs", json.loads(raw))

        st, _, _, _ = self._req("GET", "/api/audit?action=user.blocked&limit=50", cookies=cookies)
        self.assertEqual(st, 200)


if __name__ == "__main__":
    unittest.main()
