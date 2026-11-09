#!/usr/bin/env bash
# setup.sh — 为 html-to-docx 技能准备 Python 运行时（自包含版）。
#
# 与插件版的区别：
#   - 不再向外层 plugin 根寻找 skills/html-to-docx/scripts，直接以本脚本所在目录为准；
#   - 支持 `--print-python`：只向 stdout 打印解释器绝对路径，便于命令替换捕获；
#   - 依赖自检用真实 import 名（html4docx，而非 htmldocx）。
#
# 依赖：python-docx / html-for-docx / beautifulsoup4 / lxml / httpx / Pillow / click
# 首次安装需要外网（uv + python-build-standalone + PyPI）。私有化环境请预先：
#   export UV_INDEX_URL=<内网 PyPI>/simple
#   export UV_PYTHON_INSTALL_MIRROR=<内网 python-build-standalone 镜像>
#   并把 uv 二进制放到 PATH 或 $HOME/.local/bin/ 下
#
# 用法：
#   bash scripts/setup.sh                 # 幂等安装，打印人读摘要
#   bash scripts/setup.sh --print-python  # 只打印解释器路径
#   HTML_TO_DOCX_VENV=/自定义/路径 bash scripts/setup.sh
#
# 退出码：0 = 就绪；1 = 失败（stderr 有原因）

set -u

QUIET=0
PRINT_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --print-python) PRINT_ONLY=1 ;;
    -q|--quiet)     QUIET=1 ;;
    -h|--help)      sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$SCRIPT_DIR/html_to_docx"
REQ_FILE="$SCRIPT_DIR/requirements.txt"
VENV_DIR="${HTML_TO_DOCX_VENV:-$HOME/.venv-html-to-docx}"
PY_VERSION="3.12"
MODULES="docx,html4docx,bs4,lxml,httpx,PIL,click"

log()  { [ "$QUIET" = 1 ] || [ "$PRINT_ONLY" = 1 ] || echo "  $*"; }
step() { [ "$QUIET" = 1 ] || [ "$PRINT_ONLY" = 1 ] || echo "> $*"; }
ok()   { [ "$QUIET" = 1 ] || [ "$PRINT_ONLY" = 1 ] || echo "OK $*"; }
die()  { echo "错误: $*" >&2; exit 1; }

[ -d "$PKG_DIR" ] || die "找不到 html_to_docx 包目录: $PKG_DIR（技能分发不完整）"
[ -f "$REQ_FILE" ] || die "找不到 requirements.txt: $REQ_FILE"

deps_ready() {
  local py="$1"
  [ -x "$py" ] || return 1
  "$py" -c "import $MODULES" >/dev/null 2>&1 || return 1
  "$py" -c "import sys; sys.exit(0 if sys.version_info[:2] >= (3,10) else 1)" >/dev/null 2>&1 || return 1
  return 0
}

# --- 快速路径：现成 venv 已就绪则秒退 ---
if deps_ready "$VENV_DIR/bin/python"; then
  if [ "$PRINT_ONLY" = 1 ]; then
    "$VENV_DIR/bin/python" -c 'import sys; print(sys.executable)'
  else
    ok "运行时就绪: $VENV_DIR"
    echo ""
    echo "Python runner: $VENV_DIR/bin/python"
  fi
  exit 0
fi

step "现有运行时不可用，开始装配（目标 venv: $VENV_DIR）"

if ! command -v uv >/dev/null 2>&1; then
  if [ -x "$HOME/.local/bin/uv" ]; then
    export PATH="$HOME/.local/bin:$PATH"
  else
    step "安装 uv（需要访问 astral.sh）"
    curl -LsSf https://astral.sh/uv/install.sh 2>/dev/null | sh >/dev/null 2>&1 \
      || die "uv 安装失败：无法访问 astral.sh。私有化环境请预先把 uv 放到 \$HOME/.local/bin/ 下"
    export PATH="$HOME/.local/bin:$PATH"
    ok "uv 已安装"
  fi
fi

if ! uv python find "$PY_VERSION" >/dev/null 2>&1; then
  step "通过 uv 安装 Python $PY_VERSION"
  uv python install "$PY_VERSION" >/dev/null 2>&1 || die "Python $PY_VERSION 安装失败（网络或镜像问题）"
fi
ok "Python $PY_VERSION 可用"

if [ ! -x "$VENV_DIR/bin/python" ]; then
  step "创建 venv: $VENV_DIR"
  uv venv --python "$PY_VERSION" "$VENV_DIR" >/dev/null 2>&1 || die "venv 创建失败: $VENV_DIR"
fi
ok "venv 已创建"

step "安装依赖（仅 wheel，规避 lxml 源码构建）"
uv pip install --quiet --python "$VENV_DIR/bin/python" --only-binary=:all: -r "$REQ_FILE" >/dev/null 2>&1 \
  || die "依赖安装失败，请检查 UV_INDEX_URL / 网络"

deps_ready "$VENV_DIR/bin/python" || die "依赖安装后自检仍失败，请检查 $VENV_DIR"

PYTHONPATH="$SCRIPT_DIR" "$VENV_DIR/bin/python" -c "import html_to_docx" >/dev/null 2>&1 \
  || die "html_to_docx 包导入失败，检查 $SCRIPT_DIR"
ok "html_to_docx 包可导入"

if [ "$PRINT_ONLY" = 1 ]; then
  "$VENV_DIR/bin/python" -c 'import sys; print(sys.executable)'
else
  echo ""
  echo "Python runner: $VENV_DIR/bin/python"
  echo ""
  echo "调用示例:"
  echo "  cd \"$SCRIPT_DIR\" && \"$VENV_DIR/bin/python\" -m html_to_docx convert input.html -o output.docx"
fi
exit 0
