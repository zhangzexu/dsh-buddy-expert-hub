#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""docx2html.py — 纯 Python 的 DOCX → 语义化 HTML 提取器。

本文件是 format-extract 技能的**转换内核**，替代原始插件里缺失的 Node 打包产物
（`cli.cjs`，该产物在任何分发中都不存在）。对外契约与原 CLI 保持一致：

  python3 docx2html.py convert --input <docx> --output <html> [--image-base-url images]
  python3 docx2html.py convert --input-dir <dir> --output-dir <dir> [--image-base-url images]
  python3 docx2html.py assess <html-file> [--output <report-path>]
  python3 docx2html.py --version

设计约束（与原实现对齐）：
  * 输出根内容容器固定为 `<article class="docx-content">`；
  * 内联样式只允许白名单属性：color / background-color / text-align /
    text-decoration / font-weight / font-style / max-width；
  * 不输出 `mso-*` 属性、`MsoXxx` 类名、空 `<span>`；
  * 表格保留合并单元格（colspan / rowspan）；
  * 图片抽取到 `<image-base-url>` 指向的目录，src 用相对路径。

超出白名单的排版事实（字号、字体名、缩进）不写进 style，而以 `data-*`
属性附带，供下游分析——这样既能被下游读取，又不污染 assess 的白名单检查。

退出码：0 成功；1 失败；2 参数错误。
"""

from __future__ import annotations

import json
import os
import re
import sys
import zipfile
from datetime import datetime, timezone
from html import escape
from html.parser import HTMLParser
from pathlib import Path

VERSION = "1.0.0-py"

STYLE_WHITELIST = {
    "color",
    "background-color",
    "text-align",
    "text-decoration",
    "font-weight",
    "font-style",
    "max-width",
}

ALIGN_MAP = {
    "LEFT": "left",
    "CENTER": "center",
    "RIGHT": "right",
    "JUSTIFY": "justify",
    "DISTRIBUTE": "justify",
}

HEADING_RE = re.compile(r"^(?:heading|标题)\s*([1-9])$", re.I)
TITLE_NAMES = {"title", "标题"}
SUBTITLE_NAMES = {"subtitle", "副标题"}

W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# w:highlight（Word 的「高亮」）只有这套固定 16 色，与 w:shd（底纹）是两套机制。
HIGHLIGHT_RGB = {
    "yellow": "ffff00",
    "brightgreen": "00ff00",
    "turquoise": "00ffff",
    "pink": "ff00ff",
    "blue": "0000ff",
    "red": "ff0000",
    "darkblue": "000080",
    "darkred": "800000",
    "darkgreen": "008000",
    "violet": "800080",
    "darkyellow": "808000",
    "teal": "008080",
    "gray25": "c0c0c0",
    "gray50": "808080",
    "black": "000000",
    "white": "ffffff",
}


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


# ---------------------------------------------------------------- 工具


def _rgb(color) -> str | None:
    """把 python-docx 的 ColorFormat 转成 #rrggbb；无有效值时返回 None。"""
    try:
        if color is None or color.rgb is None:
            return None
        return "#" + str(color.rgb).lower()
    except (AttributeError, ValueError, TypeError):
        return None


def _shading(el) -> str | None:
    """从 rPr/pPr 下的 w:shd 读底纹填充色。"""
    try:
        shd = el.find(
            "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}shd"
        )
        if shd is None:
            return None
        fill = shd.get(
            "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}fill"
        )
        if not fill or fill.lower() in ("auto", "ffffff", "none"):
            return None
        return "#" + fill.lower()
    except Exception:
        return None


def _highlight(run_el) -> str | None:
    """
    读 run 的 w:highlight（Word「高亮」）。

    与 w:shd（底纹/背景色）**不是同一套机制**：Word 界面的「文本突出显示颜色」
    写的是 w:highlight，只有固定 16 色；w:shd 才是任意色值的底纹。两者都要认，
    否则大量真实文档的黄色高亮会整段丢失。
    """
    try:
        rpr = run_el.find(f"{W_NS}rPr")
        if rpr is None:
            return None
        hl = rpr.find(f"{W_NS}highlight")
        if hl is None:
            return None
        val = (hl.get(f"{W_NS}val") or "").strip().lower()
        val = val.replace("-", "").replace("_", "")
        rgb = HIGHLIGHT_RGB.get(val)
        return "#" + rgb if rgb else None
    except Exception:
        return None


def _style_attr(props: dict[str, str]) -> str:
    """序列化白名单内的样式属性；空则返回空串。"""
    items = [(k, v) for k, v in props.items() if k in STYLE_WHITELIST and v]
    if not items:
        return ""
    return ' style="' + ";".join(f"{k}:{v}" for k, v in items) + '"'


def _data_attrs(pairs: dict[str, str]) -> str:
    out = "".join(
        f' {k}="{escape(str(v), quote=True)}"' for k, v in pairs.items() if v
    )
    return out


# ---------------------------------------------------------------- 图片抽取


class ImageExtractor:
    """按出现顺序抽取内嵌图片，落盘到 images 目录。"""

    EXT_BY_TYPE = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/gif": "gif",
        "image/bmp": "bmp",
        "image/tiff": "tif",
        "image/x-emf": "emf",
        "image/x-wmf": "wmf",
        "image/svg+xml": "svg",
    }

    def __init__(self, doc, image_base_url: str, images_dir: Path | None) -> None:
        self.doc = doc
        self.base = image_base_url.rstrip("/")
        self.images_dir = images_dir
        self.saved: list[tuple[str, bytes]] = []
        self._cache: dict[str, str] = {}
        self._n = 0

    def resolve(self, rid: str) -> str | None:
        """把 r:embed 关系 id 换成 <img src>；失败返回 None。"""
        if not rid:
            return None
        if rid in self._cache:
            return self._cache[rid]
        try:
            part = self.doc.part.related_parts[rid]
        except (KeyError, AttributeError):
            return None
        blob = getattr(part, "blob", None)
        if not blob:
            return None
        self._n += 1
        ext = self.EXT_BY_TYPE.get(getattr(part, "content_type", ""), "png")
        name = f"image{self._n}.{ext}"
        if self.images_dir is not None:
            try:
                (self.images_dir / name).write_bytes(blob)
            except OSError as e:  # 落盘失败不阻塞转换
                log(f"⚠️ 图片写入失败 {name}: {e}")
        self.saved.append((name, blob))
        src = f"{self.base}/{name}" if self.base else name
        self._cache[rid] = src
        return src


# ---------------------------------------------------------------- Run / Paragraph


def render_run(run, img: ImageExtractor) -> str:
    """渲染一个 run：文本 / 图片 / 制表符。"""
    from docx.oxml.ns import qn

    parts: list[str] = []

    # 图片：w:drawing//a:blip@r:embed
    for blip in run._element.findall(".//" + qn("a:blip")):
        rid = blip.get(qn("r:embed"))
        src = img.resolve(rid)
        if src:
            parts.append(f'<img src="{escape(src, quote=True)}" alt="">')

    text = run.text or ""
    if text:
        props: dict[str, str] = {}
        font = run.font
        if run.bold:
            props["font-weight"] = "700"
        if run.italic:
            props["font-style"] = "italic"
        deco = []
        if run.underline:
            deco.append("underline")
        if run.font.strike:
            deco.append("line-through")
        if deco:
            props["text-decoration"] = " ".join(deco)
        color = _rgb(font.color)
        if color:
            props["color"] = color
        # 背景色：w:shd（任意色底纹）优先，其次 w:highlight（16 色高亮）
        rpr = run._element.find(qn("w:rPr"))
        bg = _shading(rpr) if rpr is not None else None
        if not bg:
            bg = _highlight(run._element)
        if bg:
            props["background-color"] = bg

        data: dict[str, str] = {}
        try:
            if font.size is not None:
                data["data-size-pt"] = f"{font.size.pt:g}"
            if font.name:
                data["data-font"] = font.name
        except (AttributeError, TypeError):
            pass

        body = escape(text).replace("\t", "&#9;").replace("\n", "<br>")
        style = _style_attr(props)
        extra = _data_attrs(data)
        if style or extra:
            parts.append(f"<span{style}{extra}>{body}</span>")
        else:
            parts.append(body)

    return "".join(parts)


def _heading_level(paragraph) -> int | None:
    try:
        name = (paragraph.style.name or "").strip()
    except AttributeError:
        return None
    m = HEADING_RE.match(name)
    if m:
        return int(m.group(1))
    if name.lower() in TITLE_NAMES:
        return 1
    return None


def _list_kind(paragraph) -> str | None:
    """返回 'ul' / 'ol' / None。"""
    try:
        name = (paragraph.style.name or "").lower()
    except AttributeError:
        return None
    if "list bullet" in name or "列表段落" in name:
        return "ul"
    if "list number" in name:
        return "ol"
    # 直接来自 numbering.xml 的编号
    ppr = paragraph._p.find("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}pPr")
    if ppr is not None:
        num = ppr.find("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}numPr")
        if num is not None:
            return "ol"
    return None


def render_paragraph(paragraph, img: ImageExtractor) -> tuple[str, str | None]:
    """返回 (html, list_kind)。list_kind 非空表示该段是列表项。"""
    inner = "".join(render_run(r, img) for r in paragraph.runs)
    if not inner.strip():
        # 空段落：保留为一个空 <p> 以还原段间距
        return "<p></p>", None

    props: dict[str, str] = {}
    if paragraph.alignment is not None:
        name = getattr(paragraph.alignment, "name", str(paragraph.alignment))
        if name in ALIGN_MAP:
            props["text-align"] = ALIGN_MAP[name]

    data: dict[str, str] = {}
    try:
        pf = paragraph.paragraph_format
        if pf.left_indent is not None:
            data["data-indent-left-pt"] = f"{pf.left_indent.pt:g}"
        if pf.first_line_indent is not None:
            data["data-indent-first-line-pt"] = f"{pf.first_line_indent.pt:g}"
        if pf.space_before is not None:
            data["data-space-before-pt"] = f"{pf.space_before.pt:g}"
        if pf.space_after is not None:
            data["data-space-after-pt"] = f"{pf.space_after.pt:g}"
        if pf.line_spacing is not None:
            data["data-line-spacing"] = f"{pf.line_spacing}"
    except (AttributeError, TypeError):
        pass

    kind = _list_kind(paragraph)
    style = _style_attr(props)
    extra = _data_attrs(data)

    if kind:
        return f"<li{style}{extra}>{inner}</li>", kind

    level = _heading_level(paragraph)
    if level:
        return f"<h{level}{style}{extra}>{inner}</h{level}>", None

    try:
        style_name = (paragraph.style.name or "").strip()
    except AttributeError:
        style_name = ""
    if style_name.lower() in SUBTITLE_NAMES:
        return f'<p class="docx-subtitle"{style}{extra}>{inner}</p>', None

    return f"<p{style}{extra}>{inner}</p>", None


# ---------------------------------------------------------------- Table


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _cell_html(cell, img: ImageExtractor) -> str:
    """
    渲染单元格内容：逐 run 走 render_run，保留字体色 / 加粗 / 底纹 / 内联图片。

    早期实现只是 `''.join(w:t)` 拼纯文本，会把单元格内的颜色、加粗和图片全部
    拍平 —— 而表格恰恰是最需要保留格式的区域，故改为与正文同一套渲染。
    段落间用 <br> 分隔。
    """
    try:
        paragraphs = cell.paragraphs
    except Exception:
        return ""
    chunks: list[str] = []
    for para in paragraphs:
        try:
            inner = "".join(render_run(r, img) for r in para.runs)
        except Exception:
            inner = escape(para.text or "")
        if inner.strip():
            chunks.append(inner)
    return "<br>".join(chunks)


def render_table(table, img: ImageExtractor) -> str:
    """渲染表格，处理 gridSpan（colspan）、vMerge（rowspan）、单元格底纹。"""
    rows = table._tbl.findall(f"{W}tr")
    if not rows:
        return ""

    try:
        from docx.table import _Cell as _CellCls
    except ImportError:  # python-docx 版本差异
        from docx.table import Cell as _CellCls

    grid: list[list[dict]] = []
    for tr in rows:
        line: list[dict] = []
        for tc in tr.findall(f"{W}tc"):
            tcpr = tc.find(f"{W}tcPr")
            span = 1
            vmerge = None
            if tcpr is not None:
                gs = tcpr.find(f"{W}gridSpan")
                if gs is not None:
                    try:
                        span = max(1, int(gs.get(f"{W}val", "1")))
                    except (TypeError, ValueError):
                        span = 1
                vm = tcpr.find(f"{W}vMerge")
                if vm is not None:
                    vmerge = vm.get(f"{W}val", "continue")
            # 单元格底纹（w:tcPr/w:shd）——表头浅蓝、强调行浅黄都靠它
            shade = _shading(tcpr) if tcpr is not None else None
            try:
                html = _cell_html(_CellCls(tc, table), img)
            except Exception:
                html = escape("".join(t.text or "" for t in tc.iter(f"{W}t")))
            line.append({
                "html": html,
                "span": span,
                "vmerge": vmerge,
                "style": {"background-color": shade} if shade else {},
            })
        grid.append(line)

    # 计算 rowspan：向下数连续的 vMerge=continue
    total_cols = max((sum(c["span"] for c in r) for r in grid), default=0)
    out: list[str] = ['<table>']
    for ri, line in enumerate(grid):
        # 表头判定：显式 w:tblHeader 优先；否则多行表的第一行当表头
        trpr = rows[ri].find(f"{W}trPr")
        explicit_header = (
            trpr is not None and trpr.find(f"{W}tblHeader") is not None
        )
        is_header = explicit_header or (ri == 0 and len(rows) > 1 and total_cols > 0)
        out.append("<tr>")
        for ci, cell in enumerate(line):
            if cell["vmerge"] == "continue":
                continue  # 被上方单元格跨行覆盖，不输出
            rowspan = 1
            if cell["vmerge"] == "restart":
                for rj in range(ri + 1, len(grid)):
                    nxt = grid[rj][ci] if ci < len(grid[rj]) else None
                    if nxt is not None and nxt["vmerge"] == "continue":
                        rowspan += 1
                    else:
                        break
            attrs = ""
            if cell["span"] > 1:
                attrs += f' colspan="{cell["span"]}"'
            if rowspan > 1:
                attrs += f' rowspan="{rowspan}"'
            attrs += _style_attr(cell["style"])
            tag = "th" if is_header else "td"
            out.append(f"<{tag}{attrs}>{cell['html'] or ''}</{tag}>")
        out.append("</tr>")
    out.append("</table>")
    return "".join(out)


# ---------------------------------------------------------------- 主转换


def convert_docx(docx_path: Path, image_base_url: str, images_dir: Path | None) -> str:
    """把 docx 转成 HTML 字符串。"""
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(str(docx_path))
    img = ImageExtractor(doc, image_base_url, images_dir)

    body = doc.element.body
    pieces: list[str] = []
    open_list: str | None = None

    def close_list() -> None:
        nonlocal open_list
        if open_list:
            pieces.append(f"</{open_list}>")
            open_list = None

    for child in body.iterchildren():
        tag = child.tag
        if tag == f"{W}p":
            html, kind = render_paragraph(Paragraph(child, doc), img)
            if kind:
                if open_list != kind:
                    close_list()
                    pieces.append(f"<{kind}>")
                    open_list = kind
                pieces.append(html)
            else:
                close_list()
                pieces.append(html)
        elif tag == f"{W}tbl":
            close_list()
            pieces.append(render_table(Table(child, doc), img))
        # sectPr 等忽略
    close_list()

    title = ""
    try:
        title = (doc.core_properties.title or "").strip()
    except Exception:
        title = ""

    head = (
        "<!DOCTYPE html>\n"
        '<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
        f"<title>{escape(title) or docx_path.stem}</title>\n"
        "<style>\n"
        "body{margin:0;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;"
        "line-height:1.7;color:#1a1a1a;background:#fff}\n"
        ".docx-content{max-width:820px;margin:0 auto}\n"
        ".docx-content table{border-collapse:collapse;width:100%;margin:12px 0}\n"
        ".docx-content th,.docx-content td{border:1px solid #d0d0d0;padding:6px 10px;"
        "vertical-align:top;text-align:left}\n"
        ".docx-content img{max-width:100%;height:auto}\n"
        ".docx-subtitle{color:#555}\n"
        "</style>\n</head>\n<body>\n"
    )
    return head + '<article class="docx-content">\n' + "\n".join(pieces) + "\n</article>\n</body>\n</html>\n"


# ---------------------------------------------------------------- assess


class _Collector(HTMLParser):
    """收集标签平衡、style 属性、文本量、空 span。"""

    VOID = {"br", "img", "hr", "meta", "link", "input", "col"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.unclosed: list[str] = []
        self.mismatched: list[str] = []
        self.styles: list[str] = []
        self.text_len = 0
        self.markup_len = 0
        # 只统计「表现层」标记（span 标签 + style 属性）。结构标签（table/tr/td/p/
        # h1-6/ul/li/br）属于内容结构，不是样式噪声 —— 表格一多就把它们算进噪声，
        # 会让表格型文档必然判负，那是度量本身的假阴性。
        self.style_len = 0
        self.empty_spans = 0
        self._span_open: int | None = None
        self._span_text = 0
        self.articles: list[dict[str, str]] = []
        self.classes: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        tag_text = self.get_starttag_text() or ""
        self.markup_len += len(tag_text)
        if tag == "span":
            # 开 + 闭标签都算表现层成本
            self.style_len += len(tag_text) + len("</span>")
        elif "style" in a:
            # 结构标签上的内联样式：只计 style 属性本身
            self.style_len += len(a["style"]) + len('style=""')
        if tag not in self.VOID:
            self.stack.append(tag)
        if "style" in a:
            self.styles.append(a["style"])
        if "class" in a:
            self.classes.append(a["class"])
        if tag == "article":
            self.articles.append(a)
        if tag == "span":
            self._span_open = len(self.stack)
            self._span_text = 0

    def handle_endtag(self, tag):
        self.markup_len += len(tag) + 3
        if tag == "span" and self._span_open is not None:
            if self._span_text == 0:
                self.empty_spans += 1
            self._span_open = None
        if tag in self.VOID:
            return
        if self.stack and self.stack[-1] == tag:
            self.stack.pop()
        elif tag in self.stack:
            while self.stack and self.stack[-1] != tag:
                self.mismatched.append(self.stack.pop())
            if self.stack:
                self.stack.pop()
        else:
            self.mismatched.append(tag)

    def handle_data(self, data):
        if data.strip():
            self.text_len += len(data.strip())
            if self._span_open is not None:
                self._span_text += len(data.strip())


def assess_html(html: str, label: str) -> dict:
    col = _Collector()
    col.feed(html)
    col.unclosed = list(col.stack)

    checks: list[dict] = []

    # 1. 结构化校验
    art = [a for a in col.articles if "docx-content" in a.get("class", "")]
    ok1 = len(art) == 1 and not col.unclosed and not col.mismatched
    detail1 = []
    if len(art) != 1:
        detail1.append(f'<article class="docx-content"> 数量 = {len(art)}（应为 1）')
    if col.unclosed:
        detail1.append(f"未闭合标签: {', '.join(col.unclosed[:5])}")
    if col.mismatched:
        detail1.append(f"错配标签: {', '.join(col.mismatched[:5])}")
    checks.append({
        "name": "结构化校验",
        "passed": ok1,
        "detail": "根内容容器为 article.docx-content，标签闭合正确" if ok1 else "；".join(detail1),
    })

    # 2. 样式信噪比：文本量 / (文本量 + 表现层标记) ≥ 50%
    #    结构标签不计入分母 —— 见 _Collector.style_len 的注释。
    denom = col.text_len + col.style_len
    ratio = (col.text_len / denom * 100) if denom else 0.0
    ok2 = ratio >= 50
    checks.append({
        "name": "样式信噪比",
        "passed": ok2,
        "detail": (
            f"文本 {col.text_len} / 样式标记 {col.style_len}，文本占比 {ratio:.1f}%"
            f"（阈值 ≥50%，结构标签不计入；全部标记 {col.markup_len} 字符）"
        ),
    })

    # 3. 表格还原度
    tbl_issues = []
    for m in re.finditer(r"<tr\b[^>]*>(.*?)</tr>", html, re.S | re.I):
        cols = 0
        for cm in re.finditer(r"<(td|th)\b([^>]*)>", m.group(1), re.I):
            attrs = cm.group(2)
            span = re.search(r'colspan="(\d+)"', attrs, re.I)
            cols += int(span.group(1)) if span else 1
        if cols == 0:
            tbl_issues.append("存在空行")
    if re.search(r"gridSpan|vMerge|hMerge", html):
        tbl_issues.append("残留 OOXML 合并标记")
    ok3 = not tbl_issues
    checks.append({
        "name": "表格还原度",
        "passed": ok3,
        "detail": "合并单元格已转为 colspan/rowspan，无残留 OOXML 标记" if ok3 else "；".join(tbl_issues),
    })

    # 4. 样式白名单
    bad_props: list[str] = []
    for style in col.styles:
        for decl in style.split(";"):
            if ":" not in decl:
                continue
            prop = decl.split(":", 1)[0].strip().lower()
            if prop and prop not in STYLE_WHITELIST:
                bad_props.append(prop)
    ok4 = not bad_props
    checks.append({
        "name": "样式白名单",
        "passed": ok4,
        "detail": "仅使用白名单样式属性" if ok4
        else f"越界属性: {', '.join(sorted(set(bad_props)))}",
    })

    # 5. 降噪检查
    noise = []
    if re.search(r"\bmso-[a-z-]+", html, re.I):
        noise.append("含 mso-* 属性")
    if re.search(r"\bMso[A-Z]", html):
        noise.append("含 MsoXxx 类名")
    if col.empty_spans:
        noise.append(f"空 <span> ×{col.empty_spans}")
    ok5 = not noise
    checks.append({
        "name": "降噪检查",
        "passed": ok5,
        "detail": "无 mso-* / MsoXxx / 空 span" if ok5 else "；".join(noise),
    })

    passed = sum(1 for c in checks if c["passed"])
    return {
        "file": label,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "overall": "pass" if passed == len(checks) else "fail",
        "checks": checks,
        "summary": {
            "total": len(checks),
            "passed": passed,
            "failed": len(checks) - passed,
            "warnings": 0,
        },
    }


def generate_report(result: dict) -> str:
    lines = [
        f"HTML 质量评估: {result['file']}",
        f"时间: {result['timestamp']}",
        f"结论: {'✅ 全部通过' if result['overall'] == 'pass' else '❌ 存在未通过项'} "
        f"({result['summary']['passed']}/{result['summary']['total']})",
        "",
    ]
    for c in result["checks"]:
        lines.append(f"  {'✅' if c['passed'] else '❌'} {c['name']}: {c['detail']}")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- CLI


def cmd_convert(argv: list[str]) -> int:
    src_file: str | None = None
    src_dir: str | None = None
    out_file: str | None = None
    out_dir: str | None = None
    base = "images"

    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--input", "-i") and i + 1 < len(argv):
            src_file = argv[i + 1]; i += 2
        elif a == "--input-dir" and i + 1 < len(argv):
            src_dir = argv[i + 1]; i += 2
        elif a in ("--output", "-o") and i + 1 < len(argv):
            out_file = argv[i + 1]; i += 2
        elif a == "--output-dir" and i + 1 < len(argv):
            out_dir = argv[i + 1]; i += 2
        elif a == "--image-base-url" and i + 1 < len(argv):
            base = argv[i + 1]; i += 2
        else:
            log(f"未知参数: {a}")
            return 2

    if src_file and src_dir:
        log("--input 与 --input-dir 互斥")
        return 1
    if not src_file and not src_dir:
        log("必须指定 --input 或 --input-dir")
        return 1

    if src_file:
        p = Path(src_file)
        if not p.is_file():
            log(f"ENOENT: 输入文件不存在: {p}")
            return 1
        targets = [p]
    else:
        d = Path(src_dir)
        if not d.is_dir():
            log(f"ENOENT: 输入目录不存在: {d}")
            return 1
        targets = sorted(x for x in d.iterdir() if x.suffix.lower() == ".docx")

    ok = 0
    for p in targets:
        if src_file and out_file:
            html_path = Path(out_file)
        elif out_dir:
            html_path = Path(out_dir) / (p.stem + ".html")
        else:
            html_path = p.with_suffix(".html")
        images_dir = html_path.parent / (base.rstrip("/") or "images")
        try:
            images_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            images_dir = None  # type: ignore[assignment]
        try:
            html = convert_docx(p, base, images_dir)
            html_path.parent.mkdir(parents=True, exist_ok=True)
            html_path.write_text(html, encoding="utf-8")
            log(f"✅ {p.name} → {html_path}  ({len(html)} B)")
            ok += 1
        except (zipfile.BadZipFile, KeyError, ValueError) as e:
            log(f"❌ {p.name} 转换失败（非 .docx 或文件损坏）: {e}")
        except Exception as e:  # noqa: BLE001
            log(f"❌ {p.name} 转换失败: {type(e).__name__}: {e}")
    if targets and ok == 0:
        return 1
    return 0


def cmd_assess(argv: list[str]) -> int:
    if not argv:
        log("用法: docx2html.py assess <html-file> [--output <report-path>]")
        return 2
    target = Path(argv[0])
    report_path: Path | None = None
    if "--output" in argv:
        k = argv.index("--output")
        if k + 1 < len(argv):
            report_path = Path(argv[k + 1])
    if not target.is_file():
        log(f"ENOENT: HTML 文件不存在: {target}")
        return 1
    html = target.read_text(encoding="utf-8", errors="replace")
    result = assess_html(html, str(target))
    report = generate_report(result)
    log(report)
    if report_path:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report, encoding="utf-8")
        json_path = report_path.with_suffix(".json")
        json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"报告已写入: {report_path}")
    return 0 if result["overall"] == "pass" else 1


def main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        return 0
    if argv[0] in ("--version", "-v", "version"):
        print(VERSION)
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "convert":
        return cmd_convert(rest)
    if cmd == "assess":
        return cmd_assess(rest)
    log(f"未知子命令: {cmd}（支持 convert / assess）")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
