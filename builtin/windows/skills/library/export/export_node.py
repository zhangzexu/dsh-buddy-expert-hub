#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
export/export_node.py —— 把 doc / database / web 节点导出成文件。

完整链路：
    1. kind 未传时 POST /space/api/agent/v1/node-info 取节点真实类型
    2. POST /space/api/agent/v1/export-node 提交异步导出，拿到 taskId
    3. 轮询 POST /space/api/agent/v1/query-export-progress 直到 done 或 failed
    4. done 且传入 --out 时，把 cosUrl 下载到本地。只接受 COS https 域名，
       连之前核对解析出的公网 IP，重定向逐跳重做这两步
    5. 成功 → stdout `KS_NODE_EXPORT <json>`，再一行 KS_USER_REPLY；exit 0
       失败 → stdout 单行 {"error":"..."} 后 exit 0

用法：
    python3 export/export_node.py --node-id <blk_xxx> [--kind doc|database|web] [--time-zone Asia/Shanghai] [--out <path>]

约定：
    - 只导出 doc→md、database→csv、web→html；带图片或附件时文件名以 .zip 结尾
    - drive / smh / link / folder 不走本脚本
    - 轮询在脚本内完成，调用方不要自己打 export-node
    - download_url 约 15 分钟有效；KS_USER_REPLY 不展开签名 URL
"""

from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Sequence, Tuple

_LIB_DIR = Path(__file__).resolve().parents[1]
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

from _common import (  # noqa: E402
    USER_AGENT,
    HttpError,
    emit_user_reply,
    error_exit,
    http_request,
    safe_print,
    unwrap_data,
)

_PATH_NODE_INFO = "/space/api/agent/v1/node-info"
_PATH_EXPORT = "/space/api/agent/v1/export-node"
_PATH_PROGRESS = "/space/api/agent/v1/query-export-progress"

_SPACE_D_RE = re.compile(r"/space/d/([^/?#]+)")
_PUBLISH_P_RE = re.compile(r"/p/([^/?#]+)")
_UNSAFE_NAME = re.compile(r'[\x00-\x1f<>:"|?*\\/]')

# 服务端任务超时默认 10 分钟；客户端多留 1 分钟接终态。
_POLL_TIMEOUT_S = 11 * 60
_POLL_INTERVAL_S = 2.0
_DOWNLOAD_TIMEOUT_S = 300
_MAX_DOWNLOAD_REDIRECTS = 3
_MAX_DOWNLOAD_URL_LEN = 8192

# 导出产物的预签名地址是 COS 桶域名，不是任意 https。
# 形如 <bucket>.cos.<region>.myqcloud.com / *.tencentcos.cn。
# 不放行 *.myqcloud.com 整域，也不放行 cos-internal / 内网 endpoint。
_COS_HOST_SUFFIXES = (".myqcloud.com", ".tencentcos.cn")
_COS_LABEL_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_REDIRECT_STATUSES = (301, 302, 303, 307, 308)

# 回环、私网、链路本地（含 169.254.169.254）、CGNAT、组播、保留、隧道地址。
# 显式写网段，避免不同 Python 版本对 is_private 的口径不一致。
_BLOCKED_V4 = (
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("192.0.2.0/24"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
    ipaddress.ip_network("224.0.0.0/4"),
    ipaddress.ip_network("240.0.0.0/4"),
)
_BLOCKED_V6 = (
    ipaddress.ip_network("::/128"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("fec0::/10"),
    ipaddress.ip_network("ff00::/8"),
    ipaddress.ip_network("2001::/32"),       # Teredo
    ipaddress.ip_network("2001:db8::/32"),   # 文档网段
    ipaddress.ip_network("2002::/16"),       # 6to4
    ipaddress.ip_network("64:ff9b::/96"),    # NAT64
    ipaddress.ip_network("64:ff9b:1::/48"),  # 本地 NAT64
)

_EXPORT_KINDS = {
    "doc": "doc",
    "database": "database",
    "web": "web",
    "page": "web",
}
_KIND_REDIRECT = {
    "drive": "kind=drive 不能走节点导出，请改用 drive/get_download_link.py",
    "smh": "kind=smh 不能走节点导出，请改用 smh/get_download_link.py",
    "link": "kind=link 不能导出为文件，请用 link 模块读取正文",
    "folder": "文件夹不能导出",
}
_FILE_TYPE_EXT = {"md": ".md", "csv": ".csv", "html": ".html"}


def normalize_node_id(raw: str) -> str:
    """裸 nodeId，或从 /space/d/{id}、/p/{id} 链接里取出 id。"""
    value = (raw or "").strip()
    if not value:
        return ""
    matched = _SPACE_D_RE.search(value)
    if matched:
        return matched.group(1).strip()
    matched = _PUBLISH_P_RE.search(value)
    if matched:
        return matched.group(1).strip()
    return value


def classify_kind(kind: str) -> Tuple[str, str]:
    """返回 (api_kind, error)。可导出时 error 为空。"""
    key = (kind or "").strip().lower()
    if key in _EXPORT_KINDS:
        return _EXPORT_KINDS[key], ""
    if key in _KIND_REDIRECT:
        return "", _KIND_REDIRECT[key]
    shown = kind.strip() if isinstance(kind, str) and kind.strip() else "空"
    return "", "不支持导出的节点类型: %s" % shown


def safe_export_file_name(name: str, file_type: str) -> str:
    """只用文件名本身，去掉路径和非法字符。"""
    base = (name or "").replace("\\", "/").split("/")[-1].strip().rstrip(".")
    base = _UNSAFE_NAME.sub("_", base).strip()
    if base in ("", ".", ".."):
        return "export" + _FILE_TYPE_EXT.get((file_type or "").strip().lower(), "")
    return base


def normalize_msys_path(raw: str) -> str:
    """Git Bash 的 /c/Users/... 在 Windows 上要先转成 C:/Users/...。"""
    if sys.platform == "win32" and len(raw) >= 3 and raw[0] == "/" and raw[1].isalpha() and raw[2] == "/":
        return raw[1] + ":" + raw[2:]
    return raw


def resolve_out_path(out: str, file_name: str) -> Path:
    """--out 以分隔符结尾或已是目录时，在目录下使用服务端文件名。"""
    raw = normalize_msys_path((out or "").strip())
    path = Path(raw)
    if raw.endswith(("/", "\\")) or (path.exists() and path.is_dir()):
        return (path / file_name).resolve()
    return path.resolve()


def wait_export(
    fetch: Callable[[], Mapping[str, object]],
    *,
    timeout_s: float,
    interval_s: float,
    sleep_fn: Callable[[float], None],
    monotonic: Callable[[], float],
) -> Dict[str, object]:
    """轮询到 done / failed。未知状态立即失败，超时抛 TimeoutError。"""
    deadline = monotonic() + timeout_s
    while True:
        data = dict(fetch())
        status = str(data.get("status") or "").strip()
        if status in ("done", "failed"):
            return data
        if status not in ("pending", "running"):
            raise ValueError(status or "empty")
        if monotonic() >= deadline:
            raise TimeoutError("export poll timed out")
        sleep_fn(interval_s)


def _lookup_kind(node_id: str) -> str:
    try:
        data = unwrap_data(http_request(
            "POST", _PATH_NODE_INFO, body={"nodeId": node_id}, timeout=15.0))
    except HttpError as exc:
        error_exit("查询节点信息失败: %s" % exc)
    node = data.get("node") if isinstance(data, Mapping) else None
    if not isinstance(node, Mapping):
        error_exit("查询节点信息失败: code=INVALID_RESPONSE; msg=缺少 node")
    return str(node.get("kind") or "")


def _submit(node_id: str, kind: str, time_zone: str) -> str:
    body = {"nodeId": node_id, "kind": kind}
    if time_zone:
        body["timeZone"] = time_zone
    try:
        data = unwrap_data(http_request("POST", _PATH_EXPORT, body=body, timeout=20.0))
    except HttpError as exc:
        error_exit("提交导出失败: %s" % exc)
    task_id = str(data.get("taskId") or "").strip()
    if not task_id:
        error_exit("提交导出失败: code=50000; msg=导出服务暂不可用，请稍后重试")
    return task_id


def _poll(task_id: str) -> Dict[str, object]:
    def fetch() -> Mapping[str, object]:
        try:
            return unwrap_data(http_request(
                "POST", _PATH_PROGRESS, body={"taskId": task_id}, timeout=15.0))
        except HttpError as exc:
            error_exit("查询导出进度失败: %s" % exc)

    try:
        return wait_export(
            fetch,
            timeout_s=_POLL_TIMEOUT_S,
            interval_s=_POLL_INTERVAL_S,
            sleep_fn=time.sleep,
            monotonic=time.monotonic,
        )
    except TimeoutError:
        error_exit("查询导出进度失败: code=50000; msg=导出超时，请重试")
    except ValueError as exc:
        error_exit("查询导出进度失败: code=INVALID_RESPONSE; msg=未知状态 %s" % exc)


def _fail_code(value: object) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


class _UnsafeDownloadURL(Exception):
    """下载地址未通过域名或目的地校验。错误信息不能带 host，避免变成探测回显。"""


def _cos_host_allowed(host: str) -> bool:
    """只接受带 cos 标签的桶域名。IP、后缀仿冒、cos-internal 都不算。"""
    name = (host or "").lower().rstrip(".")
    if not name or len(name) > 253 or ".." in name:
        return False
    try:
        ipaddress.ip_address(name)
        return False
    except ValueError:
        pass
    suffix = next((item for item in _COS_HOST_SUFFIXES if name.endswith(item) and len(name) > len(item)), "")
    if not suffix:
        return False
    labels = name[: -len(suffix)].split(".")
    if "cos" not in labels:
        return False
    for label in labels:
        if label == "cos-internal" or not _COS_LABEL_RE.fullmatch(label):
            return False
    return True


def _parse_export_download_url(url: str) -> urllib.parse.SplitResult:
    """https、无 userinfo、端口仅 443、host 在 COS 白名单。失败抛 _UnsafeDownloadURL。"""
    if not isinstance(url, str):
        raise _UnsafeDownloadURL()
    raw = url.strip()
    if not raw or len(raw) > _MAX_DOWNLOAD_URL_LEN or any(ord(ch) < 33 or ord(ch) == 127 for ch in raw):
        raise _UnsafeDownloadURL()
    try:
        parts = urllib.parse.urlsplit(raw)
        port = parts.port
        host = parts.hostname
    except ValueError:
        raise _UnsafeDownloadURL() from None
    if parts.scheme != "https" or parts.username or parts.password:
        raise _UnsafeDownloadURL()
    netloc = parts.netloc or ""
    if not host or port not in (None, 443) or "%" in netloc or "@" in netloc:
        raise _UnsafeDownloadURL()
    if not _cos_host_allowed(host):
        raise _UnsafeDownloadURL()
    return parts


def _address_blocked(ip: ipaddress._BaseAddress) -> bool:
    """实际要连接的地址。IPv4-mapped 先拆成 IPv4 再判。"""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return _address_blocked(ip.ipv4_mapped)
    if (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return True
    nets: Sequence[ipaddress._BaseNetwork] = _BLOCKED_V4 if ip.version == 4 else _BLOCKED_V6
    return any(ip in net for net in nets)


def _pinned_public_ip(host: str, resolve_fn: Callable[..., Sequence[tuple]]) -> str:
    """解析全部地址。任一落在禁止网段就拒绝；返回的地址就是随后要连接的地址。"""
    try:
        infos = resolve_fn(host, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise OSError("dns failed") from exc
    ips: List[str] = []
    for item in infos:
        sockaddr = item[4]
        if not sockaddr:
            continue
        ip = sockaddr[0]
        if isinstance(ip, str) and "%" in ip:
            ip = ip.split("%", 1)[0]
        ips.append(ip)
    if not ips:
        raise _UnsafeDownloadURL()
    for ip in ips:
        try:
            parsed = ipaddress.ip_address(ip)
        except ValueError:
            raise _UnsafeDownloadURL() from None
        if _address_blocked(parsed):
            raise _UnsafeDownloadURL()
    return ips[0]


def _request_target(parts: urllib.parse.SplitResult) -> str:
    path = parts.path or "/"
    if parts.query:
        return path + "?" + parts.query
    return path


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """TCP 连到已校验的 IP，SNI 和证书校验仍用原始 COS 域名。"""

    def __init__(self, host: str, port: int, pin_ip: str, timeout: float) -> None:
        context = ssl.create_default_context()
        super().__init__(host, port, timeout=timeout, context=context)
        self._pin_ip = pin_ip
        self._pin_context = context

    def connect(self) -> None:
        raw = socket.create_connection((self._pin_ip, self.port), self.timeout)
        try:
            self.sock = self._pin_context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


def _fetch_pinned(hostname: str, port: int, ip: str, target: str) -> http.client.HTTPResponse:
    conn = _PinnedHTTPSConnection(hostname, port, ip, _DOWNLOAD_TIMEOUT_S)
    try:
        conn.request("GET", target, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
        return conn.getresponse()
    except Exception:
        conn.close()
        raise


def _save_response(dest: Path, read: Callable[[int], bytes]) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    try:
        with open(tmp, "wb") as handle:
            while True:
                chunk = read(256 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
        tmp.replace(dest)
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def _download(
    url: str,
    dest: Path,
    *,
    resolve_fn: Callable[..., Sequence[tuple]] = socket.getaddrinfo,
    fetch_fn: Optional[Callable[..., http.client.HTTPResponse]] = None,
) -> None:
    """下载 cosUrl。不使用 urllib 的自动重定向：每一跳重新做域名和 IP 校验。"""
    fetch = fetch_fn or _fetch_pinned
    current = url
    try:
        for hop in range(_MAX_DOWNLOAD_REDIRECTS + 1):
            target = _parse_export_download_url(current)
            ip = _pinned_public_ip(target.hostname or "", resolve_fn)
            resp = fetch(target.hostname or "", target.port or 443, ip, _request_target(target))
            try:
                status = getattr(resp, "status", 0)
                if status in _REDIRECT_STATUSES:
                    if hop >= _MAX_DOWNLOAD_REDIRECTS:
                        raise _UnsafeDownloadURL()
                    location = resp.getheader("Location") if hasattr(resp, "getheader") else None
                    if not location or not str(location).strip():
                        raise _UnsafeDownloadURL()
                    current = urllib.parse.urljoin(current, str(location).strip())
                    continue
                if not (200 <= int(status) < 300):
                    error_exit("保存导出文件失败: code=HTTP_%s; msg=下载失败" % status)
                _save_response(dest, resp.read)
                return
            finally:
                close = getattr(resp, "close", None)
                if close:
                    close()
    except _UnsafeDownloadURL:
        error_exit("保存导出文件失败: code=INVALID_RESPONSE; msg=下载地址无效")
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException, ssl.SSLError):
        error_exit("保存导出文件失败: code=NETWORK_ERROR; msg=导出文件已生成，但保存到本地失败")


def _receipt(file_name: str, saved: bool) -> str:
    zipped = file_name.lower().endswith(".zip")
    if zipped and saved:
        return "已导出「%s」（含图片或附件，需解压）。" % file_name
    if zipped:
        return "已导出「%s」（含图片或附件，需解压）。下载链接约 15 分钟内有效，请尽快保存。" % file_name
    if saved:
        return "已导出「%s」。" % file_name
    return "已导出「%s」。下载链接约 15 分钟内有效，请尽快保存。" % file_name


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--node-id", dest="node_id", default="")
    parser.add_argument("--kind", dest="kind", default="")
    parser.add_argument("--time-zone", dest="time_zone", default="")
    parser.add_argument("--out", dest="out", default="")
    try:
        args, _unknown = parser.parse_known_args()
    except SystemExit:
        error_exit("参数解析失败")

    node_id = normalize_node_id(args.node_id)
    if not node_id:
        error_exit("--node-id 必填")

    kind_raw = (args.kind or "").strip()
    if not kind_raw:
        kind_raw = _lookup_kind(node_id)
    api_kind, kind_err = classify_kind(kind_raw)
    if kind_err:
        error_exit("提交导出失败: code=11607; msg=%s" % kind_err)

    time_zone = (args.time_zone or "").strip()
    task_id = _submit(node_id, api_kind, time_zone)
    data = _poll(task_id)
    status = str(data.get("status") or "").strip()
    if status == "failed":
        code = _fail_code(data.get("failCode")) or 50000
        reason = str(data.get("failReason") or "").strip() or "导出失败，请重试"
        error_exit("导出失败: code=%s; msg=%s" % (code, reason))

    file_name = safe_export_file_name(str(data.get("fileName") or ""), str(data.get("fileType") or ""))
    file_type = str(data.get("fileType") or "").strip()
    download_url = str(data.get("cosUrl") or "").strip()
    if not download_url:
        error_exit("导出失败: code=50000; msg=导出服务暂不可用，请稍后重试")

    local_path = ""
    out = (args.out or "").strip()
    if out:
        dest = resolve_out_path(out, file_name)
        _download(download_url, dest)
        local_path = str(dest)

    out_obj = {
        "node_id": node_id,
        "kind": api_kind,
        "file_name": file_name,
        "file_type": file_type,
        "download_url": download_url,
    }
    if local_path:
        out_obj["local_path"] = local_path
    safe_print("KS_NODE_EXPORT " + json.dumps(out_obj, ensure_ascii=False, separators=(",", ":")))
    emit_user_reply(_receipt(file_name, bool(local_path)))


if __name__ == "__main__":
    main()
