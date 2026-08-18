#!/usr/bin/env python3
"""Property tests for the diskless public RPC gateway (G-1 / G-3)."""

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

# Filled at container start from /etc/resolv.conf — not operator keys.
# TEST-NET-1 stub so unit tests can render the template without Docker.
# NGINX_REPLICA_UPSTREAM defaults to the bare contract URL (no-search
# fallback). Qualification is tested via the startup script, not here.
STARTUP_DEFAULTS = {
    "NGINX_LOCAL_RESOLVERS": "192.0.2.53",
    "NGINX_REPLICA_UPSTREAM": "http://fortel2-replica:10000",
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

SEARCH_STUB = "oregon-private.render.test"
DUMMY_NGINX_CONF = """
server {
    listen 10000;
    server_name _;
    location / {
        default_type application/json;
        return 200 '{"jsonrpc":"2.0","id":1,"result":"0x354"}';
    }
}
"""


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


def _run_resolver_script(resolv_text: str, extra_env=None) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory() as tmp:
        resolv = Path(tmp) / "resolv.conf"
        resolv.write_text(resolv_text, encoding="utf-8")
        env = {
            **os.environ,
            "RESOLV_CONF": str(resolv),
            "REPLICA_UPSTREAM": "http://fortel2-replica:10000",
        }
        env.update(extra_env or {})
        return subprocess.run(
            [
                "sh",
                "-c",
                '. "$1" && printf "NGINX_LOCAL_RESOLVERS=%s\\n'
                'NGINX_SEARCH_DOMAIN=%s\\nNGINX_REPLICA_UPSTREAM=%s\\n" '
                '"$NGINX_LOCAL_RESOLVERS" "$NGINX_SEARCH_DOMAIN" '
                '"$NGINX_REPLICA_UPSTREAM"',
                "resolver-script",
                str(RESOLVER_SCRIPT),
            ],
            capture_output=True,
            text=True,
            timeout=10,
            env=env,
        )


def _script_exports(got: subprocess.CompletedProcess) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in (got.stdout or "").splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            out[key] = value
    return out


def _http(method: str, url: str, body: bytes | None = None, timeout: float = 5.0):
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or parsed.hostname is None:
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
        type(self).last_body = self.rfile.read(n)
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
        self.assertIn("NGINX_REPLICA_UPSTREAM", df)
        self.assertRegex(
            df,
            r'NGINX_ENVSUBST_FILTER="[^"]*NGINX_LOCAL_RESOLVERS[^"]*"',
        )
        self.assertRegex(
            df,
            r'NGINX_ENVSUBST_FILTER="[^"]*NGINX_REPLICA_UPSTREAM[^"]*"',
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
                "NGINX_REPLICA_UPSTREAM": "http://example.internal:9",
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
        """Regression for incident 1: literal proxy_pass caches the IP."""
        raw = TEMPLATE.read_text(encoding="utf-8")
        self.assertNotIn("proxy_pass ${REPLICA_UPSTREAM};", raw)
        self.assertNotIn("proxy_pass ${NGINX_REPLICA_UPSTREAM};", raw)
        self.assertIn("set $replica_upstream ${NGINX_REPLICA_UPSTREAM};", raw)
        self.assertIn("proxy_pass $replica_upstream$request_uri;", raw)

        conf = render_gateway_conf()
        self.assertNotIn("proxy_pass http://fortel2-replica:10000;", conf)
        self.assertIn("set $replica_upstream http://fortel2-replica:10000;", conf)
        self.assertIn("proxy_pass $replica_upstream$request_uri;", conf)

        proxied = _block(conf, "location /")
        self.assertIn("set $replica_upstream", proxied)
        self.assertIn("proxy_pass $replica_upstream$request_uri;", proxied)

    def test_short_name_gets_search_suffix(self):
        """Bare host + search domain → host is qualified; scheme/port stay put."""
        got = _run_resolver_script(
            f"nameserver 10.31.0.2\nsearch {SEARCH_STUB} extra.invalid\n"
        )
        self.assertEqual(0, got.returncode, got.stderr)
        env = _script_exports(got)
        self.assertEqual("10.31.0.2", env.get("NGINX_LOCAL_RESOLVERS"))
        self.assertEqual(SEARCH_STUB, env.get("NGINX_SEARCH_DOMAIN"))
        self.assertEqual(
            f"http://fortel2-replica.{SEARCH_STUB}:10000",
            env.get("NGINX_REPLICA_UPSTREAM"),
        )
        self.assertNotIn(
            f"fortel2-replica.{SEARCH_STUB}.{SEARCH_STUB}",
            env.get("NGINX_REPLICA_UPSTREAM", ""),
        )

        conf = render_gateway_conf(
            {"NGINX_REPLICA_UPSTREAM": env["NGINX_REPLICA_UPSTREAM"]}
        )
        self.assertIn(
            f"set $replica_upstream http://fortel2-replica.{SEARCH_STUB}:10000;",
            conf,
        )
        self.assertIn("proxy_pass $replica_upstream$request_uri;", conf)
        self.assertNotIn("proxy_pass http://fortel2-replica:10000;", conf)

    def test_dotted_host_is_not_qualified_again(self):
        """A host that already has a dot must not get a second suffix."""
        already = "http://fortel2-replica.some.domain:10000"
        got = _run_resolver_script(
            f"nameserver 10.31.0.2\nsearch {SEARCH_STUB}\n",
            extra_env={"REPLICA_UPSTREAM": already},
        )
        self.assertEqual(0, got.returncode, got.stderr)
        env = _script_exports(got)
        self.assertEqual(already, env.get("NGINX_REPLICA_UPSTREAM"))
        self.assertNotIn(SEARCH_STUB, env.get("NGINX_REPLICA_UPSTREAM", ""))

        conf = render_gateway_conf({"NGINX_REPLICA_UPSTREAM": already})
        self.assertIn(f"set $replica_upstream {already};", conf)
        self.assertNotIn(
            f"fortel2-replica.some.domain.{SEARCH_STUB}",
            conf,
        )

    def test_no_search_line_keeps_bare_name(self):
        """Missing search is not a startup failure; bare name is used as-is."""
        got = _run_resolver_script("nameserver 10.31.0.2\noptions ndots:0\n")
        self.assertEqual(0, got.returncode, got.stderr)
        env = _script_exports(got)
        self.assertEqual("10.31.0.2", env.get("NGINX_LOCAL_RESOLVERS"))
        self.assertEqual("", env.get("NGINX_SEARCH_DOMAIN"))
        self.assertEqual(
            "http://fortel2-replica:10000",
            env.get("NGINX_REPLICA_UPSTREAM"),
        )

    def test_ipv4_literal_is_not_qualified(self):
        got = _run_resolver_script(
            f"nameserver 10.31.0.2\nsearch {SEARCH_STUB}\n",
            extra_env={"REPLICA_UPSTREAM": "http://10.31.222.133:10000"},
        )
        self.assertEqual(0, got.returncode, got.stderr)
        env = _script_exports(got)
        self.assertEqual("http://10.31.222.133:10000", env.get("NGINX_REPLICA_UPSTREAM"))

    def test_resolver_script_extracts_nameservers(self):
        """Same awk as nginxinc 15-local-resolvers.envsh: IPv4 as-is, IPv6 bracketed."""
        got = _run_resolver_script(
            "# comment\n"
            "nameserver 10.31.0.2\n"
            "nameserver 2001:db8::53\n"
            "options ndots:0\n"
        )
        self.assertEqual(0, got.returncode, got.stderr)
        env = _script_exports(got)
        self.assertEqual("10.31.0.2 [2001:db8::53]", env.get("NGINX_LOCAL_RESOLVERS"))

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
        """Live container: resolver IPs must be this container's nameservers.

        The nginxinc entrypoint only sources /docker-entrypoint.d/ when
        argv[1] is nginx or nginx-debug. `docker run IMAGE sh -c …`
        skips 14-resolvers-from-resolv.conf.envsh and envsubst, so this
        test must start the default CMD (nginx) and exec into it.
        """
        cid = subprocess.check_output(
            ["docker", "run", "-d", "--rm", IMAGE],
            text=True,
            timeout=60,
        ).strip()
        try:
            nginx_t = self._wait_nginx_t(cid)
            resolv = subprocess.run(
                ["docker", "exec", cid, "cat", "/etc/resolv.conf"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertEqual(0, resolv.returncode, resolv.stderr)
            nameservers = []
            for line in (resolv.stdout or "").splitlines():
                parts = line.split()
                if len(parts) >= 2 and parts[0] == "nameserver":
                    ip = parts[1]
                    if ":" in ip and not ip.startswith("["):
                        ip = f"[{ip}]"
                    nameservers.append(ip)
            self.assertTrue(nameservers, "container /etc/resolv.conf had no nameserver")

            combined = (nginx_t.stdout or "") + "\n" + (nginx_t.stderr or "")
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
        finally:
            self._stop(cid)

    def test_search_qualified_short_name_resolves(self):
        """Incident 2: nginx resolver does not apply search; we must qualify.

        Stub upstream is reachable only as replica.search.test (Docker
        network alias). Bare `replica` is not a name on that network. A
        G-2-style variable proxy_pass without qualification gets
        Host not found — the production failure. Qualification must
        turn REPLICA_UPSTREAM=http://replica:10000 into a request that
        actually succeeds.
        """
        net = f"g3search-{os.getpid()}-{int(time.time())}"
        dummy = None
        gw = None
        created_net = False
        host_port = _free_port()
        tmp = tempfile.TemporaryDirectory()
        try:
            create = subprocess.run(
                ["docker", "network", "create", net],
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(0, create.returncode, create.stderr)
            created_net = True

            conf_path = Path(tmp.name) / "dummy.conf"
            conf_path.write_text(DUMMY_NGINX_CONF, encoding="utf-8")
            dummy = subprocess.check_output(
                [
                    "docker",
                    "run",
                    "-d",
                    "--rm",
                    "--network",
                    net,
                    "--network-alias",
                    "replica.search.test",
                    "-v",
                    f"{conf_path}:/etc/nginx/conf.d/default.conf:ro",
                    "--entrypoint",
                    "nginx",
                    "nginxinc/nginx-unprivileged:1.30.4-alpine",
                    "-g",
                    "daemon off;",
                ],
                text=True,
                timeout=60,
            ).strip()

            gw = subprocess.check_output(
                [
                    "docker",
                    "run",
                    "-d",
                    "--rm",
                    "--network",
                    net,
                    "--dns-search",
                    "search.test",
                    "-p",
                    f"127.0.0.1:{host_port}:10000",
                    "-e",
                    "REPLICA_UPSTREAM=http://replica:10000",
                    "-e",
                    "RPC_RATE=20r/s",
                    "-e",
                    "RPC_BURST=40",
                    IMAGE,
                ],
                text=True,
                timeout=60,
            ).strip()

            url = f"http://127.0.0.1:{host_port}"
            deadline = time.time() + 20
            last_err = None
            while time.time() < deadline:
                try:
                    status, body, _hdrs = _http("GET", f"{url}/healthz", timeout=1.5)
                    if status == 200 and body == b"ok\n":
                        last_err = None
                        break
                    last_err = f"healthz {status} {body!r}"
                except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
                    last_err = str(exc)
                time.sleep(0.2)
            if last_err:
                logs = subprocess.run(
                    ["docker", "logs", gw],
                    capture_output=True,
                    text=True,
                    timeout=15,
                )
                raise AssertionError(
                    f"gateway never became ready: {last_err}\n"
                    f"logs:\n{(logs.stderr or '') + (logs.stdout or '')}"[-2000:]
                )

            nginx_t = self._wait_nginx_t(gw)
            combined = (nginx_t.stdout or "") + "\n" + (nginx_t.stderr or "")
            self.assertIn(
                "set $replica_upstream http://replica.search.test:10000;",
                combined,
                combined[-2000:],
            )
            self.assertNotIn(
                "set $replica_upstream http://replica:10000;",
                combined,
            )
            self.assertIn("proxy_pass $replica_upstream$request_uri;", combined)

            status, body, _hdrs = _http("POST", url, CHAIN_ID_REQ)
            self.assertEqual(200, status, body)
            self.assertIn(b'"result":"0x354"', body)
        finally:
            if gw:
                self._stop(gw)
            if dummy:
                self._stop(dummy)
            if created_net:
                subprocess.run(
                    ["docker", "network", "rm", net],
                    capture_output=True,
                    timeout=30,
                )
            tmp.cleanup()

        # DNS-change-without-restart (incident 1) is not simulated here.
        # Docker embedded-DNS TTLs would make a same-name container swap
        # a false failure. That case is the live-Render reproduction.

    def _wait_nginx_t(self, cid: str) -> subprocess.CompletedProcess:
        last_err = None
        deadline = time.time() + 20
        while time.time() < deadline:
            probe = subprocess.run(
                ["docker", "exec", cid, "nginx", "-T"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if probe.returncode == 0:
                return probe
            last_err = probe.stderr or probe.stdout
            time.sleep(0.2)
        logs = subprocess.run(
            ["docker", "logs", cid],
            capture_output=True,
            text=True,
            timeout=15,
        )
        raise AssertionError(
            (
                f"nginx -T never succeeded: {last_err}\n"
                f"logs:\n{(logs.stderr or '') + (logs.stdout or '')}"
            )[-2000:]
        )


if __name__ == "__main__":
    unittest.main()
