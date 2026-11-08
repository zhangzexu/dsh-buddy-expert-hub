#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""html-to-doc 一键转换：preflight → create → open → insert → save(直接落交付路径) → verify。

全流程自包含：
    调用方只需提供 HTML 与交付路径；脚本 create_doc 建新文档 → open 激活会话
    → insert_html_content → save 直接写到交付路径（产物即位，无中间拷贝）
    → verify 出门校验。成品预览由调用方在脚本返回成功后 present。

用法：
    python3 convert_doc.py --html <S2产物.html> --output <stage3/output.docx>
        [--require-page-furniture]   用户要求页眉页脚/页码/封面时必传
        [--require-toc]              强制目录结构校验（HTML 含目录块时自动启用）

输出：stdout 末行 JSON
    {"success": bool, "docx_path": str|null, "chunks": int|null,
     "preflight": {...}, "verify": {...}, "error": "[stage] msg"|null}
退出码：0 成功 / 1 失败（error 标注失败阶段 preflight / convert / verify）
失败重跑：直接重跑本脚本（每次 create 新文档，不依赖上次会话状态）。
"""
import argparse
import json
import os
import re
import subprocess
import sys
import traceback
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import edsdk  # 复用端口发现（环境变量 editor_sdk_port > EXTRA_PORTS 常驻实例 > 端口扫描）与 RPC 封装

PY = sys.executable

# AIGC 隐标（docProps/custom.xml）——字段 schema 与 WorkBuddy PPT 侧定稿对齐：
# properties.AIGC 的值是 JSON 字符串（JSON.stringify 语义），不能直接传对象。
AIGC_PRODUCER_CODE = "00119111010856365494821B355"


def _set_aigc_hidden_tag(file_id):
    """在 save 前写入 AIGC 隐标（自定义文档属性）。

    - ProduceID 优先取环境变量 CODEBUDDY_CONVERSATION_REQUEST_ID（生成会话可追溯），
      缺失/空白时生成 UUID 兜底；PropagateID 与 ProduceID 同值（与 PPT 侧一致）。
    - 写入失败仅告警、不阻断转换（降级交付，与 PPT 侧语义一致）。
    返回 True/False 供结果上报。
    """
    try:
        produce_id = (os.environ.get("CODEBUDDY_CONVERSATION_REQUEST_ID") or "").strip() \
            or str(uuid.uuid4())
        metadata = {"AIGC": {
            "Label": "1",
            "ContentProducer": AIGC_PRODUCER_CODE,
            "ProduceID": produce_id,
            "ReservedCode1": "",
            "ContentPropagator": AIGC_PRODUCER_CODE,
            "PropagateID": produce_id,
            "ReservedCode2": "",
        }}
        body = edsdk.localapi_post("custom", {
            "file_id": file_id, "action": "set",
            "properties": {"AIGC": json.dumps(metadata, ensure_ascii=False)},
        })
        if not isinstance(body, dict):
            print(f"[warn] AIGC 隐标写入返回结构异常: {str(body)[:200]}",
                  file=sys.stderr, flush=True)
            return False
        # code 类型归一化：缺失/非数字/无法解析一律按失败处理，兼容字符串 "0"
        try:
            code = int(body.get("code"))
        except (TypeError, ValueError):
            code = -1
        if code != 0:
            print(f"[warn] AIGC 隐标写入返回 code={body.get('code')}: "
                  f"{body.get('message')}", file=sys.stderr, flush=True)
            return False
        return True
    except Exception as e:
        print(f"[warn] AIGC 隐标写入失败（不阻断转换）: {e}", file=sys.stderr, flush=True)
        traceback.print_exc(file=sys.stderr)
        return False


def _run_json(cmd):
    """跑子脚本，返回 (退出码, 解析到的JSON或None, stderr摘要)。"""
    r = subprocess.run(cmd, capture_output=True, text=True)
    data = None
    stdout = (r.stdout or "").strip()
    if stdout:
        try:
            data = json.loads(stdout)  # 整体 JSON（verify 为 pretty-print 多行）
        except json.JSONDecodeError:
            for line in reversed(stdout.splitlines()):  # 兜底：末行单行 JSON
                try:
                    data = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue
    return r.returncode, data, (r.stderr or "")[:300]


def _call(name, args):
    """调 MCP 工具，返回 (result_dict, content_text)。失败抛 RuntimeError。"""
    try:
        result = edsdk._rpc("tools/call", {"name": name, "arguments": args})
    except SystemExit as e:  # edsdk 错误路径走 sys.exit(1)，错误信息已打印
        raise RuntimeError(f"{name} 调用失败（连接/JSON-RPC 错误，见上方 edsdk 输出）") from e
    if not isinstance(result, dict):
        raise RuntimeError(f"{name} 返回结构异常: {str(result)[:200]}")
    text = "\n".join(c.get("text", "") for c in result.get("content", [])
                     if isinstance(c, dict))
    return result, text


# MCP 工具返回无独立结构化字段（content 内只有 text），键值解析三级兜底：
# ① 整体 JSON（open_file 等返回 JSON 文本）② "key": value JSON 片段 ③ key=value 文本
_RE_KV_JSON = re.compile(r'"(file_id|file_path)"\s*:\s*"([^"]+)"')
_RE_KV_TEXT = re.compile(r'\b(file_id|file_path)=(\S+?)(?=\s|$|,)')
_RE_NUM_JSON = re.compile(r'"(?:chunks|block_count)"\s*:\s*(\d+)')


def _parse_tool_kv(text: str) -> dict:
    """从工具返回文本提取 file_id / file_path（JSON 优先，等号文本兜底）。"""
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return {k: str(v) for k, v in obj.items()
                    if k in ("file_id", "file_path") and v is not None}
    except json.JSONDecodeError:
        pass
    kv = dict(_RE_KV_JSON.findall(text))
    kv.update(_RE_KV_TEXT.findall(text))
    return kv


def main():
    ap = argparse.ArgumentParser(description="html-to-doc 一键转换（预检→转换→校验）")
    ap.add_argument("--html", required=True, help="S2 产出的单个完整 HTML 文件")
    ap.add_argument("--output", required=True, help="交付 .docx 绝对路径（output_docx_path）")
    ap.add_argument("--no-preflight", action="store_true",
                    help="跳过 preflight 门禁（快通道；工作流默认使用，排查问题时去掉）")
    ap.add_argument("--no-verify", action="store_true",
                    help="跳过 verify 出门校验（快通道；工作流默认使用，排查问题时去掉）")
    ap.add_argument("--require-page-furniture", action="store_true",
                    help="用户要求页眉页脚/页码/封面时必传（透传 preflight_check）")
    ap.add_argument("--require-toc", action="store_true",
                    help="强制目录结构校验；HTML 含目录块时自动启用（透传 verify_output）")
    a = ap.parse_args()
    # 相对路径按「调用方 cwd」规范化为绝对路径：若把相对路径原样传给引擎，
    # 引擎会按其自身工作目录解析（launchd 服务的 cwd），导致 save 落错位置而失败
    # （实测 2026-09-23）。--html 同理规范化，保证子进程（preflight/verify）口径一致。
    a.output = os.path.abspath(a.output)
    a.html = os.path.abspath(a.html)

    result = {"success": False, "docx_path": None, "chunks": None,
              "preflight": None, "verify": None, "aigc_tag": None, "error": None}

    def fail(stage, err):
        result["error"] = f"[{stage}] {str(err)[:300]}"
        print(json.dumps(result, ensure_ascii=False), flush=True)
        sys.exit(1)

    # ① preflight：S2 产物硬门禁（--no-preflight 跳过：快通道）。
    # 页面要素强制预检（代码级，与 doc-converter.md §6 纪律 10 配套）：
    # --require-page-furniture 时忽略 --no-preflight——@page 缺失必须硬失败，
    # 不依赖调用方自觉，堵死门禁真空
    if a.require_page_furniture and a.no_preflight:
        print("[warn] --require-page-furniture 场景强制启用 preflight，忽略 --no-preflight",
              file=sys.stderr)
        a.no_preflight = False
    if not a.no_preflight:
        cmd = [PY, os.path.join(HERE, "preflight_check.py"), "--html", a.html]
        if a.require_page_furniture:
            cmd.append("--require-page-furniture")
        rc, data, err = _run_json(cmd)
        result["preflight"] = data if isinstance(data, dict) else (err or f"exit {rc}")
        if rc != 0:
            issues = data.get("issues") if isinstance(data, dict) else None
            fail("preflight", issues or err or f"exit {rc}")

    # ② create → open → insert → save 直接到交付路径（产物即位，无中间拷贝）
    try:
        html_text = open(a.html, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError) as e:
        fail("convert", f"读取 HTML 失败: {e}")

    create_fid = None
    live_id = None
    try:
        # create 建新文档（引擎落在 uploads，返回会话 id 与实际路径——
        # 交付由下面 save 直接写到 output，uploads 里的创建副本无需关心）
        r_create, t_create = _call("create_doc", {"file_path": a.output})
        # 解析对齐 SKILL §2.1 契约：create_doc 的 file_id/file_path 在 JSON-RPC
        # result 的顶层字段（自写 driver 必须取顶层，不在 content[0].text 里）；
        # content 文本解析仅作引擎旧输出形态的兜底
        kv = {k: str(r_create[k]) for k in ("file_id", "file_path")
              if r_create.get(k) is not None}
        if not kv.get("file_id"):
            kv = _parse_tool_kv(t_create)
        create_fid = kv.get("file_id")
        if not create_fid:
            raise RuntimeError(f"create_doc 未返回 file_id: {t_create[:200]}")
        created_path = kv.get("file_path")
        # 显式激活编辑会话并等待导入完成，并改用 open 返回的编辑器 file_id（路径形式）——
        # create 自动 open 的会话闲置数十秒会被引擎回收（实测 2026-09-17），open(wait)
        # 幂等激活防竞态（open 同样顶层优先、文本兜底）
        r_open, t_open = _call("open_file", {"file_path": created_path, "wait": True})
        live_id = (r_open.get("file_id") or
                   _parse_tool_kv(t_open).get("file_id") or create_fid)
        _, text = _call("doc_insert_html_content",
                        {"file_id": live_id, "idx": 0, "html_text": html_text})
        m = _RE_NUM_JSON.search(text)
        if m:
            result["chunks"] = int(m.group(1))
        # AIGC 隐标：insert 之后、save 之前写入（随 save 落盘），失败不阻断
        result["aigc_tag"] = _set_aigc_hidden_tag(live_id)
        # save 直接写到交付路径——产物即位
        out_dir = os.path.dirname(os.path.abspath(a.output))
        os.makedirs(out_dir, exist_ok=True)
        _call("save_file", {"file_id": live_id, "file_path": a.output})
        result["docx_path"] = a.output
    except Exception as e:
        fail("convert", e)
    finally:
        # close 失败仅告警不抛出：主流程已完成（save 已落盘）或已走 fail() 退出路径，
        # 此处异常不应掩盖主结果/主错误；残留会话由引擎闲置回收兜底
        for fid in (create_fid, live_id):
            if fid:
                try:
                    _call("close_file", {"file_id": fid})
                except Exception as e:
                    print(f"[warn] close_file({fid}) 失败（不影响产物，会话由引擎闲置回收）: {e}",
                          file=sys.stderr, flush=True)

    # ③ verify：出门校验（对交付文件；--no-verify 跳过：快通道）
    if not a.no_verify:
        cmd = [PY, os.path.join(HERE, "verify_output.py"),
               "--html", a.html, "--docx", a.output]
        if a.require_toc or 'class="doc-toc"' in html_text:
            cmd.append("--require-toc")
        rc, data, err = _run_json(cmd)
        result["verify"] = data if isinstance(data, dict) else (err or f"exit {rc}")
        if rc != 0:
            issues = data.get("issues") if isinstance(data, dict) else None
            fail("verify", issues or err or f"exit {rc}")

    result["success"] = True
    print(json.dumps(result, ensure_ascii=False), flush=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
