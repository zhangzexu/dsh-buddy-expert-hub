# PPT 设计系统（python-pptx 原生实现）

> 本文件是 `pptx-generator` 的唯一视觉规范。生成任何 `.pptx` 之前必须完整阅读。
> 所有坐标单位为英寸（in），字号单位为磅（pt），颜色为 6 位十六进制 RGB。

---

## §0 优先级链

```
用户显式指令 ≻ 项目 DESIGN.md ≻ 本文件
```

- 用户点名了配色 / 字号 / 版式，按用户的来。
- 项目里已有 `DESIGN.md`（本次会话早前写的视觉设计文档），以它为准。
- 两者都没有，才回落到本文件的默认值。
- **冲突时不静默折中**：在 `DESIGN.md` 里记一句「因用户指令覆盖了 §X 的默认值」。

---

## §1 画布与分区

### 1.1 画布

| 项 | 值 |
|---|---|
| 宽 × 高 | **13.333 in × 7.5 in**（16:9） |
| 等价像素 | 1280 px × 720 px |
| 面积 | 100 in² |

换算三列（`pt = px × 0.75`，`in = px / 96`）：

| px | pt | in |
|---|---|---|
| 12 | 9 | 0.125 |
| 16 | 12 | 0.167 |
| 24 | 18 | 0.250 |
| 32 | 24 | 0.333 |
| 48 | 36 | 0.500 |
| 64 | 48 | 0.667 |
| 96 | 72 | 1.000 |
| 1280 | 960 | 13.333 |

### 1.2 A / B / C 母版分区

| 区 | y 范围 | 用途 |
|---|---|---|
| A | 0 – 1.25 in | 标题栏 / 页眉（主色块 + 强调色细线） |
| B | 1.25 – 6.875 in | 内容主体区 |
| C | 6.875 – 7.5 in | 页脚 / 页码 / 结论条 |

### 1.3 安全区

```
x ∈ [0.5, 12.83]   y ∈ [0.15, 7.35]
```

- 所有**携带文字**的形状必须整体落在安全区内（机械门禁 geometry 会逐形状校验）。
- **全出血装饰色块允许贴边甚至铺满画布**：它们不带文字，不参与越界判定。
- 页码框 `(11.53, 7.05, 1.3, 0.3)`、页脚框 `(0.625, 7.05, 8.0, 0.3)` 是 C 区的标准位置；`7.05 = 7.5 − 0.45` 由 `_footer_top(prs)` 从**画布高度**推导，绝不能误用画布宽度。

---

## §2 五套配色

| 名称 | 主色 | 强调色 | 适用 |
|---|---|---|---|
| `business_blue` | `#1E3C72` | `#FFC107` | 经营分析、季度汇报、商业提案 |
| `academic_white` | `#003366` | `#B22222` | 学术答辩、研究汇报 |
| `creative_purple` | `#662D8C` | `#F1C40F` | 品牌、创意、发布会 |
| `tech_dark` | `#303848` | `#00C896` | 技术架构、产品发布（深色） |
| `minimal_gray` | `#505050` | `#0078D7` | 极简、内部同步、信息通报 |

### 2.1 面积上限（按可见色块面积计）

| 角色 | 上限 |
|---|---|
| 主色 | ≤ 60% |
| 辅助色 | ≤ 30% |
| **强调色** | **≤ 10%**（hero 页：封面 / 章节页放宽到 15–20%） |

> 机械门禁 `accent_area` 逐页统计强调色填充形状面积占比，普通页 >10% / hero 页 >20% 判定未过。

### 2.2 渐变的不透明等价色

python-pptx **不支持 CSS 渐变**（`gradient_start` / `gradient_end` 这类字段没有对应 API）。需要渐变氛围时，用不透明实色拼接近似：

| 原意图 | 不透明等价做法 |
|---|---|
| 主色 → 亮主色渐变 | 主色实心底 + 顶部一条 `secondary` 实色窄带 |
| 深色科技感渐变 | `bg_primary` 实色铺满 + `bg_secondary` 斜向大色块 |
| 强调色高光渐变 | 强调色实心细线（0.06 in）+ 大片留白 |

**禁止**在交付物里声称用了渐变；只描述成「分层色块」。

---

## §3 字阶与字体

### 3.1 字阶表（px → pt 双列）

| 层级 | px | pt | 用途 |
|---|---|---|---|
| 封面主标题 | 60 – 96 | **45 – 72** | 仅封面 / 尾页 |
| 锚点巨型数字 | 72 – 120 | **54 – 90** | 数据锚点、章节号 |
| 页标题 | 32 – 40 | **24 – 30** | A 区标题栏 |
| 卡片头 | 24 – 29 | **18 – 22** | 卡片 / 分栏小标题 |
| 正文 | 21 – 28 | **16 – 21** | 主体内容、结论条 |
| 脚注 / 页码 / 页脚 | 14 – 16 | **10.5 – 12** | C 区 |

**标准档**：`26 / 18 / 16 / 11 / 60`（页标题 / 卡片头 / 正文 / 脚注 / 锚点）。

### 3.2 字号白名单

```python
ALLOWED_PT = [10.5, 11, 12, 15, 16, 18, 20, 22, 24, 26, 28, 30, 45, 54, 60, 72, 90]
```

任何文本的字号必须取自该白名单；机械门禁 `font_size` 会读取 `a:defRPr/@sz` 逐项比对。

### 3.3 `set_font()` 必须演示 `a:ea` 中文字体注入

只设 `run.font.name` 只会写 `<a:latin>`，PowerPoint / WPS 遇到中文仍会回退默认字体。必须同时写 `<a:ea>`：

```python
from pptx.oxml.ns import qn
from pptx.oxml.xmlchemy import OxmlElement

def _apply_font(paragraph, name):
    """把字体族写入 a:latin / a:ea / a:cs，确保中文不回退默认字体。"""
    pPr = paragraph._p.get_or_add_pPr()
    def_rpr = pPr.find(qn("a:defRPr"))
    if def_rpr is None:
        def_rpr = OxmlElement("a:defRPr")
        pPr.append(def_rpr)
    targets = [def_rpr]
    for run in paragraph.runs:
        targets.append(run._r.get_or_add_rPr())
    for rpr in targets:
        for tag in ("a:latin", "a:ea", "a:cs"):   # a:ea 是关键
            el = rpr.find(qn(tag))
            if el is None:
                el = OxmlElement(tag)
                rpr.append(el)
            el.set("typeface", name)
```

`_add_para()` 按 `size >= 18` 选 `heading` 字体族，否则选 `body`；`__init__` 调 `set_active_fonts(style)` 切换五套配色各自的字体族。机械门禁 `font_family` 会检查每个非空段落的 `a:ea`。

---

## §4 密度门禁

### 4.1 档位常量

```python
DENSITY = {"dense": 180, "standard": 120, "sparse": 60}
TYPE_RATIO = {"cover": 0.11, "section": 0.17, "agenda": 0.44, "content": 1.0,
              "two_column": 1.0, "table": 0.33, "chart": 0.44, "timeline": 0.67,
              "quote": 0.17, "image": 0.17, "summary": 0.33, "contact": 0.06}
```

逐页要求字符数 = `DENSITY[档位] × TYPE_RATIO[type]`；默认档位 `standard`。
`--json slides.json` 让门禁按每页真实 `type` 应用阈值，而不是一刀切。

| 页型 | standard 档要求字符数 |
|---|---|
| cover / contact | 13 / 7 |
| section / quote / image | 20 |
| agenda / chart | 53 |
| table / summary | 40 |
| timeline | 80 |
| content / two_column | 120 |

### 4.2 容器填充与卡片字数

- 容器填充率 **≥ 85%**：内容文本框不要只占半张卡片就留大片空白。
- 卡片宽度 ≥ 380 px 时，卡内文字 **≥ 100 字**。
- 卡片宽度 ≥ 480 px 时，卡内文字 **≥ 130 字**。
- 达不到就不要用卡片版式，改用两段正文 + 一个数据锚点。

---

## §5 图片：三级策略 + 五步降级

### 5.1 图片级别

| 级别 | 含义 |
|---|---|
| L1 | 用户提供的真实图片 / 截图 |
| L2 | 宿主图像生成能力产出的配图 |
| L3 | 纯 python-pptx 图形（`MSO_SHAPE`、大色块、巨型数字） |

### 5.2 五步降级阶梯（自上而下依次尝试，命中即停）

1. **用户图**：用户给了图片路径，直接用。
2. **宿主 ImageGen**：环境提供图像生成能力时，按页意生成一张。
3. **`MSO_SHAPE` 图形**：用矩形 / 圆 / 箭头 / 时间线圆点拼出示意结构。
4. **大色块 + 巨型数字**：拿 54–90pt 锚点数字 + 主色块承载关键数据。
5. **声明「图形化 deck」**：在 `DESIGN.md` 明确写「本稿为图形化 deck，无摄影图片」，并全程使用 L3 方案。

### 5.3 铁律

- **永不拉伸，只裁剪**：图片必须按原宽高比 `crop` 或等比缩放后居中裁剪，禁止同时改 width / height 破坏比例。
- 降级到 L3 之后不要反复尝试上层能力，避免耗时。
- `image_path` 不存在时生成器会抛错并跳过该页；先降级再生成，不要让页面凭空消失。

---

## §6 12 种 `type` → 信息形态映射

| type | 信息形态 | JSON 关键字段 |
|---|---|---|
| `cover` | 一句话主张 + 副标题 | `title` / `subtitle` / `variant` |
| `section` | 章节切换（大字锚点） | `title` / `subtitle` |
| `agenda` | 有序清单 | `topics` / `highlight` |
| `content` | 并列要点 / 论述 | `items` / `columns` |
| `two_column` | 左右对照（优势 vs 风险） | `left` / `right` |
| `table` | 精确数值矩阵 | `headers` / `rows` |
| `chart` | 趋势 / 占比 + **结论** | `chart_type` / `categories` / `series` / `insight` |
| `timeline` | 时间顺序里程碑 | `milestones` |
| `quote` | 引证 / 观点 | `quote` / `attribution` |
| `image` | 视觉证据 | `image_path` / `caption` / `overlay` |
| `summary` | 收敛动作清单 | `points` / `conclusion` |
| `contact` | 联络信息 | `info` |

> **禁止连续 3 页同 `type`**（机械门禁 `layout_repeat` 会检查页型序列）。
> 图表页必须给 `insight`：有结论时图高从 5.2 收到 4.35 in，并在 `(0.8, 6.0, 11.7, 0.7)` 渲染 16pt 结论条。

---

## §7 页面映射表格式

生成前在 `DESIGN.md` 里写一张映射表，逐页锁定意图，避免边生成边改：

| 页 | type | 标题 | 核心信息 | 视觉方案 | 配色角色 |
|---|---|---|---|---|---|
| 1 | cover | … | 主张 | 左对齐大标题 + 主色竖条 | 主 60% / 强调 5% |
| 2 | agenda | 目录 | 4 个章节 | 有序清单 | 强调 ≤10% |
| 3 | content | … | 3 条要点 | 单栏正文 | 辅助 ≤30% |
| 4 | chart | … | 趋势 + insight | 柱图 + 结论条 | 强调 ≤10% |
| … | … | … | … | … | … |

每行都要能回答：这页**只讲一件事**吗？和上一页的 `type` 重复吗？

---

## §8 八项机械门禁

八项维度 → `check_design.py` 输出 **7 项阻断门禁**（「画布」与「越界」合并为 `geometry` 一项）：

| # | 维度 | 门禁名 | 判定 |
|---|---|---|---|
| 1 | 画布 | `geometry` | 13.333 × 7.5 in |
| 2 | 越界 | `geometry` | 仅文字形状须落在安全区；全出血装饰块豁免 |
| 3 | 标题 | `title` | 每页至少一个 ≥24pt 标题文本 |
| 4 | 字号 | `font_size` | 全部字号 ∈ `ALLOWED_PT` |
| 5 | 字体族 | `font_family` | 每个非空段落写入 `a:ea` |
| 6 | 密度 | `density` | 逐页 ≥ `DENSITY × TYPE_RATIO[type]` |
| 7 | 强调色面积 | `accent_area` | ≤10%（hero ≤20%） |
| 8 | 版式重复 | `layout_repeat` | 无连续 3 页同 `type` |

```bash
python3 scripts/check_design.py <deck.pptx> --json slides.json
# → {"passed": true, "checks": [7 项], ...}
```

未过门禁时按 `SKILL.md` 的四步流程最多修 3 轮，仍不过则如实报告，禁止改门禁常量凑通过。

---

## §9 九类常见返工原因

| # | 返工原因 | 修法 |
|---|---|---|
| 1 | 页脚 / 页码飞到画布外（把 slide_width 当 y 坐标） | 用 `_footer_top(prs) = slide_height / 914400 − 0.45` |
| 2 | 标题框右边缘越界（如 `x=0.12, w=11.733`） | 统一 `0.8, 0.17, 11.7`，宽高收进安全区 |
| 3 | 中文回退成默认字体 | `_apply_font()` 写入 `a:ea` |
| 4 | 字号碎（13pt / 17pt / 19pt 混用） | 全部收敛到 `ALLOWED_PT` |
| 5 | 图表只有数据没有结论 | 补 `chart.insight`，生成结论条 |
| 6 | 页码显示不出总数（`NN / TOTAL` 缺 TOTAL） | `PPTGenerator(total=...)` 由 `build_from_json` 传入 |
| 7 | 强调色铺满半页 | 降到大色块主色，强调色只留细线 / 圆点 |
| 8 | 连续 3 页以上同一版式 | 插入 `section` / `quote` / `chart` 打断 |
| 9 | 卡片空、容器填充 <85% | 补正文到字数下限，或改两段式版式 |

---

## 变更记录

- `3.0.0`：按 python-pptx 原生能力重写；新增 §3 `a:ea` 注入、§4 逐页密度阈值、§8 机械门禁与 7 项门禁脚本的对应关系、§9 返工清单；删除 CSS 渐变等不可用表述。
