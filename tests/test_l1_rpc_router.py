#!/usr/bin/env python3
"""Unit tests for l1_rpc_router schedule selection."""

import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from l1_rpc_router import choose_upstream, redact


PT = ZoneInfo("America/Los_Angeles")
METERED = "https://metered.example/secret-token"
PUBLIC = "https://ethereum-sepolia-rpc.publicnode.com"


class ChooseUpstreamTests(unittest.TestCase):
    def test_business_hours_use_metered(self):
        now = datetime(2026, 8, 4, 9, 0, tzinfo=PT)  # Monday 09:00
        url, reason = choose_upstream(
            now,
            metered_url=METERED,
            public_url=PUBLIC,
            start_hour=9,
            end_hour=17,
        )
        self.assertEqual(METERED, url)
        self.assertIn("business", reason)

    def test_end_hour_is_exclusive(self):
        now = datetime(2026, 8, 4, 17, 0, tzinfo=PT)
        url, _ = choose_upstream(
            now,
            metered_url=METERED,
            public_url=PUBLIC,
            start_hour=9,
            end_hour=17,
        )
        self.assertEqual(PUBLIC, url)

    def test_morning_before_nine_is_public(self):
        now = datetime(2026, 8, 4, 8, 59, tzinfo=PT)
        url, _ = choose_upstream(
            now,
            metered_url=METERED,
            public_url=PUBLIC,
            start_hour=9,
            end_hour=17,
        )
        self.assertEqual(PUBLIC, url)

    def test_force_public(self):
        now = datetime(2026, 8, 4, 12, 0, tzinfo=PT)
        url, reason = choose_upstream(
            now,
            metered_url=METERED,
            public_url=PUBLIC,
            start_hour=9,
            end_hour=17,
            force="public",
        )
        self.assertEqual(PUBLIC, url)
        self.assertEqual("force=public", reason)

    def test_force_metered(self):
        now = datetime(2026, 8, 4, 3, 0, tzinfo=PT)
        url, reason = choose_upstream(
            now,
            metered_url=METERED,
            public_url=PUBLIC,
            start_hour=9,
            end_hour=17,
            force="metered",
        )
        self.assertEqual(METERED, url)
        self.assertEqual("force=metered", reason)

    def test_redact_strips_token(self):
        self.assertEqual(
            "https://metered.example/<redacted>",
            redact(METERED),
        )
        self.assertNotIn("secret", redact(METERED))

    def test_redact_strips_query_and_userinfo(self):
        self.assertEqual(
            "https://rpc.example/<redacted>",
            redact("https://rpc.example?api_key=secret"),
        )
        self.assertEqual(
            "https://rpc.example/<redacted>",
            redact("https://user:pass@rpc.example/path?token=abc"),
        )
        self.assertNotIn("secret", redact("https://rpc.example?api_key=secret"))
        self.assertNotIn("pass", redact("https://user:pass@rpc.example/"))

    def test_require_http_url_rejects_file_scheme(self):
        from l1_rpc_router import require_http_url

        with self.assertRaises(SystemExit) as ctx:
            require_http_url("L1_RPC_PUBLIC_URL", "file:///etc/passwd")
        self.assertIn("http(s)", str(ctx.exception))

    def test_require_http_url_accepts_https(self):
        from l1_rpc_router import require_http_url

        self.assertEqual(PUBLIC, require_http_url("L1_RPC_PUBLIC_URL", PUBLIC))


class RouterStateTimezoneTests(unittest.TestCase):
    def test_invalid_tz_fails_startup(self):
        import os
        from unittest import mock

        from l1_rpc_router import RouterState

        env = {
            "L1_RPC_METERED_URL": METERED,
            "TZ": "America/Los_Anglees",  # typo
        }
        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaises(SystemExit) as ctx:
                RouterState()
        self.assertIn("invalid TZ", str(ctx.exception))
        self.assertIn("America/Los_Anglees", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
