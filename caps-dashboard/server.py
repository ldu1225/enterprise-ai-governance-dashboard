#!/usr/bin/env python3
"""Entrypoint for the Hub-and-Spoke GCP AI Usage & Model Budget Dashboard."""

from __future__ import annotations

import http.server
import logging
import signal
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from app.caps_client import CapsApiClient
from app.config import DashboardConfig, load_config
from app.routes import DashboardContext, make_handler
from app.security import AuthManager


def build_server(config: DashboardConfig) -> tuple[http.server.ThreadingHTTPServer, DashboardContext]:
    client = CapsApiClient(config.api_base_url, config.api_key)
    auth = AuthManager(
        session_secret=config.session_secret,
        base_dir=config.base_dir,
        is_cloud_run=config.is_cloud_run,
        env_password_hash=config.admin_password_hash,
        env_password_plain=config.admin_password_plain,
    )
    ctx = DashboardContext(config, client, auth)
    handler_cls = make_handler(ctx)
    server = http.server.ThreadingHTTPServer((config.host, config.port), handler_cls)
    server.daemon_threads = True
    return server, ctx


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log = logging.getLogger("caps_dashboard.server")

    config = load_config(ROOT_DIR)
    server, ctx = build_server(config)

    def _handle_signal(signum: int, _frame: object) -> None:
        log.info("Received signal %d; shutting down.", signum)
        server.shutdown()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    browse_url = f"http://localhost:{config.port}" if not config.is_cloud_run else f"http://{config.host}:{config.port}"
    log.info(
        "AI Usage & Model Budget Dashboard ready at %s (bind=%s:%d, hub=%s, spokes=%s, api_key=%s)",
        browse_url,
        config.host,
        config.port,
        config.hub_project,
        ",".join(config.spoke_projects),
        "configured" if config.api_key else "MISSING",
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        ctx.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
