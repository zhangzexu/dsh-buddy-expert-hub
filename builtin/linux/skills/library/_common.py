# -*- coding: utf-8 -*-

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import sys
import urllib.parse
from typing import Any, Dict, List, Mapping, Optional, Tuple

# ---------------------------------------------------------------------------
# 运行模式
# ---------------------------------------------------------------------------

_SANDBOX_ENV_KEY = "X_IDE_IS_CLOUDSTUDIO"
_TRUE_VALUES = frozenset({"1", "true", "yes", "y", "on", "enabled"})


def is_sandbox() -> bool:
    """当前是否运行在 CodeBuddy 沙箱内。"""
    return os.environ.get(_SANDBOX_ENV_KEY, "").strip().lower() in _TRUE_VALUES


# ---------------------------------------------------------------------------
# Endpoint 与 base 状态
# ---------------------------------------------------------------------------

_SANDBOX_BASE = "http://spaceengine.agent-gateway.auth-proxy.local"
# 沙箱经 agent-gateway 转发，需在 SpaceEngine 原路径前加内部前缀
_SANDBOX_PATH_PREFIX = "/_internal/spaceengine"


USER_AGENT = f"library-skills/{os.environ.get('KS_SKILL_VERSION', '0.1.0')}"

# ---------------------------------------------------------------------------
# 脱敏
# ---------------------------------------------------------------------------

def redact(text: Any) -> str:
    """输出前的统一归一化出口。

    脚本进程内不再持有任何凭证（客户端由宿主通道注入、沙箱由 auth-proxy 注入），
    这里只负责把任意对象安全地转成字符串；具体的敏感内容裁剪在
    `_safe_backend_message()` 里做。
    """
    try:
        return text if isinstance(text, str) else str(text)
    except Exception:
        return "[REDACTED]"


# ---------------------------------------------------------------------------
# HTTP 错误类型
# ---------------------------------------------------------------------------

class HttpError(Exception):
    """HTTP / 业务层错误。"""

    def __init__(self, message: str, *, error_code: Any = "UNKNOWN",
                 backend_message: Any = "", traceid: Optional[str] = None) -> None:
        super().__init__(message)
        self.error_code = _safe_error_code(error_code)
        self.backend_message = _safe_backend_message(backend_message)
        self.traceid = traceid

    def __str__(self) -> str:
        if self.backend_message:
            return f"code={self.error_code}; msg={self.backend_message}"
        return f"code={self.error_code}"


class HttpResponse(dict):
    """JSON 响应体 dict，附带 traceid。"""

    def __init__(self, payload: Mapping[str, Any], *, traceid: Optional[str] = None) -> None:
        super().__init__(payload)
        self.traceid = traceid


# ---------------------------------------------------------------------------
# HTTP 辅助
# ---------------------------------------------------------------------------

def _header_value(value: Any) -> str:
    if isinstance(value, (list, tuple)):
        value = next((item for item in value if item is not None), None)
    return "" if value is None else str(value).strip()


# wbipc 响应头白名单里没有 traceid，只有 x-request-id
_TRACEID_HEADERS: Tuple[str, ...] = ("traceid", "x-request-id")


def _extract_traceid(headers: Any) -> Optional[str]:
    """从响应 headers 取 traceid。"""
    if not headers:
        return None
    try:
        items = [(str(k).lower(), v) for k, v in headers.items()]
    except Exception:
        return None
    for name in _TRACEID_HEADERS:
        for key, value in items:
            if key == name:
                val = _header_value(value)
                if val:
                    return val
    return None


def _safe_error_code(value: Any) -> str:
    text = str(value if value is not None else "UNKNOWN").strip()
    if not text or len(text) > 64:
        return "UNKNOWN"
    if not all(ch.isalnum() or ch in "_.-" for ch in text):
        return "UNKNOWN"
    return text


def _safe_backend_message(value: Any) -> str:
    if value is None:
        return ""
    text = redact(value).strip()
    if not text:
        return ""
    if "Traceback (most recent call last)" in text or "goroutine " in text:
        return "[INTERNAL_DETAIL_REDACTED]"
    text = re.sub(r"https?://\S+", "[URL_REDACTED]", text, flags=re.I)
    text = re.sub(
        r"(?i)(?:bearer\s+|(?:token|cookie)\s*[:=]\s*|authorization\s*[:=]\s*(?:bearer\s+)?|x-skill-token\s*[:=]\s*)\S+",
        "[CREDENTIAL_REDACTED]", text)
    text = re.sub(r"(?i)\b(?:request_?id|trace_?id)\s*[:=]\s*\S+", "[ID_REDACTED]", text)
    text = re.sub(r"(?i)\b(?:request|body|payload)\s*[:=].*$", "[REQUEST_BODY_REDACTED]", text)
    text = re.sub(r"\{.*\}", "[REQUEST_BODY_REDACTED]", text, flags=re.S)
    text = re.sub(r"(?:/Users|/home|/var|[A-Za-z]:\\)\S+", "[PATH_REDACTED]", text)
    return " ".join(text.split())[:256]


def _read_http_error_meta(error: urllib.error.HTTPError) -> Tuple[Any, str]:
    """从 HTTPError 响应体提取 code/msg。"""
    try:
        payload = json.loads(error.read(65537).decode("utf-8"))
    except Exception:
        return f"HTTP_{error.code}", ""
    if not isinstance(payload, Mapping):
        return f"HTTP_{error.code}", ""
    code = payload.get("code", payload.get("retcode"))
    msg = payload.get("msg", payload.get("message", ""))
    if code in (None, 0, "0", "OK", "ok"):
        code = f"HTTP_{error.code}"
    return code, _safe_backend_message(msg)


# ---------------------------------------------------------------------------
# HTTP 调用
# ---------------------------------------------------------------------------

_OK_CODES: Tuple[Any, ...] = (0, "0", "OK", "ok")


# ---------------------------------------------------------------------------
# 客户端模式：WBIPC 宿主通道转发
# ---------------------------------------------------------------------------

_WBIPC_PIPE = "wb.request"
_WBIPC_METHOD = "http.fetch"
_WBIPC_CODE_MAP = {
    "E_TIMEOUT": "TEMPORARY_ERROR",
    "E_REVOKED": "TEMPORARY_ERROR",
    "E_INTERNAL": "TEMPORARY_ERROR",
    "E_UPSTREAM": "TEMPORARY_ERROR",
    "E_BUSY": "TEMPORARY_ERROR",
    "E_CANCELLED": "TEMPORARY_ERROR",
    "E_BAD_REQUEST": "INVALID_PARAMS",
    "E_NOT_CONNECTED": "AUTH_REQUIRED",
    "E_POLICY_DENIED": "AUTH_REQUIRED",
}

_wbipc_client: Any = None   # 持引用防 GC 关闭 socket
_wbipc_pipe: Any = None
_wbipc_method: str = ""
_wbipc_failure: Optional[HttpError] = None


def _wbipc_channel() -> Tuple[Any, str]:
    """返回 (pipe, ipc_method)；只探测一次，拿不到通道抛 HttpError，不降级直连。"""
    global _wbipc_client, _wbipc_pipe, _wbipc_method, _wbipc_failure
    if _wbipc_pipe is not None:
        return _wbipc_pipe, _wbipc_method
    if _wbipc_failure is not None:
        raise _wbipc_failure

    try:
        pipe, method, client = _wbipc_open()
    except HttpError as e:
        _wbipc_failure = e
        raise

    _wbipc_client, _wbipc_pipe, _wbipc_method = client, pipe, method
    return pipe, method


def _wbipc_open() -> Tuple[Any, str, Any]:
    """连接宿主并绑定 pipe；失败统一转 HttpError。"""
    try:
        from workbuddy_ipc import (  # type: ignore
            ConsentRequired, EndpointUntrusted, NotWorkBuddyEnv, WbipcError, connect,
        )
    except ImportError as e:
        raise HttpError(
            "workbuddy_ipc unavailable", error_code="E_NOT_WORKBUDDY",
            backend_message="缺少 workbuddy_ipc 模块，无法接入宿主通道；请在 WorkBuddy 客户端内运行",
        ) from e

    try:
        client = connect(client_id="library-skills", client_kind="skill")
    except NotWorkBuddyEnv as e:
        raise HttpError(
            "not running inside workbuddy", error_code="E_NOT_WORKBUDDY",
            backend_message="未连接到 WorkBuddy 客户端宿主通道；请在客户端内运行并确认已登录",
        ) from e
    except EndpointUntrusted as e:
        raise HttpError(
            "wbipc endpoint untrusted", error_code="E_ENDPOINT_UNTRUSTED",
            backend_message="宿主 IPC 端点无法自证身份（可能被抢占），已中止请求",
        ) from e
    except ConsentRequired as e:
        raise HttpError(
            "wbipc consent required", error_code="E_CONSENT_REQUIRED",
            backend_message="请在 WorkBuddy 客户端完成授权后重试",
        ) from e
    except WbipcError as e:
        raise _wbipc_error(e) from e
    except Exception as e:
        raise HttpError("wbipc connect failed", error_code="TEMPORARY_ERROR") from e

    try:
        # 能力靠运行时发现：没公布就是当前用不了，不 try/except 硬探测
        if _WBIPC_PIPE not in (getattr(client, "pipes", None) or []):
            raise HttpError(
                "wbipc pipe unavailable", error_code="AUTH_REQUIRED",
                backend_message=f"宿主未开放 {_WBIPC_PIPE} 通道；请确认已在 WorkBuddy 客户端登录并授权",
            )
        pipe = client.get_pipe(_WBIPC_PIPE)
        if _WBIPC_METHOD not in (getattr(pipe, "methods", None) or []):
            raise HttpError(
                "wbipc forward method unavailable", error_code="E_METHOD_UNKNOWN",
                backend_message=f"{_WBIPC_PIPE} 未提供 {_WBIPC_METHOD} 方法；请升级 WorkBuddy 客户端",
            )
    except HttpError:
        _wbipc_close(client)
        raise
    except ConsentRequired as e:
        _wbipc_close(client)
        raise HttpError(
            "wbipc consent required", error_code="E_CONSENT_REQUIRED",
            backend_message="请在 WorkBuddy 客户端完成授权后重试",
        ) from e
    except WbipcError as e:
        _wbipc_close(client)
        raise _wbipc_error(e) from e
    except Exception as e:
        _wbipc_close(client)
        raise HttpError("wbipc bind pipe failed", error_code="TEMPORARY_ERROR") from e

    return pipe, _WBIPC_METHOD, client


def _wbipc_close(client: Any) -> None:
    try:
        client.close()
    except Exception:
        pass


def _invalid(message: str, hint: str = "") -> HttpError:
    return HttpError(message, error_code="INVALID_PARAMS", backend_message=hint)


def _wbipc_headers(extra_headers: Optional[Mapping[str, str]],
                   has_body: bool) -> Dict[str, str]:
    headers: Dict[str, str] = {"accept": "*/*"}
    if has_body:
        headers["content-type"] = "application/json"
    for k, v in (extra_headers or {}).items():
        if k and v is not None:
            headers[str(k).strip().lower()] = str(v)
    return headers


def _wbipc_query(url_query: str, params: Optional[Mapping[str, Any]]) -> Dict[str, str]:
    """构造 {str: str} 的 query。

    宿主每键只收一个字符串值，多值参数与重名键在此模型里无法表达；
    悄悄丢一个值会变成难查的数据错，所以这两种情况直接报参数错。
    """
    out: Dict[str, str] = {}
    pairs: List[Tuple[Any, Any]] = []
    if url_query:
        pairs.extend(urllib.parse.parse_qsl(url_query, keep_blank_values=True))
    pairs.extend((k, v) for k, v in (params or {}).items() if v is not None)

    for key, value in pairs:
        if isinstance(value, (list, tuple, set, dict)):
            raise _invalid("query value must be scalar", "宿主通道的 query 不支持多值参数")
        name = str(key)
        if name in out:
            raise _invalid("duplicate query key")
        out[name] = str(value)
    return out


def _wbipc_error(err: Any) -> HttpError:
    """WbipcError -> HttpError；未映射的 code 原样透出，data.hint 优先于 message。"""
    data = getattr(err, "data", None)
    data = data if isinstance(data, Mapping) else {}
    hint = _header_value(data.get("hint"))
    return HttpError(
        "wbipc request rejected",
        error_code=_WBIPC_CODE_MAP.get(getattr(err, "code", ""), getattr(err, "code", "E_INTERNAL")),
        backend_message=hint or getattr(err, "message", ""),
        traceid=_header_value(data.get("traceid", data.get("traceId"))) or None,
    )


def _wbipc_http_request(
    http_method: str, url: str, *,
    params: Optional[Mapping[str, Any]] = None,
    body: Optional[Mapping[str, Any]] = None,
    timeout: float = 30.0,
    extra_headers: Optional[Mapping[str, str]] = None,
) -> HttpResponse:
    """交给宿主代发；只传 path/query，host 与鉴权由宿主决定。

    method / path / headers 的合法性由宿主 request-pipe 裁决（非法一律
    E_BAD_REQUEST），这里不复刻它的规则。
    """
    pipe, ipc_method = _wbipc_channel()

    parts = urllib.parse.urlsplit(url)
    request: Dict[str, Any] = {
        "method": http_method.upper(),
        "path": parts.path or "/",
        "headers": _wbipc_headers(extra_headers, body is not None),
    }
    query = _wbipc_query(parts.query, params)
    if query:
        request["query"] = query
    if body is not None:
        try:
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError) as e:
            raise _invalid("invalid body") from e
        request["body_b64"] = base64.b64encode(raw).decode("ascii")

    from workbuddy_ipc import WbipcError  # type: ignore

    try:
        result = pipe.invoke(ipc_method, request, timeout=float(timeout) + 5.0)
    except WbipcError as e:
        raise _wbipc_error(e) from e
    except Exception as e:
        raise HttpError("wbipc request failed", error_code="TEMPORARY_ERROR") from e

    return _wbipc_response(result)


def _wbipc_body(b64: Any, traceid: Optional[str]) -> Any:
    """base64 -> utf-8 -> JSON；空体（204 等）当空对象。"""
    if not b64:
        return {}
    try:
        return json.loads(base64.b64decode(b64, validate=True).decode("utf-8"))
    except (TypeError, binascii.Error, ValueError, UnicodeDecodeError) as e:
        raise HttpError("json parse failed", error_code="INVALID_RESPONSE",
                        traceid=traceid) from e


def _wbipc_response(result: Any) -> HttpResponse:
    """解析 http.fetch 的 {status, headers, body_b64}。"""
    if not isinstance(result, Mapping) or "body_b64" not in result:
        raise HttpError("invalid wbipc result", error_code="INVALID_RESPONSE")

    try:
        status = int(result.get("status"))
    except (TypeError, ValueError) as e:
        raise HttpError("invalid wbipc status", error_code="INVALID_RESPONSE") from e
    traceid = _extract_traceid(result.get("headers"))
    payload = _wbipc_body(result.get("body_b64"), traceid)

    if not (200 <= status < 300):
        code: Any = f"HTTP_{status}"
        msg = ""
        if isinstance(payload, Mapping):
            biz = payload.get("code", payload.get("retcode"))
            if biz is not None and biz not in _OK_CODES:
                code = biz
            msg = payload.get("msg", payload.get("message", ""))
        raise HttpError("http request rejected", error_code=code,
                        backend_message=msg, traceid=traceid)

    if not isinstance(payload, Mapping):
        raise HttpError("json payload is not object", error_code="INVALID_RESPONSE",
                        traceid=traceid)

    response = HttpResponse(payload, traceid=traceid)
    biz_code = response.get("code", response.get("retcode"))
    if biz_code is not None and biz_code not in _OK_CODES:
        raise HttpError("business request rejected", error_code=biz_code,
                        backend_message=response.get("msg", response.get("message", "")),
                        traceid=traceid)
    return response


def _do_http_request(
    method: str, url: str, *,
    params: Optional[Mapping[str, Any]] = None,
    body: Optional[Mapping[str, Any]] = None,
    timeout: float = 30.0,
    extra_headers: Optional[Mapping[str, str]] = None,
) -> HttpResponse:
    """沙箱模式单次 HTTP 请求（身份由 auth-proxy 注入），不做 fallback。"""
    import ssl
    import urllib.error
    import urllib.request

    if not url:
        raise HttpError("missing url", error_code="INVALID_PARAMS")

    full_url = url
    if params:
        qs = urllib.parse.urlencode(
            {k: v for k, v in params.items() if v is not None}, doseq=True)
        if qs:
            full_url = f"{full_url}{'&' if '?' in full_url else '?'}{qs}"

    headers: Dict[str, str] = {
        "Accept": "*/*", "Accept-Language": "zh-CN", "User-Agent": USER_AGENT,
    }
    data: Optional[bytes] = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        try:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        except (TypeError, ValueError) as e:
            raise HttpError("invalid body", error_code="INVALID_PARAMS") from e
    if extra_headers:
        for k, v in extra_headers.items():
            if k and v is not None:
                headers[str(k)] = str(v)

    req = urllib.request.Request(full_url, data=data, method=method.upper(), headers=headers)
    ctx = (ssl._create_unverified_context() if os.environ.get("KS_SSL_INSECURE") == "1"
           else ssl.create_default_context())

    traceid: Optional[str] = None
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            status = getattr(resp, "status", 200)
            resp_headers = getattr(resp, "headers", None)
            if not resp_headers:
                try:
                    resp_headers = resp.info()
                except Exception:
                    resp_headers = None
            traceid = _extract_traceid(resp_headers)
            raw = resp.read()
    except urllib.error.HTTPError as e:
        traceid = _extract_traceid(getattr(e, "headers", None))
        ec, msg = _read_http_error_meta(e)
        raise HttpError("http request rejected", error_code=ec,
                        backend_message=msg, traceid=traceid) from e
    except urllib.error.URLError as e:
        raise HttpError("network error", error_code="NETWORK_ERROR") from e
    except Exception as e:
        raise HttpError("request failed", error_code="TEMPORARY_ERROR", traceid=traceid) from e

    if not (200 <= status < 300):
        raise HttpError("http request rejected", error_code=f"HTTP_{status}", traceid=traceid)

    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise HttpError("json parse failed", error_code="INVALID_RESPONSE", traceid=traceid) from e
    if not isinstance(payload, Mapping):
        raise HttpError("json payload is not object", error_code="INVALID_RESPONSE", traceid=traceid)

    response = HttpResponse(payload, traceid=traceid)
    biz_code = response.get("code", response.get("retcode"))
    if biz_code is not None and biz_code not in _OK_CODES:
        raise HttpError("business request rejected", error_code=biz_code,
                        backend_message=response.get("msg", response.get("message", "")),
                        traceid=traceid)
    return response


def http_request(
    method: str, path: str, *,
    params: Optional[Mapping[str, Any]] = None,
    body: Optional[Mapping[str, Any]] = None,
    timeout: float = 30.0,
    extra_headers: Optional[Mapping[str, str]] = None,
) -> Dict[str, Any]:
    if not path.startswith("/"):
        path = "/" + path
    kwargs = dict(params=params, body=body, timeout=timeout, extra_headers=extra_headers)

    if not is_sandbox():
        return _wbipc_http_request(method, path, **kwargs)

    url = _SANDBOX_BASE + _SANDBOX_PATH_PREFIX + path
    return _do_http_request(method, url, **kwargs)


# ---------------------------------------------------------------------------
# 响应解包
# ---------------------------------------------------------------------------

def unwrap_data(envelope: Mapping[str, Any]) -> Dict[str, Any]:
    """从 {code, msg, data} 信封中取出 data；非成功抛 HttpError。"""
    traceid = getattr(envelope, "traceid", None)
    if not isinstance(envelope, Mapping):
        raise HttpError("invalid envelope", error_code="INVALID_RESPONSE", traceid=traceid)
    code = envelope.get("code", envelope.get("retcode"))
    if code not in _OK_CODES:
        raise HttpError("business request rejected", error_code=code,
                        backend_message=envelope.get("msg", envelope.get("message", "")),
                        traceid=traceid)
    data = envelope.get("data") or envelope.get("result", {}) or {}
    if not isinstance(data, Mapping):
        raise HttpError("data is not object", error_code="INVALID_RESPONSE", traceid=traceid)
    return dict(data)


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------

def safe_print(line: str) -> None:
    """stdout 唯一出口；自动 redact。"""
    try:
        sys.stdout.write(redact(line))
        if not line.endswith("\n"):
            sys.stdout.write("\n")
    except Exception:
        pass


def emit_user_reply(reply: str) -> None:
    """输出脚本产出的最终用户回执，供上层原样透传。"""
    safe_print(f"KS_USER_REPLY\t{reply}")


def build_review_submit_user_reply(affected_count: int, anchor_url: str) -> str:
    """构造审阅式编辑成功回执；有锚点时必须返回完整 anchor URL。"""
    n = max(int(affected_count), 0)
    if anchor_url:
        return f"已生成 {n} 处修订建议，需在审阅栏接受后才会落入正文，点击查看并接受/拒绝：{anchor_url}"
    return f"已生成 {n} 处修订建议，需在审阅栏接受后才会落入正文；请在文档右侧审阅栏逐条查看并接受/拒绝。"


def build_direct_edit_user_reply(affected_count: int, anchor_url: str) -> str:
    """构造直接编辑成功回执；有锚点时必须返回完整 anchor URL。"""
    n = max(int(affected_count), 0)
    if anchor_url:
        return f"已完成 {n} 处直接编辑，已即时落入正文，无需审阅；点击查看：{anchor_url}"
    return f"已完成 {n} 处直接编辑，已即时落入正文，无需审阅；请在文档中查看。"


def error_exit(message: str, code: int = 0, traceid: Optional[str] = None) -> "None":
    """输出结构化错误 JSON 后退出。"""
    payload: Dict[str, str] = {"error": redact(message)}
    if traceid:
        payload["traceid"] = redact(traceid)
    safe_print(json.dumps(payload, ensure_ascii=False))
    try:
        sys.stdout.flush()
    except Exception:
        pass
    sys.exit(code)


__all__ = [
    "USER_AGENT",
    "HttpError", "HttpResponse",
    "http_request", "unwrap_data",
    "redact", "safe_print", "emit_user_reply",
    "build_review_submit_user_reply", "build_direct_edit_user_reply",
    "error_exit",
]
