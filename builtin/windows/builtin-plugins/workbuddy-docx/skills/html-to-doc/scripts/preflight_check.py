#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""preflight_check.py —— S3 插入前的确定性产物预检（fail-fast 硬门禁）。

背景：S2（doc-formatter）产出的 HTML 是否合规，不能依赖 LLM 写作时的自觉——
实测多轮表明 S2 会漏写 <style>/@page，S3 若静默走"工具补页眉页脚"兜底，
产物会带 updateFields=False（页码域打开不刷新）等隐性缺陷。
本脚本把检查下沉为确定性规则：启用 preflight 时在插入前执行、不通过即硬失败
（convert_doc.py 工作流默认 --no-preflight 快通道跳过；用户要求页眉页脚/页码/
封面时必须启用——convert_doc.py 对 --require-page-furniture 强制忽略
--no-preflight，见 doc-converter.md §6 纪律 10）。

用法：
    python3 preflight_check.py --html <file1.html> <file2.html> ...
    python3 preflight_check.py --html-dir <stage2目录>
    # 用户要求页眉页脚/页码/封面时（必传）：
    python3 preflight_check.py --html-dir <stage2目录> --require-page-furniture

检查项：
    PF-01 每份 HTML 必须含 <style> 块（页面级规则载体，见 doc-formatter §2.5）
    PF-02 --require-page-furniture 时，每份 HTML 的 <style> 必须含 @page 规则
          （页眉页脚正道：CSS @page → 引擎转 Word 页眉页脚域 + updateFields
           自动置位；工具补位是能力受限的降级，须显式告警而非默认）
    PF-03 CSS 类选择器与结构脱钩检测：CSS 中出现的每个 .class（含后代选择器
          前缀如 `.report-body h1`），HTML 里必须有元素挂载该 class——脱钩时
          规则整体失配，正文样式静默回退默认（实测 2026-09-15：S2 写了 8 条
          .report-body 前缀规则但 section 忘挂 class，标题全部变宋体小四）

输出：JSON（stdout）
    {"passed": bool, "issues": [...], "files": [{"file":..., "has_style":...,
     "has_page_rule":..., "orphan_css_classes":[...]}], "require_page_furniture": bool}

退出码：0=通过；1=不通过；2=运行错误（输入缺失/为空）
纯 Python 3 标准库，零第三方依赖。
"""

import argparse
import glob
import json
import os
import re
import sys
from html.parser import HTMLParser

_STYLE_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.IGNORECASE | re.DOTALL)

# @page at-rule 形态匹配：@page 后须跟 空白 / { / : ——覆盖 @page {}、
# @page :first {}、@page <命名页> {} 三种合法形态
_PAGE_RULE_RE = re.compile(r"@page[\s:{]")
# CSS 字符串字面量剥离——属性值（如 content: "...@page..."）不构成 at-rule，
# 判定前先剥离，避免字符串文本干扰（AI 评审：子串判定会把 "@page" 文本
# 误判为有效规则，造成 PF-02 漏报）
_CSS_STRING_RE = re.compile(r'"[^"\n]*"|\'[^\'\n]*\'')


def _has_page_rule(css: str) -> bool:
    """@page at-rule 存在性判定（形态匹配，非子串）。"""
    return bool(_PAGE_RULE_RE.search(css))


class _MountedClassCollector(HTMLParser):
    """提取 HTML 元素实际挂载的 class。

    用 html.parser 而非正则提取：天然处理单/双引号与大小写属性名，且
    跳过注释——注释里的 class="..." 不构成真实挂载。原正则仅匹配双引号
    小写 class 且把注释内容计入，存在误杀合格文档与注释假挂载两类偏差。
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.classes = set()

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name == "class" and value:
                self.classes.update(value.split())


def check_file(path, require_page_furniture):
    """检查单份 HTML，返回 (issues, file_report)。"""
    issues = []
    # 全部键在初始化时给出默认值——异常路径提前返回时结构与正常路径一致，
    # 调用方按统一结构访问不会 KeyError（AI 评审 2026-09-16）
    report = {
        "file": path,
        "has_style": False,
        "has_page_rule": False,
        "orphan_css_classes": [],
        "orphan_structural_classes": [],
    }
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            html = f.read()
    except OSError as e:
        return ([f"[PF-00] 无法读取 {path}: {e}"], report)

    style_blocks = _STYLE_RE.findall(html)
    report["has_style"] = bool(style_blocks)
    if not style_blocks:
        issues.append(
            f"[PF-01] {os.path.basename(path)} 缺少 <style> 块——"
            "页面级规则（@page/命名页）必须写在 <style> 内，inline style 无法表达"
            "（doc-formatter §2.5：inline 管元素视觉，<style> 管页面级规则，缺一不可）"
        )

    css_text = "\n".join(style_blocks)
    # CSS 注释剥离——PF-03 class 检测用
    css_clean = re.sub(r"/\*.*?\*/", "", css_text, flags=re.DOTALL)
    # @page 判定文本：注释与字符串字面量均剥离——两者中的 @page 均不构成
    # 有效 at-rule（引擎不解析注释内规则；属性值字符串仅是文本），在原文上
    # 判定会造成硬门禁假通过
    css_code = _CSS_STRING_RE.sub("", css_clean)
    report["has_page_rule"] = _has_page_rule(css_code)
    if require_page_furniture and not report["has_page_rule"]:
        if _has_page_rule(css_text):
            issues.append(
                f"[PF-02] {os.path.basename(path)} 的 @page 仅存在于 CSS 注释或字符串字面量中——"
                "不构成有效规则（引擎不解析注释内规则，属性值仅为文本），等同缺失："
                "请写出真实 @page 规则或删除误导性内容"
            )
        else:
            issues.append(
                f"[PF-02] {os.path.basename(path)} 缺少 CSS @page 规则——"
                "用户要求了页眉页脚/页码/封面，必须由 HTML 的 @page margin-box 承载"
                "（counter(page) 页码 / 命名页 + section[role] 分节），"
                "S3 引擎自动转 Word 页眉页脚域并置位 updateFields；"
                "禁止省略 @page 后改用 doc_insert_header/doc_set_page_number 工具补位"
                "（工具补位产物 updateFields 不置位，页码打开不刷新），"
                "更禁止绕道 python-docx（doc-formatter §2.5）"
            )

    # PF-03 CSS 类选择器与结构脱钩检测（css_text/css_clean 已在 PF-02 前计算）
    # HTML 里实际挂载的全部 class——html.parser 提取（单双引号/大小写/注释均正确）
    collector = _MountedClassCollector()
    try:
        collector.feed(html)
        collector.close()
    except Exception as e:
        # 宽松解析极少抛；静默吞掉会掩盖真实解析缺陷——stderr 留痕排查
        # （stdout 保持纯 JSON 输出契约，告警走 stderr）
        print(f"[PF-03] class 提取异常，保留已收集部分: {type(e).__name__}: {e}",
              file=sys.stderr)
    mounted = collector.classes
    # 所有 CSS 引用的 class（信息性）
    css_classes = set(re.findall(r"\.([A-Za-z_][\w-]*)", css_clean))
    # 结构样式承载者：".class 标题/正文标签" 后代选择器（如 .report-body h1 / .X p）。
    # 这类选择器一旦脱钩，标题/正文的字体字号颜色整体静默回退默认——灾难级，必须拦截。
    # （表格/列表类组件规则脱钩影响局部且模板常备冗余，不拦，仅记录在 orphan_css_classes）
    _STRUCT_TAGS = r"(?:h[1-6]|p)\b"
    structural = set()
    # 先按逗号拆分复合选择器再判断——否则 '.foo, .bar h1' 会把 .foo 误判为
    # 结构类（跨逗号匹配到 .bar 后的 h1），PF-03 误报（AI 评审 2026-09-16）
    for rule_sels in re.findall(r"([^{}]+)\{", css_clean):
        for sel in rule_sels.split(","):
            for m in re.finditer(r"\.([A-Za-z_][\w-]+)[^{}]*?\s+" + _STRUCT_TAGS, sel):
                structural.add(m.group(1))
    orphan_structural = sorted(c for c in structural if c not in mounted)
    orphan_all = sorted(css_classes - mounted)
    report["orphan_css_classes"] = orphan_all
    report["orphan_structural_classes"] = orphan_structural
    if orphan_structural:
        issues.append(
            f"[PF-03] {os.path.basename(path)} CSS 类选择器与结构脱钩——"
            f"结构样式承载 class（.X h1/p/li 等后代选择器）未挂载：{', '.join(orphan_structural[:8])}"
            "（这些规则整体失配，标题/正文样式静默回退默认；典型事故：S2 写了 .report-body"
            " 前缀规则但 section 忘挂 class，标题全部变宋体小四。请给对应元素补 class 或改用"
            " tag/attribute 选择器，修正后重跑预检）"
        )
    return issues, report


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="S3 插入前的 HTML 产物预检（fail-fast 硬门禁）"
    )
    parser.add_argument("--html", nargs="+", help="待检 HTML 文件路径（可多个）")
    parser.add_argument("--html-dir", help="待检 HTML 目录（取目录内全部 *.html，按文件名排序）")
    parser.add_argument(
        "--require-page-furniture",
        action="store_true",
        help="用户要求页眉页脚/页码/封面时必传：强制检查每份 HTML 含 @page（PF-02）",
    )
    args = parser.parse_args(argv)

    files = list(args.html or [])
    if args.html_dir:
        files += sorted(glob.glob(os.path.join(args.html_dir, "*.html")))
    # 去重保序
    seen = set()
    files = [f for f in files if not (f in seen or seen.add(f))]
    files = [f for f in files if os.path.isfile(f)]

    if not files:
        sys.stderr.write("未找到任何待检 HTML 文件（--html / --html-dir 至少提供一个有效输入）\n")
        return 2

    issues = []
    reports = []
    for p in files:
        f_issues, f_report = check_file(p, args.require_page_furniture)
        issues.extend(f_issues)
        reports.append(f_report)

    passed = not issues
    report = {
        "passed": passed,
        "issues": issues,
        "files": reports,
        "require_page_furniture": bool(args.require_page_furniture),
    }
    sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=2))
    sys.stdout.write("\n")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
