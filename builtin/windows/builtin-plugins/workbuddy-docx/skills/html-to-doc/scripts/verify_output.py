#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_output.py —— S3 落盘后的完整校验（内容完整性 + 目录版式结构）。

背景（实测 2026-09-15）：引擎存在两处状态相关的偶发行为——
  1. 内容完整性兜底（历史版本曾出现转换丢段，现已覆盖引擎一次转换路径）；
  2. section_break / insert 交互偶发产生错误节结构（"目录"标题段被挂上 sectPr
     成为独立节尾，与 TOC 分隔两页；或拆出空白空节）。
同输入同序列不同运行结果不同，链路侧以"落盘后确定性校验 + 失败整体重跑"闭环兜底。

用法：
    python3 verify_output.py --html <S2产物.html> --docx <输出.docx> [--require-toc]

校验项：
    C-1 内容完整性：HTML 全部非空段落（p/h1-h6/li/td）特征逐段在 docx 中存在
    （--require-toc 时附加）：
    S-1 "目录"标题段存在（outlineLvl 段、文本=目录），且其后紧邻出现 TOC 域
        （instrText 含 TOC）——标题与 TOC 不得被节边界/整页分隔
    S-2 TOC 域指令存在（instrText 含 "TOC"）且 PAGEREF>0（域未被切断）
    S-3 封面与"目录"标题之间无空节段落（无"空段挂 sectPr"结构）
    S-4 正文节页码重起（存在 w:pgNumType w:start="1"）
    S-6 标题样式绑定：HTML h1~h3 对应文本的 docx 段落须挂 Heading 样式
        （引擎默认只写 outlineLvl 不绑样式——Word 中标题显示"正文"，实测 2026-09-15）

输出：JSON（stdout）
    {"passed": bool, "content": {...}, "structure": {...}, "issues": [...]}

退出码：0=通过；1=校验失败（S3 应整体重跑一次，再败如实报错）；2=输入错误
纯 Python 3 标准库。
"""
from __future__ import annotations

import argparse
import html as _html
import json
import logging
import re
import sys
import zipfile
from typing import NamedTuple

logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s", stream=sys.stderr)

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_EMPTY_SECT_RE = re.compile(r"<w:p\b[^>]*>\s*<w:pPr>\s*<w:sectPr")
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
# (?<!/) 排除自闭合 <li/>（自闭合无配对闭合标签，入栈会导致栈残留）
_LI_OPEN_RE = re.compile(r"<li\b[^>]*(?<!/)>", re.I)
_LI_CLOSE_RE = re.compile(r"</li\s*>", re.I)
_LIST_BLOCK_RE = re.compile(r"<(ol|ul)\b[^>]*>.*?</\1>", re.S | re.I)


class _LiEvent(NamedTuple):
    pos: int          # 标签起始偏移
    is_open: bool     # True=开标签，False=闭标签
    after_open: int   # 开标签结束偏移（闭标签恒 0）


def _li_inners(body: str) -> list[str]:
    """平衡扫描提取每个 <li> 的完整内容（按开/闭计数配对，含嵌套各层）。

    正则非贪婪 `(.*?)</li>` 遇嵌套列表会在内层 </li> 提前截断：外层 li
    的捕获片段缺嵌套 <ol> 的闭合标签，无法剔除子块 → 父+子文本拼接成
    docx 里不存在的假特征（实测 2026-09-17：嵌套 TOC 二级条目 C-1 误报）。
    每层 li 各自产出 inner：外层含嵌套块（由调用方剔除），内层独立——
    父/子条目均成为可校验特征。
    未闭合的外层 li 无法定位内容边界，不产特征并告警（stderr）——
    残段截断位置任意会产生假特征，宁可告警不静默。
    """
    events = [_LiEvent(m.start(), True, m.end()) for m in _LI_OPEN_RE.finditer(body)]
    events += [_LiEvent(m.start(), False, 0) for m in _LI_CLOSE_RE.finditer(body)]
    events.sort()
    out, stack = [], []  # stack: [(open_pos, inner_start)]
    for ev in events:
        if ev.is_open:
            stack.append((ev.pos, ev.after_open))
        elif stack:
            _, inner_start = stack.pop()
            out.append(body[inner_start:ev.pos])
        else:
            logging.debug("多余 </li>（无对应开标签，偏移 %d），已忽略", ev.pos)
    if stack:
        preview = _WS_RE.sub("", _TAG_RE.sub("", body[stack[-1][1]:stack[-1][1] + 40]))
        logging.warning(
            "%d 个 <li> 未闭合（开标签偏移: %s），其内容未纳入 C-1 特征；"
            "最后一个起始片段: %s…",
            len(stack),
            ", ".join(str(p) for p, _ in stack),
            preview[:20],
        )
    return out


def html_paragraph_feats(html: str) -> list[str]:
    m = re.search(r"<body[^>]*>(.*?)</body>", html, re.S | re.I)
    body = m.group(1) if m else html
    body = _HTML_COMMENT_RE.sub("", body)
    body = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", body, flags=re.S | re.I)
    feats = []
    # li 用平衡扫描单独提取（见 _li_inners）；其余标签正则非嵌套，维持 finditer
    inners = [(t.group(2)) for t in re.finditer(
        r"<(p|h[1-6]|td|blockquote|math)\b[^>]*>(.*?)</\1>", body, re.S | re.I)]
    inners += [i for i in _li_inners(body)]
    for inner in inners:
        # li 先剔除嵌套列表块（完整闭合），只留直接文本——父/子条目各自独立成特征
        inner = _LIST_BLOCK_RE.sub("", inner)
        # 实体解码放在标签剔除之后——先对整个 body unescape 会把文本节点的
        # &lt;/&gt; 转成真实尖括号，干扰标签边界匹配/被误当子标签剔除（AI 评审
        # 2026-09-16）。解码仍是必须的：引擎把实体转为真实字符（&nbsp;→U+00A0），
        # 不解码特征串与 docx 文本不匹配会误报 C-1（实测 2026-09-16）
        text = _WS_RE.sub("", _html.unescape(_TAG_RE.sub("", inner)))
        if len(text) >= 8:
            feats.append(text[:16])
    return feats


def check(args) -> dict:
    issues = []
    try:
        # --html 支持逗号分隔多文件（兼容能力；主路径为单文件完整 HTML）
        html_parts = []
        for p in str(args.html).split(","):
            p = p.strip()
            if p:
                html_parts.append(open(p, encoding="utf-8", errors="replace").read())
        html = "\n".join(html_parts)
        doc = zipfile.ZipFile(args.docx).read("word/document.xml").decode("utf-8", "ignore")
    except OSError as e:
        print(json.dumps({"passed": False, "error": f"输入读取失败: {e}"}, ensure_ascii=False))
        sys.exit(2)

    # ---- C-1 内容完整性 ----
    feats = html_paragraph_feats(html)
    if not feats:
        # 空 HTML/结构异常提取不到特征时不得静默通过（verify_content 评审修复随合并带入）
        issues.append("[C-1] HTML 未提取到任何段落特征（文件为空或结构异常），无法校验内容完整性")
    plain = _WS_RE.sub("", _TAG_RE.sub("", doc))
    missing = [f for f in feats if f not in plain]
    content = {"total": len(feats), "missing_count": len(missing), "missing": missing[:10]}
    if missing:
        issues.append(
            f"[C-1] 内容缺失 {len(missing)}/{len(feats)} 段（转换丢段）："
            + "; ".join(missing[:3])
        )

    structure = {}
    # 标题样式 ID 集合：styles.xml 中含 outlineLvl 或名称含 heading/标题 的样式
    # （引擎为 level=N 生成随机样式 ID，大纲级别在样式定义里而非段落上）——
    # S-6 对所有文档校验，构建不依赖 --require-toc
    heading_style_ids = set()
    try:
        styles = zipfile.ZipFile(args.docx).read("word/styles.xml").decode("utf-8", "ignore")
        for sm in re.finditer(r'<w:style [^>]*w:styleId="([^"]+)"[^>]*>(.*?)</w:style>', styles, re.S):
            sid, sbody = sm.group(1), sm.group(2)
            if "outlineLvl" in sbody or re.search(r'w:val="[^\"]*[Hh]eading', sbody):
                heading_style_ids.add(sid)
    except (OSError, KeyError):
        pass
    structure["heading_style_count"] = len(heading_style_ids)
    if args.require_toc:
        # 定位"目录"标题段（nav.doc-toc 的 toc-title 转为普通段，只按文本匹配；
        # 排除 TOC 条目段——条目含 PAGEREF 域）
        title_span = None
        for m in re.finditer(r"<w:p\b[^>]*>((?:(?!</w:p>).)*?)</w:p>", doc, re.S):
            seg = m.group(0)
            if "PAGEREF" in seg or "instrText" in seg:
                continue
            txt = _WS_RE.sub("", "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", seg)))
            if txt == "目录":
                title_span = (m.start(), m.end())
                break
        structure["toc_title_found"] = title_span is not None
        if not title_span:
            issues.append("[S-1] 未找到「目录」标题段（outlineLvl 段、文本=目录）")
        else:
            # 标题段与 TOC 域之间不得有节边界（sectPr）或超长间隔
            after = doc[title_span[1]:]
            i_instr = after.find("TOC")
            instr_m = re.search(r"<w:instrText[^>]*>[^<]*TOC", after)
            gap = doc[title_span[1]:title_span[1] + (instr_m.start() if instr_m else 4000)]
            sect_between = gap.count("sectPr")
            structure["sect_between_title_and_toc"] = sect_between
            if not instr_m:
                issues.append("[S-1] 「目录」标题后未找到 TOC 域指令（域丢失或被切断）")
            elif sect_between > 0:
                issues.append(
                    f"[S-1] 「目录」标题与 TOC 域之间有 {sect_between} 个节边界——"
                    "标题与目录内容被分节隔成两页（引擎 section_break 偶发错位）"
                )

        # S-2 TOC 域
        has_toc_field = bool(re.search(r"<w:instrText[^>]*>[^<]*TOC", doc))
        pageref = doc.count("PAGEREF")
        structure["toc_field"] = has_toc_field
        structure["pageref_count"] = pageref
        if not has_toc_field or pageref == 0:
            issues.append("[S-2] TOC 域不完整（instrText 或 PAGEREF 缺失——域被切断）")

        # S-3 封面与目录之间无"真空节"（相邻两个 sectPr 之间无任何文本内容）
        if title_span:
            sects = [m for m in re.finditer(r"<w:sectPr", doc)]
            empty_real = 0
            for k in range(len(sects) - 1):
                if sects[k + 1].start() >= title_span[0]:
                    break
                gap = doc[sects[k].end():sects[k + 1].start()]
                texts = re.findall(r"<w:t[^>]*>([^<]*)</w:t>", gap)
                if not any(t.strip() for t in texts):
                    empty_real += 1
            structure["empty_section_before_toc"] = empty_real
            if empty_real:
                issues.append("[S-3] 封面与目录之间存在真空节（相邻分节符间无内容——空白页来源）")

            # S-7 封面内容与目录必须分节：目录标题段之前，最近分节符之后不得
            # 残留内容段——nav 与封面内容同 section 时无分节符，封面与目录连排
            # 同页（实测 2026-09-17：agent 按旧示例把 nav 放进封面 section）
            before = doc[: title_span[0]]
            last_sect_end = before.rfind("</w:sectPr>")
            # 分节并入前段形态（引擎合法形态）：sectPr 位于封面末段 w:pPr 内部，
            # 该段的文本 run 在 sectPr 之后的 XML 位置——同段文本属于封面节，
            # 不算泄漏；只扫分节段落结束（</w:p>）之后的内容
            if last_sect_end >= 0:
                para_end = before.find("</w:p>", last_sect_end)
                scan_from = para_end + len("</w:p>") if para_end >= 0 else last_sect_end + 11
            else:
                scan_from = 0
            head = before[scan_from:]
            cover_leak = [t for t in re.findall(r"<w:t[^>]*>([^<]*)</w:t>", head) if t.strip()]
            structure["cover_toc_sectioned"] = not cover_leak
            if cover_leak:
                issues.append(
                    f"[S-7] 目录标题前有 {len(cover_leak)} 个内容段未分节——封面与目录连排同页"
                    "（nav.doc-toc 须独占一个 cover section，不得与封面内容同节）"
                )

        # S-4 正文页码正确：正文节 pgNumType start∈{0,1}（0=目录页占第0页不显示，
        # 正文第一页=1；1=目录独立节重起），且目录页无页眉页脚（titlePg 在目录所在节）
        start0 = 'w:start="0"' in doc
        start1 = 'w:start="1"' in doc
        structure["body_start0"] = start0
        structure["body_start1"] = start1
        structure["titlePg"] = "titlePg" in doc
        if not (start0 or start1):
            issues.append("[S-4] 正文节未设置页码重起（pgNumType start=0/1 均缺失）")
        elif start0 and "titlePg" not in doc:
            issues.append("[S-4] start=0 方案要求 titlePg（目录页=正文节第一页无页眉页脚）")

        # S-5 正文第一段另起页：TOC 域之后第一个真身标题段，其之前存在节边界
        # （sectPr，正文新节 nextPage 自然另起页）或该段自身带 pageBreakBefore
        toc_field_m = re.search(r"<w:instrText[^>]*>[^<]*TOC", doc)
        search_from = toc_field_m.end() if toc_field_m else 0
        first_body_h1 = None
        for m in re.finditer(r"<w:p\b[^>]*>((?:(?!</w:p>).)*?)</w:p>", doc, re.S):
            if m.start() < search_from:
                continue
            seg = m.group(0)
            if "outlineLvl" in seg and "PAGEREF" not in seg:
                first_body_h1 = m
                break
        pb = bool(first_body_h1 and "pageBreakBefore" in first_body_h1.group(0))
        sect_before = bool(
            first_body_h1 and "<w:sectPr" in doc[search_from:first_body_h1.start()]
        )
        structure["body_first_h1_page_break"] = pb
        structure["body_first_h1_new_section"] = sect_before
        if first_body_h1 and not (pb or sect_before):
            issues.append("[S-5] 正文第一段标题既无前置节边界也无 pageBreakBefore（正文与目录连排同页）")

        # S-8 目录后内容分节：TOC 域之后、下一分节符之前不得出现内容段
        # （目录块独占一节；摘要等前置内容与正文另节排布）
        if toc_field_m:
            scan_end = doc.find("<w:sectPr", toc_field_m.end())
            scope = doc[toc_field_m.end():scan_end] if scan_end > 0 else doc[toc_field_m.end():]
            toc_tail_leak = []
            for pm in re.finditer(r"<w:p\b[^>]*>((?:(?!</w:p>).)*?)</w:p>", scope, re.S):
                seg = pm.group(0)
                if "PAGEREF" in seg or "instrText" in seg:
                    continue
                txt = _WS_RE.sub("", "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", seg)))
                if txt:
                    toc_tail_leak.append(txt[:12])
            structure["toc_tail_sectioned"] = not toc_tail_leak
            if toc_tail_leak:
                issues.append(
                    f"[S-8] 目录之后有 {len(toc_tail_leak)} 个内容段未分节——目录与后续内容连排同页"
                    "（目录块须独占一节，摘要/正文另节）"
                )

    # S-6 标题样式绑定：HTML h1~h3 对应段落须挂 Heading 样式（pStyle ∈ 含
    # outlineLvl 的样式集合——TOC 条目段 pStyle=TOC1 不在集合，不误判）
    heading_feats = []
    for m in re.finditer(r"<(h[1-3])[^>]*>(.*?)</\1>", html, re.S | re.I):
        t = _WS_RE.sub("", _html.unescape(_TAG_RE.sub("", m.group(2))))
        if len(t) >= 4:
            heading_feats.append(t[:14])
    if heading_feats:
        styled = 0
        sample_missing = []
        for feat in heading_feats:
            found_styled = False
            for pm in re.finditer(r"<w:p\b[^>]*>((?:(?!</w:p>).)*?)</w:p>", doc, re.S):
                seg = pm.group(0)
                if feat not in _WS_RE.sub("", "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", seg))):
                    continue
                ps = re.search(r'<w:pStyle w:val="([^"]+)"', seg)
                if ps and ps.group(1) in heading_style_ids:
                    found_styled = True
                    break
            if found_styled:
                styled += 1
            else:
                sample_missing.append(feat)
        structure["heading_style_bound"] = f"{styled}/{len(heading_feats)}"
        if sample_missing and styled < len(heading_feats):
            issues.append(
                f"[S-6] {len(heading_feats) - styled}/{len(heading_feats)} 个标题未绑 Heading 样式"
                f"（Word 中显示'正文'，需 doc_apply_named_style 兜底，见 Skill ④f）："
                + "; ".join(sample_missing[:3])
            )

    passed = not issues
    return {"passed": passed, "content": content, "structure": structure, "issues": issues}


def main() -> int:
    ap = argparse.ArgumentParser(description="S3 落盘后完整校验（内容+结构）")
    ap.add_argument("--html", required=True)
    ap.add_argument("--docx", required=True)
    ap.add_argument("--require-toc", action="store_true", help="启用目录结构校验（S-1~S-7）")
    ap.add_argument("-v", "--verbose", action="store_true", help="输出 debug 日志（HTML 解析异常排查）")
    args = ap.parse_args()
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)
    report = check(args)
    sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
    sys.stdout.write("\n")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
