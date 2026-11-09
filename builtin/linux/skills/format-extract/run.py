#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
格式特征提取 — 一键脚本
用法: python3 run.py <input_docx_path> --output-dir <dir>

自动完成: 输入路径校验 → artifact 隔离目录生成（基于源文件名 + 内容哈希）
         → Python 解释器/依赖检测（python-docx）→ 转换
         → format_artifact.json manifest 写盘
成功时输出 HTML 绝对路径到 stdout 最后一行，供调用方捕获。

★ 输出目录策略（v3）：
  --output-dir 为**必传参数**，由调用方（如 doc-formatter）显式指定。
  脚本自身**不猜测输出位置**——不基于 __file__ 定位 workpace、不基于 cwd 猜、
  不读环境变量。这是"关注点分离"：产物落点由编排层拥有，脚本只负责转换。

  脚本会在 --output-dir 下自动追加 <artifact_id> 子目录做多模板隔离，
  确保多个 docx 各自独立、永不相互覆盖；同一 docx 重复处理复用同一
  目录（幂等）。若 --output-dir 末尾已是 artifact_id，则原样使用不重复嵌套。

★ 转换实现：
  统一使用与本脚本**同目录**下的 `scripts/docx2html.py`（纯 Python，
  依赖 python-docx），通过 `Path(__file__).resolve().parent` 定位，
  不受调用方 cwd 影响。不再需要 Node.js、不再尝试 npx / npm install，
  也不依赖外网/内网镜像源。

★ 输入路径：
  接受绝对路径或相对当前 cwd 的路径。不做 workpace 相对路径回退、
  不做 input/raw 模糊搜索——调用方保证传入可访问的路径。

manifest 产物（format_artifact.json）：
  与 reference_format.html 同级生成，记录 artifact_id / 源 docx 路径 /
  内容哈希 / 产出时间 / images_dir 等元数据，供 docx-writing Skill
  在 Step 2 绑定 FormatArtifactSet 时直接读取。
"""

from __future__ import annotations

import sys
import os
import json
import shutil
import hashlib
import subprocess
import re
from datetime import datetime, timezone
from pathlib import Path


def log(msg: str):
    """日志输出到 stderr，不污染 stdout"""
    print(msg, file=sys.stderr)


def run_cmd(cmd: list[str], capture=True, check=False) -> subprocess.CompletedProcess:
    """执行命令并返回结果"""
    return subprocess.run(
        cmd,
        capture_output=capture,
        text=True,
        check=check,
    )


# ============================================================
# 输入文件路径解析（策略单一：绝对路径 / 相对 cwd）
# ============================================================
def resolve_input_path(raw_path: str) -> Path:
    """
    解析输入 docx 文件路径，返回绝对路径。

    只接受绝对路径或相对当前 cwd 的路径。找不到直接报错退出——
    调用方（如 doc-formatter）负责传入可访问的路径，本脚本不猜。
    """
    p = Path(raw_path).resolve()
    if p.is_file():
        return p

    log(f"❌ 输入文件不存在: {raw_path}")
    log(f"   解析为绝对路径: {p}")
    log(f"   当前工作目录: {Path.cwd()}")
    log(f"   提示：请传入绝对路径或相对当前 cwd 的有效路径。")
    sys.exit(1)


# ============================================================
# 前置门禁
# ============================================================
def _docx2html_script() -> Path:
    """返回转换器脚本路径：与本脚本同级的 scripts/docx2html.py"""
    return Path(__file__).resolve().parent / "scripts" / "docx2html.py"


def _python_candidates() -> list[Path]:
    """
    按优先级列出候选 Python 解释器：

      1. 环境变量 FORMAT_EXTRACT_PY（调用方显式指定，最优先）
      2. ~/.venv-html-to-docx/bin/python（html-to-docx 技能共享的 venv，
         其依赖清单里已包含 python-docx）
      3. 运行本脚本的解释器 sys.executable
      4. PATH 上的 python3 / python（兜底）

    返回去重后的候选列表，不保证每个都可运行。
    """
    cands: list[Path] = []

    env_py = os.environ.get("FORMAT_EXTRACT_PY", "").strip()
    if env_py:
        cands.append(Path(env_py).expanduser())

    cands.append(Path.home() / ".venv-html-to-docx" / "bin" / "python")
    cands.append(Path(sys.executable))

    for name in ("python3", "python"):
        found = shutil.which(name)
        if found:
            cands.append(Path(found))

    seen: set[str] = set()
    uniq: list[Path] = []
    for p in cands:
        try:
            key = str(p.resolve())
        except OSError:
            key = str(p)
        if key in seen:
            continue
        seen.add(key)
        uniq.append(p)
    return uniq


def resolve_python() -> str | None:
    """
    P1/P2 合并：挑选一个**能 import docx** 的 Python 解释器。

    逐个候选执行 `-c "import docx"` 探测，第一个通过者即采用。
    全部失败时打印可执行的修复指引并返回 None。

    返回解释器绝对路径字符串；失败返回 None。
    """
    script = _docx2html_script()
    if not script.is_file():
        log(f"❌ 转换器脚本不存在: {script}")
        log("   请确认技能分发完整（含 scripts/docx2html.py）。")
        return None

    tried: list[str] = []
    for py in _python_candidates():
        if not py.is_file():
            tried.append(f"{py}（不存在）")
            continue
        try:
            probe = run_cmd([str(py), "-c", "import docx"])
        except (FileNotFoundError, PermissionError, OSError) as e:
            tried.append(f"{py}（无法执行: {e}）")
            continue
        if probe.returncode == 0:
            log(f"✅ 使用 Python 解释器: {py}")
            return str(py)
        tried.append(f"{py}（缺 python-docx）")

    log("❌ 未找到可用的 Python 解释器（需已安装 python-docx）")
    for item in tried:
        log(f"   - {item}")
    log("   修复方式（任选其一）：")
    log("     a) bash <skill_dir>/scripts/setup.sh         # 自动准备 venv 并装依赖")
    log("     b) export FORMAT_EXTRACT_PY=/path/to/python  # 指向已有环境")
    log("     c) pip install python-docx                   # 装到当前解释器")
    return None


# ============================================================
# 主流程
# ============================================================
def compute_artifact_id(input_path: Path) -> str:
    """
    基于源 docx 的文件名 stem + 内容 MD5 前 8 位生成稳定 artifact_id。

    设计目标：
      - 同一个 docx 多次处理 → 得到相同 artifact_id（幂等，可复用产物目录）
      - 不同 docx → 得到不同 artifact_id，永不互相覆盖
      - docx 内容变更 → 哈希变化，自动隔离新旧版本

    返回示例: "财报_a1b2c3d4"
    """
    try:
        content_hash = hashlib.md5(input_path.read_bytes()).hexdigest()[:8]
    except (OSError, PermissionError) as e:
        log(f"⚠️ 无法读取源文件计算哈希: {e}，回退到时间戳")
        content_hash = datetime.now().strftime("%H%M%S")
    # 文件名做基础清洗：去掉文件系统不友好字符
    stem = re.sub(r"[^\w\u4e00-\u9fff.\-]+", "_", input_path.stem).strip("_")
    if not stem:
        stem = "template"
    return f"{stem}_{content_hash}"


def write_manifest(
    out_dir: Path,
    artifact_id: str,
    input_path: Path,
    html_path: Path,
    images_dir: Path,
) -> Path:
    """
    在产物目录下写入 format_artifact.json manifest，与 docx-writing
    Skill 的 Step 2 (FormatArtifactSet 绑定) 契约对齐。

    返回 manifest 文件绝对路径。
    """
    manifest_path = out_dir / "format_artifact.json"
    manifest = {
        "artifact_id": artifact_id,
        "source_docx": str(input_path),
        "source_docx_md5": hashlib.md5(input_path.read_bytes()).hexdigest(),
        "html_path": str(html_path),
        "images_dir": str(images_dir),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generator": "format-extract/run.py",
        "schema_version": "1.0",
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest_path


def resolve_output_dir(custom_out_dir: str, artifact_id: str) -> Path:
    """
    解析输出目录路径。**custom_out_dir 必传**，脚本不猜位置。

    策略：
      1. 在 custom_out_dir 下追加 <artifact_id> 子目录做隔离
         （若路径末尾已经等于 artifact_id，则原样使用避免重复嵌套）
      2. 父目录不存在时自动创建，创建失败或不可写则报错退出

    ★ 与 v2 的差异：不再有"默认路径"分支——custom_out_dir 为 None 时
      直接报错（由 main() 的 argparse 层拦截，此处防御性再校验一次）。
    """
    if not custom_out_dir:
        # 防御性检查——正常情况 main() 里已经拦截了
        log("❌ 内部错误：resolve_output_dir 收到空的 custom_out_dir")
        log("   --output-dir 是必传参数，请由调用方显式指定。")
        sys.exit(2)

    custom_path = Path(custom_out_dir).resolve()

    # 如果自定义路径包含文件名后缀，提取目录部分
    if custom_path.suffix:
        base_dir = custom_path.parent / custom_path.stem
    else:
        base_dir = custom_path

    # 若调用方未在路径末尾带上 artifact_id，则自动追加
    # 判定标准：路径最后一段不等于 artifact_id（避免重复嵌套）
    if base_dir.name != artifact_id:
        out_dir = base_dir / artifact_id
    else:
        out_dir = base_dir

    # 验证父目录可写
    parent_dir = out_dir.parent
    if not parent_dir.exists():
        try:
            parent_dir.mkdir(parents=True, exist_ok=True)
            log(f"📂 已创建输出目录的父路径: {parent_dir}")
        except (PermissionError, OSError) as e:
            log(f"❌ 无法创建输出目录的父路径: {parent_dir}")
            log(f"   错误: {e}")
            sys.exit(1)

    try:
        test_file = parent_dir / ".write_test"
        test_file.touch()
        test_file.unlink()
    except (PermissionError, OSError) as e:
        log(f"❌ 指定的输出目录无写入权限: {parent_dir}")
        log(f"   错误: {e}")
        sys.exit(1)

    log(f"📂 使用输出目录（已按 artifact_id 隔离）: {out_dir}")
    return out_dir


def main():
    # ── 解析命令行参数 ──
    args = sys.argv[1:]

    # 帮助信息
    if not args or args[0] in ("-h", "--help"):
        print(f"""用法: {sys.argv[0]} <input_docx_path> --output-dir <dir>

参数:
  <input_docx_path>          要转换的 .docx 文件路径（绝对路径或相对 cwd 的路径）
  -o, --output-dir <dir>     ★ 必传 ★ 输出目录的【父目录】
                             脚本会在其下自动追加 <artifact_id> 子目录隔离，
                             避免多模板互相覆盖。
  -h, --help                 显示帮助信息

★ 关于 --output-dir 必传：
  本脚本不再自行猜测输出位置。调用方（如 doc-formatter）必须显式指定
  一个可写目录，通常应指向 pipeline 目录下 stage 的中间产物区，例如：
    <workspace>/output/<request_id>/stage2/intermediate/format-extract/

artifact_id 规则:
  <docx_stem>_<md5_8>，例如 财报_a1b2c3d4
  - 同一 docx 多次处理 → 复用同一目录（幂等）
  - 不同 docx → 自动隔离，永不互相覆盖

示例:
  {sys.argv[0]} /abs/path/to/document.docx --output-dir /abs/path/to/stage2/intermediate/format-extract
  {sys.argv[0]} ./doc.docx -o ./out/stage2/intermediate/format-extract

产物清单（位于 <output-dir>/<artifact_id>/）:
  - reference_format.html        # 语义化 HTML
  - format_artifact.json         # manifest（含 artifact_id / 源 docx 哈希等）
  - images/                      # 提取的图片资产
""", file=sys.stderr)
        sys.exit(0)

    input_path_str = args[0]
    custom_out_dir: str | None = None

    # 解析可选参数
    i = 1
    while i < len(args):
        if args[i] in ("-o", "--output-dir"):
            if i + 1 >= len(args):
                log(f"❌ {args[i]} 参数需要指定目录路径")
                sys.exit(2)
            custom_out_dir = args[i + 1]
            i += 2
        else:
            log(f"⚠️ 未知参数: {args[i]}")
            i += 1

    # ── 必传参数校验：--output-dir ──
    if not custom_out_dir:
        log("❌ 缺少必传参数 --output-dir")
        log("   本脚本不再猜测输出位置。请由调用方（如 doc-formatter）显式指定。")
        log(f"   查看用法: {sys.argv[0]} --help")
        sys.exit(2)

    # ── 解析输入文件路径（只认绝对路径 / 相对 cwd）──
    input_path = resolve_input_path(input_path_str)

    # ── 计算 artifact_id（基于源文件名 + 内容哈希，多模板隔离的核心）──
    artifact_id = compute_artifact_id(input_path)
    log(f"🔖 artifact_id: {artifact_id}")

    # ── 解析输出目录（按 artifact_id 隔离，永不互相覆盖）──
    out_dir = resolve_output_dir(custom_out_dir, artifact_id)

    # ── 创建输出目录结构 ──
    try:
        images_dir = out_dir / "images"
        images_dir.mkdir(parents=True, exist_ok=True)
    except (PermissionError, OSError) as e:
        log(f"❌ 无法创建输出目录: {out_dir}")
        log(f"   错误: {e}")
        sys.exit(1)

    html_path = out_dir / "reference_format.html"

    # ── 校验输出目录已正确创建 ──
    if not out_dir.is_dir():
        log(f"❌ 输出目录创建失败: {out_dir}")
        sys.exit(1)

    # ── 门禁：Python 解释器 + python-docx + 转换器脚本 ──
    python_exe = resolve_python()
    if not python_exe:
        sys.exit(1)

    converter = _docx2html_script()

    # ── 转换 ──
    log(f"▶ 输入: {input_path}")
    log(f"▶ 输出: {html_path}")
    log(f"▶ 转换器: {converter}")

    result = run_cmd([
        python_exe, str(converter), "convert",
        "--input", str(input_path),
        "--output", str(html_path),
        "--image-base-url", "./images",
    ], capture=True)

    if result.stdout:
        log(result.stdout.rstrip())
    if result.stderr:
        log(result.stderr.rstrip())

    if result.returncode != 0:
        log("❌ 转换失败")
        sys.exit(1)

    # ── 校验 HTML 产物存在 ──
    if not html_path.is_file():
        log(f"❌ 转换声称成功但 HTML 文件不存在: {html_path}")
        sys.exit(1)

    # ── 写入 format_artifact.json manifest（与 docx-writing Skill Step 2 契约对齐）──
    try:
        manifest_path = write_manifest(
            out_dir=out_dir,
            artifact_id=artifact_id,
            input_path=input_path,
            html_path=html_path,
            images_dir=images_dir,
        )
        log(f"📝 已写入 manifest: {manifest_path}")
    except (OSError, PermissionError) as e:
        log(f"⚠️ manifest 写入失败（不影响 HTML 产物可用性）: {e}")

    # ── 校验产物路径有效性 ──
    if not str(html_path).startswith(str(Path(custom_out_dir).resolve())):
        log(f"⚠️ HTML 产物路径不在指定输出目录下: {html_path}")

    # stdout 最后一行输出 HTML 绝对路径
    print(str(html_path))


if __name__ == "__main__":
    main()
