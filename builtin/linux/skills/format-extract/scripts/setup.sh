#!/usr/bin/env bash
# format-extract 依赖准备（幂等）
#
# 本技能的转换器 scripts/docx2html.py 依赖 python-docx。
# 依赖环境与 html-to-docx 技能共用同一个 venv（~/.venv-html-to-docx），
# 因此直接转发到 html-to-docx 的 setup.sh，避免重复维护两套安装逻辑。
#
# 用法:
#   bash scripts/setup.sh               # 准备环境（已就绪则秒退）
#   bash scripts/setup.sh --print-python  # 仅打印可用解释器绝对路径
#
# 环境变量:
#   HTML_TO_DOCX_VENV  覆盖 venv 位置（默认 $HOME/.venv-html-to-docx）

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HERE/../../html-to-docx/scripts/setup.sh"

if [ ! -f "$TARGET" ]; then
  echo "错误: 找不到 html-to-docx 技能的 scripts/setup.sh（$TARGET）" >&2
  echo "请确认 format-extract 与 html-to-docx 安装在同一 skills 目录下。" >&2
  exit 1
fi

exec bash "$TARGET" "$@"
