#!/usr/bin/env bash
# setup.sh — 装齐 workbuddy / local 通道 plugin 运行时依赖。
#
# 覆盖链路：format-extract（需要 Node.js 18+，跑 skills/format-extract/dist/cli.cjs）
#
# 注：docx-referring 已下放到 Stage3 doc-editor（tencent-doc-edit），不再由本聚合
# 脚本装载。如仍需要，请直接调 src/skills/docx-referring/scripts/setup_env.sh。
# 注：html-to-docx 旧链路（含 setup-html-to-docx.sh）已废弃，HTML→docx 转换由
# html-to-doc skill 承接，不再由本脚本装载 Python 环境。
#
# 幂等：已就绪则跳过。
#
# 用法：
#   bash src/scripts/wb/local/setup.sh                # 检查 Node
#   bash src/scripts/wb/local/setup.sh --skip-node    # 跳过 Node 检查
#
# 布局兼容：本脚本可能位于两处
#   1. src 开发态：<repo>/src/scripts/wb/local/setup.sh
#   2. plugin 部署态：<plugin_root>/scripts/wb/local/setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 定位 ROOT_DIR（仅用于检查根目录空 node 占位）
if [ -d "$SCRIPT_DIR/../../../skills" ]; then
    # plugin 布局：scripts/wb/local -> scripts/wb -> scripts -> <plugin_root>
    ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
else
    # src 布局：src/scripts/wb/local -> src/scripts/wb -> src/scripts -> src -> <repo>
    ROOT_DIR="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
fi

SKIP_NODE=false
for arg in "$@"; do
    case "$arg" in
        --skip-node)   SKIP_NODE=true ;;
        -h|--help)
            sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

section() { echo ""; echo "═══ $* ═══"; }
ok()      { echo "✓ $*"; }
warn()    { echo "! $*" >&2; }
fail()    { echo "✗ $*" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────
# Node.js 18+（format-extract 依赖）
# ─────────────────────────────────────────────────────────────
setup_node() {
    section "Node.js runtime (for format-extract)"

    # 仓根有个 0 字节的 ./node 占位文件（历史遗留），会误导 PATH 查找
    if [ -f "$ROOT_DIR/node" ] && [ ! -s "$ROOT_DIR/node" ]; then
        warn "根目录存在空的 ./node 占位文件，请勿把它加入 PATH（非可执行）"
    fi

    if command -v node >/dev/null 2>&1; then
        NODE_VER="$(node -v 2>/dev/null || true)"
        # 期望 v20+；<v18 太老，format-extract 明确要求 >=18
        MAJOR="$(echo "$NODE_VER" | sed -E 's/^v([0-9]+)\..*/\1/')"
        if [ -n "$MAJOR" ] && [ "$MAJOR" -ge 18 ] 2>/dev/null; then
            ok "Node $NODE_VER available (>= 18 satisfied)"
            return 0
        else
            warn "detected Node $NODE_VER，低于 format-extract 所需的 >= 18"
        fi
    fi

    warn "Node.js 未安装或版本过低。"
    warn "请手动安装 Node 20 LTS 后再跑本脚本（本仓不代管 Node 安装策略）："
    warn "  - 若使用 CodeBuddy IDE，可让 agent 调 install_binary(node, 20.18.0)"
    warn "  - 或用系统包管理器 / nvm 安装 node >= 18"
    # Node 是 format-extract 的硬依赖，缺失时不报 fail——只警告后继续；
    # 真正调 format-extract 时会立即失败并给出明确信息。
    return 0
}

# ─────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────
[ "$SKIP_NODE" = true ] || setup_node

section "All done"
