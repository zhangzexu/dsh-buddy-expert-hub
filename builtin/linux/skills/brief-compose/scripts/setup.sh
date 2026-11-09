#!/usr/bin/env bash
# setup.sh — brief-compose 的运行时入口（委托给同级 html-to-docx 技能）。
#
# brief-compose 自身不含转换实现：它写完 HTML 后调用 html-to-docx 技能完成
# HTML→DOCX。两个技能必须同批安装、保持同级目录，本脚本只做路径转发，
# 保证调用方始终只用 `<skill_dir>/scripts/setup.sh` 一个入口。
#
# 用法：
#   bash scripts/setup.sh                 # 幂等安装，打印人读摘要
#   bash scripts/setup.sh --print-python  # 只打印解释器绝对路径
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="$HERE/../../html-to-docx/scripts/setup.sh"

if [ ! -f "$TARGET" ]; then
  echo "错误: 找不到 html-to-docx 技能的 scripts/setup.sh" >&2
  echo "  brief-compose 依赖 html-to-docx 同批安装（同级目录 skills/html-to-docx/）" >&2
  echo "  期望路径: $TARGET" >&2
  exit 1
fi

exec bash "$TARGET" "$@"
