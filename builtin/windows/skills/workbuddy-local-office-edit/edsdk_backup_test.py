import importlib.util
import io
import json
import os
from pathlib import Path
import socketserver
import subprocess
import tempfile
import threading
import unittest
from contextlib import redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch


@unittest.skipIf(os.name == "nt", "Unix socket integration; named pipe needs Windows runtime")
class DocumentBackupRoutingTest(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.deny = None
        self.save_failure = False
        self.save_http_error = False
        case = self

        class Ipc(socketserver.StreamRequestHandler):
            def handle(self):
                message = json.loads(self.rfile.readline())
                case.events.append(("ipc", message))
                action = message.get("action")
                response = {"ok": True, "ticket": "save-ticket", "fileIds": ["mine"]}
                if action == case.deny:
                    response = {"ok": False, "error": "backup unavailable"}
                self.wfile.write((json.dumps(response) + "\n").encode())

        class Sdk(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                case.events.append(("sdk", message))
                name = message.get("params", {}).get("name")
                if name == "save_file" and case.save_http_error:
                    self.send_error(503, "SDK unavailable")
                    return
                data = {"success": not case.save_failure or name != "save_file"}
                if name.startswith("create_"):
                    data["file_id"] = "mine"
                if name == "get_pool_status":
                    data = {"open_editors": [
                        {"file_id": "mine", "file_path": "/work/book.xlsx", "is_dirty": True},
                        {"file_id": "other", "file_path": "/work/other.xlsx", "is_dirty": True}]}
                response = {"result": {"content": [{"type": "text", "text": json.dumps(data)}]}}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(response).encode())

        self.temp = tempfile.TemporaryDirectory(prefix="doc-ipc-", dir="/tmp")
        self.address = str(Path(self.temp.name) / "broker.sock")
        self.servers = [socketserver.ThreadingUnixStreamServer(self.address, Ipc), ThreadingHTTPServer(("127.0.0.1", 0), Sdk)]
        self.threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in self.servers]
        for thread in self.threads:
            thread.start()
        self.env = {"CODEBUDDY_DOCUMENT_IPC_ADDRESS": self.address,
                    "CODEBUDDY_DOCUMENT_TOKEN": "test-capability",
                    "editor_sdk_port": str(self.servers[1].server_port),
                    "TENCENT_DOCS_LOCAL_MCP": f"http://127.0.0.1:{self.servers[1].server_port}/mcp"}

    def tearDown(self):
        for server, thread in zip(self.servers, self.threads):
            server.shutdown()
            server.server_close()
            thread.join()
        self.temp.cleanup()

    def scripts(self):
        plugins = Path(__file__).resolve().parents[2]
        return [Path(__file__).with_name("edsdk.py"),
                plugins / "builtin-plugins/workbuddy-pptx/skills/workbuddy-pptx/scripts/edsdk.py",
                plugins / "builtin-plugins/workbuddy-docx/skills/html-to-doc/scripts/edsdk.py"]

    def load(self, script):
        spec = importlib.util.spec_from_file_location("edsdk", script)
        sdk = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sdk)
        return sdk

    def sequence(self):
        return [(kind, msg.get("action") if kind == "ipc" else msg["params"]["name"]) for kind, msg in self.events]

    def test_scripts_send_payload_directly_and_wrap_save(self):
        for script in self.scripts():
            with self.subTest(script=script), patch.dict(os.environ, self.env):
                self.events.clear()
                sdk = self.load(script)
                sdk._rpc("tools/call", {"name": "doc_insert_text", "arguments": {"file_id": "mine", "text": "中文"}})
                sdk._rpc("tools/call", {"name": "save_file", "arguments": {"file_id": "mine", "file_path": "/work/new.xlsx"}})
                self.assertEqual(self.sequence(), [("ipc", "edit"), ("sdk", "doc_insert_text"),
                                                 ("ipc", "prepare"), ("sdk", "save_file"), ("ipc", "complete")])
                ipc = [msg for kind, msg in self.events if kind == "ipc"]
                self.assertTrue(all(m["command"] == "DocumentBackup" and "request" not in m for m in ipc))
                self.assertEqual((ipc[0]["fileId"], "path" in ipc[0]), ("mine", False))
                self.assertEqual(ipc[1]["path"], "/work/new.xlsx")
                self.assertEqual(ipc[2]["ticket"], "save-ticket")

    def test_path_only_calls_resolve_the_editor_like_editor_sdk(self):
        for script in self.scripts():
            with self.subTest(script=script), patch.dict(os.environ, self.env):
                self.events.clear()
                sdk = self.load(script)
                sdk._rpc("tools/call", {"name": "sheet_set_cell_value", "arguments": {"file_path": "/work/book.xlsx"}})
                sdk._rpc("tools/call", {"name": "save_file", "arguments": {"file_path": "/work/book.xlsx"}})
                self.assertEqual(self.sequence(), [("sdk", "get_pool_status"), ("ipc", "edit"), ("sdk", "sheet_set_cell_value"),
                                                   ("sdk", "get_pool_status"), ("ipc", "prepare"), ("sdk", "save_file"),
                                                   ("ipc", "complete")])
                ipc = [msg for kind, msg in self.events if kind == "ipc"]
                self.assertEqual([(m["fileId"], m.get("path")) for m in ipc[:2]], [("mine", None), ("mine", "/work/book.xlsx")])
                self.events.clear()
                stderr = io.StringIO()
                with redirect_stderr(stderr):
                    sdk._rpc("tools/call", {"name": "sheet_set_cell_value", "arguments": {"file_path": "./book.xlsx"}})
                self.assertIn("未找到编辑器", stderr.getvalue())
                self.assertEqual(self.sequence(), [("sdk", "get_pool_status"), ("sdk", "sheet_set_cell_value")])

    def test_backup_ipc_failures_do_not_block_edits_or_change_sdk_results(self):
        for script in self.scripts():
            for action, name in (("edit", "doc_insert_text"), ("edit", "create_document"),
                                 ("prepare", "save_file"), ("complete", "save_file"), ("cancel", "save_file")):
                with self.subTest(script=script, action=action, name=name), patch.dict(os.environ, self.env):
                    self.events.clear()
                    self.deny = action
                    self.save_failure = action == "cancel"
                    stderr = io.StringIO()
                    with redirect_stderr(stderr):
                        sdk = self.load(script)
                        result = sdk._rpc("tools/call", {"name": name, "arguments": {
                            "file_id": "mine", "file_path": "/work/new.xlsx"}})
                    self.assertEqual(json.loads(result["content"][0]["text"])["success"], not self.save_failure)
                    self.assertEqual(self.sequence().count(("sdk", name)), 1)
                    self.assertIn("backup unavailable", stderr.getvalue())
                    if action == "prepare":
                        self.assertEqual(self.sequence(), [("ipc", "prepare"), ("sdk", "save_file")])
                    if action == "cancel":
                        self.assertNotIn(("ipc", "complete"), self.sequence())

    def test_unreachable_ipc_does_not_block_script_or_hook_saves(self):
        env = {**self.env, "CODEBUDDY_DOCUMENT_IPC_ADDRESS": str(Path(self.temp.name) / "missing.sock")}
        for script in self.scripts():
            with self.subTest(script=script), patch.dict(os.environ, env):
                self.events.clear()
                stderr = io.StringIO()
                with redirect_stderr(stderr):
                    sdk = self.load(script)
                    sdk._rpc("tools/call", {"name": "save_file", "arguments": {
                        "file_id": "mine", "file_path": "/work/new.xlsx"}})
                self.assertEqual(self.sequence(), [("sdk", "save_file")])
                self.assertIn("备份准备", stderr.getvalue())
        self.events.clear()
        hook = Path(__file__).resolve().parents[2] / "builtin-plugins/workbuddy-sheetagent/hooks/save-on-subagent-stop.mjs"
        run = subprocess.run(["node", str(hook)], input='{"hook_event_name":"SubagentStop"}',
                             text=True, capture_output=True, timeout=15, env={**os.environ, **env})
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(self.sequence().count(("sdk", "save_file")), 2)
        self.assertIn("文档归属查询失败", run.stderr)

    def test_cancel_failure_does_not_mask_sdk_transport_error(self):
        self.deny = "cancel"
        self.save_http_error = True
        for script in self.scripts():
            with self.subTest(script=script), patch.dict(os.environ, self.env):
                self.events.clear()
                stderr = io.StringIO()
                with redirect_stderr(stderr):
                    sdk = self.load(script)
                    with self.assertRaises(SystemExit):
                        sdk._rpc("tools/call", {"name": "save_file", "arguments": {
                            "file_id": "mine", "file_path": "/work/new.xlsx"}})
                self.assertIn("503", stderr.getvalue())
                self.assertIn("backup unavailable", stderr.getvalue())
                self.assertEqual(self.sequence(), [("ipc", "prepare"), ("sdk", "save_file"), ("ipc", "cancel")])

    def test_sdk_failure_cancels_without_completion(self):
        with patch.dict(os.environ, self.env):
            self.save_failure = True
            sdk = self.load(self.scripts()[0])
            result = sdk._rpc("tools/call", {"name": "save_file", "arguments": {
                "file_id": "mine", "file_path": "/work/new.xlsx"}})
            self.assertFalse(json.loads(result["content"][0]["text"])["success"])
            self.assertEqual(self.sequence(), [("ipc", "prepare"), ("sdk", "save_file"), ("ipc", "cancel")])

    def test_read_only_calls_do_not_claim_ownership_or_log_missing_backup(self):
        for script in self.scripts():
            for backup_env in (self.env, {}, {"CODEBUDDY_DOCUMENT_BACKUP_ERROR": "unavailable"}):
                env = {"editor_sdk_port": self.env["editor_sdk_port"],
                       "TENCENT_DOCS_LOCAL_MCP": self.env["TENCENT_DOCS_LOCAL_MCP"], **backup_env}
                with self.subTest(script=script, backup_env=backup_env), patch.dict(os.environ, env, clear=True):
                    self.events.clear()
                    stderr = io.StringIO()
                    with redirect_stderr(stderr):
                        sdk = self.load(script)
                        for name in ("doc_get_text", "doc_compare_documents"):
                            sdk._rpc("tools/call", {"name": name, "arguments": {"file_id": "mine"}})
                    self.assertEqual(self.sequence(), [("sdk", "doc_get_text"), ("sdk", "doc_compare_documents")])
                    self.assertEqual(stderr.getvalue(), "")

    def test_non_agent_writes_log_missing_backup_and_still_call_sdk(self):
        env = {"editor_sdk_port": self.env["editor_sdk_port"],
               "TENCENT_DOCS_LOCAL_MCP": self.env["TENCENT_DOCS_LOCAL_MCP"]}
        for script in self.scripts():
            for name in ("doc_insert_text", "save_file", "create_document"):
                with self.subTest(script=script, name=name), patch.dict(os.environ, env, clear=True):
                    self.events.clear()
                    stderr = io.StringIO()
                    with redirect_stderr(stderr):
                        sdk = self.load(script)
                        result = sdk._rpc("tools/call", {"name": name, "arguments": {"file_id": "mine"}})
                    self.assertTrue(result)
                    self.assertEqual(self.sequence(), [("sdk", name)])
                    self.assertIn("未接入文档备份", stderr.getvalue())

    def test_hook_logs_missing_backup_and_preserves_legacy_saves(self):
        hook = Path(__file__).resolve().parents[2] / "builtin-plugins/workbuddy-sheetagent/hooks/save-on-subagent-stop.mjs"
        env = {k: v for k, v in os.environ.items() if not k.startswith("CODEBUDDY_DOCUMENT_")}
        env["TENCENT_DOCS_LOCAL_MCP"] = self.env["TENCENT_DOCS_LOCAL_MCP"]
        run = subprocess.run(["node", str(hook)], input='{"hook_event_name":"SubagentStop"}',
                             text=True, capture_output=True, timeout=15, env=env)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("未接入文档备份", run.stderr)
        saves = [m for kind, m in self.events if kind == "sdk" and m["params"]["name"] == "save_file"]
        self.assertEqual([m["params"]["arguments"]["file_id"] for m in saves], ["mine", "other"])
        self.assertFalse(any(kind == "ipc" for kind, _ in self.events))

    def test_backup_error_marker_logs_but_allows_writes_and_reads(self):
        env = {"CODEBUDDY_DOCUMENT_BACKUP_ERROR": "Document backup turn has ended",
               "editor_sdk_port": self.env["editor_sdk_port"],
               "TENCENT_DOCS_LOCAL_MCP": self.env["TENCENT_DOCS_LOCAL_MCP"]}
        for script in self.scripts():
            with self.subTest(script=script), patch.dict(os.environ, env, clear=True):
                self.events.clear()
                sdk = self.load(script)
                for name in ("sheet_set_cell_value", "save_file"):
                    stderr = io.StringIO()
                    with redirect_stderr(stderr):
                        sdk._rpc("tools/call", {"name": name, "arguments": {"file_id": "mine", "file_path": "/work/book.xlsx"}})
                    self.assertIn("Document backup turn has ended", stderr.getvalue())
                sdk._rpc("tools/call", {"name": "doc_get_text", "arguments": {"file_id": "mine"}})
                sdk._rpc("tools/call", {"name": "create_document", "arguments": {}})
                self.assertEqual(self.sequence(), [("sdk", "sheet_set_cell_value"), ("sdk", "save_file"),
                                                 ("sdk", "doc_get_text"), ("sdk", "create_document")])

    def test_hook_logs_backup_error_and_still_saves(self):
        hook = Path(__file__).resolve().parents[2] / "builtin-plugins/workbuddy-sheetagent/hooks/save-on-subagent-stop.mjs"
        env = {k: v for k, v in os.environ.items() if not k.startswith("CODEBUDDY_DOCUMENT_")}
        env.update({"CODEBUDDY_DOCUMENT_BACKUP_ERROR": "broker unavailable",
                    "TENCENT_DOCS_LOCAL_MCP": self.env["TENCENT_DOCS_LOCAL_MCP"]})
        run = subprocess.run(["node", str(hook)], input='{"hook_event_name":"SubagentStop"}',
                             text=True, capture_output=True, timeout=15, env=env)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("broker unavailable", run.stderr)
        self.assertEqual(self.sequence().count(("sdk", "save_file")), 2)

    def test_hook_logs_failures_without_repeating_saves_and_exits_zero(self):
        hook = Path(__file__).resolve().parents[2] / "builtin-plugins/workbuddy-sheetagent/hooks/save-on-subagent-stop.mjs"
        for action, saves in [("prepare", 1), ("complete", 1), ("cancel", 1), ("owned", 2)]:
            with self.subTest(action=action):
                self.events.clear()
                self.deny = action
                self.save_failure = action == "cancel"
                run = subprocess.run(["node", str(hook)], input='{"hook_event_name":"SubagentStop"}',
                                     text=True, capture_output=True, timeout=15, env={**os.environ, **self.env})
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(self.sequence().count(("sdk", "save_file")), saves)
                self.assertIn("backup unavailable", run.stderr)
                if self.save_failure:
                    self.assertIn("unsaved:", run.stderr)
                    self.assertNotIn("save ok:", run.stderr)
                if action in ("prepare", "cancel"):
                    self.assertNotIn(("ipc", "complete"), self.sequence())

    def test_subagent_hook_saves_only_owned_documents_directly(self):
        hook = Path(__file__).resolve().parents[2] / "builtin-plugins/workbuddy-sheetagent/hooks/save-on-subagent-stop.mjs"
        run = subprocess.run(["node", str(hook)], input='{"hook_event_name":"SubagentStop"}',
                             text=True, capture_output=True, timeout=15, env={**os.environ, **self.env})
        self.assertEqual(run.returncode, 0, run.stderr)
        saves = [m for kind, m in self.events if kind == "sdk" and m["params"]["name"] == "save_file"]
        self.assertEqual([m["params"]["arguments"]["file_id"] for m in saves], ["mine"])
        self.assertIn(("ipc", "prepare"), self.sequence())
        self.assertEqual(self.sequence()[-1], ("ipc", "complete"))


if __name__ == "__main__":
    unittest.main()
