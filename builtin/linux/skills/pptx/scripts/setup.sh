#!/usr/bin/env bash
# setup.sh — pptx 技能的 Python 运行时自举。
# 共享 venv：~/.venv-office（OFFICE_VENV 可覆盖）；OFFICE_PY 可直通已就绪解释器。
# 最后一行固定输出 `Python runner: <解释器绝对路径>`：
#   PY="$(bash scripts/setup.sh | sed -n 's/^Python runner: //p')"
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="${OFFICE_VENV:-$HOME/.venv-office}"
PY_VERSION="3.12"
REQUIREMENTS="python-pptx>=0.6.21 lxml>=5.2 defusedxml>=0.7"
REQUIRED_MODULES="pptx lxml defusedxml"

ok()   { echo "✓ $*"; }
step() { echo "▶ $*"; }

runner_ready() {
    local py="$1"
    [ -x "$py" ] || return 1
    for m in $REQUIRED_MODULES; do
        "$py" -c "import $m" 2>/dev/null || return 1
    done
    return 0
}

emit() {
    echo ""
    echo "✓ 解释器：$1"
    echo "  用法：cd $SCRIPT_DIR && $1 <script>.py"
    echo "  或：export OFFICE_PY=\"$1\""
    echo "Python runner: $1"
}

# 0. 外部显式指定
if [ -n "${OFFICE_PY:-}" ] && runner_ready "$OFFICE_PY"; then
    ok "使用外部指定的解释器：$OFFICE_PY"
    emit "$OFFICE_PY"
    exit 0
fi

# 1. 已有共享 venv 且依赖齐全
for cand in "$VENV_DIR/bin/python3" "$VENV_DIR/bin/python"; do
    if runner_ready "$cand"; then
        ok "已就绪：$VENV_DIR"
        emit "$cand"
        exit 0
    fi
done

# 2. 系统 python3 已装齐
for cand in python3 python3.12 python3.11; do
    if command -v "$cand" >/dev/null 2>&1 && runner_ready "$(command -v "$cand")"; then
        ok "系统解释器已具备依赖：$(command -v "$cand")"
        emit "$(command -v "$cand")"
        exit 0
    fi
done

# 3. uv 建共享 venv
if ! command -v uv >/dev/null 2>&1; then
    if [ -x "$HOME/.local/bin/uv" ]; then
        export PATH="$HOME/.local/bin:$PATH"
    else
        step "安装 uv（需访问 https://astral.sh/uv/install.sh）"
        if ! curl -LsSf https://astral.sh/uv/install.sh 2>/dev/null | sh >/dev/null 2>&1; then
            echo "✗ 无法安装 uv（无外网）。可预先 export OFFICE_PY=/已有/依赖/的/python3 后重跑。" >&2
            exit 1
        fi
        export PATH="$HOME/.local/bin:$PATH"
        ok "uv 已安装"
    fi
fi
if ! uv python find "$PY_VERSION" >/dev/null 2>&1; then
    step "通过 uv 安装 Python $PY_VERSION"
    uv python install "$PY_VERSION" >/dev/null 2>&1
fi
if [ -d "$VENV_DIR" ] && [ ! -x "$VENV_DIR/bin/python" ]; then
    mv "$VENV_DIR" "${VENV_DIR}.broken.$(date +%s)"
fi
if [ ! -x "$VENV_DIR/bin/python" ]; then
    step "创建 venv：$VENV_DIR"
    uv venv --python "$PY_VERSION" "$VENV_DIR" >/dev/null 2>&1
fi
PY="$VENV_DIR/bin/python"
step "安装依赖：$REQUIREMENTS"
# shellcheck disable=SC2086
uv pip install --quiet --python "$PY" --only-binary=:all: $REQUIREMENTS >/dev/null 2>&1
ok "依赖安装完成"
if ! runner_ready "$PY"; then
    echo "✗ 安装后仍缺依赖，请检查网络或改用 OFFICE_PY 直通" >&2
    exit 1
fi
emit "$PY"
