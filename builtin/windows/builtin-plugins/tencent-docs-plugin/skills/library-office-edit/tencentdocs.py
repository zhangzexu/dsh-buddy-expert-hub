#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tencentdocs.py —— WorkBuddy 资料库文档 MCP 调用入口（纯 Python 标准库 / 跨平台 / 不落盘）。

行为与原 tencent-saas-docs skill 的资料库分支保持一致：
  1. 用资料库链接 nodeId 调 get-drive-token，取得 accessToken / 第三方 fileId / edition；
     沙箱走 auth-proxy，客户端走 WBIPC（见 workbuddy_library）。
  2. accessToken 以 X-Mcp-Token 透传，X-App-Id 由 edition（toc/tob）与链接域名（生产/测试）确定；
     不读取、不透传普通腾讯文档 OAuth / OneID 票据。
  3. 第三方 fileId 直接注入为目标工具的 file_id，文档 MCP 服务负责转换为内部 ID。
  4. 票据仅在内存里通过 HTTP header 即时透传，不写入任何文件；MCP 请求不跟随重定向。
  5. 4 个 MCP endpoint，按 service 名路由：library-office-edit / slide-mcp / doc-mcp / sheet-mcp

用法（供 AI Agent 调用，资料库命令前加 PYTHONPATH=）：
    PYTHONPATH= python3 tencentdocs.py tdoc_init --document-url <资料库链接>
        → READY 或 ERROR:*

    PYTHONPATH= python3 tencentdocs.py tdoc_call <service> <tool> [json_args] --document-url <资料库链接>
        --document-url 必填；脚本取票后将第三方 fileId 注入为 file_id，无需预先解析 file_id

    PYTHONPATH= python3 tencentdocs.py tdoc_list <service> --document-url <资料库链接>
        → 原样输出该 endpoint 的 tools/list JSON-RPC 响应

    PYTHONPATH= python3 tencentdocs.py tdoc_schema <service> <tool> --document-url <资料库链接>
        → 输出单个工具的描述与完整参数（inputSchema）；调用 tdoc_call 前必须先查。

可选参数：
    --no-proxy              本次请求绕过所有代理（默认走系统代理）
    --timeout <秒>          覆盖 HTTP 超时（默认取 TDOC_HTTP_TIMEOUT 或 120）
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

import workbuddy_library

# ── 端点配置：复用 SaaS 端 endpoint；主服务 service 名用于与 tencent-saas-docs skill 区分 ──
API_BASE = os.environ.get("TDOC_API_BASE_URL", "https://saas.docs.qq.com")
MAIN_SERVICE = "library-office-edit"
MCP_URLS = {
    MAIN_SERVICE: f"{API_BASE}/api/v6/open/agent/mcp",
    "slide-mcp": f"{API_BASE}/api/v6/slide/mcp",
    "doc-mcp": f"{API_BASE}/api/v6/doc/mcp",
    "sheet-mcp": f"{API_BASE}/api/v6/sheet/mcp",
}
HTTP_TIMEOUT = int(os.environ.get("TDOC_HTTP_TIMEOUT", "120"))
_SERVICE_HINT = " / ".join(MCP_URLS)
_MISSING_URL = ("library_file_id_invalid_url - 缺少资料库链接，"
                "请通过 --document-url 传入 https://www.workbuddy.cn/space/d/<nodeId>")


def _debug(msg):
    if os.environ.get("TDOC_DEBUG") == "1" or os.environ.get("WORKBUDDY_TDOC_DEBUG") == "1":
        print(f"[TencentDocsLibrary] {msg}", file=sys.stderr)


def _load_drive(document_url, no_proxy=False, timeout=10):
    """一次 get-drive-token 同时取得第三方 fileId、票据和对应环境 X-App-Id。

    返回 (drive_dict, error_str)；drive_dict 含 access_token / third_file_id / edition / app_id。
    """
    if not document_url:
        return None, _MISSING_URL
    if not workbuddy_library.is_document_url(document_url):
        return None, "library_file_id_invalid_url - 不是允许的资料库 HTTPS 域名"
    try:
        drive = workbuddy_library.load_drive_token(document_url, no_proxy, timeout, _debug)
        drive["app_id"] = workbuddy_library.get_drive_app_id(document_url, drive["edition"])
    except (workbuddy_library.TokenError, workbuddy_library.FileIDResolveError) as e:
        return None, str(e)
    return drive, None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """MCP 请求不跟随重定向，避免把资料库 token 带到其他主机。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _build_opener(no_proxy):
    """no_proxy=True 时绕过所有代理；否则走系统代理（urllib 默认读 *_PROXY 环境变量）。"""
    if no_proxy:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    return urllib.request.build_opener(_NoRedirect())


# ── 发一条 JSON-RPC 请求，返回原始响应文本（兼容 SSE） ─────────────────────────
def _post_jsonrpc(url, payload, drive, no_proxy, timeout):
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "Workbuddy Plugin",
        # 资料库 accessToken：X-Mcp-Token + X-App-Id，不进 Authorization，不叠加 Bearer / OneID。
        "X-Mcp-Token": drive["access_token"],
        "X-App-Id": drive["app_id"],
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with _build_opener(no_proxy).open(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            ctype = resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        # 与原 skill 一致：把后端原始报文带出来（stderr），便于定位 400006 等错误
        detail = ""
        try:
            detail = e.read().decode("utf-8", errors="replace")
        except (OSError, TypeError, ValueError):
            pass
        print(f"ERROR:http_failed - HTTP {e.code} {e.reason} {detail}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"ERROR:http_failed - {e.reason}", file=sys.stderr)
        return None
    except OSError as e:
        print(f"ERROR:http_failed - {e}", file=sys.stderr)
        return None
    if "text/event-stream" in ctype:
        return _extract_sse_json(raw)
    return raw


def _extract_sse_json(raw):
    """从 SSE 报文里抽取最后一条 data: 负载（MCP 流式响应的最终结果）。"""
    data_lines = [ln[len("data:"):].strip() for ln in raw.splitlines()
                  if ln.startswith("data:")]
    if not data_lines:
        return raw
    for chunk in reversed(data_lines):
        try:
            json.loads(chunk)
            return chunk
        except json.JSONDecodeError:
            continue
    return data_lines[-1]


def _resolve_url(service):
    return MCP_URLS.get(service)


def call_tool(service, tool, arguments, no_proxy=False, timeout=None, document_url=""):
    """以模块方式调用 MCP 工具；第三方 fileId 直接注入为 file_id（服务端自动转换）。

    返回 (result_dict, error_str)：成功时 error_str 为 None。
    document_url 必须是资料库原始链接；不从 arguments 中推断。
    """
    url = _resolve_url(service)
    if not url:
        return None, f"unknown_service: {service}"
    request_timeout = timeout or HTTP_TIMEOUT
    drive, err = _load_drive((document_url or "").strip(), no_proxy, min(request_timeout, 10))
    if err:
        return None, err
    prepared = dict(arguments)
    prepared["file_id"] = drive["third_file_id"]
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
               "params": {"name": tool, "arguments": prepared}}
    rsp = _post_jsonrpc(url, payload, drive, no_proxy, request_timeout)
    if rsp is None:
        return None, "http_failed"
    try:
        return json.loads(rsp), None
    except json.JSONDecodeError:
        return None, f"non_json_response: {rsp[:200]}"


def fetch_tools(service, drive, no_proxy=False, timeout=None):
    """拉取某 endpoint 的 tools/list，返回 (tools_list, error_str)。"""
    url = _resolve_url(service)
    if not url:
        return None, f"unknown_service: {service}"
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    rsp = _post_jsonrpc(url, payload, drive, no_proxy, timeout or HTTP_TIMEOUT)
    if rsp is None:
        return None, "http_failed"
    try:
        obj = json.loads(rsp)
    except json.JSONDecodeError:
        return None, f"non_json_response: {rsp[:200]}"
    if obj.get("error"):
        return None, f"jsonrpc_error: {obj['error']}"
    return (obj.get("result") or {}).get("tools", []), None


def _require_drive(args):
    """按资料库链接获取票据，失败时输出错误并返回 None。"""
    drive, err = _load_drive(args.document_url.strip(), args.no_proxy, min(args.timeout, 10))
    if err:
        print(f"ERROR:{err}")
        return None
    return drive


def _check_service(service):
    if _resolve_url(service):
        return True
    print(f"ERROR:unknown_service - 未知 service: {service}（应为 {_SERVICE_HINT}）")
    return False


# ── 主入口 A：环境检查 ────────────────────────────────────────────────────────
def cmd_init(args):
    if _require_drive(args) is None:
        return 1
    print("READY")
    return 0


# ── 主入口 B：调用工具（tools/call） ──────────────────────────────────────────
def cmd_call(args):
    if not _check_service(args.service):
        return 1
    arguments_str = args.json_args if args.json_args else "{}"
    try:
        arguments = json.loads(arguments_str)
    except json.JSONDecodeError:
        print(f"ERROR:bad_args_json - args 必须是合法的 JSON 对象字符串，收到: {arguments_str}")
        return 1
    if not isinstance(arguments, dict):
        print(f"ERROR:bad_args_json - args 必须是 JSON 对象（{{...}}），收到: {arguments_str}")
        return 1
    response, err = call_tool(args.service, args.tool, arguments, no_proxy=args.no_proxy,
                              timeout=args.timeout, document_url=args.document_url)
    if err:
        print(f"ERROR:{err}")
        return 1
    print(json.dumps(response, ensure_ascii=False))
    return 0


# ── 主入口 C：列工具（tools/list） ────────────────────────────────────────────
def cmd_list(args):
    if not _check_service(args.service):
        return 1
    drive = _require_drive(args)
    if drive is None:
        return 1
    payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    rsp = _post_jsonrpc(_resolve_url(args.service), payload, drive, args.no_proxy, args.timeout)
    if rsp is None:
        return 1
    print(rsp)
    return 0


# ── 主入口 D：查单个工具的参数定义（调用前必做） ──────────────────────────────
def cmd_schema(args):
    service, tool = args.service, args.tool
    if not _check_service(service):
        return 1
    drive = _require_drive(args)
    if drive is None:
        return 1
    tools, err = fetch_tools(service, drive, args.no_proxy, args.timeout)
    if err:
        print(f"ERROR:{err}")
        return 1
    t = next((x for x in tools if x.get("name") == tool), None)
    if t is None:
        names = ", ".join(sorted(x.get("name", "") for x in tools)[:60])
        print(f"ERROR:tool_not_found - 工具 {tool!r} 不在 {service}（可用工具名见 tdoc_list；部分：{names}）")
        return 1
    if args.raw:
        print(json.dumps(t, ensure_ascii=False, indent=2))
        return 0
    schema = t.get("inputSchema") or {}
    props = schema.get("properties") or {}
    required = set(schema.get("required") or [])
    print(f"# {t.get('name')}")
    desc = (t.get("description") or "").strip()
    if desc:
        print(f"\n{desc}")
    if not props:
        print("\n（无参数）")
    else:
        print("\n参数（✓=必填，调用前按此传参，勿猜；file_id 由资料库链接自动注入）：")
        ordered = [k for k in schema.get("required") or [] if k in props] + \
                  [k for k in props if k not in required]
        for k in ordered:
            spec = props.get(k) or {}
            typ = spec.get("type", "")
            if typ == "array" and isinstance(spec.get("items"), dict):
                typ = f"array<{spec['items'].get('type', '')}>"
            mark = "✓" if k in required else " "
            d = (spec.get("description") or "").replace("\n", " ").strip()
            print(f"  [{mark}] {k} ({typ}): {d}")
    print("\n★ 用 tdoc_call 调用时，arguments 必须严格按以上参数定义传入；"
          "需要原始 JSON Schema 加 --raw。")
    return 0


def _add_document_url_arg(parser):
    parser.add_argument(
        "--document-url", required=True,
        help="资料库原始链接 https://www.workbuddy.cn/space/d/<nodeId>；用于获取 token 并注入 file_id")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="tencentdocs.py", add_help=True,
                                 description="WorkBuddy 资料库文档 MCP 调用入口（纯 Python，跨平台）")
    ap.add_argument("--no-proxy", action="store_true", help="本次请求绕过所有代理（默认走系统代理）")
    ap.add_argument("--timeout", type=int, default=HTTP_TIMEOUT, help="HTTP 超时秒数（默认 120）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("tdoc_init", help="环境检查（资料库 token 获取）")
    _add_document_url_arg(p)
    p.set_defaults(func=cmd_init)

    p = sub.add_parser("tdoc_call", help="调用 MCP 工具（tools/call）。调用前先用 tdoc_schema 查参数，勿猜")
    p.add_argument("service", help=_SERVICE_HINT)
    p.add_argument("tool", help="工具名，如 smartcanvas.edit / slide_add_shape")
    p.add_argument("json_args", nargs="?", default="", help="工具参数 JSON 对象字符串；须按 tdoc_schema 的定义传")
    _add_document_url_arg(p)
    p.set_defaults(func=cmd_call)

    p = sub.add_parser("tdoc_list", help="列出指定 endpoint 的所有 MCP 工具（tools/list）")
    p.add_argument("service", help=_SERVICE_HINT)
    _add_document_url_arg(p)
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("tdoc_schema",
                       help="查单个工具的描述与参数定义（★ 调用 tdoc_call 前必做，按定义传参勿猜）")
    p.add_argument("service", help=_SERVICE_HINT)
    p.add_argument("tool", help="工具名，如 smartcanvas.edit / slide_add_shape")
    p.add_argument("--raw", action="store_true", help="原样输出该工具完整定义 JSON（含 inputSchema）")
    _add_document_url_arg(p)
    p.set_defaults(func=cmd_schema)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
