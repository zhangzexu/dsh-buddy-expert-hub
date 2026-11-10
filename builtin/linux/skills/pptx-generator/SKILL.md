---
name: pptx-generator
description: 专业 PPT 生成器。按 JSON 描述生成标准、可编辑的 .pptx（12 种页型 / 5 套配色 / 图表 / 表格 / 时间线 / 图片 / 页码页脚）。内置 python-pptx 原生设计系统与机械门禁，读数设计系统 → 写设计说明 → 生成 → 跑门禁并最多修 3 轮。触发词：PPT、幻灯片、演示文稿、PowerPoint、做一份汇报、把大纲做成 deck。
category: capability
version: "3.0.0"
tags: [pptx, presentation, python-pptx, design-system, quality-gate]
user-invocable: true
disable-model-invocation: false
---

# pptx-generator — 结构化演示文稿生成

纯 python-pptx 实现，输出标准**可编辑**的 `.pptx`（不是图片拼接，不是 HTML 截图）。

<goal>
把用户给的主题 / 大纲 / 数据 / 参考材料，转成一份逐页锁定意图、通过机械门禁的演示文稿，并交付 `.pptx` 绝对路径。
</goal>

---

## §0 前置门禁（P0）

```bash
PPT_PY="$(bash <SKILL_DIR>/scripts/setup.sh | sed -n 's/^Python runner: //p')"
```

- `scripts/setup.sh` 自举共享环境并校验 `import pptx`；解释器一律**运行时捕获**，不要硬编码路径。
- `<SKILL_DIR>` = 本技能目录的绝对路径。
- 生成器与门禁脚本都复用同一个 `$PPT_PY`。

---

## §1 强制四步流程（不可跳步）

### 步骤 1 — 读设计系统

完整阅读 [`references/design-system.md`](references/design-system.md)（9 节）：画布与 A/B/C 分区、五套配色、字阶白名单、密度门禁、图片降级、12 种页型映射、页面映射表、八项机械门禁、九类返工原因。

> 优先级：**用户显式指令 ≻ 项目 `DESIGN.md` ≻ 设计系统默认值**。

### 步骤 2 — 写 `DESIGN.md`

在工作目录写一份视觉设计文档，至少包含：

1. 选定的配色（`style`）与理由。
2. 按 §7 格式的**页面映射表**：每页的 `type` / 标题 / 核心信息 / 视觉方案 / 配色角色。
3. 图片策略：命中 §5 五级降级的第几级；若为 L3，明确写「本稿为图形化 deck，无摄影图片」。
4. 逐页密度档位（`standard` / `dense` / `sparse`）。

> 没有 `DESIGN.md` 就不要进入步骤 3——边生成边改版式是返工的主要来源。

### 步骤 3 — 生成

```bash
"$PPT_PY" <SKILL_DIR>/scripts/generate_pptx.py <slides.json 绝对路径> --out <输出 .pptx 绝对路径>
```

### 步骤 4 — 跑门禁并最多修 3 轮

```bash
"$PPT_PY" <SKILL_DIR>/scripts/check_design.py <输出 .pptx 路径> --json <slides.json 路径>
```

- stdout 为纯 JSON：`{"passed": bool, "checks": [7 项], "summary": "..."}`；exit `0` = 通过 / `1` = 有未过项 / `2` = 运行错误。
- `passed: false` 时按 `checks` 里 `passed: false` 的 `detail` 定位问题，对照 §9 返工清单修改 `DESIGN.md` 与 `slides.json` 后**重新生成 + 重新跑门禁**。
- **最多 3 轮**。3 轮后仍不过：如实报告未过项与已尝试的修法，**禁止**改门禁常量、改 `ALLOWED_PT`、删页来凑通过，也禁止谎报通过。

---

## §2 JSON 契约

顶层字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `style` | 否 | `business_blue` / `academic_white` / `creative_purple` / `tech_dark` / `minimal_gray`，默认 `business_blue` |
| `footer` | 否 | 页脚文字，写入每页 C 区左侧 |
| `page_numbers` | 否 | 默认 `true`，显示 `NN / TOTAL` |
| `output` | 否 | 默认输出名；实际以 `--out` 优先 |
| `density` | 否 | `standard` / `dense` / `sparse`，供门禁使用，默认 `standard` |
| `slides` | **是** | 页数组，见下 |

每页公共字段：`type`（必填）、`title`。

| type | 专属字段 |
|---|---|
| `cover` | `subtitle` / `author` / `date` / `variant`（`centered` / `split` / `left`） |
| `section` | `subtitle` |
| `agenda` | `topics` / `highlight` |
| `content` | `items`（字符串或 `{t, s[]}`）/ `columns`（1 或 2） |
| `two_column` | `left` / `right` |
| `table` | `headers` / `rows` |
| `chart` | `chart_type`（`bar` / `bar_stacked` / `line` / `pie`）/ `categories` / `series`（`[{name, values}]`）/ **`insight`** |
| `timeline` | `milestones`（`[{label, desc, active}]`） |
| `quote` | `quote` / `attribution` |
| `image` | `image_path` / `caption` / `overlay` |
| `summary` | `points` / `conclusion` |
| `contact` | `info` |

### `chart.insight`（重要）

图表页**必须**给 `insight` 一句话结论。生成器在有 `insight` 时把图高从 5.2 in 收到 4.35 in，并在 `(0.8, 6.0, 11.7, 0.7)` 渲染 16pt 结论条；门禁的 `density` 也会把它计入该页字符数。

```json
{
  "type": "chart",
  "title": "收入结构：主业贡献八成",
  "chart_type": "bar",
  "categories": ["2025Q3", "2026Q3"],
  "series": [{"name": "主业订阅", "values": [7215, 8240]}],
  "insight": "增值服务增速已从 28% 降至 5.1%，是收入结构中最需要干预的单项。"
}
```

> 约束：禁止连续 3 页同 `type`；所有文本字号由生成器统一取自 §3 白名单，不要在 JSON 里塞字号。

---

## §3 交付

- 交付 `.pptx` **绝对路径** + 页数 + `passed: true` 的门禁结论。
- 同时保留 `DESIGN.md` 与 `slides.json`，便于复现。
- 生成器 stderr 出现「跳过」提示时，说明有页生成失败——**必须排查后重生成**，不能带着缺页交付。

---

## §4 失败与降级

| 场景 | 处理 |
|---|---|
| `scripts/setup.sh` exit 1 | 如实报告依赖缺失，按脚本提示处理一次；不硬编码其它解释器绕过 |
| 生成时某页报错 | 读 stderr 的「跳过」行，修正 JSON 字段或图片路径后重生成 |
| `image_path` 不存在 | 按 §5 降级到 `MSO_SHAPE` / 大色块 / 图形化 deck，不要留空页 |
| 门禁 3 轮未过 | 如实报告未过项，交付当前产物并标注「未通过门禁」，**禁止伪造通过** |
| 用户要求的效果 python-pptx 做不到（如 CSS 渐变） | 用 §2.2 的不透明等价色实现，并说明这是分层色块，不谎称渐变 |

---

## §5 参考

- [`references/design-system.md`](references/design-system.md) — 9 节视觉规范（步骤 1 必读）
- `scripts/setup.sh` — 环境自举，末行输出 `Python runner:` 供捕获
- `scripts/generate_pptx.py` — 生成器（`--help` 查看完整 JSON 示例）
- `scripts/check_design.py` — 机械门禁（`--json slides.json` 逐页应用密度阈值）

---

## 变更记录

- `3.0.0`：全文重写。新增 §1 强制四步流程（读设计系统 → 写 `DESIGN.md` → 生成 → 门禁最多修 3 轮）；JSON 契约补 `chart.insight` 与 `density`；补门禁 `--json slides.json` 用法与「禁止伪造通过」纪律；补齐 `category` / `version` / `tags` 与调用开关。
