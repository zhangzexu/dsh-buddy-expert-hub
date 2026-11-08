#!/bin/bash
#
# Inspect a Tencent Docs PPT and return compact JSON for LLM routing.
#
# Usage:
#   bash scripts/get_slide_info.sh <file_url_or_id> [--file-id]
#
# Output:
#   {"action":"write_design_md"|"proceed_next","reason":"...",...}
#

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "ERROR:missing_argument"
    exit 1
fi

INPUT="$1"
FILE_KEY="file_url"
[[ "${2:-}" == "--file-id" ]] && FILE_KEY="file_id"

BASE_ARGS=$(jq -n --arg key "$FILE_KEY" --arg val "$INPUT" '{($key): $val}')

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TDOC_PY="$SCRIPT_DIR/../../tencentdocs.py"

# 调用 slide-mcp 工具并解析出业务 JSON：兼容 result.structuredContent 与 result.content[0].text 两种形态
_call_slide_tool() {
    local raw payload
    raw=$(python3 "$TDOC_PY" tdoc_call slide-mcp "$1" "$2" 2>&1) || return 1
    payload=$(echo "$raw" | jq -c '(.result.structuredContent // (.result.content[0].text? | fromjson?)) // empty' 2>/dev/null) || return 1
    [[ -z "$payload" ]] && return 1
    echo "$payload"
}

INFO_RESULT=$(_call_slide_tool slide_get_info "$BASE_ARGS") || {
    echo "ERROR:slide_get_info_failed"
    exit 1
}

SLIDE_COUNT=$(echo "$INFO_RESULT" | jq -r '.slide_count // 0')
W_PT=$(echo "$INFO_RESULT" | jq -r '.w_pt // 0')
H_PT=$(echo "$INFO_RESULT" | jq -r '.h_pt // 0')

if [[ "$SLIDE_COUNT" -eq 0 ]] || [[ "$W_PT" -eq 0 ]] || [[ "$H_PT" -eq 0 ]]; then
    jq -n --arg reason "ppt_is_empty" --argjson sc "$SLIDE_COUNT" --argjson w "$W_PT" --argjson h "$H_PT" \
        '{action:"write_design_md",reason:$reason,slide_count:$sc,w_pt:$w,h_pt:$h}'
    exit 0
fi

CONTENT_PAGE_COUNT=0

for i in $(seq 0 $((SLIDE_COUNT - 1))); do
    PAGE_ARGS=$(echo "$BASE_ARGS" | jq --argjson idx "$i" '. + {page_index: $idx}')
    PAGE_RESULT=$(_call_slide_tool slide_get_page_info "$PAGE_ARGS") || continue

    HAS_CONTENT=$(echo "$PAGE_RESULT" | jq '
        [.shapes // [] | .[] | select((.text // "") | gsub("[\\s\\r\\n]"; "") != "")] | length > 0
    ' 2>/dev/null || echo "false")

    [[ "$HAS_CONTENT" == "true" ]] && CONTENT_PAGE_COUNT=$((CONTENT_PAGE_COUNT + 1))
done

if [[ "$CONTENT_PAGE_COUNT" -eq 0 ]]; then
    jq -n --arg reason "ppt_content_is_empty" --argjson sc "$SLIDE_COUNT" --argjson w "$W_PT" --argjson h "$H_PT" --argjson cpc "$CONTENT_PAGE_COUNT" \
        '{action:"write_design_md",reason:$reason,slide_count:$sc,w_pt:$w,h_pt:$h,content_page_count:$cpc}'
    exit 0
fi

DESIGN_RESULT=$(_call_slide_tool slide_get_design "$BASE_ARGS") || {
    echo "ERROR:slide_get_design_failed"
    exit 1
}

DESIGN_EXISTS=$(echo "$DESIGN_RESULT" | jq -r '.exists // false')
DESIGN_MD=$(echo "$DESIGN_RESULT" | jq -r '.design_md // ""')

if [[ "$DESIGN_EXISTS" == "false" ]] || [[ -z "$DESIGN_MD" ]] || [[ "$DESIGN_MD" == '""' ]]; then
    jq -n --arg reason "design_is_empty" --argjson sc "$SLIDE_COUNT" --argjson w "$W_PT" --argjson h "$H_PT" --argjson cpc "$CONTENT_PAGE_COUNT" --argjson de "$DESIGN_EXISTS" \
        '{action:"write_design_md",reason:$reason,slide_count:$sc,w_pt:$w,h_pt:$h,content_page_count:$cpc,design_exists:$de}'
    exit 0
fi

DESIGN_MD_LEN=${#DESIGN_MD}
UPDATED_AT=$(echo "$DESIGN_RESULT" | jq -r '.updated_at // "0"')

jq -n --argjson sc "$SLIDE_COUNT" --argjson w "$W_PT" --argjson h "$H_PT" --argjson cpc "$CONTENT_PAGE_COUNT" --argjson de "$DESIGN_EXISTS" --argjson dml "$DESIGN_MD_LEN" --arg ua "$UPDATED_AT" \
    '{action:"proceed_next",reason:"design_exists",slide_count:$sc,w_pt:$w,h_pt:$h,content_page_count:$cpc,design_exists:$de,design_md_length:$dml,updated_at:$ua}'
