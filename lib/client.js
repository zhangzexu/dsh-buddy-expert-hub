window.__ModuleLoader__.load({
  id: "dsh-buddy-expert-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    // =======================================================================
    // 常量
    // =======================================================================

    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useCallback = React.useCallback;

    /** 主面板 key / 侧边栏入口 id，二者必须一致。 */
    var PANEL_ID = "dsh-buddy-expert-hub";

    /** 后端路由前缀。 */
    var API = "/dsh-buddy-expert-hub";

    /** 技能分页大小。 */
    var PAGE_SIZE = 60;

    /** 连接器分页大小（连接器整体量级小，一次多取一些）。 */
    var CONNECTOR_PAGE_SIZE = 500;

    /** 专家描述超过这个字数才出现「展开 / 收起」。 */
    var DESC_CLAMP_CHARS = 90;

    /** 召唤语兜底：没有 defaultInitPrompt 也没有快捷提示时使用。 */
    var FALLBACK_SUMMON = "你好，请介绍一下你能帮我做什么";

    /** 数据条取值的视觉长度超过这个值就降一档字号（中文按 2 计）。 */
    var STAT_COMPACT_UNITS = 10;

    /**
     * 兜底用的伪职业值。
     * 仓库里查不到的纯本地包会被后端填成「本地专家」，它不是真职业，
     * 不能拿来当标题，否则团队详情会出现「本地专家 | 鹏城信息AI专家」这种怪标题。
     */
    var FAKE_PROFESSIONS = ["本地专家", "本地已导入", "未分类", "unknown", "agent", "team"];

    /** YAML 块标符残留（`|` / `>-` / `>`），说明描述解析失败，当空处理。 */
    var BLOCK_MARKER_RE = /^[|>][-+]?\d*$/;

    /** 形如 `software-company` 的机器名（可以美化成 Software Company）。 */
    var SLUG_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

    /** 三大块分类图标：用户提供的 WorkBuddy 原生 SVG 路径（16x16 currentColor，内联避免额外请求）。 */
    var CATEGORY_ICONS = {
      expert: { transform: "matrix(1 0 0 1 1.36963 0.768944)", d: "M7.1035 0C8.6643 0 10.7053 0.0099 12.0742 1.5205C13.2979 2.8714 13.3086 4.7621 13.3086 6.1885L13.3086 8.1777C13.3086 10.1172 12.4294 11.8523 11.0498 13.004C8.8995 14.7989 5.3968 15.0938 3.2227 13.0078C2.3428 12.1634 1.8536 11.0199 1.7246 9.7939C0.8046 9.5348 0.112 8.7337 0.0127 7.7568L0 7.5146C0.0001 6.2068 1.0603 5.1465 2.3682 5.1465L2.6104 5.1592C3.6191 5.2617 4.4383 5.9978 4.6689 6.9629L5.6562 6.9629C5.9052 5.9216 6.8394 5.1465 7.957 5.1465L8.1992 5.1592C9.3932 5.2805 10.3251 6.2887 10.3252 7.5146L10.3125 7.7568C10.1912 8.9509 9.1831 9.8828 7.957 9.8828L7.7148 9.8701C6.7393 9.7711 5.939 9.0803 5.6787 8.1621L4.6445 8.1621C4.4136 8.9759 3.7594 9.6106 2.9346 9.8134C3.0599 10.7423 3.4425 11.555 4.0537 12.1416C5.6974 13.7188 8.498 13.5697 10.2803 12.0821C11.3984 11.1486 12.1084 9.7464 12.1084 8.1777L12.1084 6.1885C12.1084 4.677 12.0504 3.281 11.1856 2.3262C10.2269 1.2683 8.7608 1.1992 7.1035 1.1992C5.2192 1.1992 3.708 1.2459 2.6699 1.292C2.179 1.3138 1.7933 1.3357 1.5244 1.3525C1.4552 1.8424 1.5142 2.1892 1.625 2.4326C1.7619 2.733 2.0131 2.9569 2.3867 3.1113C3.1734 3.4364 4.3684 3.392 5.4512 3.1201L5.7441 4.2842C4.5613 4.5812 3.0644 4.6898 1.9287 4.2207C1.3415 3.978 0.8226 3.567 0.5322 2.9297C0.2457 2.2999 0.2194 1.5309 0.4434 0.6396L0.4736 0.5488C0.5603 0.3473 0.7528 0.2058 0.9766 0.1875L0.9785 0.1875C0.9785 0.1875 0.9822 0.1867 0.9844 0.1865C0.9892 0.1862 0.997 0.1862 1.0059 0.1855C1.0243 0.1841 1.0517 0.1813 1.0869 0.1787C1.1586 0.1735 1.265 0.166 1.4033 0.1572C1.6808 0.1396 2.0904 0.1162 2.6172 0.0928C3.6711 0.046 5.1999 0 7.1035 0ZM2.3682 6.3467C1.7231 6.3467 1.2003 6.8696 1.2002 7.5146C1.2002 8.1598 1.723 8.6826 2.3682 8.6826C3.0133 8.6826 3.5361 8.1598 3.5361 7.5146C3.5361 6.8696 3.0132 6.3467 2.3682 6.3467ZM7.957 6.3467C7.312 6.3467 6.7892 6.8696 6.7891 7.5146C6.7891 8.1598 7.3119 8.6826 7.957 8.6826C8.6021 8.6825 9.125 8.1598 9.125 7.5146C9.1249 6.8697 8.602 6.3468 7.957 6.3467Z", fillRule: "evenodd" },
      skill: { transform: "matrix(1 0 0 1 0.485779 0.117911)", d: "M4.6063 4.6987Q4.7494 4.7505 4.8255 4.7783Q5.7193 5.1048 6.5463 5.5015L0.59 11.4578Q0 12.0478 0 12.8821Q0 13.7164 0.59 14.3064Q1.1799 14.8963 2.0142 14.8963Q2.8485 14.8963 3.4385 14.3064L8.8444 8.9005L7.9958 8.052L2.59 13.4578Q2.3515 13.6963 2.0142 13.6963Q1.677 13.6963 1.4385 13.4578Q1.2 13.2193 1.2 12.8821Q1.2 12.5448 1.4385 12.3064L7.6601 6.0847Q8.8609 6.7696 9.9038 7.6204Q12.3371 9.6056 13.2462 12.0051Q13.3286 12.2429 13.5609 12.3395Q13.7872 12.4495 14.0199 12.3536Q14.194 12.2902 14.2984 12.1372Q14.4068 11.987 14.4072 11.8017Q14.459 8.4358 12.2057 5.3174Q9.969 2.2218 6.2641 0.4907Q5.6636 0.2101 5.415 0.1409Q4.9087 0 4.4826 0.1859Q4.1015 0.3522 3.8452 0.7962Q3.7204 1.0124 3.4651 1.6298L3.4638 1.633L3.4222 1.7337Q3.4095 1.7643 3.3849 1.8238Q3.1054 2.4987 3.0381 2.7676Q2.8998 3.3203 3.1034 3.7425Q3.2831 4.1152 3.7555 4.3571Q3.9811 4.4726 4.6063 4.6987ZM10.6624 6.6906Q8.315 4.7755 5.2372 3.6511Q5.1593 3.6227 5.0145 3.5703Q4.2127 3.2802 4.1843 3.2213Q4.1416 3.1328 4.4936 2.2829Q4.5183 2.2232 4.5311 2.1922L4.5728 2.0915L4.5741 2.0883Q4.8934 1.3159 4.9625 1.2858Q5.0496 1.2478 5.7561 1.5779Q9.1787 3.1771 11.233 6.0201Q12.1806 7.3316 12.6737 8.6809Q11.8234 7.6378 10.6624 6.6906ZM10.0312 10.5647C9.9585 10.3032 9.5796 10.3284 9.4539 10.6029L8.8284 11.9696C8.7889 12.0557 8.7157 12.1262 8.6286 12.163L7.2451 12.7441C6.9676 12.861 6.9301 13.2405 7.1879 13.3222L8.473 13.7281C8.5541 13.7537 8.6138 13.8161 8.6366 13.8983L8.998 15.1995C9.0706 15.461 9.4496 15.4358 9.5753 15.1612L10.2008 13.7945C10.2404 13.7084 10.3135 13.6379 10.4006 13.6012L11.7831 13.0201C12.0609 12.9032 12.0984 12.5235 11.8403 12.442L10.5562 12.0361C10.4752 12.0105 10.4155 11.9488 10.3926 11.8669L10.0312 10.5647Z", fillRule: "evenodd" },
      connector: { transform: "matrix(1 0 0 1 0.435199 0.715962)", d: "M7.5656 4.2827C8.2868 4.6991 8.7999 5.2128 9.1214 5.8068C9.4424 6.4 9.5528 7.0359 9.5284 7.6644C9.5192 7.8997 9.4911 8.1358 9.4474 8.3709L8.3226 7.7215C8.325 7.6869 8.3279 7.6525 8.3293 7.6183C8.3469 7.1636 8.2661 6.7484 8.0655 6.3778C7.8653 6.0082 7.5257 5.6444 6.966 5.3213C6.4063 4.9981 5.9214 4.8859 5.5013 4.8973C5.08 4.9089 4.68 5.0465 4.2951 5.2892C3.5056 5.787 2.8232 6.6961 2.254 7.6819C1.6848 8.6678 1.2387 9.7133 1.2024 10.6459C1.1847 11.1006 1.2655 11.5158 1.4661 11.8864C1.6663 12.256 2.0059 12.6198 2.5656 12.9429C3.1254 13.2661 3.6102 13.3783 4.0304 13.3669C4.4516 13.3553 4.8516 13.2177 5.2365 12.975C5.7924 12.6245 6.2937 12.0689 6.7412 11.4273L7.784 12.0294C7.2672 12.7855 6.6365 13.511 5.876 13.9904C5.3439 14.3258 4.738 14.5482 4.0638 14.5668C3.3886 14.5853 2.6872 14.3978 1.966 13.9815C1.2448 13.5651 0.7317 13.0514 0.4102 12.4574C0.0892 11.8642 -0.0211 11.2283 0.0033 10.5998C0.0512 9.3663 0.6211 8.1118 1.2154 7.0823C1.8098 6.0528 2.6114 4.932 3.6556 4.2738C4.1877 3.9384 4.7936 3.716 5.4678 3.6974C6.143 3.6789 6.8445 3.8663 7.5656 4.2827ZM13.1637 0.5865C13.8848 1.0029 14.3979 1.5167 14.7195 2.1106C15.0405 2.7038 15.1508 3.3397 15.1264 3.9683C15.0785 5.2017 14.5086 6.4563 13.9142 7.4858C13.3199 8.5153 12.5183 9.636 11.4741 10.2943C10.942 10.6296 10.3361 10.8521 9.6618 10.8706C8.9867 10.8892 8.2852 10.7017 7.5641 10.2853C6.8429 9.869 6.3298 9.3552 6.0083 8.7613C5.6873 8.1681 5.5769 7.5322 5.6013 6.9037C5.6105 6.6684 5.6386 6.4323 5.6823 6.1971L6.8071 6.8465C6.8046 6.8811 6.8018 6.9155 6.8004 6.9498C6.7828 7.4045 6.8636 7.8197 7.0642 8.1903C7.2643 8.5599 7.6039 8.9236 8.1637 9.2468C8.7234 9.5699 9.2083 9.6822 9.6284 9.6707C10.0497 9.6591 10.4496 9.5215 10.8346 9.2789C11.6241 8.7811 12.3065 7.872 12.8757 6.8862C13.4449 5.9003 13.8909 4.8548 13.9273 3.9221C13.945 3.4674 13.8642 3.0523 13.6636 2.6816C13.4634 2.3121 13.1238 1.9483 12.5641 1.6251C12.0043 1.3019 11.5195 1.1897 11.0993 1.2012C10.6781 1.2128 10.2781 1.3504 9.8932 1.593C9.3373 1.9435 8.836 2.4991 8.3884 3.1407L7.3456 2.5387C7.8624 1.7825 8.4932 1.057 9.2537 0.5776C9.7858 0.2422 10.3917 0.0198 11.0659 0.0013C11.7411 -0.0173 12.4425 0.1702 13.1637 0.5865Z" },
    };

    /** serialize 截断阈值（readme / config 正文）。 */
    var SERIALIZE_LIMIT = 6000;

    /** 专家分类中文名。 */
    var CATEGORY_LABELS = {
      "01-ProductDesign": "产品设计",
      "02-Engineering": "工程技术",
      "03-GameSpatial": "游戏与空间",
      "04-DataAI": "数据与 AI",
      "06-ContentCreative": "内容创意",
      "08-FinanceInvestment": "金融投资",
      "10-ProjectQuality": "项目质量",
      "11-SecurityCompliance": "安全合规",
      "12-IndustryConsultant": "行业顾问",
      "13-TencentZone": "腾讯专区"
    };

    /** 四个底层数据键（接口 / 分页 / 搜索仍按这四个走）。 */
    var TABS = [
      { id: "experts", label: "专家", countKey: "experts", placeholder: "搜索专家名称、职业、描述、标签" },
      { id: "teams", label: "专家团", countKey: "teams", placeholder: "搜索专家团名称、职业、描述" },
      { id: "skills", label: "技能", countKey: "skills", placeholder: "搜索技能名称或描述" },
      { id: "connectors", label: "连接器", countKey: "connectors", placeholder: "搜索连接器名称或描述" }
    ];

    /** 三大块分栏：专家（内含专家 / 专家团子分组）、技能、连接器。 */
    var GROUPS = [
      { id: "expert", label: "专家", icon: "expert", children: ["experts", "teams"] },
      { id: "skill", label: "技能", icon: "skill", children: ["skills"] },
      { id: "connector", label: "连接器", icon: "connector", children: ["connectors"] }
    ];

    /**
     * 由底层 tab 反查所属大块 id。
     * @param {string} tab 数据键
     * @returns {string} 大块 id
     */
    function groupOfTab(tab) {
      for (const group of GROUPS) {
        if (group.children.indexOf(tab) >= 0) return group.id;
      }
      return "expert";
    }

    /**
     * 大块计数：专家块 = 专家 + 专家团之和。
     * @param {string} groupId 大块 id
     * @param {Record<string, number>} counts 计数表
     * @returns {number} 合计
     */
    function groupCount(groupId, counts) {
      return TABS.filter((t) => groupOfTab(t.id) === groupId)
        .reduce((sum, t) => sum + Number(counts[t.countKey] || 0), 0);
    }

    // =======================================================================
    // 样式（统一 dshe- 前缀，dsh 设计变量 + 浅色兜底）
    // =======================================================================

    var CSS = [
      /* ---- 面板骨架 -------------------------------------------------------- */
      ".dshe-root{width:100%;height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:1.55;text-align:left}",
      ".dshe-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:18px 24px 12px}",
      ".dshe-head-main{min-width:0}",
      ".dshe-title{margin:0;font-size:16px;font-weight:600;letter-spacing:.2px}",
      ".dshe-sub{margin:3px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-head-actions{display:flex;align-items:center;gap:8px}",
      ".dshe-search{width:250px;max-width:42vw;height:30px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:inherit;font-size:12.5px;outline:none}",
      ".dshe-search:focus{border-color:var(--dsw-alias-brand-primary,#0969da);background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-btn{height:30px;padding:0 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px;cursor:pointer;white-space:nowrap}",
      ".dshe-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-btn:disabled{opacity:.55;cursor:default}",
      ".dshe-btn-primary{border-color:var(--dsw-alias-brand-primary,#0969da);background:var(--dsw-alias-brand-primary,#0969da);color:#fff}",
      ".dshe-btn-primary:hover:not(:disabled){color:#fff;opacity:.9}",
      ".dshe-tabs{display:flex;gap:4px;padding:0 24px;border-bottom:1px solid var(--dsw-alias-border-l1,#d0d7de)}",
      ".dshe-tab{position:relative;display:inline-flex;align-items:center;gap:6px;padding:9px 12px;border:none;border-bottom:2px solid transparent;background:none;color:var(--dsw-alias-label-secondary,#57606a);font-size:13px;font-weight:500;cursor:pointer;margin-bottom:-1px}",
      ".dshe-tab:hover{color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-tab-on{color:var(--dsw-alias-brand-primary,#0969da);border-bottom-color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:17px;padding:0 5px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#eef1f4);color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;font-weight:600}",
      ".dshe-tab-on .dshe-tab-badge{background:var(--dsw-alias-brand-primary,#0969da);color:#fff}",
      ".dshe-tab svg{flex:none;display:block}",
      /* 专家块内的二级子分组（专家 / 专家团） */
      ".dshe-subtabs{display:flex;gap:6px;padding:8px 24px 0}",
      ".dshe-subtab{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 11px;border:1px solid transparent;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#eef1f4);color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;font-weight:500;cursor:pointer}",
      ".dshe-subtab:hover{color:var(--dsw-alias-label-primary,#1f2328);border-color:var(--dsw-alias-border-l1,#d0d7de)}",
      ".dshe-subtab-on{background:rgba(9,105,218,.10);border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-subtab-badge{font-size:11px;font-weight:600;opacity:.8}",
      /* ---- SkillHub 商店 --------------------------------------------------- */
      ".dshe-hub-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}",
      ".dshe-hub-search{flex:1;min-width:180px;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:13px;color:inherit;outline:none}",
      ".dshe-hub-search:focus{border-color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-hub-cats{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}",
      ".dshe-hub-cat{height:24px;padding:0 10px;border:1px solid #e5e7eb;border-radius:999px;background:#fff;color:#4b5563;font-size:12px;cursor:pointer;transition:background .12s,color .12s,border-color .12s}",
      ".dshe-hub-cat:hover{background:#f6f7f8;color:#111827}",
      ".dshe-hub-cat-on{background:rgba(9,105,218,.10);border-color:#0969da;color:#0969da;font-weight:600}",
      ".dshe-hub-card{display:flex;flex-direction:column;gap:7px;min-width:0;padding:10px;border-radius:10px;border:1px solid #eef0f2;background:var(--dsw-alias-bg-layer-1,#fff);transition:border-color .14s,box-shadow .14s}",
      ".dshe-hub-card:hover{border-color:#e1e5ea;box-shadow:0 4px 16px rgba(0,0,0,.06)}",
      ".dshe-hub-head{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dshe-hub-icon{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;overflow:hidden;background:#eef1f4;color:#9ca3af}",
      ".dshe-hub-icon img{width:100%;height:100%;object-fit:cover}",
      ".dshe-hub-title{min-width:0;flex:1;font-size:12.5px;font-weight:600;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-hub-desc{font-size:12px;line-height:1.5;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-hub-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}",
      ".dshe-hub-meta{font-size:11px;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-hub-get{flex:none;height:22px;padding:0 9px;border:none;border-radius:6px;background:#16a34a;color:#fff;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap}",
      ".dshe-hub-get:disabled{background:#e5e7eb;color:#9ca3af;cursor:default}",
      ".dshe-hub-state{padding:28px 0;text-align:center;color:#9ca3af;font-size:13px}",
      ".dshe-hub-err{color:#b42318}",
      /* 商店详情抽屉 */
      ".dshe-hub-hero{display:flex;align-items:center;gap:14px;min-width:0}",
      ".dshe-hub-hero-icon{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:14px;overflow:hidden;background:#eef1f4;color:#9ca3af}",
      ".dshe-hub-hero-icon img{width:100%;height:100%;object-fit:cover}",
      ".dshe-hub-hero-id{min-width:0;flex:1}",
      ".dshe-hub-hero-name{margin:0;font-size:19px;font-weight:650;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-hub-hero-sub{margin-top:3px;font-size:12.5px;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-hub-hero-get{height:28px;padding:0 14px;font-size:12.5px;border-radius:7px}",
      ".dshe-hub-hero-meta{margin-top:14px;font-size:12.5px;color:#6b7280}",
      ".dshe-hub-hero-desc{margin-top:14px;font-size:13.5px;line-height:1.7;color:#374151;white-space:pre-wrap;word-break:break-word}",
      ".dshe-hub-section{margin-top:22px}",
      ".dshe-hub-section-title{margin:0 0 8px;font-size:13px;font-weight:650;color:#111827}",
      ".dshe-hub-pre{margin:0;padding:14px;max-height:320px;overflow:auto;border-radius:10px;background:#f6f8fa;border:1px solid #eef0f2;font-size:12.5px;line-height:1.65;color:#374151;white-space:pre-wrap;word-break:break-word}",
      ".dshe-hub-src{margin-top:20px;font-size:12px;color:#9ca3af;word-break:break-all}",
      ".dshe-hub-src a{color:#0969da;text-decoration:none}",
      ".dshe-hub-src a:hover{text-decoration:underline}",
      ".dshe-hub-note{margin-top:10px;font-size:12px;color:#9ca3af}",
      /* 已安装技能库 */
      ".dshe-inst-group{margin-bottom:20px}",
      ".dshe-inst-group-title{margin:0 0 10px;font-size:13px;font-weight:600;color:#4b5563}",
      ".dshe-inst-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(max(280px, calc((100% - 28px) / 3)), 1fr));gap:14px}",
      ".dshe-inst-card{display:flex;align-items:center;gap:12px;min-width:0;padding:12px;border-radius:12px;border:1px solid #eef0f2;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-inst-tile{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9px;font-size:15px;font-weight:700;user-select:none}",
      ".dshe-inst-info{flex:1;min-width:0}",
      ".dshe-inst-name{display:flex;align-items:center;gap:6px;font-size:13.5px;font-weight:600;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-inst-tag{flex:none;padding:1px 6px;border-radius:4px;background:#eff6ff;color:#1d4ed8;font-size:10.5px;font-weight:600}",
      ".dshe-inst-desc{margin-top:3px;font-size:12px;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-switch{box-sizing:border-box;flex:none;position:relative;width:34px;height:20px;padding:0;border:none;border-radius:999px;background:#d8dce1;cursor:pointer;transition:background .14s}",
      ".dshe-switch-on{background:#16a34a}",
      ".dshe-switch-dot{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .14s}",
      ".dshe-switch-on .dshe-switch-dot{transform:translateX(14px)}",
      ".dshe-body{flex:1;min-height:0;overflow:auto;padding:16px 24px 40px;scrollbar-gutter:stable}",

      /* ---- 专家 / 专家团卡片 ---------------------------------------------- */
      ".dshe-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(max(220px, calc((100% - 56px) / 5)), 1fr));gap:14px}",
      ".dshe-card{display:flex;flex-direction:column;gap:7px;padding:10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);text-align:left;cursor:pointer;color:inherit;font-size:13px;transition:border-color .12s,box-shadow .12s}",
      ".dshe-card:hover{border-color:var(--dsw-alias-brand-primary,#0969da);box-shadow:0 4px 14px rgba(9,105,218,.12)}",
      ".dshe-card-head{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dshe-card-id{min-width:0;flex:1}",
      ".dshe-card-name{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      /* 名称下方的小字副标题已移除（用户要求）；描述收敛为单行 */
      ".dshe-card-prof{display:none}",
      ".dshe-card-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#57606a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-height:18px}",
      /* 卡片右上「召唤」：绿色实心胶囊，不冒泡（点它不打开详情） */
      ".dshe-card-summon{flex:none;height:22px;padding:0 8px;border:none;border-radius:6px;background:#16a34a;color:#fff;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap}",
      ".dshe-card-summon:hover{background:#15803d}",
      ".dshe-card-summon:disabled{background:#d7dade;cursor:default}",
      ".dshe-avatar{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;object-fit:cover;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#eef1f4)}",
      ".dshe-avatar-letter{font-weight:600;line-height:1}",
      ".dshe-avatar-placeholder{display:inline-flex;align-items:center;justify-content:center;background:#eef1f4;color:#9ca3af}",
      ".dshe-chips{display:flex;flex-wrap:wrap;gap:5px}",
      /* 标签 chip：加深底色 + 深色字 + 细描边，形成层次（用户反馈原样式太浅） */
      ".dshe-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:5px;border:1px solid rgba(31,35,40,.08);background:#e8ecf1;color:#3d4451;font-size:11.5px;font-weight:500;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}",
      ".dshe-chip-muted{background:transparent;border:1px solid var(--dsw-alias-border-l1,#d0d7de)}",

      /* ---- 技能列表（分组 + 行） ------------------------------------------- */
      ".dshe-row{display:flex;align-items:center;gap:10px;width:100%;padding:8px 6px;border:none;border-radius:6px;background:none;text-align:left;cursor:pointer;color:inherit;font-size:13px}",
      ".dshe-row:hover{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}",
      ".dshe-row-name{flex:0 0 auto;max-width:30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}",
      ".dshe-row-desc{flex:1 1 auto;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-row-meta{flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;min-width:max-content}",
      ".dshe-row-meta .dshe-chip{flex:0 0 auto;max-width:none;white-space:nowrap;overflow:visible;text-overflow:clip}",

      /* ---- 连接器卡片网格 ------------------------------------------------- */
      ".dshe-conn-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(max(220px, calc((100% - 56px) / 5)), 1fr));gap:14px}",
      "",
      "@media (max-width:520px){.dshe-grid,.dshe-conn-grid,.dshe-skill-grid{grid-template-columns:minmax(0,1fr)}}",
      ".dshe-conn-card{display:flex;flex-direction:column;gap:9px;min-width:0;padding:16px;border-radius:14px;border:1px solid #eef0f2;background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;transition:border-color .14s,box-shadow .14s}",
      ".dshe-conn-card:hover{border-color:#e1e5ea;box-shadow:0 4px 16px rgba(0,0,0,.06)}",
      ".dshe-conn-head{display:flex;align-items:center;gap:10px;min-width:0}",
      ".dshe-conn-tile{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;border:1px solid #f2f3f5;background:#fff;overflow:hidden;color:#6b7280;font-size:16px;font-weight:600}",
      ".dshe-conn-tile img{width:32px;height:32px;object-fit:contain;display:block}",
      ".dshe-conn-name-btn{flex:1 1 auto;min-width:0;margin:0;padding:0;border:none;background:none;color:#111827;font:inherit;font-size:15px;font-weight:600;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-conn-name-btn:hover{color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-conn-add{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid #e5e7eb;border-radius:50%;background:#fff;color:#b9bec4;cursor:pointer;transition:background .12s,color .12s,border-color .12s}",
      ".dshe-conn-card:hover .dshe-conn-add{color:#6b7280;border-color:#d8dce1}",
      ".dshe-conn-add:hover{background:#f3f4f6;color:#111827;border-color:#c9ced4}",
      ".dshe-conn-desc{font-size:13px;line-height:1.55;color:#9ca3af;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:40px;word-break:break-word}",

      /* ---- 技能卡片网格（横向宽卡片，2 列保证标题/描述可读） --------------- */
      /* minmax(0,1fr) 防长名撑破列宽（老教训）；横向布局在 5 列下会被压成「A..」 */
      ".dshe-skill-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(max(260px, calc((100% - 42px) / 4)), 1fr));gap:14px}",
      "@media (max-width:760px){.dshe-grid,.dshe-conn-grid,.dshe-skill-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}",
      /* 参考图：横向布局 = 左图标 + 右（标题 / 一行描述）+ 右上「+」，无底部元信息 */
      ".dshe-skill-card{display:flex;flex-direction:row;align-items:center;gap:12px;min-width:0;padding:14px;border-radius:12px;border:1px solid #eef0f2;background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;transition:border-color .14s,box-shadow .14s}",
      ".dshe-skill-card:hover{border-color:#e1e5ea;box-shadow:0 4px 16px rgba(0,0,0,.06)}",
      ".dshe-skill-tile{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;border:1px solid rgba(0,0,0,.04);font-size:17px;font-weight:700;user-select:none}",
      ".dshe-skill-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
      ".dshe-skill-add{flex:none;align-self:flex-start;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid #e5e7eb;border-radius:7px;background:#f7f8fa;color:#9ca3af;cursor:pointer;transition:background .12s,color .12s,border-color .12s}",
      ".dshe-skill-card:hover .dshe-skill-add{color:#6b7280;border-color:#d8dce1}",
      ".dshe-skill-add:hover{background:#f3f4f6;color:#111827;border-color:#c9ced4}",
      ".dshe-skill-name{font-size:14px;font-weight:600;line-height:1.35;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-skill-desc{font-size:12.5px;line-height:1.45;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",

      /* ---- 会话常驻专家 chip（conversation.input.left 工具栏行内槽） -------- */
      /* 对齐 WorkBuddy 工具栏原生元素：无胶囊/边框/阴影，扁平行内、安静待着 */
      ".dshe-dock{display:inline-flex;flex-wrap:nowrap;align-items:center;gap:6px;padding:0;margin:0;vertical-align:middle;min-width:0}",
      ".dshe-dock-chip{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:220px;padding:2px 4px;border:none;border-radius:6px;background:transparent;font-size:13px;font-weight:400;color:#374151;transition:background .12s}",
      ".dshe-dock-chip:hover,.dshe-dock-chip:focus-within{background:#f3f4f6}",
      /* 真实头像资产（无资产时用统一中性人形占位，不按名字生成彩色圆/字母圆） */
      ".dshe-dock-avatar{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;overflow:hidden;background:#eef1f4;color:#9ca3af;user-select:none}",
      ".dshe-dock-avatar img{width:16px;height:16px;object-fit:cover;display:block}",
      ".dshe-dock-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;color:#374151}",
      ".dshe-dock-pending{flex:none;font-size:11px;color:#b45309;background:transparent;border-radius:0;padding:0}",
      /* × 只在 hover/focus 时出现；保留 aria-label 可访问性 */
      ".dshe-dock-remove{opacity:0;flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:none;border-radius:50%;background:transparent;color:#9ca3af;cursor:pointer;transition:opacity .12s,background .12s,color .12s}",
      ".dshe-dock-chip:hover .dshe-dock-remove,.dshe-dock-chip:focus-within .dshe-dock-remove{opacity:1}",
      ".dshe-dock-remove:hover{background:#e5e7eb;color:#111827}",
      /* 会话常驻连接器 chip：约 28×28 圆角方块，只放真实品牌图标，不显示文字；
         紧跟专家 chip 之后（专家按钮旁边），可多个并列。 */
      ".dshe-dock-conn{position:relative;box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:3px;border:1px solid #eef0f2;border-radius:8px;background:#fff;color:#6b7280;font-size:12px;font-weight:600;user-select:none;transition:border-color .12s,background .12s}",
      ".dshe-dock-conn:hover,.dshe-dock-conn:focus-within{border-color:#d8dce1;background:#f7f8fa}",
      ".dshe-dock-conn img{width:18px;height:18px;object-fit:contain;display:block}",
      ".dshe-dock-conn-fallback{display:inline-flex;align-items:center;justify-content:center;line-height:1;color:#9ca3af}",
      ".dshe-dock-conn-pending{position:absolute;bottom:1px;right:1px;width:5px;height:5px;border-radius:50%;background:#f59e0b}",
      /* 右上角小 ×：只在 hover/focus 时出现，保持工具栏安静 */
      ".dshe-dock-conn-remove{position:absolute;top:-6px;right:-6px;opacity:0;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;padding:0;border:1px solid #e5e7eb;border-radius:50%;background:#fff;color:#9ca3af;cursor:pointer;transition:opacity .12s,background .12s,color .12s}",
      ".dshe-dock-conn:hover .dshe-dock-conn-remove,.dshe-dock-conn:focus-within .dshe-dock-conn-remove{opacity:1}",
      ".dshe-dock-conn-remove:hover{background:#f3f4f6;color:#111827}",

      /* ---- 紧凑专家选择器（conversation.input.overlay 自绘浮层） ---------- */
      /* overlayAnchor 是 height:0 的绝对定位容器；面板向上弹出，层级高于宿主菜单(100) */
      ".dshe-picker{position:absolute;bottom:calc(100% + 4px);left:8px;z-index:120;box-sizing:border-box;width:270px;max-width:calc(100% - 16px);display:flex;flex-direction:column;padding:10px;border:1px solid #eef0f2;border-radius:12px;background:#fff;box-shadow:0 8px 28px rgba(0,0,0,.12);font-size:13px}",
      ".dshe-picker-search{display:flex;align-items:center;gap:6px;height:34px;padding:0 10px;border-radius:10px;background:#f3f4f6;color:#9ca3af}",
      ".dshe-picker-search-icon{flex:none;font-size:16px;line-height:1}",
      ".dshe-picker-input{flex:1;min-width:0;border:none;background:transparent;outline:none;font-size:13px;color:#111827}",
      ".dshe-picker-input::placeholder{color:#9ca3af}",
      ".dshe-picker-list{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow-y:auto;padding:8px 0 6px}",
      ".dshe-picker-row{display:flex;align-items:center;gap:9px;min-width:0;width:100%;height:36px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:#374151;font-size:13px;text-align:left;cursor:pointer}",
      ".dshe-picker-row:hover,.dshe-picker-row-cursor{background:#f6f7f8}",
      ".dshe-picker-row-on{background:#F0F9F1}",
      ".dshe-picker-row-on:hover{background:#F0F9F1}",
      ".dshe-picker-avatar{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;overflow:hidden;background:#eef1f4;color:#9ca3af;user-select:none}",
      /* 技能/连接器用分类图标：方形圆角 + 深一点的底色，与专家头像圆区分 */
      ".dshe-picker-avatar-cat{border-radius:7px;background:#e8ecf1;color:#4b5563}",
      ".dshe-picker-avatar-tile{font-size:12px;font-weight:700;user-select:none}",
      /* 「应用」= 把技能/连接器作为结构化引用插进当前对话草稿 */
      ".dshe-card-apply{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid #bbf7d0;border-radius:7px;background:#f0fdf4;color:#15803d;cursor:pointer;transition:background .12s,color .12s}",
      ".dshe-card-apply:hover{background:#16a34a;border-color:#16a34a;color:#fff}",
      ".dshe-card-apply-off{background:#f6f7f8;border-color:#e5e7eb;color:#c4c9cf;cursor:not-allowed}",
      ".dshe-card-apply-off:hover{background:#f6f7f8;border-color:#e5e7eb;color:#c4c9cf}",
      ".dshe-picker-avatar img{width:24px;height:24px;object-fit:cover;display:block}",
      ".dshe-picker-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-picker-check{flex:none;color:#16a34a;font-size:14px;font-weight:700}",
      ".dshe-picker-state{padding:14px 8px;text-align:center;color:#9ca3af;font-size:12px}",
      ".dshe-picker-state-err{color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dshe-picker-foot{border-top:1px solid #eef0f2;padding-top:6px}",
      ".dshe-picker-more{display:flex;align-items:center;gap:6px;width:100%;height:32px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:#374151;font-size:13px;text-align:left;cursor:pointer}",
      ".dshe-picker-more:hover{background:#f6f7f8}",
      /* ---- 两级分类菜单：一级三大块带 > 箭头，二级带返回与子分组 ---- */
      ".dshe-picker-head{display:flex;align-items:center;gap:6px;padding:0 0 6px;border-bottom:1px solid #eef0f2;margin-bottom:6px}",
      ".dshe-picker-back{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:#6b7280;font-size:15px;cursor:pointer}",
      ".dshe-picker-back:hover{background:#f3f4f6;color:#111827}",
      ".dshe-picker-crumb{flex:1;min-width:0;font-size:12px;font-weight:600;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-picker-cat{display:flex;align-items:center;gap:10px;width:100%;height:38px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:#374151;font-size:13px;text-align:left;cursor:pointer}",
      ".dshe-picker-cat:hover,.dshe-picker-cat-cursor{background:#f6f7f8}",
      ".dshe-picker-cat svg{flex:none;display:block;color:#6b7280}",
      ".dshe-picker-cat-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-picker-cat-arrow{flex:none;color:#9ca3af;font-size:15px;line-height:1}",
      ".dshe-picker-subtabs{display:flex;gap:5px;padding:2px 0 6px}",
      ".dshe-picker-subtab{height:24px;padding:0 9px;border:1px solid transparent;border-radius:999px;background:#f3f4f6;color:#6b7280;font-size:11.5px;font-weight:500;cursor:pointer}",
      ".dshe-picker-subtab-on{background:rgba(9,105,218,.10);border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}",

      /* ---- 通用状态 ------------------------------------------------------- */
      ".dshe-hint{padding:48px 12px;text-align:center;color:var(--dsw-alias-label-secondary,#57606a);font-size:13px}",
      ".dshe-gate{max-width:520px;margin:56px auto;padding:24px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);text-align:center}",
      ".dshe-source{display:flex;align-items:center;gap:10px;margin:0 24px;padding:7px 12px;border-radius:8px;border:1px solid rgba(9,105,218,.25);background:rgba(9,105,218,.06);color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}",
      ".dshe-source span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-source-reset{flex:none;height:22px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:11.5px;cursor:pointer}",
      ".dshe-source-reset:hover{border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-gate-title{font-size:14px;font-weight:600;margin-bottom:8px}",
      ".dshe-gate-desc{font-size:12.5px;color:var(--dsw-alias-label-secondary,#57606a);margin-bottom:16px;word-break:break-all}",
      ".dshe-gate-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#cf222e);margin-bottom:12px;word-break:break-all}",
      ".dshe-errbar{display:flex;align-items:center;gap:10px;margin:12px 0;padding:10px 12px;border-radius:8px;border:1px solid rgba(207,34,46,.35);background:rgba(207,34,46,.06);color:var(--dsw-alias-state-error-primary,#cf222e);font-size:12.5px}",
      ".dshe-errbar span{flex:1;min-width:0;word-break:break-all}",
      ".dshe-skel{height:96px;border-radius:10px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2,#f0f2f4) 25%,var(--dsw-alias-bg-layer-1,#f7f9fa) 50%,var(--dsw-alias-bg-layer-2,#f0f2f4) 75%);background-size:200% 100%;animation:dshe-shimmer 1.2s infinite linear}",
      "@keyframes dshe-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}",
      ".dshe-more{display:flex;justify-content:center;padding:22px 0 8px}",
      ".dshe-more-btn{height:34px;padding:0 18px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;color:#374151;font-size:13px;cursor:pointer}",
      ".dshe-more-btn:hover:not(:disabled){border-color:#d1d5db;background:#f9fafb}",
      ".dshe-more-btn:disabled{opacity:.6;cursor:default}",
      ".dshe-more-note{font-size:13px;color:#9ca3af}",

      /* ---- 详情弹窗 ------------------------------------------------------- */
      ".dshe-mask{position:fixed;top:0;right:0;bottom:0;left:0;z-index:1200;background:rgba(0,0,0,.34);display:flex;align-items:center;justify-content:center;padding:24px}",
      ".dshe-drawer{position:relative;display:flex;flex-direction:column;width:760px;max-width:100%;height:auto;max-height:88vh;background:#fff;border-radius:20px;box-shadow:0 28px 70px rgba(0,0,0,.2);overflow:hidden;animation:dshe-pop .18s ease-out}",
      "@keyframes dshe-pop{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}",
      "@media (prefers-reduced-motion:reduce){.dshe-drawer{animation:none}}",
      "@media (max-width:860px){.dshe-drawer{width:92vw}}",
      "@media (max-width:640px){.dshe-mask{padding:0}.dshe-drawer{width:100%;height:100%;max-height:100%;border-radius:0}}",
      ".dshe-drawer-close{position:absolute;top:20px;right:20px;z-index:3;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:8px;background:transparent;color:#9ca3af;cursor:pointer}",
      ".dshe-drawer-export{position:absolute;top:20px;right:58px;z-index:3;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid #e5e7eb;border-radius:8px;background:#fff;color:#4b5563;font-size:12px;cursor:pointer}",
      ".dshe-drawer-export:hover{background:#f6f7f8;color:#111827;border-color:#d8dce1}",
      ".dshe-drawer-close:hover{background:#f3f4f6;color:#111827}",
      ".dshe-drawer-body{flex:1;min-height:0;overflow:auto;padding:36px 40px 32px}",
      ".dshe-drawer-state{display:flex;align-items:center;gap:6px;padding:40px 0;color:#9ca3af;font-size:14px}",
      ".dshe-drawer-state-err{color:var(--dsw-alias-state-error-primary,#cf222e);word-break:break-all}",
      ".dshe-drawer-foot{flex:none;display:flex;gap:8px;padding:12px 32px;border-top:1px solid #eef0f2;background:#fff}",

      /* ---- 设置弹窗（小号居中弹窗） ---------------------------------------- */
      ".dshe-settings{position:relative;display:flex;flex-direction:column;width:480px;max-width:100%;max-height:70vh;background:#fff;border-radius:16px;box-shadow:0 28px 70px rgba(0,0,0,.2);overflow:hidden;animation:dshe-pop .18s ease-out}",
      "@media (max-width:640px){.dshe-settings{width:100%;height:100%;max-height:100%;border-radius:0}}",
      ".dshe-settings-btn{padding:0 10px}",
      ".dshe-settings-title{flex:none;margin:0;padding:22px 28px 0;font-size:18px;font-weight:700;color:#111827}",
      ".dshe-settings-field{flex:1;min-height:0;overflow:auto;padding:16px 28px 8px}",
      ".dshe-settings-label{display:block;margin-bottom:6px;font-size:13px;font-weight:600;color:#374151}",
      ".dshe-settings-input{width:100%;box-sizing:border-box;height:38px;padding:0 12px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#111827;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
      ".dshe-settings-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#0969da);box-shadow:0 0 0 2px rgba(9,105,218,.14)}",
      ".dshe-settings-input-err{border-color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dshe-settings-hint{margin:6px 0 0;font-size:12px;color:#9ca3af}",
      ".dshe-settings-hint-err{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dshe-settings-note{margin:10px 0 0;padding:8px 10px;border-radius:8px;background:#fffbeb;border:1px solid #fde68a;font-size:12px;color:#92400e}",
      ".dshe-settings-error{flex:1;min-height:0;overflow:auto;padding:16px 28px;font-size:13px;color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dshe-settings-foot{flex:none;display:flex;align-items:center;gap:8px;padding:14px 28px;border-top:1px solid #eef0f2;background:#fff}",
      ".dshe-settings-foot-gap{flex:1}",

      /* ---- 详情：头部 ----------------------------------------------------- */
      ".dshe-detail-hero{display:flex;align-items:flex-start;gap:20px;padding-right:26px}",
      ".dshe-detail-titles{flex:1;min-width:0}",
      ".dshe-detail-line{display:flex;align-items:baseline;flex-wrap:wrap;min-width:0}",
      /* 22px 是为了让「高级开发工程师 | 吴八哥」在 460px 抽屉里排成一行 */
      ".dshe-detail-main{font-size:22px;font-weight:700;line-height:1.32;color:#111827;word-break:break-word}",
      /* 竖线与副标题绑成一个整体：换行时「| 人名」一起走，不会留个竖线吊在行尾 */
      ".dshe-detail-sub-group{display:inline-flex;align-items:baseline;min-width:0;max-width:100%;white-space:nowrap;overflow:hidden}",
      ".dshe-detail-sep{flex:none;margin:0 8px;color:#d1d5db;font-size:20px;font-weight:300;line-height:1.32}",
      ".dshe-detail-sub{min-width:0;font-size:20px;font-weight:400;line-height:1.32;color:#9ca3af;overflow:hidden;text-overflow:ellipsis}",
      ".dshe-cta{display:inline-flex;align-items:center;justify-content:center;gap:6px;margin-top:12px;height:38px;padding:0 22px;border:none;border-radius:10px;background:#111;color:#fff;font-size:14px;font-weight:600;cursor:pointer}",
      ".dshe-cta:hover:not(:disabled){background:#000}",
      ".dshe-cta:disabled{background:#d7dade;cursor:default}",

      /* ---- 详情：正文 ----------------------------------------------------- */
      ".dshe-detail-desc{margin:24px 0 0;font-size:15px;line-height:1.75;color:#374151;white-space:pre-wrap;word-break:break-word}",
      ".dshe-desc-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal}",
      ".dshe-expand{display:inline-flex;align-items:center;gap:4px;margin-top:8px;padding:0;border:none;background:none;color:#6b7280;font-size:14px;cursor:pointer}",
      ".dshe-expand:hover{color:#111827}",
      ".dshe-tagrow{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}",
      ".dshe-tag{display:inline-flex;align-items:center;max-width:100%;padding:6px 12px;border-radius:8px;background:#f3f4f6;color:#374151;font-size:14px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshe-divider{height:1px;margin:24px 0;background:#eef0f2}",

      /* ---- 详情：数据条 --------------------------------------------------- */
      ".dshe-stats{display:grid;gap:10px}",
      ".dshe-stat{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:6px;min-width:0;padding:0 2px;text-align:center}",
      ".dshe-stat-value{display:flex;align-items:center;justify-content:center;gap:6px;max-width:100%;font-size:17px;font-weight:600;line-height:1.3;color:#111827}",
      ".dshe-stat-text{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      /* 长值（传输方式 / 集合名）降字号，保证 streamableHttp、anthropics-skills 不截断 */
      ".dshe-stat-text[data-compact]{font-size:11px;font-weight:600;letter-spacing:0}",
      ".dshe-stat-label{font-size:13px;line-height:1.3;color:#9ca3af}",
      ".dshe-icon{display:inline-flex;align-items:center;justify-content:center;line-height:0}",
      ".dshe-stat-icon{flex:none;color:#6b7280}",

      /* ---- 详情：区块 ----------------------------------------------------- */
      ".dshe-block{margin:28px 0 0}",
      ".dshe-block-title{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:16px;font-weight:700;line-height:1.4;color:#111827}",
      ".dshe-block-icon{flex:none;color:#6b7280}",
      ".dshe-muted{font-size:14px;line-height:1.6;color:#9ca3af}",

      /* ---- 详情：提示行 --------------------------------------------------- */
      ".dshe-prompt-row{display:flex;align-items:center;gap:12px;margin-bottom:10px;padding:16px 18px;border-radius:12px;background:#f6f7f8;font-size:15px;line-height:1.6;color:#374151;cursor:pointer;transition:background .12s}",
      ".dshe-prompt-row:last-child{margin-bottom:0}",
      ".dshe-prompt-row:hover{background:#eef0f2}",
      ".dshe-prompt-text{flex:1;min-width:0;word-break:break-word}",
      ".dshe-prompt-copy{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:50%;background:transparent;color:#9ca3af;cursor:pointer;transition:background .12s,color .12s}",
      ".dshe-prompt-copy:hover{background:#fff;color:#374151}",

      /* ---- 详情：团队成员 ------------------------------------------------- */
      /* 弹窗 760px、内容宽 680px，3 列每格约 217px，长职业名也放得下 */
      ".dshe-member-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}",
      "@media (max-width:640px){.dshe-member-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}",
      ".dshe-member-item{display:flex;align-items:center;gap:10px;min-width:0;padding:6px;border-radius:10px;transition:background .12s}",
      ".dshe-member-item:hover{background:#f6f7f8}",
      ".dshe-member-info{flex:1;min-width:0}",
      ".dshe-member-name{display:flex;align-items:center;gap:5px;min-width:0;font-size:14px;font-weight:600;line-height:1.4;color:#111827}",
      ".dshe-member-name-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-lead-chip{flex:none;display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:6px;background:#f0f1f3;color:#6b7280;font-size:11px;font-weight:500;line-height:1.4;white-space:nowrap}",
      ".dshe-member-prof{font-size:13px;line-height:1.4;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",

      /* ---- 详情：技能行 / 说明 / 更多 -------------------------------------- */
      ".dshe-skill-line{display:flex;align-items:center;gap:10px;width:100%;margin-bottom:8px;padding:10px 12px;border-radius:10px;background:#f6f7f8;color:#374151;font-size:14px;text-align:left;transition:background .12s}",
      ".dshe-skill-line:last-child{margin-bottom:0}",
      ".dshe-skill-line:hover{background:#eef0f2}",
      ".dshe-skill-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:0;border:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
      ".dshe-skill-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#9ca3af}",
      ".dshe-skill-dot-local{background:#1a7f37}",
      ".dshe-skill-dot-repo{background:#0969da}",
      ".dshe-skill-dot-missing{background:#c4c9cf}",
      ".dshe-skill-fetch{flex:none;height:26px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-brand-primary,#0969da);font-size:12px;cursor:pointer}",
      ".dshe-skill-fetch:hover{border-color:var(--dsw-alias-brand-primary,#0969da);background:rgba(9,105,218,.06)}",
      /* 限定在详情抽屉的技能行内：不限定会污染技能卡片的标题（曾被 max-width:46% 压成半截） */
      ".dshe-skill-line .dshe-skill-name{flex:none;max-width:46%;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-skill-path{flex:1;min-width:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-readme{max-height:360px;overflow:auto;padding:14px 16px;border:1px solid #eef0f2;border-radius:12px;background:#fafbfc;font-size:13px;line-height:1.7;color:#374151;white-space:pre-wrap;word-break:break-word}",
      ".dshe-more-box{padding:14px 18px;border-radius:12px;background:#f6f7f8;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.7;color:#6b7280;word-break:break-all}",
      ".dshe-more-box div+div{margin-top:2px}",
      ".dshe-config{position:relative}",
      /* JSON 保持原始缩进，太长就横向滚动（换行会把缩进打断得更难看） */
      ".dshe-config-pre{margin:0;max-height:320px;overflow:auto;padding:14px 44px 14px 16px;border:1px solid #eef0f2;border-radius:12px;background:#fafbfc;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.65;color:#111827;white-space:pre;tab-size:2}",
      ".dshe-config-copy{position:absolute;top:8px;right:8px;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid #eef0f2;border-radius:7px;background:#fff;color:#9ca3af;cursor:pointer}",
      ".dshe-config-copy:hover{border-color:#e1e5ea;color:#111827}",

      /* ---- 其它 ----------------------------------------------------------- */
      ".dshe-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:1300;max-width:70vw;padding:9px 16px;border-radius:8px;background:rgba(31,35,40,.94);color:#fff;font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.25);word-break:break-all}",
      ".dshe-panel-icon{display:inline-flex;align-items:center;justify-content:center;line-height:0;color:currentColor}",
      ".dshe-panel-icon-on{color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-spin{display:inline-block;width:11px;height:11px;margin-right:6px;vertical-align:-1px;border:1.6px solid currentColor;border-right-color:transparent;border-radius:50%;animation:dshe-spin .7s linear infinite}",
      "@keyframes dshe-spin{to{transform:rotate(360deg)}}",

      /* ---- Composer 工具栏按钮 --------------------------------------------- */
      ".dshe-composer-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:999px;background:transparent;color:#6b7280;cursor:pointer;transition:background .12s,color .12s}",
      ".dshe-composer-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid,#f3f4f6);color:#111827}"
    ].join("\n");

    // =======================================================================
    // 基础设施：样式注入 / 请求 / URL 拼接
    // =======================================================================

    /**
     * 注入全局样式，随插件卸载一起清理。
     * @param {any} ctx 插件上下文
     * @returns {void}
     */
    function applyStyles(ctx) {
      ctx.effect(() => {
        const el = document.createElement("style");
        el.dataset.plugin = "dsh-buddy-expert-hub";
        el.textContent = CSS;
        document.head.append(el);
        return () => el.remove();
      }, "dsh-buddy-expert-hub: styles");
    }

    /**
     * GET 请求并解析 JSON。
     * @param {string} pathAndQuery 以 `/` 开头的路径（不含 API 前缀）
     * @returns {Promise<any>} 解析后的载荷
     */
    function fetchJson(pathAndQuery) {
      return fetch(API + pathAndQuery, { headers: { Accept: "application/json" } }).then((resp) => resp.json());
    }

    /**
     * 广播「已安装技能发生变化」，通知主面板立即重拉 /skills/installed。
     *
     * 三个安装入口（商店卡片「获取」、详情抽屉「获取」、仓库技能「+」）统一用它，
     * 避免把刷新回调层层透传给深层子组件；与 dock 的 attachments-changed 同一套事件风格。
     * 非浏览器 / 简化 window 桩下 try/catch 静默降级，不影响安装结果本身。
     * @returns {void}
     */
    function notifyInstalledSkillsChanged() {
      try {
        window.dispatchEvent(new Event("dsh-buddy-expert-hub:installed-skills-changed"));
      } catch { /* 非 DOM 环境降级：忽略 */ }
    }

    /**
     * 把资源路径转成可用的 URL。
     * `local:<id>` 表示 DSH 本地已导入专家的头像，其余为数据仓库内的相对路径。
     * @param {string|null} relativePath 资源路径
     * @returns {string|null} 可直接用于 img src 的地址
     */
    function assetUrl(relativePath) {
      if (relativePath === null || relativePath === undefined || relativePath === "") return null;
      if (relativePath.indexOf("data:") === 0) return relativePath;
      if (relativePath.indexOf("local:") === 0) {
        return API + "/local-avatar?id=" + encodeURIComponent(relativePath.slice("local:".length));
      }
      return API + "/asset?path=" + encodeURIComponent(relativePath);
    }

    /**
     * 连接器图标 URL。
     * @param {string} id 连接器 id
     * @returns {string} 图标地址
     */
    function iconUrl(id) {
      return API + "/icon?id=" + encodeURIComponent(id);
    }

    /**
     * 拼装列表查询地址。
     * @param {string} tab 标签页 id
     * @param {string} query 关键词
     * @param {number} offset 偏移
     * @param {number} limit 条数
     * @returns {string} 路径 + 查询串
     */
    function listPath(tab, query, offset, limit) {
      const parts = [];
      if (query !== "") parts.push("q=" + encodeURIComponent(query));
      parts.push("limit=" + String(limit));
      parts.push("offset=" + String(offset));
      return "/" + tab + "?" + parts.join("&");
    }

    /**
     * 复制文本到剪贴板：优先 Clipboard API，失败回退 execCommand。
     * 所有复制入口（召唤 / 安装 / 提示语 / 技能路径 / MCP 配置）都必须走这里，
     * 保证降级行为一致。
     * @param {string} text 待复制文本
     * @param {string} label 用途说明，仅用于错误信息
     * @returns {Promise<void>} 完成信号
     */
    function copyText(text, label) {
      const value = String(text === null || text === undefined ? "" : text);
      const what = typeof label === "string" && label !== "" ? label : "内容";
      if (typeof navigator !== "undefined" && navigator.clipboard !== undefined &&
          navigator.clipboard !== null && typeof navigator.clipboard.writeText === "function") {
        return Promise.resolve(navigator.clipboard.writeText(value)).catch(() => legacyCopy(value, what));
      }
      return legacyCopy(value, what);
    }

    /**
     * execCommand 兜底复制（仅用于不支持 Clipboard API 的环境）。
     * @param {string} value 待复制文本
     * @param {string} what 用途说明，用于错误信息
     * @returns {Promise<void>} 完成信号
     */
    function legacyCopy(value, what) {
      return new Promise((resolve, reject) => {
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          const ok = document.execCommand("copy");
          document.body.removeChild(ta);
          if (ok === false) {
            reject(new Error(what + "复制失败"));
            return;
          }
          resolve();
        } catch (error) {
          document.body.removeChild(ta);
          reject(error);
        }
      });
    }

    // =======================================================================
    // 纯函数工具（详情页字段归一）
    // =======================================================================

    /**
     * 安全取字符串：非字符串返回空串，字符串原样返回（保留内部空格）。
     * @param {any} value 任意值
     * @returns {string} 字符串或空串
     */
    function textOf(value) {
      return typeof value === "string" ? value : "";
    }

    /**
     * 安全取去掉首尾空白的字符串。
     * @param {any} value 任意值
     * @returns {string} 去空白后的字符串或空串
     */
    function trimmed(value) {
      return textOf(value).trim();
    }

    /**
     * 截断长文本（去空白后超过 max 字符则截断并加省略号）。
     * @param {any} value 任意值
     * @param {number} max 最大字符数
     * @returns {string} 处理后的文本，空值返回空串
     */
    function trimTo(value, max) {
      const text = trimmed(value);
      if (text === "") return "";
      return text.length > max ? text.slice(0, max) + "…" : text;
    }

    /**
     * 技能目录名安全化——必须与 host 半 `skillDirNameOf` 逐字一致，
     * 否则前端算出的 dir 与「已安装」列表里的 dir 对不上，按钮形态就会错。
     * @param {string} raw 技能名
     * @returns {string} 目录名（可能为空串）
     */
    function skillDirNameOfClient(raw) {
      const safe = String(raw === null || raw === undefined ? "" : raw)
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
      return safe !== "" ? safe.slice(0, 100) : "";
    }

    /**
     * 统一中性人形占位图标：dock / picker / 专家链路 Avatar 无图回落共用同一段 SVG，
     * 不按名字 hash、不取首字母、不生成彩色块（QA 可比对 outerHTML 逐字相同）。
     * @param {number} size 图标尺寸
     * @returns {any} React 元素
     */
    function neutralAvatarGlyph(size) {
      return h(Icon, { name: "person", size: size });
    }

    /**
     * 由名字推导一个稳定的色相，仅用于技能/连接器详情头部的既有首字母色块。
     * @param {string} text 名字
     * @returns {number} 0-359 的色相
     */
    function hueOf(text) {
      const value = String(text === null || text === undefined ? "" : text);
      let hash = 0;
      for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) % 360;
      return hash;
    }

    /**
     * 取名字的首字母（大写），空名字返回 `?`。
     * @param {string} name 名字
     * @returns {string} 首字母
     */
    function initialOf(name) {
      const text = trimmed(name);
      return (text.charAt(0) || "?").toUpperCase();
    }

    /**
     * 把快捷提示条目（`{zh,en}` 或纯字符串）规整成可复制的纯文本。
     * @param {any} prompt 提示条目
     * @returns {string} 纯文本，空条目返回空串
     */
    function promptText(prompt) {
      if (typeof prompt === "string") return prompt.trim();
      if (prompt !== null && typeof prompt === "object") {
        const zh = trimmed(prompt.zh);
        if (zh !== "") return zh;
        return trimmed(prompt.en);
      }
      return "";
    }

    /**
     * 把 quickPrompts 规整成非空文本数组。
     * @param {any} list 原始列表
     * @returns {string[]} 纯文本列表
     */
    function promptList(list) {
      if (!Array.isArray(list)) return [];
      const out = [];
      for (const entry of list) {
        const text = promptText(entry);
        if (text !== "") out.push(text);
      }
      return out;
    }

    /**
     * 把任意数组规整成非空字符串数组。
     * @param {any} list 原始列表
     * @returns {string[]} 字符串列表
     */
    function textList(list) {
      if (!Array.isArray(list)) return [];
      const out = [];
      for (const entry of list) {
        const text = trimmed(entry);
        if (text !== "") out.push(text);
      }
      return out;
    }

    /**
     * 分类 id → 中文名，无法映射时回落 id 本身。
     * @param {any} categoryId 分类 id
     * @returns {string} 中文分类名
     */
    function categoryLabel(categoryId) {
      const id = trimmed(categoryId);
      if (id === "") return "未分类";
      return CATEGORY_LABELS[id] || id;
    }

    /**
     * 判断一个描述值是不是 YAML 块标符残留（`|` / `>-` / `>`）。
     * 市场里不少 SKILL.md 用块标量写描述，解析失败时只会剩标符本身。
     * @param {string} value 描述值
     * @returns {boolean} 是标符残留
     */
    function isBlockMarker(value) {
      return BLOCK_MARKER_RE.test(trimmed(value));
    }

    /**
     * 取可展示的描述文本：空白与 YAML 标符残留都返回空串（由调用方回落「暂无描述」）。
     * @param {any} value 描述值
     * @returns {string} 可用描述
     */
    function descOf(value) {
      const text = trimmed(value);
      return isBlockMarker(text) ? "" : text;
    }

    /**
     * 把 slug 形式的机器名美化成可读名字（`software-company` → `Software Company`）。
     * 已经是正常名字（含中文 / 大写 / 空格）时原样返回。
     * @param {string} value 原始名字
     * @returns {string} 可读名字
     */
    function prettyName(value) {
      const text = trimmed(value);
      if (text === "" || !SLUG_RE.test(text)) return text;
      const words = text.split(/[._-]+/).filter((word) => word !== "");
      return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    }

    /**
     * 列表与详情统一使用的展示名（slug 形式的机器名会被美化成可读名字）。
     * @param {any} item 专家 / 团队条目
     * @returns {string} 展示名
     */
    function displayNameOf(item) {
      return prettyName(trimmed(item.displayName) || trimmed(item.name) || trimmed(item.id));
    }

    /**
     * 是否是一个「真」职业名（排除「本地专家」这类兜底值）。
     * @param {string} value 职业值
     * @returns {boolean} 可以当标题用
     */
    function isRealProfession(value) {
      const text = trimmed(value);
      if (text === "") return false;
      return FAKE_PROFESSIONS.indexOf(text.toLowerCase()) < 0;
    }

    /**
     * 拆分「主标题 | 副标题」。
     *
     * - 专家：职业在前、人名在后（参考图是「高级开发工程师 | 吴八哥」）；
     *   职业为空或是兜底值时不渲染副标题。
     * - 团队：团队名在前、出品方/职业在后（参考图是「游戏开发工作室 | 鹏城信息AI专家」），
     *   兜底值不当副标题。
     * - 技能 / 连接器：只有名字。
     *
     * @param {any} item 条目
     * @param {string} kind 类型：expert / team / skill / connector
     * @returns {{ main: string, sub: string }} 标题
     */
    function splitTitle(item, kind) {
      const rawName = trimmed(item.displayName) || trimmed(item.name) || trimmed(item.id);
      const profession = trimmed(item.profession);
      const isExpertOrTeam = kind === "expert" || kind === "team";
      const name = isExpertOrTeam ? prettyName(rawName) : rawName;

      if (kind === "team") {
        return { main: name, sub: isRealProfession(profession) && profession !== name ? profession : "" };
      }
      if (kind === "expert") {
        if (isRealProfession(profession) && profession !== name) return { main: profession, sub: name };
        return { main: name, sub: "" };
      }
      return { main: name, sub: "" };
    }

    /**
     * 估算字符串的视觉长度：中日韩字符按 2 个宽度单位算，其余按 1 个。
     * 用来判断数据条的取值会不会被列宽截断（中文 6 个字就和 12 个字母一样宽）。
     * @param {any} value 取值
     * @returns {number} 视觉长度
     */
    function visualLength(value) {
      const text = String(value === null || value === undefined ? "" : value);
      let units = 0;
      for (let i = 0; i < text.length; i += 1) {
        units += /[\u2e80-\u9fff\uff00-\uffef]/.test(text.charAt(i)) ? 2 : 1;
      }
      return units;
    }

    /**
     * 取路径最后一段（技能名 / 文件名）。
     * @param {string} value 路径
     * @returns {string} 最后一段
     */
    function lastSegment(value) {
      const parts = trimmed(value).split("/").filter((it) => it !== "");
      return parts.length === 0 ? "" : parts[parts.length - 1];
    }

    /**
     * 把 markdown 正文降级成纯文本：去掉标题井号、引用符号、强调标记。
     * 抽屉空间有限，直接铺 `## Overview`、`>` 这类源码观感太原始；
     * 围栏代码块内的内容原样保留，避免改坏示例命令。
     * @param {string} value markdown 正文
     * @returns {string} 纯文本
     */
    function plainMarkdown(value) {
      const text = textOf(value);
      if (text === "") return "";
      let inFence = false;
      return text.split("\n").map((line) => {
        if (/^\s*(```|~~~)/.test(line)) {
          inFence = !inFence;
          return line;
        }
        if (inFence) return line;
        return line
          .replace(/^\s{0,3}#{1,6}\s+/, "")
          .replace(/^\s{0,3}>\s?/, "")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/__([^_]+)__/g, "$1")
          .replace(/`([^`]+)`/g, "$1");
      }).join("\n");
    }

    /**
     * 组装「召唤语」：优先 defaultInitPrompt，其次第一条快捷提示，最后兜底文案。
     * 插件无法直接写入 DSH 对话框，所以这里只负责给出可复制的文本。
     * @param {any} item 专家 / 团队条目
     * @returns {string} 召唤语
     */
    function summonText(item) {
      const init = trimmed(item.defaultInitPrompt);
      if (init !== "") return init;
      const prompts = promptList(item.quickPrompts);
      if (prompts.length > 0) return prompts[0];
      return FALLBACK_SUMMON;
    }

    /**
     * 连接器 MCP 配置文本；没有 config 时返回空串。
     * @param {any} item 连接器条目
     * @returns {string} 格式化后的 JSON 文本
     */
    function connectorConfigText(item) {
      const config = item.config;
      if (config === null || config === undefined) return "";
      try {
        return JSON.stringify(config, null, 2);
      } catch {
        return "";
      }
    }

    /**
     * 统计 MCP 配置项数量（`mcpServers` 的键数）；没有 config 时返回 0。
     * @param {any} item 连接器条目
     * @returns {number} 配置项数量
     */
    function connectorConfigCount(item) {
      const config = item.config;
      if (config === null || config === undefined || typeof config !== "object") return 0;
      const servers = config.mcpServers;
      if (servers === null || servers === undefined || typeof servers !== "object") return 0;
      return Object.keys(servers).length;
    }

    // =======================================================================
    // 图标（内联 SVG，零依赖）
    // =======================================================================

    /**
     * 图标轮廓表：每项是一组 SVG 子元素描述对象，`tag` 缺省为 path。
     * 全部使用 24x24 视窗 + stroke，保证与文字基线对齐。
     */
    var ICON_SHAPES = {
      v: [{ d: "M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6z" }, { d: "M8.6 12.4l2.3 2.3 4.6-4.6" }],
      spark: [{ d: "M12 3.4l1.75 4.75L18.5 9.9l-4.75 1.75L12 16.4l-1.75-4.75L5.5 9.9l4.75-1.75z" }],
      users: [{ d: "M15.4 19.6v-1.4a3.6 3.6 0 0 0-3.6-3.6H7.9a3.6 3.6 0 0 0-3.6 3.6v1.4" }, { tag: "circle", cx: 9.9, cy: 8.1, r: 3.3 }, { d: "M20.3 19.6v-1.4a3.6 3.6 0 0 0-2.7-3.5" }, { d: "M15.6 4.9a3.3 3.3 0 0 1 0 6.4" }],
      tag: [{ d: "M4.4 4.4h6.9l8.3 8.3-6.9 6.9-8.3-8.3z" }, { tag: "circle", cx: 8.3, cy: 8.3, r: 1.25 }],
      bolt: [{ d: "M13.4 3 6 13.6h4.7L10 21l7.4-10.6h-4.7z" }],
      sliders: [{ d: "M4 8h5" }, { tag: "circle", cx: 12, cy: 8, r: 2.4 }, { d: "M15 8h5" }, { d: "M4 16h9" }, { tag: "circle", cx: 16, cy: 16, r: 2.4 }, { d: "M19 16h1" }],
      person: [{ tag: "circle", cx: 12, cy: 8.2, r: 3.4 }, { d: "M5.4 20.4a6.6 6.6 0 0 1 13.2 0" }],
      layers: [{ d: "M12 3.6 20 8l-8 4.4L4 8z" }, { d: "M4.6 12.4 12 16.6l7.4-4.2" }, { d: "M4.6 16.4 12 20.6l7.4-4.2" }],
      file: [{ d: "M6.6 3.4h6.8L18.8 8.8v11.8H6.6z" }, { d: "M13.4 3.4v5.4h5.4" }],
      chat: [{ d: "M20.4 11.8a7.8 7.8 0 0 1-11.5 7L4 20.4l1.6-4.6a7.8 7.8 0 1 1 14.8-4z" },
        { tag: "circle", cx: 8.9, cy: 11.8, r: 0.95, fill: "currentColor", stroke: "none" },
        { tag: "circle", cx: 12.2, cy: 11.8, r: 0.95, fill: "currentColor", stroke: "none" },
        { tag: "circle", cx: 15.5, cy: 11.8, r: 0.95, fill: "currentColor", stroke: "none" }],
      book: [{ d: "M6.9 2.8H19v16.6H6.9a2.3 2.3 0 0 0-2.3 2.3V5.1a2.3 2.3 0 0 1 2.3-2.3z" }, { d: "M4.6 19.4a2.3 2.3 0 0 1 2.3-2.3H19" }],
      list: [{ d: "M9 6.6h11" }, { d: "M9 12h11" }, { d: "M9 17.4h11" },
        { tag: "circle", cx: 4.9, cy: 6.6, r: 1.1, fill: "currentColor", stroke: "none" },
        { tag: "circle", cx: 4.9, cy: 12, r: 1.1, fill: "currentColor", stroke: "none" },
        { tag: "circle", cx: 4.9, cy: 17.4, r: 1.1, fill: "currentColor", stroke: "none" }],
      plus: [{ d: "M12 5.8v12.4" }, { d: "M5.8 12h12.4" }],
      download: [{ d: "M12 4.4v10.2" }, { d: "M7.9 10.6 12 14.7l4.1-4.1" }, { d: "M5.2 18.6h13.6" }],
      copy: [{ tag: "rect", x: 8.6, y: 8.6, width: 11, height: 11, rx: 2.4 }, { d: "M15.4 5.4h-9a2 2 0 0 0-2 2v9" }],
      close: [{ d: "M6.8 6.8 17.2 17.2" }, { d: "M17.2 6.8 6.8 17.2" }],
      crown: [{ d: "M4.4 8.2 8.2 12l3.8-5.6L15.8 12l3.8-3.8V18H4.4z" }],
      "chevron-down": [{ d: "M6.4 9.6 12 15.2l5.6-5.6" }],
      "chevron-up": [{ d: "M6.4 14.4 12 8.8l5.6 5.6" }],
      dot: [{ tag: "circle", cx: 12, cy: 12, r: 4, fill: "currentColor", stroke: "none" }]
    };

    /**
     * 内联图标。
     * @param {{ name: string, size?: number, className?: string }} props 属性
     * @returns {any} React 元素
     */
    /**
     * 三大块分类图标：用户提供的 WorkBuddy 原生 SVG（16x16 currentColor）。
     * 用 fill=currentColor 让选中/非选中态随 CSS color 变化，不生成自定义图标。
     * @param {{ name: string, size?: number }} props 属性
     * @returns {any} React 元素
     */
    function CategoryIcon(props) {
      const spec = CATEGORY_ICONS[props.name] === undefined ? CATEGORY_ICONS.expert : CATEGORY_ICONS[props.name];
      const size = typeof props.size === "number" ? props.size : 16;
      const pathAttrs = { transform: spec.transform, d: spec.d, fill: "currentColor" };
      if (spec.fillRule !== "") pathAttrs.fillRule = spec.fillRule;
      return h("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        xmlns: "http://www.w3.org/2000/svg",
        "aria-hidden": "true",
        focusable: "false"
      }, h("path", pathAttrs));
    }

    function Icon(props) {
      const size = typeof props.size === "number" ? props.size : 16;
      const shapes = ICON_SHAPES[props.name] === undefined ? ICON_SHAPES.dot : ICON_SHAPES[props.name];
      return h("span", {
        className: "dshe-icon" + (typeof props.className === "string" ? " " + props.className : ""),
        "aria-hidden": "true"
      },
        h("svg", {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          xmlns: "http://www.w3.org/2000/svg"
        },
          shapes.map((shape, index) => {
            const tag = shape.tag === undefined ? "path" : shape.tag;
            const attrs = Object.assign({ key: index }, shape);
            delete attrs.tag;
            return h(tag, attrs);
          })
        )
      );
    }

    // =======================================================================
    // 侧边栏图标
    // =======================================================================

    /**
     * 侧边栏入口图标：改用用户提供的专家图标（expert-icon.svg，与面板 Tab 同一份）。
     * @param {{ size?: number, active?: boolean }} props 组件属性
     * @returns {any} React 元素
     */
    function PanelIcon(props) {
      const size = typeof props.size === "number" ? props.size : 18;
      const active = props.active === true;
      return h("span", {
        className: "dshe-panel-icon" + (active ? " dshe-panel-icon-on" : ""),
        "aria-hidden": "true",
        "data-dsh-buddy-expert-hub-panel-trigger": "1",
        style: { display: "inline-flex", alignItems: "center", justifyContent: "center" }
      },
        h(CategoryIcon, { name: "expert", size: size })
      );
    }

    // =======================================================================
    // 通用展示组件
    // =======================================================================

    /**
     * 头像：有图用图；无图回落按类型分支。
     * `neutralFallback: true`（专家/团队链路）→ 统一中性人形 SVG；
     * 其余（技能/连接器详情头部）→ 既有的名字 hash 首字母色块。
     * @param {{ src?: string|null, name?: string, size?: number, radius?: number, fontSize?: number, contain?: boolean, neutralFallback?: boolean }} props 属性
     * @returns {any} React 元素
     */
    function Avatar(props) {
      const size = typeof props.size === "number" ? props.size : 40;
      const radius = typeof props.radius === "number" ? props.radius : Math.round(size * 0.24);
      const fontSize = typeof props.fontSize === "number" ? props.fontSize : Math.round(size * 0.42);
      const contain = props.contain === true;
      const neutral = props.neutralFallback === true;
      const [broken, setBroken] = useState(false);
      const name = textOf(props.name);
      const src = props.src === undefined || props.src === null || props.src === "" ? null : props.src;
      const baseStyle = { width: size, height: size, borderRadius: radius };
      if (contain) {
        baseStyle.objectFit = "contain";
        baseStyle.background = "#fff";
        baseStyle.padding = Math.round(size * 0.14);
      }

      if (src === null || broken) {
        if (neutral) {
          return h("span", {
            className: "dshe-avatar dshe-avatar-placeholder",
            style: { width: size, height: size, borderRadius: radius },
            "aria-hidden": "true"
          }, neutralAvatarGlyph(Math.round(size * 0.5)));
        }
        const hue = hueOf(name);
        const letterStyle = { width: size, height: size, borderRadius: radius };
        return h("span", {
          className: "dshe-avatar dshe-avatar-letter",
          style: Object.assign(letterStyle, {
            background: "hsl(" + hue + " 62% 92%)",
            color: "hsl(" + hue + " 55% 32%)",
            fontSize: fontSize
          }),
          "aria-hidden": "true"
        }, initialOf(name));
      }

      return h("img", {
        className: "dshe-avatar",
        style: baseStyle,
        src: src,
        alt: name,
        loading: "lazy",
        onError: () => setBroken(true)
      });
    }

    /**
     * 小标签。
     * @param {{ label: string, tone?: string }} props 属性
     * @returns {any} React 元素
     */
    function Chip(props) {
      return h("span", { className: "dshe-chip" + (props.tone === "muted" ? " dshe-chip-muted" : ""), title: props.label }, props.label);
    }

    /**
     * 详情页数据条：有几项就渲染几列，空值项整列不渲染。
     * @param {{ items: Array<{ label: string, value: string, icon?: string, title?: string }> }} props 属性
     * @returns {any} React 元素
     */
    function StatRow(props) {
      const list = Array.isArray(props.items) ? props.items : [];
      const stats = list.filter((item) => item !== null && item !== undefined && trimmed(item.value) !== "");
      if (stats.length === 0) return null;
      return h("div", {
        className: "dshe-stats",
        // minmax(0,1fr) 才能让长内容不撑破等分列（1fr 的自动最小尺寸是 min-content）
        style: { gridTemplateColumns: "repeat(" + String(stats.length) + ",minmax(0,1fr))" }
      },
        stats.map((stat, index) => h("div", { key: index, className: "dshe-stat" },
          h("div", { className: "dshe-stat-value" },
            typeof stat.icon === "string" && stat.icon !== ""
              ? h(Icon, { name: stat.icon, size: 16, className: "dshe-stat-icon" })
              : null,
            h("span", {
              className: "dshe-stat-text",
              // 长值（传输方式 / 集合名）降一档字号，避免 4 列布局里被截成半个词。
              "data-compact": visualLength(stat.value) > STAT_COMPACT_UNITS ? "1" : undefined,
              title: typeof stat.title === "string" ? stat.title : stat.value
            }, stat.value)
          ),
          h("div", { className: "dshe-stat-label" }, stat.label)
        ))
      );
    }

    /**
     * 详情页区块：图标 + 标题 + 内容。
     * @param {{ title: string, icon?: string, children?: any }} props 属性
     * @returns {any} React 元素
     */
    function Block(props) {
      return h("div", { className: "dshe-block" },
        h("div", { className: "dshe-block-title" },
          typeof props.icon === "string" && props.icon !== ""
            ? h(Icon, { name: props.icon, size: 18, className: "dshe-block-icon" })
            : null,
          h("span", null, props.title)
        ),
        props.children === undefined ? null : props.children
      );
    }

    /**
     * 「更多」灰底块：逐行展示 ID / 路径 / 来源等原始信息。
     * @param {{ lines: string[] }} props 属性
     * @returns {any} React 元素
     */
    function MoreBox(props) {
      const lines = (Array.isArray(props.lines) ? props.lines : []).filter((it) => trimmed(it) !== "");
      if (lines.length === 0) return null;
      return h("div", { className: "dshe-more-box" },
        lines.map((line, index) => h("div", { key: index }, line))
      );
    }

    /**
     * 详情页头部：大头像 + 「主标题 | 副标题」+ 主按钮。
     * @param {{ item: any, kind: string, actionLabel: string, onAction: Function, contain?: boolean, iconSrc?: string|null }} props 属性
     * @returns {any} React 元素
     */
    function DetailHero(props) {
      const titles = splitTitle(props.item, props.kind);
      const iconSrc = props.iconSrc === undefined ? assetUrl(props.item.avatar) : props.iconSrc;
      return h("div", { className: "dshe-detail-hero" },
        h(Avatar, {
          src: iconSrc,
          name: titles.sub !== "" ? titles.sub : titles.main,
          size: 88,
          radius: 20,
          fontSize: 32,
          contain: props.contain === true,
          neutralFallback: props.kind === "expert" || props.kind === "team"
        }),
        h("div", { className: "dshe-detail-titles" },
          h("div", { className: "dshe-detail-line" },
            h("span", { className: "dshe-detail-main" }, titles.main),
            // 竖线与副标题必须在同一个不可换行的容器里，否则窄抽屉下会留下孤零零的「|」
            titles.sub === ""
              ? null
              : h("span", { className: "dshe-detail-sub-group" },
                  h("span", { className: "dshe-detail-sep", "aria-hidden": "true" }, "|"),
                  h("span", { className: "dshe-detail-sub" }, titles.sub)
                )
          ),
          h("button", {
            type: "button",
            className: "dshe-cta",
            onClick: props.onAction
          }, props.actionLabel)
        )
      );
    }

    /**
     * 详情页提示行：整行可点复制，右侧是带 aria-label 的圆形图标按钮。
     * @param {{ text: string, onCopy: Function }} props 属性
     * @returns {any} React 元素
     */
    function PromptRow(props) {
      return h("div", { className: "dshe-prompt-row", onClick: props.onCopy },
        h("span", { className: "dshe-prompt-text" }, props.text),
        h("button", {
          type: "button",
          className: "dshe-prompt-copy",
          "aria-label": "复制这条提示",
          title: "复制这条提示",
          onClick: (event) => {
            event.stopPropagation();
            props.onCopy();
          }
        }, h(Icon, { name: "chat", size: 18 }))
      );
    }

    /**
     * 团队成员网格：三人一排，团长带「主理人」小 chip。
     * @param {{ members: Array<any> }} props 属性
     * @returns {any} React 元素
     */
    function MemberGrid(props) {
      const members = Array.isArray(props.members) ? props.members : [];
      return h("div", { className: "dshe-member-grid" },
        members.map((member, index) => {
          const name = trimmed(member.name) || trimmed(member.id) || "未命名成员";
          const profession = trimmed(member.profession);
          return h("div", { key: (trimmed(member.id) || String(index)) + "-" + String(index), className: "dshe-member-item" },
            h(Avatar, {
              src: assetUrl(member.avatar),
              name: name,
              size: 48,
              radius: 12,
              fontSize: 18,
              neutralFallback: true
            }),
            h("div", { className: "dshe-member-info" },
              h("div", { className: "dshe-member-name" },
                h("span", { className: "dshe-member-name-text", title: name }, name),
                member.role === "lead"
                  ? h("span", { className: "dshe-lead-chip", title: "团队主理人" },
                      h(Icon, { name: "crown", size: 11 }),
                      "主理人"
                    )
                  : null
              ),
              profession === ""
                ? null
                : h("div", { className: "dshe-member-prof", title: profession }, profession)
            )
          );
        })
      );
    }

    /**
     * 专家 / 团队详情里的技能状态行。
     * 状态：local=绿（点复制本地 SKILL.md 路径）/ repo=蓝（带「从仓库获取」按钮）/
     * missing=灰（点复制 ref 原文）。skillDetails 由 /detail 实时解析；
     * 旧后端没有该字段时回退到纯文本行为。
     * @param {{ skills: string[], skillDetails: Array<any>|undefined, onCopy: Function, onFetch: Function|undefined }} props 属性
     * @returns {any} React 元素
     */
    function SkillLines(props) {
      const details = Array.isArray(props.skillDetails) && props.skillDetails.length > 0
        ? props.skillDetails
        : textList(props.skills).map((path) => ({ ref: path, name: lastSegment(path) || path, status: "missing" }));
      return h("div", null,
        details.map((entry, index) => {
          const status = entry.status === "local" || entry.status === "repo" ? entry.status : "missing";
          const isLocal = status === "local";
          const isRepo = status === "repo";
          const title = isLocal
            ? (entry.localPath || entry.ref)
            : isRepo
              ? "仓库中找到该技能，可一键获取到本地"
              : "仅声明，本地与仓库均不存在";
          const pathText = isLocal ? (entry.localPath || "") : entry.ref;
          return h("div", { key: index, className: "dshe-skill-line" + (isLocal ? " dshe-skill-line-local" : isRepo ? " dshe-skill-line-repo" : "") },
            h("button", {
              type: "button",
              className: "dshe-skill-main",
              title,
              onClick: () => {
                if (isLocal) props.onCopy(entry.localPath || entry.ref, "已复制技能路径");
                else if (!isRepo) props.onCopy(entry.ref, "已复制技能引用（仅声明，未找到来源）");
              }
            },
              h("span", { className: "dshe-skill-dot dshe-skill-dot-" + status, "aria-label": status }),
              h("span", { className: "dshe-skill-name" }, entry.name || lastSegment(entry.ref) || entry.ref),
              h("span", { className: "dshe-skill-path" }, pathText)
            ),
            isRepo && typeof props.onFetch === "function"
              ? h("button", {
                  type: "button",
                  className: "dshe-skill-fetch",
                  title: "从技能仓库把 SKILL.md 取到本地专家目录",
                  onClick: () => props.onFetch(entry.ref)
                }, "从仓库获取")
              : null
          );
        })
      );
    }

    /**
     * 专家 / 专家团卡片。
     * @param {{ item: any, imported: boolean, onOpen: Function, onSummon: Function }} props 属性
     * @returns {any} React 元素
     */
    function ExpertCard(props) {
      const item = props.item;
      const tags = Array.isArray(item.tags) ? item.tags.slice(0, 3) : [];
      const name = displayNameOf(item);
      /* 称号放第一位：只有「真称号」才配当主标题。
         dsh 专家包不存 profession，服务端历史兜底会给出「本地专家」这类占位值；
         直接用它会显示成「本地专家 / 本地已导入」这种自相矛盾的文案。
         占位值时回落到真实名字（displayName，如「资深全栈开发工程师」）。 */
      const rawProfession = trimmed(item.profession);
      const profession = isRealProfession(rawProfession) ? rawProfession : "";
      const main = profession !== "" ? profession : name;
      const full = profession !== "" && profession !== name ? profession + " | " + name : name;
      /* 卡片主体是 div 而非 button：右上角「召唤」是嵌套按钮，button 里套 button
         是非法 HTML。主体点击仍打开详情，召唤按钮 stopPropagation 不冒泡。 */
      return h("div", {
        className: "dshe-card",
        role: "button",
        tabIndex: 0,
        onClick: () => props.onOpen(item),
        onKeyDown: (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onOpen(item);
          }
        },
        title: full,
        "aria-label": full
      },
        h("div", { className: "dshe-card-head" },
          h(Avatar, { src: assetUrl(item.avatar), name, size: 32, radius: 7, neutralFallback: true }),
          h("div", { className: "dshe-card-id" },
            h("div", { className: "dshe-card-name" }, main)
          ),
          h("button", {
            type: "button",
            className: "dshe-card-summon",
            "aria-label": "召唤 " + full,
            title: "召唤（自动导入并打开新会话）",
            onClick: (event) => {
              event.stopPropagation();
              if (typeof props.onSummon === "function") props.onSummon(item);
            }
          }, "召唤")
        ),
        h("div", { className: "dshe-card-desc" }, descOf(item.description) !== "" ? descOf(item.description) : "暂无描述"),
        h("div", { className: "dshe-chips" },
          tags.map((tag, index) => h(Chip, { key: index, label: tag })),
          item.local === true
            ? h(Chip, { key: "local", label: "本地" })
            : props.imported
              ? h(Chip, { key: "imported", label: "已导入" })
              : null
        )
      );
    }

    /**
     * 技能卡片的确定性配色：按技能名 hash 从柔和色板取色，
     * 同名技能每次打开颜色一致（hash 决定，无随机）。
     * @param {string} name 技能名
     * @returns {{ bg: string, fg: string }} 背景色与同系深色文字
     */
    var SKILL_TILE_PALETTE = [
      { bg: "#EEF2FF", fg: "#4338CA" },
      { bg: "#E0F2FE", fg: "#0369A1" },
      { bg: "#ECFDF5", fg: "#047857" },
      { bg: "#FEF3C7", fg: "#B45309" },
      { bg: "#FCE7F3", fg: "#BE185D" },
      { bg: "#F3E8FF", fg: "#7E22CE" },
      { bg: "#FFEDD5", fg: "#C2410C" },
      { bg: "#DCFCE7", fg: "#15803D" },
      { bg: "#E0E7FF", fg: "#3730A3" },
      { bg: "#CCFBF1", fg: "#0F766E" }
    ];

    /**
     * 简单字符串 hash（djb2），保证同名技能稳定同色。
     * @param {string} text 输入
     * @returns {number} 非负整数
     */
    function hashText(text) {
      let value = 5381;
      const text2 = String(text || "");
      for (let i = 0; i < text2.length; i += 1) {
        value = ((value << 5) + value + text2.charCodeAt(i)) >>> 0;
      }
      return value;
    }

    /**
     * 按技能名取确定性色板项。
     * @param {string} name 技能名
     * @returns {{ bg: string, fg: string }} 色板项
     */
    function skillTileColor(name) {
      return SKILL_TILE_PALETTE[hashText(name) % SKILL_TILE_PALETTE.length];
    }

    /**
     * 技能卡（参考图横向布局）：左彩色图标块 + 右（标题 / 一行描述）+ 右上
     * `+` 复制 SKILL.md 路径。不再渲染底部集合/文件元信息。卡片主体点击开详情，
     * `+` 不冒泡。
     * @param {{ item: any, onOpen: Function, onCopy: Function }} props 属性
     * @returns {any} React 元素
     */
    /**
     * 技能卡：图标 + 名称 + 一行描述 + 右上操作。
     *
     * 操作按钮语义（用户要求）：
     *   - 未安装 → `+` 安装到本地技能库（仓库技能也需要装过才能用）
     *   - 已安装 → 气泡图标，点了引用到当前对话
     *   - 已安装但被关闭 → 气泡置灰，提示先去「已安装」开启
     *
     * @param {{ item: any, installed: boolean, enabled: boolean, onOpen: Function, onInstall: Function, onApply: Function, onCopy: Function }} props 属性
     * @returns {any} React 元素
     */
    function SkillCard(props) {
      const item = props.item;
      const name = trimmed(item.name) || trimmed(item.id);
      const description = descOf(item.description);
      const color = skillTileColor(name);
      const installed = props.installed === true;
      const active = installed && props.enabled !== false;
      return h("div", {
        className: "dshe-skill-card",
        "data-skill-id": item.id,
        onClick: () => props.onOpen(item)
      },
        h("span", {
          className: "dshe-skill-tile",
          style: { backgroundColor: color.bg, color: color.fg },
          "aria-hidden": "true"
        }, initialOf(name)),
        h("div", { className: "dshe-skill-info" },
          h("div", { className: "dshe-skill-name", title: name }, name),
          h("div", { className: "dshe-skill-desc", title: description !== "" ? description : "暂无描述" },
            description !== "" ? description : "暂无描述")
        ),
        installed
          ? h("button", {
              type: "button",
              className: "dshe-card-apply" + (active ? "" : " dshe-card-apply-off"),
              disabled: active === false,
              title: active ? "引用到当前对话" : "该技能已关闭，请到「已安装」里开启后再用",
              "aria-label": "把 " + name + " 引用到当前对话",
              onClick: (event) => {
                event.stopPropagation();
                props.onApply(item);
              }
            }, h(Icon, { name: "chat", size: 15 }))
          : h("button", {
              type: "button",
              className: "dshe-skill-add",
              title: "安装到本地技能库后才能在对话里使用",
              "aria-label": "安装 " + name,
              onClick: (event) => {
                event.stopPropagation();
                props.onInstall(item);
              }
            }, h(Icon, { name: "plus", size: 14 }))
      );
    }

    /**
     * 连接器卡片：40 图标 + 名称 + `+` 复制配置 + 两行描述。
     * 卡片主体点击打开详情，`+` 只复制配置不冒泡。
     * @param {{ item: any, onOpen: Function, onCopy: Function }} props 属性
     * @returns {any} React 元素
     */
    function ConnectorCard(props) {
      const item = props.item;
      const [broken, setBroken] = useState(false);
      const name = trimmed(item.name) || trimmed(item.id);
      const description = descOf(item.description);
      return h("div", {
        className: "dshe-conn-card",
        "data-connector-id": item.id,
        onClick: () => props.onOpen(item)
      },
        h("div", { className: "dshe-conn-head" },
          h("span", { className: "dshe-conn-tile" },
            broken
              ? initialOf(name)
              : h("img", { src: iconUrl(item.id), alt: "", loading: "lazy", onError: () => setBroken(true) })
          ),
          h("button", {
            type: "button",
            className: "dshe-conn-name-btn",
            title: name,
            "aria-label": "查看 " + name + " 详情",
            onClick: (event) => {
              event.stopPropagation();
              props.onOpen(item);
            }
          }, name),
          props.connected === true
            ? h("button", {
                type: "button",
                className: "dshe-card-apply",
                title: "引用到当前对话",
                "aria-label": "把 " + name + " 引用到当前对话",
                onClick: (event) => {
                  event.stopPropagation();
                  props.onApply(item);
                }
              }, h(Icon, { name: "chat", size: 15 }))
            : h("button", {
                type: "button",
                className: "dshe-conn-add",
                title: "连接该连接器（登记后可引用到对话）",
                "aria-label": "连接 " + name,
                onClick: (event) => {
                  event.stopPropagation();
                  props.onConnect(item);
                }
              }, h(Icon, { name: "plus", size: 16 }))
        ),
        h("div", { className: "dshe-conn-desc", title: description }, description !== "" ? description : "暂无描述")
      );
    }

    /**
     * 错误条，带重试按钮。
     * @param {{ message: string, onRetry: Function }} props 属性
     * @returns {any} React 元素
     */
    function ErrorBar(props) {
      return h("div", { className: "dshe-errbar" },
        h("span", null, props.message),
        h("button", { type: "button", className: "dshe-btn", onClick: props.onRetry }, "重试")
      );
    }

    /**
     * 加载骨架。
     * @returns {any} React 元素
     */
    function Skeleton() {
      return h("div", { className: "dshe-grid" },
        [0, 1, 2, 3, 4, 5].map((index) => h("div", { key: index, className: "dshe-skel" }))
      );
    }

    // =======================================================================
    // 详情抽屉
    // =======================================================================

    /**
     * 专家 / 专家团详情正文。
     * 数据条只展示真实存在的字段：版本 / 技能数或成员数 / 分类，缺数据整列不渲染。
     * @param {{ item: any, isTeam: boolean, readme: string, onCopy: Function }} props 属性
     * @returns {any} React 元素
     */
    function ExpertDetailBody(props) {
      const item = props.item;
      const isTeam = props.isTeam === true;
      const tags = textList(item.tags);
      const prompts = promptList(item.quickPrompts);
      const skills = textList(item.skills);
      const members = isTeam && Array.isArray(item.members) ? item.members : [];
      const version = trimmed(item.version);
      const description = descOf(item.description);
      const readme = plainMarkdown(props.readme);

      const stats = [
        { label: "版本", value: version === "" ? "" : (version.charAt(0) === "v" ? version : "v" + version), icon: "v" },
        isTeam
          ? { label: "成员", value: members.length === 0 ? "" : String(members.length), icon: "users" }
          : { label: "技能", value: skills.length === 0 ? "" : String(skills.length), icon: "spark" },
        { label: "分类", value: categoryLabel(item.categoryId), icon: "tag" }
      ];

      return h("div", null,
        h(DetailHero, {
          item,
          kind: isTeam ? "team" : "expert",
          actionLabel: "召唤",
          onAction: () => {
            /* 召唤 = 开新会话并常驻（探针确认宿主支持）；bridge 未就绪时
               降级为旧的复制召唤语行为 */
            if (typeof props.onSummon === "function") {
              props.onSummon(item);
              return;
            }
            props.onCopy(summonText(item), "召唤语已复制，粘贴到对话即可");
          }
        }),
        h("div", { className: "dshe-detail-desc" }, description !== "" ? description : "暂无描述"),
        tags.length === 0
          ? null
          : h("div", { className: "dshe-tagrow" }, tags.map((tag, index) => h("span", { key: index, className: "dshe-tag", title: tag }, tag))),
        h("div", { className: "dshe-divider" }),
        h(StatRow, { items: stats }),
        h("div", { className: "dshe-divider" }),
        prompts.length === 0
          ? null
          : h(Block, { title: isTeam ? "团队帮你做" : "专家帮你做", icon: "spark" },
              prompts.map((text, index) => h(PromptRow, {
                key: index,
                text,
                onCopy: () => props.onCopy(text, "已复制提示语")
              }))
            ),
        members.length === 0
          ? null
          : h(Block, { title: "团队成员", icon: "users" }, h(MemberGrid, { members })),
        skills.length === 0
          ? null
          : h(Block, { title: "技能", icon: "layers" }, h(SkillLines, {
              skills,
              skillDetails: item.skillDetails,
              onCopy: props.onCopy,
              onFetch: props.onSkillFetch
            })),
        readme === ""
          ? null
          : h(Block, { title: "说明", icon: "book" }, h("div", { className: "dshe-readme" }, readme)),
        h(Block, { title: "更多", icon: "list" },
          h(MoreBox, {
            lines: [
              "ID: " + trimmed(item.id),
              item.local === true ? "源：~/.dsh/experts/" + trimmed(item.id) : ""
            ]
          })
        )
      );
    }

    /**
     * 技能详情正文。
     * @param {{ item: any, readme: string, onCopy: Function }} props 属性
     * @returns {any} React 元素
     */
    function SkillDetailBody(props) {
      const item = props.item;
      const [expanded, setExpanded] = useState(false);
      const description = descOf(item.description);
      const version = trimmed(item.version);
      const collection = trimmed(item.collection);
      const path = trimmed(item.path);
      const readme = plainMarkdown(props.readme);
      const clampable = description.length > DESC_CLAMP_CHARS;

      const stats = [
        { label: "版本", value: version === "" ? "—" : (version.charAt(0) === "v" ? version : "v" + version), icon: "v" },
        { label: "所属集合", value: collection, icon: "layers", title: collection },
        // 文件只显示基名（都是 SKILL.md），完整路径放 title 与「更多」里
        { label: "文件", value: lastSegment(path), icon: "file", title: path }
      ];

      return h("div", null,
        h(DetailHero, {
          item,
          kind: "skill",
          actionLabel: "安装",
          onAction: () => props.onCopy(path, "技能路径已复制")
        }),
        h("div", { className: "dshe-detail-desc" + (clampable && expanded === false ? " dshe-desc-clamp" : "") },
          description !== "" ? description : "暂无描述"),
        clampable
          ? h("button", {
              type: "button",
              className: "dshe-expand",
              "aria-expanded": expanded,
              onClick: () => setExpanded(!expanded)
            },
              expanded ? "收起" : "展开",
              h(Icon, { name: expanded ? "chevron-up" : "chevron-down", size: 14 })
            )
          : null,
        h("div", { className: "dshe-divider" }),
        h(StatRow, { items: stats }),
        h("div", { className: "dshe-divider" }),
        h(Block, { title: "说明", icon: "book" },
          readme === ""
            ? h("div", { className: "dshe-muted" }, "该技能没有可预览的正文")
            : h("div", { className: "dshe-readme" }, readme)
        ),
        h(Block, { title: "更多", icon: "list" },
          h(MoreBox, { lines: ["ID: " + trimmed(item.id), path === "" ? "" : "路径：" + path] })
        )
      );
    }

    /**
     * 连接器详情正文。
     * @param {{ item: any, onCopy: Function }} props 属性
     * @returns {any} React 元素
     */
    function ConnectorDetailBody(props) {
      const item = props.item;
      const description = descOf(item.description);
      const author = trimmed(item.author);
      const transport = trimmed(item.transport);
      const configText = connectorConfigText(item);
      const configCount = connectorConfigCount(item);

      const stats = [
        { label: "传输方式", value: transport, icon: "bolt", title: transport },
        { label: "配置项", value: configCount === 0 ? "" : String(configCount), icon: "sliders" },
        { label: "作者", value: author, icon: "person", title: author }
      ];

      return h("div", null,
        h(DetailHero, {
          item,
          kind: "connector",
          iconSrc: iconUrl(item.id),
          contain: true,
          actionLabel: "复制配置",
          onAction: () => props.onCopy(configText === "" ? "" : configText, configText === "" ? "该连接器没有 MCP 配置" : "已复制 MCP 配置")
        }),
        h("div", { className: "dshe-detail-desc" }, description !== "" ? description : "暂无描述"),
        h("div", { className: "dshe-divider" }),
        h(StatRow, { items: stats }),
        h("div", { className: "dshe-divider" }),
        h(Block, { title: "MCP 配置", icon: "sliders" },
          configText === ""
            ? h("div", { className: "dshe-muted" }, "该连接器为 CLI 类型，没有 MCP 配置")
            : h("div", { className: "dshe-config" },
                h("pre", { className: "dshe-config-pre" }, configText),
                h("button", {
                  type: "button",
                  className: "dshe-config-copy",
                  title: "复制 MCP 配置",
                  "aria-label": "复制 MCP 配置",
                  onClick: () => props.onCopy(configText, "已复制 MCP 配置")
                }, h(Icon, { name: "copy", size: 15 }))
              )
        ),
        h(Block, { title: "更多", icon: "list" },
          h(MoreBox, {
            lines: [
              "ID: " + trimmed(item.id),
              trimmed(item.url) === "" ? "" : "地址：" + trimmed(item.url)
            ]
          })
        )
      );
    }

    // =======================================================================
    // 设置弹窗（数据源仓库地址）
    // =======================================================================

    /**
     * 校验仓库地址输入：仅放行 https:// 与 git@ 形式（与后端同规则，前端只是提前提示）。
     * @param {string} value 用户输入
     * @returns {string} 错误文案；合法返回空串
     */
    function settingsUrlError(value) {
      const trimmed = String(value || "").trim();
      if (trimmed === "") return "仓库地址不能为空";
      if (/\s/.test(trimmed) || trimmed.includes("..")) return "地址中含非法字符";
      if (trimmed.startsWith("https://")) return /^https:\/\/[^\s]+$/.test(trimmed) ? "" : "https 地址格式不正确";
      if (trimmed.startsWith("git@")) return /^git@[^\s/:\\]+:[^\s]+$/.test(trimmed) ? "" : "git@ 地址格式形如 git@host:owner/repo.git";
      return "仅支持 https:// 或 git@ 形式的仓库地址";
    }

    /**
     * 设置弹窗：配置数据源 git 仓库地址。
     * 复用居中弹窗骨架的小号变体；Esc / 点遮罩关闭；非法输入内联红字且禁用保存。
     * @param {{ onClose: Function, onToast: Function, libraryMode: boolean }} props 属性
     * @returns {any} React 元素
     */
    function SettingsDialog(props) {
      const [loaded, setLoaded] = useState(false);
      const [sourceUrl, setSourceUrl] = useState("");
      const [defaultUrl, setDefaultUrl] = useState("");
      const [usingDefault, setUsingDefault] = useState(true);
      const [skillhubUrl, setSkillhubUrl] = useState("");
      const [skillhubTouched, setSkillhubTouched] = useState(false);
      const [saving, setSaving] = useState(false);
      const [loadError, setLoadError] = useState(null);
      const [touched, setTouched] = useState(false);

      // 打开时拉当前生效值。
      useEffect(() => {
        let cancelled = false;
        fetchJson("/settings")
          .then((res) => {
            if (cancelled) return;
            if (res !== null && res !== undefined && res.ok === true) {
              setSourceUrl(String(res.sourceUrl || ""));
              setDefaultUrl(String(res.defaultUrl || ""));
              setUsingDefault(res.usingDefault === true);
              setSkillhubUrl(String(res.skillhubUrl || ""));
              setLoaded(true);
            } else {
              setLoadError((res && (res.error || res.message)) || "无法读取设置");
            }
          })
          .catch((error) => {
            if (!cancelled) setLoadError(String((error && error.message) || error));
          });
        return () => { cancelled = true; };
      }, []);

      useEffect(() => {
        const onKey = (event) => { if (event.key === "Escape") props.onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, []);

      const trimmedValue = String(sourceUrl || "").trim();
      const errorText = touched && trimmedValue !== "" ? settingsUrlError(trimmedValue) : "";
      const skillhubTrimmed = String(skillhubUrl || "").trim();
      const skillhubError = skillhubTouched && skillhubTrimmed !== "" && !/^https?:\/\/[^\s]+$/.test(skillhubTrimmed)
        ? "Skillhub 地址需为 http(s):// 形式（内网可用 http）"
        : "";
      const canSave = loaded && saving === false && trimmedValue !== "" && errorText === "" && skillhubError === "";

      /**
       * 保存：POST /settings，成功后 toast + 关闭。
       * @returns {void}
       */
      function doSave() {
        if (!canSave) return;
        setSaving(true);
        fetch(API + "/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceUrl: trimmedValue, skillhubUrl: skillhubTrimmed })
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              props.onToast("已保存，下次同步生效");
              props.onClose();
            } else {
              props.onToast((res && (res.error || res.message)) || "保存失败");
              setSaving(false);
            }
          })
          .catch((error) => {
            props.onToast("保存失败：" + String((error && error.message) || error));
            setSaving(false);
          });
      }

      /**
       * 恢复默认：POST /settings/reset，成功后清空输入为默认值。
       * @returns {void}
       */
      function doReset() {
        if (saving === true || usingDefault === true) return;
        setSaving(true);
        fetch(API + "/settings/reset", { method: "POST" })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setSourceUrl(String(res.sourceUrl || ""));
              setUsingDefault(true);
              setTouched(false);
              setSkillhubUrl(String(res.skillhubUrl || ""));
              props.onToast("已恢复默认仓库地址");
            } else {
              props.onToast((res && (res.error || res.message)) || "恢复默认失败");
            }
          })
          .catch((error) => props.onToast("恢复默认失败：" + String((error && error.message) || error)))
          .finally(() => setSaving(false));
      }

      return h("div", {
        className: "dshe-mask",
        onClick: (event) => { if (event.target === event.currentTarget) props.onClose(); }
      },
        h("div", {
          className: "dshe-settings",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "设置"
        },
          h("button", {
            type: "button",
            className: "dshe-drawer-close",
            "aria-label": "关闭",
            title: "关闭",
            onClick: props.onClose
          }, h(Icon, { name: "close", size: 18 })),
          h("h2", { className: "dshe-settings-title" }, "设置"),
          loadError !== null
            ? h("div", { className: "dshe-settings-error" }, loadError)
            : h("div", { className: "dshe-settings-field" },
                h("label", { className: "dshe-settings-label", htmlFor: "dshe-settings-url" }, "资源仓库地址"),
                h("input", {
                  id: "dshe-settings-url",
                  className: "dshe-settings-input" + (errorText !== "" ? " dshe-settings-input-err" : ""),
                  type: "text",
                  value: sourceUrl,
                  placeholder: defaultUrl || "https://example.com/repo.git",
                  disabled: loaded === false || saving === true,
                  spellCheck: false,
                  onChange: (event) => { setTouched(true); setSourceUrl(event.target.value); },
                  onKeyDown: (event) => { if (event.key === "Enter") doSave(); }
                }),
                errorText !== ""
                  ? h("p", { className: "dshe-settings-hint-err", role: "alert" }, errorText)
                  : h("p", { className: "dshe-settings-hint" }, "支持 https:// 或 git@ 形式；保存后下次同步生效"),
                props.libraryMode
                  ? h("p", { className: "dshe-settings-note" }, "当前为本地资料库模式，保存的地址在切回原数据源后生效")
                  : null
              ),
            h("div", { className: "dshe-settings-field" },
                h("label", { className: "dshe-settings-label", htmlFor: "dshe-settings-skillhub" }, "Skillhub 地址（可选）"),
                h("input", {
                  id: "dshe-settings-skillhub",
                  className: "dshe-settings-input" + (skillhubError !== "" ? " dshe-settings-input-err" : ""),
                  type: "text",
                  value: skillhubUrl,
                  placeholder: "https://api.skillhub.cn",
                  disabled: loaded === false || saving === true,
                  spellCheck: false,
                  onChange: (event) => { setSkillhubTouched(true); setSkillhubUrl(event.target.value); }
                }),
                skillhubError !== ""
                  ? h("p", { className: "dshe-settings-hint-err", role: "alert" }, skillhubError)
                  : h("p", { className: "dshe-settings-hint" }, "留空使用官方 https://api.skillhub.cn；内网自建商店可填 http:// 地址")
              ),
          h("div", { className: "dshe-settings-foot" },
            h("button", {
              type: "button",
              className: "dshe-btn",
              disabled: saving === true || usingDefault === true,
              title: usingDefault === true ? "当前已是默认地址" : undefined,
              onClick: doReset
            }, "恢复默认"),
            h("span", { className: "dshe-settings-foot-gap" }),
            h("button", { type: "button", className: "dshe-btn", disabled: saving === true, onClick: props.onClose }, "取消"),
            h("button", {
              type: "button",
              className: "dshe-btn dshe-btn-primary",
              disabled: canSave === false,
              onClick: doSave
            }, saving === true ? [h("span", { key: "spin", className: "dshe-spin" }), "保存中…"] : "保存")
          )
        )
      );
    }

    // =======================================================================

    /**
     * 右侧抽屉（详情页）。
     * @param {{ state: any, importedIds: string[], onClose: Function, onImport: Function, onCopy: Function }} props 属性
     * @returns {any} React 元素
     */
    function DetailDrawer(props) {
      const state = props.state;

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === "Escape") props.onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, []);

      let body = null;
      /* 用户要求：详情底部「已导入 ✓ / 导入 / 关闭」整条不再显示。
         关闭统一走右上角 X、Esc、点遮罩三种出口。 */
      const footer = null;

      if (state.kind === "loading") {
        body = h("div", { className: "dshe-drawer-state" },
          h("span", { className: "dshe-spin" }),
          "加载中…"
        );
      } else if (state.kind === "error") {
        body = h("div", { className: "dshe-drawer-state dshe-drawer-state-err" }, state.message);
      } else if (state.type === "skill") {
        body = h(SkillDetailBody, { item: state.item, readme: state.readme || "", onCopy: props.onCopy });
      } else if (state.type === "connector") {
        body = h(ConnectorDetailBody, { item: state.item, onCopy: props.onCopy });
      } else {
        const isTeam = state.type === "team" || state.item.type === "team";
        body = h(ExpertDetailBody, {
          item: state.item,
          isTeam,
          readme: state.readme || "",
          onCopy: props.onCopy,
          onSkillFetch: props.onSkillFetch,
          onSummon: props.onSummon
        });
        /* 未导入的专家由「召唤」自动导入；关闭走右上角 X / Esc / 点遮罩。 */
      }

      return h("div", {
        className: "dshe-mask",
        onClick: (event) => {
          if (event.target === event.currentTarget) props.onClose();
        }
      },
        h("div", {
          className: "dshe-drawer",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": state.title || "详情"
        },
          /* 单条目导出：专家 / 专家团 / 技能各自打包成一个 .json.gz，
             换台机器用顶部的「导入条目」即可只新增这一条。 */
          state.type === "expert" || state.type === "team" || state.type === "skill"
            ? h("button", {
                type: "button",
                className: "dshe-drawer-export",
                title: "把这个条目导出为文件（单个条目，不含其他数据）",
                "aria-label": "导出这个条目",
                onClick: () => props.onExportItem(
                  state.type === "team" ? "team" : (state.type === "skill" ? "skill" : "expert"),
                  state.item !== null && state.item !== undefined ? state.item.id : ""
                )
              }, h(Icon, { name: "download", size: 16 }), "导出")
            : null,
          h("button", {
            type: "button",
            className: "dshe-drawer-close",
            "aria-label": "关闭",
            title: "关闭",
            onClick: props.onClose
          }, h(Icon, { name: "close", size: 20 })),
          h("div", { className: "dshe-drawer-body" }, body),
          footer
        )
      );
    }

    // =======================================================================
    // 主面板
    // =======================================================================

    /**
     * 主面板组件。
     * @returns {any} React 元素
     */
    function Panel() {
      const [status, setStatus] = useState(null);
      const [statusError, setStatusError] = useState(null);
      const [tab, setTab] = useState("experts");
      /* 技能块的来源子分组：repo=仓库技能（原有），skillhub=商店，installed=已安装库。 */
      const [skillSource, setSkillSource] = useState("repo");
      /* 已安装技能（含被关闭的）与已连接连接器：卡片按钮据此在「+」与「对话」间切换。 */
      const [installedSkills, setInstalledSkills] = useState([]);
      const [connectedConnectors, setConnectedConnectors] = useState([]);
      const [inputs, setInputs] = useState({ experts: "", teams: "", skills: "", connectors: "" });
      const [applied, setApplied] = useState({ experts: "", teams: "", skills: "", connectors: "" });
      const [data, setData] = useState({ experts: null, teams: null, skills: null, connectors: null });
      const [errors, setErrors] = useState({});
      const [loading, setLoading] = useState(false);
      const [loadingMore, setLoadingMore] = useState(false);
      const [detail, setDetail] = useState(null);
      const [importedIds, setImportedIds] = useState([]);
      const [skillsMissing, setSkillsMissing] = useState(false);
      const [toast, setToast] = useState(null);
      const [nonce, setNonce] = useState(0);
      const [transferring, setTransferring] = useState("");
      const [settingsOpen, setSettingsOpen] = useState(false);

      const prevBusy = useRef(false);
      const restoreFocusRef = useRef(null);
      const importFileRef = useRef(null);

      /**
       * 拉取整体状态。
       * @returns {Promise<any>} 状态载荷
       */
      const loadStatus = useCallback(() => {
        return fetchJson("/status")
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setStatus(res);
              setStatusError(null);
            } else {
              setStatusError((res && (res.error || res.message)) || "无法连接插件后端");
            }
            return res;
          })
          .catch((error) => {
            setStatusError(String((error && error.message) || error));
            return null;
          });
      }, []);

      /**
       * 拉取已导入列表。
       * @returns {Promise<void>}
       */
      const loadImported = useCallback(() => {
        return fetchJson("/imported")
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) setImportedIds(res.ids || []);
          })
          .catch(() => {});
      }, []);

      /**
       * 重新拉取已安装技能清单——唯一写入 installedSkills 的刷新入口。
       *
       * 挂载 / nonce 变化（开关、仓库安装、同步完成）与安装成功后的自定义事件
       * 都走这里，避免多处各写一遍 fetch 造成两套机制。
       * @param {(() => boolean)|undefined} isActive 可选：返回 false 时丢弃过期响应
       * @returns {Promise<void>} 刷新完成
       */
      const refreshInstalledSkills = useCallback((isActive) => {
        const alive = typeof isActive === "function" ? isActive : () => true;
        return fetchJson("/skills/installed")
          .then((res) => {
            if (!alive()) return;
            if (res !== null && res !== undefined && res.ok === true) {
              setInstalledSkills(Array.isArray(res.items) ? res.items : []);
            }
          })
          .catch(() => { /* 已安装态拿不到不影响浏览 */ });
      }, []);

      // 首次挂载：状态 + 已导入列表。
      useEffect(() => {
        loadStatus();
        loadImported();
      }, []);

      const busy = status !== null && (status.busy === true || status.indexReady !== true);

      // 同步中轮询状态。
      useEffect(() => {
        if (!busy) return undefined;
        const timer = setInterval(() => {
          loadStatus();
        }, 1000);
        return () => clearInterval(timer);
      }, [busy, loadStatus]);

      // 同步由「进行中」转为「结束」时提示并刷新列表。
      useEffect(() => {
        if (status === null) return;
        const nowBusy = status.busy === true;
        if (prevBusy.current === true && nowBusy === false) {
          if (status.lastError !== null && status.lastError !== undefined) {
            setToast("同步失败：" + status.lastError);
          } else {
            setToast("资源已同步");
            setNonce((value) => value + 1);
          }
        }
        prevBusy.current = nowBusy;
      }, [status]);

      // 搜索输入防抖 250ms。
      useEffect(() => {
        const value = inputs[tab];
        const timer = setTimeout(() => {
          setApplied((prev) => (prev[tab] === value ? prev : Object.assign({}, prev, { [tab]: value })));
        }, 250);
        return () => clearTimeout(timer);
      }, [inputs.experts, inputs.teams, inputs.skills, inputs.connectors, tab]);

      /* 已安装技能 / 已连接连接器：挂载与数据变化（nonce）时刷新。
         卡片按钮据此在「+（安装/连接）」与「对话（引用）」之间切换。
         installedSkills 统一交给 refreshInstalledSkills()，与安装广播共用一条路径。 */
      useEffect(() => {
        let cancelled = false;
        refreshInstalledSkills(() => !cancelled);
        fetchJson("/connectors/connected")
          .then((res) => {
            if (cancelled) return;
            if (res !== null && res !== undefined && res.ok === true) setConnectedConnectors(Array.isArray(res.ids) ? res.ids : []);
          })
          .catch(() => { /* 同上 */ });
        return () => { cancelled = true; };
      }, [nonce]);

      /* 安装成功后立即刷新「已安装」：SkillHubStore / SkillHubDetail 是深层子组件，
         用 window 事件解耦，不必层层透传 onInstalled 回调。
         refreshInstalledSkills 由 useCallback([]) 稳定持有，deps 可安全置空；
         卸载时移除监听，window 不可用时 try/catch 降级（测试桩是简化对象）。 */
      useEffect(() => {
        const onInstalledChanged = () => { refreshInstalledSkills(); };
        try {
          window.addEventListener("dsh-buddy-expert-hub:installed-skills-changed", onInstalledChanged);
        } catch { /* 非 DOM 环境降级：忽略 */ }
        return () => {
          try {
            window.removeEventListener("dsh-buddy-expert-hub:installed-skills-changed", onInstalledChanged);
          } catch { /* 同上 */ }
        };
      }, []);

      const ready = status !== null && status.indexReady === true;
      const activeQuery = applied[tab];

      // 当前标签页数据加载。
      useEffect(() => {
        if (!ready) return undefined;
        let cancelled = false;
        setLoading(true);
        setErrors((prev) => {
          if (prev[tab] === undefined) return prev;
          const next = Object.assign({}, prev);
          delete next[tab];
          return next;
        });
        fetchJson(listPath(tab, activeQuery, 0, pageSizeOf(tab)))
          .then((res) => {
            if (cancelled) return;
            if (res !== null && res !== undefined && res.ok === true) {
              setSkillsMissing(false);
              setData((prev) => Object.assign({}, prev, {
                [tab]: {
                  items: res.items || [],
                  total: res.total || 0,
                  collections: res.collections || []
                }
              }));
            } else if (res !== null && res !== undefined && res.code === "skills-missing") {
              // 数据源里没有 skills/：专家数据可用，但技能需要先同步一次仓库。
              setSkillsMissing(true);
            } else if (res !== null && res !== undefined && res.busy === true) {
              setErrors((prev) => Object.assign({}, prev, { [tab]: res.message || "首次同步中，请稍候…" }));
            } else {
              setErrors((prev) => Object.assign({}, prev, {
                [tab]: (res && (res.error || res.message)) || "加载失败"
              }));
            }
          })
          .catch((error) => {
            if (cancelled) return;
            setErrors((prev) => Object.assign({}, prev, { [tab]: String((error && error.message) || error) }));
          })
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
        return () => {
          cancelled = true;
        };
      }, [ready, tab, activeQuery, nonce]);

      // toast 自动消失。
      useEffect(() => {
        if (toast === null) return undefined;
        const timer = setTimeout(() => setToast(null), 3200);
        return () => clearTimeout(timer);
      }, [toast]);

      /**
       * 各标签页的分页大小。
       * @param {string} which 标签页 id
       * @returns {number} 每页条数
       */
      function pageSizeOf(which) {
        return which === "skills" ? PAGE_SIZE : CONNECTOR_PAGE_SIZE;
      }

      /**
       * 当前标签页加载下一页（技能 / 连接器）。
       * @returns {void}
       */
      function loadMore() {
        if (loadingMore === true) return;
        const current = data[tab];
        if (current === null || current === undefined) return;
        if (current.items.length >= current.total) return;
        setLoadingMore(true);
        fetchJson(listPath(tab, applied[tab], current.items.length, pageSizeOf(tab)))
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setData((prev) => {
                const base = prev[tab];
                if (base === null || base === undefined) return prev;
                return Object.assign({}, prev, {
                  [tab]: {
                    items: base.items.concat(res.items || []),
                    total: res.total || base.total,
                    collections: res.collections || base.collections
                  }
                });
              });
            }
          })
          .catch(() => {})
          .finally(() => setLoadingMore(false));
      }

      /**
       * 滚动到底部自动加载（技能 / 连接器）。
       * @param {any} event 滚动事件
       * @returns {void}
       */
      function onBodyScroll(event) {
        if (tab !== "skills" && tab !== "connectors") return;
        const el = event.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) loadMore();
      }

      /**
       * 复制文本并提示。
       * @param {string} text 文本
       * @param {string} message 成功提示
       * @returns {void}
       */
      function doCopy(text, message) {
        copyText(text, message)
          .then(() => setToast(message))
          .catch((error) => setToast("复制失败：" + String((error && error.message) || error)));
      }

      /**
       * 从仓库获取专家声明的技能：成功后就地把该行变绿并 toast。
       * @param {string} expertId 专家 id
       * @param {string} ref 技能引用
       * @returns {void}
       */
      function doSkillFetch(expertId, ref) {
        fetch(API + "/skills/fetch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expertId, ref })
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setToast(res.already === true ? "该技能已在本地" : "技能已获取到本地");
              setDetail((prev) => {
                if (prev === null || prev.kind !== "ready" || prev.item === null || prev.item === undefined ||
                    !Array.isArray(prev.item.skillDetails)) return prev;
                return Object.assign({}, prev, {
                  item: Object.assign({}, prev.item, {
                    skillDetails: prev.item.skillDetails.map((entry) =>
                      entry.ref === ref ? Object.assign({}, entry, { status: "local", localPath: res.localPath }) : entry)
                  })
                });
              });
            } else {
              setToast((res && (res.error || res.message)) || "获取失败");
            }
          })
          .catch((error) => setToast("获取失败：" + String((error && error.message) || error)));
      }

      /**
       * 打开详情抽屉。打开前记住焦点，关闭时还给触发元素。
       * @param {any} item 列表条目
       * @param {string} type 详情类型
       * @returns {void}
       */
      function openDetail(item, type) {
        if (typeof document !== "undefined" && document.activeElement !== undefined && document.activeElement !== null) {
          restoreFocusRef.current = document.activeElement;
        }
        const title = displayNameOf(item) || trimmed(item.name) || trimmed(item.id);
        setDetail({ kind: "loading", type, id: item.id, title });
        fetchJson("/detail?type=" + encodeURIComponent(type) + "&id=" + encodeURIComponent(item.id))
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setDetail(Object.assign({ kind: "ready" }, res, { title }));
            } else {
              setDetail({ kind: "error", type, id: item.id, title, message: (res && (res.error || res.message)) || "加载详情失败" });
            }
          })
          .catch((error) => {
            setDetail({ kind: "error", type, id: item.id, title, message: String((error && error.message) || error) });
          });
      }

      /**
       * 关闭详情抽屉，并把焦点还给打开它的元素。
       * @returns {void}
       */
      function closeDetail() {
        setDetail(null);
        const node = restoreFocusRef.current;
        restoreFocusRef.current = null;
        if (node !== null && node !== undefined && typeof node.focus === "function") node.focus();
      }

      /**
       * 导入专家 / 专家团。召唤场景会 await 这个 Promise（静默导入，不弹 toast）。
       * @param {any} item 专家条目
       * @param {boolean} [silent=false] 静默：成功不弹 toast（失败仍提示）
       * @returns {Promise<boolean>} 是否导入成功（或本来就已导入）
       */
      function doImport(item, silent) {
        return fetch(API + "/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: item.type === "team" ? "team" : "expert", id: item.id })
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setImportedIds((prev) => (prev.indexOf(res.id) >= 0 ? prev : prev.concat([res.id])));
              if (silent !== true) setToast(res.already === true ? "该专家已经导入过" : "已导入：" + res.path);
              return true;
            }
            setToast((res && (res.error || res.message)) || "导入失败");
            return false;
          })
          .catch((error) => {
            setToast("导入失败：" + String((error && error.message) || error));
            return false;
          });
      }

      /**
       * 召唤前的自动导入：本地已导入或已在已导入列表里 → 直接完成；
       * 否则静默 POST /import（不弹「已导入」toast，召唤本身就是用户意图）。
       * @param {any} item 专家/团队条目
       * @returns {Promise<boolean>} 是否可继续召唤
       */
      function ensureImported(item) {
        if (item.local === true || importedIds.indexOf(item.id) >= 0) return Promise.resolve(true);
        return doImport(item, true);
      }

      /**
       * 找某个技能在已安装清单里的记录（按安全化目录名匹配）。
       * @param {any} item 技能条目
       * @returns {any|null} 已安装记录；未安装返回 null
       */
      function installedRowOf(item) {
        /* SkillHub 商店条目只有 `slug`（没有 id，也没有本地目录名），而安装落盘后的
           目录名来自 SKILL.md frontmatter 的 name，两者经常对不上。后端
           /skills/installed 会把 _meta.json 里的 slug 一并返回，按它匹配最可靠 ——
           否则已装过的商店技能点「对话」会被误判成「还没安装」。 */
        const slug = trimmed(item.slug);
        if (slug !== "") {
          const bySlug = installedSkills.find((row) => row !== null && row !== undefined && trimmed(row.slug) === slug);
          if (bySlug !== undefined) return bySlug;
        }
        const name = trimmed(item.name) || trimmed(item.id);
        const dir = skillDirNameOfClient(name);
        if (dir === "") return null;
        const hit = installedSkills.find((row) => row !== null && row !== undefined && row.dir === dir);
        return hit === undefined ? null : hit;
      }

      /**
       * 安装仓库技能到本地技能库（卡片「+」）。
       * @param {any} item 技能条目
       * @returns {void}
       */
      function installRepoSkill(item) {
        const id = String(item.id || "");
        if (id === "" || transferring !== "") return;
        setTransferring("install");
        fetch(API + "/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id })
        })
          .then((resp) => resp.json())
          .then((res) => {
            setTransferring("");
            if (res !== null && res !== undefined && res.ok === true) {
              setToast(res.already === true
                ? "「" + String(res.name || id) + "」已经安装过"
                : "已安装「" + String(res.name || id) + "」，现在就可以在对话里引用");
              /* nonce 重载列表数据；事件统一刷新已安装清单（与商店两个入口同一路径）。 */
              setNonce((value) => value + 1);
              notifyInstalledSkillsChanged();
            } else {
              setToast("安装失败：" + String((res && (res.error || res.message)) || "未知错误"));
            }
          })
          .catch((error) => {
            setTransferring("");
            setToast("安装失败：" + String((error && error.message) || error));
          });
      }

      /**
       * 连接连接器（卡片「+」）：把该连接器挂到本会话的 system prompt 上常驻。
       *
       * 两步都成功才提示：先 POST /attach 建立会话常驻（与专家单选不同，连接器
       * 可多选、不清专家），再 POST /connectors/connect 保留列表按钮的「已连接」形态。
       * 宿主 MCP 工具仍需 profile 里的 mcp-client 实例，本插件不改用户配置文件。
       *
       * @param {any} item 连接器条目
       * @returns {void}
       */
      function connectConnector(item) {
        const id = String(item.id || "");
        if (id === "") return;
        const sid = resolveSessionId(null);
        if (sid === "") {
          setToast("未找到当前会话：请先在对话里打开一个会话，再点「连接」");
          return;
        }
        const label = trimmed(item.name) || trimmed(item.displayName) || id;
        fetch(API + "/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid, type: "connector", id })
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) {
              setToast("常驻失败：" + String((res && (res.error || res.message)) || "未知错误"));
              return undefined;
            }
            return fetch(API + "/connectors/connect", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id })
            })
              .then((resp2) => resp2.json())
              .then((res2) => {
                if (res2 === null || res2 === undefined || res2.ok !== true) {
                  /* /attach 已成功：即使连接状态登记失败，也让 dock 立刻对账显示 */
                  try { window.dispatchEvent(new Event("dsh-buddy-expert-hub:attachments-changed")); } catch { /* 忽略 */ }
                  setToast("已挂到本会话，但连接状态登记失败：" +
                    String((res2 && (res2.error || res2.message)) || "未知错误"));
                  showConversationSafe();
                  return;
                }
                /* dock 监听同一事件：立刻对账，不必等 5s 轮询 */
                try { window.dispatchEvent(new Event("dsh-buddy-expert-hub:attachments-changed")); } catch { /* 忽略 */ }
                setToast("已挂到本会话：「" + label + "」" +
                  (res2.hostConfigRequired === true ? "；引用到对话时会带上 MCP 配置" : ""));
                /* 与技能引用一致：挂完切回对话视图，让用户看到 dock 里的连接器图标 chip。 */
                showConversationSafe();
                setNonce((value) => value + 1);
              });
          })
          .catch((error) => setToast("常驻失败：" + String((error && error.message) || error)));
      }

      /**
       * 开启 / 关闭某个已安装技能（关闭后宿主扫描不到，对话不再加载）。
       * @param {any} row 已安装记录
       * @param {boolean} enabled 目标状态
       * @returns {void}
       */
      function toggleInstalledSkill(row, enabled) {
        const dir = row !== null && row !== undefined ? String(row.dir || "") : "";
        if (dir === "") return;
        fetch(API + "/skills/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir, enabled })
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setToast(enabled
                ? "已开启「" + String(row.name || dir) + "」，现在就可以在对话里引用"
                : "已关闭「" + String(row.name || dir) + "」，对话不再加载它");
              setNonce((value) => value + 1);
            } else {
              setToast((enabled ? "开启失败：" : "关闭失败：") + String((res && (res.error || res.message)) || "未知错误"));
            }
          })
          .catch((error) => setToast("操作失败：" + String((error && error.message) || error)));
      }

      /**
       * 把技能/连接器作为**结构化引用**插入当前会话草稿（与 composer 菜单选中效果一致）。
       *
       * 走宿主 `input.insertReference`（pickerInsertRef 桥），草稿里出现 chip，
       * 发送时由 serialize 展开正文 / MCP 配置——不往输入框塞纯文本。
       *
       * @param {any} item 技能或连接器条目
       * @param {'skill'|'connector'} refType 引用类型
       * @returns {void}
       */
      function applyToConversation(item, refType) {
        const label = trimmed(item.name) || trimmed(item.displayName) || String(item.id);
        /* 连接器已改成「会话常驻」语义：不论从列表页的 +、列表页的气泡，
           还是输入框选择器里选，统一走 connectConnector（/attach → dock 图标 chip）。
           只有技能才保留一次性引用 chip。 */
        if (refType === "connector") {
          connectConnector(item);
          return;
        }
        /* 技能必须已安装且处于开启态才允许引用：未安装先装，关闭了先去开启。 */
        if (refType === "skill") {
          const row = installedRowOf(item);
          if (row === null) {
            setToast("「" + label + "」还没安装：先点卡片上的 + 安装到本地技能库");
            return;
          }
          if (row.enabled === false) {
            setToast("「" + label + "」已关闭：到「已安装」里开启后再引用");
            return;
          }
        }
        const sid = resolveSessionId(null);
        if (sid === "") {
          setToast("未找到当前会话：请先在对话里打开一个会话，再点「引用」");
          return;
        }
        if (typeof pickerInsertRef !== "function") {
          setToast("引用通道未就绪（宿主 conversation 服务未注入），请重启 dsh web 后重试");
          return;
        }
        /* 仓库技能有 id（相对路径）；SkillHub 商店条目只有 slug，而后端 /detail
           的 resolveInstalledSkill() 支持按 slug 回退到已安装技能，所以这里按优先级
           取一个真正可解析的 refId，避免出现 "skill:undefined"。 */
        const refId = String(item.id || item.slug || label);
        const inserted = pickerInsertRef(sid, refType, refId, label);
        /* 只有插入成功才切回对话视图：宿主默认停在侧栏技能面板，插完 chip 若不
           显式跳转，用户在当前界面根本看不到刚插入的引用。
           两个动作彼此独立：会话切换缺失/失败不能阻断视图跳转（此前
           sessions.open 抛错就把 layout.selectPanel(null) 一起带崩了）。 */
        if (inserted === true) {
          openSessionSafe(sid);
          showConversationSafe();
        }
        setToast(inserted
          ? "已插入引用：「" + label + "」，发送消息时生效"
          : "插入失败：" + (lastInsertError !== "" ? lastInsertError : "编辑器未接受该引用"));
      }

      /**
       * 触发资源仓库同步。
       * @returns {void}
       */
      function doRefresh() {
        fetch(API + "/refresh", { method: "POST" })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.busy === true) {
              setStatus(res);
              setToast(res.started === true ? "已开始同步资源仓库" : "同步正在进行中");
            } else {
              setToast((res && (res.error || res.message)) || "同步失败");
            }
          })
          .catch((error) => setToast("同步失败：" + String((error && error.message) || error)));
      }

      /**
       * 把字节数格式化成人类可读大小。
       * @param {number} bytes 字节数
       * @returns {string} 如 "5.2MB" / "318KB"
       */
      function humanSize(bytes) {
        if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + "MB";
        if (bytes >= 1024) return Math.round(bytes / 1024) + "KB";
        return String(bytes) + "B";
      }

      /**
       * 整包导出：下载 gzip 附件，完成后 toast 报大小。
       * @returns {void}
       */
      function doExport() {
        if (transferring !== "") return;
        setTransferring("export");
        fetch(API + "/export")
          .then((resp) => {
            if (!resp.ok) throw new Error("导出失败（HTTP " + String(resp.status) + "）");
            return resp.blob();
          })
          .then((blob) => {
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "dsh-buddy-expert-hub-export.json.gz";
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            setToast("导出完成（" + humanSize(blob.size) + "）");
          })
          .catch((error) => setToast(String((error && error.message) || error)))
          .finally(() => setTransferring(""));
      }

      /**
       * 单条目导出：专家 / 专家团 / 技能各自打包成一个 .json.gz。
       *
       * 走 `<a download>` 直连后端，避免把几十 MB 内容读进内存再转 blob；
       * 下载失败（无宿主 DOM）时降级为提示。
       *
       * @param {'expert'|'team'|'skill'} type 条目类型
       * @param {string} id 条目 id
       * @returns {void}
       */
      function exportItem(type, id) {
        const itemId = trimmed(id);
        if (itemId === "") {
          setToast("条目 id 缺失，无法导出");
          return;
        }
        const url = API + "/export/item?type=" + encodeURIComponent(type) + "&id=" + encodeURIComponent(itemId);
        try {
          const link = document.createElement("a");
          link.href = url;
          link.rel = "noopener";
          if (typeof link.download === "string") link.download = "";
          document.body.appendChild(link);
          if (typeof link.click === "function") link.click();
          link.remove();
          setToast("已开始下载：单个" + (type === "skill" ? "技能" : type === "team" ? "专家团" : "专家") + "导出文件");
        } catch (error) {
          setToast("导出失败：" + String((error && error.message) || error));
        }
      }

      /**
       * 单条目导入：上传一个条目包，只新增这一个条目（不替换数据源）。
       * @param {File} file 用户选中的文件
       * @returns {void}
       */
      function doImportItem(file) {
        if (transferring !== "") return;
        setTransferring("import");
        fetch(API + "/import/item", { method: "POST", body: file })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              const label = trimmed(res.name) !== "" ? res.name : res.id;
              setToast("已导入" + (res.type === "skill" ? "技能" : res.type === "team" ? "专家团" : "专家") +
                "「" + String(label) + "」" +
                (res.type === "skill" ? "，现在可在「已安装」里查看和引用"
                  : (res.restartRequired === true ? "，重启 dsh web 后生效" : "")));
              loadStatus();
              setNonce((value) => value + 1);
            } else {
              setToast("导入失败：" + String((res && (res.error || res.message)) || "未知错误"));
            }
          })
          .catch((error) => setToast("导入失败：" + String((error && error.message) || error)))
          .finally(() => setTransferring(""));
      }

      /**
       * 整包导入：上传选中的文件字节，成功后刷新面板。
       * @param {File} file 用户选中的文件
       * @returns {void}
       */
      function doImportBundle(file) {
        if (transferring !== "") return;
        setTransferring("import");
        fetch(API + "/library/import", { method: "POST", body: file })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              const c = res.counts || {};
              setToast("导入成功：" + String(c.experts || 0) + " 位专家 · " + String(c.teams || 0) + " 个专家团 · " +
                String(c.skills || 0) + " 个技能 · " + String(c.connectors || 0) + " 个连接器");
              loadStatus();
              setNonce((value) => value + 1);
            } else {
              setToast((res && (res.error || res.message)) || "导入失败");
            }
          })
          .catch((error) => setToast("导入失败：" + String((error && error.message) || error)))
          .finally(() => setTransferring(""));
      }

      /**
       * 切回原数据源。
       * @returns {void}
       */
      function doLibraryReset() {
        if (transferring !== "") return;
        setTransferring("reset");
        fetch(API + "/library/reset", { method: "POST" })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setToast("已切回原数据源");
              loadStatus();
              setNonce((value) => value + 1);
            } else {
              setToast((res && (res.error || res.message)) || "切回失败");
            }
          })
          .catch((error) => setToast("切回失败：" + String((error && error.message) || error)))
          .finally(() => setTransferring(""));
      }

      const libraryMode = status !== null && status.library !== null && status.library !== undefined;

      const counts = status === null || status.counts === undefined
        ? { experts: 0, teams: 0, skills: 0, connectors: 0 }
        : status.counts;

      const subtitle =
        String(counts.experts) + " 位专家 · " +
        String(counts.teams) + " 个专家团 · " +
        String(counts.skills) + " 个技能 · " +
        String(counts.connectors) + " 个连接器";

      const activeTab = TABS.find((item) => item.id === tab) || TABS[0];

      /**
       * 渲染同步引导页。
       * @returns {any} React 元素
       */
      function renderSyncGate() {
        const busyNow = status !== null && status.busy === true;
        const progress = status !== null && typeof status.progress === "string" && status.progress !== ""
          ? status.progress
          : "正在同步…";
        return h("div", { className: "dshe-gate" },
          h("div", { className: "dshe-gate-title" }, "首次使用需同步资源仓库（约 30MB）"),
          h("div", { className: "dshe-gate-desc" },
            busyNow
              ? progress
              : "专家、专家团与技能来自 gitee.com/zhangzexu/dsh-buddy-expert-hub-resource，同步一次后即可离线浏览。"
          ),
          status !== null && status.lastError !== null && status.lastError !== undefined
            ? h("div", { className: "dshe-gate-err" }, "上次同步失败：" + status.lastError)
            : null,
          h("button", {
            type: "button",
            className: "dshe-btn dshe-btn-primary",
            disabled: busyNow,
            onClick: doRefresh
          }, busyNow
            ? [h("span", { key: "spin", className: "dshe-spin" }), "同步中…"]
            : "立即同步")
        );
      }

      /**
       * 渲染分页尾部（加载更多 / 已加载全部）。
       * @param {any} list 分页数据
       * @param {string} noun 名词，用于「已加载全部 N 个 X」
       * @param {string} [key] 放进数组子节点时使用的 key
       * @returns {any} React 元素
       */
      function renderMore(list, noun, key) {
        const remaining = list.total - list.items.length;
        return h("div", { key: key === undefined ? "more" : key, className: "dshe-more" },
          remaining > 0
            ? h("button", {
                type: "button",
                className: "dshe-more-btn",
                disabled: loadingMore,
                onClick: loadMore
              }, loadingMore ? "加载中…" : "加载更多（" + String(list.items.length) + " / " + String(list.total) + "）")
            : h("span", { className: "dshe-more-note" }, "已加载全部 " + String(list.total) + " 个" + noun)
        );
      }

      /**
       * 渲染技能列表：WorkBuddy 式 5 列卡片网格（无分组头，集合进卡片底部元信息）。
       * 搜索 / 分页 / 空状态行为不变，只换渲染形态。
       * @param {any} list 技能分页数据
       * @returns {any} React 元素
       */
      function renderSkills(list) {
        return h("div", null,
          h("div", { className: "dshe-skill-grid" },
            list.items.map((item) => {
              const row = installedRowOf(item);
              return h(SkillCard, {
                key: item.id,
                item,
                installed: row !== null,
                enabled: row !== null ? row.enabled : false,
                onOpen: (target) => openDetail(target, "skill"),
                onCopy: doCopy,
                onInstall: installRepoSkill,
                onApply: (target) => applyToConversation(target, "skill")
              });
            })
          ),
          renderMore(list, "技能")
        );
      }

      /**
       * 渲染「技能数据尚未同步」引导。
       * @returns {any} React 元素
       */
      function renderSkillsMissing() {
        const busyNow = status !== null && status.busy === true;
        const progress = status !== null && typeof status.progress === "string" && status.progress !== ""
          ? status.progress
          : "正在同步…";
        return h("div", { className: "dshe-gate" },
          h("div", { className: "dshe-gate-title" }, "技能数据尚未同步"),
          h("div", { className: "dshe-gate-desc" },
            busyNow
              ? progress
              : "技能来自 ntd-resource 仓库的 skills/ 目录，需要克隆一次（约 30MB）。专家与专家团数据不受影响，可以继续浏览。"
          ),
          status !== null && status.lastError !== null && status.lastError !== undefined
            ? h("div", { className: "dshe-gate-err" }, "上次同步失败：" + status.lastError)
            : null,
          h("button", {
            type: "button",
            className: "dshe-btn dshe-btn-primary",
            disabled: busyNow || libraryMode,
            title: libraryMode ? "当前为本地资料库，切回原数据源后可同步" : undefined,
            onClick: doRefresh
          }, busyNow
            ? [h("span", { key: "spin", className: "dshe-spin" }), "同步中…"]
            : libraryMode ? "当前为本地资料库" : "立即同步")
        );
      }

      /**
       * 渲染内容区。
       * @returns {any} React 元素
       */
      function renderBody() {
        if (status === null) {
          if (statusError !== null) {
            return h(ErrorBar, { message: "无法连接插件后端：" + statusError, onRetry: loadStatus });
          }
          return h(Skeleton);
        }
        /* SkillHub 商店与仓库数据互不依赖：仓库没同步时也能逛商店，放在同步门禁之前。 */
        if (tab === "skills" && skillSource === "skillhub") {
          return h(SkillHubStore, {
            onToast: setToast,
            installedSkills,
            onApply: (target) => applyToConversation(target, "skill")
          });
        }
        /* 已安装技能库同理：不依赖仓库索引，随时可看可开关。 */
        if (tab === "skills" && skillSource === "installed") {
          return h(InstalledSkills, {
            items: installedSkills,
            onToggle: toggleInstalledSkill
          });
        }
        if (status.indexReady !== true) return renderSyncGate();
        if (tab === "skills" && skillsMissing) return renderSkillsMissing();

        const list = data[tab];
        if (errors[tab] !== undefined && list === null) {
          return h(ErrorBar, { message: errors[tab], onRetry: () => setNonce((value) => value + 1) });
        }
        if (list === null) return h(Skeleton);
        if (loading === true && list.items.length === 0) return h(Skeleton);
        if (list.items.length === 0) {
          return h("div", { className: "dshe-hint" },
            activeQuery === "" ? "这里还没有数据" : "没有匹配「" + activeQuery + "」的结果");
        }

        if (tab === "skills") return renderSkills(list);

        if (tab === "connectors") {
          return h("div", null,
            h("div", { className: "dshe-conn-grid" },
              list.items.map((item) => h(ConnectorCard, {
                key: item.id,
                item,
                connected: connectedConnectors.indexOf(String(item.id)) >= 0,
                onOpen: (target) => openDetail(target, "connector"),
                onCopy: doCopy,
                onConnect: connectConnector,
                onApply: (target) => applyToConversation(target, "connector")
              }))
            ),
            renderMore(list, "连接器")
          );
        }

        return h("div", { className: "dshe-grid" },
          list.items.map((item) => h(ExpertCard, {
            key: item.id,
            item,
            imported: importedIds.indexOf(item.id) >= 0,
            onOpen: (target) => openDetail(target, "expert"),
            onSummon: (target) => summonExpert(target, {
              onToast: setToast,
              onClose: () => {},
              ensureImported: ensureImported,
              onFallbackCopy: () => doCopy(summonText(target), "召唤语已复制，粘贴到对话即可")
            })
          }))
        );
      }

      return h("div", { className: "dshe-root" },
        h("div", { className: "dshe-head" },
          h("div", { className: "dshe-head-main" },
            h("h1", { className: "dshe-title" }, "专家·技能·连接器"),
            h("p", { className: "dshe-sub" }, subtitle)
          ),
          h("div", { className: "dshe-head-actions" },
            /* SkillHub 商店自带搜索框（检索的是远端商店），顶部这个只作用于仓库数据，故隐藏。 */
            tab === "skills" && skillSource === "skillhub"
              ? null
              : h("input", {
                  className: "dshe-search",
                  type: "search",
                  value: inputs[tab],
                  placeholder: activeTab.placeholder,
                  onChange: (event) => {
                    const value = event.target.value;
                    setInputs((prev) => Object.assign({}, prev, { [tab]: value }));
                  }
                }),
            h("button", {
              type: "button",
              className: "dshe-btn",
              disabled: transferring !== "",
              onClick: () => {
                if (importFileRef.current !== null) {
                  importFileRef.current.value = "";
                  importFileRef.current.click();
                }
              },
              title: "导入单个专家 / 专家团 / 技能包（在条目详情里用「导出」生成），只新增这一个条目"
            }, transferring === "import"
              ? [h("span", { key: "spin", className: "dshe-spin" }), "导入中…"]
              : "导入条目"),
            h("input", {
              key: "import-file",
              ref: importFileRef,
              type: "file",
              accept: ".json.gz,.gz,.json",
              style: { display: "none" },
              onChange: (event) => {
                const file = event.target.files && event.target.files[0];
                if (file !== null && file !== undefined) doImportItem(file);
              }
            }),
            h("button", {
              type: "button",
              className: "dshe-btn",
              disabled: transferring !== "" || (status !== null && status.busy === true),
              title: libraryMode ? "当前为本地资料库，切回原数据源后可同步" : undefined,
              onClick: () => {
                if (libraryMode) {
                  setToast("当前为本地资料库，切回原数据源后可同步");
                  return;
                }
                doRefresh();
              }
            }, status !== null && status.busy === true
              ? [h("span", { key: "spin", className: "dshe-spin" }), "同步中…"]
              : "刷新"),
            h("button", {
              type: "button",
              className: "dshe-btn dshe-settings-btn",
              "aria-label": "设置",
              title: "配置数据源 git 仓库地址",
              onClick: () => setSettingsOpen(true)
            }, h(Icon, { name: "sliders", size: 15 }))
          )
        ),
        libraryMode
          ? h("div", { className: "dshe-source" },
              h("span", null, "数据来源：本地资料库（导入于 " + String(status.library.importedAt || "").replace("T", " ").slice(0, 16) + "）"),
              h("button", {
                type: "button",
                className: "dshe-source-reset",
                disabled: transferring !== "",
                onClick: doLibraryReset
              }, transferring === "reset" ? "切回中…" : "切回原数据源")
            )
          : null,
        /* 三大块分栏：专家（内含专家 / 专家团）、技能、连接器。
           每块用用户提供的原生 SVG 图标，专家块计数为两类之和。 */
        h("div", { className: "dshe-tabs", role: "tablist", "aria-label": "资源分类" },
          GROUPS.map((group) => h("button", {
            key: group.id,
            type: "button",
            className: "dshe-tab" + (groupOfTab(tab) === group.id ? " dshe-tab-on" : ""),
            role: "tab",
            "aria-selected": groupOfTab(tab) === group.id,
            onClick: () => setTab(group.children[0])
          },
            h(CategoryIcon, { name: group.icon, size: 15 }),
            group.label,
            h("span", { className: "dshe-tab-badge" }, String(groupCount(group.id, counts)))
          ))
        ),
        /* 专家块内的二级子分组：专家 / 专家团，各自带计数徽章。 */
        groupOfTab(tab) === "expert"
          ? h("div", { className: "dshe-subtabs", role: "tablist", "aria-label": "专家类型" },
              TABS.filter((entry) => groupOfTab(entry.id) === "expert").map((entry) => h("button", {
                key: entry.id,
                type: "button",
                className: "dshe-subtab" + (tab === entry.id ? " dshe-subtab-on" : ""),
                role: "tab",
                "aria-selected": tab === entry.id,
                onClick: () => setTab(entry.id)
              },
                entry.label,
                h("span", { className: "dshe-subtab-badge" }, String(counts[entry.countKey] || 0))
              ))
            )
          : null,
        /* 技能块的二级子分组：仓库技能 / SkillHub 商店。 */
        groupOfTab(tab) === "skill"
          ? h("div", { className: "dshe-subtabs", role: "tablist", "aria-label": "技能来源" },
              h("button", {
                type: "button",
                className: "dshe-subtab" + (skillSource === "repo" ? " dshe-subtab-on" : ""),
                role: "tab",
                "aria-selected": skillSource === "repo",
                onClick: () => setSkillSource("repo")
              },
                "仓库技能",
                h("span", { className: "dshe-subtab-badge" }, String(counts.skills || 0))
              ),
              h("button", {
                type: "button",
                className: "dshe-subtab" + (skillSource === "skillhub" ? " dshe-subtab-on" : ""),
                role: "tab",
                "aria-selected": skillSource === "skillhub",
                title: "从 SkillHub 技能商店浏览并安装（地址可在设置里改成内网源）",
                onClick: () => setSkillSource("skillhub")
              },
                "SkillHub 商店"
              ),
              h("button", {
                type: "button",
                className: "dshe-subtab" + (skillSource === "installed" ? " dshe-subtab-on" : ""),
                role: "tab",
                "aria-selected": skillSource === "installed",
                title: "查看已安装到本机的技能，可开启 / 关闭",
                onClick: () => setSkillSource("installed")
              },
                "已安装",
                h("span", { className: "dshe-subtab-badge" }, String(installedSkills.length))
              )
            )
          : null,
        h("div", { className: "dshe-body", onScroll: onBodyScroll }, renderBody()),
        detail !== null
          ? h(DetailDrawer, {
              state: detail,
              importedIds,
              onClose: closeDetail,
              onImport: doImport,
              onCopy: doCopy,
              onExportItem: exportItem,
              onSkillFetch: (ref) => {
                if (detail !== null && detail.item !== null && detail.item !== undefined) {
                  doSkillFetch(detail.item.id, ref);
                }
              },
              onSummon: (item) => summonExpert(item, {
                onToast: setToast,
                onClose: closeDetail,
                ensureImported: ensureImported,
                /* bridge 未就绪（宿主缺 sessions 服务）时降级回复制召唤语 */
                onFallbackCopy: () => doCopy(summonText(item), "召唤语已复制，粘贴到对话即可")
              })
            })
          : null,
        settingsOpen
          ? h(SettingsDialog, { libraryMode, onClose: () => setSettingsOpen(false), onToast: setToast })
          : null,
        toast !== null ? h("div", { className: "dshe-toast" }, toast) : null
      );
    }

    // =======================================================================
    // 会话 id 归一化（dock / onPick / serialize 共用）
    // =======================================================================

    /** dock 快照形态诊断告警只发一次，避免轮询刷屏。 */
    var dockWarned = false;

    /**
     * 归一化取当前会话 id：优先调用方已知的 sessionId，回落 sessions 快照。
     * 快照的 current 在不同宿主版本可能是字符串也可能是 {id} 对象（QA 实测
     * dock 不渲染的疑点之一），两种形态都归一化。
     * @param {{ sessionId?: unknown }|null} [session] 宿主投影（可为 null）
     * @returns {string} 会话 id；取不到返回空串
     */
    function resolveSessionId(session) {
      if (session !== null && session !== undefined) {
        const direct = session.sessionId;
        if (typeof direct === "string" && direct !== "") return direct;
      }
      try {
        const snap = sessions.list.getSnapshot();
        if (snap !== null && snap !== undefined) {
          const cur = snap.current;
          if (typeof cur === "string" && cur !== "") { lastComposerSessionId = cur; return cur; }
          if (cur !== null && cur !== undefined && typeof cur === "object" && typeof cur.id === "string" && cur.id !== "") {
            lastComposerSessionId = cur.id;
            return cur.id;
          }
        }
      } catch { /* 快照不可用 */ }
      /* 侧栏面板（main 槽）拿不到会话注入，且部分宿主版本里快照 current 恒为空。
         composer 的 dock 槽组件能拿到注入的 sessionId，并且只要对话打开着它就会渲染
         （没有常驻专家时组件 return null，但函数体照常执行），因此拿它兜底最贴近
         「用户正在看的那条会话」。 */
      if (lastComposerSessionId !== "") return lastComposerSessionId;
      if (dockWarned === false) {
        dockWarned = true;
        try {
          console.warn("[dsh-buddy-expert-hub] 无法确定当前会话 id（快照 current 为空且 composer 槽未上报），引用/常驻相关功能暂不可用");
        } catch { /* 忽略 */ }
      }
      return "";
    }

    /** composer 槽（conversation.input.left）上报的当前会话 id，供侧栏面板兜底。 */
    var lastComposerSessionId = "";

    // =======================================================================
    // 召唤（开新会话并常驻）
    // =======================================================================

    /** 宿主服务：applyComposer 用 ctx.get 提升为模块层引用，供 resolveSessionId
        的会话快照兜底与 applyToConversation 的 sessions.open 兜底使用。
        必须是模块层变量——局部 const 会让这两处在运行时 ReferenceError。 */
    var sessions = null;
    var conversation = null;
    var inputTriggers = null;
    /** 宿主布局服务：selectPanel(null) 把主视图从侧栏面板切回当前 Conversation。 */
    var layout = null;

    /**
     * 从宿主 ctx 取服务，优先选带指定方法的那个 face。
     *
     * 宿主用 `ctx.reflect.provide(name, service)` 注册服务，而
     * `ctx.reflect.get(name)` 的契约是「without the inject requirement」——
     * 它往往能拿到完整实现；`ctx.get(name)` 在插件世界有时只给裁剪版
     * （实测 sessions 只有 list/scope、没有 open，layout 直接拿不到）。
     * 两条路都试，按关键方法挑更完整的那个，都不可用则退回 ctx.get 的结果。
     *
     * @param {any} ctx 宿主上下文
     * @param {string} name 服务名
     * @param {string} requiredMethod 期望存在的方法名
     * @returns {any} 服务对象或 null
     */
    function pickHostService(ctx, name, requiredMethod) {
      let viaGet = null;
      let viaReflect = null;
      try {
        if (ctx !== null && ctx !== undefined && typeof ctx.get === "function") viaGet = ctx.get(name);
      } catch { /* 服务未声明 */ }
      try {
        const reflect = ctx !== null && ctx !== undefined ? ctx.reflect : null;
        if (reflect !== null && reflect !== undefined && typeof reflect.get === "function") {
          viaReflect = reflect.get(name);
        }
      } catch { /* 忽略 */ }
      const hasMethod = (v) => v !== null && v !== undefined && typeof v[requiredMethod] === "function";
      if (hasMethod(viaGet)) return viaGet;
      if (hasMethod(viaReflect)) return viaReflect;
      return viaGet || viaReflect || null;
    }

    /**
     * 切换当前会话（防御式）。
     *
     * 实测某些宿主版本 `ctx.get("sessions")` 给的是会话列表 store（有 list/scope，
     * 但没有 open/create），直接调 `sessions.open(id)` 会抛
     * "sessions.open is not a function"，把同一 try 块里的视图切换一起带崩。
     * 因此这里只做能力探测：缺失或抛错都只留痕，绝不向调用方抛异常。
     *
     * @param {string} sid 会话 id
     * @returns {boolean} 是否成功发起切换
     */
    function openSessionSafe(sid) {
      try {
        if (sessions !== null && sessions !== undefined) {
          if (typeof sessions.open === "function") return sessions.open(sid) !== false;
          /* 裁剪版 face 可能把 manager 露出来：服务类的 open(id) 内部就是
             manager.select(id)。逐级尝试，尽量保住「召唤开新会话」的语义。 */
          const manager = sessions.manager;
          if (manager !== null && manager !== undefined && typeof manager.select === "function") {
            manager.select(sid);
            return true;
          }
          if (typeof sessions.select === "function") {
            sessions.select(sid);
            return true;
          }
          const list = sessions.list;
          if (list !== null && list !== undefined && typeof list.select === "function") {
            list.select(sid);
            return true;
          }
        }
        try { console.warn("[dsh-buddy-expert-hub] 宿主无可用会话切换能力，跳过（sid=" + String(sid) + "）"); } catch { /* 忽略 */ }
      } catch (error) {
        try { console.warn("[dsh-buddy-expert-hub] 会话切换失败：" + String((error && error.message) || error)); } catch { /* 忽略 */ }
      }
      return false;
    }

    /**
     * 宿主是否具备「选中某个会话」的能力。召唤流程据此决定是开新会话，
     * 还是降级把专家挂到当前会话（否则新会话永远打不开，专家就消失了）。
     * @returns {boolean} 是否可切换
     */
    function canSwitchSession() {
      if (sessions === null || sessions === undefined) return false;
      if (typeof sessions.open === "function" || typeof sessions.select === "function") return true;
      const manager = sessions.manager;
      if (manager !== null && manager !== undefined && typeof manager.select === "function") return true;
      const list = sessions.list;
      return list !== null && list !== undefined && typeof list.select === "function";
    }

    /**
     * 把主视图切回当前 Conversation（防御式）。
     *
     * ILayout 契约：`selectPanel(null)` = 显示当前 Conversation。必须独立于
     * `openSessionSafe()` 执行 —— 两者放同一个 try 时，会话切换失败会连累跳转。
     *
     * @returns {boolean} 是否成功发起跳转
     */
    function showConversationSafe() {
      try {
        if (layout !== null && layout !== undefined && typeof layout.selectPanel === "function") {
          layout.selectPanel(null);
          return true;
        }
        try { console.warn("[dsh-buddy-expert-hub] ctx.layout 不可用：无法自动切回对话视图"); } catch { /* 忽略 */ }
      } catch (error) {
        try { console.warn("[dsh-buddy-expert-hub] layout.selectPanel(null) 失败：" + String((error && error.message) || error)); } catch { /* 忽略 */ }
      }
      return false;
    }

    /** sessions 服务桥：applyComposer 的 inject 闭包里捕获，供 Panel 侧召唤使用。 */
    var summonBridge = null;

    /**
     * 召唤专家/团队：先确保已导入（未导入则静默自动导入），再
     * create → open → attach 到新会话。宿主 sessions 契约见
     * dsh-api-session-controller/client/contract/sessions.d.ts。
     * @param {any} item 专家/团队条目
     * @param {{ onToast: Function, onClose: Function, ensureImported?: Function, onFallbackCopy?: Function }} hooks UI 回调
     * @returns {void}
     */
    function summonExpert(item, hooks) {
      const finish = () => startSummon(item, hooks);
      /* 卡片与详情页共用：没导入的，召唤时默认静默导入。
         bridge 未就绪时也要先导入（降级复制召唤语前资源应已落盘）。 */
      let ready;
      if (typeof hooks.ensureImported === "function") {
        try { ready = Promise.resolve(hooks.ensureImported(item)); }
        catch (error) { ready = Promise.reject(error); }
      } else {
        ready = Promise.resolve(true);
      }
      ready.then(finish).catch((error) => {
        hooks.onToast("自动导入失败：" + String((error && error.message) || error));
      });
    }

    /**
     * 召唤的实际执行体（导入已完成）。
     * @param {any} item 专家/团队条目
     * @param {{ onToast: Function, onClose: Function, onFallbackCopy?: Function }} hooks UI 回调
     * @returns {void}
     */
    function startSummon(item, hooks) {
      if (summonBridge === null) {
        /* bridge 未就绪（宿主缺 sessions 服务）：降级为复制召唤语 */
        if (typeof hooks.onFallbackCopy === "function") hooks.onFallbackCopy();
        return;
      }
      const name = trimmed(item.displayName || item.name || item.id);
      const type = item.type === "team" ? "team" : "agent";
      const expertId = String(item.id || "");
      if (expertId === "") return;

      const attachTo = (sessionId) => {
        return fetch(API + "/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, type, id: expertId })
        })
          .then((resp) => resp.json())
          .then((res) => {
            /* 用户明确要求不显示「已常驻」类提示；失败仍给出可读错误。 */
            if (res === null || res === undefined || res.ok !== true) {
              hooks.onToast((res && (res.error || res.message)) || "常驻失败");
              return false;
            }
            hooks.onClose();
            return true;
          })
          .catch((error) => {
            hooks.onToast("常驻失败：" + String((error && error.message) || error));
            return false;
          });
      };

      /* 宿主没有选中会话的能力时，create() 出来的新会话永远不会被打开，
         专家挂上去用户根本看不到（用户反馈「专家跳转，没有出现专家」）。
         降级为直接挂到当前会话：dock 里立刻出现 chip，语义从「开新会话」
         变成「挂到本会话」，并明确告知用户原因。 */
      if (canSwitchSession() === false) {
        const currentSid = resolveSessionId(null);
        if (currentSid === "") {
          hooks.onToast("未找到当前会话：请先在对话里打开一个会话");
          return;
        }
        attachTo(currentSid).then((ok) => {
          if (ok !== true) return;
          try { window.dispatchEvent(new CustomEvent("dsh-buddy-expert-hub:attachments-changed")); } catch { /* 忽略 */ }
          showConversationSafe();
          hooks.onToast("已把「" + name + "」挂到当前会话（宿主不支持自动打开新会话）");
        });
        return;
      }

      /**
       * 宿主 create() 返回 Promise<SessionId>（client facade 契约
       * `sessions.d.ts:28-38`）；open(id) → manager.select(id) 切换当前会话。
       * 兼容部分版本把 id 包在 {value:{sessionId}} / {sessionId} 里的形态。
       * @param {any} result create 返回值
       * @returns {string} 会话 id，解析失败为空串
       */
      const createdId = (result) => {
        if (typeof result === "string" && result !== "") return result;
        if (result !== null && typeof result === "object") {
          if (result.ok === false) return "";
          const value = result.value;
          if (value !== null && typeof value === "object" && typeof value.sessionId === "string") return value.sessionId;
          if (typeof result.sessionId === "string") return result.sessionId;
        }
        return "";
      };

      let created;
      try {
        created = summonBridge.create();
      } catch (error) {
        hooks.onToast("无法创建会话：" + String((error && error.message) || error));
        return;
      }
      Promise.resolve(created).then((result) => {
        const newSid = createdId(result);
        if (newSid === "") {
          hooks.onToast("创建会话失败");
          return;
        }
        /* 先切换会话再挂载：open 为可选能力，缺失时 openSessionSafe 只留痕；
           再用 layout 把主视图切回对话，让用户看到新会话（两个动作互不牵连）。 */
        const switched = summonBridge.open(newSid);
        showConversationSafe();
        /* 运行时切换仍失败（例如 manager.select 抛错）：别把专家挂到打不开的
           新会话上，回退挂到当前会话，保证 dock 里能看见。 */
        if (switched === false) {
          const fallbackSid = resolveSessionId(null);
          if (fallbackSid !== "" && fallbackSid !== newSid) {
            attachTo(fallbackSid).then((ok) => {
              if (ok !== true) return;
              try { window.dispatchEvent(new CustomEvent("dsh-buddy-expert-hub:attachments-changed")); } catch { /* 忽略 */ }
              hooks.onToast("新会话切换失败，已把「" + name + "」挂到当前会话");
            });
            return;
          }
        }
        attachTo(newSid);
      }).catch((error) => {
        hooks.onToast("创建会话失败：" + String((error && error.message) || error));
      });
    }

    // =======================================================================
    // 紧凑专家选择器（conversation.input.overlay 槽，自绘浮层）
    // =======================================================================

    /** 打开面板的桥：ComposerButton 与 overlay 槽组件解耦（组件挂载时注册）。 */
    var pickerOpenSetter = null;
    var pickerWarned = false;
    var dockMultiWarned = false;
    /** 会话通知桥：applyComposer 里挂上 notifySession，供模块层组件提示用。 */
    var expertNotify = null;
    /** 草稿引用插入桥：二级菜单选技能/连接器时插入结构化 chip（不插文本提示词）。 */
    var pickerInsertRef = null;

    /** 最近一次插入引用失败的原因（供 toast 透出）。 */
    var lastInsertError = "";

    /**
     * 请求打开专家选择面板。
     * @returns {void}
     */
    function openExpertPicker() {
      if (typeof pickerOpenSetter === "function") {
        pickerOpenSetter((prev) => {
          /* 每次点击都从一级分类开始；已打开时再点则关闭（toggle 直觉）。 */
          return prev === true ? false : true;
        });
      } else if (pickerWarned === false) {
        pickerWarned = true;
        try { console.warn("[dsh-buddy-expert-hub] 专家选择器 overlay 槽尚未挂载，无法打开面板"); } catch { /* 忽略 */ }
      }
    }

    /**
     * 自绘紧凑选择面板：对齐参考图右侧子面板（270px / 搜索框 / 单行无描述 /
     * 选中浅绿底 + ✓ / 底部召唤更多专家）。宿主大表格菜单不再用于专家选择。
     * @param {{ sessionId?: string }} props 槽位注入 props
     * @returns {any} React 元素
     */
    /**
     * SkillHub 技能详情抽屉。
     *
     * 数据来自 `GET /skillhub/detail?slug=`（后端代理官方 `/api/v1/skills/{slug}`），
     * 比列表多出 stats / subCategories / overviewMd / sourceUrl。
     *
     * @param {{ slug: string, name?: string, installed: boolean, onClose: Function, onToast: Function, onInstalled: Function }} props 属性
     * @returns {any} React 元素
     */
    function SkillHubDetail(props) {
      const [state, setState] = useState({ kind: "loading" });
      const [installing, setInstalling] = useState(false);

      useEffect(() => {
        const controller = new AbortController();
        fetch(API + "/skillhub/detail?slug=" + encodeURIComponent(props.slug), {
          headers: { Accept: "application/json" },
          signal: controller.signal
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) setState({ kind: "ok", data: res });
            else setState({ kind: "error", message: (res && (res.error || res.message)) || "详情加载失败" });
          })
          .catch((error) => {
            if (error !== null && error !== undefined && error.name === "AbortError") return;
            setState({ kind: "error", message: "详情加载失败：" + String((error && error.message) || error) });
          });
        return () => controller.abort();
      }, [props.slug]);

      /* Esc 关闭 */
      useEffect(() => {
        const onKeyDown = (event) => { if (event.key === "Escape") props.onClose(); };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
      }, [props.onClose]);

      function doInstall(slug) {
        if (installing) return;
        setInstalling(true);
        fetch(API + "/skillhub/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug })
        })
          .then((resp) => resp.json())
          .then((res) => {
            setInstalling(false);
            if (res !== null && res !== undefined && res.ok === true) {
              props.onInstalled(slug);
              /* 通知主面板立即重拉 /skills/installed：切到「已安装」页无需手动刷新。 */
              notifyInstalledSkillsChanged();
              props.onToast("已获取「" + String(res.name || slug) + "」，已可在「已安装」里查看和引用");
            } else {
              props.onToast("获取失败：" + String((res && (res.error || res.message)) || "未知错误"));
            }
          })
          .catch((error) => {
            setInstalling(false);
            props.onToast("获取失败：" + String((error && error.message) || error));
          });
      }

      let body = null;
      if (state.kind === "loading") {
        body = h("div", { className: "dshe-drawer-state" }, h("span", { className: "dshe-spin" }), "加载中…");
      } else if (state.kind === "error") {
        body = h("div", { className: "dshe-drawer-state dshe-drawer-state-err" }, state.message);
      } else {
        const d = state.data;
        const desc = trimmed(d.summaryZh) !== "" ? d.summaryZh : d.summary;
        const metaBits = [];
        if (trimmed(d.categoryName) !== "") metaBits.push(d.categoryName);
        if (Array.isArray(d.subCategories)) for (const sub of d.subCategories) metaBits.push(sub);
        if (trimmed(d.version) !== "") metaBits.push("v" + d.version);
        if (d.downloads > 0) metaBits.push("↓ " + d.downloads);
        if (d.installs > 0) metaBits.push("安装 " + d.installs);
        const done = props.installed === true || d.installed === true;
        body = h("div", null,
          h("div", { className: "dshe-hub-hero" },
            h("span", { className: "dshe-hub-hero-icon" },
              trimmed(d.iconUrl) !== ""
                ? h("img", { src: d.iconUrl, alt: "" })
                : h(CategoryIcon, { name: "skill", size: 26 })),
            h("div", { className: "dshe-hub-hero-id" },
              h("h2", { className: "dshe-hub-hero-name", title: d.name }, d.name),
              h("div", { className: "dshe-hub-hero-sub" },
                trimmed(d.owner) !== "" ? "@" + d.owner : "",
                trimmed(d.source) !== "" ? " · 来自 " + d.source : ""
              )
            ),
            h("button", {
              type: "button",
              className: "dshe-hub-get dshe-hub-hero-get",
              disabled: done || installing,
              onClick: () => doInstall(props.slug)
            }, done ? "已安装" : (installing ? "获取中…" : "获取"))
          ),
          metaBits.length > 0 ? h("div", { className: "dshe-hub-hero-meta" }, metaBits.join(" · ")) : null,
          h("p", { className: "dshe-hub-hero-desc" }, desc !== "" ? desc : "暂无描述"),
          trimTo(d.overviewMd, 6000) !== ""
            ? h("div", { className: "dshe-hub-section" },
                h("h3", { className: "dshe-hub-section-title" }, "概述"),
                h("pre", { className: "dshe-hub-pre" }, trimTo(d.overviewMd, 6000)))
            : null,
          trimTo(d.changelog, 600) !== ""
            ? h("div", { className: "dshe-hub-section" },
                h("h3", { className: "dshe-hub-section-title" }, "更新说明"),
                h("p", { className: "dshe-hub-hero-desc" }, trimTo(d.changelog, 600)))
            : null,
          trimmed(d.sourceUrl) !== ""
            ? h("p", { className: "dshe-hub-src" },
                "来源页：",
                h("a", { href: d.sourceUrl, target: "_blank", rel: "noreferrer noopener" }, d.sourceUrl))
            : null,
          h("p", { className: "dshe-hub-note" }, "安装目录：$DSH_HOME/skills/，装完即可在「已安装」里查看，并可在对话中引用。")
        );
      }

      return h("div", {
        className: "dshe-mask",
        onClick: (event) => { if (event.target === event.currentTarget) props.onClose(); }
      },
        h("div", {
          className: "dshe-drawer",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": (props.name || props.slug) + " 详情"
        },
          h("button", {
            type: "button",
            className: "dshe-drawer-close",
            "aria-label": "关闭",
            title: "关闭",
            onClick: props.onClose
          }, h(Icon, { name: "close", size: 20 })),
          h("div", { className: "dshe-drawer-body" }, body)
        )
      );
    }

    /**
     * 已安装技能库视图（技能块第三个子分组）。
     *
     * 分组：本地安装（用户自己放的）/ 来自仓库 / 来自 SkillHub。
     * 每张卡右上开关 = 是否让对话加载该技能；关闭后 host 半把目录挪到
     * `skills-disabled/`，插件每次请求实时读目录，挪走即生效（无需重启），文件不会被删。
     *
     * @param {{ items: Array<Record<string, any>>, onToggle: Function }} props 属性
     * @returns {any} React 元素
     */
    function InstalledSkills(props) {
      const [query, setQuery] = useState("");
      const items = Array.isArray(props.items) ? props.items : [];
      const keyword = trimmed(query).toLowerCase();
      const filtered = keyword === ""
        ? items
        : items.filter((it) => (String(it.name || "") + " " + String(it.description || "")).toLowerCase().indexOf(keyword) >= 0);

      const SOURCES = [
        { id: "local", label: "本地安装（用户自定义）" },
        { id: "repo", label: "来自仓库" },
        { id: "market", label: "来自 SkillHub" },
      ];
      const enabledCount = items.filter((it) => it.enabled !== false).length;

      const row = (it) => {
        const color = skillTileColor(trimmed(it.name) || String(it.dir));
        return h("div", { key: it.dir, className: "dshe-inst-card", "data-skill-dir": it.dir },
          h("span", {
            className: "dshe-inst-tile",
            style: { backgroundColor: color.bg, color: color.fg },
            "aria-hidden": "true"
          }, initialOf(trimmed(it.name) || String(it.dir))),
          h("div", { className: "dshe-inst-info" },
            h("div", { className: "dshe-inst-name", title: trimmed(it.name) },
              trimmed(it.name) || String(it.dir),
              it.source === "market" ? h("span", { className: "dshe-inst-tag" }, "市场") : null
            ),
            h("div", { className: "dshe-inst-desc", title: trimmed(it.description) },
              trimmed(it.description) !== "" ? it.description : "暂无描述")
          ),
          h("button", {
            type: "button",
            className: "dshe-switch" + (it.enabled !== false ? " dshe-switch-on" : ""),
            role: "switch",
            "aria-checked": it.enabled !== false,
            title: it.enabled !== false ? "已开启，点击关闭（关闭后对话不再加载）" : "已关闭，点击开启",
            "aria-label": (it.enabled !== false ? "关闭 " : "开启 ") + (trimmed(it.name) || it.dir),
            onClick: () => props.onToggle(it, it.enabled === false)
          }, h("span", { className: "dshe-switch-dot" }))
        );
      };

      const sections = SOURCES
        .map((source) => ({ id: source.id, label: source.label, rows: filtered.filter((it) => (it.source || "local") === source.id) }))
        .filter((section) => section.rows.length > 0);

      return h("div", null,
        h("div", { className: "dshe-hub-bar" },
          h("input", {
            className: "dshe-hub-search",
            type: "search",
            value: query,
            placeholder: "搜索已安装的技能",
            onChange: (event) => setQuery(event.target.value)
          }),
          h("span", { className: "dshe-hub-meta" }, "共 " + String(items.length) + " 个 · 已开启 " + String(enabledCount))
        ),
        items.length === 0
          ? h("div", { className: "dshe-hub-state" }, "还没有安装任何技能：去「仓库技能」或「SkillHub 商店」点 + 安装")
          : sections.length === 0
            ? h("div", { className: "dshe-hub-state" }, "没有匹配「" + query + "」的技能")
            : sections.map((section) => h("div", { key: section.id, className: "dshe-inst-group" },
                h("h3", { className: "dshe-inst-group-title" }, section.label + " (" + String(section.rows.length) + ")"),
                h("div", { className: "dshe-inst-grid" }, section.rows.map(row))
              ))
      );
    }

    /**
     * SkillHub 商店视图（技能块下的第二个子分组）。
     *
     * 协议见 host 半 `index.js` 的 SkillHub 段落：分类 / 检索 / 榜单 / 下载安装
     * 全部由后端代发（避免浏览器跨域，也让内网地址只需在设置里配一次）。
     * 安装落盘到 `$DSH_HOME/skills/`，插件每次请求实时扫描，装完即可用（无需重启）。
     *
     * @param {{ onToast: Function }} props 组件属性
     * @returns {any} React 元素
     */
    function SkillHubStore(props) {
      const [query, setQuery] = useState("");
      const [category, setCategory] = useState("");
      const [categories, setCategories] = useState([]);
      const [items, setItems] = useState([]);
      const [installed, setInstalled] = useState([]);
      const [base, setBase] = useState("");
      const [loading, setLoading] = useState(true);
      const [errorText, setErrorText] = useState("");
      const [installing, setInstalling] = useState("");
      const [detail, setDetail] = useState(null);
      const toast = typeof props.onToast === "function" ? props.onToast : () => {};

      /* 已安装清单：进面板拉一次，安装成功后本地追加，避免额外往返。 */
      useEffect(() => {
        fetch(API + "/skillhub/installed", { headers: { Accept: "application/json" } })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && Array.isArray(res.slugs)) setInstalled(res.slugs);
          })
          .catch(() => { /* 已安装态拿不到不影响浏览 */ });
      }, []);

      /* 列表加载：无关键词、无分类时看热门榜；否则走检索。300ms 防抖 + 取消旧请求。 */
      useEffect(() => {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          setLoading(true);
          const params = [];
          if (query !== "") params.push("q=" + encodeURIComponent(query));
          if (category !== "") params.push("category=" + encodeURIComponent(category));
          if (query === "" && category === "") params.push("section=hot");
          params.push("limit=36");
          fetch(API + "/skillhub/search?" + params.join("&"), {
            headers: { Accept: "application/json" },
            signal: controller.signal
          })
            .then((resp) => resp.json())
            .then((res) => {
              if (res === null || res === undefined) { setErrorText("SkillHub 无响应"); setLoading(false); return; }
              setBase(typeof res.base === "string" ? res.base : "");
              if (Array.isArray(res.categories)) setCategories(res.categories);
              if (res.ok === true) {
                setItems(Array.isArray(res.items) ? res.items : []);
                setErrorText("");
              } else {
                setItems([]);
                setErrorText(typeof res.error === "string" && res.error !== "" ? res.error : "SkillHub 请求失败");
              }
              setLoading(false);
            })
            .catch((error) => {
              if (error !== null && error !== undefined && error.name === "AbortError") return;
              setItems([]);
              setErrorText("无法连接插件后端：" + String((error && error.message) || error));
              setLoading(false);
            });
        }, 300);
        return () => { clearTimeout(timer); controller.abort(); };
      }, [query, category]);

      /**
       * 下载并安装一个技能。
       * @param {any} item SkillHub 条目
       * @returns {void}
       */
      function doInstall(item) {
        const slug = String(item.slug || "");
        if (slug === "" || installing !== "") return;
        setInstalling(slug);
        fetch(API + "/skillhub/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug })
        })
          .then((resp) => resp.json())
          .then((res) => {
            setInstalling("");
            if (res !== null && res !== undefined && res.ok === true) {
              setInstalled((prev) => (prev.indexOf(slug) >= 0 ? prev : prev.concat([slug])));
              /* 通知主面板立即重拉 /skills/installed：切到「已安装」页无需手动刷新。 */
              notifyInstalledSkillsChanged();
              toast("已获取「" + String(res.name || item.name || slug) + "」，已可在「已安装」里查看和引用");
            } else {
              toast("获取失败：" + String((res && (res.error || res.message)) || "未知错误"));
            }
          })
          .catch((error) => {
            setInstalling("");
            toast("获取失败：" + String((error && error.message) || error));
          });
      }

      const catChips = categories.map((entry) => h("button", {
        key: entry.key,
        type: "button",
        className: "dshe-hub-cat" + (category === entry.key ? " dshe-hub-cat-on" : ""),
        onClick: () => setCategory((prev) => (prev === entry.key ? "" : entry.key))
      }, entry.name));

      const cards = items.map((item) => {
        const done = installed.indexOf(item.slug) >= 0;
        const busy = installing === item.slug;
        const desc = trimmed(item.summaryZh) !== "" ? item.summaryZh : item.summary;
        const metaBits = [];
        if (trimmed(item.owner) !== "") metaBits.push("@" + item.owner);
        if (item.downloads > 0) metaBits.push("↓ " + String(item.downloads));
        return h("div", {
          key: item.slug,
          className: "dshe-hub-card",
          role: "button",
          tabIndex: 0,
          "data-skillhub-slug": item.slug,
          onClick: () => setDetail(item),
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setDetail(item); }
          }
        },
          h("div", { className: "dshe-hub-head" },
            h("span", { className: "dshe-hub-icon", "aria-hidden": "true" },
              trimmed(item.iconUrl) !== ""
                ? h("img", {
                    src: item.iconUrl, alt: "", loading: "lazy",
                    onError: (event) => { try { event.target.style.display = "none"; } catch { /* 忽略 */ } }
                  })
                : h(CategoryIcon, { name: "skill", size: 18 })),
            h("div", { className: "dshe-hub-title", title: item.name }, item.name)
          ),
          h("div", { className: "dshe-hub-desc", title: desc }, desc !== "" ? desc : "暂无描述"),
          h("div", { className: "dshe-hub-foot" },
            h("span", { className: "dshe-hub-meta", title: metaBits.join(" · ") }, metaBits.join(" · ")),
            h("button", {
              type: "button",
              className: done ? "dshe-card-apply" : "dshe-hub-get",
              disabled: busy,
              title: done ? "引用到当前对话" : "下载并安装到本地技能库",
              "aria-label": (done ? "引用 " : "获取 ") + item.name,
              onClick: (event) => {
                event.stopPropagation();
                if (done) props.onApply(item);
                else doInstall(item);
              }
            }, done ? h(Icon, { name: "chat", size: 15 }) : (busy ? "获取中…" : "获取"))
          )
        );
      });

      return h("div", null,
        h("div", { className: "dshe-hub-bar" },
          h("input", {
            className: "dshe-hub-search",
            type: "search",
            value: query,
            placeholder: "搜索 SkillHub 技能",
            onChange: (event) => setQuery(event.target.value)
          }),
          base !== "" ? h("span", { className: "dshe-hub-meta", title: base }, "来源：" + base) : null
        ),
        catChips.length > 0 ? h("div", { className: "dshe-hub-cats", "aria-label": "技能分类" }, catChips) : null,
        errorText !== ""
          ? h("div", { className: "dshe-hub-state dshe-hub-err" }, errorText)
          : loading === true
            ? h("div", { className: "dshe-hub-state" }, "加载中…")
            : items.length === 0
              ? h("div", { className: "dshe-hub-state" }, query !== "" ? "没有匹配「" + query + "」的技能" : "该分类下暂无技能")
              : h("div", { className: "dshe-skill-grid" }, cards),
        detail !== null
          ? h(SkillHubDetail, {
              slug: detail.slug,
              name: detail.name,
              installed: installed.indexOf(detail.slug) >= 0,
              onClose: () => setDetail(null),
              onToast: toast,
              onInstalled: (slug) => setInstalled((prev) => (prev.indexOf(slug) >= 0 ? prev : prev.concat([slug])))
            })
          : null
      );
    }

    function ExpertPicker(props) {
      const [open, setOpen] = useState(false);
      /** 一级 = 三大块分类；二级 = 该块内的细分列表。 */
      const [level, setLevel] = useState("root");
      const [category, setCategory] = useState("expert");
      /** 专家块内二级：agent（专家）/ team（专家团）。 */
      const [expertKind, setExpertKind] = useState("agent");
      const [query, setQuery] = useState("");
      const [items, setItems] = useState([]);
      /** 专家/专家团只能选一个。 */
      const [selectedId, setSelectedId] = useState("");
      /** 连接器可多选：已常驻的连接器 id 列表，与专家单选态分开。 */
      const [selectedConnectorIds, setSelectedConnectorIds] = useState([]);
      const [loading, setLoading] = useState(false);
      const [errorText, setErrorText] = useState("");
      const [cursor, setCursor] = useState(0);
      const rootRef = useRef(null);
      const inputRef = useRef(null);
      const sid = props !== null && props !== undefined && typeof props.sessionId === "string" && props.sessionId !== ""
        ? props.sessionId
        : "";

      /* 选择器也上报一次：面板侧引用、常驻都靠这里兜底。 */
      useEffect(() => {
        if (sid !== "") lastComposerSessionId = sid;
      }, [sid]);

      /* 组件挂载即登记 opener，工具栏按钮只调 openExpertPicker() */
      useEffect(() => {
        pickerOpenSetter = setOpen;
        return () => { pickerOpenSetter = null; };
      }, []);

      /* 每次打开都从一级三大块开始，清空二级状态与搜索词。 */
      useEffect(() => {
        if (!open) return;
        setLevel("root");
        setCategory("expert");
        setExpertKind("agent");
        setQuery("");
        setCursor(0);
        setErrorText("");
      }, [open]);

      /* 进入二级后自动聚焦搜索框：ref 判空、依赖 level（每次切回二级重新聚焦）。
         不用 autoFocus —— overlay 槽可能被宿主重复挂载。 */
      useEffect(() => {
        if (!open || level !== "list") return;
        const el = inputRef.current;
        if (el !== null && el !== undefined && typeof el.focus === "function") el.focus();
      }, [open, level, category, expertKind]);

      /* 打开时回显当前挂载（选中态 ✓） */
      useEffect(() => {
        if (!open) return;
        const sessionId = sid !== "" ? sid : resolveSessionId(null);
        if (sessionId === "") { setSelectedId(""); setSelectedConnectorIds([]); return; }
        fetchJson("/attachments?sessionId=" + encodeURIComponent(sessionId))
          .then((res) => {
            /* /attachments 现在同时返回专家与连接器：专家单选只取非 connector 的第一条，
               连接器全量回显（多选）。不能再用 items[0] 一把抓，否则只挂连接器时 selectedId
               会被设成连接器 id，专家选中态就乱了。 */
            const list = res !== null && res !== undefined && res.ok === true && Array.isArray(res.items)
              ? res.items : [];
            const expert = list.find((it) => it !== null && it !== undefined && it.type !== "connector");
            setSelectedId(expert !== undefined ? String(expert.id || "") : "");
            setSelectedConnectorIds(list
              .filter((it) => it !== null && it !== undefined && it.type === "connector")
              .map((it) => String(it.id || "")));
          })
          .catch(() => { setSelectedId(""); setSelectedConnectorIds([]); });
      }, [open, sid]);

      /* 搜索：防抖 150ms + AbortController 取消旧请求。
         一级不拉数据；二级按 category 取对应分组（专家块按 expertKind 再分
         agent / team），技能与连接器各自成组。 */
      useEffect(() => {
        if (!open || level !== "list") return undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => {
          setLoading(true);
          setErrorText("");
          fetch(API + "/pick?q=" + encodeURIComponent(query) + "&limit=20", {
            headers: { Accept: "application/json" }, signal: controller.signal
          })
            .then((resp) => resp.json())
            .then((res) => {
              if (res === null || res === undefined || res.ok !== true || !Array.isArray(res.groups)) {
                setItems([]); setLoading(false); return;
              }
              const wanted = category === "expert"
                ? (expertKind === "team" ? ["team"] : ["agent"])
                : category === "skill" ? ["skill"] : ["connector"];
              const merged = [];
              for (const group of res.groups) {
                if (group === null || group === undefined || wanted.indexOf(group.kind) < 0) continue;
                for (const entry of Array.isArray(group.items) ? group.items : []) {
                  merged.push({
                    id: String(entry.id || ""),
                    name: String(entry.name || entry.id || ""),
                    avatar: typeof entry.avatar === "string" ? entry.avatar : "",
                    profession: typeof entry.profession === "string" ? entry.profession : "",
                    type: group.kind
                  });
                }
              }
              setItems(merged);
              setCursor(0);
              setLoading(false);
            })
            .catch((error) => {
              if (error !== null && error !== undefined && error.name === "AbortError") return;
              setErrorText("加载失败，请重试");
              setLoading(false);
            });
        }, 150);
        return () => { clearTimeout(timer); controller.abort(); };
      }, [open, level, category, expertKind, query]);

      /* Esc：二级返回一级，一级关闭；点面板外部直接关闭 */
      useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event.key !== "Escape") return;
          if (level === "list") { setLevel("root"); setCursor(0); }
          else setOpen(false);
        };
        const onPointerDown = (event) => {
          const root = rootRef.current;
          if (root === null || root === undefined) return;
          if (typeof root.contains === "function" && !root.contains(event.target)) setOpen(false);
        };
        window.addEventListener("keydown", onKeyDown);
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => {
          window.removeEventListener("keydown", onKeyDown);
          document.removeEventListener("pointerdown", onPointerDown, true);
        };
      }, [open, level]);

      /**
       * 选择一条：同一个 = 取消常驻（toggle 直觉，注释固化语义）；
       * 不同 = attach（服务端保证单选替换），关闭面板并广播让 dock 立即对账。
       * @param {any} entry 条目
       * @returns {void}
       */
      function choose(entry) {
        const sessionId = sid !== "" ? sid : resolveSessionId(null);
        if (sessionId === "" || entry.id === "") return;
        /* 技能保持一次性引用语义：插入结构化 chip，不插文本提示词。 */
        if (entry.type === "skill") {
          const inserted = typeof pickerInsertRef === "function"
            ? pickerInsertRef(sessionId, entry.type, entry.id, entry.name) : false;
          if (inserted === true) {
            setOpen(false);
          } else {
            setErrorText("插入引用失败，请在输入框输入 @ 选择");
          }
          return;
        }
        /* 连接器与专家同款：挂到本会话 system prompt，dock 里常驻图标 chip，可多选。
           这里必须走 /attach —— 之前这一支还在走 insertReference 一次性引用，
           所以从输入框选择器里选连接器时，工具栏里根本不会出现 chip。 */
        if (entry.type === "connector") {
          const connectorId = String(entry.id);
          const attached = selectedConnectorIds.indexOf(connectorId) >= 0;
          const target = attached ? API + "/detach" : API + "/attach";
          const body = attached
            ? { sessionId, id: connectorId, type: "connector" }
            : { sessionId, type: "connector", id: connectorId };
          fetch(target, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          })
            .then((resp) => resp.json())
            .then((res) => {
              if (res !== null && res !== undefined && res.ok === true) {
                setSelectedConnectorIds((prev) => attached
                  ? prev.filter((id) => id !== connectorId)
                  : (prev.indexOf(connectorId) >= 0 ? prev : prev.concat([connectorId])));
                setOpen(false);
                /* 列表页的「已连接」态同步登记/清除，两处入口行为一致（fire-and-forget）。 */
                fetch(API + (attached ? "/connectors/disconnect" : "/connectors/connect"), {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id: connectorId })
                }).catch(() => { /* 登记失败不影响常驻 */ });
                /* dock 监听同一事件：立刻对账，不必等 5s 轮询。不弹横幅（用户要求）。 */
                try { window.dispatchEvent(new CustomEvent("dsh-buddy-expert-hub:attachments-changed")); } catch { /* 忽略 */ }
              } else {
                const failure = (res && (res.error || res.message)) || "连接器常驻失败";
                setErrorText(failure);
                if (typeof expertNotify === "function") expertNotify(sessionId, failure, "error");
              }
            })
            .catch((error) => {
              const failure = "连接器常驻失败：" + String((error && error.message) || error);
              setErrorText(failure);
              if (typeof expertNotify === "function") expertNotify(sessionId, failure, "error");
            });
          return;
        }
        if (entry.id === selectedId) {
          fetch(API + "/detach", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, id: entry.id })
          }).then(() => {
            setSelectedId("");
            setOpen(false);
            /* 用户明确要求：不显示「已常驻 / 已取消常驻」这类横幅提示。 */
            try { window.dispatchEvent(new CustomEvent("dsh-buddy-expert-hub:attachments-changed")); } catch { /* 忽略 */ }
          }).catch(() => setErrorText("取消常驻失败"));
          return;
        }
        fetch(API + "/attach", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, type: entry.type, id: entry.id })
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setSelectedId(entry.id);
              setOpen(false);
              /* 成功不弹提示（用户要求）；改名 warning 只在真正冲突时用 error 级别单独提示。 */
              if (typeof res.warning === "string" && res.warning !== "" && typeof expertNotify === "function") {
                expertNotify(sessionId, res.warning, "error");
              }
              try { window.dispatchEvent(new CustomEvent("dsh-buddy-expert-hub:attachments-changed")); } catch { /* 忽略 */ }
            } else {
              const failure = (res && (res.error || res.message)) || "常驻失败";
              setErrorText(failure);
              if (typeof expertNotify === "function") expertNotify(sessionId, "常驻失败：" + failure, "error");
            }
          })
          .catch((error) => {
            const failure = "常驻失败：" + String((error && error.message) || error);
            setErrorText(failure);
            if (typeof expertNotify === "function") expertNotify(sessionId, failure, "error");
          });
      }

      /**
       * 键盘上下移动 + Enter 选中。
       * @param {any} event 键盘事件
       * @returns {void}
       */
      function onPanelKeyDown(event) {
        /* 一级：三项分类；二级：细分列表。Escape 在二级先返回一级。 */
        const count = level === "root" ? GROUPS.length : items.length;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setCursor((value) => Math.min(value + 1, count - 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setCursor((value) => Math.max(value - 1, 0));
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (level === "root") {
            const group = GROUPS[cursor];
            if (group !== undefined) { setCategory(group.id); setLevel("list"); setCursor(0); }
          } else if (items[cursor] !== undefined) {
            choose(items[cursor]);
          }
        }
      }

      /**
       * 进入某个大类。
       * @param {string} groupId 大块 id
       * @returns {void}
       */
      function enterCategory(groupId) {
        setCategory(groupId);
        setExpertKind("agent");
        setQuery("");
        setCursor(0);
        setErrorText("");
        setLevel("list");
      }

      /**
       * 召唤更多专家：复用侧栏现有入口（PanelIcon 根上打了 data 标记）。
       * @returns {void}
       */
      function openSidebarPanel() {
        try {
          const marker = document.querySelector("[data-dsh-buddy-expert-hub-panel-trigger]");
          const button = marker === null ? null : marker.closest("button");
          if (button !== null && button !== undefined) button.click();
        } catch { /* 找不到入口时静默放弃 */ }
        setOpen(false);
      }

      if (!open) return null;

      /* 一级：三大块分类，各带原生 SVG 图标与 > 箭头。 */
      const rootRows = GROUPS.map((group, index) => h("button", {
        key: group.id,
        type: "button",
        className: "dshe-picker-cat" + (index === cursor ? " dshe-picker-cat-cursor" : ""),
        onMouseEnter: () => setCursor(index),
        onClick: () => enterCategory(group.id)
      },
        h(CategoryIcon, { name: group.icon, size: 16 }),
        h("span", { className: "dshe-picker-cat-label" }, group.label),
        h("span", { className: "dshe-picker-cat-arrow", "aria-hidden": "true" }, "›")
      ));

      /* 二级：细分列表 */
      const visible = items.map((entry, index) => {
        /* 连接器按多选列表回显 ✓；专家/团队仍是单选。 */
        const selected = entry.type === "connector"
          ? selectedConnectorIds.indexOf(String(entry.id)) >= 0
          : entry.id === selectedId;
        /* 图标必须与列表卡片一致（用户反馈菜单里的图标和列表对不上）：
           专家/团队 → 真实头像，无资产回落中性人形；
           技能     → 与技能卡同款确定性彩色字母方块（skillTileColor + 首字母）；
           连接器   → 与连接器卡同款真实品牌图标（/icon?id=），加载失败回落首字母。 */
        const tileColor = entry.type === "skill" && entry.avatar === "" ? skillTileColor(entry.name) : null;
        const iconInner = entry.avatar !== ""
          ? h("img", {
              src: assetUrl(entry.avatar), alt: "", loading: "lazy",
              onError: (event) => { try { event.target.style.display = "none"; } catch { /* 忽略 */ } }
            })
          : entry.type === "skill"
            ? initialOf(entry.name)
            : entry.type === "connector"
              ? h("img", {
                  src: iconUrl(entry.id), alt: "", loading: "lazy",
                  onError: (event) => {
                    /* 无图标资产时回落首字母，保持与连接器卡一致的信息量 */
                    try {
                      const box = event.target.parentElement;
                      event.target.style.display = "none";
                      if (box !== null) box.textContent = initialOf(entry.name);
                    } catch { /* 忽略 */ }
                  }
                })
              : neutralAvatarGlyph(14);
        const iconStyle = tileColor !== null
          ? { backgroundColor: tileColor.bg, color: tileColor.fg, borderRadius: 7 }
          : null;
        const icon = h("span", {
          className: "dshe-picker-avatar" + (entry.type === "connector" ? " dshe-picker-avatar-cat" : "") + (tileColor !== null ? " dshe-picker-avatar-tile" : ""),
          style: iconStyle,
          "aria-hidden": "true"
        }, iconInner);
        return h("button", {
          key: entry.id + ":" + index,
          type: "button",
          className: "dshe-picker-row" + (selected ? " dshe-picker-row-on" : "") + (index === cursor ? " dshe-picker-row-cursor" : ""),
          role: "option", "aria-selected": selected,
          onMouseEnter: () => setCursor(index),
          onClick: () => choose(entry)
        },
          icon,
          h("span", { className: "dshe-picker-name", title: entry.name }, entry.name),
          selected ? h("span", { className: "dshe-picker-check", "aria-hidden": "true" }, "✓") : null
        );
      });

      const groupLabel = category === "expert" ? "专家" : category === "skill" ? "技能" : "连接器";
      const placeholder = category === "expert" ? "搜索专家" : category === "skill" ? "搜索技能" : "搜索连接器";

      const head = h("div", { className: "dshe-picker-head" },
        h("button", {
          type: "button", className: "dshe-picker-back", title: "返回分类", "aria-label": "返回分类",
          onClick: () => { setLevel("root"); setCursor(0); }
        }, "‹"),
        h("span", { className: "dshe-picker-crumb" }, groupLabel),
        category === "expert"
          ? h("div", { className: "dshe-picker-subtabs" },
              h("button", {
                type: "button",
                className: "dshe-picker-subtab" + (expertKind === "agent" ? " dshe-picker-subtab-on" : ""),
                onClick: () => { setExpertKind("agent"); setCursor(0); }
              }, "专家"),
              h("button", {
                type: "button",
                className: "dshe-picker-subtab" + (expertKind === "team" ? " dshe-picker-subtab-on" : ""),
                onClick: () => { setExpertKind("team"); setCursor(0); }
              }, "专家团")
            )
          : null
      );

      return h("div", {
        ref: rootRef,
        className: "dshe-picker",
        role: "dialog", "aria-label": "选择专家、技能或连接器", "aria-modal": "false",
        onKeyDown: onPanelKeyDown
      },
        level === "root"
          ? h("div", { className: "dshe-picker-list", role: "menu", "aria-label": "资源分类" }, rootRows)
          : [
              h("div", { key: "head" }, head),
              h("div", { key: "search", className: "dshe-picker-search" },
                h("span", { className: "dshe-picker-search-icon", "aria-hidden": "true" }, "⌕"),
                h("input", {
                  ref: inputRef,
                  className: "dshe-picker-input", type: "text", value: query,
                  placeholder: placeholder, "aria-label": placeholder, spellCheck: false,
                  onChange: (event) => setQuery(event.target.value)
                })
              ),
              h("div", { key: "list", className: "dshe-picker-list", role: "listbox", "aria-label": groupLabel },
                loading === true && items.length === 0
                  ? h("div", { className: "dshe-picker-state" }, "加载中…")
                  : errorText !== ""
                    ? h("div", { className: "dshe-picker-state dshe-picker-state-err" }, errorText)
                    : items.length === 0
                      ? h("div", { className: "dshe-picker-state" }, "没有匹配的" + groupLabel)
                      : visible
              ),
              category === "expert"
                ? h("div", { key: "foot", className: "dshe-picker-foot" },
                    h("button", { type: "button", className: "dshe-picker-more", onClick: openSidebarPanel }, "↗ 召唤更多专家")
                  )
                : null
            ]
      );
    }

    // =======================================================================
    // Composer 工具栏按钮
    // =======================================================================

    /**
     * 会话常驻连接器 chip：约 28×28 的方块，只显示真实品牌图标，不渲染任何文字。
     * 图标走 /dsh-buddy-expert-hub/icon?id=；加载失败回落中性连接器占位 SVG（同样不带任何字符），
     * 名称只放在 title / aria-label 里，绝不落到可见文本节点。
     * 右上角小 × 用于把该连接器从本会话拆掉，不影响专家与其他连接器。
     * @param {{ item: any, onRemove: Function }} props 属性
     * @returns {any} React 元素
     */
    function DockConnectorChip(props) {
      const item = props.item;
      const [broken, setBroken] = useState(false);
      const id = String(item.id || "");
      const name = String(item.displayName || item.name || id);
      return h("span", {
        className: "dshe-dock-conn",
        role: "listitem",
        title: "常驻连接器：" + name,
        "aria-label": "常驻连接器 " + name
      },
        broken
          ? h("span", { className: "dshe-dock-conn-fallback", "aria-hidden": "true" },
              h(CategoryIcon, { name: "connector", size: 16 }))
          : h("img", { src: iconUrl(id), alt: "", loading: "lazy", onError: () => setBroken(true) }),
        item.pending === true ? h("span", { className: "dshe-dock-conn-pending", title: "待生效" }) : null,
        h("button", {
          type: "button",
          className: "dshe-dock-conn-remove",
          "aria-label": "移除常驻连接器 " + name,
          title: "移除（本会话不再常驻）",
          onClick: props.onRemove
        }, h(Icon, { name: "close", size: 10 }))
      );
    }

    /**
     * 会话常驻专家 chip（conversation.input.left 工具栏行内槽）：与 + / 分支 /
     * 权限按钮同一行的扁平元素，蓝色圆点 + 常规字重名称 + hover 才出现的 ×。
     * sessionId 来自槽位 inject（宿主传参，与 queue dock 同款），回落快照归一化；
     * 读 GET /attachments 渲染 chip 列表，点 × POST /detach 移除。
     * 轻轮询（5s）对账服务端内存态——挂载是会话级语义，重启丢失即消失。
     * @param {{ sessionId?: string }} props 槽位注入的 props
     * @returns {any} React 元素
     */
    function ExpertDock(props) {
      const [items, setItems] = useState([]);
      const [sessionId, setSessionId] = useState("");
      /* 槽位 inject 给的 sessionId（最可靠）；随会话切换变化，进依赖触发重载 */
      const injectedSid = props !== null && props !== undefined && typeof props.sessionId === "string" ? props.sessionId : "";

      /* 上报给模块层：侧栏面板（main 槽）拿不到会话注入，靠这个兜底才能把引用插进对会话。 */
      useEffect(() => {
        if (injectedSid !== "") lastComposerSessionId = injectedSid;
      }, [injectedSid]);

      const load = useCallback(() => {
        let sid = injectedSid;
        if (sid === "") sid = resolveSessionId(null);
        if (sid === "") { setItems([]); setSessionId(""); return; }
        setSessionId(sid);
        fetchJson("/attachments?sessionId=" + encodeURIComponent(sid))
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true && Array.isArray(res.items)) {
              setItems(res.items);
            } else {
              setItems([]);
            }
          })
          .catch(() => { /* 网络抖动保持现状 */ });
      }, []);

      useEffect(() => {
        load();
        const timer = setInterval(load, 5000);
        /* 选择器里选中/取消后立即对账，不必等 5s 轮询 */
        const onChange = () => load();
        try { window.addEventListener("dsh-buddy-expert-hub:attachments-changed", onChange); } catch { /* 忽略 */ }
        return () => {
          clearInterval(timer);
          try { window.removeEventListener("dsh-buddy-expert-hub:attachments-changed", onChange); } catch { /* 忽略 */ }
        };
      }, [load, injectedSid]);

      /**
       * 移除一个常驻专家：POST /detach 后立即对账刷新。
       * @param {string} id 专家 id
       * @returns {void}
       */
      function removeExpert(id) {
        if (sessionId === "") return;
        fetch(API + "/detach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, id })
        })
          .then(() => load())
          .catch(() => load());
      }

      /**
       * 移除一个常驻连接器：POST /detach {sessionId,id,type:'connector'} 后对账刷新。
       * type 必带，否则服务端会走专家单选的 detach 分支。
       * @param {string} id 连接器 id
       * @returns {void}
       */
      function removeConnector(id) {
        if (sessionId === "") return;
        fetch(API + "/detach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, id, type: "connector" })
        })
          .then(() => load())
          .catch(() => load());
      }

      if (sessionId === "") return null;
      /* 专家/专家团仍「只能选一个」：接口若异常返回多条，只渲染第一条并告警。
         连接器「可以选多个」：全部渲染，与专家 chip 同容器、紧随其后（专家按钮旁边）。 */
      const expertItems = items.filter((item) =>
        item !== null && item !== undefined && item.type !== "connector");
      const connectorItems = items.filter((item) =>
        item !== null && item !== undefined && item.type === "connector");
      if (expertItems.length === 0 && connectorItems.length === 0) return null;
      if (expertItems.length > 1 && dockMultiWarned === false) {
        dockMultiWarned = true;
        try { console.warn("[dsh-buddy-expert-hub] /attachments 返回多条专家挂载，dock 只渲染第一条专家"); } catch { /* 忽略 */ }
      }
      const shown = expertItems.slice(0, 1);
      return h("div", { className: "dshe-dock", role: "list", "aria-label": "本会话常驻专家与连接器" },
        shown.map((item) => {
          /* 用户要「展示专家称号」：真称号优先（设计系统架构师），
             占位值/空值回落 displayName；title/aria 给完整「称号 | 人名」 */
          const rawProfession = trimmed(item.profession || "");
          const profession = isRealProfession(rawProfession) ? rawProfession : "";
          const personName = String(item.displayName || item.id);
          const label = profession !== "" ? profession : personName;
          const full = profession !== "" && profession !== personName ? profession + " | " + personName : personName;
          const avatarPath = typeof item.avatar === "string" ? item.avatar : "";
          return h("span", { key: item.id, className: "dshe-dock-chip", role: "listitem" },
            h("span", { className: "dshe-dock-avatar", "aria-hidden": "true" },
              avatarPath !== ""
                ? h("img", { src: assetUrl(avatarPath), alt: "", loading: "lazy" })
                : neutralAvatarGlyph(12)),
            h("span", { className: "dshe-dock-name", title: full }, label),
            item.pending === true ? h("span", { className: "dshe-dock-pending" }, "待生效") : null,
            h("button", {
              type: "button",
              className: "dshe-dock-remove",
              "aria-label": "移除常驻专家 " + full,
              title: "移除（本会话不再自动生效）",
              onClick: () => removeExpert(item.id)
            }, h(Icon, { name: "close", size: 12 }))
          );
        }),
        connectorItems.map((item) =>
          h(DockConnectorChip, {
            key: "conn:" + String(item.id),
            item,
            onRemove: () => removeConnector(String(item.id))
          })
        )
      );
    }

    /**
     * Composer 工具栏按钮：点击打开专家/技能/连接器选择菜单。
     * `onMouseDown` 必须 `preventDefault` 并回焦编辑器，否则宿主检测失焦立即关菜单。
     * @param {{ onClick: Function, onMouseDown: Function }} props 属性
     * @returns {any} React 元素
     */
    function ComposerButton(props) {
      return h("button", {
        type: "button",
        className: "dshe-composer-btn",
        onMouseDown: props.onMouseDown,
        onClick: props.onClick,
        title: "选择专家、专家团、技能或连接器",
        "aria-label": "选择专家、技能或连接器"
      },
        /* 用户提供的 expert-icon.svg（内联为原生 SVG，currentColor 随 hover 变色） */
        h(CategoryIcon, { name: "expert", size: 18 })
      );
    }

    /**
     * 注册 composer 工具栏按钮与触发源。
     * @param {any} ctx 插件上下文
     * @returns {void}
     */
    function applyComposer(ctx) {
      /* 优雅降级：测试环境或缺少宿主 API 时不注册 composer 集成 */
      if (typeof ctx.get !== "function") {
        return;
      }

      /* 赋值提升为模块层引用（不要 const 局部声明）：resolveSessionId 与
         applyToConversation 都在 applyComposer 作用域之外，必须用同一份服务。 */
      sessions = pickHostService(ctx, "sessions", "open");
      conversation = ctx.get("conversation");
      inputTriggers = ctx.get("inputTriggers");
      /* layout 是可选服务：拿不到时引用与会话切换照常工作，只是不自动跳回对话视图。
         不把它加进 inject 依赖数组，避免某个宿主版本缺该服务就整块 composer 集成失效。 */
      layout = pickHostService(ctx, "layout", "selectPanel");

      if (!sessions || !conversation || !inputTriggers) {
        return;
      }

      /**
       * 通过会话输入通道发一条用户可见提示。
       * 探针：宿主 InputFacade.notify 只接受 'info' | 'error'
       * （dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:195）。
       * 成功/普通提示用 info（无 ⚠ 警示图标），失败用 error（默认）。
       * @param {string} sessionId 会话 id
       * @param {string} text 提示文本
       * @param {'info'|'error'} [level='error'] 级别
       * @returns {void}
       */
      function notifySession(sessionId, text, level) {
        const severity = level === "info" ? "info" : "error";
        try {
          const actx = sessions.scope(sessionId);
          if (actx === undefined) return;
          const input = conversation.input.for(actx);
          if (input !== null && input !== undefined && typeof input.notify === "function") {
            input.notify(severity, text);
          }
        } catch {
          // 会话已不存在等场景：静默放弃提示
        }
      }

      /**
       * 菜单条目图标：按类别映射到宿主 ReferenceIconKind 合法枚举。
       * 专家/团队 = session（圆形徽章）、技能 = folder、连接器 = file。
       * 宿主不支持自定义图片（探针结论），这是不伪造数据前提下的最优形态。
       * @param {string} kind 数据类别（agent/team/skill/connector）
       * @returns {string} ReferenceIconKind
       */
      function menuIconFor(kind) {
        if (kind === "agent" || kind === "team") return "session";
        if (kind === "skill") return "folder";
        return "file";
      }

      const source = {
        trigger: "@",
        name: "dsh-buddy-expert-hub",
        order: 50,
        candidates: async (session, { query, signal }) => {
          const url = API + "/pick?q=" + encodeURIComponent(query || "");
          const resp = await fetch(url, { headers: { Accept: "application/json" }, signal });
          if (!resp.ok) return [];
          const data = await resp.json();
          if (!data.ok || !data.groups) return [];
          const items = [];
          for (const group of data.groups) {
            /* 专家/专家团不再走宿主大表格菜单（改自绘紧凑面板）；
               @ 触发源只保留技能/连接器的一次性 chip 语义 */
            if (group.kind === "agent" || group.kind === "team") continue;
            for (const item of group.items) {
              items.push({
                section: group.title,
                name: item.name,
                description: item.desc || "",
                value: group.kind + ":" + item.id,
                /* 探针结论：宿主菜单 icon 只接受 ReferenceIconKind 枚举
                   'session'|'file'|'folder'（ReferenceIcon switch + d.ts 双证据），
                   自定义图片/emoji 不支持。按类别映射最接近的原生 glyph。 */
                icon: menuIconFor(group.kind)
              });
            }
          }
          return items;
        },
        onPick: ({ candidate, session }) => {
          const refParts = String(candidate.value || "").split(":");
          const refType = refParts[0];
          const refId = refParts[1];
          // 连接器与技能保持一次性 chip 语义：插入引用，serialize 时内联配置/正文。
          // 技能不走 /attach（服务端只收 agent/team，此前误入 attach 分支报 400）。
          if (refType === "connector" || refType === "skill") {
            return {
              insert: {
                source: "dsh-buddy-expert-hub",
                ref: candidate.value,
                label: candidate.name,
                appearance: "session",
                clipboardText: "@" + candidate.name
              }
            };
          }
          // 专家/团队改为会话常驻：POST /attach 注册 systemPrompt 身份区块 +
          // runtime skill，dock 出现常驻 chip；不插入草稿（宿主 settle() 对
          // undefined outcome 只关菜单不插入，探针已证实）。
          const pickSessionId = refId ? resolveSessionId(session) : "";
          if (pickSessionId !== "") {
            fetch(API + "/attach", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: pickSessionId, type: refType, id: refId })
            })
              .then((resp) => resp.json())
              .then((res) => {
                if (res === null || res === undefined || res.ok !== true) {
                  notifySession(pickSessionId, "专家常驻失败：" + ((res && (res.error || res.message)) || "未知错误"));
                } else if (typeof res.warning === "string" && res.warning !== "") {
                  notifySession(pickSessionId, res.warning, "info");
                }
              })
              .catch((error) => notifySession(pickSessionId, "专家常驻失败：" + String((error && error.message) || error)));
          } else if (refId) {
            /* 绝不静默：会话 id 取不到也要让用户知道常驻没发生 */
            try { console.warn("[dsh-buddy-expert-hub] onPick：无法确定当前会话 id，attach 已跳过"); } catch { /* 忽略 */ }
          }
          return undefined;
        },
        codec: {
          clipboardText: (ref) => "@" + ref,
          serialize: async (ref, signal) => {
            const parts = ref.split(":");
            if (parts.length !== 2) {
              throw new Error("无法解析引用：" + ref);
            }
            const [type, id] = parts;
            const resp = await fetch(API + "/detail?type=" + encodeURIComponent(type) + "&id=" + encodeURIComponent(id), {
              headers: { Accept: "application/json" },
              signal
            });
            if (!resp.ok) {
              throw new Error("无法加载该内容，请重试");
            }
            const data = await resp.json();
            if (!data.ok || !data.item) {
              throw new Error("无法加载该内容，请重试");
            }

            const item = data.item;
            const name = item.displayName || item.name || item.id;
            const description = item.description || "";
            const readme = data.readme || "";

            let block = "<dsh-buddy-expert-hub type=\"" + type + "\" id=\"" + id + "\" name=\"" + name + "\">\n";
            block += "<description>" + description + "</description>\n";

            if (type === "connector") {
              const config = item.config ? JSON.stringify(item.config, null, 2) : "";
              block += "<mcp-config>" + config.slice(0, SERIALIZE_LIMIT) + "</mcp-config>\n";
              block += "如需使用该连接器，请按上述 MCP 配置调用\n";
            } else if (type === "skill") {
              /* 技能保持一次性引用：内联 SKILL.md 正文 + 资源目录指针。 */
              block += "<instructions>\n" + readme.slice(0, SERIALIZE_LIMIT) + "\n</instructions>\n";
              const skillsDir = typeof item.skillsDir === "string" ? item.skillsDir : "";
              if (skillsDir !== "") {
                block += "<skills location=\"" + skillsDir + "\">\n";
                block += "该技能的资源在此目录；需要时用 read / glob 读取，不要凭猜测使用。\n";
                block += "</skills>\n";
              }
            } else {
              /* 专家/团队已改为会话常驻（onPick 时 attach，system prompt 注入），
                 不再插草稿；这个分支只为兼容旧草稿里可能残留的 expert 引用 ——
                 给一句最小降级说明，绝不再展开 <dsh-buddy-expert-hub> 大块。 */
              block += "@" + name + "（该专家已改为会话常驻；若本会话未生效，请在输入框工具栏重新选择一次）\n";
            }

            block += "</dsh-buddy-expert-hub>";
            return block;
          }
        }
      };

      ctx.effect(() => inputTriggers.registerSource(source), "dsh-buddy-expert-hub: composer trigger source");

      ctx.inject(["slots", "sessions", "conversation", "inputTriggers"], (scope) => {
        /* inject 回调里的 scope 才是依赖就绪后的 ctx：同样走
           ctx.get + ctx.reflect.get 双路探测，尽量拿到带 open / selectPanel
           的完整 face，替换掉 applyComposer 阶段拿到的裁剪版。 */
        const scopedSessions = pickHostService(scope, "sessions", "open");
        if (scopedSessions !== null && typeof scopedSessions.open === "function" &&
            (sessions === null || typeof sessions.open !== "function")) {
          sessions = scopedSessions;
        }
        const scopedLayout = pickHostService(scope, "layout", "selectPanel");
        if (scopedLayout !== null && typeof scopedLayout.selectPanel === "function" &&
            (layout === null || typeof layout.selectPanel !== "function")) {
          layout = scopedLayout;
        }
        scope.slots.inject("conversation.input.left", () =>
          scope.slots.register({
            name: "conversation.input.left",
            id: "dsh-buddy-expert-hub-composer-button",
            order: 10,
            inject: (sessionId) => {
              /**
               * 这个按钮常驻在输入框工具栏，注入回调里就能拿到宿主直供的 sessionId。
               * 顺手记到模块变量：侧栏面板（main 槽）拿不到会话注入，且部分宿主版本
               * 里 sessions.list 快照的 current 恒为空 —— 没有这一手，面板里点「引用」
               * 会报「未找到当前会话」。
               */
              if (typeof sessionId === "string" && sessionId !== "") lastComposerSessionId = sessionId;
              return {
                /**
                 * 阻止浏览器把焦点移到按钮，保持编辑器不 blur。
                 * 宿主的 + 按钮就是这么做的：`keepFocus = (e) => { e.preventDefault(); editor?.getRootElement()?.focus(); }`
                 */
                onMouseDown: (e) => { e.preventDefault(); },
                /* 不再 toggleSource：专家选择改由 conversation.input.overlay 槽
                   里的自绘紧凑面板负责；@ 触发源只保留技能/连接器。 */
                onClick: () => openExpertPicker()
              };
            }
          }, ComposerButton)
        );

        // 会话常驻专家 chip：探针确认 `conversation.input.left` 就是输入框
        // 底部工具栏行内槽（dsh-client-ui-conversation:16178，leading 组末尾，
        // 紧跟 + / 分支 / 权限按钮），与 ComposerButton 同槽。
        // order 20 排在按钮（order 10）之后、右侧模型选择器之前，不挤占右侧控件。
        // inject 返回的 props 传给组件：sessionId 由宿主直供（queue dock 同款），
        // 比快照可靠（上一轮 QA 实测快照路径不可靠）。
        scope.slots.inject("conversation.input.left", () =>
          scope.slots.register({
            name: "conversation.input.left",
            id: "dsh-buddy-expert-hub-dock",
            order: 20,
            inject: (sessionId) => ({ sessionId: typeof sessionId === "string" ? sessionId : "" })
          }, ExpertDock)
        );

        // 紧凑专家选择器：探针确认 `conversation.input.overlay` 是公开 list 槽
        // （slots.d.ts:193「Floating entries rendered inside the resident composer
        // card」），宿主菜单本体 slash-menu 也注册在这里（ui-input-trigger:1116），
        // overlayAnchor 为 height:0 的绝对定位容器——完全可自绘任意 React 浮层。
        // order 10 与宿主菜单同槽，z-index 120 高于宿主菜单(100)。
        scope.slots.inject("conversation.input.overlay", () =>
          scope.slots.register({
            name: "conversation.input.overlay",
            id: "dsh-buddy-expert-hub-picker",
            order: 10,
            inject: (sessionId) => ({ sessionId: typeof sessionId === "string" ? sessionId : "" })
          }, ExpertPicker)
        );

        // 会话通知桥：面板/选择器与 Panel 共处的模块层组件用同一提示通道。
        expertNotify = notifySession;

        // 草稿引用插入桥：把技能/连接器作为结构化 chip 插入输入框，
        // 复用宿主 insertReference（span 用当前 caret，draftRev 做 CAS）。
        pickerInsertRef = (sid, refType, refId, label) => {
          lastInsertError = "";
          const fail = (reason) => {
            lastInsertError = reason;
            try { console.warn("[dsh-buddy-expert-hub] 插入引用失败：" + reason); } catch { /* 忽略 */ }
            return false;
          };
          try {
            if (typeof sid !== "string" || sid === "") return fail("会话 id 为空");
            const actx = sessions.scope(sid);
            if (actx === undefined) return fail("会话上下文未就绪（sessions.scope 返回空）");
            const input = conversation.input.for(actx);
            if (input === null || input === undefined) return fail("输入框不可用（input.for 返回空）");

            const payload = {
              source: "dsh-buddy-expert-hub",
              ref: refType + ":" + refId,
              label: label,
              appearance: "session",
              clipboardText: "@" + label
            };

            /**
             * span 的 start/end 用「草稿可见长度」推断；草稿里若已有 chip，
             * draft 是展开后的投影、长度可能大于编辑器文档长度，直接把末尾
             * 当插入点会越界被 CAS 拒绝。因此按「末尾 → 0」两档重试，
             * 每档都重读快照拿最新 draftRev（插入前 rev 可能已变）。
             */
            for (const where of ["end", "start"]) {
              const snap = input.state.getSnapshot();
              const phase = snap !== null && snap !== undefined ? snap.phase : undefined;
              if (phase !== undefined && phase !== "plain") return fail("输入框正忙（phase=" + String(phase) + "），等这一轮结束再试");
              const len = String(snap.draft || "").length;
              const at = where === "end" ? len : 0;
              const ok = input.insertReference(payload, { start: at, end: at, draftRev: snap.draftRev || 0 });
              if (ok === true) return true;
            }
            return fail("编辑器拒绝了插入（span CAS 未通过）");
          } catch (error) {
            return fail(String((error && error.message) || error));
          }
        };

        // 召唤桥：把 sessions 服务的 create/open 能力暴露给面板侧。
        // 探针确认 create(opts?) → Promise<SessionId>、open(id) 为宿主官方契约。
        summonBridge = {
          create: () => {
            if (sessions !== null && sessions !== undefined && typeof sessions.create === "function") {
              return sessions.create();
            }
            return Promise.reject(new Error("宿主 sessions.create 不可用"));
          },
          /* 防御式：宿主没有 open 时只留痕、不抛错，召唤流程继续挂载专家。 */
          open: (id) => openSessionSafe(id),
          currentSessionId: () => resolveSessionId(null)
        };

        /**
         * 控制台诊断钩子：`__expertHubDiag()` 一次性吐出会话/输入框的真实状态。
         * 引用插不进去时，用户或排查者不必猜是哪一环挂的（scope / phase / draftRev）。
         */
        try {
          window.__expertHubDiag = () => {
            const out = {
              sessionId: resolveSessionId(null),
              lastComposerSessionId: lastComposerSessionId,
              insertRefReady: typeof pickerInsertRef === "function",
              lastInsertError: lastInsertError,
              /* 宿主能力探测：open 缺失时只跳过会话切换，不影响引用与视图跳转。 */
              hasSessionsOpen: sessions !== null && sessions !== undefined && typeof sessions.open === "function",
              hasSessionsCreate: sessions !== null && sessions !== undefined && typeof sessions.create === "function",
              sessionsKeys: sessions !== null && sessions !== undefined ? Object.keys(sessions).slice(0, 20) : [],
              layoutOk: layout !== null && layout !== undefined && typeof layout.selectPanel === "function"
            };
            try {
              const actx = sessions.scope(out.sessionId);
              out.scopeOk = actx !== undefined;
              if (actx !== undefined) {
                const input = conversation.input.for(actx);
                out.inputOk = input !== null && input !== undefined;
                if (out.inputOk) {
                  const snap = input.state.getSnapshot();
                  out.phase = snap !== null && snap !== undefined ? snap.phase : null;
                  out.draftLen = snap !== null && snap !== undefined ? String(snap.draft || "").length : -1;
                  out.draftRev = snap !== null && snap !== undefined ? snap.draftRev : -1;
                  out.canInsertReference = typeof input.insertReference === "function";
                }
              }
            } catch (error) {
              out.scopeError = String((error && error.message) || error);
            }
            return out;
          };
        } catch { /* 无 window 环境（如单测）忽略 */ }
      });
    }

    // =======================================================================
    // 插件导出
    // =======================================================================

    var inject = ["slots", "sessions", "conversation", "inputTriggers"];

    /**
     * 注册主面板与侧边栏入口。
     * @param {any} ctx 插件上下文
     * @returns {void}
     */
    function apply(ctx) {
      applyStyles(ctx);

      ctx.slots.inject("main", () =>
        ctx.slots.register({
          name: "main",
          key: PANEL_ID,
          inject: () => ({})
        }, Panel)
      );

      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 12,
          label: () => "专家·技能·连接器"
        }, PanelIcon)
      );

      applyComposer(ctx);
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
