#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pptx-generator 机械门禁（design-system.md §8）。

用法:
  python3 check_design.py <deck.pptx> --json slides.json
  python3 check_design.py --json slides.json          # 仅校验设计计划

输出（stdout，纯 JSON）: {"passed": bool, "checks": [7 项], ...}
退出码: 0 = 全部通过 / 1 = 有未过项 / 2 = 运行错误。

§8 列出 8 个维度，其中「画布」与「越界」在实现里合并为 geometry 一项，
「强调色面积」单列，故脚本的 checks 固定为 7 项阻断门禁。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pptx import Presentation
from pptx.enum.dml import MSO_FILL
from pptx.oxml.ns import qn

# ── §8 门禁常量（与 design-system.md 逐字一致） ────────────────────────
CANVAS_W_IN = 13.333
CANVAS_H_IN = 7.5
SAFE = {"left": 0.5, "right": 12.83, "top": 0.15, "bottom": 7.35}
ALLOWED_PT = [10.5, 11, 12, 15, 16, 18, 20, 22, 24, 26, 28, 30, 45, 54, 60, 72, 90]
ACCENTS = {"business_blue": "FFC107", "academic_white": "B22222",
           "creative_purple": "F1C40F", "tech_dark": "00C896", "minimal_gray": "0078D7"}
DENSITY = {"dense": 180, "standard": 120, "sparse": 60}
TYPE_RATIO = {"cover": 0.11, "section": 0.17, "agenda": 0.44, "content": 1.0,
              "two_column": 1.0, "table": 0.33, "chart": 0.44, "timeline": 0.67,
              "quote": 0.17, "image": 0.17, "summary": 0.33, "contact": 0.06}

EMU_PER_IN = 914400.0
GEOM_TOL = 0.02          # 英寸容差，吸收 Inches() 取整误差
MIN_TITLE_PT = 24.0      # 每页至少一个 >=24pt 的标题文本
ACCENT_LIMIT = 0.10      # 强调色面积上限
ACCENT_LIMIT_HERO = 0.20  # hero 页（封面 / 章节）上限


def _check(name: str, passed: bool, detail: str) -> dict:
    return {"name": name, "passed": bool(passed), "detail": detail}


def _iter_text_shapes(slide):
    """只迭代携带文字的形状：全出血装饰色块（无文字）不参与越界检查。"""
    for shape in slide.shapes:
        try:
            if shape.has_text_frame and shape.text_frame.text.strip():
                yield shape
        except (AttributeError, ValueError):
            continue


def _shape_geom(shape) -> tuple[float, float, float, float]:
    """返回 (left, top, right, bottom)，单位英寸。"""
    left = shape.left / EMU_PER_IN
    top = shape.top / EMU_PER_IN
    right = left + shape.width / EMU_PER_IN
    bottom = top + shape.height / EMU_PER_IN
    return left, top, right, bottom


def _paragraph_sizes(slide) -> list[float]:
    """收集所有文本形状中 defRPr/rPr/endParaRPr 的 sz（百分之一磅 → 磅）。"""
    sizes: list[float] = []
    for shape in _iter_text_shapes(slide):
        el = shape.text_frame._txBody
        for tag in ("a:defRPr", "a:rPr", "a:endParaRPr"):
            for node in el.iter(qn(tag)):
                sz = node.get("sz")
                if sz:
                    try:
                        sizes.append(float(sz) / 100.0)
                    except ValueError:
                        continue
    return sizes


def _all_ea_present(slide) -> tuple[bool, int, int]:
    """检查每个非空段落的 defRPr 是否写入了 a:ea typeface。"""
    total = 0
    missing = 0
    for shape in _iter_text_shapes(slide):
        for para in shape.text_frame.paragraphs:
            if not para.text.strip():
                continue
            total += 1
            pPr = para._p.find(qn("a:pPr"))
            def_rpr = pPr.find(qn("a:defRPr")) if pPr is not None else None
            ea = def_rpr.find(qn("a:ea")) if def_rpr is not None else None
            if ea is None or not (ea.get("typeface") or "").strip():
                missing += 1
    return missing == 0, total, missing


def _slide_text_len(slide) -> int:
    return sum(len(shape.text_frame.text.strip()) for shape in _iter_text_shapes(slide))


def _accent_ratio(slide, accent_hex: str) -> float:
    """强调色填充形状面积 / 画布面积。"""
    canvas_area = CANVAS_W_IN * CANVAS_H_IN
    covered = 0.0
    for shape in slide.shapes:
        try:
            if shape.fill.type != MSO_FILL.SOLID:
                continue
            rgb = shape.fill.fore_color.rgb
            if str(rgb).upper() != accent_hex.upper():
                continue
            _, _, right, bottom = _shape_geom(shape)
            left = shape.left / EMU_PER_IN
            top = shape.top / EMU_PER_IN
            covered += max(right - left, 0.0) * max(bottom - top, 0.0)
        except (AttributeError, ValueError, TypeError):
            continue
    return covered / canvas_area if canvas_area else 0.0


def _json_text_len(slide_obj: dict) -> int:
    """递归统计一页设计计划里所有字符串长度（无 pptx 时的静态密度口径）。"""
    buf: list[str] = []

    def walk(node) -> None:
        if isinstance(node, str):
            buf.append(node)
        elif isinstance(node, dict):
            for v in node.values():
                walk(v)
        elif isinstance(node, (list, tuple)):
            for v in node:
                walk(v)

    walk(slide_obj)
    return len("".join(buf).strip())


def run(pptx_path: Path | None, json_path: Path | None) -> dict:
    plan: dict = {}
    slides_plan: list[dict] = []
    if json_path is not None:
        plan = json.loads(json_path.read_text(encoding="utf-8"))
        slides_plan = plan.get("slides", [])
    style = plan.get("style", "business_blue")
    accent_hex = ACCENTS.get(style, ACCENTS["business_blue"])

    prs = None
    if pptx_path is not None:
        prs = Presentation(str(pptx_path))

    checks: list[dict] = []

    # 1) geometry — 画布尺寸 + 文字形状越界（§8 的「画布」「越界」合并）
    if prs is not None:
        w = prs.slide_width / EMU_PER_IN
        h = prs.slide_height / EMU_PER_IN
        canvas_ok = abs(w - CANVAS_W_IN) < GEOM_TOL and abs(h - CANVAS_H_IN) < GEOM_TOL
        violations: list[str] = []
        for idx, slide in enumerate(prs.slides, 1):
            for shape in _iter_text_shapes(slide):
                l, t, r, b = _shape_geom(shape)
                if (l < SAFE["left"] - GEOM_TOL or r > SAFE["right"] + GEOM_TOL
                        or t < SAFE["top"] - GEOM_TOL or b > SAFE["bottom"] + GEOM_TOL):
                    violations.append("p%d(%.2f,%.2f,%.2f,%.2f)" % (idx, l, t, r, b))
        passed = canvas_ok and not violations
        detail = ("画布 %.3fx%.3fin；文字形状越界 %d 处" % (w, h, len(violations)))
        if violations:
            detail += "：" + ", ".join(violations[:4])
        checks.append(_check("geometry", passed, detail))
    else:
        checks.append(_check("geometry", True,
                             "未提供 pptx，画布/越界留待生成后校验；计划含 %d 页" % len(slides_plan)))

    # 2) title — 每页至少一个 >=24pt 的标题文本
    if prs is not None:
        bad: list[int] = []
        for idx, slide in enumerate(prs.slides, 1):
            sizes = _paragraph_sizes(slide)
            if not sizes or max(sizes) < MIN_TITLE_PT - 0.1:
                bad.append(idx)
        checks.append(_check("title", not bad,
                             "要求每页最大字号 >=%.0fpt；未达标页 %s"
                             % (MIN_TITLE_PT, bad if bad else "无")))
    else:
        missing = [i + 1 for i, s in enumerate(slides_plan)
                   if s.get("type") not in ("quote", "contact") and not s.get("title")]
        checks.append(_check("title", not missing,
                             "设计计划缺标题页 %s" % (missing if missing else "无")))

    # 3) font_size — 全部字号落在 ALLOWED_PT 白名单
    if prs is not None:
        seen: set[float] = set()
        for slide in prs.slides:
            seen.update(_paragraph_sizes(slide))
        off = sorted(v for v in seen
                     if not any(abs(v - a) < 0.11 for a in ALLOWED_PT))
        checks.append(_check("font_size", not off,
                             "实测字号 %s；越界 %s"
                             % (sorted(seen) if seen else "[]", off if off else "无")))
    else:
        checks.append(_check("font_size", True,
                             "未提供 pptx；生成器统一使用 §3 白名单字号"))

    # 4) font_family — 中文 a:ea 字体族注入
    if prs is not None:
        total = 0
        missing_ea = 0
        for slide in prs.slides:
            _, t, m = _all_ea_present(slide)
            total += t
            missing_ea += m
        checks.append(_check("font_family", missing_ea == 0,
                             "非空段落 %d 个，缺 a:ea %d 个" % (total, missing_ea)))
    else:
        checks.append(_check("font_family", True,
                             "未提供 pptx；生成器 _apply_font 统一注入 a:ea"))

    # 5) density — 逐页按 type 应用密度阈值
    density_level = plan.get("density", "standard")
    base = DENSITY.get(density_level, DENSITY["standard"])
    density_bad: list[str] = []
    density_detail: list[str] = []
    page_count = len(prs.slides) if prs is not None else len(slides_plan)
    for i in range(page_count):
        typ = (slides_plan[i].get("type", "content")
               if i < len(slides_plan) else "content")
        ratio = TYPE_RATIO.get(typ, 1.0)
        required = base * ratio
        if prs is not None:
            actual = _slide_text_len(prs.slides[i])
        else:
            actual = _json_text_len(slides_plan[i]) if i < len(slides_plan) else 0
        density_detail.append("p%d:%s %.0f/%.0f" % (i + 1, typ, actual, required))
        if actual < required:
            density_bad.append("p%d(%s)" % (i + 1, typ))
    checks.append(_check("density", not density_bad,
                         "档位 %s；%s；未达标 %s"
                         % (density_level, " ".join(density_detail),
                            density_bad if density_bad else "无")))

    # 6) accent_area — 强调色面积上限
    if prs is not None:
        over: list[str] = []
        for i, slide in enumerate(prs.slides, 1):
            typ = (slides_plan[i - 1].get("type", "content")
                   if i - 1 < len(slides_plan) else "content")
            limit = ACCENT_LIMIT_HERO if typ in ("cover", "section") else ACCENT_LIMIT
            ratio = _accent_ratio(slide, accent_hex)
            if ratio > limit + 1e-6:
                over.append("p%d=%.1f%%" % (i, ratio * 100))
        checks.append(_check("accent_area", not over,
                             "强调色 %s；上限 %.0f%%/hero %.0f%%；超限 %s"
                             % (accent_hex, ACCENT_LIMIT * 100, ACCENT_LIMIT_HERO * 100,
                                over if over else "无")))
    else:
        checks.append(_check("accent_area", style in ACCENTS,
                             "配色 %s 已登记强调色 %s" % (style, accent_hex)))

    # 7) layout_repeat — 禁止连续 3 页同 type
    types = [s.get("type", "content") for s in slides_plan]
    repeat_bad: list[int] = []
    for i in range(len(types) - 2):
        if types[i] == types[i + 1] == types[i + 2]:
            repeat_bad.append(i + 1)
    checks.append(_check("layout_repeat", not repeat_bad,
                         "页型序列 %s；连续 3 页重复起始位 %s"
                         % (types if types else "[]", repeat_bad if repeat_bad else "无")))

    passed = all(c["passed"] for c in checks)
    return {
        "passed": passed,
        "checks": checks,
        "passed_count": sum(1 for c in checks if c["passed"]),
        "total": len(checks),
        "summary": "passed: %s, %d/%d checks" % (str(passed).lower(),
                                                 sum(1 for c in checks if c["passed"]),
                                                 len(checks)),
        "pptx": str(pptx_path) if pptx_path else None,
        "json": str(json_path) if json_path else None,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="pptx-generator 机械门禁（§8）")
    parser.add_argument("pptx", nargs="?", help="待检查的 .pptx 文件")
    parser.add_argument("--json", dest="json_path", help="设计计划 slides.json")
    args = parser.parse_args(argv)

    json_path = Path(args.json_path) if args.json_path else None
    if json_path is not None and not json_path.is_file():
        sys.stderr.write("找不到设计计划: %s\n" % json_path)
        return 2
    pptx_path = Path(args.pptx) if args.pptx else None
    if pptx_path is not None and not pptx_path.is_file():
        sys.stderr.write("找不到 pptx: %s\n" % pptx_path)
        return 2
    if pptx_path is None and json_path is None:
        sys.stderr.write("需要 <pptx> 或 --json 至少其一\n")
        return 2

    try:
        result = run(pptx_path, json_path)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write("门禁运行错误: %s\n" % exc)
        return 2

    sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2))
    sys.stdout.write("\n")
    sys.stderr.write("%s\n" % result["summary"])
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
