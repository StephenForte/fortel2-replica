#!/usr/bin/env python3
"""Poor-man's L1 JSON-RPC router: QuickNode in business hours, publicnode overnight.

op-node talks to http://127.0.0.1:18545; this process forwards each request to
the upstream selected by wall-clock (local TZ). Overrides are re-read each
request so a Render env flip takes effect without restarting op-node.

Env:
  L1_RPC_METERED_URL   QuickNode (or other metered) HTTPS URL — required
  L1_RPC_PUBLIC_URL    public Sepolia RPC (default publicnode)
  L1_RPC_LISTEN        bind address (default 127.0.0.1:18545)
  L1_RPC_BUSINESS_START  hour 0-23 inclusive start (default 9)
  L1_RPC_BUSINESS_END    hour 0-23 exclusive end (default 17) → 09:00–16:59
  L1_RPC_FORCE         public | metered | empty (schedule)
  TZ                   set by container (e.g. America/Los_Angeles)
"""

from __future__ import annotations

import os
import sys
import urllib.error
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def parse_hour(name: str, default: int) -> int:
    raw = _env(name, str(default))
    try:
        hour = int(raw)
    except ValueError as exc:
        raise SystemExit(f"ERROR: {name} must be an integer 0-23 (got {raw!r})") from exc
    if hour < 0 or hour > 23:
        raise SystemExit(f"ERROR: {name} must be 0-23 (got {hour})")
    return hour


def choose_upstream(
    now: datetime,
    *,
    metered_url: str,
    public_url: str,
    start_hour: int,
    end_hour: int,
    force: str = "",
) -> tuple[str, str]:
    """Return (upstream_url, reason)."""
    force = (force or "").strip().lower()
    if force in ("public", "1", "true", "yes", "on"):
        return public_url, "force=public"
    if force in ("metered", "quicknode", "qn"):
        return metered_url, "force=metered"

    hour = now.hour
    if start_hour == end_hour:
        # Degenerate: treat as always metered (full-day window).
        return metered_url, f"business(all-day @{now.tzinfo})"
    if start_hour < end_hour:
        in_window = start_hour <= hour < end_hour
    else:
        # Overnight window e.g. 22–6
        in_window = hour >= start_hour or hour < end_hour

    if in_window:
        return metered_url, f"business {start_hour:02d}-{end_hour:02d} (hour={hour})"
    return public_url, f"off-hours (hour={hour}; business {start_hour:02d}-{end_hour:02d})"


def redact(url: str) -> str:
    """Keep scheme + hostname only (drop userinfo, path, query, fragment)."""
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.hostname:
        return "<redacted>"
    return f"{parsed.scheme}://{parsed.hostname}/<redacted>"


def require_http_url(name: str, url: str) -> str:
    """Reject non-http(s) URLs so urllib cannot be pointed at file:// etc."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise SystemExit(
            f"ERROR: {name} must be an http(s) URL with a host (got {redact(url)})"
        )
    return url


class RouterState:
    def __init__(self) -> None:
        metered = _env("L1_RPC_METERED_URL")
        if not metered:
            raise SystemExit("ERROR: L1_RPC_METERED_URL is required")
        self.metered = require_http_url("L1_RPC_METERED_URL", metered)
        self.public = require_http_url(
            "L1_RPC_PUBLIC_URL",
            _env(
                "L1_RPC_PUBLIC_URL",
                "https://ethereum-sepolia-rpc.publicnode.com",
            ),
        )
        self.start = parse_hour("L1_RPC_BUSINESS_START", 9)
        self.end = parse_hour("L1_RPC_BUSINESS_END", 17)
        self.tz_name = _env("TZ", "UTC") or "UTC"
        try:
            self.tz = ZoneInfo(self.tz_name)
        except ZoneInfoNotFoundError as exc:
            raise SystemExit(
                f"ERROR: invalid TZ={self.tz_name!r} "
                f"(install tzdata / use e.g. America/Los_Angeles): {exc}"
            ) from exc
        self.last_reason: Optional[str] = None
        self.last_upstream: Optional[str] = None

    def pick(self) -> tuple[str, str]:
        now = datetime.now(self.tz)
        force = _env("L1_RPC_FORCE")
        # FORCE is read from process env; Render env edits restart the service.
        url, reason = choose_upstream(
            now,
            metered_url=self.metered,
            public_url=self.public,
            start_hour=self.start,
            end_hour=self.end,
            force=force,
        )
        if reason != self.last_reason:
            print(
                f"l1-rpc-router: upstream -> {redact(url)} ({reason})",
                flush=True,
            )
            self.last_reason = reason
            self.last_upstream = url
        return url, reason


STATE: Optional[RouterState] = None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        # Keep default quiet; switches are logged in RouterState.pick.
        return

    def do_POST(self) -> None:  # noqa: N802
        assert STATE is not None
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b""
        upstream, _reason = STATE.pick()
        # Upstream is operator env (L1_RPC_*), never request-controlled; schemes
        # restricted to http(s) at RouterState init via require_http_url.
        req = urllib.request.Request(
            upstream,
            data=body,
            method="POST",
            headers={
                "Content-Type": self.headers.get("Content-Type", "application/json"),
                "User-Agent": "fortel2-l1-rpc-router/1",
            },
        )
        try:
            # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            with urllib.request.urlopen(req, timeout=60) as resp:
                payload = resp.read()
                self.send_response(resp.status)
                ctype = resp.headers.get("Content-Type", "application/json")
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as err:
            payload = err.read()
            self.send_response(err.code)
            self.send_header("Content-Type", err.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as exc:  # noqa: BLE001
            msg = f'{{"jsonrpc":"2.0","id":null,"error":{{"code":-32000,"message":"router upstream error: {exc}"}}}}'
            data = msg.encode()
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        # Cheap health / which-upstream probe for operators.
        assert STATE is not None
        upstream, reason = STATE.pick()
        body = (
            f'{{"ok":true,"upstream":"{redact(upstream)}","reason":"{reason}",'
            f'"tz":"{STATE.tz_name}","business":"{STATE.start:02d}-{STATE.end:02d}"}}\n'
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    global STATE
    listen = _env("L1_RPC_LISTEN", "127.0.0.1:18545")
    if ":" not in listen:
        raise SystemExit(f"ERROR: L1_RPC_LISTEN must be host:port (got {listen!r})")
    host, port_s = listen.rsplit(":", 1)
    try:
        port = int(port_s)
    except ValueError as exc:
        raise SystemExit(f"ERROR: bad L1_RPC_LISTEN port in {listen!r}") from exc

    STATE = RouterState()
    # Log initial choice once at boot.
    STATE.pick()
    print(
        f"l1-rpc-router: listening on http://{host}:{port} "
        f"business={STATE.start:02d}-{STATE.end:02d} tz={STATE.tz_name} "
        f"metered={redact(STATE.metered)} public={redact(STATE.public)}",
        flush=True,
    )
    server = ThreadingHTTPServer((host, port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
