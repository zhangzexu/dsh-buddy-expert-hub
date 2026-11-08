---
name: charts-create
description: >
  Create a chart: chart-type selection, data-source binding, newChart usage & example,
  placement & sizing, combo / dual-axis, and scatter recipes. Read
  (together with charts-visual) before any newChart. Triggers on: 生成图表 / 画个图 / 创建图表 /
  柱状图 / 折线图 / 饼图 / 环形图 / 散点图 / 气泡图 / 雷达图 / 趋势图 / 占比 / 对比图 /
  可视化 / 仪表盘 / 组合图 / 双轴图; "make / create / add a chart / graph / plot";
  "visualize / plot this"; a named chart type (bar / line / pie / scatter / bubble / radar /
  stacked / combo / dual-axis).
---

# Sheet Charts — Creating a Chart

> **Read this file together with charts-visual before any `newChart(...)`.** Creation always
> applies full styling in the same `newChart` call (system prompt rule 12), so you MUST Read
> **charts-visual** alongside this file — the `ChartType` values, the `ChartOptions` shape, and the
> styling / axis-scale / data-label rules needed to build the `options` blob all live there. This
> file alone cannot emit a correct chart. The chart *method* signatures (`Sheet.newChart` /
> `EmbeddedChart`) live in **sheet-api-reference**. To modify or delete an existing chart, see
> **charts-edit** / **charts-delete**.

## Reading structured WARN lines from `[log]` (MUST read for every chart run_command)

The Shim reports auto-adjustments and rejected inputs as **structured single-line** entries in the
tool-result `[log]` section. Format (stable protocol — parse it exactly):

```
[WARN:<level>:<code>] {json-detail}
```

- `<level>` is one of `info` / `warn` / `error`.
- `<code>` is a stable UPPER_SNAKE identifier (see codes below).
- `{json-detail}` is a single-line JSON object with contextual fields.

**Reading rules — you MUST follow these on every chart operation:**

1. **After every `run_command` that creates or edits a chart, scan the `[log]` section for
   `[WARN:...]` lines.** They tell you exactly what the Shim silently adjusted, dropped, or
   rejected. Ignoring them leaves the user with an unexplained result.
2. **`level=info`** — the Shim auto-adjusted something (e.g. avoided a collision, expanded rows).
   Include a brief note in your final reply to the user (e.g. "chart auto-placed at row 15 to avoid
   overlap") so the outcome is not opaque.
3. **`level=warn`** — the data may not match your intent (e.g. upstream tool missing, explicit
   position conflicts with existing charts). Adjust your next step or explain the caveat to the
   user; do not silently proceed.
4. **`level=error`** — the payload was **rejected**. Do NOT proceed. Read the detail, fix the
   offending field, and retry with a corrected `newChart` / `updateChart` call. Never assume the
   chart landed correctly when an `error` line appears.

**Codes you will encounter here:**

| Code | Level | What it means | Recommended action |
|---|---|---|---|
| `LAYOUT_ADJUSTED` | info | Auto-avoided a collision; anchor moved. `detail.finalAnchor` gives the actual position. | Reflect the new position in the user summary. |
| `LAYOUT_UNKNOWN_ANCHOR` | info | An existing chart's anchor is unknown; the new chart was pushed further down as a safety margin. | Mention the conservative shift if the user asked for a specific position. |
| `LAYOUT_EXPAND` | info | The target rectangle overshot the sheet; the Shim inserted rows/columns to make room. | No action needed; note if the sheet size changed materially. |
| `LAYOUT_EXPAND_REJECTED` | error | The requested position needed too many new rows/columns; the chart was NOT placed. | Retry with an anchor inside the current grid (`getMaxRows()` / `getMaxColumns()`) or a smaller `width`/`height`. |
| `LAYOUT_EXPLICIT_CONFLICT` | warn | You passed `explicitLayout: true` and the anchor collides with an existing chart/data. Nothing was moved. | Either accept the overlap intentionally, or retry with `detail.suggestedLocation`. |
| `LAYOUT_NO_FREE_SPOT` | error | Sheet is fully occupied within its bounds; no valid position exists. | Delete/relocate an existing chart, shrink the new chart, or enlarge the sheet. |
| `ERR_SCALE_NOT_FINITE` | error | `yAxis`/`secondaryYAxis` `scale.min` / `scale.max` / `majorUnit` / `minorUnit` was NaN / ±Infinity, or `min >= max`. The whole `scale` (or that specific unit) was dropped to protect the file. | Recompute the axis bounds from the actual data (filter out `#N/A` / non-numeric strings, ensure `min < max`) and retry. |
| `UPSTREAM_TOOL_MISSING` / `DIMENSION_UNAVAILABLE` / `SHEET_META_MISSING` | warn | An optional upstream capability isn't wired on this host; the Shim degraded (e.g. returned `0` / `[]`). | Use the fallback defaults noted in the relevant reference and do not treat it as a chart failure. |

Do not invent codes that aren't listed here. If a `[WARN:...]` line uses a code you don't recognise,
treat it as an `info` message: surface it verbatim in your reply so the user can act on it.

## Structured error prefixes `[ERR_*]`

Chart failures start with a stable `[ERR_<CODE>]` prefix — treat this as a non-retryable
protocol. For most codes the message tail is enough to fix the input (e.g. wrong `chartType`,
missing `drawing_id`, invalid size / data range). Two codes where you MUST NOT retry:

- `ERR_INTERNAL` — backend state anomaly (workbook not open, etc.); report the raw message and stop.
- `ERR_UNCLEAR_STATE` — script partially executed; call `sheet.getCharts()` or re-read the target
  range to reconcile the actual state before deciding next step.

## Choosing the Chart Type (decide BEFORE binding data / styling)

> **The chart type must follow the user's question and the data's shape — not a default.** The single most common failure is reaching for `COLUMN` / `LINE` / `PIE` out of habit when the data calls for something else. Before calling `newChart(...)`, name (1) what the user is trying to *see* (trend? ranking? composition? correlation? comparison across attributes?) and (2) the shape of the source (how many categories, how many numeric dimensions, is the x-axis ordered or categorical, are there negatives). Then pick from the table below. (Chart-type string values are listed in **charts-visual**.)

**Intent → recommended type:**

| What the user wants to see | Data shape | Recommended type | Notes |
|---|---|---|---|
| Trend over time | 1+ numeric series over an **ordered** x (dates / periods) | `LINE` (many points) / `COLUMN` (≤ ~8 discrete periods) | Line for continuity; column when each period is a discrete bucket to compare. |
| **Ranking / Top-N** | one numeric value per category, **sorted** | **`BAR`** (horizontal), sorted descending | This is the classic miss — see below. Use `BAR`, not `COLUMN`. |
| Compare a metric across a few entities | one value per category, unordered | `COLUMN` (short labels) / `BAR` (long labels or > ~8 categories) | Horizontal bar keeps long category names readable. |
| Part-to-whole (share of total) | one series, parts sum to 100%, **few** slices (≤ ~6) | `PIE` / `DOUGHNUT` | For > ~6 categories or any negative value, use a sorted `BAR` instead — pie becomes unreadable. |
| Composition over time — **absolute** | several series stacked per period | `STACKED_COLUMN` / `STACKED_AREA` | Total height = the running total; use when the total itself matters. |
| Composition over time — **share** | several series, want % mix per period | `PERCENT_STACKED_COLUMN` / `PERCENT_STACKED_AREA` | Each period normalised to 100%; use when only the *proportion* matters, not the absolute total. |
| Correlation between **two** numeric variables | x = numeric, y = numeric, no inherent order | **`SCATTER`** | Not `LINE`. `dataRange` = **exactly two** numeric columns (1st → X axis, 2nd → Y axis), nothing else; **both axis titles required** — see the Scatter Charts section below. |
| Relationship among **three** numeric dimensions | x, y, **and a magnitude** per point | **`BUBBLE`** | The forgotten one — see below. Bubble size encodes the third metric. |
| Compare a few entities across **several attributes** | 3–8 entities × 3–8 metrics on comparable scales | `RADAR` / `MARKER_RADAR` | e.g. comparing 3 products across price / battery / weight / rating. |
| Hierarchical part-to-whole | nested categories with a size each | `TREEMAP` | When there are many categories and a hierarchy, treemap beats a crowded pie. |
| Values by geographic region | one numeric value per region/country/province | `REGION_MAP` | Data must be region names/codes the map can resolve, not arbitrary categories. |
| Two metrics with very different magnitudes | e.g. revenue (¥10K) + growth rate (%) | combo on a secondary axis | See the Combo Charts section below — do **not** force both onto one axis. |

**Types the model frequently picks wrong (call these out to yourself before committing):**

- **Top-N → `BAR`, not `COLUMN`.** "Top 10 products by sales", "best-selling regions", "highest-spending customers" are rankings. Use a **horizontal `BAR`** sorted descending: long category names stay readable (column charts rotate/truncate them) and the eye reads a ranking top-to-bottom naturally. Default to `BAR` whenever the request contains "top N / ranking / 排名 / 最高 / 最畅销" **and** category labels are non-trivial.
- **Correlation → `SCATTER`, not `LINE`.** "Is there a relationship between ad spend and revenue?", "price vs units sold" — the x-axis has no natural order, so connecting points with a line is misleading. Use `SCATTER`, bind the `dataRange` to **exactly the two** numeric columns (1st → X, 2nd → Y, no extra columns), and show **both** axis titles — follow the dedicated scatter rules in the Scatter Charts section below. (A `*_SCATTER` smooth/straight variant merely connects the raw points in data order and is **NOT** a regression fit — for an actual fitted trend line use `series[i].trendlines`, see below.)
- **Three numeric dimensions → `BUBBLE`.** When the user wants to compare items on **two** metrics *and* weight them by a **third** (e.g. "revenue vs profit-margin, sized by market share", "risk vs return, sized by position size"), `BUBBLE` shows all three at once. The model almost never reaches for it — actively consider it whenever a third per-point magnitude exists. Data shape: 3 numeric columns (x, y, size).
- **Many categories → sorted `BAR`, not `PIE`.** A pie with 10+ slices (or near-equal slices, or any negative value) is unreadable. Switch to a sorted horizontal `BAR`. Reserve pie/doughnut for ≤ ~6 clearly-different parts of a genuine whole.
- **Share-over-time → `PERCENT_STACKED_*`, not `STACKED_*`.** If the user asks "how did the *mix* / *proportion* change over time", normalise to 100% with the percent-stacked variant. Use the plain `STACKED_*` only when the absolute total per period is itself the point.
- **Categorical x → `COLUMN`/`BAR`, not `LINE`.** A line across unordered categories (products, regions) implies a progression that doesn't exist.
- **No native histogram / box-plot.** There is no distribution chart type in the enum. If the user asks for a histogram or distribution, bucket the data into bins yourself (helper column, see the data-source rule below) and render the bin counts as a `COLUMN` chart; state the binning in the summary.

> **Data source — bind to existing cells first; build helper data only as a last resort.** Charts in a workbook are most useful when they read straight from the user's existing data: the user can see the source, edit it, and the chart updates accordingly. Fabricating a parallel "chart-only" table next to the original data clutters the sheet, surprises the user, and means future edits have to be made in two places.
>
> Decide the data source in this order:
>
> 1. **Use the existing data range as-is.** Find the columns/rows that already carry the values the chart needs (often the same range the user pointed at, or the obvious header + data block on the sheet) and pass that `Range` directly to `newChart(..., dataRange, ...)`. This is the default — almost every chart should land here.
> 2. **Trim / extend the range after creation via `chart.setDataRange(newRange)`.** If the initial chart picked up an extra column you didn't want (e.g. an `id` column dragged in alongside `month` + `revenue`), or missed a column the user asked for, do NOT delete the chart and call `newChart` again, and do NOT copy the source data into a fresh "clean" block. Just call `chart.setDataRange(sheet.getRange(...))` once with the corrected range — the rest of the styling (`options`) is preserved. Combined with the "apply styling on creation" rule (system prompt rule 12), this gives the cheapest "create once, refine in place" loop. For per-series shape changes that `setDataRange` cannot express (e.g. dropping a single series out of a multi-column block), fall back to `removeChart` + a new `newChart(...)` over the narrower range — still do NOT precompute a helper table for this.
> 3. **Only build auxiliary data when the source genuinely cannot serve the chart**, i.e. when ALL of the following are true:
>    - the shape is wrong and not just a column-range trim away (e.g. long-format data when the chart needs wide-format, or vice versa);
>    - or the chart needs an aggregation/derivation that no existing column carries (totals by month, % share, YoY growth, …) AND a formula in the original block isn't acceptable;
>    - or units / number formats in the source would distort the axis and rewriting the source isn't an option.
>
>    When you do create helper data, put it in a clearly named, isolated block (a few cells below or to the right of the source, with a header row stating what it represents), keep it minimal (only the columns the chart binds to), and mention it in the final summary so the user knows the helper cells exist.
>
> ❌ Anti-patterns to avoid:
>
> - Copy-pasting the original data into a "chart data" block just so the chart can read from "clean" cells when the original range was already usable.
> - Pre-aggregating numbers into JS arrays inside `run_command`, writing them into a brand-new cell block, and then pointing the chart at that block — when the same aggregation could be done by passing a wider source range and letting the chart group it, OR by a one-cell formula like `=SUMIFS(...)`.
> - Deleting and re-creating a chart over the "right" data when a single `chart.setDataRange(...)` would have fixed the bind.

- `sheet.newChart(drawingId, chartType, dataRange, anchorRow, anchorCol, offsetX, offsetY, width, height, options?)` — drawingId: string — Unique chart ID (required, generated by the caller); chartType: string — Chart type; dataRange: Range — Data source range; anchorRow: number — Anchor row (0-based; `-1` = let `newChart()` pick, see "Placing a new chart"); anchorCol: number — Anchor column (0-based; `-1` = let `newChart()` pick); offsetX: number — Horizontal offset in pixels; offsetY: number — Vertical offset in pixels; width: number — Width (≥1); height: number — Height (≥1); options?: `ChartOptions` — chart appearance config (title / axes / legend / series styling / data labels / etc.). **Always pass the complete styling through this parameter at creation time** (see charts-visual — Chart Styling Recommendations); do NOT do "newChart first, then `chart.setOptions(...)`" as two steps — that adds an extra write and shows the user an unstyled intermediate chart. Use `setOptions` **only when modifying an existing chart** (see charts-edit). Creates an embedded chart. The drawingId is generated and passed in by the caller; the engine holds this ID for subsequent update/delete operations. Returns EmbeddedChart.
- `sheet.insertChart(chart: EmbeddedChart)` — chart: EmbeddedChart — Chart object. Compatibility interface (the chart is already inserted at newChart time; this method is a no-op).

**Example:**

```javascript
// 1. Prepare test data (A1:B5)
const dataRange = sheet.getRange(1, 1, 5, 2);
dataRange.setValues([
    ['Month',    'Sales'],
    ['January',  100],
    ['February', 200],
    ['March',    150],
    ['April',    400],
]);
// 2. Add a chart — pass styling directly to newChart in one call (recommended).
//    Parameters: chartType, dataRange, anchorRow, anchorCol, offsetX, offsetY, width, height, options
//    anchorRow/anchorCol are 0-based; -1, -1 lets newChart pick (see "Placing a new chart")
const chart = sheet.newChart(
    'chart_001',
    'LINE',                            // Line chart
    sheet.getRange(1, 1, 5, 2),        // Data range A1:B5
    -1,                                // Anchor row
    -1,                                // Anchor column
    0,                                 // Horizontal offset
    0,                                 // Vertical offset
    600,                               // Width (pixels)
    375,                               // Height (pixels)
    {                                  // ← options: title / legend / axes all together
      title:  { text: 'Monthly Sales', visible: true,
                textStyle: { bold: true, fontSize: 16 } },
      legend: { visible: true, position: 'BOTTOM', textStyle: { fontSize: 12 } },
    },
);
```

## Placing a new chart — `newChart()` resolves the position

**Do NOT compute an anchor yourself** (probing `getCharts()`, walking `getColumnWidth()` /
`getRowHeight()`, checking sheet edges). `newChart()` already does it — including existing charts,
which `read_table` cannot show — and its answer is the one that takes effect.

It avoids exactly two things: the chart's own **source range** (`dataRange`) and **existing charts**.
Other cells may be covered.

- **User did not name a location → pass `-1, -1`.** The chart goes right of the source range
  (1-column gap, top-aligned) if it stays mostly within the first ~1200px (≈ 12 columns) of the
  sheet, otherwise below it (4-row gap, aligned with its first column). Further charts fill rows
  left to right (usually two per row) and leave a 1-row / 1-column gap between charts.
- **User named a location → pass that anchor.** It is used as-is unless it overlaps the source range
  or a chart; then it is moved (keeping the column when moving down). To never move it, add
  `explicitLayout: true` to options — you get a warning plus `suggestedLocation` instead. An explicit
  anchor must be inside the grid (`anchorRow < getMaxRows()`, `anchorCol < getMaxColumns()`).
- **Default size `600 × 375`** for every chart type; change it only when the user asks.
- **Never insert rows/columns to make room.** The grid is far larger than the used range, so the cells
  past the data already exist; inserting leaves blank bands in the user's sheet. If a chart runs past
  the grid edge, `newChart()` extends the sheet itself.

```javascript
// No location from the user: newChart picks the spot.
const line = sheet.newChart('chart_line', 'LINE', dataRange, -1, -1, 0, 0, 600, 375);
// "Put the pie chart at H2": never moved, even on conflict.
const pie = sheet.newChart('chart_pie', 'PIE', dataRange, 1, 7, 0, 0, 600, 375,
  { explicitLayout: true, title: 'Pie' });
```

## Combo Charts

A combo chart mixes **column / line / area** series in a single plot, and can bind chosen series to a **secondary y-axis** (right side) — typical use case is two metrics with very different magnitudes on the same chart (e.g. *"revenue (¥10K) + YoY/MoM growth rate (%)"*).

**Two paths to render a combo chart — pick by scenario:**

1. **Simple case — use an Excel preset combo `chartType`** (one chartType string is enough; no need to write `series.type`):

   | Business need | chartType |
   | --- | --- |
   | Column + line, sharing one y-axis | `'CLUSTERED_COLUMN_AND_LINE_COMBO'` |
   | Column + line, line on the **secondary axis** | `'CLUSTERED_COLUMN_AND_LINE_ON_SECONDARY_AXIS_COMBO'` |

   The preset's default split rule is *"the last series becomes the line, the rest become columns"*. If your data layout matches that rule, **strongly prefer the preset** — it is the simplest and least error-prone path.

2. **Fine-grained control — write `series[i].type` and `series[i].axis`** (top-level `chartType` is free; the shim auto-rewrites to `customCombo` when any `series[i].type` disagrees with the top-level type):

   ```javascript
   const chart = sheet.newChart(
     'chart_sales_growth',
     'COLUMN', // any top-level type; shim auto-rewrites to customCombo if series.type diverges
     dataRange,
     17, 0, 0, 0, 600, 375,
     {
       title: { text: '2024 Monthly Revenue & MoM Growth', visible: true, textStyle: { bold: true, fontSize: 16 } },
       legend: { visible: true, position: 'BOTTOM', textStyle: { fontSize: 12 } },
       xAxis: { gridlines: false, textStyle: { fontSize: 11 } },
       yAxis: { title: { text: 'Revenue (¥10K)', visible: true, textStyle: { fontSize: 12, bold: true } },
                numberFormat: '#,##0', scale: { min: 0, max: 500 }, gridlines: true,    // max from data scan
                textStyle: { fontSize: 11 } },
       series: [
         // Online channel revenue — clustered column, primary axis
         { type: 'COLUMN', axis: 'PRIMARY' },
         // Offline channel revenue — clustered column, primary axis
         { type: 'COLUMN', axis: 'PRIMARY' },
         // Total MoM growth rate — marker line, secondary axis
         { type: 'MARKER_LINE', axis: 'SECONDARY' },
       ],
     },
   );
   ```

**Allowed values for `series[i].type`** (OOXML `customCombo` only allows the column / line / area families):

- Column: `'COLUMN'` | `'STACKED_COLUMN'`
- Line:   `'LINE'` | `'MARKER_LINE'`
- Area:   `'AREA'` | `'STACKED_AREA'`

> ⚠️ Do **NOT** put `'PIE'` / `'SCATTER'` / `'BUBBLE'` / `'RADAR'` on `series.type` — OOXML does not allow mixing these types into a `customCombo`. The backend **silently ignores** such values and falls back to its built-in default (typically *"first series as a line, the rest as clustered columns"*), which is usually not what you intended.

**`series[i].axis`**: `'PRIMARY'` (default, left axis) / `'SECONDARY'` (right axis). When any series is bound to `SECONDARY`, communicate what the secondary axis represents (e.g. *"growth rate"*) through `secondaryYAxis.title.text` plus the main title / legend, so the reader can immediately tell what the left vs right axis means.

**Primary vs secondary y-axis — scale bounds (read this for any dual-axis chart):**

When a combo chart has a `SECONDARY` series, the primary y-axis is controlled by `options.yAxis` and the secondary y-axis is controlled independently by `options.secondaryYAxis`. The two have an identical field shape (`scale.min` / `scale.max` / `numberFormat` / `title` / `gridlines` / `textStyle` / …), and the backend matches them by OOXML `val_ax.ax_pos` (`l` = primary, `r` = secondary). **If `secondaryYAxis` is omitted, the backend falls back and applies `yAxis` to the secondary axis as well** (legacy-script compatibility); to make primary and secondary `scale.min` / `scale.max` independent, you MUST provide both blocks explicitly.

- **Compute `scale.min` / `scale.max` per the charts-visual "data-scan" workflow (Axes)** — primary axis scans the source column(s) bound to primary-axis series, secondary axis scans the source column(s) bound to secondary-axis series; never reuse one axis's scan results on the other. Dual-axis-specific notes:
  - **The secondary axis must carry a single unit** (either all percentages, or all absolute quantities). Don't bind both *"growth rate (%)"* and *"MoM delta (¥10K)"* to the secondary axis — the platform can only pick one `min` / `max` pair, so one of them will be squashed.
  - **If the secondary axis carries an absolute quantity** (two different units of currency / count), first compare the two axes' extents: if `primary.max ≥ 100 × secondary.max`, either rescale the secondary metric into a comparable magnitude in the source column (e.g. `¥10K → ¥`), or drop the dual axis entirely. Forcing two axes with extreme magnitude differences flattens one series into a near-zero line.
  - **Aligning the zero baseline across axes (mandatory when the secondary axis crosses zero)** — if the secondary-axis scan shows the data crosses zero (e.g. growth rate `actualMin = -0.18` / `actualMax = 0.34`, so per the charts-visual Axes workflow `secondaryYAxis.scale = { min: -0.20, max: 0.40 }`), and the primary axis is **line / scatter** with all non-negative values, nudge `yAxis.scale.min` slightly negative (proportional to `actualMax_primary`) so that zero falls at the same relative position on both axes — this aligns the two zero lines visually. If the primary axis is **column / bar / stacked**, `yAxis.scale.min` MUST still be `0` (hard rule, charts-visual — Axes); in that case zero sits at the bottom of the primary axis and the secondary's negative region falls below the primary's zero line — that is the expected look, do not violate the column-baseline rule for "alignment".
  - **`numberFormat` must be set per axis**: percentage secondary axis → `numberFormat: '0.0%'` or `'0%'`; currency secondary axis → `'$#,##0'` or `'#,##0'`. Never reuse the primary axis's `numberFormat` — the tick labels will then misrepresent the metric.
- **Secondary horizontal gridlines (`secondaryYAxis.gridlines`)**: default `false`, **MUST be emitted explicitly**. The primary axis already renders a set of horizontal gridlines (`yAxis.gridlines: true`); adding another set on top from the secondary axis produces overlapping, offset gridlines that look noisy. Additionally, when `secondaryYAxis` is omitted, the backend falls back to applying `yAxis.gridlines: true` to the secondary axis as well. **Even if you provide `secondaryYAxis` with other sub-fields but omit `gridlines`, the platform still applies `yAxis.gridlines` as the fallback** — to actually turn the secondary gridlines off, you must explicitly write `gridlines: false` inside `secondaryYAxis`.

**Minimal full example — column revenue + MoM growth-rate line, dual axis:**

```javascript
// Data scan (compute via get_cell_ranges / run_command BEFORE newChart):
//   Primary series (revenue, ¥10K)           actualMin=120,  actualMax=478   → scale.min=0 (column hard rule), max=500
//   Secondary series (MoM growth, crosses 0) actualMin=-0.18, actualMax=0.34 → scale.min=-0.20, max=0.40
const chart = sheet.newChart(
  'chart_sales_growth',
  'CLUSTERED_COLUMN_AND_LINE_ON_SECONDARY_AXIS_COMBO',
  dataRange,
  17, 0, 0, 0, 600, 375,
  {
    title: { text: '2024 Monthly Revenue & MoM Growth', visible: true,
             textStyle: { bold: true, fontSize: 16 } },
    legend: { visible: true, position: 'BOTTOM', textStyle: { fontSize: 12 } },
    // No xAxis.title at creation time (see charts-visual — Axes); add later via setOptions only if the user explicitly asks.
    xAxis: {
      gridlines: false, textStyle: { fontSize: 11 },
    },
    yAxis: {                                        // Primary: revenue (absolute, column → hard-coded min: 0)
      title: { text: 'Revenue (¥10K)', visible: true,
               textStyle: { fontSize: 12, bold: true } },
      numberFormat: '#,##0',
      scale: { min: 0, max: 500 },                  // min: column hard rule; max: ceil(478 * 1.05) snapped to 50
      gridlines: true,
      textStyle: { fontSize: 11 },
    },
    secondaryYAxis: {                               // Secondary: MoM growth (line, crosses zero)
      title: { text: 'MoM Growth Rate', visible: true,
               textStyle: { fontSize: 12, bold: true } },
      numberFormat: '0.0%',                         // independent percentage format
      scale: { min: -0.20, max: 0.40 },             // scan-based actualMin/Max ±5%, snapped to 0.05
      gridlines: false,                             // turn off to avoid overlapping with primary gridlines
      textStyle: { fontSize: 11 },
    },
  },
);
```

> To modify an existing combo chart, send a minimal patch only — see **charts-edit**.

**Common pitfalls:**

- Top-level `chartType: 'CUSTOM_COMBO'` but every `series[i]` omits `type` → the backend falls back to its built-in default and renders **all series as clustered columns** (a semantically neutral fallback; it does **NOT** auto-add a line or area). This is rarely what the user actually wants — explicitly write `series[i].type` / `series[i].axis` for each series, or switch to one of the three Excel presets above.
- Reaching for a combo chart when there are only one or two series → unnecessary complexity; a plain column / line chart fits better.
- A data range mixes *"revenue"* and *"share %"* in the same chart without enabling a secondary axis → the percentage line gets squashed into a near-flat line on the x-axis, and the chart becomes unreadable.
- The primary axis is column / bar / area / stacked-* but you forgot to set `yAxis.scale.min: 0` → columns float off the baseline and the magnitude is visually exaggerated. (This is the one exception to the charts-visual Axes data-scan workflow: column / bar / stacked / area MUST hard-code `min: 0` without scanning.)
- **Dual-axis chart provides `yAxis` only, no `secondaryYAxis`** → the backend applies `yAxis` to the secondary axis as well; when the two metrics have different units, one series will always be squashed. To get independent ranges (e.g. *"primary 0~max, secondary ±%"*), you MUST explicitly provide `secondaryYAxis.scale` and scan each axis's own source column(s) per the charts-visual Axes workflow.
- Primary and secondary axes **not scanned independently** — reusing primary's `scale.min/max` on secondary (or vice versa) → with different units (percentage vs currency), sharing one `scale` always squashes one of them. Scan each axis's own source series; never cross-apply.
- Hard-coding `yAxis.scale.max` / `secondaryYAxis.scale.max` from a guess (e.g. always `100` / `1000`) or omitting `scale` and relying on platform auto-fit → real data above the cap gets clipped, real data far below the cap makes the chart look flat, and auto-fit produces tick spacing that is inconsistent across charts. **Every y-axis bound MUST come from scanning the source data first**, then computing `min` / `max` per the charts-visual Axes workflow.
- Writing the secondary axis as `yAxis2` / `rightYAxis` / `secondaryY` or any other alias → none of these are valid field names, the backend ignores them. The only accepted name is `secondaryYAxis` (with the same shape as `yAxis`).
- Providing `secondaryYAxis` with `scale` / `numberFormat` / `title` set but **without an explicit `gridlines: false`** → the backend falls back to `yAxis.gridlines: true` for the secondary axis as well, producing two overlapping, offset sets of horizontal gridlines. **Any combo chart with a SECONDARY series MUST explicitly set `secondaryYAxis.gridlines: false`**.

## Scatter Charts (correlation) — REQUIRED setup

> Once the chart-type selection has led you to `SCATTER`, this is the build recipe. A scatter answers *"how do two numeric variables relate?"*, so it has its own non-negotiable rules that **override** the generic chart defaults. Triggers: 散点图 / scatter / "X vs Y / 相关性 / 关系 / 关联". Apply ALL of 1–4 every time you build a scatter.

1. **`dataRange` = exactly the two columns — nothing else.** Bind a **two-column** range: the **first** column is the **horizontal (X) axis**, the **second** is the **vertical (Y) axis**. The scatter back-end maps a 2-column rectangle to a single X-Y series; do **NOT** widen the range with a 3rd column (a fitted/trend column, an `id` / index / label column, a second metric) — the scatter does NOT treat extra columns as clean shared-X series and the chart comes out wrong. Both columns must be numeric (a scatter's x-axis is a VALUE axis, not categories); never put a text column on X — that silently degrades the chart into a category/line chart. If the source block has more than two numeric columns, pass `sheet.getRange(...)` for **only** the two the question is about (e.g. *"广告投入 vs 销售额"* → exactly those two); if they are not adjacent, this is the one case where copying the two columns into an adjacent helper block is justified so the single rectangle covers exactly X + Y.

2. **Bind the X axis to the first column; do NOT specify a series.** In the `newChart` options, set **`firstColumnAsCategory: true`** so the back-end uses the first column as the horizontal (X) axis values (this is a top-level `newChart` option, alongside `title` / `legend` / `xAxis` / …). A scatter needs **no** `series` config — omit the `series` block entirely, and do not set `useColumnAsSeries`. The second column becomes Y automatically.

3. **Both axis titles are MANDATORY** — this is the explicit **EXCEPTION** to the charts-visual *"omit `xAxis.title` at creation"* rule. A column/line chart's x-axis carries self-describing category labels, but a scatter's x-axis is bare numbers, so without a title the reader cannot tell what the horizontal axis measures. At `newChart` time you MUST emit **both** `xAxis.title` and `yAxis.title`, each with `visible: true`, `text` = the source column header (add the unit if the header omits it), and `textStyle: { bold: true, fontSize: 12 }`. The charts-visual font rule that normally forbids `xAxis.title.textStyle` at creation does NOT apply here.

4. **Styling.** Single X-Y series → `legend.visible: false` (the title carries the meaning; a one-entry legend is dead space). Scatter usually has ≥10 points → data labels stay **off** (charts-visual density rule). Both axes follow the **line/scatter** branch of the charts-visual `scale` workflow (scan each column's actualMin/actualMax independently). Keep the platform default marker color (no `series` block — see rule 2) unless the user asks for a specific color.

> **Trend line → `series[i].trendlines`, not a fabricated column.** If the user asks to see a fitted trend on the scatter, use `series[0].trendlines: [{ type: 'linear', ... }]` (see **charts-visual** "Trend lines" for the full field set and other fit types). Do **NOT** fake one by appending a fitted-`ŷ` column to `dataRange` (that produces the wrong chart, per rule 1), and do NOT confuse it with switching to a `*_SCATTER` line variant (those connect the raw points in data order — not a regression fit).

```javascript
// Source A1:B41 — A: 广告投入(万元), B: 销售额(万元), 40 data rows (row 1 = header).
// Axis scan (line/scatter branch): X actualMin≈5/max≈98 → 0~100; Y actualMin≈40/max≈520 → 0~550
const chart = sheet.newChart(
  'chart_scatter_corr',
  'SCATTER',
  sheet.getRange(1, 1, 41, 2),        // EXACTLY two columns: [X | Y]
  0, 3, 0, 0, 720, 420,
  {
    firstColumnAsCategory: true,                               // 第一列作为横轴(X)；散点图无需指定 series
    title:  { text: '广告投入 vs 销售额', visible: true,
              textStyle: { bold: true, fontSize: 16 } },
    legend: { visible: false },                                // single series → legend off
    xAxis: {                                                   // 散点图必须给 X 轴标题（例外规则）
      title: { text: '广告投入（万元）', visible: true, textStyle: { bold: true, fontSize: 12 } },
      numberFormat: '#,##0', scale: { min: 0, max: 100 }, gridlines: false,
      textStyle: { fontSize: 11 },
    },
    yAxis: {
      title: { text: '销售额（万元）', visible: true, textStyle: { bold: true, fontSize: 12 } },
      numberFormat: '#,##0', scale: { min: 0, max: 550 }, gridlines: true,
      textStyle: { fontSize: 11 },
    },
  },
);
```

## Common creation pitfalls

- **Inserting rows/columns to "make room" for the chart, or computing the anchor yourself** → see "Placing a new chart"; pass `-1, -1` unless the user named a location.
- **Scatter `dataRange` wider than two columns, or missing axis titles** → a scatter's `dataRange` MUST be exactly two columns (1st → X, 2nd → Y); a 3rd column (fitted/trend, `id`, a second metric) makes the chart come out wrong. It MUST also emit both `xAxis.title` and `yAxis.title` at creation (the one chart type that does). For an actual fitted trend line use `series[i].trendlines`, not an extra column or a `*_SCATTER` line variant. See the Scatter Charts section above.
