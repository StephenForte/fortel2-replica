#!/usr/bin/env python3
"""Property tests for the diskless public RPC gateway (G-1)."""

from __future__ import annotations

import os
import re
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
GATEWAY = ROOT / "gateway"
TEMPLATE = GATEWAY / "nginx.conf.template"
DOCKERFILE = GATEWAY / "Dockerfile"
RESOLVER_SCRIPT = GATEWAY / "14-resolvers-from-resolv.conf.envsh"

CONTRACT_DEFAULTS = {
    "PORT": "10000",
    "REPLICA_UPSTREAM": "http://fortel2-replica:10000",
    "RPC_RATE": "20r/s",
    "RPC_BURST": "40",
    "RPC_REAL_IP_HEADER": "CF-Connecting-IP",
    "RPC_MAX_BODY": "1m",
}

# Filled at container start from /etc/resolv.conf — not an operator key.
# TEST-NET-1 stub so unit tests can render the template without Docker.
STARTUP_DEFAULTS = {
    "NGINX_LOCAL_RESOLVERS": "192.0.2.53",
}

PUBLIC_RESOLVERS = (
    "8.8.8.8",
    "8.8.4.4",
    "1.1.1.1",
    "1.0.0.1",
    "9.9.9.9",
    "208.67.222.222",
    "208.67.220.220",
)

IMAGE = "fortel2-gw:test"
CHAIN_ID_BODY = b'{"jsonrpc":"2.0","id":1,"result":"0x354"}'
CHAIN_ID_REQ = b'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'


def render_gateway_conf(overrides=None) -> str:
    """Substitute ${ENV} placeholders the same way the image entrypoint does."""
    env = {**CONTRACT_DEFAULTS, **STARTUP_DEFAULTS, **(overrides or {})}
    text = TEMPLATE.read_text(encoding="utf-8")

    def repl(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in env:
            raise AssertionError(f"template references unset ${{{key}}}")
        return env[key]

    rendered = re.sub(r"\$\{([A-Z][A-Z0-9_]*)\}", repl, text)
    leftover = re.findall(r"\$\{[A-Z][A-Z0-9_]*\}", rendered)
    if leftover:
        raise AssertionError(f"unsubstituted placeholders: {leftover}")
    return rendered


def _block(text: str, start: str) -> str:
    """Return the `{ ... }` block that begins at the first `start` match."""
    idx = text.find(start)
    if idx < 0:
        raise AssertionError(f"missing {start!r}")
    brace = text.find("{", idx)
    if brace < 0:
        raise AssertionError(f"no opening brace after {start!r}")
    depth = 0
    for i, ch in enumerate(text[brace:], start=brace):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[brace : i + 1]
    raise AssertionError(f"unbalanced braces after {start!r}")


def _docker_usable() -> str | None:
    """Return a skip reason, or None if docker build/run can be exercised."""
    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except FileNotFoundError:
        return "docker binary not found"
    except subprocess.TimeoutExpired:
        return "docker info timed out"
    except OSError as exc:
        return f"docker info failed: {exc}"
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "unknown error").strip().splitlines()
        return f"docker daemon not usable: {err[-1] if err else result.returncode}"
    return None


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _run_resolver_script(resolv_text: str) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory() as tmp:
        resolv = Path(tmp) / "resolv.conf"
        resolv.write_text(resolv_text, encoding="utf-8")
        return subprocess.run(
            [
                "sh",
                "-c",
                '. "$1" && printf %s "$NGINX_LOCAL_RESOLVERS"',
                "resolver-script",
                str(RESOLVER_SCRIPT),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            env={**os.environ, "RESOLV_CONF": str(resolv)},
        )


def _http(method: str, url: str, body: bytes | None = None, timeout: float = 5.0):
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError(f"test helper only fetches http(s) URLs (got {url!r})")
    req = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        # Callers pass http://127.0.0.1:<ephemeral>; scheme-checked above.
        # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read(), dict(err.headers)


class _DummyFilter(BaseHTTPRequestHandler):
    """Stand-in for rpc-method-filter.py — records hits, echoes a fixed body."""

    hits: list[str]
    last_body: bytes

    def log_message(self, *_args) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        self.hits.append(f"GET {self.path}")
        payload = b'{"ok":true,"upstream":"dummy","allowed":1}\n'
        self._write(200, payload, "application/json")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.hits.append(f"OPTIONS {self.path}")
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get("Content-Length", "0") or 0)
        self.last_body = self.rfile.read(n)
        self.hits.append(f"POST {self.path}")
        self._write(200, CHAIN_ID_BODY, "application/json")

    def _write(self, status: int, payload: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


class GatewayConfigTests(unittest.TestCase):
    def test_template_and_dockerfile_exist(self):
        self.assertTrue(TEMPLATE.is_file(), TEMPLATE)
        self.assertTrue(DOCKERFILE.is_file(), DOCKERFILE)
        self.assertTrue(RESOLVER_SCRIPT.is_file(), RESOLVER_SCRIPT)
        self.assertTrue(os.access(RESOLVER_SCRIPT, os.X_OK), RESOLVER_SCRIPT)
        df = DOCKERFILE.read_text(encoding="utf-8")
        self.assertNotRegex(df, r":latest\b")
        self.assertRegex(df, r"(?m)^FROM nginxinc/nginx-unprivileged:\d")
        self.assertNotRegex(df, r"(?m)^VOLUME\b")
        self.assertNotRegex(df, r"(?im)^(RUN|COPY|ADD)\b.*\bgeth\b")
        self.assertIn("RPC_REAL_IP_HEADER=CF-Connecting-IP", df)
        self.assertIn("14-resolvers-from-resolv.conf.envsh", df)
        self.assertIn("NGINX_LOCAL_RESOLVERS", df)
        self.assertRegex(
            df,
            r'NGINX_ENVSUBST_FILTER="[^"]*NGINX_LOCAL_RESOLVERS[^"]*"',
        )

    def test_rendered_defaults_match_contract(self):
        conf = render_gateway_conf()

        zone = re.search(r"limit_req_zone\s+(\S+)\s+zone=rpc:\S+\s+rate=(\S+);", conf)
        self.assertIsNotNone(zone, conf)
        key, rate = zone.group(1), zone.group(2)
        self.assertNotEqual("$remote_addr", key)
        self.assertNotEqual("$binary_remote_addr", key)
        self.assertEqual("20r/s", rate)

        self.assertIn("limit_req_status 429;", conf)
        self.assertIn("client_max_body_size 1m;", conf)
        self.assertIn("set $replica_upstream http://fortel2-replica:10000;", conf)
        self.assertIn("proxy_pass $replica_upstream$request_uri;", conf)
        self.assertNotIn("proxy_pass http://fortel2-replica:10000;", conf)
        self.assertIn("listen 10000;", conf)
        self.assertIn("real_ip_header CF-Connecting-IP;", conf)
        self.assertIn("real_ip_recursive on;", conf)
        self.assertIn("limit_req zone=rpc burst=40 nodelay;", conf)
        self.assertIn("key=$rpc_limit_key", conf)
        self.assertIn("peer=$realip_remote_addr", conf)

        healthz = _block(conf, "location = /healthz")
        self.assertIn("return 200", healthz)
        self.assertNotIn("limit_req", healthz)
        self.assertNotIn("proxy_pass", healthz)

        proxied = _block(conf, "location /")
        self.assertIn("limit_req", proxied)
        self.assertIn("proxy_pass", proxied)
        self.assertNotIn("proxy_hide_header Access-Control", proxied)
        self.assertNotIn("add_header Access-Control", proxied)

    def test_env_overrides_flow_into_rendered_config(self):
        conf = render_gateway_conf(
            {
                "PORT": "8080",
                "REPLICA_UPSTREAM": "http://example.internal:9",
                "RPC_RATE": "5r/s",
                "RPC_BURST": "7",
                "RPC_REAL_IP_HEADER": "X-Forwarded-For",
                "RPC_MAX_BODY": "512k",
            }
        )
        self.assertIn("listen 8080;", conf)
        self.assertIn("set $replica_upstream http://example.internal:9;", conf)
        self.assertIn("proxy_pass $replica_upstream$request_uri;", conf)
        self.assertNotIn("proxy_pass http://example.internal:9;", conf)
        self.assertIn("rate=5r/s;", conf)
        self.assertIn("burst=7", conf)
        self.assertIn("real_ip_header X-Forwarded-For;", conf)
        self.assertIn("client_max_body_size 512k;", conf)

    def test_empty_limit_key_falls_back_to_nonempty(self):
        """Empty limit_req_zone keys disable the limiter silently."""
        conf = render_gateway_conf()
        mapping = _block(conf, "map $remote_addr $rpc_limit_key")
        empty = re.search(r'""\s+(\S+);', mapping)
        self.assertIsNotNone(empty, mapping)
        fallback = empty.group(1)
        self.assertTrue(fallback, "empty-key fallback must be non-empty")
        self.assertNotEqual('""', fallback)
        self.assertNotEqual("''", fallback)
        self.assertIn("default $remote_addr;", mapping)

        zone = re.search(r"(?m)^limit_req_zone\s+(\S+)\s+zone=", conf)
        self.assertIsNotNone(zone)
        self.assertEqual("$rpc_limit_key", zone.group(1))
        self.assertIsNone(re.search(r"(?m)^limit_req_zone \$http_", conf))
        self.assertIsNone(re.search(r"(?m)^limit_req_zone \$remote_addr", conf))

    def test_trusts_cloudflare_pops_so_xff_walk_skips_them(self):
        """Render Web Services always sit behind Cloudflare.

        XFF is `client, cf-pop`. Private-only set_real_ip_from makes
        real_ip_recursive key on the PoP (shared 20 r/s bucket).
        """
        conf = render_gateway_conf()
        for cidr in (
            "104.16.0.0/13",
            "104.24.0.0/14",
            "172.64.0.0/13",
            "162.158.0.0/15",
            "173.245.48.0/20",
            "2400:cb00::/32",
            "2a06:98c0::/29",
        ):
            self.assertIn(f"set_real_ip_from {cidr};", conf, cidr)
        # 172.64/13 is CF, not RFC1918 — 172.16/12 alone is not enough.
        self.assertIn("set_real_ip_from 172.16.0.0/12;", conf)
        self.assertIn("set_real_ip_from 172.64.0.0/13;", conf)

    def test_resolver_comes_from_placeholder_not_public_dns(self):
        """resolver must be injected at start, not baked in as a public DNS IP."""
        raw = TEMPLATE.read_text(encoding="utf-8")
        resolver_lines = [
            ln.strip()
            for ln in raw.splitlines()
            if re.match(r"resolver\s", ln.strip())
        ]
        self.assertEqual(["resolver ${NGINX_LOCAL_RESOLVERS};"], resolver_lines)
        self.assertIn("resolver_timeout 5s;", raw)
        self.assertNotRegex(raw, r"(?m)^resolver\s+\d+\.\d+\.\d+\.\d+")
        script = RESOLVER_SCRIPT.read_text(encoding="utf-8")
        for ip in PUBLIC_RESOLVERS:
            self.assertNotIn(ip, script, ip)
        self.assertIsNone(re.search(r"(?m)^resolver\s+\S+.*valid=", raw))
        self.assertIn("/etc/resolv.conf", script)

        conf = render_gateway_conf({"NGINX_LOCAL_RESOLVERS": "10.99.0.53 10.99.0.54"})
        rendered_resolver = [
            ln.strip()
            for ln in conf.splitlines()
            if re.match(r"resolver\s", ln.strip())
        ]
        self.assertEqual(["resolver 10.99.0.53 10.99.0.54;"], rendered_resolver)
        for ip in PUBLIC_RESOLVERS:
            self.assertNotIn(ip, rendered_resolver[0], ip)

    def test_proxy_pass_uses_variable_not_literal_upstream(self):
        """Regression for the 2026-08-16 incident: literal proxy_pass caches the IP."""
        raw = TEMPLATE.read_text(encoding="utf-8")
        self.assertNotIn("proxy_pass ${REPLICA_UPSTREAM};", raw)
        self.assertIn("set $replica_upstream ${REPLICA_UPSTREAM};", raw)
        self.assertIn("proxy_pass $replica_upstream$request_uri;", raw)

        conf = render_gateway_conf()
        self.assertNotIn("proxy_pass http://fortel2-replica:10000;", conf)
        self.assertIn("set $replica_upstream http://fortel2-replica:10000;", conf)
        self.assertIn("proxy_pass $replica_upstream$request_uri;", conf)

        proxied = _block(conf, "location /")
        self.assertIn("set $replica_upstream", proxied)
        self.assertIn("proxy_pass $replica_upstream$request_uri;", proxied)

    def test_resolver_script_extracts_nameservers(self):
        """Same awk as nginxinc 15-local-resolvers.envsh: IPv4 as-is, IPv6 bracketed."""
        got = _run_resolver_script(
            "# comment\n"
            "nameserver 10.31.0.2\n"
            "nameserver 2001:db8::53\n"
            "options ndots:0\n"
        )
        self.assertEqual(0, got.returncode, got.stderr)
        self.assertEqual("10.31.0.2 [2001:db8::53]", got.stdout)

    def test_resolver_script_fails_without_nameserver(self):
        got = _run_resolver_script("search render.internal\noptions ndots:0\n")
        self.assertNotEqual(0, got.returncode)
        self.assertIn("no nameserver", got.stderr)


class GatewayDockerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skip_reason = _docker_usable()
        cls.image_built = False
        if cls.skip_reason:
            return
        build = subprocess.run(
            [
                "docker",
                "build",
                "-f",
                str(DOCKERFILE),
                "-t",
                IMAGE,
                str(GATEWAY),
            ],
            capture_output=True,
            text=True,
            timeout=300,
        )
        if build.returncode != 0:
            raise AssertionError(
                "docker is present but gateway image failed to build:\n"
                + (build.stderr or build.stdout)[-2000:]
            )
        cls.image_built = True
        # Variable proxy_pass uses the nginx resolver, which ignores
        # /etc/hosts. host.docker.internal only exists there via
        # --add-host, so dummy-upstream tests must use the numeric IP.
        cls.host_ip = cls._container_host_ip()

    def setUp(self):
        if self.skip_reason:
            raise unittest.SkipTest(self.skip_reason)

    @classmethod
    def _container_host_ip(cls) -> str:
        probe = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--add-host=host.docker.internal:host-gateway",
                IMAGE,
                "sh",
                "-c",
                'awk \'$2=="host.docker.internal" {print $1; exit}\' /etc/hosts',
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        ip = (probe.stdout or "").strip().split()[0] if probe.returncode == 0 else ""
        if not ip:
            raise AssertionError(
                "could not read host.docker.internal from gateway image /etc/hosts:\n"
                + (probe.stderr or probe.stdout or "")[-1000:]
            )
        return ip

    def _start_upstream(self):
        handler = _DummyFilter
        handler.hits = []
        handler.last_body = b""
        server = ThreadingHTTPServer(("0.0.0.0", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, server.server_address[1]

    def _run_gateway(self, upstream_port: int, extra_env=None):
        host_port = _free_port()
        env = {
            "PORT": "10000",
            "REPLICA_UPSTREAM": f"http://{self.host_ip}:{upstream_port}",
            "RPC_RATE": "1r/s",
            "RPC_BURST": "2",
            "RPC_REAL_IP_HEADER": "X-Forwarded-For",
            "RPC_MAX_BODY": "1m",
        }
        env.update(extra_env or {})
        cmd = [
            "docker",
            "run",
            "-d",
            "--rm",
            "--add-host=host.docker.internal:host-gateway",
            "-p",
            f"127.0.0.1:{host_port}:10000",
        ]
        for key, value in env.items():
            cmd.extend(["-e", f"{key}={value}"])
        cmd.append(IMAGE)
        cid = subprocess.check_output(cmd, text=True, timeout=60).strip()
        url = f"http://127.0.0.1:{host_port}"
        deadline = time.time() + 20
        last_err = None
        while time.time() < deadline:
            try:
                status, body, _hdrs = _http("GET", f"{url}/healthz", timeout=1.5)
                if status == 200 and body == b"ok\n":
                    return cid, url
                last_err = f"healthz {status} {body!r}"
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
                last_err = str(exc)
            time.sleep(0.2)
        subprocess.run(["docker", "stop", "-t", "2", cid], capture_output=True)
        raise AssertionError(f"gateway never became ready: {last_err}")

    def _stop(self, cid: str) -> None:
        subprocess.run(["docker", "stop", "-t", "2", cid], capture_output=True, timeout=30)

    def test_passthrough_and_burst_returns_429(self):
        upstream, up_port = self._start_upstream()
        cid = None
        try:
            cid, url = self._run_gateway(up_port)
            before = list(_DummyFilter.hits)

            status, body, headers = _http("POST", url, CHAIN_ID_REQ)
            self.assertEqual(200, status, body)
            self.assertEqual(CHAIN_ID_BODY, body)
            self.assertEqual("*", headers.get("Access-Control-Allow-Origin"))
            self.assertEqual(before + ["POST /"], _DummyFilter.hits)
            self.assertEqual(CHAIN_ID_REQ, _DummyFilter.last_body)

            hz_status, hz_body, _ = _http("GET", f"{url}/healthz")
            self.assertEqual(200, hz_status)
            self.assertEqual(b"ok\n", hz_body)
            self.assertEqual(before + ["POST /"], _DummyFilter.hits)
            hz_codes = [_http("GET", f"{url}/healthz")[0] for _ in range(20)]
            self.assertEqual({200}, set(hz_codes), hz_codes)

            codes = []
            for _ in range(20):
                code, _body, _hdrs = _http("POST", url, CHAIN_ID_REQ)
                codes.append(code)
            self.assertIn(429, codes, f"expected 429 in burst, got {codes}")
            self.assertIn(200, codes, f"expected some 200s before the cap, got {codes}")
        finally:
            if cid:
                self._stop(cid)
            upstream.shutdown()

    def test_missing_real_ip_header_still_rate_limits(self):
        """Header absent → fallback key is non-empty; limiter stays on."""
        upstream, up_port = self._start_upstream()
        cid = None
        try:
            cid, url = self._run_gateway(
                up_port,
                extra_env={"RPC_REAL_IP_HEADER": "X-Does-Not-Exist"},
            )
            codes = []
            for _ in range(20):
                code, _body, _hdrs = _http("POST", url, CHAIN_ID_REQ)
                codes.append(code)
            self.assertIn(
                429,
                codes,
                f"missing real-ip header must not disable limit_req; got {codes}",
            )
        finally:
            if cid:
                self._stop(cid)
            upstream.shutdown()

    def test_proxy_forwards_path_and_query(self):
        """Variable proxy_pass must still forward path and query unchanged.

        A no-path literal proxy_pass does this automatically. The variable
        form used to re-resolve DNS does not unless $request_uri is appended.
        This is the test that chooses the proxy_pass form.
        """
        upstream, up_port = self._start_upstream()
        cid = None
        try:
            cid, url = self._run_gateway(up_port)
            status, _body, _hdrs = _http("GET", f"{url}/status?qid=7&x=1")
            self.assertEqual(200, status)
            self.assertIn("GET /status?qid=7&x=1", _DummyFilter.hits)

            status, _body, _hdrs = _http("POST", f"{url}/rpc?foo=bar", CHAIN_ID_REQ)
            self.assertEqual(200, status)
            self.assertIn("POST /rpc?foo=bar", _DummyFilter.hits)
        finally:
            if cid:
                self._stop(cid)
            upstream.shutdown()

    def test_running_config_resolver_matches_resolv_conf(self):
        """Live container: resolver IPs must be this container's nameservers."""
        result = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                IMAGE,
                "sh",
                "-c",
                "cat /etc/resolv.conf; echo '---NGINX---'; nginx -T",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(0, result.returncode, result.stderr or result.stdout)
        stdout = result.stdout or ""
        combined = stdout + "\n" + (result.stderr or "")
        resolv_part, _, _nginx_part = stdout.partition("---NGINX---")
        nameservers = []
        for line in resolv_part.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[0] == "nameserver":
                ip = parts[1]
                if ":" in ip and not ip.startswith("["):
                    ip = f"[{ip}]"
                nameservers.append(ip)
        self.assertTrue(nameservers, "container /etc/resolv.conf had no nameserver")

        resolver_line = None
        for line in combined.splitlines():
            stripped = line.strip()
            if stripped.startswith("resolver ") and stripped.endswith(";"):
                resolver_line = stripped
                break
        self.assertIsNotNone(resolver_line, combined[-2000:])
        for ns in nameservers:
            self.assertIn(ns, resolver_line, resolver_line)
        for public in PUBLIC_RESOLVERS:
            if public not in nameservers:
                self.assertNotIn(public, resolver_line)

        # DNS-change-without-restart (the 2026-08-16 incident) is not
        # simulated here. Docker /etc/hosts and a loopback dummy do not
        # exercise nginx's resolver, and Docker embedded-DNS TTLs would
        # make a same-name container swap a false failure. That case is
        # the live-Render reproduction in the G-2 gate.


if __name__ == "__main__":
    unittest.main()
