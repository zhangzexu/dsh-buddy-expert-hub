#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""export_node 纯函数单测：类型映射、文件名、落盘路径、轮询终态、下载目的地校验。不访问网络。"""

from __future__ import annotations

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import export_node  # noqa: E402


class ExportNodeTest(unittest.TestCase):
    def test_normalize_node_id(self):
        self.assertEqual(export_node.normalize_node_id("  blk_1 "), "blk_1")
        self.assertEqual(
            export_node.normalize_node_id("https://workbuddy.cn/space/d/blk_2?x=1"),
            "blk_2",
        )
        self.assertEqual(
            export_node.normalize_node_id("https://x.workbuddy.link/p/blk_3"),
            "blk_3",
        )

    def test_classify_kind(self):
        self.assertEqual(export_node.classify_kind("page"), ("web", ""))
        self.assertEqual(export_node.classify_kind(" database "), ("database", ""))
        api_kind, err = export_node.classify_kind("drive")
        self.assertEqual(api_kind, "")
        self.assertIn("get_download_link.py", err)
        _, folder_err = export_node.classify_kind("folder")
        self.assertIn("文件夹", folder_err)
        _, empty_err = export_node.classify_kind("")
        self.assertIn("空", empty_err)

    def test_safe_file_name(self):
        self.assertEqual(export_node.safe_export_file_name("会议纪要.md", "md"), "会议纪要.md")
        self.assertEqual(
            export_node.safe_export_file_name("../../a/会议.zip", "md"),
            "会议.zip",
        )
        self.assertEqual(export_node.safe_export_file_name("a<b>.csv", "csv"), "a_b_.csv")
        self.assertEqual(export_node.safe_export_file_name("", "html"), "export.html")

    def test_resolve_out_path_file(self):
        path = export_node.resolve_out_path("/tmp/out/note.md", "other.md")
        self.assertTrue(str(path).endswith("note.md"))

    def test_wait_export_done_and_timeout(self):
        clock = {"t": 0.0}

        def monotonic():
            return clock["t"]

        def sleep_fn(seconds):
            clock["t"] += seconds

        states = iter([
            {"status": "pending"},
            {"status": "running"},
            {"status": "done", "fileName": "a.md"},
        ])
        got = export_node.wait_export(
            lambda: next(states),
            timeout_s=10,
            interval_s=2,
            sleep_fn=sleep_fn,
            monotonic=monotonic,
        )
        self.assertEqual(got["status"], "done")

        def pending():
            return {"status": "pending"}

        with self.assertRaises(TimeoutError):
            export_node.wait_export(
                pending,
                timeout_s=3,
                interval_s=2,
                sleep_fn=sleep_fn,
                monotonic=monotonic,
            )

    def test_wait_export_rejects_unknown_status(self):
        with self.assertRaises(ValueError):
            export_node.wait_export(
                lambda: {"status": "weird"},
                timeout_s=5,
                interval_s=1,
                sleep_fn=lambda _s: None,
                monotonic=lambda: 0.0,
            )


_COS = "https://bucket.cos.ap-guangzhou.myqcloud.com/export/a.md?sign=1"


class _FakeResp:
    def __init__(self, status, location="", body=b""):
        self.status = status
        self._location = location
        self._body = body
        self.closed = False

    def getheader(self, name, default=None):
        if str(name).lower() == "location":
            return self._location or default
        return default

    def read(self, _n):
        data, self._body = self._body, b""
        return data

    def close(self):
        self.closed = True


def _resolve_to(ip):
    def resolve(_host, port, type=0):  # noqa: A002
        del type
        return [(2, 1, 0, "", (ip, port))]

    return resolve


class ExportDownloadGuardTest(unittest.TestCase):
    def test_cos_host_allowlist(self):
        allowed = (
            _COS,
            "https://bucket-1258344699.cos.ap-beijing.myqcloud.com/a",
            "https://bucket.cos.accelerate.myqcloud.com/a",
            "https://bucket.cos.ap-guangzhou.tencentcos.cn/a?q-sign=1",
            "https://bucket.cos.ap-guangzhou.myqcloud.com:443/a",
        )
        for url in allowed:
            parts = export_node._parse_export_download_url(url)
            self.assertTrue(parts.hostname.endswith((".myqcloud.com", ".tencentcos.cn")))

        rejected = (
            "http://bucket.cos.ap-guangzhou.myqcloud.com/a",
            "https://127.0.0.1:8443/a",
            "https://[::1]/a",
            "https://169.254.169.254/latest/meta-data/",
            "https://10.0.0.1/a",
            "https://evil.example/a",
            "https://notmyqcloud.com/a",
            "https://myqcloud.com.evil.com/a",
            "https://bucket.cos.ap-guangzhou.myqcloud.com.evil.com/a",
            "https://evil.myqcloud.com/a",
            "https://bucket.cos-internal.ap-guangzhou.tencentcos.cn/a",
            "https://user@bucket.cos.ap-guangzhou.myqcloud.com/a",
            "https://bucket.cos.ap-guangzhou.myqcloud.com:8443/a",
            "https://bucket.cos.ap-guangzhou.myqcloud.com%2eevil.com/a",
        )
        for url in rejected:
            with self.assertRaises(export_node._UnsafeDownloadURL, msg=url):
                export_node._parse_export_download_url(url)

    def test_blocked_connection_addresses(self):
        blocked = (
            "127.0.0.1",
            "127.0.0.2",
            "0.0.0.0",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "169.254.1.1",
            "100.64.0.1",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fd00::1",
            "fe80::1",
            "::",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:10.0.0.1",
            "2002:7f00:1::",
            "64:ff9b::7f00:1",
            "fd00:ec2::254",
        )
        for raw in blocked:
            ip = export_node.ipaddress.ip_address(raw)
            self.assertTrue(export_node._address_blocked(ip), raw)
        for raw in ("1.1.1.1", "8.8.8.8", "::ffff:1.1.1.1"):
            ip = export_node.ipaddress.ip_address(raw)
            self.assertFalse(export_node._address_blocked(ip), raw)

    def _run_download(self, url, dest, resolve_fn, fetch_fn):
        buf = io.StringIO()
        with redirect_stdout(buf):
            with self.assertRaises(SystemExit):
                export_node._download(url, dest, resolve_fn=resolve_fn, fetch_fn=fetch_fn)
        return buf.getvalue()

    def test_download_does_not_connect_for_disallowed_url(self):
        def resolve(*_a, **_k):
            raise AssertionError("must not resolve")

        def fetch(*_a, **_k):
            raise AssertionError("must not connect")

        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "out.md"
            for url in (
                "https://127.0.0.1:8443/a",
                "https://169.254.169.254/latest/meta-data/",
                "https://10.0.0.8/a",
                "http://bucket.cos.ap-guangzhou.myqcloud.com/a",
            ):
                out = self._run_download(url, dest, resolve, fetch)
                self.assertIn("INVALID_RESPONSE", out)
                self.assertNotIn("169.254", out)
                self.assertNotIn("127.0.0.1", out)
                self.assertFalse(dest.exists())

    def test_download_rejects_private_resolution_before_connect(self):
        calls = []

        def fetch(*_a, **_k):
            calls.append(1)
            raise AssertionError("must not connect")

        with tempfile.TemporaryDirectory() as tmp:
            out = self._run_download(
                _COS,
                Path(tmp) / "out.md",
                _resolve_to("169.254.169.254"),
                fetch,
            )
        self.assertEqual(calls, [])
        self.assertIn("INVALID_RESPONSE", out)
        self.assertNotIn("169.254", out)

    def test_redirect_is_rechecked_and_not_followed_off_allowlist(self):
        calls = []

        def fetch(hostname, port, ip, target):
            del port, target
            calls.append((hostname, ip))
            return _FakeResp(302, "https://169.254.169.254/latest/meta-data/")

        with tempfile.TemporaryDirectory() as tmp:
            out = self._run_download(_COS, Path(tmp) / "out.md", _resolve_to("1.1.1.1"), fetch)
        self.assertEqual(calls, [("bucket.cos.ap-guangzhou.myqcloud.com", "1.1.1.1")])
        self.assertIn("INVALID_RESPONSE", out)
        self.assertNotIn("169.254", out)

    def test_redirect_rechecks_resolved_ip(self):
        seen = []

        def resolve(host, port, type=0):  # noqa: A002
            del host, type
            ip = "1.1.1.1" if not seen else "10.1.1.1"
            seen.append(ip)
            return [(2, 1, 0, "", (ip, port))]

        def fetch(hostname, port, ip, target):
            del hostname, port, ip, target
            return _FakeResp(302, "/next")

        with tempfile.TemporaryDirectory() as tmp:
            out = self._run_download(_COS, Path(tmp) / "out.md", resolve, fetch)
        self.assertEqual(seen, ["1.1.1.1", "10.1.1.1"])
        self.assertIn("INVALID_RESPONSE", out)

    def test_download_pins_resolved_ip_and_replaces_part_file(self):
        pinned = []

        def fetch(hostname, port, ip, target):
            pinned.append((hostname, port, ip, target))
            return _FakeResp(200, body=b"hello-export")

        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "note.md"
            export_node._download(_COS, dest, resolve_fn=_resolve_to("1.1.1.1"), fetch_fn=fetch)
            self.assertEqual(dest.read_bytes(), b"hello-export")
            self.assertFalse(dest.with_name(dest.name + ".part").exists())
        self.assertEqual(pinned, [(
            "bucket.cos.ap-guangzhou.myqcloud.com",
            443,
            "1.1.1.1",
            "/export/a.md?sign=1",
        )])

    def test_pinned_connection_uses_checked_ip_and_cos_sni(self):
        created = {}

        class _Raw:
            def close(self):
                created["closed"] = True

        def create_connection(address, timeout):
            created["address"] = address
            created["timeout"] = timeout
            return _Raw()

        def wrap_socket(raw, server_hostname):
            created["raw"] = raw
            created["sni"] = server_hostname
            return raw

        conn = export_node._PinnedHTTPSConnection(
            "bucket.cos.ap-guangzhou.myqcloud.com", 443, "1.1.1.1", 12,
        )
        original_create = export_node.socket.create_connection
        original_wrap = conn._pin_context.wrap_socket
        export_node.socket.create_connection = create_connection
        conn._pin_context.wrap_socket = wrap_socket
        try:
            conn.connect()
        finally:
            export_node.socket.create_connection = original_create
            conn._pin_context.wrap_socket = original_wrap
        self.assertEqual(created["address"], ("1.1.1.1", 443))
        self.assertEqual(created["timeout"], 12)
        self.assertEqual(created["sni"], "bucket.cos.ap-guangzhou.myqcloud.com")
        self.assertIs(conn.sock, created["raw"])

    def test_http_redirect_is_rejected(self):
        def fetch(*_a, **_k):
            return _FakeResp(302, "http://bucket.cos.ap-guangzhou.myqcloud.com/a")

        with tempfile.TemporaryDirectory() as tmp:
            out = self._run_download(_COS, Path(tmp) / "out.md", _resolve_to("1.1.1.1"), fetch)
        self.assertIn("INVALID_RESPONSE", out)


if __name__ == "__main__":
    unittest.main()
