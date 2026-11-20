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

    /* ---- Office 版式级预览能力探测（模块内缓存，避免每次打开文档都打一次请求） ----
       成功缓存 5 分钟；失败只缓存 30 秒，避免一次网络抖动让预览能力长时间失效。 */
    var OFFICE_CAP_CACHE = { at: 0, value: false };
    var OFFICE_CAP_OK_TTL = 5 * 60 * 1000;
    var OFFICE_CAP_FAIL_TTL = 30 * 1000;

    /**
     * 探测在线资料库是否启用了非内置的 Office 版式预览服务（ONLYOFFICE / WPS）。
     *
     * 独立走 fetch + 2.5s 超时：不复用 fetchJson 的 15s，保证在线不可达时
     * 「打开文档」不会被探测卡住。任何失败（超时 / 网络 / 非 200 / 结构异常）
     * 一律静默返回 false，由调用方回退到内置轻量视图，不弹错误、不阻塞打开。
     *
     * @returns {Promise<boolean>} 是否可用
     */
    function probeOfficeCapability() {
      var now = Date.now();
      var ttl = OFFICE_CAP_CACHE.value === true ? OFFICE_CAP_OK_TTL : OFFICE_CAP_FAIL_TTL;
      if (OFFICE_CAP_CACHE.at > 0 && now - OFFICE_CAP_CACHE.at < ttl) {
        return Promise.resolve(OFFICE_CAP_CACHE.value);
      }
      if (typeof fetch !== "function") {
        OFFICE_CAP_CACHE = { at: Date.now(), value: false };
        return Promise.resolve(false);
      }
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var timer = controller === null ? null : setTimeout(function () {
        try { controller.abort(); } catch { /* 已结束 */ }
      }, 2500);
      var init = { headers: { Accept: "application/json" } };
      if (controller !== null) init.signal = controller.signal;
      var finish = function (value) {
        if (timer !== null) clearTimeout(timer);
        OFFICE_CAP_CACHE = { at: Date.now(), value: value };
        return value;
      };
      return fetch(API + "/khub/office/status", init)
        .then(function (resp) { return resp.ok === true ? resp.json() : null; })
        .then(function (res) {
          var provider = res !== null && res !== undefined && typeof res.provider === "string" ? res.provider : "";
          var ok = res !== null && res !== undefined && res.ok === true &&
            provider !== "" && provider !== "BUILTIN" && res.enabled === true;
          return finish(ok === true);
        })
        .catch(function () { return finish(false); });
    }

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
    /** 第 4 个大块「个人工作台」的 16x16 四宫格图标（与三大块同款 currentColor 内联 SVG）。 */
    CATEGORY_ICONS.workbench = { transform: "", d: "M1.5 1.5h5.2v5.2H1.5V1.5zm7.8 0h5.2v5.2H9.3V1.5zm-7.8 7.8h5.2v5.2H1.5V9.3zm7.8 0h5.2v5.2H9.3V9.3z", fillRule: "" };

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

    /** 专家选择器的一级分类：与面板大块一一对应，工作台是独立侧栏面板、不进 /pick。 */
    var PICKER_GROUPS = GROUPS;

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
      ".dshe-sub-stale{margin:3px 0 0;font-size:12px;color:var(--dsw-alias-state-warning-primary,#9a6700);background:rgba(212,167,44,.12);border-radius:6px;padding:2px 8px;display:inline-block}",
      ".dshe-head-actions{display:flex;align-items:center;gap:8px}",
      ".dshe-search{width:250px;max-width:42vw;height:30px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:inherit;font-size:12.5px;outline:none}",
      ".dshe-search:focus{border-color:var(--dsw-alias-brand-primary,#0969da);background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-btn{height:30px;padding:0 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px;cursor:pointer;white-space:nowrap}",
      ".dshe-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-btn:disabled{opacity:.55;cursor:default}",
      ".dshe-btn-primary{border-color:var(--dsw-alias-brand-primary,#0969da);background:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-bg-base,#fff)}",
      ".dshe-btn-primary:hover:not(:disabled){color:var(--dsw-alias-bg-base,#fff);opacity:.9}",
      ".dshe-tabs{display:flex;gap:4px;padding:0 24px;border-bottom:1px solid var(--dsw-alias-border-l1,#d0d7de)}",
      ".dshe-tab{position:relative;display:inline-flex;align-items:center;gap:6px;padding:9px 12px;border:none;border-bottom:2px solid transparent;background:none;color:var(--dsw-alias-label-secondary,#57606a);font-size:13px;font-weight:500;cursor:pointer;margin-bottom:-1px}",
      ".dshe-tab:hover{color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-tab-on{color:var(--dsw-alias-brand-primary,#0969da);border-bottom-color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-tab-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:17px;padding:0 5px;border-radius:9px;background:var(--dsw-alias-bg-layer-2,#eef1f4);color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;font-weight:600}",
      ".dshe-tab-on .dshe-tab-badge{background:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-bg-base,#fff)}",
      ".dshe-tab svg{flex:none;display:block}",
      /* 专家块内的二级子分组（专家 / 专家团） */
      ".dshe-subtabs{display:flex;gap:6px;padding:8px 24px 0}",
      ".dshe-subtab{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 11px;border:1px solid transparent;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#eef1f4);color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;font-weight:500;cursor:pointer}",
      ".dshe-subtab:hover{color:var(--dsw-alias-label-primary,#1f2328);border-color:var(--dsw-alias-border-l1,#d0d7de)}",
      ".dshe-subtab-on{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(9,105,218,.10));border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-subtab-badge{font-size:11px;font-weight:600;opacity:.8}",
      /* ---- SkillHub 商店 --------------------------------------------------- */
      ".dshe-hub-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}",
      ".dshe-hub-search{flex:1;min-width:180px;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:13px;color:inherit;outline:none}",
      ".dshe-hub-search:focus{border-color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-hub-cats{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}",
      ".dshe-hub-cat{height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#4b5563);font-size:12px;cursor:pointer;transition:background .12s,color .12s,border-color .12s}",
      ".dshe-hub-cat:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-primary,#111827)}",
      ".dshe-hub-cat-on{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(9,105,218,.10));border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da);font-weight:600}",
      ".dshe-hub-card{display:flex;flex-direction:column;gap:7px;min-width:0;padding:10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,#eef0f2);background:var(--dsw-alias-bg-layer-1,#fff);transition:border-color .14s,box-shadow .14s}",
      ".dshe-hub-card:hover{border-color:var(--dsw-alias-border-l1,#e1e5ea);box-shadow:0 4px 16px rgba(0,0,0,.06)}",
      ".dshe-hub-head{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dshe-hub-icon{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;overflow:hidden;background:var(--dsw-alias-border-l1,#eef1f4);color:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".dshe-hub-icon img{width:100%;height:100%;object-fit:cover}",
      ".dshe-hub-title{min-width:0;flex:1;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#111827);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-hub-desc{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-hub-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}",
      ".dshe-hub-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-hub-get{flex:none;height:22px;padding:0 9px;border:none;border-radius:6px;background:var(--dsw-alias-state-success-primary,#16a34a);color:var(--dsw-alias-bg-base,#fff);font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap}",
      ".dshe-hub-get:disabled{background:var(--dsw-alias-border-l1,#e5e7eb);color:var(--dsw-alias-label-secondary,#9ca3af);cursor:default}",
      ".dshe-hub-state{padding:28px 0;text-align:center;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:13px}",
      ".dshe-hub-err{color:var(--dsw-alias-state-error-primary,#b42318)}",
      /* 商店详情抽屉 */
      ".dshe-hub-hero{display:flex;align-items:center;gap:14px;min-width:0}",
      ".dshe-hub-hero-icon{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:14px;overflow:hidden;background:var(--dsw-alias-border-l1,#eef1f4);color:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".dshe-hub-hero-icon img{width:100%;height:100%;object-fit:cover}",
      ".dshe-hub-hero-id{min-width:0;flex:1}",
      ".dshe-hub-hero-name{margin:0;font-size:19px;font-weight:650;color:var(--dsw-alias-label-primary,#111827);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-hub-hero-sub{margin-top:3px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-hub-hero-get{height:28px;padding:0 14px;font-size:12.5px;border-radius:7px}",
      ".dshe-hub-hero-meta{margin-top:14px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#6b7280)}",
      ".dshe-hub-hero-desc{margin-top:14px;font-size:13.5px;line-height:1.7;color:var(--dsw-alias-label-secondary,#374151);white-space:pre-wrap;word-break:break-word}",
      ".dshe-hub-section{margin-top:22px}",
      ".dshe-hub-section-title{margin:0 0 8px;font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary,#111827)}",
      ".dshe-hub-pre{margin:0;padding:14px;max-height:320px;overflow:auto;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f6f8fa);border:1px solid var(--dsw-alias-border-l1,#eef0f2);font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#374151);white-space:pre-wrap;word-break:break-word}",
      ".dshe-hub-src{margin-top:20px;font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af);word-break:break-all}",
      ".dshe-hub-src a{color:var(--dsw-alias-brand-primary,#0969da);text-decoration:none}",
      ".dshe-hub-src a:hover{text-decoration:underline}",
      ".dshe-hub-note{margin-top:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af)}",
      /* 已安装技能库 */
      ".dshe-inst-group{margin-bottom:20px}",
      ".dshe-inst-group-title{margin:0 0 10px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#4b5563)}",
      ".dshe-inst-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(max(280px, calc((100% - 28px) / 3)), 1fr));gap:14px}",
      ".dshe-inst-card{display:flex;align-items:center;gap:12px;min-width:0;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,#eef0f2);background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-inst-tile{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9px;font-size:15px;font-weight:700;user-select:none}",
      ".dshe-inst-info{flex:1;min-width:0}",
      ".dshe-inst-name{display:flex;align-items:center;gap:6px;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#111827);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-inst-tag{flex:none;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#eff6ff);color:var(--dsw-alias-brand-primary,#1d4ed8);font-size:10.5px;font-weight:600}",
      ".dshe-inst-desc{margin-top:3px;font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-switch{box-sizing:border-box;flex:none;position:relative;width:34px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-border-l1,#d8dce1);cursor:pointer;transition:background .14s}",
      ".dshe-switch-on{background:var(--dsw-alias-state-success-primary,#16a34a)}",
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
      ".dshe-card-summon{flex:none;height:22px;padding:0 8px;border:none;border-radius:6px;background:var(--dsw-alias-state-success-primary,#16a34a);color:var(--dsw-alias-bg-base,#fff);font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap}",
      ".dshe-card-summon:hover{background:var(--dsw-alias-state-success-primary,#15803d)}",
      ".dshe-card-summon:disabled{background:var(--dsw-alias-border-l1,#d7dade);cursor:default}",
      ".dshe-avatar{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;object-fit:cover;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#eef1f4)}",
      ".dshe-avatar-letter{font-weight:600;line-height:1}",
      ".dshe-avatar-placeholder{display:inline-flex;align-items:center;justify-content:center;background:var(--dsw-alias-border-l1,#eef1f4);color:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".dshe-chips{display:flex;flex-wrap:wrap;gap:5px}",
      /* 标签 chip：加深底色 + 深色字 + 细描边，形成层次（用户反馈原样式太浅） */
      ".dshe-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:5px;border:1px solid rgba(31,35,40,.08);background:var(--dsw-alias-bg-layer-2,#e8ecf1);color:var(--dsw-alias-label-primary,#3d4451);font-size:11.5px;font-weight:500;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}",
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
      ".dshe-conn-card{display:flex;flex-direction:column;gap:9px;min-width:0;padding:16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1,#eef0f2);background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;transition:border-color .14s,box-shadow .14s}",
      ".dshe-conn-card:hover{border-color:var(--dsw-alias-border-l1,#e1e5ea);box-shadow:0 4px 16px rgba(0,0,0,.06)}",
      ".dshe-conn-head{display:flex;align-items:center;gap:10px;min-width:0}",
      ".dshe-conn-tile{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;border:1px solid var(--dsw-alias-bg-layer-2,#f2f3f5);background:var(--dsw-alias-bg-layer-1,#fff);overflow:hidden;color:var(--dsw-alias-label-secondary,#6b7280);font-size:16px;font-weight:600}",
      ".dshe-conn-tile img{width:32px;height:32px;object-fit:contain;display:block}",
      ".dshe-conn-name-btn{flex:1 1 auto;min-width:0;margin:0;padding:0;border:none;background:none;color:var(--dsw-alias-label-primary,#111827);font:inherit;font-size:15px;font-weight:600;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-conn-name-btn:hover{color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-conn-add{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-border-l1,#b9bec4);cursor:pointer;transition:background .12s,color .12s,border-color .12s}",
      ".dshe-conn-card:hover .dshe-conn-add{color:var(--dsw-alias-label-secondary,#6b7280);border-color:var(--dsw-alias-border-l1,#d8dce1)}",
      ".dshe-conn-add:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-primary,#111827);border-color:var(--dsw-alias-border-l1,#c9ced4)}",
      ".dshe-conn-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 12px;flex-wrap:wrap}",
      ".dshe-conn-views{display:inline-flex;gap:4px;padding:3px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f9fafb)}",
      ".dshe-conn-view{border:0;background:transparent;padding:5px 12px;border-radius:7px;font-size:13px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}",
      ".dshe-conn-view:hover{color:var(--dsw-alias-label-primary,#111827)}",
      ".dshe-conn-view-on{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);box-shadow:0 1px 3px rgba(0,0,0,.07);font-weight:500}",
      ".dshe-conn-new{display:inline-flex;align-items:center;gap:6px}",
      ".dshe-conn-install{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid var(--dsw-alias-brand-primary,#bfdbfe);border-radius:50%;background:var(--dsw-alias-bg-layer-2,#eff6ff);color:var(--dsw-alias-brand-primary,#2563eb);cursor:pointer;transition:background .12s,color .12s,border-color .12s}",
      ".dshe-conn-install:hover{background:var(--dsw-alias-brand-primary,#2563eb);border-color:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-bg-base,#fff)}",
      /* 不可连接的连接器（CLI / SSE / 地址含占位符）：按钮位换成置灰说明 */
      ".dshe-conn-locked{flex:none;padding:1px 6px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f9fafb);color:var(--dsw-alias-label-secondary,#9ca3af);font-size:10.5px;line-height:16px;white-space:nowrap;cursor:default}",
      ".dshe-conn-card-locked{opacity:.78}",
      ".dshe-conn-remove{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-border-l1,#c4c9cf);cursor:pointer}",
      ".dshe-conn-remove:hover{background:var(--dsw-alias-bg-layer-2,#fee2e2);color:var(--dsw-alias-state-error-primary,#dc2626)}",
      ".dshe-create-tabs{display:inline-flex;gap:4px;padding:3px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#f9fafb)}",
      ".dshe-connect-textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary,#111827);background:var(--dsw-alias-bg-layer-1,#fff);resize:vertical}",
      ".dshe-conn-desc{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary,#9ca3af);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:40px;word-break:break-word}",
      /* 已安装卡片的第二行：来源徽标 + 卸载 ×。与 head 拆开，避免把名称挤成一个字符 */
      ".dshe-conn-meta{display:flex;align-items:center;gap:8px;min-width:0;margin-top:-3px}",
      ".dshe-conn-meta .dshe-conn-remove{margin-left:auto}",
      /* 来源徽标：已安装卡片上标明「本地自定义 / 云端下载」，两种来源不同浅底色 */
      ".dshe-conn-source{flex:none;padding:1px 6px;border-radius:4px;font-size:10.5px;font-weight:600;line-height:16px;white-space:nowrap}",
      ".dshe-conn-source-manual{background:var(--dsw-alias-bg-layer-2,#eef2ff);color:var(--dsw-alias-brand-primary,#4338ca)}",
      ".dshe-conn-source-cloud{background:var(--dsw-alias-bg-layer-2,#eff6ff);color:var(--dsw-alias-brand-primary,#1d4ed8)}",
      /* 「已安装」视图下的来源细分筛选行 */
      ".dshe-conn-sources{display:flex;align-items:center;gap:6px;margin:-4px 0 12px;flex-wrap:wrap}",
      ".dshe-conn-sources-label{font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".dshe-conn-source-btn{padding:3px 9px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}",
      ".dshe-conn-source-btn:hover{color:var(--dsw-alias-label-primary,#111827);border-color:var(--dsw-alias-border-l1,#d8dce1)}",
      ".dshe-conn-source-btn-on{background:var(--dsw-alias-bg-layer-2,#eff6ff);border-color:var(--dsw-alias-brand-primary,#bfdbfe);color:var(--dsw-alias-brand-primary,#1d4ed8);font-weight:600}",
      ".dshe-conn-source-btn-on:hover{background:var(--dsw-alias-bg-layer-2,#eff6ff);border-color:var(--dsw-alias-brand-primary,#bfdbfe);color:var(--dsw-alias-brand-primary,#1d4ed8)}",
      /* 已安装视图空态：两行引导文案 */
      ".dshe-conn-empty{padding:36px 8px;text-align:center;font-size:13px;line-height:1.9;color:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".dshe-conn-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280)}",
      /* 仓库里有、但宿主加载不了的连接器（CLI / SSE）说明行：常驻在列表底部 */
      ".dshe-conn-skipped{margin-top:14px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l1,#e5e7eb);border-radius:6px;font-size:12px;line-height:1.8;color:var(--dsw-alias-label-secondary,#9ca3af)}",

      /* ---- 连接器连接弹窗（首次使用需填参数 / 需先登录） ------------------- */
      ".dshe-connect-body{display:flex;flex-direction:column;gap:14px;padding:16px 28px 8px;overflow:auto}",
      ".dshe-connect-intro{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-connect-guide{margin:0;padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fffbeb);border:1px solid var(--dsw-alias-state-warning-primary,#fde68a);font-size:13px;line-height:1.6;color:var(--dsw-alias-state-warning-primary,#92400e)}",
      ".dshe-connect-guide-ok{background:var(--dsw-alias-bg-layer-2,#f0fdf4);border-color:var(--dsw-alias-state-success-primary,#bbf7d0);color:var(--dsw-alias-state-success-primary,#15803d)}",
      ".dshe-connect-fields{display:flex;flex-direction:column;gap:12px}",
      ".dshe-connect-field{display:flex;flex-direction:column;gap:6px}",
      ".dshe-connect-label{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#374151);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
      ".dshe-connect-input{width:100%;box-sizing:border-box;height:38px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,#d1d5db);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);font-size:13px}",
      ".dshe-connect-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#0969da);box-shadow:0 0 0 2px rgba(9,105,218,.14)}",
      ".dshe-connect-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dshe-connect-note{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af);line-height:1.6}",
      ".dshe-connect-provision{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f9fafb)}",
      ".dshe-connect-paths{margin:0;padding-left:18px;font-size:12px;line-height:1.8;color:var(--dsw-alias-label-secondary,#4b5563);word-break:break-all}",
      ".dshe-connect-snippet{font-size:12px;color:var(--dsw-alias-label-secondary,#4b5563)}",
      ".dshe-connect-snippet summary{cursor:pointer;color:var(--dsw-alias-brand-primary,#2563eb)}",
      ".dshe-connect-snippet pre{margin:8px 0 0;padding:10px;max-height:180px;overflow:auto;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#374151);font-size:11px;line-height:1.5;white-space:pre}",
      ".dshe-connect-doc{font-size:12.5px;color:var(--dsw-alias-brand-primary,#0969da);text-decoration:none}",
      ".dshe-connect-doc:hover{text-decoration:underline}",

      /* ---- 技能卡片网格（横向宽卡片，2 列保证标题/描述可读） --------------- */
      /* minmax(0,1fr) 防长名撑破列宽（老教训）；横向布局在 5 列下会被压成「A..」 */
      ".dshe-skill-grid{display:grid;grid-template-columns:repeat(auto-fill, minmax(max(260px, calc((100% - 42px) / 4)), 1fr));gap:14px}",
      "@media (max-width:760px){.dshe-grid,.dshe-conn-grid,.dshe-skill-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}",
      /* 参考图：横向布局 = 左图标 + 右（标题 / 一行描述）+ 右上「+」，无底部元信息 */
      ".dshe-skill-card{display:flex;flex-direction:row;align-items:center;gap:12px;min-width:0;padding:14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,#eef0f2);background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;transition:border-color .14s,box-shadow .14s}",
      ".dshe-skill-card:hover{border-color:var(--dsw-alias-border-l1,#e1e5ea);box-shadow:0 4px 16px rgba(0,0,0,.06)}",
      ".dshe-skill-tile{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;border:1px solid rgba(0,0,0,.04);font-size:17px;font-weight:700;user-select:none}",
      ".dshe-skill-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
      ".dshe-skill-add{flex:none;align-self:flex-start;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer;transition:background .12s,color .12s,border-color .12s}",
      ".dshe-skill-card:hover .dshe-skill-add{color:var(--dsw-alias-label-secondary,#6b7280);border-color:var(--dsw-alias-border-l1,#d8dce1)}",
      ".dshe-skill-add:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-primary,#111827);border-color:var(--dsw-alias-border-l1,#c9ced4)}",
      ".dshe-skill-name{font-size:14px;font-weight:600;line-height:1.35;color:var(--dsw-alias-label-primary,#111827);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-skill-name-row{display:flex;align-items:center;gap:6px;min-width:0}",
      ".dshe-skill-name-row .dshe-skill-name{flex:1;min-width:0}",
      ".dshe-skill-ver{flex:none;padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#6b7280);font-size:10.5px;font-weight:600;line-height:1.5;white-space:nowrap}",
      ".dshe-skill-tile img,.dshe-inst-tile img{width:100%;height:100%;object-fit:cover;display:block;border-radius:inherit}",
      ".dshe-skill-desc{font-size:12.5px;line-height:1.45;color:var(--dsw-alias-label-secondary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",

      /* ---- 会话常驻专家 chip（conversation.input.left 工具栏行内槽） -------- */
      /* 对齐 WorkBuddy 工具栏原生元素：无胶囊/边框/阴影，扁平行内、安静待着 */
      ".dshe-dock{display:inline-flex;flex-wrap:nowrap;align-items:center;gap:6px;padding:0;margin:0;vertical-align:middle;min-width:0}",
      ".dshe-dock-chip{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:220px;padding:2px 4px;border:none;border-radius:6px;background:transparent;font-size:13px;font-weight:400;color:var(--dsw-alias-label-secondary,#374151);transition:background .12s}",
      ".dshe-dock-chip:hover,.dshe-dock-chip:focus-within{background:var(--dsw-alias-bg-layer-2,#f3f4f6)}",
      /* 真实头像资产（无资产时用统一中性人形占位，不按名字生成彩色圆/字母圆） */
      ".dshe-dock-avatar{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;overflow:hidden;background:var(--dsw-alias-border-l1,#eef1f4);color:var(--dsw-alias-label-secondary,#9ca3af);user-select:none}",
      ".dshe-dock-avatar img{width:16px;height:16px;object-fit:cover;display:block}",
      ".dshe-dock-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;color:var(--dsw-alias-label-secondary,#374151)}",
      ".dshe-dock-pending{flex:none;font-size:11px;color:var(--dsw-alias-state-warning-primary,#b45309);background:transparent;border-radius:0;padding:0}",
      /* × 只在 hover/focus 时出现；保留 aria-label 可访问性 */
      ".dshe-dock-remove{opacity:0;flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer;transition:opacity .12s,background .12s,color .12s}",
      ".dshe-dock-chip:hover .dshe-dock-remove,.dshe-dock-chip:focus-within .dshe-dock-remove{opacity:1}",
      ".dshe-dock-remove:hover{background:var(--dsw-alias-border-l1,#e5e7eb);color:var(--dsw-alias-label-primary,#111827)}",
      /* 会话常驻连接器 chip：约 28×28 圆角方块，只放真实品牌图标，不显示文字；
         紧跟专家 chip 之后（专家按钮旁边），可多个并列。 */
      ".dshe-dock-conn{position:relative;box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:3px;border:1px solid var(--dsw-alias-border-l1,#eef0f2);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;font-weight:600;user-select:none;transition:border-color .12s,background .12s}",
      ".dshe-dock-conn:hover,.dshe-dock-conn:focus-within{border-color:var(--dsw-alias-border-l1,#d8dce1);background:var(--dsw-alias-bg-layer-2,#f7f8fa)}",
      ".dshe-dock-conn img{width:18px;height:18px;object-fit:contain;display:block}",
      ".dshe-dock-conn-fallback{display:inline-flex;align-items:center;justify-content:center;line-height:1;color:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".dshe-dock-conn-pending{position:absolute;bottom:1px;right:1px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-warning-primary,#f59e0b)}",
      /* 右上角小 ×：只在 hover/focus 时出现，保持工具栏安静 */
      ".dshe-dock-conn-remove{position:absolute;top:-6px;right:-6px;opacity:0;display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;padding:0;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer;transition:opacity .12s,background .12s,color .12s}",
      ".dshe-dock-conn:hover .dshe-dock-conn-remove,.dshe-dock-conn:focus-within .dshe-dock-conn-remove{opacity:1}",
      ".dshe-dock-conn-remove:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}",

      /* ---- 紧凑专家选择器（conversation.input.overlay 自绘浮层） ---------- */
      /* overlayAnchor 是 height:0 的绝对定位容器；面板向上弹出，层级高于宿主菜单(100) */
      ".dshe-picker{position:absolute;bottom:calc(100% + 4px);left:8px;z-index:120;box-sizing:border-box;width:270px;max-width:calc(100% - 16px);display:flex;flex-direction:column;padding:10px;border:1px solid var(--dsw-alias-border-l1,#eef0f2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 8px 28px rgba(0,0,0,.12);font-size:13px}",
      ".dshe-picker-search{display:flex;align-items:center;gap:6px;height:34px;padding:0 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".dshe-picker-search-icon{flex:none;font-size:16px;line-height:1}",
      ".dshe-picker-input{flex:1;min-width:0;border:none;background:transparent;outline:none;font-size:13px;color:var(--dsw-alias-label-primary,#111827)}",
      ".dshe-picker-input::placeholder{color:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".dshe-picker-list{display:flex;flex-direction:column;gap:2px;max-height:240px;overflow-y:auto;padding:8px 0 6px}",
      ".dshe-picker-row{display:flex;align-items:center;gap:9px;min-width:0;width:100%;height:36px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#374151);font-size:13px;text-align:left;cursor:pointer}",
      ".dshe-picker-row:hover,.dshe-picker-row-cursor{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-picker-row-on{background:var(--dsw-alias-bg-layer-2,#F0F9F1)}",
      ".dshe-picker-row-on:hover{background:var(--dsw-alias-bg-layer-2,#F0F9F1)}",
      ".dshe-picker-avatar{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;overflow:hidden;background:var(--dsw-alias-border-l1,#eef1f4);color:var(--dsw-alias-label-secondary,#9ca3af);user-select:none}",
      /* 技能/连接器用分类图标：方形圆角 + 深一点的底色，与专家头像圆区分 */
      ".dshe-picker-avatar-cat{border-radius:7px;background:var(--dsw-alias-bg-layer-2,#e8ecf1);color:var(--dsw-alias-label-secondary,#4b5563)}",
      ".dshe-picker-avatar-tile{font-size:12px;font-weight:700;user-select:none}",
      /* 「应用」= 把技能/连接器作为结构化引用插进当前对话草稿 */
      ".dshe-card-apply{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid var(--dsw-alias-state-success-primary,#bbf7d0);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f0fdf4);color:var(--dsw-alias-state-success-primary,#15803d);cursor:pointer;transition:background .12s,color .12s}",
      ".dshe-card-apply:hover{background:var(--dsw-alias-state-success-primary,#16a34a);border-color:var(--dsw-alias-state-success-primary,#16a34a);color:var(--dsw-alias-bg-base,#fff)}",
      ".dshe-card-apply-off{background:var(--dsw-alias-bg-layer-2,#f6f7f8);border-color:var(--dsw-alias-border-l1,#e5e7eb);color:var(--dsw-alias-border-l1,#c4c9cf);cursor:not-allowed}",
      ".dshe-card-apply-off:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8);border-color:var(--dsw-alias-border-l1,#e5e7eb);color:var(--dsw-alias-border-l1,#c4c9cf)}",
      ".dshe-picker-avatar img{width:24px;height:24px;object-fit:cover;display:block}",
      ".dshe-picker-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-picker-ver{flex:none;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:10.5px;font-weight:600;white-space:nowrap}",
      ".dshe-picker-check{flex:none;color:var(--dsw-alias-state-success-primary,#16a34a);font-size:14px;font-weight:700}",
      ".dshe-picker-state{padding:14px 8px;text-align:center;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:12px}",
      ".dshe-picker-state-err{color:var(--dsw-alias-state-error-primary,#cf222e)}",
      /* 空态（只列已安装，一条都没有时）：可读中文 + 打开面板安装入口 */
      ".dshe-picker-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:18px 10px;text-align:center}",
      ".dshe-picker-empty-text{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".dshe-picker-empty-btn{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,#d8dde3);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#374151);font-size:12px;cursor:pointer}",
      ".dshe-picker-empty-btn:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8);border-color:var(--dsw-alias-border-l1,#c8cfd8)}",
      ".dshe-picker-foot{border-top:1px solid var(--dsw-alias-border-l1,#eef0f2);padding-top:6px}",
      ".dshe-picker-more{display:flex;align-items:center;gap:6px;width:100%;height:32px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#374151);font-size:13px;text-align:left;cursor:pointer}",
      ".dshe-picker-more:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      /* ---- 两级分类菜单：一级三大块带 > 箭头，二级带返回与子分组 ---- */
      ".dshe-picker-head{display:flex;align-items:center;gap:6px;padding:0 0 6px;border-bottom:1px solid var(--dsw-alias-border-l1,#eef0f2);margin-bottom:6px}",
      ".dshe-picker-back{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font-size:15px;cursor:pointer}",
      ".dshe-picker-back:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}",
      ".dshe-picker-crumb{flex:1;min-width:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#374151);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-picker-cat{display:flex;align-items:center;gap:10px;width:100%;height:38px;padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#374151);font-size:13px;text-align:left;cursor:pointer}",
      ".dshe-picker-cat:hover,.dshe-picker-cat-cursor{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-picker-cat svg{flex:none;display:block;color:var(--dsw-alias-label-secondary,#6b7280)}",
      ".dshe-picker-cat-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-picker-cat-arrow{flex:none;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:15px;line-height:1}",
      ".dshe-picker-subtabs{display:flex;gap:5px;padding:2px 0 6px}",
      ".dshe-picker-subtab{height:24px;padding:0 9px;border:1px solid transparent;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#6b7280);font-size:11.5px;font-weight:500;cursor:pointer}",
      ".dshe-picker-subtab-on{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(9,105,218,.10));border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}",

      /* ---- 通用状态 ------------------------------------------------------- */
      ".dshe-hint{padding:48px 12px;text-align:center;color:var(--dsw-alias-label-secondary,#57606a);font-size:13px}",
      ".dshe-gate{max-width:520px;margin:56px auto;padding:24px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-layer-2,#f6f8fa);text-align:center}",
      ".dshe-source{display:flex;align-items:center;gap:10px;margin:0 24px;padding:7px 12px;border-radius:8px;border:1px solid var(--dsw-alias-brand-primary,rgba(9,105,218,.25));background:var(--dsw-alias-interactive-bg-hover-solid,rgba(9,105,218,.06));color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}",
      ".dshe-source span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-source-reset{flex:none;height:22px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:11.5px;cursor:pointer}",
      ".dshe-source-reset:hover{border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-gate-title{font-size:14px;font-weight:600;margin-bottom:8px}",
      ".dshe-gate-desc{font-size:12.5px;color:var(--dsw-alias-label-secondary,#57606a);margin-bottom:16px;word-break:break-all}",
      ".dshe-gate-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#cf222e);margin-bottom:12px;word-break:break-all}",
      ".dshe-errbar{display:flex;align-items:center;gap:10px;margin:12px 0;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary,rgba(207,34,46,.35));background:var(--dsw-alias-state-error-primary,rgba(207,34,46,.06));color:var(--dsw-alias-state-error-primary,#cf222e);font-size:12.5px}",
      ".dshe-errbar span{flex:1;min-width:0;word-break:break-all}",
      ".dshe-skel{height:96px;border-radius:10px;background:linear-gradient(90deg,var(--dsw-alias-bg-layer-2,#f0f2f4) 25%,var(--dsw-alias-bg-layer-1,#f7f9fa) 50%,var(--dsw-alias-bg-layer-2,#f0f2f4) 75%);background-size:200% 100%;animation:dshe-shimmer 1.2s infinite linear}",
      "@keyframes dshe-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}",
      ".dshe-more{display:flex;justify-content:center;padding:22px 0 8px}",
      ".dshe-more-btn{height:34px;padding:0 18px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#374151);font-size:13px;cursor:pointer}",
      ".dshe-more-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l1,#d1d5db);background:var(--dsw-alias-bg-layer-2,#f9fafb)}",
      ".dshe-more-btn:disabled{opacity:.6;cursor:default}",
      ".dshe-more-note{font-size:13px;color:var(--dsw-alias-label-secondary,#9ca3af)}",

      /* ---- 详情弹窗 ------------------------------------------------------- */
      ".dshe-mask{position:fixed;top:0;right:0;bottom:0;left:0;z-index:1200;background:rgba(0,0,0,.34);display:flex;align-items:center;justify-content:center;padding:24px}",
      ".dshe-drawer{position:relative;display:flex;flex-direction:column;width:760px;max-width:100%;height:auto;max-height:88vh;background:var(--dsw-alias-bg-layer-1,#fff);border-radius:20px;box-shadow:0 28px 70px rgba(0,0,0,.2);overflow:hidden;animation:dshe-pop .18s ease-out}",
      "@keyframes dshe-pop{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}",
      "@media (prefers-reduced-motion:reduce){.dshe-drawer{animation:none}}",
      "@media (max-width:860px){.dshe-drawer{width:92vw}}",
      "@media (max-width:640px){.dshe-mask{padding:0}.dshe-drawer{width:100%;height:100%;max-height:100%;border-radius:0}}",
      ".dshe-drawer-close{position:absolute;top:20px;right:20px;z-index:3;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer}",
      ".dshe-drawer-export{position:absolute;top:20px;right:58px;z-index:3;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#4b5563);font-size:12px;cursor:pointer}",
      ".dshe-drawer-export:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-primary,#111827);border-color:var(--dsw-alias-border-l1,#d8dce1)}",
      ".dshe-drawer-close:hover{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}",
      ".dshe-drawer-body{flex:1;min-height:0;overflow:auto;padding:36px 40px 32px}",
      ".dshe-drawer-state{display:flex;align-items:center;gap:6px;padding:40px 0;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:14px}",
      ".dshe-drawer-state-err{color:var(--dsw-alias-state-error-primary,#cf222e);word-break:break-all}",
      ".dshe-drawer-foot{flex:none;display:flex;gap:8px;padding:12px 32px;border-top:1px solid var(--dsw-alias-border-l1,#eef0f2);background:var(--dsw-alias-bg-layer-1,#fff)}",

      /* ---- 设置弹窗（小号居中弹窗） ---------------------------------------- */
      ".dshe-settings{position:relative;display:flex;flex-direction:column;width:480px;max-width:100%;max-height:70vh;background:var(--dsw-alias-bg-layer-1,#fff);border-radius:16px;box-shadow:0 28px 70px rgba(0,0,0,.2);overflow:hidden;animation:dshe-pop .18s ease-out}",
      "@media (max-width:640px){.dshe-settings{width:100%;height:100%;max-height:100%;border-radius:0}}",
      ".dshe-settings-title{flex:none;margin:0;padding:22px 28px 0;font-size:18px;font-weight:700;color:var(--dsw-alias-label-primary,#111827)}",
      ".dshe-settings-field{flex:1;min-height:0;overflow:auto;padding:16px 28px 8px}",
      ".dshe-settings-label{display:block;margin-bottom:6px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#374151)}",
      ".dshe-settings-input{width:100%;box-sizing:border-box;height:38px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,#d1d5db);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
      ".dshe-settings-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#0969da);box-shadow:0 0 0 2px rgba(9,105,218,.14)}",
      ".dshe-settings-input-err{border-color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dshe-settings-hint{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".dshe-settings-branch-row{display:flex;align-items:center;gap:8px}",
      ".dshe-settings-branch-row .dshe-settings-input{flex:1;min-width:0}",
      ".dshe-settings-branch-row .dshe-btn{flex:none;white-space:nowrap}",
      ".dshe-settings-check{display:flex;align-items:center;gap:8px;margin:8px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary,#64748b);cursor:pointer}",
      ".dshe-settings-auth-row{display:flex;align-items:center;gap:8px}",
      ".dshe-settings-auth-row .dshe-settings-input{flex:1;min-width:0}",
      ".dshe-settings-hint-err{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dshe-settings-note{margin:10px 0 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fffbeb);border:1px solid var(--dsw-alias-state-warning-primary,#fde68a);font-size:12px;color:var(--dsw-alias-state-warning-primary,#92400e)}",
      ".dshe-settings-error{flex:1;min-height:0;overflow:auto;padding:16px 28px;font-size:13px;color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dshe-settings-foot{flex:none;display:flex;align-items:center;gap:8px;padding:14px 28px;border-top:1px solid var(--dsw-alias-border-l1,#eef0f2);background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-settings-foot-gap{flex:1}",
      /* ---- 设置：内置技能开关（浅色主题，原生 checkbox + 自绘轨道） ---- */
      ".dshe-settings-switch{display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none}",
      ".dshe-settings-switch-input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}",
      ".dshe-settings-switch-track{position:relative;flex:none;display:inline-block;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l1,#d8dde3);transition:background .15s ease-out}",
      ".dshe-settings-switch-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .15s ease-out}",
      ".dshe-settings-switch-on .dshe-settings-switch-track{background:var(--dsw-alias-state-success-primary,#16a34a)}",
      ".dshe-settings-switch-on .dshe-settings-switch-knob{transform:translateX(16px)}",
      ".dshe-settings-switch-text{font-size:13px;color:var(--dsw-alias-label-secondary,#374151)}",
      ".dshe-settings-switch-input:disabled ~ .dshe-settings-switch-track{opacity:.5}",

      /* ---- 详情：头部 ----------------------------------------------------- */
      ".dshe-detail-hero{display:flex;align-items:flex-start;gap:20px;padding-right:26px}",
      ".dshe-detail-titles{flex:1;min-width:0}",
      ".dshe-detail-line{display:flex;align-items:baseline;flex-wrap:wrap;min-width:0}",
      /* 22px 是为了让「高级开发工程师 | 吴八哥」在 460px 抽屉里排成一行 */
      ".dshe-detail-main{font-size:22px;font-weight:700;line-height:1.32;color:var(--dsw-alias-label-primary,#111827);word-break:break-word}",
      /* 竖线与副标题绑成一个整体：换行时「| 人名」一起走，不会留个竖线吊在行尾 */
      ".dshe-detail-sub-group{display:inline-flex;align-items:baseline;min-width:0;max-width:100%;white-space:nowrap;overflow:hidden}",
      ".dshe-detail-sep{flex:none;margin:0 8px;color:var(--dsw-alias-border-l1,#d1d5db);font-size:20px;font-weight:300;line-height:1.32}",
      ".dshe-detail-sub{min-width:0;font-size:20px;font-weight:400;line-height:1.32;color:var(--dsw-alias-label-secondary,#9ca3af);overflow:hidden;text-overflow:ellipsis}",
      ".dshe-cta{display:inline-flex;align-items:center;justify-content:center;gap:6px;margin-top:12px;height:38px;padding:0 22px;border:none;border-radius:10px;background:var(--dsw-alias-label-primary,#111);color:var(--dsw-alias-bg-base,#fff);font-size:14px;font-weight:600;cursor:pointer}",
      ".dshe-cta:hover:not(:disabled){opacity:.88}",
      ".dshe-cta:disabled{background:var(--dsw-alias-border-l1,#d7dade);cursor:default}",

      /* ---- 详情：正文 ----------------------------------------------------- */
      ".dshe-detail-desc{margin:24px 0 0;font-size:15px;line-height:1.75;color:var(--dsw-alias-label-secondary,#374151);white-space:pre-wrap;word-break:break-word}",
      ".dshe-desc-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal}",
      ".dshe-expand{display:inline-flex;align-items:center;gap:4px;margin-top:8px;padding:0;border:none;background:none;color:var(--dsw-alias-label-secondary,#6b7280);font-size:14px;cursor:pointer}",
      ".dshe-expand:hover{color:var(--dsw-alias-label-primary,#111827)}",
      ".dshe-tagrow{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}",
      ".dshe-tag{display:inline-flex;align-items:center;max-width:100%;padding:6px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#374151);font-size:14px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dshe-divider{height:1px;margin:24px 0;background:var(--dsw-alias-border-l1,#eef0f2)}",

      /* ---- 详情：数据条 --------------------------------------------------- */
      ".dshe-stats{display:grid;gap:10px}",
      ".dshe-stat{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:6px;min-width:0;padding:0 2px;text-align:center}",
      ".dshe-stat-value{display:flex;align-items:center;justify-content:center;gap:6px;max-width:100%;font-size:17px;font-weight:600;line-height:1.3;color:var(--dsw-alias-label-primary,#111827)}",
      ".dshe-stat-text{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      /* 长值（传输方式 / 集合名）降字号，保证 streamableHttp、anthropics-skills 不截断 */
      ".dshe-stat-text[data-compact]{font-size:11px;font-weight:600;letter-spacing:0}",
      ".dshe-stat-label{font-size:13px;line-height:1.3;color:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".dshe-icon{display:inline-flex;align-items:center;justify-content:center;line-height:0}",
      ".dshe-stat-icon{flex:none;color:var(--dsw-alias-label-secondary,#6b7280)}",

      /* ---- 详情：区块 ----------------------------------------------------- */
      ".dshe-block{margin:28px 0 0}",
      ".dshe-block-title{display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:16px;font-weight:700;line-height:1.4;color:var(--dsw-alias-label-primary,#111827)}",
      ".dshe-block-icon{flex:none;color:var(--dsw-alias-label-secondary,#6b7280)}",
      ".dshe-muted{font-size:14px;line-height:1.6;color:var(--dsw-alias-label-secondary,#9ca3af)}",

      /* ---- 详情：提示行 --------------------------------------------------- */
      ".dshe-prompt-row{display:flex;align-items:center;gap:12px;margin-bottom:10px;padding:16px 18px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);font-size:15px;line-height:1.6;color:var(--dsw-alias-label-secondary,#374151);cursor:pointer;transition:background .12s}",
      ".dshe-prompt-row:last-child{margin-bottom:0}",
      ".dshe-prompt-row:hover{background:var(--dsw-alias-border-l1,#eef0f2)}",
      ".dshe-prompt-text{flex:1;min-width:0;word-break:break-word}",
      ".dshe-prompt-copy{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer;transition:background .12s,color .12s}",
      ".dshe-prompt-copy:hover{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#374151)}",

      /* ---- 详情：团队成员 ------------------------------------------------- */
      /* 弹窗 760px、内容宽 680px，3 列每格约 217px，长职业名也放得下 */
      ".dshe-member-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}",
      "@media (max-width:640px){.dshe-member-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}",
      ".dshe-member-item{display:flex;align-items:center;gap:10px;min-width:0;padding:6px;border-radius:10px;transition:background .12s}",
      ".dshe-member-item:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-member-info{flex:1;min-width:0}",
      ".dshe-member-name{display:flex;align-items:center;gap:5px;min-width:0;font-size:14px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#111827)}",
      ".dshe-member-name-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-lead-chip{flex:none;display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f0f1f3);color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;font-weight:500;line-height:1.4;white-space:nowrap}",
      ".dshe-member-prof{font-size:13px;line-height:1.4;color:var(--dsw-alias-label-secondary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",

      /* ---- 详情：技能行 / 说明 / 更多 -------------------------------------- */
      ".dshe-skill-line{display:flex;align-items:center;gap:10px;width:100%;margin-bottom:8px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-secondary,#374151);font-size:14px;text-align:left;transition:background .12s}",
      ".dshe-skill-line:last-child{margin-bottom:0}",
      ".dshe-skill-line:hover{background:var(--dsw-alias-border-l1,#eef0f2)}",
      ".dshe-skill-main{display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:0;border:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
      ".dshe-skill-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-secondary,#9ca3af)}",
      ".dshe-skill-dot-local{background:var(--dsw-alias-state-success-primary,#1a7f37)}",
      ".dshe-skill-dot-repo{background:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-skill-dot-missing{background:var(--dsw-alias-border-l1,#c4c9cf)}",
      ".dshe-skill-fetch{flex:none;height:26px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-brand-primary,#0969da);font-size:12px;cursor:pointer}",
      ".dshe-skill-fetch:hover{border-color:var(--dsw-alias-brand-primary,#0969da);background:var(--dsw-alias-interactive-bg-hover-solid,rgba(9,105,218,.06))}",
      /* 限定在详情抽屉的技能行内：不限定会污染技能卡片的标题（曾被 max-width:46% 压成半截） */
      ".dshe-skill-line .dshe-skill-name{flex:none;max-width:46%;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-skill-path{flex:1;min-width:0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-readme{max-height:360px;overflow:auto;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1,#eef0f2);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fafbfc);font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary,#374151);white-space:pre-wrap;word-break:break-word}",
      ".dshe-more-box{padding:14px 18px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;line-height:1.7;color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-all}",
      ".dshe-more-box div+div{margin-top:2px}",
      ".dshe-config{position:relative}",
      /* JSON 保持原始缩进，太长就横向滚动（换行会把缩进打断得更难看） */
      ".dshe-config-pre{margin:0;max-height:320px;overflow:auto;padding:14px 44px 14px 16px;border:1px solid var(--dsw-alias-border-l1,#eef0f2);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fafbfc);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary,#111827);white-space:pre;tab-size:2}",
      ".dshe-config-copy{position:absolute;top:8px;right:8px;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l1,#eef0f2);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer}",
      ".dshe-config-copy:hover{border-color:var(--dsw-alias-border-l1,#e1e5ea);color:var(--dsw-alias-label-primary,#111827)}",

      /* ---- 其它 ----------------------------------------------------------- */
      ".dshe-toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:1300;max-width:70vw;padding:9px 16px;border-radius:8px;background:rgba(31,35,40,.94);color:#fff;font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.25);word-break:break-all}",
      ".dshe-panel-icon{display:inline-flex;align-items:center;justify-content:center;line-height:0;color:currentColor}",
      ".dshe-panel-icon-on{color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-spin{display:inline-block;width:11px;height:11px;margin-right:6px;vertical-align:-1px;border:1.6px solid currentColor;border-right-color:transparent;border-radius:50%;animation:dshe-spin .7s linear infinite}",
      "@keyframes dshe-spin{to{transform:rotate(360deg)}}",

      /* ---- Composer 工具栏按钮 --------------------------------------------- */
      ".dshe-composer-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;transition:background .12s,color .12s}",
      ".dshe-composer-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}",

      /* ---- 统一「+」安装图标 -----------------------------------------------
         SkillHub 商店卡片 / 详情抽屉 / 连接器卡片共用，浅色主题方角小按钮，
         只放一个 plus 图标；安装中用 dshe-spin，不带任何可见文字。 */
      ".dshe-add-btn{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-brand-primary,#0969da);font-size:12px;font-weight:600;cursor:pointer;transition:background .12s,color .12s,border-color .12s}",
      ".dshe-add-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid,rgba(9,105,218,.08));border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-add-btn:disabled{opacity:.6;cursor:default}",
      ".dshe-add-btn .dshe-icon{display:inline-flex;align-items:center;justify-content:center}",
      ".dshe-add-btn .dshe-spin{margin-right:0}",
      ".dshe-conn-install.dshe-add-btn{width:28px;height:28px;border-radius:50%}",
      ".dshe-hub-get.dshe-add-btn{border:1px solid var(--dsw-alias-border-l1,#d0d7de);white-space:nowrap}",
      ".dshe-hub-hero-get.dshe-add-btn{height:28px;border-radius:7px}",

      /* ---- 文件夹导入弹窗 --------------------------------------------------- */
      ".dshe-folder-body{padding:0 20px 4px;max-height:62vh;overflow:auto}",
      ".dshe-folder-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0}",
      ".dshe-folder-check{margin-top:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f9fafb);font-size:12px;line-height:1.7;color:var(--dsw-alias-label-primary,#374151)}",
      ".dshe-folder-check-title{font-weight:600;margin-bottom:4px}",
      ".dshe-folder-line{padding:2px 0;word-break:break-all}",
      ".dshe-folder-line-ok{color:var(--dsw-alias-state-success-primary,#15803d)}",
      ".dshe-folder-line-bad{color:var(--dsw-alias-state-error-primary,#b42318)}",
      ".dshe-folder-ok{margin-top:10px;color:var(--dsw-alias-state-success-primary,#15803d);font-size:12.5px}",

      /* ---- 个人工作台（侧栏独立面板） --------------------------------------
         布局：左侧文件树（工作台 HTML + 它下面的 CSV 数据表）+ 右侧整页 iframe。
         工作台内部的菜单 / 按钮 / 配色 / 排版全部由 HTML 自己渲染，插件不代画；
         插件只提供顶部一条自己的工具条（刷新 / 设置）。 */
      ".dshe-wb{display:flex;flex-direction:column;gap:8px;min-height:0;min-width:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:14px;line-height:1.5}",
      /* 工作台面板：整块撑满宿主给的高度，body 不再自己滚动 / 留底部空白（滚动交给左侧文件树）。 */
      ".dshe-root-wb .dshe-body{overflow:hidden;padding:14px 16px 12px;display:flex;flex-direction:column;gap:0}",
      ".dshe-root-wb .dshe-body>.dshe-wb{flex:1;min-height:0}",
      ".dshe-wb-main{display:flex;gap:8px;flex:1;min-height:0;min-width:0}",

      /* 左侧文件树 */
      ".dshe-wb-side{flex:none;width:224px;display:flex;flex-direction:column;gap:4px;min-width:0;min-height:0;padding:8px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-wb-side-title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#57606a);letter-spacing:.02em;padding:2px 6px 6px}",
      /* 侧栏标题行：标题 + 收起 */
      ".dshe-wb-side-head{display:flex;align-items:center;gap:2px}",
      ".dshe-wb-side-head .dshe-wb-side-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      /* 目录树：文件夹行可展开 / 可接收拖入的工作台 */
      ".dshe-wb-folder{display:flex;flex-direction:column;gap:1px;min-width:0}",
      ".dshe-wb-folder-row{display:flex;align-items:center;gap:1px;min-width:0}",
      ".dshe-wb-folder-btn{flex:1;display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font-size:12.5px;text-align:left;cursor:pointer;min-width:0}",
      ".dshe-wb-folder-btn:hover{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}",
      ".dshe-wb-folder-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-wb-folder-drop{background:var(--dsw-alias-interactive-bg-hover-solid,#e8f0ff);box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-wb-folder-children{display:flex;flex-direction:column;gap:1px;padding-left:14px}",
      ".dshe-wb-space-head{padding:6px 8px 2px;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#57606a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      /* 右键「移动到目录」小菜单（贴光标，不做居中弹窗） */
      ".dshe-wb-movemask{position:fixed;inset:0;z-index:60;background:transparent}",
      ".dshe-wb-movemenu{position:fixed;min-width:176px;max-height:60vh;overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 10px 28px rgba(0,0,0,.16)}",
      ".dshe-wb-movetitle{padding:4px 8px 6px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-wb-moveitem{display:flex;align-items:center;gap:6px;width:100%;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px;text-align:left;cursor:pointer}",
      ".dshe-wb-moveitem:hover{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}",
      ".dshe-wb-moveitem-on{color:var(--dsw-alias-brand-primary,#0969da);font-weight:500}",
      ".dshe-wb-tree{display:flex;flex-direction:column;gap:1px;flex:1;min-height:0;overflow:auto}",
      ".dshe-wb-group{display:flex;flex-direction:column;gap:1px;min-width:0;cursor:grab}",
      ".dshe-wb-group:active{cursor:grabbing}",
      ".dshe-wb-group-drop{box-shadow:inset 0 2px 0 var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-wb-node-row{display:flex;align-items:center;gap:1px;min-width:0}",
      ".dshe-wb-caret{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:26px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer}",
      ".dshe-wb-caret-empty{visibility:hidden}",
      ".dshe-wb-node{flex:1;display:flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;text-align:left;cursor:pointer;min-width:0}",
      ".dshe-wb-node:hover{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}",
      ".dshe-wb-node-on{background:var(--dsw-alias-interactive-bg-hover-solid,#e8f0ff);color:var(--dsw-alias-brand-primary,#0969da);font-weight:500}",
      ".dshe-wb-node-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-wb-leaves{display:flex;flex-direction:column;gap:1px;padding-left:19px}",
      ".dshe-wb-leaf{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:6px;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;min-width:0}",
      ".dshe-wb-leaf:hover{background:var(--dsw-alias-bg-layer-2,#f6f8fa)}",
      ".dshe-wb-leaf-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      /* 宽度分隔条：拖动改左栏宽度；hover / 聚焦时高亮，双击复位 */
      ".dshe-wb-resizer{flex:none;width:6px;margin:0 -3px;border-radius:3px;background:transparent;cursor:col-resize;position:relative;z-index:1}",
      ".dshe-wb-resizer:hover,.dshe-wb-resizer:focus-visible{background:var(--dsw-alias-brand-primary,#0969da);outline:none}",

      /* 右侧整页：iframe 铺满，工具栏/冲突条只占自己那一行 */
      ".dshe-wb-stage{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;gap:6px}",
      ".dshe-wb-frame{flex:1;min-width:0;min-height:0;width:100%;height:100%;border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-wb-alert{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border:1px solid var(--dsw-alias-state-warning-primary,#fde68a);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#fffbeb);color:var(--dsw-alias-state-warning-primary,#92400e);font-size:12.5px}",
      ".dshe-wb-alert .dshe-btn{height:26px;font-size:12px}",
      ".dshe-wb-empty{display:flex;flex-direction:column;align-items:flex-start;gap:10px;flex:1;min-height:240px;padding:20px;border:1px dashed var(--dsw-alias-border-l1,#d0d7de);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-wb-empty-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-wb-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a);word-break:break-all}",
      ".dshe-wb-errors{font-size:12px;color:var(--dsw-alias-state-error-primary,#cf222e);word-break:break-all}",

      /* ---- 顶部固定工具条：第一行 = 当前工作台名称 + 插件自己的操作 ---- */
      ".dshe-wb-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;padding:7px 12px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-wb-toolbar-main{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;min-width:0;flex:1}",
      ".dshe-wb-toolbar-title{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,#1f2328);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-wb-toolbar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}",
      /* 自动刷新开关：文字 + 现有 dshe-switch（沿用主面板开关样式） */
      ".dshe-wb-autosync{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a);user-select:none}",

      /* ---- 独立「工作台设置」弹窗 ----------------------------------------- */
      ".dshe-wb-settings-sec{padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1,#d0d7de)}",
      ".dshe-wb-settings-sec-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);margin-bottom:8px}",
      ".dshe-wb-settings-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshe-wb-settings-status{font-size:12px;padding:6px 10px;border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#d0d7de);color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-wb-settings-status-bad{color:var(--dsw-alias-state-error-primary,#cf222e);border-color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dshe-wb-settings-status-ok{color:var(--dsw-alias-brand-primary,#0969da);border-color:var(--dsw-alias-brand-primary,#0969da)}",
      /* ---- dsh 设置页（settings.section）：四个分区的卡片与导航 ---- */
      /* ---- dsh 设置页「Buddy 工作台」：卡片外壳 + 头部 + 横向分区导航 ---- */
      ".dshe-setpage{display:flex;flex-direction:column;gap:14px;min-width:0;padding:18px 20px 20px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-setpage-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
      ".dshe-setpage-avatar{flex:none;width:40px;height:40px;border-radius:10px;object-fit:cover;background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-setpage-head-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
      ".dshe-setpage-title{margin:0;font-size:18px;font-weight:600;line-height:1.3;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-setpage-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-setpage-head-actions{display:flex;align-items:center;gap:14px;flex:none;flex-wrap:wrap}",
      ".dshe-setpage-effects{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#57606a);user-select:none}",
      ".dshe-setpage-star{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da);background:transparent;font-size:12.5px;font-weight:500;text-decoration:none;cursor:pointer}",
      ".dshe-setpage-star:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-setpage-nav{display:flex;gap:18px;flex-wrap:wrap;padding:0 2px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}",
      ".dshe-setpage-tab{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 0 2px;border:none;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font-size:13px;cursor:pointer}",
      ".dshe-setpage-tab:hover{color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-setpage-tab-on{color:var(--dsw-alias-label-primary,#1f2328);border-bottom-color:var(--dsw-alias-brand-primary,#0969da);font-weight:600}",
      ".dshe-setpage-body{min-width:0}",
      /* 视觉特效：只有开关打开才生效；关掉时整页零动画。系统开「减少动态效果」时一律不动。
         设计原则：一个主题色、两层流光、一种位移 —— 可见颜色取自宿主 token，深浅色自动跟随。
         1) 常驻（infinite）：外框流光 + 外框呼吸 + 头像光环 + Star 脉冲 + 选中页签微光 + 卡片流光，
            打开设置页什么都不做也在持续变化，不依赖切分区，也不依赖 hover。
         2) 入场：分区卡片整体上滑（26px / .5s 弹性），内部内容只做错峰淡入，
            父子不再叠加位移，避免抖动；收尾一次性柔光高亮。
         3) 悬浮：卡片 / 按钮 / 头像 / 页签大幅抬起。 */
      "@keyframes dshe-setpage-rise{0%{opacity:0;transform:translateY(26px) scale(.97)}60%{opacity:1}100%{opacity:1;transform:none}}",
      "@keyframes dshe-setpage-fade{from{opacity:0}to{opacity:1}}",
      "@keyframes dshe-setpage-flash{0%{box-shadow:0 0 0 0 rgba(9,105,218,0)}35%{box-shadow:0 0 30px 8px rgba(9,105,218,.26)}100%{box-shadow:0 0 0 0 rgba(9,105,218,0)}}",
      "@keyframes dshe-setpage-flow{from{background-position:0% 50%}to{background-position:100% 50%}}",
      "@keyframes dshe-setpage-breath{0%,100%{box-shadow:0 0 0 1px rgba(9,105,218,.05),0 6px 18px rgba(9,105,218,.04)}50%{box-shadow:0 0 0 1px rgba(9,105,218,.22),0 12px 38px rgba(9,105,218,.16)}}",
      "@keyframes dshe-setpage-halo{0%,100%{box-shadow:0 0 0 0 rgba(9,105,218,.42),0 0 10px 0 rgba(9,105,218,.08)}50%{box-shadow:0 0 0 7px rgba(9,105,218,.10),0 0 24px 6px rgba(9,105,218,.36)}}",
      "@keyframes dshe-setpage-pulse{0%,100%{box-shadow:0 0 0 0 rgba(9,105,218,.45);opacity:.95}50%{box-shadow:0 0 0 10px rgba(9,105,218,0);opacity:.3}}",
      "@keyframes dshe-setpage-underline{0%,100%{box-shadow:0 0 0 0 rgba(9,105,218,0)}50%{box-shadow:0 0 10px 2px rgba(9,105,218,.8)}}",
      "@keyframes dshe-setpage-tabglow{0%,100%{text-shadow:0 0 0 rgba(9,105,218,0)}50%{text-shadow:0 0 12px rgba(9,105,218,.55)}}",
      "@keyframes dshe-setpage-sweep{from{transform:scaleX(0)}to{transform:scaleX(1)}}",
      "@keyframes dshe-setpage-twinkle{0%,100%{transform:scale(1) rotate(0)}50%{transform:scale(1.3) rotate(-10deg)}}",
      /* 流光颜色用宿主的 hover 底色 token：浅色外观是一层淡蓝、深色外观是一层柔光，
         不会像写死的蓝色那样在深色主题下发灰。只画外框 + 卡片两层，避免四条光带同时扫。 */
      ".dshe-setpage.dshe-setpage-effects,.dshe-setpage-effects .dshe-setpage-body > *{background-image:linear-gradient(105deg,rgba(0,0,0,0) 36%,var(--dsw-alias-interactive-bg-hover-solid,rgba(9,105,218,.10)) 48%,rgba(0,0,0,0) 60%);background-size:240% 100%;background-repeat:no-repeat}",
      ".dshe-setpage.dshe-setpage-effects{animation:dshe-setpage-flow 5.2s linear infinite alternate,dshe-setpage-breath 3.2s ease-in-out infinite}",
      ".dshe-setpage-effects .dshe-setpage-body > *{animation:dshe-setpage-rise .5s cubic-bezier(.34,1.56,.64,1) backwards,dshe-setpage-flash .9s ease-out .06s,dshe-setpage-flow 5.2s linear infinite alternate}",
      ".dshe-setpage-effects .dshe-setpage-body > :nth-child(2){animation-delay:.09s}",
      ".dshe-setpage-effects .dshe-setpage-body > :nth-child(3){animation-delay:.18s}",
      ".dshe-setpage-effects .dshe-setpage-body > :nth-child(n+4){animation-delay:.27s}",
      /* 二级内容只淡入、不再位移：父层滑入 + 子层错峰显影，层次清楚也不会抖。 */
      ".dshe-setpage-effects .dshe-setpage-body > * > *{animation:dshe-setpage-fade .5s ease-out backwards}",
      ".dshe-setpage-effects .dshe-setpage-body > * > :nth-child(2){animation-delay:.09s}",
      ".dshe-setpage-effects .dshe-setpage-body > * > :nth-child(3){animation-delay:.18s}",
      ".dshe-setpage-effects .dshe-setpage-body > * > :nth-child(n+4){animation-delay:.27s}",
      /* 头部：头像常驻呼吸光环；Star 用 ::after 做常驻脉冲光晕（不占按钮自身的 box-shadow）。 */
      ".dshe-setpage-effects .dshe-setpage-avatar{animation:dshe-setpage-halo 2.4s ease-in-out infinite;transition:transform .3s cubic-bezier(.34,1.56,.64,1)}",
      ".dshe-setpage-effects .dshe-setpage-avatar:hover{transform:translateY(-4px) rotate(-8deg) scale(1.16)}",
      ".dshe-setpage-effects .dshe-setpage-star{position:relative;transition:transform .24s cubic-bezier(.34,1.56,.64,1),box-shadow .24s,background .24s,border-color .24s}",
      ".dshe-setpage-effects .dshe-setpage-star::after{content:\"\";position:absolute;top:-2px;right:-2px;bottom:-2px;left:-2px;border-radius:inherit;pointer-events:none;animation:dshe-setpage-pulse 2.1s ease-in-out infinite}",
      ".dshe-setpage-effects .dshe-setpage-star:hover{transform:translateY(-5px) scale(1.04);background:var(--dsw-alias-bg-layer-2,#f6f7f8);box-shadow:0 12px 26px rgba(9,105,218,.34)}",
      ".dshe-setpage-effects .dshe-setpage-star:hover svg{animation:dshe-setpage-twinkle .6s ease-in-out}",
      /* 分区页签：下划线从左划出后常驻微光，选中文字呼吸，悬浮抬 4px。 */
      ".dshe-setpage-effects .dshe-setpage-tab{transition:color .16s,transform .24s cubic-bezier(.34,1.56,.64,1)}",
      ".dshe-setpage-effects .dshe-setpage-tab:hover{transform:translateY(-4px)}",
      ".dshe-setpage-effects .dshe-setpage-tab-on{border-bottom-color:transparent;position:relative;animation:dshe-setpage-tabglow 2.6s ease-in-out infinite}",
      ".dshe-setpage-effects .dshe-setpage-tab-on::after{content:\"\";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,#0969da);transform-origin:left center;animation:dshe-setpage-sweep .35s cubic-bezier(.16,1,.3,1) both,dshe-setpage-underline 2s ease-in-out .35s infinite}",
      /* 卡片与卡片内按钮：位移 6px / 3px，阴影与描边同步明显变化。 */
      ".dshe-setpage-effects .dshe-set-card{transition:transform .26s cubic-bezier(.34,1.56,.64,1),box-shadow .26s,border-color .26s}",
      ".dshe-setpage-effects .dshe-set-card:hover{transform:translateY(-6px) scale(1.012);border-color:var(--dsw-alias-brand-primary,#0969da);box-shadow:0 18px 38px rgba(9,105,218,.20)}",
      ".dshe-setpage-effects .dshe-set-card .dshe-btn{transition:transform .2s ease-out,background .2s,border-color .2s,box-shadow .2s}",
      ".dshe-setpage-effects .dshe-set-card .dshe-btn:hover:not(:disabled){transform:translateY(-3px);box-shadow:0 8px 18px rgba(9,105,218,.22)}",
      /* 减少动态效果：所有常驻 / 入场动画与位移一律归零，功能不受影响。 */
      "@media (prefers-reduced-motion:reduce){.dshe-setpage.dshe-setpage-effects,.dshe-setpage-effects .dshe-setpage-body > *,.dshe-setpage-effects .dshe-setpage-body > * > *,.dshe-setpage-effects .dshe-setpage-avatar,.dshe-setpage-effects .dshe-setpage-star::after,.dshe-setpage-effects .dshe-setpage-tab-on,.dshe-setpage-effects .dshe-setpage-tab-on::after,.dshe-setpage-effects .dshe-setpage-star:hover svg{animation:none;background-image:none}.dshe-setpage-effects .dshe-setpage-tab:hover,.dshe-setpage-effects .dshe-setpage-avatar:hover,.dshe-setpage-effects .dshe-setpage-star:hover,.dshe-setpage-effects .dshe-set-card:hover,.dshe-setpage-effects .dshe-set-card .dshe-btn:hover:not(:disabled){transform:none}}",
      ".dshe-set-card{display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-set-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".dshe-set-card-title{margin:0;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-set-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-secondary,#57606a);font-size:11.5px}",
      ".dshe-set-desc{margin:0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-set-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshe-set-row .dshe-btn{display:inline-flex;align-items:center;gap:6px;text-decoration:none}",
      ".dshe-set-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-set-history{display:flex;flex-direction:column;gap:4px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,#e5e7eb)}",
      ".dshe-set-history-title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-set-history-item{display:flex;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-set-history-time{margin-left:auto;opacity:.75}",
      ".dshe-set-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}",
      ".dshe-set-bad{color:var(--dsw-alias-state-error-primary,#cf222e)}",
      /* 远程配置：URL 输入行、状态块 */
      ".dshe-rc-url{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dshe-rc-url .dshe-settings-input{flex:1;min-width:220px}",
      ".dshe-rc-status{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-rc-status-on{border-color:var(--dsw-alias-state-success-primary,#16a34a)}",
      /* 工作台 CSV 网格视图（点击左侧数据表进入）：整块占满右侧 */
      ".dshe-wb-gridview{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;padding:12px;overflow:auto;background:var(--dsw-alias-bg-base,#f7f8fa)}",
      ".dshe-wb-gridbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".dshe-wb-gridtitle{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-wb-griddirty{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#fff7e6);color:var(--dsw-alias-state-warning-primary,#92400e);font-size:11.5px}",
      ".dshe-wb-gridactions{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}",
      ".dshe-wb-gridview .dshe-lib-grid-wrap{flex:1;min-height:0}",
      ".dshe-wb-gridth{display:flex;align-items:center;height:30px;padding:0 8px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);white-space:nowrap}",
      ".dshe-wb-gridid{display:flex;align-items:center;height:30px;padding:0 8px;font:11px ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary,#57606a)}",
      /* 左侧 CSV 叶子：可点击进入网格；选中态与工作台节点一致 */
      ".dshe-wb-leaf-btn{width:100%;border:0;background:transparent;text-align:left;cursor:pointer;font:inherit;color:inherit}",
      ".dshe-wb-leaf-btn:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-wb-leaf-on{background:var(--dsw-alias-interactive-bg-hover-solid,#e8f0ff);color:var(--dsw-alias-brand-primary,#0969da)}",
      /* embedded：同一个设置弹窗组件挂进设置页时退化成普通区块 */
      ".dshe-mask-embedded{position:static;inset:auto;padding:0;background:transparent;z-index:auto;display:block;overflow:visible}",
      ".dshe-settings-embedded{position:static;width:auto;max-width:100%;max-height:none;padding:0;border:none;background:transparent;box-shadow:none;overflow:visible}",
      ".dshe-settings-embedded .dshe-drawer-close,.dshe-settings-embedded .dshe-settings-title{display:none}",
      /* 插件介绍弹窗 */
      ".dshe-intro{position:relative;width:min(560px,92vw);max-height:min(78vh,640px);overflow:auto;padding:24px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-intro-dots{display:flex;gap:5px;margin-bottom:14px}",
      ".dshe-intro-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l1,#d0d7de)}",
      ".dshe-intro-dot-on{background:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-intro-title{margin:0 0 10px;font-size:17px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-intro-list{margin:0;padding-left:18px;font-size:12.5px;line-height:1.9;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-intro-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px}",
      ".dshe-intro-step{font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-intro-actions{display:flex;gap:8px}",
      /* ---- 在线资料库面板：整屏左树 + 右列表，颜色全部走宿主 token ---- */
      ".dshe-root-lib .dshe-body{overflow:hidden;padding:14px 16px 12px;display:flex;gap:0;flex-direction:row}",
      ".dshe-lib{display:flex;gap:12px;flex:1;min-height:0;min-width:0;background:var(--dsw-alias-bg-base,#f7f8fa)}",
      ".dshe-lib-side{flex:none;width:262px;display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;padding:16px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);overflow:auto}",
      /* 资料库左栏宽度分隔条：拖动改宽度，双击复位（与个人工作台一致） */
      ".dshe-lib-resizer{flex:none;width:6px;margin:0 -3px;border-radius:3px;background:transparent;cursor:col-resize;position:relative;z-index:1}",
      ".dshe-lib-resizer:hover,.dshe-lib-resizer:focus-visible{background:var(--dsw-alias-brand-primary,#0969da);outline:none}",
      /* 折叠后的窄条：资料库 / 个人工作台共用，只留展开按钮 + 竖排文字 */
      ".dshe-side-rail{flex:none;width:32px;display:flex;flex-direction:column;align-items:center;gap:10px;padding:12px 0;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-side-rail-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer}",
      ".dshe-side-rail-btn:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-side-rail-label{writing-mode:vertical-rl;font-size:11px;letter-spacing:.08em;color:var(--dsw-alias-label-secondary,#57606a);user-select:none}",
      /* 侧栏标题行里的折叠按钮 */
      ".dshe-side-fold{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer}",
      ".dshe-side-fold:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-lib-head-actions{flex:none;display:flex;align-items:center;gap:2px}",
      ".dshe-lib-head{display:flex;align-items:center;gap:9px;padding:0 4px}",
      ".dshe-lib-logo{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:var(--dsw-alias-brand-primary,#4c6ef5);color:var(--dsw-alias-bg-base,#fff);font-size:11px;font-weight:700;letter-spacing:.02em}",
      ".dshe-lib-title{flex:1;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-lib-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover-solid,#e8f0ff);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-lib-search-row{display:flex;align-items:center;gap:6px;padding:0 4px}",
      ".dshe-lib-search-ico{display:inline-flex;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-search{flex:1;min-width:0;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px}",
      ".dshe-lib-search-btn{flex:none;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;cursor:pointer}",
      ".dshe-lib-quicks{display:flex;flex-direction:column;gap:2px}",
      ".dshe-lib-quick{display:flex;align-items:center;gap:9px;width:100%;height:32px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;text-align:left;cursor:pointer}",
      ".dshe-lib-quick:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-quick-primary{color:var(--dsw-alias-brand-primary,#0969da);font-weight:500}",
      ".dshe-lib-quick-on{background:var(--dsw-alias-interactive-bg-hover-solid,#e8f0ff);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-lib-quick-off{opacity:.55}",
      ".dshe-lib-groups{display:flex;flex-direction:column;gap:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1,#e5e7eb)}",
      ".dshe-lib-group{display:flex;flex-direction:column;gap:2px}",
      ".dshe-lib-group-head{display:flex;align-items:center;gap:6px;padding:2px 10px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-group-count{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);font-size:10.5px}",
      ".dshe-lib-space{display:flex;align-items:center;gap:8px;width:100%;height:34px;padding:0 8px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;text-align:left;cursor:pointer}",
      ".dshe-lib-space:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-space-on{background:var(--dsw-alias-interactive-bg-hover-solid,#e8f0ff);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-lib-space-ico{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:var(--dsw-alias-brand-primary,#4c6ef5);color:var(--dsw-alias-bg-base,#fff);font-size:10px}",
      ".dshe-lib-space-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-lib-count{font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-online,.dshe-lib-offline{margin-top:auto;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;gap:10px}",
      ".dshe-lib-crumb{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:28px;font-size:13px;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-lib-crumb-space{font-weight:600}",
      ".dshe-lib-crumb-sep{color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-crumb-now{color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-crumb-actions{display:flex;gap:6px;margin-left:auto}",
      ".dshe-lib-card{flex:1;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-lib-row{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);cursor:pointer}",
      ".dshe-lib-row:last-child{border-bottom:none}",
      ".dshe-lib-row:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-ico{flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-lib-ico-folder{color:var(--dsw-alias-state-warning-primary,#b45309)}",
      ".dshe-lib-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
      ".dshe-lib-name{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-lib-meta{font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-chevron{flex:none;display:inline-flex;color:var(--dsw-alias-label-secondary,#57606a);transform:rotate(-90deg)}",
      ".dshe-lib-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:220px;padding:24px;text-align:center}",
      ".dshe-lib-empty-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-lib-error{padding:8px 12px;border:1px solid var(--dsw-alias-state-error-primary,#cf222e);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-state-error-primary,#cf222e);font-size:12.5px}",
      ".dshe-lib-editor{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-lib-editor-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".dshe-lib-editor-actions{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}",
      ".dshe-lib-textarea{flex:1;min-height:200px;width:100%;padding:12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:12.5px/1.7 ui-monospace,Consolas,monospace;resize:vertical}",
      ".dshe-lib-dialog{width:min(420px,92vw);padding:20px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-lib-dialog-title{margin:0 0 14px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-lib-dialog-fields{display:flex;flex-direction:column;gap:10px}",
      ".dshe-lib-dialog-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}",
      ".dshe-btn-danger{border-color:var(--dsw-alias-state-error-primary,#cf222e);color:var(--dsw-alias-state-error-primary,#cf222e)}",
      /* 文档查看器：Markdown 分屏 / CSV 网格 / HTML 预览 / 图片 */
      ".dshe-lib-modes{display:flex;gap:4px;flex-wrap:wrap}",
      ".dshe-lib-mode{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;cursor:pointer}",
      ".dshe-lib-mode:hover{color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-lib-mode-on{background:var(--dsw-alias-interactive-bg-hover-solid,#e8f0ff);border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-lib-md{flex:1;min-height:0;display:flex;gap:10px}",
      ".dshe-lib-md-source{flex:1;min-width:0}",
      ".dshe-lib-md-view{flex:1;min-width:0;overflow:auto;padding:12px 16px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:13px;line-height:1.8}",
      ".dshe-lib-md-view h1,.dshe-lib-md-view h2,.dshe-lib-md-view h3{margin:14px 0 8px;line-height:1.4;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-lib-md-view h1{font-size:19px}.dshe-lib-md-view h2{font-size:16px}.dshe-lib-md-view h3{font-size:14px}",
      ".dshe-lib-md-view p{margin:8px 0}",
      ".dshe-lib-md-view ul{margin:8px 0;padding-left:20px}",
      ".dshe-lib-md-view code{padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);font:12px ui-monospace,Consolas,monospace}",
      ".dshe-lib-md-view pre{margin:10px 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);overflow:auto}",
      ".dshe-lib-md-view pre code{padding:0;background:transparent}",
      ".dshe-lib-md-view blockquote{margin:10px 0;padding:6px 12px;border-left:3px solid var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-md-view a{color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-lib-md-img{display:block;max-width:100%;height:auto;margin:10px 0;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-rich img{max-width:100%;height:auto;margin:8px 0;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb)}",
      ".dshe-lib-md-link{text-decoration:underline;text-underline-offset:2px}",
      ".dshe-lib-md-miss{display:inline-block;padding:2px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}",
      ".dshe-lib-md-view hr{border:none;border-top:1px solid var(--dsw-alias-border-l1,#e5e7eb);margin:14px 0}",
      ".dshe-lib-grid-wrap{flex:1;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-lib-grid{border-collapse:collapse;width:100%;font-size:12.5px}",
      ".dshe-lib-grid th,.dshe-lib-grid td{padding:0;border:1px solid var(--dsw-alias-border-l1,#e5e7eb)}",
      ".dshe-lib-grid-input{width:100%;min-width:110px;height:30px;padding:0 8px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font:inherit}",
      ".dshe-lib-grid-input:focus{outline:2px solid var(--dsw-alias-brand-primary,#0969da);outline-offset:-2px}",
      ".dshe-lib-grid-head{font-weight:600;background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-frame{flex:1;min-height:260px;width:100%;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      /* 版式级预览（OnlyOffice 薄 iframe）：容器占满编辑区，标题栏固定、iframe 撑满剩余 */
      ".dshe-office-frame{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px}",
      ".dshe-office-frame-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none}",
      ".dshe-office-frame-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dshe-office-frame-iframe{flex:1;min-height:320px;width:100%;height:100%;border:0;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-lib-image{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;padding:12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-image img{max-width:100%;max-height:100%;object-fit:contain}",
      ".dshe-lib-file{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px}",
      /* 资料库：树形侧栏 / 类型图标 / 更多菜单 / 收藏共享 / 富文本 */
      ".dshe-lib-space-block{display:flex;flex-direction:column;gap:1px}",
      ".dshe-lib-space-row{display:flex;align-items:center;gap:2px}",
      ".dshe-lib-tree{display:flex;flex-direction:column;gap:1px}",
      ".dshe-lib-tnode-wrap{display:flex;flex-direction:column;gap:1px}",
      ".dshe-lib-tnode{display:flex;align-items:center;gap:5px;height:28px;border-radius:7px;padding-right:6px;min-width:0}",
      ".dshe-lib-tnode:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-tnode-on{background:var(--dsw-alias-interactive-bg-hover-solid,#e8f0ff)}",
      ".dshe-lib-tcaret{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:22px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer}",
      ".dshe-lib-tcaret-empty{visibility:hidden}",
      ".dshe-lib-tico{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-tico-folder{color:var(--dsw-alias-state-warning-primary,#b45309)}",
      ".dshe-lib-tico-html{color:var(--dsw-alias-state-warning-primary,#b45309)}",
      ".dshe-lib-tico-md{color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-lib-tico-image{color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-lib-tico-csv{color:var(--dsw-alias-state-success-primary,#16a34a)}",
      ".dshe-lib-tname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px;text-align:left;cursor:pointer}",
      ".dshe-lib-tstar{flex:none;display:inline-flex;color:var(--dsw-alias-state-warning-primary,#b45309)}",
      ".dshe-lib-tmore{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;line-height:1;cursor:pointer}",
      ".dshe-lib-tmore:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      /* 下拉菜单贴触发按钮弹出（fixed + 视口坐标），遮罩全透明，不做居中弹窗 */
      ".dshe-lib-pop-mask{position:fixed;top:0;left:0;right:0;bottom:0;z-index:30;background:transparent}",
      ".dshe-lib-pop{position:fixed;z-index:31;min-width:198px;max-width:274px;padding:6px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 14px 34px rgba(0,0,0,.16);max-height:calc(100vh - 16px);overflow:auto}",
      ".dshe-lib-pop-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px;text-align:left;cursor:pointer;white-space:nowrap}",
      ".dshe-lib-pop-item:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-pop-ico{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-pop-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}",
      ".dshe-lib-pop-sep{height:1px;margin:5px 6px;background:var(--dsw-alias-border-l1,#e5e7eb)}",
      ".dshe-lib-pop-danger{color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dshe-lib-tabs{display:flex;gap:4px;margin-right:6px}",
      ".dshe-lib-tab{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;cursor:pointer}",
      ".dshe-lib-tab-on{background:var(--dsw-alias-interactive-bg-hover-solid,#e8f0ff);border-color:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-lib-select{height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:12px}",
      ".dshe-lib-row-actions{display:flex;gap:4px;flex:none;flex-wrap:wrap}",
      ".dshe-lib-rich-wrap{flex:1;min-height:0;display:flex;flex-direction:column;gap:8px}",
      ".dshe-lib-toolbar{display:flex;gap:2px;flex-wrap:wrap;padding:4px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-tool{min-width:28px;height:26px;padding:0 6px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;cursor:pointer}",
      ".dshe-lib-tool:hover{background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-lib-rich{flex:1;min-height:220px;overflow:auto;padding:14px 18px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:13.5px;line-height:1.8;outline:none}",
      ".dshe-lib-rich h1{font-size:22px;margin:10px 0 8px}",
      ".dshe-lib-rich h2{font-size:18px;margin:10px 0 6px}",
      ".dshe-lib-rich h3{font-size:15px;margin:8px 0 6px}",
      ".dshe-lib-rich p{margin:6px 0}",
      ".dshe-lib-rich ul,.dshe-lib-rich ol{margin:6px 0;padding-left:22px}",
      ".dshe-lib-rich blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-rich pre{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);overflow:auto}",
      ".dshe-lib-rich a{color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-lib-dialog-wide{width:min(560px,94vw)}",
      ".dshe-lib-share-list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto;margin-top:6px}",
      ".dshe-lib-share-row{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px}",
      ".dshe-lib-share-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}",
      ".dshe-lib-break{word-break:break-all}",
      ".dshe-lib-inline{width:150px}",
      /* ---- 分享弹窗：表单三列自适应 + 每条分享一张卡（标题行 / 链接行分开） ---- */
      ".dshe-lib-share-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:10px 12px;align-items:end}",
      /* 设置页给 .dshe-settings-field 加了 28px 左右 padding，这里必须清掉，否则输入框被压窄、placeholder 显示不全 */
      ".dshe-lib-share-form .dshe-settings-field{min-width:0;flex:none;padding:0;overflow:visible}",
      ".dshe-lib-share-form .dshe-settings-input{width:100%}",
      ".dshe-lib-share-actions{display:flex;justify-content:flex-end;gap:8px}",
      ".dshe-lib-share-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-lib-share-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
      ".dshe-lib-share-top .dshe-lib-row-actions{margin-left:auto}",
      ".dshe-lib-share-tag{flex:none;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:18px}",
      ".dshe-lib-share-tag-warn{color:var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dshe-lib-share-link{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dshe-lib-share-label{flex:none;width:56px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-wb-bridge{flex:none;padding:0 8px;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a);font-family:ui-monospace,Consolas,monospace}",
      ".dshe-wb-bridge-bad{color:var(--dsw-alias-state-error-primary,#cf222e);font-weight:600}",
      /* ---- HTML 直链弹窗：实时直链 / 当前页静态快照两个独立区块 ---- */
      ".dshe-lib-direct-sec{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-lib-direct-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
      ".dshe-lib-direct-spacer{flex:1}",
      ".dshe-lib-direct-tag{flex:none;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;line-height:18px}",
      ".dshe-lib-direct-tip{margin:0;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-direct-empty{padding:6px 2px;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}",
      /* ---- 外部数据同步弹窗：路径行 / 统计行 / 记录行 ---- */
      ".dshe-ingest-path{display:flex;align-items:center;gap:8px;min-width:0}",
      ".dshe-ingest-stat{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
      ".dshe-ingest-block{display:flex;flex-direction:column;gap:6px;margin-top:4px}",
      ".dshe-ingest-block-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-ingest-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-ingest-time{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#57606a);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}",
      ".dshe-ingest-err{flex-basis:100%;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#cf222e);word-break:break-all}",
      ".dshe-ingest-alert{color:var(--dsw-alias-state-warning-primary,#9a6700);border-color:var(--dsw-alias-state-warning-primary,#9a6700)}",
      /* 实时直链的权限行：允许访客编辑开关 + 有效期 + 说明（快照分享没有这一行） */
      ".dshe-lib-direct-item{display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".dshe-lib-direct-perm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:2px 0 0 2px}",
      ".dshe-lib-direct-perm-label{font-size:12px;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-lib-direct-perm-expire{font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-direct-perm-hint{flex-basis:100%;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-share-url{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-primary,#1f2328);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px}",
      ".dshe-lib-version-pre{max-height:200px;overflow:auto;margin:6px 0 0;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap}",
      /* ---- 统一按钮体系（对齐在线资料库的元素感：主色 / 次要 / 幽灵 / 危险） ---- */
      ".dshe-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .12s,border-color .12s,color .12s}",
      ".dshe-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f6f7f8);border-color:var(--dsw-alias-border-l1,#d0d7de)}",
      ".dshe-btn:disabled{opacity:.5;cursor:not-allowed}",
      ".dshe-btn-sm{height:26px;padding:0 10px;font-size:12px}",
      ".dshe-btn-ghost{border-color:transparent;background:transparent}",
      ".dshe-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f6f7f8);border-color:transparent}",
      ".dshe-btn-danger{color:var(--dsw-alias-state-error-primary,#cf222e);border-color:var(--dsw-alias-state-error-primary,#cf222e);background:transparent}",
      ".dshe-btn-danger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#fef2f2)}",

      /* ---- 编辑器头部：标题 + 分段模式 + 操作按钮 ---- */
      ".dshe-lib-editor-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-lib-editor-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}",
      ".dshe-lib-modes{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-mode{height:26px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;cursor:pointer;transition:background .12s,color .12s}",
      ".dshe-lib-mode:hover{color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-lib-mode-on{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.10)}",

      /* ---- Word 式工具栏 ---- */
      ".dshe-lib-toolbar{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:6px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-lib-tb-group{display:inline-flex;align-items:center;gap:2px}",
      ".dshe-lib-tb-sep{width:1px;height:18px;margin:0 2px;background:var(--dsw-alias-border-l1,#e5e7eb)}",
      ".dshe-lib-tool{min-width:28px;height:28px;padding:0 7px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px;line-height:1;cursor:pointer;transition:background .12s,color .12s}",
      ".dshe-lib-tool:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-tool-on{background:var(--dsw-alias-interactive-bg-hover-solid,#eef2ff);color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-lib-tb-select{height:28px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px}",
      ".dshe-lib-tb-color{position:relative;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 6px;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px}",
      ".dshe-lib-tb-color:hover{background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-tb-color input{position:absolute;inset:0;opacity:0;cursor:pointer}",
      ".dshe-lib-tb-swatch{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-primary,#1f2328);font-size:11px;font-weight:600;border-bottom:2px solid var(--dsw-alias-state-error-primary,#cf222e)}",
      ".dshe-lib-tb-swatch-hl{border-bottom:2px solid var(--dsw-alias-state-warning-primary,#f59e0b)}",

      /* ---- 弹窗：头 / 体 / 脚，右侧按钮组 ---- */
      ".dshe-lib-dialog{width:min(480px,92vw);padding:0;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 18px 48px rgba(0,0,0,.18);overflow:hidden}",
      ".dshe-lib-dialog-wide{width:min(620px,94vw)}",
      ".dshe-lib-dialog-title{padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-lib-dialog-fields{display:flex;flex-direction:column;gap:12px;padding:16px 18px}",
      ".dshe-lib-dialog-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",

      /* ---- 表单：标签 + 控件统一高度 ---- */
      ".dshe-lib-dialog .dshe-settings-field,.dshe-lib-dialog-fields .dshe-settings-field{display:flex;flex-direction:column;gap:6px}",
      ".dshe-lib-dialog .dshe-settings-label{font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-lib-dialog .dshe-settings-input,.dshe-lib-dialog .dshe-lib-select{height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px}",
      ".dshe-lib-dialog .dshe-settings-input:focus,.dshe-lib-dialog .dshe-lib-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#0969da);box-shadow:0 0 0 3px var(--dsw-alias-interactive-bg-hover-solid,#eef2ff)}",

      /* ---- 正文里的表格（工具栏插入 / 用户粘贴） ---- */
      ".dshe-lib-rich table,.dshe-lib-md-view table{width:100%;border-collapse:collapse;margin:10px 0;font-size:12.5px}",
      ".dshe-lib-rich th,.dshe-lib-rich td,.dshe-lib-md-view th,.dshe-lib-md-view td{border:1px solid var(--dsw-alias-border-l1,#e5e7eb);padding:6px 8px;text-align:left;vertical-align:top}",
      ".dshe-lib-rich th,.dshe-lib-md-view th{background:var(--dsw-alias-bg-layer-2,#f6f7f8);font-weight:600}",
      /* 列宽可拖：表头右缘给一条淡色提示线，鼠标再往右一点就变 col-resize */
      ".dshe-lib-rich th{position:relative}",
      ".dshe-lib-rich th:hover::after{content:'';position:absolute;top:0;right:-1px;width:2px;height:100%;background:var(--dsw-alias-brand-primary,#0969da);opacity:.45}",
      ".dshe-lib-rich table[data-resized]{table-layout:fixed}",

      /* ---- 插图弹窗里的附件网格 ---- */
      ".dshe-lib-assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}",
      ".dshe-lib-asset{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);cursor:pointer;text-align:left}",
      ".dshe-lib-asset:hover{border-color:var(--dsw-alias-brand-primary,#0969da)}",
      ".dshe-lib-asset-thumb{width:100%;height:72px;object-fit:cover;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-lib-asset-name{font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",

      /* ---- Office 内置编辑 ---- */
      ".dshe-oe{display:flex;flex-direction:column;gap:10px;flex:1;min-height:0}",
      ".dshe-oe-tip{padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}",
      ".dshe-oe-doc{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:4px;padding:12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-oe-para{display:flex;align-items:flex-start;gap:8px}",
      ".dshe-oe-para-no{flex:none;width:28px;padding-top:7px;text-align:right;color:var(--dsw-alias-label-secondary,#9ca3af);font-size:11px}",
      ".dshe-oe-para-input{flex:1;min-height:30px;padding:6px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font:inherit;resize:none;overflow:hidden}",
      ".dshe-oe-para-input:hover{border-color:var(--dsw-alias-border-l1,#e5e7eb)}",
      ".dshe-oe-para-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#0969da);background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-oe-tabs{display:flex;gap:4px;flex-wrap:wrap}",
      ".dshe-oe-tab{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#57606a);font-size:12.5px;cursor:pointer}",
      ".dshe-oe-tab-on{border-color:var(--dsw-alias-brand-primary,#0969da);background:var(--dsw-alias-interactive-bg-hover-solid,#eef2ff);color:var(--dsw-alias-brand-primary,#0969da);font-weight:600}",
      ".dshe-oe-grid-wrap{flex:1;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-oe-grid{width:100%;border-collapse:collapse;font-size:12.5px}",
      ".dshe-oe-grid th,.dshe-oe-grid td{border-right:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);padding:0}",
      ".dshe-oe-rown,.dshe-oe-colh{position:sticky;left:0;background:var(--dsw-alias-bg-layer-2,#f6f7f8);color:var(--dsw-alias-label-secondary,#57606a);font-size:11px;font-weight:500;text-align:center;padding:4px 8px}",
      ".dshe-oe-cell{width:100%;min-width:96px;height:30px;padding:0 8px;border:0;background:transparent;color:var(--dsw-alias-label-primary,#1f2328);font:inherit}",
      ".dshe-oe-cell:focus{outline:2px solid var(--dsw-alias-brand-primary,#0969da);outline-offset:-2px}",
      ".dshe-oe-cell-head{font-weight:600;background:var(--dsw-alias-bg-layer-2,#f6f7f8)}",
      ".dshe-oe-slides{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px}",
      ".dshe-oe-slide{padding:14px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-oe-slide-no{margin-bottom:6px;color:var(--dsw-alias-label-secondary,#57606a);font-size:11px}",
      ".dshe-oe-slide-text{margin:4px 0;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-oe-state{flex:1;display:flex;align-items:center;justify-content:center;padding:32px;border:1px dashed var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;color:var(--dsw-alias-label-secondary,#57606a);font-size:12.5px}",

      /* 主按钮 / 危险按钮放在基础 .dshe-btn 之后，避免被后面追加的基础规则覆盖底色 */
      ".dshe-btn-primary{border-color:var(--dsw-alias-brand-primary,#0969da);background:var(--dsw-alias-brand-primary,#0969da);color:var(--dsw-alias-bg-base,#fff);font-weight:500}",
      ".dshe-btn-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#0969da);opacity:.9}",
      ".dshe-btn-danger{color:var(--dsw-alias-state-error-primary,#cf222e);border-color:var(--dsw-alias-state-error-primary,#cf222e);background:transparent}",
      ".dshe-btn-danger:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#fef2f2);border-color:var(--dsw-alias-state-error-primary,#cf222e)}",

      /* ---- 智聊面板：全部走 dsh 设计变量，浅色仅作回退 ---- */
      ".dshe-zl-wrap{display:flex;flex-direction:column;gap:14px;padding:18px 24px;overflow:auto;height:100%;box-sizing:border-box}",
      ".dshe-zl-card{padding:14px 16px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}",
      ".dshe-zl-title{margin:0 0 10px;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-zl-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#eaeef2)}",
      ".dshe-zl-row:last-child{border-bottom:none}",
      ".dshe-zl-name{flex:1;min-width:120px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-zl-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-zl-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px}",
      ".dshe-zl-label{display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#57606a)}",
      ".dshe-zl-input{height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,#d0d7de);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font-size:12.5px;min-width:0}",
      ".dshe-zl-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-primary,#1f2328)}",
      ".dshe-zl-tag{display:inline-block;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-secondary,#57606a);font-size:11px}",
      ".dshe-zl-empty{padding:14px;text-align:center;color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}",
      ".dshe-zl-text{white-space:pre-wrap;word-break:break-word;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f6f8fa);color:var(--dsw-alias-label-primary,#1f2328);font-size:12px}"
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
      /* 15 秒硬超时：没有它，宿主服务一旦不回，调用方就永远 pending，
         工作台 iframe 那边只能干等到桥超时，界面停在「加载中」。 */
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller === null ? null : setTimeout(() => {
        try { controller.abort(); } catch { /* 已结束 */ }
      }, 15000);
      const done = () => { if (timer !== null) clearTimeout(timer); };
      const init = { headers: { Accept: "application/json" } };
      if (controller !== null) init.signal = controller.signal;
      return fetch(API + pathAndQuery, init)
        .then((resp) => resp.json())
        .then((json) => { done(); return json; })
        .catch((error) => {
          done();
          const aborted = error !== null && error !== undefined && error.name === "AbortError";
          throw new Error(aborted ? "插件服务 15 秒未响应：" + pathAndQuery : String((error && error.message) || error));
        });
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
      /* 已安装技能目录下的 _icon.*：不在数据根里，走受限的 /skill-icon?dir= 路由。 */
      if (relativePath.indexOf("skill-icon:") === 0) {
        return API + "/skill-icon?dir=" + encodeURIComponent(relativePath.slice("skill-icon:".length));
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
    function listPath(tab, query, offset, limit, connectorOrigin) {
      const parts = [];
      if (query !== "") parts.push("q=" + encodeURIComponent(query));
      parts.push("limit=" + String(limit));
      parts.push("offset=" + String(offset));
      /* 连接器页支持「全部 / 已安装 / 云端」三种来源视图。 */
      if (tab === "connectors" && typeof connectorOrigin === "string" && connectorOrigin !== "" && connectorOrigin !== "all") {
        parts.push("origin=" + encodeURIComponent(connectorOrigin));
      }
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
     * 把技能引用 id 净化成宿主原生技能的 `/` 指令名。
     *
     * 宿主启动时会扫描 `$DSH_HOME/skills/<dir>/SKILL.md` 并按需加载，插件不再把整篇
     * 正文内联进用户消息；`serialize` / `clipboardText` / 两处 insert payload 统一
     * 走这里，保证 `/` 菜单、列表页气泡、自绘选择器三种入口产出同一个 `/指令名`。
     *
     * 旧草稿里可能残留 `skill:<仓库相对路径>`（如 `skills/anthropics-skills/pdf`），
     * 取末段（basename）净化；末段全是中文等非法字符时往前找最近的合法段，再不行
     * 用整条 id 的净化结果，最后兜底 `skill` —— 任何输入都不抛异常、不返回空串。
     * 净化规则与宿主 `skillDirNameOf()` 逐字一致（只保留 `[A-Za-z0-9._-]`）。
     * @param {any} rawId 引用 id（已安装目录名 / 仓库相对路径 / slug）
     * @returns {string} 合法的 `/` 指令名，永不为空
     */
    function slashNameOf(rawId) {
      const raw = trimmed(rawId);
      const segments = raw.split(/[\\/]/).filter((seg) => seg !== "");
      for (let i = segments.length - 1; i >= 0; i -= 1) {
        const name = skillDirNameOfClient(segments[i]);
        if (name !== "") return name;
      }
      const whole = skillDirNameOfClient(raw);
      return whole !== "" ? whole : "skill";
    }

    // =======================================================================
    // 文件夹导入：常量 / 路径规整 / 轻量格式预检（与后端 /import/folder 同规则）
    // =======================================================================

    /** 文件夹导入：单文件上限（2MB）。 */
    var FOLDER_MAX_FILE_BYTES = 2 * 1024 * 1024;

    /** 文件夹导入：文件数量上限。 */
    var FOLDER_MAX_FILES = 200;

    /** 文件夹导入：总字节上限（20MB）。 */
    var FOLDER_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

    /** 已知文本扩展名：utf8 读取；其余（含 png/jpg/webp 与未知类型）一律 base64。 */
    var FOLDER_TEXT_RE = /\.(md|markdown|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|sh|ps1|css|html?|xml|svg|toml|ini|csv|tsv)$/i;

    /** 三种类型的弹窗标题、必需文件与格式说明。 */
    var FOLDER_TYPE_META = {
      skill: {
        title: "添加技能", label: "技能", addLabel: "添加技能",
        required: ["SKILL.md"],
        hint: "目录根下必须有 SKILL.md，frontmatter 里建议写 name；可带 README.md 与其它资源文件。"
      },
      expert: {
        title: "导入专家", label: "专家", addLabel: "导入专家",
        required: ["expert.yml", "role.md"],
        hint: "目录根下必须有 expert.yml（至少含 id 与 display_name）和 role.md；也可用 .buddy-hub-plugin/plugin.json（或旧名 .codebuddy-plugin）兼容格式。"
      },
      team: {
        title: "导入专家团", label: "专家团", addLabel: "导入专家团",
        required: ["expert.yml", "role.md", "team.json"],
        hint: "在专家的基础上还必须有 team.json（含 teamInfo 或 members 数组）；也可用带团队信息的 .buddy-hub-plugin/plugin.json（或旧名 .codebuddy-plugin）兼容格式。"
      }
    };

    /** 四处统一的视图按钮组：全部 / 已安装 / 云端。 */
    var RESOURCE_VIEWS = [["all", "全部"], ["installed", "已安装"], ["cloud", "云端"]];

    /** base64 字符表（不依赖 btoa，非浏览器环境也能用）。 */
    var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    /**
     * 字节数组转 base64（分块处理，避免大文件一次展开爆栈）。
     * @param {Uint8Array} bytes 原始字节
     * @returns {string} base64 字符串
     */
    function bytesToBase64(bytes) {
      var out = "";
      for (var i = 0; i < bytes.length; i += 3) {
        var a = bytes[i];
        var b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        var c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += B64_CHARS.charAt(a >> 2);
        out += B64_CHARS.charAt(((a & 3) << 4) | (b >> 4));
        out += i + 1 < bytes.length ? B64_CHARS.charAt(((b & 15) << 2) | (c >> 6)) : "=";
        out += i + 2 < bytes.length ? B64_CHARS.charAt(c & 63) : "=";
      }
      return out;
    }

    /**
     * 读取 File 为 utf8 文本（优先原生 text()，旧浏览器回退 FileReader）。
     * @param {any} file 浏览器 File 对象
     * @returns {Promise<string>} 文本内容
     */
    function readFileText(file) {
      if (typeof file.text === "function") return file.text();
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () { resolve(String(reader.result || "")); };
        reader.onerror = function () { reject(reader.error || new Error("读取文件失败")); };
        reader.readAsText(file, "utf8");
      });
    }

    /**
     * 读取 File 为 base64（二进制文件用，优先原生 arrayBuffer()）。
     * @param {any} file 浏览器 File 对象
     * @returns {Promise<string>} base64 字符串
     */
    function readFileBase64(file) {
      if (typeof file.arrayBuffer === "function") {
        return file.arrayBuffer().then(function (buf) { return bytesToBase64(new Uint8Array(buf)); });
      }
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result || "");
          var comma = text.indexOf(",");
          resolve(comma >= 0 ? text.slice(comma + 1) : text);
        };
        reader.onerror = function () { reject(reader.error || new Error("读取文件失败")); };
        reader.readAsDataURL(file);
      });
    }

    /**
     * 规整文件夹内文件的相对路径：剥掉所选目录名这一层并做路径穿越防护。
     * 与后端 safeFolderPath 保持一致：拒绝绝对路径、盘符、反斜杠、.. 与保留字符。
     * @param {any} raw 原始相对路径（webkitRelativePath 或系统对话框拼出的路径）
     * @param {string} rootName 所选目录名
     * @returns {string|null} 安全相对路径；非法返回 null
     */
    function folderRelativePath(raw, rootName) {
      var text = String(raw === null || raw === undefined ? "" : raw);
      if (text === "" || text.length > 300) return null;
      if (text.indexOf("\\") >= 0 || text.indexOf("\0") >= 0) return null;
      if (text.charAt(0) === "/" || /^[a-zA-Z]:/.test(text)) return null;
      var parts = text.split("/");
      if (rootName !== "" && parts[0] === rootName) parts = parts.slice(1);
      parts = parts.filter(function (part) { return part !== "" && part !== "."; });
      if (parts.length === 0) return null;
      for (var i = 0; i < parts.length; i += 1) {
        if (parts[i] === ".." || /[<>:"|?*]/.test(parts[i])) return null;
      }
      var rel = parts.join("/");
      return rel.length <= 300 ? rel : null;
    }

    /**
     * 从文件列表里取某个相对路径的文本内容。
     * @param {Array<{path: string, data: string, encoding: string}>} files 文件列表
     * @param {string} rel 相对路径
     * @returns {string|null} 文本内容；不存在返回 null
     */
    function folderTextOf(files, rel) {
      for (var i = 0; i < files.length; i += 1) {
        if (files[i].path === rel) return String(files[i].data || "");
      }
      return null;
    }

    /**
     * 从文件列表里解析某个相对路径的 JSON 对象。
     * @param {Array<{path: string, data: string, encoding: string}>} files 文件列表
     * @param {string} rel 相对路径
     * @returns {any|null} 解析后的对象；不存在或不合法返回 null
     */
    function folderJsonOf(files, rel) {
      var text = folderTextOf(files, rel);
      if (text === null) return null;
      try {
        var parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }

    /**
     * 从 SKILL.md 的 frontmatter 里取 name（只做轻量预检，权威校验在后端）。
     * @param {string} text SKILL.md 全文
     * @returns {string} name；解析不出返回空串
     */
    function folderFrontmatterName(text) {
      var match = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ""));
      if (match === null) return "";
      var lines = match[1].split(/\r?\n/);
      for (var i = 0; i < lines.length; i += 1) {
        if (/^\s*name\s*:/.test(lines[i])) {
          return lines[i].replace(/^\s*name\s*:\s*/, "").trim().replace(/^["']|["']$/g, "").trim();
        }
      }
      return "";
    }

    /**
     * 轻量格式预检：校验一个候选条目目录是否符合指定类型。
     * 规则与后端 validateFolderEntry 一致，前端只用于展示，不代替后端校验。
     * @param {'skill'|'expert'|'team'} type 条目类型
     * @param {Array<{path: string, data: string, encoding: string}>} files 该目录下的文件
     * @param {string} dirName 目录名
     * @returns {{ok: boolean, id: string, name: string, reasons: string[], notes: string[]}} 预检结果
     */
    function folderEntryCheck(type, files, dirName) {
      var reasons = [];
      var notes = [];
      var skillMd = folderTextOf(files, "SKILL.md");
      var expertYml = folderTextOf(files, "expert.yml");
      var roleMd = folderTextOf(files, "role.md");
      var teamJson = folderJsonOf(files, "team.json");
      /* 清单目录新名优先、旧名兼容。 */
      var plugin = folderJsonOf(files, ".buddy-hub-plugin/plugin.json") || folderJsonOf(files, ".codebuddy-plugin/plugin.json");
      var pluginReadable = plugin !== null && (
        (typeof plugin.name === "string" && plugin.name !== "") ||
        (typeof plugin.displayName === "string" && plugin.displayName !== "")
      );

      if (type === "skill") {
        if (skillMd === null) reasons.push("缺少 SKILL.md");
        var name = String(dirName || "").trim();
        if (skillMd !== null) {
          var fromFront = folderFrontmatterName(skillMd);
          if (fromFront !== "") name = fromFront;
          else notes.push("SKILL.md 未解析出 name，已用目录名「" + dirName + "」兜底");
        }
        var id = skillDirNameOfClient(name);
        if (id === "") reasons.push("技能名无法转成安全目录名");
        return { ok: reasons.length === 0, id, name, reasons, notes };
      }

      var nativeForm = expertYml !== null && roleMd !== null;
      var expertId = String(dirName || "").trim();
      var displayName = String(dirName || "").trim();
      if (nativeForm) {
        var metaId = "";
        var metaName = "";
        var lines = expertYml.split(/\r?\n/);
        for (var i = 0; i < lines.length; i += 1) {
          var line = lines[i].trim();
          if (line === "" || line.charAt(0) === "#") continue;
          var at = line.indexOf(":");
          if (at <= 0) continue;
          var key = line.slice(0, at).trim();
          var value = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
          if (key === "id") metaId = value;
          if (key === "display_name") metaName = value;
        }
        if (metaId === "") reasons.push("expert.yml 缺少 id"); else expertId = metaId;
        if (metaName === "") reasons.push("expert.yml 缺少 display_name"); else displayName = metaName;
      } else if (pluginReadable) {
        expertId = String(plugin.name || plugin.displayName || dirName || "");
        displayName = String(plugin.displayName || plugin.name || dirName || "");
        notes.push("按 .buddy-hub-plugin/plugin.json（或旧名 .codebuddy-plugin）兼容格式导入");
        if (roleMd === null) notes.push("缺少 role.md，后端会按清单描述生成");
      } else {
        reasons.push("缺少 expert.yml + role.md，也没有含 name / displayName 的 .buddy-hub-plugin/plugin.json（或旧名 .codebuddy-plugin/plugin.json）");
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(expertId)) {
        reasons.push("条目 id「" + expertId + "」非法（只允许字母数字开头，且仅含字母数字、点、下划线、连字符）");
      }
      if (type === "team") {
        var teamOk = teamJson !== null && (
          Array.isArray(teamJson.members) ||
          (teamJson.teamInfo !== null && typeof teamJson.teamInfo === "object")
        );
        var pluginTeamOk = pluginReadable && (
          plugin.expertType === "team" || Array.isArray(plugin.members) ||
          (plugin.teamInfo !== null && typeof plugin.teamInfo === "object")
        );
        if (!teamOk && !pluginTeamOk) {
          reasons.push("缺少 team.json（需含 teamInfo 或 members 数组），plugin.json 里也没有团队信息");
        } else if (!teamOk && pluginTeamOk) {
          notes.push("团队信息来自 plugin.json，导入时会生成 team.json");
        }
      }
      return { ok: reasons.length === 0, id: expertId, name: displayName, reasons, notes };
    }

    /**
     * 整个所选目录的轻量预检：先单条目模式，失败再按一级子目录批量模式。
     * @param {'skill'|'expert'|'team'} type 条目类型
     * @param {string} rootName 所选目录名
     * @param {Array<{path: string, data: string, encoding: string}>} rawFiles 原始文件（路径可能带根目录层）
     * @returns {{ok: boolean, mode: string, candidates: Array<any>, files: Array<any>, message: string}} 预检结果
     */
    function folderPayloadCheck(type, rootName, rawFiles) {
      var files = [];
      for (var i = 0; i < rawFiles.length; i += 1) {
        var rel = folderRelativePath(rawFiles[i].path, rootName);
        if (rel === null) {
          return { ok: false, mode: "single", candidates: [], files: [], message: "文件路径非法（含 .. / 绝对路径 / 盘符 / 反斜杠）：" + String(rawFiles[i].path) };
        }
        files.push({ path: rel, data: rawFiles[i].data, encoding: rawFiles[i].encoding });
      }
      var label = FOLDER_TYPE_META[type].label;
      var single = folderEntryCheck(type, files, rootName || "import");
      if (single.ok === true) {
        return {
          ok: true, mode: "single", files: files,
          candidates: [{ dir: rootName || "import", ok: true, id: single.id, name: single.name, reasons: [], notes: single.notes }],
          message: "单条目模式：所选目录本身符合" + label + "格式，可导入 1 个条目。"
        };
      }

      var groups = [];
      var byDir = {};
      for (var j = 0; j < files.length; j += 1) {
        var parts = files[j].path.split("/");
        if (parts.length < 2) continue;
        var dir = parts[0];
        if (byDir[dir] === undefined) {
          byDir[dir] = [];
          groups.push(dir);
        }
        byDir[dir].push({ path: parts.slice(1).join("/"), data: files[j].data, encoding: files[j].encoding });
      }
      if (groups.length === 0) {
        return {
          ok: false, mode: "batch", files: files,
          candidates: [{ dir: rootName || "import", ok: false, reasons: single.reasons, notes: [] }],
          message: "所选目录不符合" + label + "格式：" + single.reasons.join("；") + "；也不是批量目录：没有一级子目录。"
        };
      }
      var candidates = [];
      var passed = 0;
      for (var k = 0; k < groups.length; k += 1) {
        var check = folderEntryCheck(type, byDir[groups[k]], groups[k]);
        if (check.ok === true) passed += 1;
        candidates.push({
          dir: groups[k], ok: check.ok, id: check.id, name: check.name,
          reasons: check.reasons, notes: check.notes
        });
      }
      return {
        ok: passed > 0, mode: "batch", files: files, candidates: candidates,
        message: passed > 0
          ? "批量模式：" + String(passed) + " 个子目录符合" + label + "格式，其余 " + String(groups.length - passed) + " 个会在导入时跳过。"
          : "批量模式：" + String(groups.length) + " 个一级子目录均不符合" + label + "格式，无法导入。"
      };
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
     * 技能展示名：优先 `_skillhub_meta.json` 的中文名，其次 SKILL.md 的 name，最后 id。
     * @param {any} item 技能条目
     * @returns {string} 展示名
     */
    function skillDisplayNameOf(item) {
      return trimmed(item.displayName) || trimmed(item.name) || trimmed(item.id);
    }

    /**
     * 版本号展示文本（统一带一个 v，重复前缀不叠加）。
     * @param {any} value 原始版本值
     * @returns {string} `v7.6.0` 形式；无版本返回空串
     */
    function versionLabel(value) {
      const text = trimmed(value);
      if (text === "") return "";
      return "v" + (text.charAt(0) === "v" ? text.slice(1) : text);
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

    /**
     * 连接器定义的来源（manual / cloud 两值）。
     *
     * 与 `origin` 不同：`origin` 表示条目当前在哪被发现（local / cloud），
     * `source` 表示这条定义是谁写下来的，装到本地后依然保留。
     * 历史值 `market`（旧市场下载）一律归一成 `cloud` —— 现在所有非手填来源都来自
     * git 资源仓库，不再有「市场」这一层。
     * 其余非法值（含更早误写入的 `local`）按「本地自定义」兜底。
     * @param {any} item 连接器条目
     * @returns {string} 合法来源；条目无来源信息时返回空串
     */
    function connectorSourceOf(item) {
      const raw = trimmed(item !== null && item !== undefined ? item.source : "").toLowerCase();
      if (raw === "manual" || raw === "cloud") return raw;
      if (raw === "market" || raw === "local") return "cloud";
      /* 未安装的条目不显示来源徽标；已安装但字段缺失的历史定义按本地自定义处理。 */
      if (item !== null && item !== undefined && item.installed === true) return "manual";
      return "";
    }

    /**
     * 来源的中文名。
     * @param {string} source 来源（manual / cloud）
     * @returns {string} 中文名；未知来源返回空串
     */
    function connectorSourceLabel(source) {
      if (source === "manual") return "本地自定义";
      if (source === "cloud") return "云端下载";
      return "";
    }

    /**
     * 时间戳 → `YYYY-MM-DD HH:mm`（本地时区）。
     * @param {any} value 毫秒时间戳或可被 Date 解析的值
     * @returns {string} 格式化文本；非法 / 空值 / 超出 Date 范围返回空串（调用方据此不渲染该行）
     */
    function formatStamp(value) {
      if (value === null || value === undefined || value === "") return "";
      const ms = typeof value === "number" ? value : Date.parse(String(value));
      if (!Number.isFinite(ms)) return "";
      const date = new Date(ms);
      /* 9e15 这类超过 Date 上限（±8.64e15）的数字会让 Date 变 Invalid Date，
         只挡 Number.isFinite 不够，必须再查 getTime()，否则会渲染出 NaN-NaN-NaN。 */
      if (!Number.isFinite(date.getTime())) return "";
      const pad = (n) => (n < 10 ? "0" + String(n) : String(n));
      return String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
        " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
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
      star: [{ d: "M12 3.8l2.5 5.4 5.9.7-4.4 4.1 1.2 5.8L12 17l-5.2 2.8 1.2-5.8L3.6 9.9l5.9-.7z" }],
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
    // 通用资源工具栏（专家 / 专家团 / 技能 / 连接器四处共用）
    // =======================================================================

    /**
     * 资源工具栏：左侧「全部 / 已安装 / 云端」视图按钮组，右侧一个 + 按钮。
     *
     * 四处（专家 / 专家团 / 技能 / 连接器）复用同一个组件，保证位置、间距、
     * 样式完全一致；+ 按钮不带 title 悬浮提示，只保留 aria-label 供无障碍与测试定位。
     *
     * @param {{ views?: Array<Array<string>>, view?: string, onViewChange?: Function,
     *           viewLabel?: string, addLabel?: string, onAdd?: Function,
     *           addDisabled?: boolean, toolbarId?: string, addId?: string }} props 组件属性
     * @returns {any} React 元素
     */
    function ResourceToolbar(props) {
      var views = Array.isArray(props.views) ? props.views : RESOURCE_VIEWS;
      var view = typeof props.view === "string" ? props.view : "all";
      var addLabel = typeof props.addLabel === "string" ? props.addLabel : "添加";
      return h("div", {
        className: "dshe-conn-toolbar",
        "data-resource-toolbar": props.toolbarId || ""
      },
        h("div", {
          className: "dshe-conn-views",
          role: "tablist",
          "aria-label": props.viewLabel || "资源视图"
        }, views.map(function (pair) {
          var viewId = pair[0];
          var label = pair[1];
          return h("button", {
            key: viewId,
            type: "button",
            role: "tab",
            "aria-selected": view === viewId ? "true" : "false",
            "data-resource-view": viewId,
            className: "dshe-conn-view" + (view === viewId ? " dshe-conn-view-on" : ""),
            onClick: function () {
              if (typeof props.onViewChange === "function") props.onViewChange(viewId);
            }
          }, label);
        })),
        h("button", {
          type: "button",
          className: "dshe-btn dshe-btn-primary dshe-conn-new",
          "data-add-button": props.addId || "",
          "aria-label": addLabel,
          disabled: props.addDisabled === true,
          onClick: function () {
            if (typeof props.onAdd === "function") props.onAdd();
          }
        }, h(Icon, { name: "plus", size: 14 }), h("span", null, addLabel))
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

    /**
     * 侧边栏「个人工作台」入口图标：与上面的资源入口并列，用第 4 大块的四宫格图标。
     * 刻意不复用 `data-dsh-buddy-expert-hub-panel-trigger` 标记 —— 宿主若按该
     * marker 查找按钮（openSidebarPanel），两个入口共用一个标记会点错面板。
     * @param {{ size?: number, active?: boolean }} props 组件属性
     * @returns {any} React 元素
     */
    function WorkbenchPanelIcon(props) {
      const size = typeof props.size === "number" ? props.size : 18;
      const active = props.active === true;
      return h("span", {
        className: "dshe-panel-icon" + (active ? " dshe-panel-icon-on" : ""),
        "aria-hidden": "true",
        "data-dsh-buddy-expert-hub-workbench-trigger": "1",
        style: { display: "inline-flex", alignItems: "center", justifyContent: "center" }
      },
        h(CategoryIcon, { name: "workbench", size: size })
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
        baseStyle.background = "var(--dsw-alias-bg-base, #fff)";
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
     * 技能图标方块：有 `_icon.*` 时用真实图标，加载失败 / 没有图标时回落确定性首字母。
     *
     * 仓库技能与已安装技能共用：`icon` 可能是数据根内的相对路径（走 /asset），
     * 也可能是 `skill-icon:<dir>`（走 /skill-icon）。assetUrl() 统一处理。
     * @param {{ icon: any, name: string, color: { bg: string, fg: string }, className: string }} props 属性
     * @returns {any} React 元素
     */
    function SkillIconTile(props) {
      const [broken, setBroken] = useState(false);
      const src = assetUrl(props.icon);
      return h("span", {
        className: props.className,
        style: { backgroundColor: props.color.bg, color: props.color.fg },
        "aria-hidden": "true"
      },
        src !== null && !broken
          ? h("img", { src: src, alt: "", loading: "lazy", onError: () => setBroken(true) })
          : initialOf(props.name)
      );
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
     *
     * 外观铁律的唯一例外：这是"内容装饰色"（技能图标底色 + 同系深色首字母），
     * 与界面主题无关，深色主题下也只是一块 24px 的小色块，不影响可读性。
     * 除这里以外的任何颜色都必须写成 var(--dsw-alias-*, 回退值)，
     * 由 _harness/appearance.mjs 自动把关。
     *
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
      const name = skillDisplayNameOf(item);
      const version = versionLabel(item.version);
      const description = descOf(item.description);
      const color = skillTileColor(name);
      const installed = props.installed === true;
      const active = installed && props.enabled !== false;
      return h("div", {
        className: "dshe-skill-card",
        "data-skill-id": item.id,
        onClick: () => props.onOpen(item)
      },
        h(SkillIconTile, { icon: item.icon, name: name, color: color, className: "dshe-skill-tile" }),
        h("div", { className: "dshe-skill-info" },
          h("div", { className: "dshe-skill-name-row" },
            h("span", { className: "dshe-skill-name", title: name }, name),
            version !== ""
              ? h("span", { className: "dshe-skill-ver", title: "版本 " + version }, version)
              : null
          ),
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
     * 解析连接器的连接需求（新版后端字段 + 旧数据兼容）。
     *
     * 规则：
     *  - `needsSetup === false`（免认证、无参数）→ 不需要连接，直接显示对话气泡；
     *  - `needsSetup === true` 且未连接 → 显示「+」，点开连接弹窗；
     *  - 后端总会输出这三个字段；完全没有新字段的数据（旧快照 / 第三方桩）
     *    保守沿用旧交互：显示「+」，点「+」直接登记连接，避免出现无法操作的空白态。
     *
     * @param {any} item 连接器条目
     * @returns {{ needsSetup: boolean, authMode: string, requiredParams: string[], optionalParams: string[], paramFields: any[], setupSchema: any, oauthReady: boolean, legacy: boolean }} 连接需求
     */
    function connectorSetupOf(item) {
      const raw = item !== null && typeof item === "object" ? item : {};
      const authMode = typeof raw.authMode === "string" ? raw.authMode : "";
      const requiredParams = Array.isArray(raw.requiredParams)
        ? raw.requiredParams.filter((name) => typeof name === "string" && name !== "").slice()
        : [];
      const optionalParams = Array.isArray(raw.optionalParams)
        ? raw.optionalParams.filter((name) => typeof name === "string" && name !== "").slice()
        : [];
      const schemaFields = Array.isArray(raw.paramFields)
        ? raw.paramFields.filter((field) => field !== null && typeof field === "object" &&
            typeof field.key === "string" && field.key !== "").map((field) => ({
            key: field.key,
            label: typeof field.label === "string" && field.label !== "" ? field.label : field.key,
            placeholder: typeof field.placeholder === "string" ? field.placeholder : "",
            description: typeof field.description === "string" ? field.description : "",
            required: field.required === true,
            type: "password"
          }))
        : [];
      const setupSchema = raw.setupSchema !== null && typeof raw.setupSchema === "object" ? raw.setupSchema : null;
      const oauthReady = raw.oauthReady === true;
      const hasMeta = typeof raw.needsSetup === "boolean" || authMode !== "" ||
        requiredParams.length > 0 || optionalParams.length > 0 || schemaFields.length > 0;
      if (!hasMeta) {
        return {
          needsSetup: true, authMode: "", requiredParams: [], optionalParams: [],
          paramFields: [], setupSchema: null, oauthReady: false, legacy: true
        };
      }
      const needsSetup = typeof raw.needsSetup === "boolean"
        ? raw.needsSetup
        : (authMode === "token" || authMode === "oauth" || authMode === "oneid-token" || requiredParams.length > 0);
      /* 表单字段优先用 schema 的中文 label/placeholder；老数据只有名单时按变量名构造。 */
      const paramFields = schemaFields.length > 0
        ? schemaFields
        : requiredParams.map((key) => ({
            key, label: key, placeholder: "", description: "", required: true, type: "password"
          })).concat(optionalParams.map((key) => ({
            key, label: key, placeholder: "", description: "", required: false, type: "password"
          })));
      return { needsSetup, authMode, requiredParams, optionalParams, paramFields, setupSchema, oauthReady, legacy: false };
    }

    /**
     * 参数输入框的标签：优先用 schema 的中文 label；
     * 「必填 / 选填」标记只在 label 本身没有这些字眼时才追加，避免重复啰嗦。
     * @param {any} field 参数字段
     * @returns {string} 标签文本
     */
    function paramLabelOf(field) {
      const label = String(field.label || field.key);
      if (field.required === true) return label.indexOf("必填") >= 0 ? label : label + "（必填）";
      return label.indexOf("选填") >= 0 || label.indexOf("可选") >= 0 ? label : label + "（选填，可留空）";
    }

    /**
     * 连接器卡片：40 图标 + 名称 + 按钮 + 两行描述。
     * 免认证 / 已连接显示对话气泡（点了就常驻到会话），需连接显示「+」（打开连接弹窗）。
     * 卡片主体点击打开详情，按钮点击不冒泡。
     * @param {{ item: any, connected: boolean, onOpen: Function, onConnect: Function, onApply: Function }} props 属性
     * @returns {any} React 元素
     */
    function ConnectorCard(props) {
      const item = props.item;
      const [broken, setBroken] = useState(false);
      const name = trimmed(item.name) || trimmed(item.id);
      const description = descOf(item.description);
      const setup = connectorSetupOf(item);
      const installed = props.installed === true || item.installed === true;
      /* 来源徽标只在已安装卡片上出现：未安装的条目还没「从哪来」这回事。 */
      const source = installed === true ? connectorSourceOf(item) : "";
      const sourceLabel = connectorSourceLabel(source);
      /* 可连接性：`connectable === false`（cli / sse / 地址含占位符）的条目照样出现在
         列表里（仓库里有多少就显示多少），但不能安装 / 连接 —— 按钮位改成一个置灰说明。 */
      const connectable = item.connectable !== false;
      const lockedReason = trimmed(item.unsupportedReason) || "该连接器暂不支持在面板内连接";
      /* 未安装 → 先安装；已安装免连接 → 直接对话；已安装需参数 → 先连接 */
      const canTalk = props.connected === true || (installed === true && setup.needsSetup === false);
      const needInstall = connectable === true && installed !== true && props.connected !== true;
      /* 来源徽标与卸载 × 放在独立的第二行：卡片最窄只有 220px，若和图标 / 名称 / 对话按钮
         全挤在 head 一行里，name 按钮会被压到只剩几个像素，长名字显示成「2.」。
         拆行后 head 只剩「图标 + 名称 + 主操作」，名称至少能占 100px 以上。 */
      const metaRow = source !== "" || (installed === true && typeof props.onUninstall === "function")
        ? h("div", { className: "dshe-conn-meta" },
            source === ""
              ? null
              : h("span", {
                  className: "dshe-conn-source dshe-conn-source-" + source,
                  "data-connector-source": source,
                  title: "来源：" + sourceLabel
                }, sourceLabel),
            installed === true && typeof props.onUninstall === "function"
              ? h("button", {
                  type: "button",
                  className: "dshe-conn-remove",
                  title: "卸载（移除本地定义，可重新安装）",
                  "aria-label": "卸载 " + name,
                  onClick: (event) => {
                    event.stopPropagation();
                    props.onUninstall(item);
                  }
                }, h(Icon, { name: "close", size: 12 }))
              : null
          )
        : null;
      return h("div", {
        className: "dshe-conn-card" + (needInstall ? " dshe-conn-card-uninstalled" : "") +
          (connectable === true ? "" : " dshe-conn-card-locked"),
        "data-connector-id": item.id,
        "data-installed": installed === true ? "1" : "0",
        "data-connector-source": source,
        "data-connectable": connectable === true ? "1" : "0",
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
          canTalk
            ? h("button", {
                type: "button",
                className: "dshe-card-apply",
                title: setup.needsSetup === false && props.connected !== true
                  ? "免连接，直接开始对话" : "引用到当前对话",
                "aria-label": "把 " + name + " 引用到当前对话",
                onClick: (event) => {
                  event.stopPropagation();
                  props.onApply(item);
                }
              }, h(Icon, { name: "chat", size: 15 }))
            : connectable === false
              ? h("span", {
                  className: "dshe-conn-locked",
                  "data-connectable": "0",
                  title: lockedReason,
                  "aria-label": name + " 不可连接：" + lockedReason
                }, "不可连接")
              : needInstall === true
                ? h("button", {
                    type: "button",
                    className: "dshe-conn-install dshe-add-btn",
                    "aria-label": "安装 " + name,
                    onClick: (event) => {
                      event.stopPropagation();
                      props.onInstall(item);
                    }
                  }, h(Icon, { name: "plus", size: 15 }))
                : h("button", {
                    type: "button",
                    className: "dshe-conn-add",
                    title: "首次使用：连接该连接器（填参数或先登录）",
                    "aria-label": "连接 " + name,
                    onClick: (event) => {
                      event.stopPropagation();
                      props.onConnect(item);
                    }
                  }, h(Icon, { name: "plus", size: 16 }))
        ),
        metaRow,
        h("div", { className: "dshe-conn-desc", title: description }, description !== "" ? description : "暂无描述")
      );
    }

    /**
     * 「+ 新增连接器」弹窗：手动填写 MCP 配置，保存为本地安装。
     *
     * 只做格式校验并保存定义（不写宿主 profile、不保存凭据）；保存后卡片变成
     * 「已安装」，需要点「+」再走一次连接才会写 profile / 加密凭据。
     *
     * @param {{ onClose: Function, onToast: Function, onCreated: Function }} props 属性
     * @returns {any} React 元素
     */
    function ConnectorCreateDialog(props) {
      const [name, setName] = useState("");
      const [description, setDescription] = useState("");
      const [transport, setTransport] = useState("streamable-http");
      const [url, setUrl] = useState("");
      const [command, setCommand] = useState("");
      const [argsText, setArgsText] = useState("");
      const [envText, setEnvText] = useState("");
      const [headersText, setHeadersText] = useState("");
      const [requiredText, setRequiredText] = useState("");
      const [submitting, setSubmitting] = useState(false);
      const [errorText, setErrorText] = useState("");

      useEffect(() => {
        const onKey = (event) => { if (event.key === "Escape") props.onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, []);

      /**
       * 把「每行 KEY=VALUE」解析成对象。
       * @param {string} text 文本
       * @returns {Record<string, string>} 键值对
       */
      function parsePairs(text) {
        const out = {};
        for (const line of String(text || "").split(/\r?\n/)) {
          const trimmedLine = line.trim();
          if (trimmedLine === "" || trimmedLine.startsWith("#")) continue;
          const at = trimmedLine.indexOf("=");
          if (at <= 0) continue;
          const key = trimmedLine.slice(0, at).trim();
          if (key === "") continue;
          out[key] = trimmedLine.slice(at + 1).trim();
        }
        return out;
      }

      /**
       * 提交：做本地必填校验后 POST /connectors/create。
       * @returns {void}
       */
      function submit() {
        if (submitting === true) return;
        const trimmedName = name.trim();
        if (trimmedName === "") { setErrorText("请填写连接器名称"); return; }
        const payload = {
          name: trimmedName,
          description: description.trim(),
          transport,
          headers: parsePairs(headersText),
          requiredParams: requiredText.split(/[,\s]+/).map((x) => x.trim()).filter((x) => x !== ""),
        };
        if (transport === "streamable-http") {
          if (url.trim() === "") { setErrorText("请填写 MCP 服务地址"); return; }
          payload.url = url.trim();
        } else {
          if (command.trim() === "") { setErrorText("请填写启动命令"); return; }
          payload.command = command.trim();
          payload.args = String(argsText || "").split(/\r?\n/).map((x) => x.trim()).filter((x) => x !== "");
          payload.env = parsePairs(envText);
        }
        setSubmitting(true);
        setErrorText("");
        fetch(API + "/connectors/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
          .then((resp) => resp.json())
          .then((res) => {
            setSubmitting(false);
            if (res !== null && res !== undefined && res.ok === true) {
              props.onToast("已安装「" + trimmedName + "」到本地");
              props.onCreated();
              props.onClose();
            } else {
              setErrorText(String((res && (res.error || res.message)) || "保存失败，请检查配置"));
            }
          })
          .catch((error) => {
            setSubmitting(false);
            setErrorText("保存失败：" + String((error && error.message) || error));
          });
      }

      const field = (labelText, input) => h("div", { className: "dshe-connect-field" },
        h("label", { className: "dshe-connect-label" }, labelText),
        input);

      return h("div", {
        className: "dshe-mask",
        onClick: (event) => { if (event.target === event.currentTarget) props.onClose(); }
      },
        h("div", {
          className: "dshe-settings",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "新增连接器"
        },
          h("button", {
            type: "button",
            className: "dshe-drawer-close",
            "aria-label": "关闭新增连接器弹窗",
            title: "关闭",
            onClick: props.onClose
          }, h(Icon, { name: "close", size: 18 })),
          h("h2", { className: "dshe-settings-title" }, "新增连接器"),
          h("div", { className: "dshe-connect-body" },
            h("p", { className: "dshe-connect-intro" },
              "手动填写 MCP 配置并保存到本地；保存后卡片会显示「+」，再点一次完成连接（写宿主配置）。"),
            field("名称（必填）", h("input", {
              className: "dshe-connect-input",
              type: "text",
              "data-create-field": "name",
              placeholder: "例如：我的知识库",
              value: name,
              onChange: (event) => setName(event.target.value)
            })),
            field("描述（可选）", h("input", {
              className: "dshe-connect-input",
              type: "text",
              "data-create-field": "description",
              placeholder: "一句话说明这个连接器能做什么",
              value: description,
              onChange: (event) => setDescription(event.target.value)
            })),
            h("div", { className: "dshe-connect-field" },
              h("label", { className: "dshe-connect-label" }, "传输方式"),
              h("div", { className: "dshe-create-tabs" },
                [["streamable-http", "Streamable HTTP"], ["stdio", "本地命令（stdio）"]].map(([value, label]) =>
                  h("button", {
                    key: value,
                    type: "button",
                    "data-create-transport": value,
                    className: "dshe-conn-view" + (transport === value ? " dshe-conn-view-on" : ""),
                    onClick: () => setTransport(value)
                  }, label))
              )),
            transport === "streamable-http"
              ? field("MCP 服务地址（必填）", h("input", {
                  className: "dshe-connect-input",
                  type: "text",
                  "data-create-field": "url",
                  placeholder: "https://example.com/mcp",
                  value: url,
                  onChange: (event) => setUrl(event.target.value)
                }))
              : h("div", null,
                  field("启动命令（必填）", h("input", {
                    className: "dshe-connect-input",
                    type: "text",
                    "data-create-field": "command",
                    placeholder: "npx",
                    value: command,
                    onChange: (event) => setCommand(event.target.value)
                  })),
                  field("命令参数（每行一个）", h("textarea", {
                    className: "dshe-connect-textarea",
                    "data-create-field": "args",
                    rows: 3,
                    placeholder: "-y\n@modelcontextprotocol/server-xxx",
                    value: argsText,
                    onChange: (event) => setArgsText(event.target.value)
                  })),
                  field("环境变量（每行 KEY=VALUE）", h("textarea", {
                    className: "dshe-connect-textarea",
                    "data-create-field": "env",
                    rows: 3,
                    placeholder: "MY_TOKEN=${MY_TOKEN}",
                    value: envText,
                    onChange: (event) => setEnvText(event.target.value)
                  }))),
            field("请求头（每行 KEY=VALUE，可选）", h("textarea", {
              className: "dshe-connect-textarea",
              "data-create-field": "headers",
              rows: 3,
              placeholder: "Authorization=Bearer ${MY_TOKEN}",
              value: headersText,
              onChange: (event) => setHeadersText(event.target.value)
            })),
            field("必填参数名（逗号分隔，可选；留空则从 ${VAR} 自动推断）", h("input", {
              className: "dshe-connect-input",
              type: "text",
              "data-create-field": "required",
              placeholder: "MY_TOKEN",
              value: requiredText,
              onChange: (event) => setRequiredText(event.target.value)
            })),
            h("p", { className: "dshe-connect-note" },
              "定义只描述这台 MCP server；连接时才会加密保存凭据并写入宿主 profile。"),
            errorText !== ""
              ? h("p", { className: "dshe-connect-error", role: "alert" }, errorText)
              : null
          ),
          h("div", { className: "dshe-settings-foot" },
            h("span", { className: "dshe-settings-foot-gap" }),
            h("button", { type: "button", className: "dshe-btn", onClick: props.onClose }, "取消"),
            h("button", {
              type: "button",
              className: "dshe-btn dshe-btn-primary",
              disabled: submitting === true,
              onClick: submit
            }, submitting === true ? "保存中…" : "保存并安装")
          )
        )
      );
    }

    /**
     * 文件夹导入弹窗：添加技能 / 导入专家 / 导入专家团。
     *
     * - 用 `<input type=file webkitdirectory>` 选文件夹；Chromium 之外用
     *   `showDirectoryPicker()` 兜底，两者都不支持时给中文提示，不静默失败；
     * - 文本文件按 utf8、二进制文件按 base64 读取，组装
     *   `{ type, rootName, files: [{ path, data, encoding }] }`；
     * - 提交前先做一次与后端同规则的轻量格式预检并展示结果，通过后才能确认导入；
     * - 导入中 / 成功 / 失败都有中文提示，成功后由 Panel 刷新对应列表。
     *
     * @param {{ type: 'skill'|'expert'|'team', onClose: Function, onToast: Function,
     *           onImported: Function }} props 组件属性
     * @returns {any} React 元素
     */
    function FolderImportDialog(props) {
      var type = props.type === "team" ? "team" : props.type === "expert" ? "expert" : "skill";
      var meta = FOLDER_TYPE_META[type];
      var [busy, setBusy] = useState("");
      var [errorText, setErrorText] = useState("");
      var [resultText, setResultText] = useState("");
      var [check, setCheck] = useState(null);
      var [payload, setPayload] = useState(null);
      var [done, setDone] = useState(false);
      var inputRef = useRef(null);

      useEffect(function () {
        var onKey = function (event) { if (event.key === "Escape") props.onClose(); };
        window.addEventListener("keydown", onKey);
        return function () { window.removeEventListener("keydown", onKey); };
      }, []);

      /**
       * 读取所选文件并做预检。
       * @param {Array<any>} list File 对象列表
       * @param {Function} pathOf 取相对路径的函数（file, index）=> string
       * @returns {Promise<void>} 完成信号
       */
      async function collectFrom(list, pathOf) {
        setErrorText("");
        setResultText("");
        setCheck(null);
        setPayload(null);
        var chosen = Array.from(list || []);
        if (chosen.length === 0) { setErrorText("没有选择任何文件，请重新选择文件夹"); return; }
        if (chosen.length > FOLDER_MAX_FILES) {
          setErrorText("文件数量超过上限（最多 200 个），请精简文件夹后重试");
          return;
        }
        setBusy("reading");
        var total = 0;
        var collected = [];
        var rootName = "";
        try {
          for (var i = 0; i < chosen.length; i += 1) {
            var file = chosen[i];
            var rawPath = String(pathOf(file, i) || file.name || "");
            /* 只有带根目录层的路径才记 rootName；老浏览器只给 file.name 时
               按「文件就在条目根下」处理，避免把文件名误当成根目录剥掉。 */
            if (rootName === "" && rawPath.indexOf("/") > 0) rootName = rawPath.split("/")[0];
            var size = Number(file.size || 0);
            if (size > FOLDER_MAX_FILE_BYTES) throw new Error("单文件超过 2MB：" + rawPath);
            total += size;
            if (total > FOLDER_MAX_TOTAL_BYTES) throw new Error("文件总大小超过 20MB 上限");
            var isText = FOLDER_TEXT_RE.test(rawPath);
            var data = isText ? await readFileText(file) : await readFileBase64(file);
            collected.push({ path: rawPath, data: data, encoding: isText ? "utf8" : "base64" });
          }
          var preflight = folderPayloadCheck(type, rootName, collected);
          setCheck(preflight);
          setPayload({ type: type, rootName: rootName, files: preflight.files });
          setErrorText(preflight.ok === true ? "" : preflight.message);
        } catch (error) {
          setCheck(null);
          setPayload(null);
          setErrorText("读取文件夹失败：" + String((error && error.message) || error));
        } finally {
          setBusy("");
        }
      }

      /**
       * 文件夹 input 变化：webkitRelativePath 就是带根目录层的相对路径。
       * @param {any} event 变更事件
       * @returns {void}
       */
      function onInputChange(event) {
        var files = event.target && event.target.files ? event.target.files : [];
        void collectFrom(files, function (file) {
          return String(file.webkitRelativePath || file.name || "");
        });
      }

      /**
       * 非 Chromium 环境兜底：用 showDirectoryPicker 递归读取目录（深度上限 8）。
       * @returns {Promise<void>} 完成信号
       */
      async function pickViaDirectoryPicker() {
        var picker = typeof window !== "undefined" ? window.showDirectoryPicker : null;
        if (typeof picker !== "function") {
          setErrorText("当前浏览器不支持文件夹选择：请使用 Chrome / Edge 等 Chromium 浏览器，或在设置里改用系统对话框支持的新版本。");
          return;
        }
        try {
          var handle = await picker();
          var rootName = String(handle.name || "import");
          var entries = [];
          /**
           * 递归遍历目录句柄。
           * @param {any} dirHandle 目录句柄
           * @param {string} prefix 路径前缀
           * @param {number} depth 当前深度
           * @returns {Promise<void>} 完成信号
           */
          async function walk(dirHandle, prefix, depth) {
            if (depth > 8 || entries.length > FOLDER_MAX_FILES) return;
            for await (var entry of dirHandle.values()) {
              if (entries.length > FOLDER_MAX_FILES) break;
              if (entry.kind === "file") {
                entries.push({ file: await entry.getFile(), path: prefix + entry.name });
              } else if (entry.kind === "directory") {
                await walk(entry, prefix + entry.name + "/", depth + 1);
              }
            }
          }
          await walk(handle, rootName + "/", 0);
          if (entries.length === 0) { setErrorText("所选文件夹里没有文件"); return; }
          await collectFrom(entries.map(function (item) { return item.file; }), function (file, index) {
            return entries[index].path;
          });
        } catch (error) {
          if (error !== null && error !== undefined && error.name === "AbortError") return;
          setErrorText("选择文件夹失败：" + String((error && error.message) || error));
        }
      }

      /**
       * 确认导入：预检通过才 POST /import/folder。
       * @returns {void}
       */
      function submit() {
        if (check === null || check.ok !== true || payload === null || busy !== "") return;
        setBusy("submitting");
        setErrorText("");
        setResultText("");
        fetch(API + "/import/folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
          .then(function (resp) { return resp.json(); })
          .then(function (res) {
            setBusy("");
            if (res !== null && res !== undefined && res.ok === true) {
              var imported = Array.isArray(res.imported) ? res.imported : [];
              var skipped = Array.isArray(res.skipped) ? res.skipped : [];
              var already = imported.filter(function (row) { return row.already === true; }).length;
              var text = "导入完成：成功 " + String(imported.length) + " 个" +
                (already > 0 ? "（其中 " + String(already) + " 个已存在，未覆盖）" : "") +
                (skipped.length > 0 ? "，跳过 " + String(skipped.length) + " 个" : "") +
                "。";
              setResultText(text);
              setDone(true);
              props.onToast(text);
              props.onImported(type, res);
              /* 不自动关闭：弹窗内保留成功提示，用户点「完成」再关。 */
            } else {
              var reason = String((res && (res.error || res.message)) || "导入失败");
              var skippedRows = res !== null && res !== undefined && Array.isArray(res.skipped) ? res.skipped : [];
              if (skippedRows.length > 0) {
                reason += "；明细：" + skippedRows.map(function (row) {
                  return String(row.dir) + "（" + String(row.reason) + "）";
                }).join("；");
              }
              setErrorText(reason);
              props.onToast("导入失败：" + reason);
            }
          })
          .catch(function (error) {
            setBusy("");
            setErrorText("导入失败：" + String((error && error.message) || error));
          });
      }

      var checkNode = null;
      if (check !== null) {
        var candidates = Array.isArray(check.candidates) ? check.candidates : [];
        checkNode = h("div", { className: "dshe-folder-check", "data-folder-check": check.ok ? "ok" : "bad" },
          h("div", { className: "dshe-folder-check-title" }, "格式预检：" + check.message),
          candidates.map(function (row) {
            var ok = row.ok === true;
            var bits = [ok ? "通过" : "未通过", "目录「" + String(row.dir) + "」"];
            if (ok && row.name) bits.push("名称「" + String(row.name) + "」");
            if (!ok && Array.isArray(row.reasons)) bits = bits.concat(row.reasons);
            if (ok && Array.isArray(row.notes)) bits = bits.concat(row.notes);
            return h("div", {
              key: String(row.dir),
              className: "dshe-folder-line " + (ok ? "dshe-folder-line-ok" : "dshe-folder-line-bad")
            }, bits.join(" · "));
          })
        );
      }

      return h("div", {
        className: "dshe-mask",
        onClick: function (event) { if (event.target === event.currentTarget) props.onClose(); }
      },
        h("div", {
          className: "dshe-settings",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": meta.title
        },
          h("button", {
            type: "button",
            className: "dshe-drawer-close",
            "aria-label": "关闭" + meta.title + "弹窗",
            onClick: props.onClose
          }, h(Icon, { name: "close", size: 18 })),
          h("h2", { className: "dshe-settings-title" }, meta.title),
          h("div", { className: "dshe-folder-body" },
            h("p", { className: "dshe-connect-intro" }, meta.hint),
            h("p", { className: "dshe-connect-note" },
              "必需文件：" + meta.required.join(" / ") +
              "；支持「所选目录本身就是一个条目」与「一级子目录各是一个条目」两种模式。"),
            h("div", { className: "dshe-folder-actions" },
              h("button", {
                type: "button",
                className: "dshe-btn",
                disabled: busy !== "",
                "data-folder-pick": "input",
                onClick: function () {
                  if (inputRef.current !== null) {
                    inputRef.current.value = "";
                    inputRef.current.click();
                  }
                }
              }, "选择文件夹"),
              h("button", {
                type: "button",
                className: "dshe-btn",
                disabled: busy !== "",
                "data-folder-pick": "picker",
                onClick: function () { void pickViaDirectoryPicker(); }
              }, "用系统对话框选择文件夹")
            ),
            h("input", {
              key: "folder-input",
              ref: inputRef,
              type: "file",
              webkitdirectory: "",
              directory: "",
              multiple: true,
              style: { display: "none" },
              onChange: onInputChange
            }),
            h("p", { className: "dshe-connect-note" },
              "当前浏览器若不支持文件夹选择，请点「用系统对话框选择文件夹」；单文件不超过 2MB、最多 200 个文件、总计不超过 20MB。同名目录已存在时不会覆盖。"),
            checkNode,
            errorText !== ""
              ? h("p", { className: "dshe-connect-error", role: "alert" }, errorText)
              : null,
            resultText !== ""
              ? h("p", { className: "dshe-folder-ok" }, resultText)
              : null
          ),
          h("div", { className: "dshe-settings-foot" },
            h("span", { className: "dshe-settings-foot-gap" }),
            done === true
              ? h("button", {
                  type: "button",
                  className: "dshe-btn dshe-btn-primary",
                  "data-folder-done": "1",
                  onClick: props.onClose
                }, "完成")
              : [
                  h("button", { key: "cancel", type: "button", className: "dshe-btn", onClick: props.onClose }, "取消"),
                  h("button", {
                    key: "submit",
                    type: "button",
                    className: "dshe-btn dshe-btn-primary",
                    "data-folder-submit": "1",
                    disabled: check === null || check.ok !== true || busy !== "",
                    onClick: submit
                  }, busy === "submitting"
                    ? [h("span", { key: "spin", className: "dshe-spin" }), "导入中…"]
                    : busy === "reading"
                      ? "读取中…"
                      : "确认导入")
                ]
          )
        )
      );
    }

    /**
     * 连接器「首次连接」弹窗。
     *
     * - 参数以 token-schema.json 的 paramFields 渲染：中文 label / placeholder / 获取链接；
     *   `required:true` 才做必填校验，`required:false` 允许留空（「留空直接连接」）；
     * - oauth / oneid-token：不放假登录表单，只给 WorkBuddy 登录引导 + 刷新状态按钮；
     * - 提交后立刻清空输入，参数值不长期留在组件 state，也不回显到任何列表 / 详情。
     *
     * @param {{ item: any, onClose: Function, onToast: Function, onConnected: Function }} props 属性
     * @returns {any} React 元素
     */
    function ConnectorConnectDialog(props) {
      const item = props.item;
      const setup = connectorSetupOf(item);
      const id = String(item.id || "");
      const name = trimmed(item.name) || trimmed(item.displayName) || id;
      const [values, setValues] = useState(() => {
        const initial = {};
        for (const field of setup.paramFields) initial[field.key] = "";
        return initial;
      });
      const [readyOverride, setReadyOverride] = useState(null);
      const [submitting, setSubmitting] = useState(false);
      const [refreshing, setRefreshing] = useState(false);
      const [errorText, setErrorText] = useState("");
      /* 连接前从后端拉「将写入哪些 profile + 配置片段」的只读预览，供用户确认。 */
      const [provisionPreview, setProvisionPreview] = useState(null);
      const optionalOnly = setup.paramFields.length > 0 && setup.requiredParams.length === 0;

      useEffect(() => {
        let cancelled = false;
        fetch(API + "/connectors/provision/preview?id=" + encodeURIComponent(id))
          .then((resp) => resp.json())
          .then((res) => {
            if (cancelled === false && res !== null && res !== undefined && res.ok === true) {
              setProvisionPreview(res);
            }
          })
          .catch(() => { /* 预览拿不到不影响手动连接 */ });
        return () => { cancelled = true; };
      }, [id]);

      useEffect(() => {
        const onKey = (event) => { if (event.key === "Escape") close(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, []);

      const isOAuth = setup.authMode === "oauth" || setup.authMode === "oneid-token";
      const oauthReady = readyOverride === null ? setup.oauthReady : readyOverride;
      const blockedByLogin = isOAuth && oauthReady === false;

      /**
       * 刷新 WorkBuddy 登录态：重新拉一次 /connectors，只取该 id 的布尔 oauthReady。
       * 不读取、不传输任何凭据。
       * @returns {void}
       */
      function refreshLoginState() {
        if (refreshing === true) return;
        setRefreshing(true);
        setErrorText("");
        fetch(API + "/connectors?limit=1000&offset=0")
          .then((resp) => resp.json())
          .then((res) => {
            const list = res !== null && res !== undefined && Array.isArray(res.items) ? res.items : [];
            const fresh = list.find((entry) => entry !== null && String(entry.id) === id);
            setReadyOverride(fresh !== undefined && fresh.oauthReady === true);
            setRefreshing(false);
          })
          .catch(() => {
            setRefreshing(false);
            setErrorText("刷新登录状态失败，请稍后重试");
          });
      }

      /**
       * 提交连接：只校验 `required:true` 的字段；选填留空允许通过。
       * 提交后立即清空输入，参数不长期留在组件 state。
       * @returns {void}
       */
      function submit() {
        if (submitting === true || blockedByLogin === true) return;
        const params = {};
        const missing = [];
        for (const field of setup.paramFields) {
          const value = typeof values[field.key] === "string" ? values[field.key] : "";
          if (value.trim() === "") {
            if (field.required === true) missing.push(field.label || field.key);
          } else {
            params[field.key] = value;
          }
        }
        if (missing.length > 0) {
          setErrorText("请填写全部参数：" + missing.join("、"));
          return;
        }
        setSubmitting(true);
        setErrorText("");
        fetch(API + "/connectors/provision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, params, confirm: true })
        })
          .then((resp) => resp.json())
          .then((res) => {
            /* 无论成败都立刻丢弃明文：组件 state 里不长期保留用户填的密钥。 */
            setValues({});
            setSubmitting(false);
            if (res !== null && res !== undefined && res.ok === true) {
              const written = Array.isArray(res.profiles) ? res.profiles : [];
              props.onToast("已写入 " + written.length + " 个 profile 的 MCP 配置；重启 dsh web 后工具可用");
              props.onConnected(id);
              props.onClose();
            } else {
              setErrorText(String((res && (res.error || res.message)) || "连接失败，请重试"));
            }
          })
          .catch((error) => {
            setValues({});
            setSubmitting(false);
            setErrorText("连接失败：" + String((error && error.message) || error));
          });
      }

      /**
       * 关闭弹窗前清空输入。
       * @returns {void}
       */
      function close() {
        setValues({});
        props.onClose();
      }

      return h("div", {
        className: "dshe-mask",
        onClick: (event) => { if (event.target === event.currentTarget) close(); }
      },
        h("div", {
          className: "dshe-settings",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "连接连接器"
        },
          h("button", {
            type: "button",
            className: "dshe-drawer-close",
            "aria-label": "关闭连接弹窗",
            title: "关闭",
            onClick: close
          }, h(Icon, { name: "close", size: 18 })),
          h("h2", { className: "dshe-settings-title" }, "连接「" + name + "」"),
          h("div", { className: "dshe-connect-body" },
            h("p", { className: "dshe-connect-intro" },
              "首次使用需要完成连接登记；完成后卡片会变为对话图标，可把该连接器挂到当前会话。"),
            setup.setupSchema !== null && setup.setupSchema.title !== ""
              ? h("p", { className: "dshe-connect-intro" }, String(setup.setupSchema.title))
              : null,
            setup.setupSchema !== null && setup.setupSchema.description !== ""
              ? h("p", { className: "dshe-connect-intro" }, String(setup.setupSchema.description))
              : null,
            setup.setupSchema !== null && typeof setup.setupSchema.docUrl === "string" &&
              /^https?:\/\//i.test(setup.setupSchema.docUrl)
              ? h("a", {
                  className: "dshe-connect-doc",
                  href: String(setup.setupSchema.docUrl),
                  target: "_blank",
                  rel: "noopener noreferrer"
                }, String(setup.setupSchema.docLabel || "如何获取凭据？"))
              : null,
            isOAuth
              ? h("p", {
                  className: "dshe-connect-guide" + (oauthReady === true ? " dshe-connect-guide-ok" : ""),
                  role: "status"
                }, oauthReady === true
                  ? "已在 WorkBuddy 完成登录，可直接完成连接。"
                  : "此连接器需在 WorkBuddy 里完成登录，请先在 WorkBuddy 连接后再回来")
              : null,
            blockedByLogin === true
              ? h("div", { className: "dshe-connect-fields" },
                  h("button", {
                    type: "button",
                    className: "dshe-btn",
                    disabled: refreshing === true,
                    onClick: refreshLoginState
                  }, refreshing === true ? "正在刷新…" : "刷新登录状态"))
              : null,
            setup.paramFields.length > 0
              ? h("div", { className: "dshe-connect-fields" },
                  setup.paramFields.map((field) => h("div", {
                    key: field.key,
                    className: "dshe-connect-field"
                  },
                    h("label", {
                      className: "dshe-connect-label",
                      htmlFor: "dshe-connect-" + field.key
                    }, paramLabelOf(field)),
                    h("input", {
                      id: "dshe-connect-" + field.key,
                      className: "dshe-connect-input",
                      type: "password",
                      autoComplete: "off",
                      spellCheck: false,
                      placeholder: String(field.placeholder || ""),
                      value: typeof values[field.key] === "string" ? values[field.key] : "",
                      disabled: submitting === true,
                      "aria-label": String(field.label),
                      "data-param-key": String(field.key),
                      onChange: (event) => {
                        const next = Object.assign({}, values);
                        next[field.key] = event.target.value;
                        setValues(next);
                      },
                      onKeyDown: (event) => { if (event.key === "Enter") submit(); }
                    }),
                    String(field.description || "") !== ""
                      ? h("p", { className: "dshe-connect-note" }, String(field.description))
                      : null
                  ))
                )
              : null,
            optionalOnly
              ? h("p", { className: "dshe-connect-note" }, "以上参数均可留空，直接点「留空直接连接」即可完成登记。")
              : null,
            provisionPreview !== null && provisionPreview.ok === true
              ? h("div", { className: "dshe-connect-provision" },
                  h("p", { className: "dshe-connect-note" },
                    "确认后会自动把 MCP 配置写入以下宿主 profile（写入前逐个备份，同 id 不重复写）："),
                  h("ul", { className: "dshe-connect-paths" },
                    (Array.isArray(provisionPreview.targets) ? provisionPreview.targets : []).map((target) =>
                      h("li", { key: String(target.name) }, String(target.file)))),
                  h("details", { className: "dshe-connect-snippet" },
                    h("summary", null, "查看将写入的配置片段"),
                    h("pre", null, String(provisionPreview.snippet || ""))),
                  h("p", { className: "dshe-connect-note" },
                    "片段只含「读取本地加密凭据」的表达式，不含凭据；新增实例需重启 dsh web 后生效。"))
              : null,
            h("p", { className: "dshe-connect-note" },
              "填写的参数会加密保存到本地（不写进配置文件、不回显）；点确认后自动完成宿主 MCP 配置。"),
            errorText !== ""
              ? h("p", { className: "dshe-connect-error", role: "alert" }, errorText)
              : null
          ),
          h("div", { className: "dshe-settings-foot" },
            h("span", { className: "dshe-settings-foot-gap" }),
            h("button", { type: "button", className: "dshe-btn", onClick: close }, "取消"),
            blockedByLogin === true
              ? null
              : h("button", {
                  type: "button",
                  className: "dshe-btn dshe-btn-primary",
                  disabled: submitting === true,
                  onClick: submit
                }, submitting === true ? "写入中…" : (optionalOnly ? "留空并写入配置" : "确认写入并连接"))
          )
        )
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
          /* 有 `_icon.*` 就用真实图标；没有时 assetUrl 返回 null，Avatar 自动回落首字母。 */
          iconSrc: assetUrl(item.icon),
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
      /* 来源 / 安装状态 / 安装时间 / 本地定义文件：已安装条目才展示来源徽标语义。 */
      const installed = item.installed === true;
      const source = connectorSourceOf(item);
      const sourceLabel = connectorSourceLabel(source);
      const installedAtText = installed ? formatStamp(item.installedAt) : "";
      const defFile = installed ? trimmed(item.file) : "";

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
              trimmed(item.url) === "" ? "" : "地址：" + trimmed(item.url),
              sourceLabel === "" ? "" : "来源：" + sourceLabel,
              "安装状态：" + (installed ? "已安装" : "未安装"),
              /* 可连接性：不可连接时把后端给的中文原因原样展示，用户才知道为什么点了没反应。 */
              "可连接性：" + (item.connectable === false
                ? "不可连接（" + (trimmed(item.unsupportedReason) || "传输方式不受支持") + "）"
                : "可连接"),
              installedAtText === "" ? "" : "安装时间：" + installedAtText,
              defFile === "" ? "" : "本地定义文件：" + defFile
            ]
          })
        )
      );
    }

    // =======================================================================
    // 设置弹窗（数据源：git 仓库地址或本机资源目录）
    // =======================================================================

    /**
     * 校验资源地址输入：https://、git@ 或本机目录绝对地址（与后端 parseSource 同规则）。
     * 浏览器拿不到 fs，这里只做格式提前提示；本机目录是否存在由后端保存时校验。
     * 本机目录允许含空格与 ..，相对路径必须给出「绝对路径」的明确提示。
     * @param {string} value 用户输入
     * @returns {string} 错误文案；合法返回空串
     */
    function settingsUrlError(value) {
      const trimmed = String(value || "").trim();
      if (trimmed === "") return "仓库地址不能为空";
      if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "地址中含非法字符";
      /* git 形式沿用旧规则：不得含空白或 ..，且必须满足各自的形态。 */
      if (trimmed.startsWith("git@")) {
        if (/\s/.test(trimmed) || trimmed.includes("..")) return "地址中含非法字符";
        return /^git@[^\s/:\\]+:[^\s]+$/.test(trimmed) ? "" : "git@ 地址格式形如 git@host:owner/repo.git";
      }
      if (/^https?:\/\//i.test(trimmed)) {
        if (/\s/.test(trimmed) || trimmed.includes("..")) return "地址中含非法字符";
        return /^https?:\/\/[^\s]+$/i.test(trimmed) ? "" : "git 仓库地址格式不正确";
      }
      /* 其它协议一律不接受，避免 ssh:// 之类被当成相对路径。 */
      if (/^(?:ssh|ftp|sftp|ws|wss):\/\//i.test(trimmed)) {
        return "数据源地址不支持该协议：请填 http://、https://、git@ 或本机目录绝对路径";
      }
      /* ~ 与 ~/... 由后端展开成用户主目录，格式上直接放行。 */
      if (trimmed === "~" || trimmed.indexOf("~/") === 0 || trimmed.indexOf("~\\") === 0) return "";
      let candidate = trimmed;
      if (/^file:\/\//i.test(trimmed)) {
        try {
          const parsed = new URL(trimmed);
          if (parsed.protocol !== "file:") return "file:// 地址格式不正确";
          const host = parsed.hostname === "" || parsed.hostname === "localhost" ? "" : parsed.hostname;
          candidate = host === "" ? parsed.pathname : "//" + host + parsed.pathname;
          try { candidate = decodeURIComponent(candidate); } catch (decodeError) { /* 保留含 % 的原始路径 */ }
        } catch (error) {
          return "file:// 地址格式不正确";
        }
        if (/[\u0000-\u001f\u007f]/.test(candidate)) return "地址中含非法字符";
      }
      /* POSIX 绝对路径 /...、Windows 盘符 C:\... 与 C:/...、UNC \\server\share 都算绝对地址。 */
      const absolute = candidate.charAt(0) === "/" || candidate.charAt(0) === "\\" ||
        /^[A-Za-z]:[\\/]/.test(candidate) || /^\\\\/.test(candidate);
      if (!absolute) {
        return "本机目录请填绝对路径（如 /home/me/dsh-buddy-expert-hub-resource 或 D:\\data\\resource）；相对路径不支持";
      }
      return "";
    }

    /**
     * 判断当前输入的资源地址是否为远程 git 源（http://、https:// 或 git@ 且格式合法）。
     * 只有这种情况才显示分支配置：本机目录模式后端不执行任何 git 命令。
     * @param {string} value 用户输入的地址
     * @returns {boolean} 是否远程 git 源
     */
    function isGitSourceInput(value) {
      const trimmed = String(value || "").trim();
      if (!/^https?:\/\//i.test(trimmed) && trimmed.indexOf("git@") !== 0) return false;
      return settingsUrlError(trimmed) === "";
    }

    /**
     * 设置弹窗：配置数据源（git 仓库地址或本机资源目录）。
     * 复用居中弹窗骨架的小号变体；Esc / 点遮罩关闭；非法输入内联红字且禁用保存。
     * @param {{ onClose: Function, onToast: Function, libraryMode: boolean }} props 属性
     * @returns {any} React 元素
     */
    function SettingsDialog(props) {
      const [loaded, setLoaded] = useState(false);
      const [sourceUrl, setSourceUrl] = useState("");
      const [defaultUrl, setDefaultUrl] = useState("");
      const [usingDefault, setUsingDefault] = useState(true);
      /* 资源仓库分支：仅远程 git 源可用。branchOptions 来自 /settings/branches，
         拉取失败时仍允许手填（datalist 只是候选，不是强制选择）。 */
      const [sourceBranch, setSourceBranch] = useState("");
      const [defaultBranch, setDefaultBranch] = useState("");
      const [branchOptions, setBranchOptions] = useState([]);
      const [branchLoading, setBranchLoading] = useState(false);
      const [branchHint, setBranchHint] = useState("");
      /* 私有 Git 仓库凭据：令牌不回显；留空表示保持已保存的值。 */
      const [sourceAuthUser, setSourceAuthUser] = useState("");
      const [sourceAuthToken, setSourceAuthToken] = useState("");
      const [sourceAuthConfigured, setSourceAuthConfigured] = useState(false);
      const [privateRepo, setPrivateRepo] = useState(false);
      const [privateRepoManual, setPrivateRepoManual] = useState(false);
      const [authHint, setAuthHint] = useState("");
      const [authClear, setAuthClear] = useState(false);
      const [skillhubUrl, setSkillhubUrl] = useState("");
      const [skillhubTouched, setSkillhubTouched] = useState(false);
      /* 内置技能开关：由 GET /settings 的 builtinSkills / builtinSkillCount /
         builtinPlatform 初始化；切换走 POST /builtin/skills/toggle。
         builtinSkillPluginCount / builtinSkillExcluded 是「其中 N 个来自内置插件、
         另有 M 个未纳入」用的两个数，后端缺这两个字段时保持 null（文案只显示总数）。 */
      const [builtinSkills, setBuiltinSkills] = useState(false);
      const [builtinPlatform, setBuiltinPlatform] = useState("");
      const [builtinSkillCount, setBuiltinSkillCount] = useState(0);
      const [builtinSkillPluginCount, setBuiltinSkillPluginCount] = useState(null);
      const [builtinSkillExcluded, setBuiltinSkillExcluded] = useState(null);
      const [builtinBusy, setBuiltinBusy] = useState(false);
      /* v2 配置分层：工作台设置已整体迁到独立的 WorkbenchSettingsDialog，
         这里只保留专家 / 资源仓库 / 内置技能开关等专家配置，不再读写工作台字段。 */
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
              setSourceBranch(typeof res.sourceBranch === "string" ? res.sourceBranch : "");
              setDefaultBranch(typeof res.defaultBranch === "string" ? res.defaultBranch : "");
              setSkillhubUrl(String(res.skillhubUrl || ""));
              setSourceAuthUser(String(res.sourceAuthUser || ""));
              setSourceAuthConfigured(res.sourceAuthConfigured === true);
              setBuiltinSkills(res.builtinSkills === true);
              setBuiltinPlatform(typeof res.builtinPlatform === "string" ? res.builtinPlatform : "");
              setBuiltinSkillCount(typeof res.builtinSkillCount === "number" ? res.builtinSkillCount : 0);
              setBuiltinSkillPluginCount(typeof res.builtinSkillPluginCount === "number" ? res.builtinSkillPluginCount : null);
              setBuiltinSkillExcluded(typeof res.builtinSkillExcluded === "number" ? res.builtinSkillExcluded : null);
              setLoaded(true);
              // 当前是远程 git 源时顺手拉一次分支候选；失败不阻断设置，仍可手填。
              if (res.branchSupported === true) pullBranches(String(res.sourceUrl || ""), () => cancelled);
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

      /**
       * 拉取远程分支候选。只读接口，失败只改提示文案，绝不阻断保存或清空手填值。
       * @param {string} url 资源仓库地址
       * @param {Function} [guard] 返回 true 表示组件已卸载，跳过 setState
       * @returns {void}
       */
      function pullBranches(url, guard) {
        const target = String(url || "").trim();
        if (!isGitSourceInput(target)) { setBranchOptions([]); setBranchHint(""); setPrivateRepo(false); setAuthHint(""); return; }
        setBranchLoading(true);
        /* 自动判定私有仓库：匿名 ls-remote 遇认证类失败即判私有；网络问题不猜测，
           分支栏里的勾选框可手动兜底。探测与分支拉取并行，互不阻塞。 */
        fetchJson("/settings/probe?url=" + encodeURIComponent(target))
          .then((probe) => {
            if (typeof guard === "function" && guard() === true) return;
            if (probe !== null && probe !== undefined && probe.ok === true && probe.private === true) {
              setPrivateRepo(true);
              setAuthHint("检测到私有仓库，请填写 Git 用户名与访问令牌");
            } else if (probe !== null && probe !== undefined && probe.ok === true && probe.private === false) {
              setPrivateRepo(false);
              setAuthHint("公开仓库，无需凭据");
            } else {
              setAuthHint("无法自动判定是否私有，可勾选「这是私有仓库」手动填写");
            }
          })
          .catch(() => {
            if (typeof guard === "function" && guard() === true) return;
            setAuthHint("无法自动判定是否私有，可勾选「这是私有仓库」手动填写");
          });
        fetchJson("/settings/branches?url=" + encodeURIComponent(target))
          .then((list) => {
            if (typeof guard === "function" && guard() === true) return;
            if (list !== null && list !== undefined && list.ok === true && Array.isArray(list.branches)) {
              setBranchOptions(list.branches);
              setBranchHint(list.branches.length > 0
                ? "已获取 " + String(list.branches.length) + " 个远端分支" + (list.truncated === true ? "（已截断）" : "")
                : "远端没有可用分支，可手动填写");
            } else {
              /* 「未知接口 / 404」说明宿主进程里的 lib/index.js 还是旧版本：
                 插件以 link: 装进 profile，后端模块只在进程启动时 import 一次，
                 刷新页面只会更新前端资源。给可操作提示，别把原始 404 丢给用户。 */
              const rawError = String((list && list.error) || "");
              setBranchHint(/未知接口|404|Not Found/i.test(rawError)
                ? "后端尚未加载新版本：请重启 dsh web 进程后重试（刷新页面无效）；也可直接手动填写分支名"
                : (rawError !== "" ? rawError + "（也可手动填写分支名）" : "获取分支失败，可手动填写分支名"));
            }
          })
          .catch(() => {
            if (typeof guard === "function" && guard() === true) return;
            setBranchHint("获取分支失败，可手动填写分支名");
          })
          .finally(() => {
            if (typeof guard === "function" && guard() === true) return;
            setBranchLoading(false);
          });
      }

      const trimmedValue = String(sourceUrl || "").trim();
      const isGitSource = isGitSourceInput(trimmedValue);
      const errorText = touched && trimmedValue !== "" ? settingsUrlError(trimmedValue) : "";
      const skillhubTrimmed = String(skillhubUrl || "").trim();
      const skillhubError = skillhubTouched && skillhubTrimmed !== "" && !/^https?:\/\/[^\s]+$/.test(skillhubTrimmed)
        ? "Skillhub 地址需为 http(s):// 形式（内网可用 http）"
        : "";
      const canSave = loaded && saving === false && trimmedValue !== "" && errorText === "" && skillhubError === "";
      const showAuthFields = isGitSource && (privateRepo === true || privateRepoManual === true);

      /**
       * 标记清除已保存的私有仓库凭据（保存后生效）。
       * @returns {void}
       */
      function clearSourceAuth() {
        setAuthClear(true);
        setSourceAuthConfigured(false);
        setSourceAuthToken("");
        setAuthHint("已标记清除凭据，保存后生效");
      }

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
          body: JSON.stringify({
            sourceUrl: trimmedValue,
            sourceBranch: isGitSource ? String(sourceBranch || "").trim() : "",
            skillhubUrl: skillhubTrimmed,
            sourceAuthUser: showAuthFields ? String(sourceAuthUser || "").trim() : "",
            sourceAuthToken: showAuthFields ? String(sourceAuthToken || "") : "",
            sourceAuthClear: authClear === true
          })
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
              setSourceBranch(String(res.sourceBranch || ""));
              setDefaultBranch(typeof res.defaultBranch === "string" ? res.defaultBranch : "");
              setBranchOptions([]);
              setBranchHint("");
              setSkillhubUrl(String(res.skillhubUrl || ""));
              setSourceAuthUser("");
              setSourceAuthToken("");
              setSourceAuthConfigured(false);
              setPrivateRepo(false);
              setPrivateRepoManual(false);
              setAuthClear(false);
              setAuthHint("");
              if (res.branchSupported === true) pullBranches(String(res.sourceUrl || ""));
              props.onToast("已恢复默认仓库地址");
            } else {
              props.onToast((res && (res.error || res.message)) || "恢复默认失败");
            }
          })
          .catch((error) => props.onToast("恢复默认失败：" + String((error && error.message) || error)))
          .finally(() => setSaving(false));
      }

      /**
       * 切换内置技能总开关：POST /builtin/skills/toggle。
       *
       * 开启 = 把插件内置的 N 个技能全部安装到本地技能库（后端幂等，重复开启等于版本升级）；
       * 关闭 = 只移除自己装进来的那些（用户同名技能不受影响，后端按落盘标记判定）。
       * 失败必须把开关**回滚**到原状态并给中文错误 —— 绝不留一个假的「已开启」。
       * @param {boolean} next 目标状态
       * @returns {void}
       */
      function toggleBuiltinSkills(next) {
        if (builtinBusy === true) return;
        const previous = builtinSkills === true;
        setBuiltinSkills(next === true);
        setBuiltinBusy(true);
        fetch(API + "/builtin/skills/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: next === true })
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              const counts = res.counts !== null && res.counts !== undefined ? res.counts : {};
              if (typeof counts.available === "number") setBuiltinSkillCount(counts.available);
              setBuiltinSkills(res.enabled === true);
              if (next === true) {
                const added = typeof res.installed === "number" ? res.installed : 0;
                const updated = typeof res.updated === "number" ? res.updated : 0;
                const skipped = Array.isArray(res.skipped) ? res.skipped.length : 0;
                let message = "已安装 " + String(added + updated) + " 个内置技能";
                if (updated > 0) message += "（其中 " + String(updated) + " 个为覆盖升级）";
                if (skipped > 0) message += "，" + String(skipped) + " 个跳过（同名技能已存在，未覆盖）";
                props.onToast(message);
              } else {
                const removed = Array.isArray(res.removed) ? res.removed.length : 0;
                props.onToast("已移除 " + String(removed) + " 个内置技能");
              }
              return;
            }
            setBuiltinSkills(previous);
            props.onToast((res && (res.error || res.message)) || "内置技能开关失败");
          })
          .catch((error) => {
            setBuiltinSkills(previous);
            props.onToast("内置技能开关失败：" + String((error && error.message) || error));
          })
          .finally(() => setBuiltinBusy(false));
      }

      /* 开关描述里的 N / M 与平台都取自后端（builtinSkillCount / builtinSkillPluginCount /
         builtinSkillExcluded / builtinPlatform），不在这里硬编码，
         避免与 builtin/<platform> 实际内容漂移。
         后端是老版本、没有这些新字段时（拿到 null）只显示总数。 */
      const builtinPluginPart = "";
      const builtinDesc = "开启后把插件内置的 " + String(builtinSkillCount) + " 个技能全部安装到本地技能库"
        + "（按当前系统取 builtin/" + (builtinPlatform === "" ? "当前平台" : builtinPlatform) + "）；"
        + builtinPluginPart
        + "这些技能不在列表里显示，关闭开关会移除它们";

      /* embedded：挂进 dsh 设置页时不要遮罩、不要关闭按钮（外壳与标题由设置页提供）。 */
      const embedded = props.embedded === true;
      return h("div", {
        className: "dshe-mask" + (embedded ? " dshe-mask-embedded" : ""),
        onClick: embedded ? undefined : (event) => { if (event.target === event.currentTarget) props.onClose(); }
      },
        h("div", {
          className: "dshe-settings" + (embedded ? " dshe-settings-embedded" : ""),
          role: embedded ? "region" : "dialog",
          "aria-modal": embedded ? undefined : "true",
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
                  placeholder: defaultUrl || "https://example.com/repo.git 或 /home/me/dsh-buddy-expert-hub-resource",
                  disabled: loaded === false || saving === true,
                  spellCheck: false,
                  onChange: (event) => { setTouched(true); setSourceUrl(event.target.value); },
                  onKeyDown: (event) => { if (event.key === "Enter") doSave(); }
                }),
                errorText !== ""
                  ? h("p", { className: "dshe-settings-hint-err", role: "alert" }, errorText)
                  : h("p", { className: "dshe-settings-hint" }, "支持 http://、https://、git@ 或本机目录（如 /home/me/dsh-buddy-expert-hub-resource、D://data//resource）；保存后下次同步生效"),
                props.libraryMode
                  ? h("p", { className: "dshe-settings-note" }, "当前为本地资料库模式，保存的地址在切回原数据源后生效")
                  : null
              ),
            /* 分支配置只在远程 git 源出现（本机目录模式后端不执行任何 git 命令）。
               候选来自 /settings/branches，但输入框始终可编辑 —— 私有仓库拿不到
               分支列表时也能手动填写，不依赖网络请求成功。 */
            isGitSource
              ? h("div", { className: "dshe-settings-field" },
                  h("label", { className: "dshe-settings-label", htmlFor: "dshe-settings-branch" }, "资源仓库分支（可选）"),
                  h("div", { className: "dshe-settings-branch-row" },
                    h("input", {
                      id: "dshe-settings-branch",
                      className: "dshe-settings-input",
                      type: "text",
                      list: "dshe-settings-branch-options",
                      value: sourceBranch,
                      placeholder: defaultBranch !== "" ? defaultBranch : "跟随远端默认分支（远端 HEAD）",
                      disabled: loaded === false || saving === true,
                      spellCheck: false,
                      onChange: (event) => setSourceBranch(event.target.value)
                    }),
                    h("button", {
                      type: "button",
                      className: "dshe-btn",
                      disabled: loaded === false || saving === true || branchLoading === true,
                      onClick: () => pullBranches(trimmedValue)
                    }, branchLoading === true ? "读取中…" : "获取分支")
                  ),
                  h("datalist", { id: "dshe-settings-branch-options" },
                    branchOptions.map((name) => h("option", { key: name, value: name }))
                  ),
                  h("p", { className: "dshe-settings-hint" },
                    branchHint !== ""
                      ? branchHint
                      : (defaultBranch !== "" ? "留空使用默认分支 " + defaultBranch : "留空跟随远端默认分支（远端 HEAD）")
                        + "；可从远端获取后选择，也可手动填写，保存后下次同步生效"
                  ),
                  h("label", { className: "dshe-settings-check" },
                    h("input", {
                      type: "checkbox",
                      checked: privateRepoManual === true,
                      disabled: loaded === false || saving === true,
                      onChange: (event) => setPrivateRepoManual(event.target.checked === true)
                    }),
                    "这是私有仓库（自动探测失败时手动勾选）"
                  )
                )
              : null,
            showAuthFields
              ? h("div", { className: "dshe-settings-field" },
                  h("div", { className: "dshe-settings-label" }, "私有仓库凭据"),
                  h("div", { className: "dshe-settings-auth-row" },
                    h("input", {
                      id: "dshe-settings-git-user",
                      className: "dshe-settings-input",
                      type: "text",
                      value: sourceAuthUser,
                      placeholder: "Git 用户名",
                      disabled: loaded === false || saving === true,
                      spellCheck: false,
                      autoComplete: "off",
                      onChange: (event) => { setSourceAuthUser(event.target.value); setAuthClear(false); }
                    }),
                    h("input", {
                      id: "dshe-settings-git-token",
                      className: "dshe-settings-input",
                      type: "password",
                      value: sourceAuthToken,
                      placeholder: sourceAuthConfigured ? "已保存，留空保持不变" : "访问令牌 / PAT",
                      disabled: loaded === false || saving === true,
                      autoComplete: "new-password",
                      onChange: (event) => { setSourceAuthToken(event.target.value); setAuthClear(false); }
                    })
                  ),
                  h("p", { className: "dshe-settings-hint" },
                    authHint !== "" ? authHint + (sourceAuthConfigured ? "（已保存凭据）" : "")
                      : "令牌用 AES-256-GCM 加密保存在本地，绝不回显；留空保持已保存的值。",
                    sourceAuthConfigured
                      ? h("button", { type: "button", className: "dshe-btn", disabled: saving === true, onClick: clearSourceAuth }, "清除") : null
                  )
                )
              : null,
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
            /* 内置技能开关：开启 = 全量安装到本地技能库（界面不可见），关闭 = 移除。
               用 label 包住原生 checkbox，点文字也能切换，且只会触发一次 onChange。 */
            h("div", { className: "dshe-settings-field" },
                h("div", { className: "dshe-settings-label" }, "内置技能"),
                h("label", {
                  className: "dshe-settings-switch" + (builtinSkills === true ? " dshe-settings-switch-on" : ""),
                  role: "switch",
                  "aria-checked": builtinSkills === true,
                  "aria-label": "启用内置技能"
                },
                  h("input", {
                    className: "dshe-settings-switch-input",
                    type: "checkbox",
                    checked: builtinSkills === true,
                    disabled: loaded === false || saving === true || builtinBusy === true,
                    onChange: (event) => toggleBuiltinSkills(event.target.checked === true)
                  }),
                  h("span", { className: "dshe-settings-switch-track", "aria-hidden": "true" },
                    h("span", { className: "dshe-settings-switch-knob" })
                  ),
                  h("span", { className: "dshe-settings-switch-text" }, "启用内置技能")
                ),
                h("p", { className: "dshe-settings-hint" }, builtinDesc)
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

    /**
     * 独立「工作台设置」弹窗（与专家 SettingsDialog 完全分离）。
     *
     * 只有两块：数据目录 / 同步间隔、创建能力。页面主题与菜单风格都不在这里 ——
     * 工作台页面的菜单、配色、排版全部由生成的 HTML 自己控制，插件不注入样式、
     * 也不提供风格选择。
     * @param {{ onClose: Function, onToast: Function, onSaved?: Function }} props 属性
     * @returns {any} React 元素
     */
    function WorkbenchSettingsDialog(props) {
      const [loaded, setLoaded] = useState(false);
      const [loadError, setLoadError] = useState("");
      const [saving, setSaving] = useState(false);
      const [dataDir, setDataDir] = useState("");
      const [syncMs, setSyncMs] = useState("2000");
      const [htmlDir, setHtmlDir] = useState("");
      const [dataDirReady, setDataDirReady] = useState(false);
      /* 后端尚未加载新版（无 /workbench/settings，宿主进程只 import 一次后端模块）时，
         回落旧 GET/POST /settings 的扁平字段，保证老宿主也能改数据目录与同步间隔。
         用独立状态记录，避免把「配置分层」又混回专家设置弹窗。 */
      const [legacy, setLegacy] = useState(false);
      const [legacySourceUrl, setLegacySourceUrl] = useState("");

      /** 把 GET /workbench/settings 的响应回填到全部字段。 */
      function applySettings(res) {
        setDataDir(typeof res.dataDir === "string" ? res.dataDir : "");
        setSyncMs(String(typeof res.syncMs === "number" ? res.syncMs : 2000));
        setHtmlDir(typeof res.htmlDir === "string" ? res.htmlDir : "");
        setDataDirReady(res.dataDirReady === true);
      }

      /** 旧版回落：把 GET /settings 的扁平字段映射进本弹窗的字段。 */
      function applyLegacySettings(res) {
        setDataDir(typeof res.workbenchDataDir === "string" ? res.workbenchDataDir : "");
        setSyncMs(String(typeof res.syncIntervalMs === "number" ? res.syncIntervalMs : 2000));
        setHtmlDir(typeof res.workbenchHtmlDir === "string" ? res.workbenchHtmlDir : "");
        setDataDirReady(res.workbenchDataDirReady === true);
        setLegacySourceUrl(typeof res.sourceUrl === "string" ? res.sourceUrl : "");
        setLegacy(true);
      }

      useEffect(() => {
        let cancelled = false;
        fetchJson("/workbench/settings")
          .then((res) => {
            if (cancelled) return;
            /* 新版后端会带 dataDir / order / autoSync 这组字段（老版本宿主对未知路由
               返回空成功体）。只有数据齐全才算新版响应，否则回落 /settings，
               绝不把空值当成功。 */
            if (res !== null && res !== undefined && res.ok === true &&
                typeof res.dataDir === "string" && Array.isArray(res.order) &&
                typeof res.autoSync === "boolean") {
              applySettings(res);
              setLoaded(true);
              return;
            }
            return fetchJson("/settings").then((old) => {
              if (cancelled) return;
              if (old !== null && old !== undefined && old.ok === true) {
                applyLegacySettings(old);
                setLoaded(true);
              } else {
                setLoadError((old && (old.error || old.message)) || "无法读取工作台设置");
              }
            });
          })
          .catch(() => {
            if (cancelled) return;
            /* 新端点不可用（404 / 网络异常）同样回落 /settings。 */
            fetchJson("/settings")
              .then((old) => {
                if (cancelled) return;
                if (old !== null && old !== undefined && old.ok === true) {
                  applyLegacySettings(old);
                  setLoaded(true);
                } else {
                  setLoadError((old && (old.error || old.message)) || "无法读取工作台设置");
                }
              })
              .catch((error) => {
                if (!cancelled) setLoadError(String((error && error.message) || error));
              });
          });
        return () => { cancelled = true; };
      }, []);

      useEffect(() => {
        const onKey = (event) => { if (event.key === "Escape") props.onClose(); };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
      }, []);

      const syncValue = String(syncMs || "").trim();
      const wbSyncError = syncValue !== "" &&
        (!/^\d+$/.test(syncValue) || Number(syncValue) < 500 || Number(syncValue) > 60000)
        ? "同步间隔需为 500-60000 之间的整数毫秒"
        : "";
      const canSave = loaded === true && saving === false && wbSyncError === "";

      /** 保存：新版走 POST /workbench/settings；老版本宿主回落 POST /settings 扁平字段。 */
      function doSave() {
        if (!canSave) return;
        setSaving(true);
        const trimmedDir = String(dataDir || "").trim();
        const numericMs = syncValue === "" ? "" : Number(syncValue);
        const endpoint = legacy === true ? "/settings" : "/workbench/settings";
        const body = legacy === true
          ? { sourceUrl: legacySourceUrl, workbenchDataDir: trimmedDir, syncIntervalMs: numericMs }
          : { dataDir: trimmedDir, syncMs: numericMs };
        fetch(API + endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              if (legacy !== true) {
                applySettings(res);
                if (typeof props.onSaved === "function") props.onSaved(res);
              }
              /* legacy 回落只写旧扁平字段，菜单风格不落库：必须明确告知用户，
                 避免「改了菜单风格、点保存、以为生效」的静默失败。 */
              props.onToast(legacy === true
                ? "已保存（旧版宿主：数据目录与同步间隔已写入，请重启 dsh 进程后生效）"
                : "已保存");
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

      /** 打开工作台数据目录：优先让插件后端用系统文件管理器打开；失败则回退为复制真实路径。 */
      function openHtmlDir() {
        fetch(API + "/workbench/open-html-dir", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
          .then((resp) => resp.json())
          .then((resp) => resp.json().then((res) => ({ status: resp.status, res })).catch(() => ({ status: resp.status, res: null })))
          .then(({ status, res }) => {
            if (res !== null && res !== undefined && res.ok === true) {
              props.onToast("已打开数据目录");
              return;
            }
            /* 404 / 未知接口：说明宿主还在跑旧版后端（新接口要重启 dsh 才注册）。
               给出可操作提示，而不是含糊的"失败"。 */
            const missingRoute = status === 404 ||
              (res !== null && res !== undefined && typeof res.error === "string" && res.error.indexOf("未知接口") >= 0);
            if (missingRoute) {
              const hint = "打开目录接口尚未生效，请重启 dsh 后重试";
              if (htmlDir !== "") {
                copyText(htmlDir, "数据目录")
                  .then(() => props.onToast(hint + "；已复制目录路径"))
                  .catch(() => props.onToast(hint));
              } else {
                props.onToast(hint);
              }
              return;
            }
            /* 后端明确报错时把原因显示出来，并回退复制真实路径。 */
            const reason = res && typeof res.error === "string" && res.error !== "" ? res.error : "";
            const target = (res && typeof res.dir === "string" && res.dir !== "") ? res.dir : htmlDir;
            if (target === "") {
              props.onToast(reason !== "" ? reason : "无法打开目录，且未取得目录路径");
              return;
            }
            copyText(target, "数据目录")
              .then(() => props.onToast((reason !== "" ? reason : "自动打开失败") + "；已复制目录路径"))
              .catch(() => props.onToast((reason !== "" ? reason + "；" : "") + "目录路径：" + target));
          })
          .catch((error) => {
            const target = htmlDir;
            if (target !== "") {
              copyText(target, "数据目录")
                .then(() => props.onToast("自动打开失败，已复制目录路径：" + target))
                .catch(() => props.onToast("目录路径：" + target));
            } else {
              props.onToast("打开失败：" + String((error && error.message) || error));
            }
          });
      }

      /* embedded：同上，挂进 dsh 设置页时由设置页提供外壳。 */
      const embedded = props.embedded === true;
      return h("div", {
        className: "dshe-mask" + (embedded ? " dshe-mask-embedded" : ""),
        onClick: embedded ? undefined : (event) => { if (event.target === event.currentTarget) props.onClose(); }
      },
        h("div", {
          className: "dshe-settings dshe-wb-settings" + (embedded ? " dshe-settings-embedded" : ""),
          role: embedded ? "region" : "dialog",
          "aria-modal": embedded ? undefined : "true",
          "aria-label": "工作台设置"
        },
          h("button", {
            type: "button",
            className: "dshe-drawer-close",
            "aria-label": "关闭",
            title: "关闭",
            onClick: props.onClose
          }, h(Icon, { name: "close", size: 18 })),
          h("h2", { className: "dshe-settings-title" }, "工作台设置"),
          loadError !== ""
            ? h("div", { className: "dshe-settings-error" }, loadError)
            : h("div", { className: "dshe-settings-field" },
                /* ① 数据分区 */
                h("div", { className: "dshe-wb-settings-sec" },
                  h("div", { className: "dshe-wb-settings-sec-title" }, "数据"),
                  h("label", { className: "dshe-settings-label", htmlFor: "dshe-settings-wb-dir" }, "工作台数据目录（HTML + CSV，绝对路径）"),
                  h("input", {
                    id: "dshe-settings-wb-dir",
                    className: "dshe-settings-input",
                    type: "text",
                    value: dataDir,
                    placeholder: "留空使用默认目录",
                    disabled: loaded === false || saving === true,
                    spellCheck: false,
                    onChange: (event) => setDataDir(event.target.value)
                  }),
                  h("p", { className: dataDirReady === true ? "dshe-settings-hint" : "dshe-settings-hint-err" },
                    dataDirReady === true
                      ? "已就绪：HTML 页面放此目录根下，CSV 数据表放同目录的 <工作台 id>/ 子目录；不配置也能用（默认 ~/.dsh/dsh-buddy-expert-hub/workbench）"
                      : "数据目录不可读写，请填一个已存在且可写的绝对路径"),
                  h("p", { className: "dshe-settings-hint" }, "改目录时会把旧目录里的 HTML 与 CSV 自动复制到新目录；旧目录会保留，不删除。"),
                  h("label", { className: "dshe-settings-label", htmlFor: "dshe-settings-wb-sync" }, "自动检查间隔（毫秒）"),
                  h("input", {
                    id: "dshe-settings-wb-sync",
                    className: "dshe-settings-input" + (wbSyncError !== "" ? " dshe-settings-input-err" : ""),
                    type: "number", min: 500, max: 60000, step: 500,
                    value: syncMs,
                    disabled: loaded === false || saving === true,
                    onChange: (event) => setSyncMs(event.target.value)
                  }),
                  wbSyncError !== ""
                    ? h("p", { className: "dshe-settings-hint-err", role: "alert" }, wbSyncError)
                    : h("p", { className: "dshe-settings-hint" }, "自动刷新打开时，外部改了 CSV 后页面按这个间隔自动更新（500-60000，默认 2000）；关闭自动刷新后该间隔不生效，需手动点「刷新」"),
                  h("div", { className: "dshe-wb-settings-row" },
                    h("button", { type: "button", className: "dshe-btn", disabled: saving === true, onClick: openHtmlDir }, "打开数据目录")
                  )
                )
              ),
          h("div", { className: "dshe-settings-foot" },
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
          /* 单条目导出：专家 / 专家团 / 技能各自打包成一个 .json.gz。
             导出的包仍可由后端 POST /import/item 导入；当前界面用各 tab
             工具栏的 + 按钮从文件夹导入（POST /import/folder）。 */
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
    // =======================================================================
    // 个人工作台（第 4 大块）：HTML 托管 + CSV 双向同步 + postMessage 桥
    // =======================================================================

    /** 父 <-> iframe 桥 magic，必须与 lib/workbench-bridge.js 的 BRIDGE_MAGIC 一致。 */
    var WB_BRIDGE_MAGIC = "__wb:1";

    /**
     * 把 /workbench/data 的响应收敛成 iframe 侧的统一快照。
     * @param {any} res 后端响应
     * @returns {any} 快照
     */
    function wbSnapshot(res) {
      return {
        ok: true,
        workbench: res.workbench,
        table: res.table,
        columns: Array.isArray(res.columns) ? res.columns : [],
        fields: Array.isArray(res.fields) ? res.fields : [],
        rows: Array.isArray(res.rows) ? res.rows : [],
        hash: String(res.hash || ""),
        mtimeMs: res.mtimeMs === undefined ? null : res.mtimeMs,
        size: Number(res.size) || 0
      };
    }

    /** 左侧文件树宽度的本地记忆键与允许范围（拖拽调整后存本地，重启保持）。 */
    var WB_SIDE_WIDTH_KEY = "dsh-buddy-expert-hub:workbench-side-width";
    var WB_SIDE_WIDTH_MIN = 140;
    var WB_SIDE_WIDTH_MAX = 520;
    var WB_SIDE_WIDTH_DEFAULT = 224;
    /** 侧栏是否收起（资料库 / 个人工作台各存一份）。 */
    var WB_SIDE_COLLAPSED_KEY = "dsh-buddy-expert-hub:workbench-side-collapsed";
    var LIB_SIDE_COLLAPSED_KEY = "dsh-buddy-expert-hub:library-side-collapsed";
    /** 资料库左栏宽度（与个人工作台同一套拖拽交互，默认 262，和原固定宽度一致）。 */
    var LIB_SIDE_WIDTH_KEY = "dsh-buddy-expert-hub:library-side-width";
    var LIB_SIDE_WIDTH_MIN = 180;
    var LIB_SIDE_WIDTH_MAX = 460;
    var LIB_SIDE_WIDTH_DEFAULT = 262;

    /** 读一个布尔偏好（localStorage 不可用时返回 fallback）。 */
    function readBoolPref(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === "1") return true;
        if (raw === "0") return false;
      } catch { /* 无 localStorage */ }
      return fallback;
    }

    /** 写一个偏好；失败只影响本次会话，不抛错。 */
    function writePref(key, value) {
      try { window.localStorage.setItem(key, String(value)); } catch { /* 忽略 */ }
    }

    /** 按允许区间夹一个宽度。 */
    function clampWidth(value, min, max, fallback) {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return Math.min(max, Math.max(min, Math.round(num)));
    }

    /** 读上次拖拽的宽度（通用版）：读不到 / 非法值回落默认。 */
    function readWidthPref(key, min, max, def) {
      try { return clampWidth(window.localStorage.getItem(key), min, max, def); } catch { return def; }
    }

    /** 读上次拖拽的宽度；读不到 / 非法值回落默认。 */
    function readWbSideWidth() {
      try {
        const raw = Number(window.localStorage.getItem(WB_SIDE_WIDTH_KEY));
        if (Number.isFinite(raw)) return Math.min(WB_SIDE_WIDTH_MAX, Math.max(WB_SIDE_WIDTH_MIN, Math.round(raw)));
      } catch { /* 无 localStorage 或宿主禁用：用默认宽度 */ }
      return WB_SIDE_WIDTH_DEFAULT;
    }

    // =======================================================================
    // 工作台 HTML 的宿主外观下发（iframe 是 opaque origin，拿不到宿主 CSS 变量）
    // =======================================================================

    /** 下发给 iframe 的宿主 token 名单：与 docs/ui-appearance.md 的九件套 + 两个状态色一致。 */
    var WB_THEME_TOKENS = [
      "bg-base", "bg-layer-1", "bg-layer-2", "interactive-bg-hover-solid",
      "label-primary", "label-secondary", "border-l1",
      "brand-primary", "state-error-primary", "state-success-primary", "state-warning-primary"
    ];

    /** 判断一个 CSS 颜色是否偏暗（决定告诉页面 dark 还是 light，页面可据此做纯 CSS 分支）。 */
    function wbColorIsDark(value) {
      const text = String(value === null || value === undefined ? "" : value).trim().toLowerCase();
      let r = -1;
      let g = -1;
      let b = -1;
      const rgb = text.match(/^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/);
      if (rgb !== null) {
        r = Number(rgb[1]); g = Number(rgb[2]); b = Number(rgb[3]);
      } else {
        const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
        if (hex !== null) {
          const raw = hex[1];
          const full = raw.length === 3
            ? raw.charAt(0) + raw.charAt(0) + raw.charAt(1) + raw.charAt(1) + raw.charAt(2) + raw.charAt(2)
            : raw;
          r = parseInt(full.slice(0, 2), 16);
          g = parseInt(full.slice(2, 4), 16);
          b = parseInt(full.slice(4, 6), 16);
        }
      }
      if (r < 0 || Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false;
      return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
    }

    /** 取宿主根节点的 alias token 快照；一个都拿不到时返回空 tokens（iframe 用自己的回退值）。 */
    function readWbThemeSnapshot() {
      const snapshot = { scheme: "light", tokens: {} };
      try {
        const cs = window.getComputedStyle(document.documentElement);
        WB_THEME_TOKENS.forEach((name) => {
          const value = String(cs.getPropertyValue("--dsw-alias-" + name) || "").trim();
          if (value !== "") snapshot.tokens[name] = value;
        });
      } catch { /* 非 DOM 环境：不下发，页面回退 */ }
      const base = snapshot.tokens["bg-base"];
      if (typeof base === "string" && base !== "") {
        snapshot.scheme = wbColorIsDark(base) ? "dark" : "light";
      }
      return snapshot;
    }

    /**
     * 个人工作台视图。
     *
     * 安全模型：iframe 只有 sandbox="allow-scripts"，不给 allow-same-origin，
     * 是 opaque origin，无法自己 fetch 插件接口；所有读写都由这里的父组件代理，
     * 并校验 event.source / magic / kind 白名单（只代理 ready / read / write）。
     * 外部改 CSV 后按 syncIntervalMs 轮询 hash，变了才 push，不打断输入。
     *
     * @param {{ onToast: Function }} props 组件属性（设置弹窗由本组件自己持有，不走父级回调）
     * @returns {any} React 元素
     */
    function WorkbenchView(props) {
      const [list, setList] = useState(null);
      const [listError, setListError] = useState("");
      const [activeId, setActiveId] = useState("");
      const [conflict, setConflict] = useState(null);
      const [syncMs, setSyncMs] = useState(2000);
      /* 自动刷新开关（存后端设置）：打开后按 syncMs 轮询数据文件变化，关闭后只能手动刷新。 */
      const [autoSync, setAutoSync] = useState(true);
      const [frameKey, setFrameKey] = useState(0);
      const [listNonce, setListNonce] = useState(0);
      /* 左侧文件树：按工作台 id 记录「数据表列表是否收起」，默认全部展开。 */
      const [collapsed, setCollapsed] = useState({});
      /* 侧栏是否收起（本地记忆）：收起后只留窄条，右侧 iframe 自动占满。 */
      const [sideCollapsed, setSideCollapsed] = useState(() => readBoolPref(WB_SIDE_COLLAPSED_KEY, false));
      /* 目录树：按目录 id 记录「是否收起」，默认全部展开。 */
      const [folderCollapsed, setFolderCollapsed] = useState({});
      /* 拖拽悬停的目录 id（高亮，表示可以放进来） */
      const [folderDropId, setFolderDropId] = useState(0);
      /* 右键「移动到目录」菜单：{ x, y, id, spaceId } | null */
      const [moveMenu, setMoveMenu] = useState(null);
      /* 左侧文件树的展示顺序（工作台 id 数组，存后端设置）与拖拽状态。 */
      const [order, setOrder] = useState([]);
      const [dragOverId, setDragOverId] = useState("");
      /* 左侧栏宽度：可拖拽调整，存 localStorage。 */
      const [sideWidth, setSideWidth] = useState(readWbSideWidth);
      const dragIdRef = useRef("");
      const iframeRef = useRef(null);
      const dataRef = useRef(null);
      const activeRef = useRef({ id: "", table: "" });
      /* 上一次推给 iframe 的外观指纹：主题没变就不重复 postMessage。 */
      const themeRef = useRef("");
      /* 来源与 contentWindow 不一致的消息数：只用于诊断，不再拦截。 */
      const bridgeSourceMismatchRef = useRef(0);
      /* 桥的收发计数：每秒随 ping 下发给 iframe，用来判断是哪个方向断了。 */
      const bridgeRecvRef = useRef(0);
      const bridgeReplyRef = useRef(0);
      const bridgeSendFailRef = useRef(0);
      /* 工具条上的通道状态（每秒同步一次，值不变就不触发重渲染） */
      const [bridgeHealth, setBridgeHealth] = useState({ recv: 0, replied: 0, fail: 0 });
      /* HTML 直链弹窗：与资料库共用 DirectLinkDialog */
      const [directOpen, setDirectOpen] = useState(false);
      const requestSnapshot = () => snapshotRequest(frameWindow);
      /* 外部数据定时更新：inbox 待处理数 / 待补推数 / 最近记录，工具栏上给个入口 */
      const [ingestInfo, setIngestInfo] = useState(null);
      const [ingestOpen, setIngestOpen] = useState(false);
      /* 直接查看/编辑 CSV：非 null 时右侧从 iframe 切换为可编辑网格。
         值形如 { workbench, file }；点左侧任意 CSV 叶子进入，点工作台 HTML 节点退出。 */
      const [editTable, setEditTable] = useState(null);
      const [grid, setGrid] = useState(null);
      const [gridLoading, setGridLoading] = useState(false);
      const [gridSaving, setGridSaving] = useState(false);
      const [gridError, setGridError] = useState("");
      const [gridDirty, setGridDirty] = useState(false);

      /** 拉一次摄入状态（15 秒一次；取不到就当没有，不影响工作台本身）。 */
      function refreshIngest() {
        fetchJson("/workbench/ingest/status")
          .then((res) => { if (res !== null && res !== undefined && res.ok === true) setIngestInfo(res); })
          .catch(() => { /* 状态不可用：入口按「同步」常态显示 */ });
      }

      useEffect(() => {
        refreshIngest();
        const timer = setInterval(refreshIngest, 15000);
        return () => clearInterval(timer);
      }, []);

      /* 每次挂载 / 点「刷新」都重新扫盘：agent 落盘新 HTML 后无需重启宿主。 */
      useEffect(() => {
        let cancelled = false;
        fetchJson("/workbench/list")
          .then((res) => {
            if (cancelled) return;
            if (res !== null && res !== undefined && res.ok === true) {
              setList(res);
              setListError("");
              const rawMs = Number(res.syncIntervalMs);
              setSyncMs(Number.isFinite(rawMs) && rawMs >= 500 && rawMs <= 60000 ? rawMs : 2000);
              const items = Array.isArray(res.workbenches) ? res.workbenches : [];
              setActiveId((prev) => prev !== "" && items.some((item) => item.id === prev)
                ? prev
                : (items.length > 0 ? items[0].id : ""));
            } else {
              setListError((res && (res.error || res.message)) || "无法读取工作台列表");
            }
          })
          .catch((error) => {
            if (!cancelled) setListError(String((error && error.message) || error));
          });
        return () => { cancelled = true; };
      }, [listNonce]);

      /* 读一次设置里的展示顺序与自动刷新开关（失败静默，按默认展示）。 */
      useEffect(() => {
        let cancelled = false;
        fetchJson("/workbench/settings")
          .then((res) => {
            if (cancelled || res === null || res === undefined || res.ok !== true) return;
            if (Array.isArray(res.order)) setOrder(res.order.filter((id) => typeof id === "string"));
            setAutoSync(res.autoSync !== false);
          })
          .catch(() => { /* 设置不可用时按默认顺序 */ });
        return () => { cancelled = true; };
      }, []);

      const workbenches = list !== null && Array.isArray(list.workbenches) ? list.workbenches : [];
      /* 在线目录树：list.folders 是所有 FOLDER 节点，工作台用 parentId 挂到目录下。
         本地模式的 list 没有这两个字段，继续走原来的扁平文件树。 */
      const folders = list !== null && Array.isArray(list.folders) ? list.folders : [];
      const treeMode = list !== null && String(list.source || "") === "online";
      /* 展示顺序：设置里的顺序优先，未登记过的新工作台按扫盘顺序追加在后面。 */
      const orderedWorkbenches = (() => {
        if (order.length === 0) return workbenches;
        const rank = {};
        order.forEach((id, index) => { rank[id] = index; });
        return workbenches.slice().sort((a, b) => {
          const ra = rank[a.id];
          const rb = rank[b.id];
          return (ra === undefined ? order.length : ra) - (rb === undefined ? order.length : rb);
        });
      })();
      const active = orderedWorkbenches.find((item) => item.id === activeId) || null;
      /* 只有在线工作台（catalog 里带 HTML 节点 id）才有直链可分享；
         必须放在 active 定义之后，提前引用会触发 const 的 TDZ。 */
      const directNodeId = active === null ? 0 : Number(active.nodeId || 0);
      const tables = active !== null && Array.isArray(active.tables) ? active.tables : [];
      const tableFile = tables.length > 0 ? String(tables[0].file || "") : "";
      activeRef.current = { id: activeId, table: tableFile };

      /**
       * 读一张表。传 probeHash 且后端判定未变化时返回 null（轻量轮询，不解析 CSV）。
       * @param {string} probeHash 上次拿到的 hash
       * @returns {Promise<any|null>} 快照或 null
       */
      function loadData(probeHash, tableOverride) {
        const sel = activeRef.current;
        if (sel.id === "" || sel.table === "") {
          /* 以前这里是 resolve(null)，父桥会回一个「成功但没有数据」的空快照，
             iframe 拿到后既不渲染也不报错，界面就卡在「加载中」。改成明确报错。 */
          return Promise.reject(new Error("工作台还没准备好：缺少选中工作台或数据表"));
        }
        const tableName = typeof tableOverride === "string" && tableOverride !== "" ? tableOverride : sel.table;
        let url = "/workbench/data?workbench=" + encodeURIComponent(sel.id) +
          "&table=" + encodeURIComponent(tableName);
        if (typeof probeHash === "string" && probeHash !== "") url += "&hash=" + encodeURIComponent(probeHash);
        return fetchJson(url).then((res) => {
          if (res === null || res === undefined || res.ok !== true) {
            const text = String((res && (res.error || res.message)) || "读取数据表失败");
            if (typeof probeHash !== "string" || probeHash === "") props.onToast("工作台数据加载失败：" + text);
            throw new Error(text);
          }
          if (res.changed === false && res.rows === undefined) return null;
          const next = wbSnapshot(res);
          /* 指定表是 iframe 自己要看的 CSV，不算父组件当前选中表，别污染轮询 hash。 */
          if (typeof tableOverride !== "string" || tableOverride === "") dataRef.current = next;
          return next;
        });
      }

      /**
       * 取 iframe 的 window。ref 没挂上时退回按类名查（曾经出现过 ref 还没绑定、
       * 消息发不出去却静默丢弃，页面就一直「加载中」）。
       * @returns {any} iframe 的 contentWindow，取不到为 null
       */
      function frameWindow() {
        let frame = iframeRef.current;
        if (frame === null || frame === undefined) {
          try { frame = document.querySelector(".dshe-wb-frame"); } catch { frame = null; }
        }
        if (frame === null || frame === undefined) return null;
        const win = frame.contentWindow;
        return win === null || win === undefined ? null : win;
      }

      /** 向 iframe 回 response / push / conflict；opaque origin 只能用 '*'。 */
      function postToFrame(kind, payload, requestId, ok) {
        const win = frameWindow();
        if (win === null) {
          /* 发不出去要计数：这是「页面永远加载中」的典型成因之一 */
          if (kind === "response") bridgeSendFailRef.current += 1;
          return;
        }
        const message = { magic: WB_BRIDGE_MAGIC, kind: kind, payload: payload };
        if (requestId !== undefined) { message.requestId = requestId; message.ok = ok === true; }
        if (kind === "response") bridgeReplyRef.current += 1;
        try { win.postMessage(message, "*"); } catch { /* iframe 正在卸载时静默放弃 */ }
      }

      function pushData(reason, snapshot) {
        postToFrame("push", {
          reason: reason,
          workbench: snapshot.workbench,
          table: snapshot.table,
          columns: snapshot.columns,
          fields: snapshot.fields,
          rows: snapshot.rows,
          hash: snapshot.hash
        });
      }

      /**
       * 把宿主外观下发给 iframe：首个 ready 强制发，之后只在指纹变化时发。
       * @param {boolean} force 是否跳过指纹比对
       * @returns {void}
       */
      function pushAppearance(force) {
        const snapshot = readWbThemeSnapshot();
        const fingerprint = JSON.stringify(snapshot);
        if (force !== true && fingerprint === themeRef.current) return;
        themeRef.current = fingerprint;
        postToFrame("theme", snapshot);
      }

      /* 宿主切深浅色 / 换主色 → 1s 内同步进 iframe；换工作台（frameKey）也重发一次。 */
      useEffect(() => {
        pushAppearance(true);
        /* 每秒顺带发一条 ping：iframe 侧据此判断「父窗口还活着」，
           并拿到父窗口自己统计的收到了几条 / 回了几个，一眼看出哪个方向断了。 */
        const timer = setInterval(() => {
          pushAppearance(false);
          postToFrame("ping", {
            recv: bridgeRecvRef.current,
            replied: bridgeReplyRef.current,
            at: Date.now()
          });
          const next = {
            recv: bridgeRecvRef.current,
            replied: bridgeReplyRef.current,
            fail: bridgeSendFailRef.current
          };
          setBridgeHealth((prev) => (prev.recv === next.recv && prev.replied === next.replied && prev.fail === next.fail
            ? prev : next));
        }, 1000);
        return () => clearInterval(timer);
      }, [frameKey]);

      /** 写回：只代理 POST /workbench/data，绝不接受 iframe 自定义 URL。 */
      function writeData(payload) {
        const sel = activeRef.current;
        const current = dataRef.current;
        const body = {
          workbench: sel.id,
          table: typeof payload.table === "string" && payload.table !== "" ? payload.table : sel.table,
          baseHash: typeof payload.baseHash === "string" ? payload.baseHash : (current !== null ? current.hash : ""),
          columns: Array.isArray(payload.columns) ? payload.columns : (current !== null ? current.columns : []),
          rows: Array.isArray(payload.rows) ? payload.rows : []
        };
        return fetch(API + "/workbench/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }).then((resp) => resp.json());
      }

      /**
       * 打开左侧某张 CSV 到右侧网格：读一次数据（走 POST/GET 同一套 /workbench/data）。
       * @param {string} workbenchId 工作台 id
       * @param {string} file CSV 文件名
       * @returns {void}
       */
      function openGrid(workbenchId, file) {
        if (workbenchId === "" || file === "") return;
        /* 点的是别的数据表所属工作台：同步切过去，"返回页面"才不会开错工作台。 */
        if (workbenchId !== activeId) {
          dataRef.current = null;
          setConflict(null);
          setActiveId(workbenchId);
          setFrameKey((value) => value + 1);
        }
        setEditTable({ workbench: workbenchId, file: file });
        setGrid(null);
        setGridError("");
        setGridDirty(false);
        setGridLoading(true);
        fetchJson("/workbench/data?workbench=" + encodeURIComponent(workbenchId) + "&table=" + encodeURIComponent(file))
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) {
              setGridError(String((res && (res.error || res.message)) || "读取数据表失败"));
              return;
            }
            setGrid(wbSnapshot(res));
          })
          .catch((error) => setGridError(String((error && error.message) || error)))
          .finally(() => setGridLoading(false));
      }

      /** 关闭网格，回到 HTML 页面视图。 */
      function closeGrid() {
        setEditTable(null);
        setGrid(null);
        setGridError("");
        setGridDirty(false);
      }

      /**
       * 改一个数据单元格。rows 是「对象数组」（{列名: 值}，见 csv.js 的 parseCsv），
       * 所以按列名赋值，不按列序号。只改本地 state，点「保存」才写回。
       * @param {number} rowIndex 数据行下标（0 = 第一条数据）
       * @param {string} key 列名
       * @param {string} value 新值
       * @returns {void}
       */
      function setGridCell(rowIndex, key, value) {
        setGrid((prev) => {
          if (prev === null || key === '_id') return prev;
          const rows = prev.rows.map((r) => (r !== null && typeof r === 'object' ? Object.assign({}, r) : {}));
          while (rows.length <= rowIndex) rows.push({});
          rows[rowIndex][key] = value;
          return Object.assign({}, prev, { rows: rows });
        });
        setGridDirty(true);
      }

      /** 保存当前网格：POST /workbench/data，带 baseHash 做 CAS。 */
      function saveGrid() {
        if (editTable === null || grid === null || gridSaving === true) return;
        setGridSaving(true);
        setGridError("");
        fetch(API + "/workbench/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workbench: editTable.workbench,
            table: editTable.file,
            baseHash: grid.hash,
            columns: grid.columns,
            rows: grid.rows,
          }),
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setGrid((prev) => (prev === null ? prev : Object.assign({}, prev, {
                hash: String(res.hash || prev.hash),
                columns: Array.isArray(res.columns) ? res.columns : prev.columns,
                rows: Array.isArray(res.rows) ? res.rows : prev.rows,
              })));
              setGridDirty(false);
              props.onToast("已保存 " + editTable.file);
              return;
            }
            if (res !== null && res !== undefined && res.code === "conflict") {
              const current = res.current !== null && typeof res.current === "object" ? res.current : null;
              setGridError("文件已被外部修改，未保存。" + (current !== null
                ? "当前版本 hash=" + String(current.hash || "").slice(0, 8) + "，点「重新加载」取最新内容。"
                : "点「重新加载」取最新内容。"));
              return;
            }
            setGridError(String((res && (res.error || res.message)) || "保存失败"));
          })
          .catch((error) => setGridError("保存失败：" + String((error && error.message) || error)))
          .finally(() => setGridSaving(false));
      }

      /* 父桥：只接受来自当前 iframe 的 ready / read / write 三类请求。 */
      useEffect(() => {
        function onMessage(event) {
          const data = event === null || event === undefined ? null : event.data;
          if (data === null || data === undefined) return;
          if (handleSnapshotResult(data) === true) return;
          if (data.magic !== WB_BRIDGE_MAGIC) return;
          if (data.kind !== "ready" && data.kind !== "read" && data.kind !== "write") return;
          bridgeRecvRef.current += 1;
          const frame = iframeRef.current;
          const win = frame === null || frame === undefined ? null : frame.contentWindow;
          /* 来源不匹配时**只记录不拦截**：
             magic（__wb:1）+ kind 白名单 + requestId 必须命中 pending，已经足够识别伪造；
             Electron 的 sandbox / webview 组合下 event.source 经常拿不到或不是 contentWindow，
             一旦严格 return，iframe 发来的真实请求会被全部丢掉 —— 表现就是页面永远「加载中」。 */
          if (win !== null && win !== undefined && event.source !== win) {
            bridgeSourceMismatchRef.current += 1;
          }
          const requestId = data.requestId === undefined || data.requestId === null
            ? "" : String(data.requestId);
          const payload = data.payload !== null && typeof data.payload === "object" ? data.payload : {};
          /* 在线工作台 HTML 用 window.KB 适配器，会带 table 指定它挂载的 CSV 子节点。 */
          const tableOverride = typeof payload.table === "string" && payload.table !== "" ? payload.table : "";
          if (data.kind === "write") {
            writeData(payload)
              .then((res) => {
                if (res !== null && res !== undefined && res.ok === true) {
                  const previous = dataRef.current;
                  const next = {
                    ok: true,
                    workbench: activeRef.current.id,
                    table: activeRef.current.table,
                    columns: Array.isArray(res.columns) ? res.columns : (previous !== null ? previous.columns : []),
                    fields: previous !== null ? previous.fields : [],
                    rows: Array.isArray(res.rows) ? res.rows : (previous !== null ? previous.rows : []),
                    hash: String(res.hash || ""),
                    changed: false
                  };
                  dataRef.current = next;
                  postToFrame("response", { hash: next.hash, columns: next.columns, rows: next.rows }, requestId, true);
                  setConflict(null);
                  props.onToast("已保存");
                  return;
                }
                if (res !== null && res !== undefined && res.code === "conflict") {
                  const current = res.current !== null && typeof res.current === "object" ? res.current : {};
                  const previous = dataRef.current;
                  const next = {
                    ok: true,
                    workbench: activeRef.current.id,
                    table: activeRef.current.table,
                    columns: Array.isArray(current.columns) ? current.columns : (previous !== null ? previous.columns : []),
                    fields: previous !== null ? previous.fields : [],
                    rows: Array.isArray(current.rows) ? current.rows : [],
                    hash: String(current.hash || ""),
                    changed: true
                  };
                  dataRef.current = next;
                  const errorText = String(res.error || "数据表已在外部被修改，已重新加载，请确认后重试");
                  postToFrame("response", { error: errorText, code: "conflict", current: current }, requestId, false);
                  postToFrame("conflict", { error: errorText, current: current });
                  pushData("external-change", next);
                  setConflict(errorText);
                  return;
                }
                postToFrame("response", { error: (res && (res.error || res.message)) || "保存失败" }, requestId, false);
              })
              .catch((error) => {
                postToFrame("response", { error: String((error && error.message) || error) }, requestId, false);
              });
            return;
          }
          /* ready / read 都读一次全量；ready 另外补一条 push，让 onData 拿到首屏数据。 */
          loadData("", tableOverride)
            .then((snapshot) => {
              const answer = snapshot === null ? { ok: true } : snapshot;
              /* 先下发外观再回 ready：页面拿到 ready 时 :root 已带宿主 token，不会闪浅色。 */
              if (data.kind === "ready") pushAppearance(true);
              postToFrame("response", answer, requestId, true);
              if (data.kind === "ready" && snapshot !== null) pushData("init", snapshot);
            })
            .catch((error) => {
              postToFrame("response", { error: String((error && error.message) || error) }, requestId, false);
            });
        }
        try { window.addEventListener("message", onMessage); } catch { /* 非 DOM 环境降级 */ }
        return () => {
          try { window.removeEventListener("message", onMessage); } catch { /* 同上 */ }
        };
      }, [activeId, tableFile, frameKey]);

      /* 自动刷新打开时：外部改 CSV → 不超过 syncIntervalMs 自动更新。带 hash 轮询，未变化零解析。 */
      useEffect(() => {
        if (autoSync !== true) return undefined;
        if (activeId === "" || tableFile === "") return undefined;
        let cancelled = false;
        /* 上一轮还没回来就跳过这一轮：远端慢的时候轮询会不断叠加，
           请求越排越长，iframe 那边就一路超时。 */
        let inFlight = false;
        const tick = () => {
          if (inFlight === true) return;
          const current = dataRef.current;
          inFlight = true;
          loadData(current !== null ? current.hash : "")
            .then((snapshot) => {
              inFlight = false;
              if (cancelled || snapshot === null) return;
              pushData("external-change", snapshot);
            })
            .catch(() => { inFlight = false; /* 单次轮询失败保留现状，下个周期再试 */ });
        };
        const timer = setInterval(tick, syncMs);
        return () => { cancelled = true; clearInterval(timer); };
      }, [activeId, tableFile, syncMs, frameKey, autoSync]);

      /** 刷新：重扫数据目录 + 重载当前页面（页面 ready 时会重新拉一次数据）。 */
      function refreshNow() {
        setListNonce((value) => value + 1);
        setFrameKey((value) => value + 1);
        props.onToast("已刷新工作台与数据");
      }

      /** 切换自动刷新：先本地生效，再写后端设置；失败回滚并提示。 */
      function toggleAutoSync() {
        const next = autoSync !== true;
        setAutoSync(next);
        fetch(API + "/workbench/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autoSync: next })
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              props.onToast(next
                ? "自动刷新已打开：后台按间隔检测数据文件变化"
                : "自动刷新已关闭：需要手动点「刷新」");
              return;
            }
            setAutoSync(!next);
            props.onToast("自动刷新设置保存失败");
          })
          .catch(() => {
            setAutoSync(!next);
            props.onToast("自动刷新设置保存失败");
          });
      }

      /** 宽度夹到允许区间。 */
      function clampSideWidth(value) {
        return Math.min(WB_SIDE_WIDTH_MAX, Math.max(WB_SIDE_WIDTH_MIN, Math.round(value)));
      }

      /** 记住宽度（localStorage 不可用时只影响本次会话）。 */
      function persistSideWidth(value) {
        try { window.localStorage.setItem(WB_SIDE_WIDTH_KEY, String(value)); } catch { /* 忽略 */ }
      }

      /** 拖拽分隔条：按下后跟随鼠标改宽度，松手落盘。 */
      function startResize(event) {
        if (typeof event.button === "number" && event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = sideWidth;
        let latest = startWidth;
        const onMove = (moveEvent) => {
          latest = clampSideWidth(startWidth + (moveEvent.clientX - startX));
          setSideWidth(latest);
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          persistSideWidth(latest);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }

      /** 键盘调整宽度：← → 小步、Shift+← → 大步。 */
      function onResizeKey(event) {
        const step = event.shiftKey === true ? 32 : 8;
        let next = null;
        if (event.key === "ArrowLeft") next = clampSideWidth(sideWidth - step);
        else if (event.key === "ArrowRight") next = clampSideWidth(sideWidth + step);
        if (next === null) return;
        event.preventDefault();
        setSideWidth(next);
        persistSideWidth(next);
      }

      /** 双击分隔条恢复默认宽度。 */
      function resetSideWidth() {
        setSideWidth(WB_SIDE_WIDTH_DEFAULT);
        persistSideWidth(WB_SIDE_WIDTH_DEFAULT);
      }

      /** 保存顺序：先本地生效（不等网络），再 POST 到设置；失败只提示不打断。 */
      function persistOrder(nextIds) {
        setOrder(nextIds);
        fetch(API + "/workbench/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: nextIds })
        })
          .then((resp) => resp.json())
          .catch(() => props.onToast("顺序未能保存，下次打开可能恢复原顺序"));
      }

      /** 把 fromId 拖到 toId 的位置（数组重排后持久化）。 */
      function moveWorkbench(fromId, toId) {
        if (fromId === "" || toId === "" || fromId === toId) return;
        const ids = orderedWorkbenches.map((item) => item.id);
        const from = ids.indexOf(fromId);
        const to = ids.indexOf(toId);
        if (from < 0 || to < 0) return;
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        persistOrder(ids);
      }

      /** 键盘排序：Alt+↑/↓ 把一个工作台上移 / 下移一位。 */
      function moveWorkbenchBy(id, delta) {
        const ids = orderedWorkbenches.map((item) => item.id);
        const index = ids.indexOf(id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= ids.length) return;
        ids.splice(target, 0, ids.splice(index, 1)[0]);
        persistOrder(ids);
      }

      /** 切换工作台：清掉旧快照，避免把 A 的 hash 带给 B；同时展开它的数据表。 */
      function selectWorkbench(nextId) {
        /* 点工作台 HTML 节点 = 回到页面视图，退出 CSV 网格。 */
        closeGrid();
        if (nextId !== activeId) {
          dataRef.current = null;
          setConflict(null);
          setActiveId(nextId);
          setFrameKey((value) => value + 1);
        }
        setCollapsed((prev) => Object.assign({}, prev, { [nextId]: false }));
      }

      /** 收起 / 展开左侧某个工作台的 CSV 数据表列表。 */
      function toggleCollapsed(id) {
        setCollapsed((prev) => Object.assign({}, prev, { [id]: prev[id] !== true }));
      }

      const dataReady = list !== null && list.dataDirReady === true;
      const htmlDir = list !== null ? String(list.htmlDir || "") : "";
      const errors = list !== null && Array.isArray(list.errors) ? list.errors : [];
      /* 页面内的菜单 / 配色 / 排版全部由 HTML 自己负责，插件只负责把整页铺满。 */
      const frameSrc = active !== null
        ? API + "/workbench/html?workbench=" + encodeURIComponent(active.id) + "&t=" + String(frameKey)
        : "";

      /**
       * 顶部固定工具条：刷新 / 自动刷新开关 / 设置（齿轮）。
       *
       * 只放插件自己的操作，与工作台页面内容完全无关；工作台里的菜单、按钮、配色
       * 全部由 HTML 自己渲染，插件一个按钮都不代画。
       * @returns {any[]} 按钮数组
       */
      function renderToolbar() {
        return [
          directNodeId > 0
            ? h("button", {
                key: "direct",
                type: "button",
                className: "dshe-btn",
                title: "HTML 直链：实时页面 / 当前页分享（静态快照）",
                onClick: () => setDirectOpen(true)
              }, "直链")
            : null,
          h("button", {
            key: "refresh",
            type: "button",
            id: "dshe-wb-refresh-btn",
            className: "dshe-btn",
            title: "重扫数据目录并重新读取当前数据表；dsh 生成新工作台后点这里即可",
            onClick: refreshNow
          }, "刷新"),
          (() => {
            const inbox = Number((ingestInfo || {}).inboxCount || 0);
            const pending = Number((ingestInfo || {}).pendingCount || 0);
            const failed = Number((ingestInfo || {}).failedCount || 0);
            const backlog = inbox + pending;
            const label = backlog > 0
              ? "同步 " + String(backlog) + (failed > 0 ? " · 失败 " + String(failed) : "")
              : "同步";
            return h("button", {
              key: "ingest",
              type: "button",
              id: "dshe-wb-ingest-btn",
              className: "dshe-btn" + (failed > 0 ? " dshe-btn-danger" : (backlog > 0 ? " dshe-ingest-alert" : "")),
              title: "外部数据定时更新：待处理批次 " + String(inbox) + " 个，待补推 " +
                String(pending) + " 张表，失败 " + String(failed) + " 个",
              onClick: () => setIngestOpen(true)
            }, label);
          })(),
          h("span", {
            key: "autosync",
            className: "dshe-wb-autosync",
            title: autoSync
              ? "自动刷新已打开：后台按同步间隔检测数据文件变化并刷新"
              : "自动刷新已关闭：数据文件变化不会自动同步"
          },
            h("span", { className: "dshe-wb-autosync-label" }, "自动刷新"),
            h("button", {
              type: "button",
              id: "dshe-wb-autosync",
              className: "dshe-switch" + (autoSync ? " dshe-switch-on" : ""),
              role: "switch",
              "aria-checked": autoSync ? "true" : "false",
              "aria-label": "自动刷新",
              onClick: toggleAutoSync
            }, h("span", { className: "dshe-switch-dot" }))
          ),
          /* 通道诊断：正常情况下是一行灰色小字；发不出去时变红，直接指出「iframe 不可达」 */
          bridgeHealth.recv > 0 || bridgeHealth.fail > 0
            ? h("span", {
                key: "bridge",
                className: "dshe-wb-bridge" + (bridgeHealth.fail > 0 ? " dshe-wb-bridge-bad" : ""),
                title: "iframe 消息通道：收到 iframe 请求 " + String(bridgeHealth.recv) +
                  " 条，回信 " + String(bridgeHealth.replied) + " 条，发送失败 " +
                  String(bridgeHealth.fail) + " 条"
              }, bridgeHealth.fail > 0
                ? "桥 收" + String(bridgeHealth.recv) + " 发失败" + String(bridgeHealth.fail)
                : "桥 " + String(bridgeHealth.recv) + "/" + String(bridgeHealth.replied))
            : null,
        ];
      }

      /**
       * 左侧文件树：每个工作台一个文件节点，下面挂它的 CSV 数据表。
       *
       * 参考文件浏览器的层级：`读书记录.html` + `books.csv`。点文件节点即切换工作台，
       * 右侧整页 iframe 换成那个页面；工作台内部菜单在 HTML 里，不在这一层。
       * @returns {any} React 元素
       */
      /** 目录树 / 扁平树的展开状态切换。 */
      function toggleFolder(id) {
        setFolderCollapsed((prev) => Object.assign({}, prev, { [id]: prev[id] !== true }));
      }

      /** 侧栏收起 / 展开（记本地）。 */
      function toggleSide() {
        const next = !sideCollapsed;
        setSideCollapsed(next);
        writePref(WB_SIDE_COLLAPSED_KEY, next ? "1" : "0");
      }

      /** 把一个工作台拖进目录：PUT /khub/node 改 parentId，成功后刷新列表。 */
      function moveToFolder(fromId, folderId) {
        const item = orderedWorkbenches.find((it) => it.id === fromId);
        if (item === undefined) return;
        const nodeId = Number(item.nodeId || 0);
        if (nodeId <= 0) { props.onToast("本地工作台不支持移动到目录"); return; }
        if (Number(item.parentId || 0) === Number(folderId)) return;
        fetch(API + "/khub/node", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: nodeId, parentId: Number(folderId) })
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              props.onToast("已移动到目录");
              setListNonce((n) => n + 1);
            } else {
              props.onToast((res && (res.error || res.message)) || "移动失败");
            }
          })
          .catch((error) => props.onToast(String((error && error.message) || error)));
      }

      /** 单个工作台节点（目录树与扁平树共用）：缩进由 depth 控制。 */
      function renderWorkbenchNode(item, depth) {
        const isActive = item.id === activeId;
        const open = collapsed[item.id] !== true;
        const itemTables = Array.isArray(item.tables) ? item.tables : [];
        return h("div", {
          key: item.id,
          className: "dshe-wb-group" + (dragOverId === item.id ? " dshe-wb-group-drop" : ""),
          style: depth > 0 ? { paddingLeft: String(depth * 12) + "px" } : undefined,
          /* 拖动排序：整个文件节点可作为拖拽源，落到另一个节点上即换位。 */
          draggable: true,
          onDragStart: (event) => {
            dragIdRef.current = item.id;
            try {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", item.id);
            } catch { /* 非真实 DnD 环境 */ }
          },
          onDragOver: (event) => {
            if (dragIdRef.current === "" || dragIdRef.current === item.id) return;
            event.preventDefault();
            try { event.dataTransfer.dropEffect = "move"; } catch { /* 同上 */ }
            setDragOverId(item.id);
          },
          onDragLeave: () => setDragOverId((prev) => (prev === item.id ? "" : prev)),
          onDrop: (event) => {
            event.preventDefault();
            const fromId = dragIdRef.current;
            dragIdRef.current = "";
            setDragOverId("");
            moveWorkbench(fromId, item.id);
          },
          onDragEnd: () => { dragIdRef.current = ""; setDragOverId(""); },
          /* 右键：弹出「移动到目录」，不依赖拖拽也能换目录 */
          onContextMenu: (event) => {
            if (event && event.preventDefault) event.preventDefault();
            if (treeMode !== true) return;
            setMoveMenu({
              x: Number(event && event.clientX ? event.clientX : 120),
              y: Number(event && event.clientY ? event.clientY : 120),
              id: item.id,
              spaceId: Number(item.spaceId || 0)
            });
          }
        },
          h("div", { className: "dshe-wb-node-row" },
            itemTables.length > 0
              ? h("button", {
                  type: "button",
                  className: "dshe-wb-caret",
                  title: open ? "收起点数据表" : "展开数据表",
                  "aria-label": open ? "收起数据表" : "展开数据表",
                  "aria-expanded": open,
                  onClick: () => toggleCollapsed(item.id)
                }, h(Icon, { name: open ? "chevron-down" : "chevron-up", size: 13 }))
              : h("span", { className: "dshe-wb-caret dshe-wb-caret-empty" }),
            h("button", {
              type: "button",
              className: "dshe-wb-node" + (isActive ? " dshe-wb-node-on" : ""),
              title: String(item.name || item.id) + "（拖动可调整顺序 / 拖到目录里，Alt+↑/↓ 也可移动）",
              "aria-current": isActive ? "true" : undefined,
              onClick: () => selectWorkbench(item.id),
              onKeyDown: (event) => {
                if (event.altKey !== true) return;
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveWorkbenchBy(item.id, -1);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveWorkbenchBy(item.id, 1);
                }
              }
            },
              h(Icon, { name: "file", size: 14 }),
              h("span", { className: "dshe-wb-node-name" }, String(item.name || item.id))
            )
          ),
          open && itemTables.length > 0
            ? h("div", { className: "dshe-wb-leaves" },
                itemTables.map((table) => {
                  const tFile = String(table.file || "");
                  const on = editTable !== null && editTable.workbench === item.id && editTable.file === tFile;
                  return h("button", {
                    key: tFile,
                    type: "button",
                    className: "dshe-wb-leaf dshe-wb-leaf-btn" + (on ? " dshe-wb-leaf-on" : ""),
                    title: String(table.name || tFile) + "（点击查看 / 编辑）",
                    "aria-pressed": on ? "true" : "false",
                    onClick: () => openGrid(item.id, tFile)
                  },
                    h(Icon, { name: "list", size: 13 }),
                    h("span", { className: "dshe-wb-leaf-name" }, String(table.name || tFile))
                  );
                }))
            : null
        );
      }

      /**
       * 目录树（在线模式）：空间 → 目录（可多层）→ 工作台。
       * 目录行可折叠，也可以把工作台直接拖进去（PUT parentId）。
       */
      function renderFolderTree() {
        const spaceList = list !== null && Array.isArray(list.spaces) ? list.spaces : [];
        if (orderedWorkbenches.length === 0 && folders.length === 0) {
          return h("div", { className: "dshe-wb-meta" }, "暂无工作台");
        }
        const spaceIds = [];
        const addSpace = (id, name) => {
          const num = Number(id || 0);
          if (num <= 0) return;
          let hit = spaceIds.find((it) => it.id === num);
          if (hit === undefined) { hit = { id: num, name: String(name || "") }; spaceIds.push(hit); }
          else if (hit.name === "" && String(name || "") !== "") hit.name = String(name || "");
        };
        spaceList.forEach((s) => addSpace(s.id, s.name));
        orderedWorkbenches.forEach((it) => addSpace(it.spaceId, it.spaceName));
        folders.forEach((f) => addSpace(f.spaceId, ""));

        const folderIds = new Set(folders.map((f) => Number(f.id)));
        /* 父节点不是文件夹（或父不在本空间目录表里）的项按根级渲染，
           否则那棵子树会从树上消失。 */
        const kidsOf = (spaceId, parentId) => {
          const atRoot = parentId === 0;
          return {
            fs: folders.filter((f) => Number(f.spaceId) === spaceId && (atRoot
              ? (Number(f.parentId) === 0 || folderIds.has(Number(f.parentId)) === false)
              : Number(f.parentId) === parentId)),
            ws: orderedWorkbenches.filter((w) => Number(w.spaceId) === spaceId && (atRoot
              ? (Number(w.parentId || 0) === 0 || folderIds.has(Number(w.parentId || 0)) === false)
              : Number(w.parentId || 0) === parentId))
          };
        };

        const renderFolderNode = (folder, depth) => {
          const open = folderCollapsed[folder.id] !== true;
          const kids = kidsOf(Number(folder.spaceId), Number(folder.id));
          const count = kids.fs.length + kids.ws.length;
          return h("div", { key: "folder-" + String(folder.id), className: "dshe-wb-folder" },
            h("div", {
              className: "dshe-wb-folder-row" + (folderDropId === folder.id ? " dshe-wb-folder-drop" : ""),
              style: { paddingLeft: String(depth * 12) + "px" },
              onDragOver: (event) => {
                if (dragIdRef.current === "") return;
                event.preventDefault();
                try { event.dataTransfer.dropEffect = "move"; } catch { /* 同上 */ }
                setFolderDropId(folder.id);
              },
              onDragLeave: () => setFolderDropId((prev) => (prev === folder.id ? 0 : prev)),
              onDrop: (event) => {
                event.preventDefault();
                const fromId = dragIdRef.current;
                dragIdRef.current = "";
                setFolderDropId(0);
                moveToFolder(fromId, Number(folder.id));
              }
            },
              h("button", {
                type: "button", className: "dshe-wb-caret",
                title: open ? "收起目录" : "展开目录",
                "aria-expanded": open,
                onClick: () => toggleFolder(folder.id)
              }, h(Icon, { name: open ? "chevron-down" : "chevron-up", size: 13 })),
              h("button", {
                type: "button", className: "dshe-wb-folder-btn",
                title: String(folder.name || "") + "（可把工作台拖进这里）",
                onClick: () => toggleFolder(folder.id)
              },
                h(Icon, { name: "layers", size: 14 }),
                h("span", { className: "dshe-wb-folder-name" }, String(folder.name || "未命名目录")),
                h("span", { className: "dshe-lib-count" }, String(count))
              )
            ),
            open === true
              ? h("div", { className: "dshe-wb-folder-children" },
                  renderLevel(Number(folder.spaceId), Number(folder.id), depth + 1))
              : null
          );
        };

        function renderLevel(spaceId, parentId, depth) {
          const { fs, ws } = kidsOf(spaceId, parentId);
          return fs.map((f) => renderFolderNode(f, depth)).concat(ws.map((w) => renderWorkbenchNode(w, depth)));
        }

        return h("div", null,
          spaceIds.map((space) => h("div", { key: "space-" + String(space.id), className: "dshe-wb-space" },
            h("div", { className: "dshe-wb-space-head", title: space.name },
              space.name || ("空间 " + String(space.id))),
            renderLevel(space.id, 0, 0)
          ))
        );
      }

      /** 本地模式保持原来的扁平文件树。 */
      function renderFlatTree() {
        if (orderedWorkbenches.length === 0) {
          return h("div", { className: "dshe-wb-meta" }, "暂无工作台");
        }
        return orderedWorkbenches.map((item) => renderWorkbenchNode(item, 0));
      }

      function renderTree() {
        return treeMode === true ? renderFolderTree() : renderFlatTree();
      }

      return h("div", { className: "dshe-wb" },
        /* 固定工具条：最上面一行只放「工作台名称 + 插件自己的操作」，无说明文案 */
        h("div", { className: "dshe-wb-toolbar" },
          h("div", { className: "dshe-wb-toolbar-main" },
            h("span", { className: "dshe-wb-toolbar-title" },
              active !== null ? String(active.name || active.id) : "工作台")
          ),
          h("div", { className: "dshe-wb-toolbar-actions" }, renderToolbar())
        ),
        h("div", { className: "dshe-wb-main" },
          /* 左侧：文件树（在线模式＝空间/目录/工作台三级，本地模式＝扁平列表）；
             收起后只留一条窄条，右侧 iframe 自动占满。 */
          sideCollapsed === true
            ? h("aside", { className: "dshe-side-rail", "aria-label": "工作台文件（已收起）" },
                h("button", {
                  type: "button",
                  className: "dshe-side-rail-btn",
                  title: "展开侧栏",
                  "aria-label": "展开工作台侧栏",
                  onClick: toggleSide
                }, h("span", { style: { display: "inline-flex", transform: "rotate(-90deg)" } },
                  h(Icon, { name: "chevron-down", size: 14 }))),
                h("span", { className: "dshe-side-rail-label" }, "工作台")
              )
            : h("aside", {
                className: "dshe-wb-side",
                "aria-label": "工作台文件",
                style: { width: String(sideWidth) + "px" }
              },
                h("div", { className: "dshe-wb-side-head" },
                  h("div", { className: "dshe-wb-side-title" }, "工作台"),
                  h("button", {
                    type: "button", className: "dshe-side-fold",
                    title: "收起侧栏", "aria-label": "收起工作台侧栏",
                    onClick: toggleSide
                  }, h("span", { style: { display: "inline-flex", transform: "rotate(90deg)" } },
                    h(Icon, { name: "chevron-down", size: 13 })))
                ),
                h("div", { className: "dshe-wb-tree" }, renderTree())
              ),
          /* 分隔条：拖动改左侧宽度，双击复位，← → 可键盘微调；收起时不渲染 */
          sideCollapsed === true ? null : h("div", {
            key: "resizer",
            className: "dshe-wb-resizer",
            role: "separator",
            "aria-orientation": "vertical",
            "aria-label": "拖动调整左侧栏宽度",
            "aria-valuemin": WB_SIDE_WIDTH_MIN,
            "aria-valuemax": WB_SIDE_WIDTH_MAX,
            "aria-valuenow": sideWidth,
            tabIndex: 0,
            title: "拖动调整宽度，双击恢复默认",
            onMouseDown: startResize,
            onDoubleClick: resetSideWidth,
            onKeyDown: onResizeKey
          }),
          /* 右侧：整页 HTML 铺满；冲突 / 错误 / 空态覆盖在页面上方 */
          h("div", { className: "dshe-wb-stage" },
            listError !== ""
              ? h("div", { className: "dshe-wb-errors", role: "alert" }, listError)
              : null,
            editTable !== null
              ? h("div", { className: "dshe-wb-gridview" },
                  h("div", { className: "dshe-wb-gridbar" },
                    h("span", { className: "dshe-wb-gridtitle" }, String(editTable.file)),
                    gridDirty === true
                      ? h("span", { className: "dshe-wb-griddirty" }, "未保存")
                      : null,
                    h("div", { className: "dshe-wb-gridactions" },
                      h("button", {
                        type: "button",
                        className: "dshe-btn dshe-btn-primary",
                        disabled: grid === null || gridSaving === true || gridDirty !== true,
                        onClick: saveGrid
                      }, gridSaving === true ? "保存中…" : "保存"),
                      h("button", {
                        type: "button",
                        className: "dshe-btn",
                        disabled: gridSaving === true,
                        onClick: () => openGrid(editTable.workbench, editTable.file)
                      }, "重新加载"),
                      h("button", {
                        type: "button",
                        className: "dshe-btn",
                        onClick: closeGrid
                      }, "返回页面")
                    )
                  ),
                  gridError !== "" ? h("div", { className: "dshe-lib-error", role: "alert" }, gridError) : null,
                  gridLoading === true
                    ? h("div", { className: "dshe-wb-meta" }, "正在读取数据表…")
                    : (grid === null
                        ? h("div", { className: "dshe-wb-meta" }, "没有数据")
                        : h("div", { className: "dshe-lib-grid-wrap" },
                            h("table", { className: "dshe-lib-grid" },
                              /* 表头只读：改列名会让后端按新列名重组数据、丢掉旧列，
                                 远程下发场景下风险大于收益，这里明确只做「查看」。 */
                              h("thead", null, h("tr", null,
                                grid.columns.map((key, col) =>
                                  h("th", { key: "gh-" + String(col) },
                                    h("span", {
                                      className: "dshe-wb-gridth",
                                      title: String(key)
                                    }, String(key === "_id" ? "ID" : key))
                                  ))
                              )),
                              h("tbody", null, grid.rows.map((row, index) =>
                                h("tr", { key: "gr-" + String(index) },
                                  grid.columns.map((key, col) =>
                                    h("td", { key: "gc-" + String(col) },
                                      key === "_id"
                                        /* _id 是行身份，改了会重建行，只读展示。 */
                                        ? h("span", { className: "dshe-wb-gridid", title: String(row[key] || "") }, String(row[key] || "").slice(0, 8))
                                        : h("input", {
                                            className: "dshe-lib-grid-input",
                                            value: String(row[key] === null || row[key] === undefined ? "" : row[key]),
                                            "aria-label": "第 " + String(index + 2) + " 行 " + String(key) + " 列",
                                            onChange: (event) => setGridCell(index, key, String((event && event.target && event.target.value) || ""))
                                          })
                                    ))
                                ))
                              )
                            )
                          ))
                )
              : (active === null || dataReady !== true
              ? h("div", { className: "dshe-wb-empty" },
                  h("div", { className: "dshe-wb-empty-title" },
                    active === null ? "还没有可用的工作台" : "数据目录不可读写"),
                  h("div", null, active === null
                    ? "让 dsh 生成一个带 CSV 数据表的 HTML 工作台，放到数据目录根下，再点「刷新」。不配置也能用，默认目录见下方。"
                    : "数据目录需要是一个已存在且可写的绝对路径；HTML 放目录根下、CSV 放 <工作台 id>/ 子目录。"),
                  h("div", { className: "dshe-wb-meta" }, "数据目录：" + (htmlDir !== "" ? htmlDir : "~/.dsh/dsh-buddy-expert-hub/workbench")),
                  h("div", { className: "dshe-wb-meta" }, "在 dsh 的「设置 → Buddy 工作台 → 个人工作台」里填数据目录")
                )
              : h("iframe", {
                  key: "dshe-wb-frame-" + String(frameKey),
                  ref: iframeRef,
                  className: "dshe-wb-frame",
                  title: String(active.name || active.id),
                  /* 不给 allow-same-origin：opaque origin 下 iframe 无法直调插件写接口。 */
                  sandbox: "allow-scripts",
                  src: frameSrc,
                  /* iframe 一加载完就主动推一次数据：万一「子→父」的请求通道有问题
                     （Electron 沙箱里出现过），父→子的 push 仍然能到，kbAdapter 会把它
                     写进缓存，页面靠缓存也能渲染首屏，不至于一直「加载中」。 */
                  onLoad: () => {
                    const sel = activeRef.current;
                    if (sel.id === "" || sel.table === "") return;
                    /* 把挂载的每张表都推一遍（一般也就一两张），页面切换表时同样命中缓存 */
                    const files = (active !== null && Array.isArray(active.tables) ? active.tables : [])
                      .map((it) => String(it.file || "")).filter((it) => it !== "");
                    if (files.length === 0) return;
                    setTimeout(() => {
                      files.forEach((file) => {
                        loadData("", file)
                          .then((snapshot) => { if (snapshot !== null) pushData("init", snapshot); })
                          .catch(() => { /* 页面自己的请求还会再试，这里静默 */ });
                      });
                    }, 600);
                  }
                })),
            conflict !== null
              ? h("div", { className: "dshe-wb-alert", role: "alert" },
                  h("span", null, conflict),
                  h("button", {
                    type: "button", className: "dshe-btn",
                    onClick: () => { setConflict(null); manualRefresh(); }
                  }, "重新加载"),
                  h("button", { type: "button", className: "dshe-btn", onClick: () => setConflict(null) }, "放弃本次修改")
                )
              : null,
            errors.length > 0
              ? h("div", { className: "dshe-wb-errors" }, "已跳过 " + String(errors.length) + " 个声明不合法的工作台：" + errors.join("；"))
              : null
          )
        ),
        ingestOpen === true
          ? h(IngestDialog, {
              info: ingestInfo,
              onRefresh: refreshIngest,
              onClose: () => setIngestOpen(false),
              onToast: (text) => props.onToast(text)
            })
          : null,
        directOpen === true && directNodeId > 0
          ? h(DirectLinkDialog, {
              nodeId: directNodeId,
              nodeName: active === null ? "" : String(active.name || ""),
              requestSnapshot: requestSnapshot,
              onClose: () => setDirectOpen(false),
              onToast: (text) => props.onToast(text)
            })
          : null,
        /* 右键「移动到目录」：拖拽之外的备用入口（触控板 / 小屏更好点） */
        moveMenu === null ? null : h("div", {
          key: "move-mask",
          className: "dshe-wb-movemask",
          onClick: () => setMoveMenu(null)
        },
          h("div", {
            className: "dshe-wb-movemenu",
            style: {
              left: String(Math.min(moveMenu.x, (typeof window !== "undefined" ? window.innerWidth : 1200) - 196)) + "px",
              top: String(Math.min(moveMenu.y, (typeof window !== "undefined" ? window.innerHeight : 800) - 260)) + "px"
            },
            onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); }
          },
            h("div", { className: "dshe-wb-movetitle" }, "移动到目录"),
            h("button", {
              type: "button",
              className: "dshe-wb-moveitem",
              onClick: () => { const id = moveMenu.id; setMoveMenu(null); moveToFolder(id, 0); }
            }, h(Icon, { name: "layers", size: 13 }), h("span", null, "空间根目录")),
            folders.filter((f) => Number(f.spaceId) === moveMenu.spaceId).map((f) => h("button", {
              key: "mv-" + String(f.id),
              type: "button",
              className: "dshe-wb-moveitem",
              title: String(f.name || ""),
              onClick: () => { const id = moveMenu.id; setMoveMenu(null); moveToFolder(id, Number(f.id)); }
            },
              h(Icon, { name: "layers", size: 13 }),
              h("span", { className: "dshe-wb-folder-name" }, String(f.name || "未命名目录"))
            ))
          )
        ),
      );
    }

    function Panel() {
      const [status, setStatus] = useState(null);
      const [statusError, setStatusError] = useState(null);
      const [tab, setTab] = useState("experts");
      /* 技能块的来源子分组：repo=仓库技能，skillhub=SkillHub 商店。
         「已安装」已挪到统一工具栏的视图按钮组，不再是一个 subtab。 */
      const [skillSource, setSkillSource] = useState("repo");
      /* 技能页统一视图：all=仓库技能 / installed=本机已安装 / cloud=SkillHub 商店。 */
      const [skillView, setSkillView] = useState("all");
      /* 专家 / 专家团共用统一视图：all=全部 / installed=已导入 / cloud=仓库来源。 */
      const [expertView, setExpertView] = useState("all");
      /* 当前打开的文件夹导入弹窗类型：null 表示关闭。 */
      const [folderImportType, setFolderImportType] = useState(null);
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
      /* 首次使用需认证 / 填参数的连接器：卡片「+」打开的连接弹窗目标。 */
      const [connectTarget, setConnectTarget] = useState(null);
      /* 连接器页来源视图：全部 / 已安装 / 云端。 */
      const [connectorView, setConnectorView] = useState("all");
      /* 「已安装」视图下的来源细分：全部 / 本地自定义 / 云端下载（纯前端过滤）。 */
      const [connSourceView, setConnSourceView] = useState("all");
      /* 「+ 新增连接器」手动配置弹窗。 */
      const [createOpen, setCreateOpen] = useState(false);

      const prevBusy = useRef(false);
      const restoreFocusRef = useRef(null);

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

      /* 选择器里完成连接 / 登记失败后都要让列表页重新拉一次 /connectors/connected，
         保证「会话挂载状态」与「列表卡片形态」对账，不出现挂上了却仍显示 +。 */
      useEffect(() => {
        const onConnectionsChanged = () => { setNonce((value) => value + 1); };
        try {
          window.addEventListener("dsh-buddy-expert-hub:connections-changed", onConnectionsChanged);
        } catch { /* 非 DOM 环境降级：忽略 */ }
        return () => {
          try {
            window.removeEventListener("dsh-buddy-expert-hub:connections-changed", onConnectionsChanged);
          } catch { /* 同上 */ }
        };
      }, []);

      const ready = status !== null && status.indexReady === true;
      const activeQuery = applied[tab] || "";

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
        fetchJson(listPath(tab, activeQuery, 0, pageSizeOf(tab), connectorView))
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
      }, [ready, tab, activeQuery, nonce, connectorView]);

      // toast 自动消失。
      useEffect(() => {
        if (toast === null) return undefined;
        const timer = setTimeout(() => setToast(null), 3200);
        return () => clearTimeout(timer);
      }, [toast]);

      /* 注册工作台 toast sink：serialize 不持有组件实例，目录同步结果靠
         模块级 sink 回传到当前可见面板；cleanup 置 null，不弹两份。 */
      useEffect(() => {
        setWorkbenchToastSink(setToast);
        return () => setWorkbenchToastSink(null);
      }, []);

      /* 工作台指令联动：`@` 源选中模板后派发 window 事件，这里收到就点开侧栏的
         「个人工作台」独立面板（工作台已不是本面板的大块，只保留侧栏入口）。
         指令源不持有组件实例，靠事件解耦；监听失败（无 window / 宿主禁事件）静默跳过。 */
      useEffect(() => {
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        const onOpenWorkbench = () => {
          try {
            const marker = document.querySelector("[data-dsh-buddy-expert-hub-workbench-trigger]");
            const button = marker === null ? null : marker.closest("button");
            if (button !== null && button !== undefined) button.click();
          } catch { /* 找不到侧栏入口时静默跳过 */ }
        };
        try {
          window.addEventListener(WORKBENCH_OPEN_EVENT, onOpenWorkbench);
        } catch {
          return undefined;
        }
        return () => {
          try { window.removeEventListener(WORKBENCH_OPEN_EVENT, onOpenWorkbench); } catch { /* 忽略 */ }
        };
      }, []);

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
       * 连接器卡片按钮的唯一入口：按状态机决定「先连接」还是「直接对话」。
       *
       * - 免认证 / 无参数（needsSetup === false）或已连接：直接走会话常驻；
       * - 需要认证 / 参数且尚未连接：打开连接弹窗，完成后卡片变对话气泡；
       * - 旧数据（完全没有新字段）：保持旧行为，点「+」直接常驻登记。
       *
       * @param {any} item 连接器条目
       * @returns {void}
       */
      /**
       * 安装连接器定义到本地：只保存定义，不写宿主 profile、不保存凭据。
       * 连接是安装之后独立的一步（点卡片「+」）。
       * @param {any} item 云端条目
       * @returns {void}
       */
      function installConnector(item) {
        const id = String((item && item.id) || "");
        if (id === "") return;
        const label = trimmed(item.name) || id;
        fetch(API + "/connectors/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id })
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setToast("已安装「" + label + "」到本地");
              setNonce((value) => value + 1);
            } else {
              setToast(String((res && (res.error || res.message)) || "安装失败"));
            }
          })
          .catch((error) => setToast("安装失败：" + String((error && error.message) || error)));
      }

      /**
       * 卸载本地安装的连接器定义；若已连接会同时断开连接登记。
       * 不自动改用户 profile（只提示需要手动移除或重新连接覆盖）。
       * 卸载成功后广播 attachments-changed：后端已清掉会话里注入的上下文，
       * dock 立即对账刷新，不必等 5s 轮询；失败分支不广播。
       * @param {any} item 条目
       * @returns {void}
       */
      function uninstallConnector(item) {
        const id = String((item && item.id) || "");
        if (id === "") return;
        const label = trimmed(item.name) || id;
        fetch(API + "/connectors/uninstall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id })
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setToast("已卸载「" + label + "」" + (res.disconnected === true ? "，并断开连接登记" : ""));
              /* 后端已同步撤掉本会话注入的上下文：让 dock 立即对账，不必等 5s 轮询 */
              try { window.dispatchEvent(new Event("dsh-buddy-expert-hub:attachments-changed")); } catch { /* 忽略 */ }
              setNonce((value) => value + 1);
            } else {
              const message = String((res && (res.error || res.message)) || "卸载失败");
              /* 后端对含路径分隔符 / 前导点的 id 一律 400 拒绝（防路径穿越）。
                 这类条目能装（云端定义自报的脏 id）但不能通过界面卸载，
                 只回一句「非法的连接器 id」等于死路，这里必须给出下一步动作。 */
              if (message.indexOf("非法的连接器 id") >= 0) {
                setToast("该连接器 id 含非法字符（" + id + "），无法通过界面卸载；请手动删除 " +
                  "$DSH_HOME/dsh-buddy-expert-hub/connectors/ 下的对应目录");
              } else {
                setToast(message);
              }
            }
          })
          .catch((error) => setToast("卸载失败：" + String((error && error.message) || error)));
      }

      function connectConnector(item) {
        const id = String(item.id || "");
        if (id === "") return;
        const setup = connectorSetupOf(item);
        const alreadyConnected = connectedConnectors.indexOf(id) >= 0;
        if (setup.needsSetup === true && setup.legacy === false && alreadyConnected === false) {
          setConnectTarget(item);
          return;
        }
        attachConnectorToConversation(item);
      }

      /**
       * 把连接器挂到本会话的 system prompt 上常驻（对话气泡 / 免认证直连）。
       *
       * 两步都成功才提示：先 POST /attach 建立会话常驻（与专家单选不同，连接器
       * 可多选、不清专家），再 POST /connectors/connect 保留列表按钮的「已连接」形态。
       * 宿主 MCP 工具仍需 profile 里的 mcp-client 实例，本插件不改用户配置文件。
       *
       * @param {any} item 连接器条目
       * @returns {void}
       */
      function attachConnectorToConversation(item) {
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
                  (res2.hostConfigRequired === true
                    ? "；MCP 配置以占位符形式随会话提供，工具真正可用仍需宿主侧 mcp-client 配置"
                    : ""));
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
       * 计算结构化引用的 id。
       *
       * 技能必须用「已安装记录的 dir」（宿主原生技能名 = `/` 指令名）：仓库相对
       * 路径 `skills/集合/名字` 与 SkillHub slug 都不是合法指令名。未安装 / 已关闭
       * 的技能在 applyToConversation 里已经被拦下，不会走到这里。
       * 其余类型沿用原有的仓库 id / slug / 展示名兜底，行为保持不变。
       * @param {any} item 列表条目
       * @param {any} installedRow 已安装技能记录；非技能或没有记录时传 null
       * @param {string} label 展示名兜底
       * @returns {string} 引用 id
       */
      function refIdOf(item, installedRow, label) {
        const dir = installedRow !== null && installedRow !== undefined ? trimmed(installedRow.dir) : "";
        if (dir !== "") return dir;
        /* 兜底：已安装记录缺 dir、或未来新增其它引用类型时，仍不让 ref 变成
           "skill:undefined"；沿用原有的 id / slug / 展示名优先级。 */
        return String(item.id || item.slug || label);
      }

      /**
       * 把技能/连接器作为**结构化引用**插入当前会话草稿（与 composer 菜单选中效果一致）。
       *
       * 走宿主 `input.insertReference`（pickerInsertRef 桥），草稿里出现 chip；
       * 发送时技能由 serialize 输出 `/指令名`、连接器仍内联 MCP 配置——不往输入框塞纯文本。
       *
       * @param {any} item 技能或连接器条目
       * @param {'skill'|'connector'} refType 引用类型
       * @returns {void}
       */
      function applyToConversation(item, refType) {
        const label = trimmed(item.name) || trimmed(item.displayName) || String(item.id);
        /* 已安装技能记录：技能引用要用它的 dir（宿主原生技能名）作为 / 指令名。 */
        let installedRow = null;
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
          installedRow = row;
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
        /* 技能引用统一改用宿主原生技能名（已安装目录名），不再用仓库相对路径：
           后者不是合法的 / 指令名，列表页气泡插入的 chip 发送后同样是 /技能名。
           非技能与「没有已安装记录」时 refIdOf() 仍走旧的 id / slug 兜底。 */
        const refId = refIdOf(item, installedRow, label);
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
       * 文件夹导入成功后刷新对应列表。
       *
       * 技能刷新 /skills/installed 并切到「已安装」；专家 / 专家团刷新
       * /imported 与 /status，并切到「已安装」。索引数据靠 nonce 重拉。
       *
       * @param {'skill'|'expert'|'team'} importedType 本次导入类型
       * @returns {void}
       */
      function onFolderImported(importedType) {
        loadStatus();
        loadImported();
        setNonce((value) => value + 1);
        if (importedType === "skill") {
          refreshInstalledSkills();
          setSkillView("installed");
        } else {
          setExpertView("installed");
        }
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
        ? { experts: 0, teams: 0, skills: 0, connectors: 0, workbench: 0 }
        : status.counts;

      /* 连接器数量为 0 时不要显示「0 个连接器」——那多半是资源仓库还没同步，
         直接说清楚下一步该做什么，避免用户以为是功能坏了。
         有「不可连接」条目时把可连接条数一并报出：列表是全量的（316 条里有 61 条
         CLI / SSE / 占位符地址），只报总数会让用户以为 316 个都能连。 */
      const connectorTotal = Number(counts.connectors) || 0;
      const connectorLocked = Number(counts.unsupported) || 0;
      const connectorConnectable = counts.connectable === undefined || counts.connectable === null
        ? connectorTotal - connectorLocked
        : Number(counts.connectable) || 0;
      const connectorText = connectorTotal > 0
        ? String(connectorTotal) + " 个连接器" +
          (connectorLocked > 0 ? "（" + String(connectorConnectable) + " 个可连接）" : "")
        : "连接器需先同步资源仓库";
      const subtitle =
        String(counts.experts) + " 位专家 · " +
        String(counts.teams) + " 个专家团 · " +
        String(counts.skills) + " 个技能 · " +
        connectorText;

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
       * 渲染连接器列表。
       *
       * 两级筛选：
       *  1. 顶部「全部 / 已安装 / 云端」——走后端 `origin` 参数，切换会重新拉数据；
       *  2. 「已安装」视图下的「来源」细分行（全部 / 本地自定义 / 云端下载）
       *     ——纯前端过滤（已安装条目数量很小），不进后端查询，切换不重新拉数据。
       *
       * @param {any} list 连接器分页数据
       * @returns {any} React 元素
       */
      function renderConnectors(list) {
        /* 仓库里有一部分条目是 CLI / SSE 类型或地址含占位符，宿主跑不起来（真实仓库 316 条
           里有 61 条）。它们照样出现在列表里（卡片标注「不可连接」），这里再给一句汇总说明。 */
        const lockedGlobal = status === null || status === undefined ||
          status.counts === undefined || status.counts === null
          ? 0
          : Number(status.counts.unsupported) || 0;
        /* 已安装视图才出现来源细分；来源两值固定，顺序固定，避免空来源时按钮跳动。 */
        const sourceViews = [["all", "全部"], ["manual", "本地自定义"], ["cloud", "云端下载"]];
        const sourceCounts = { all: list.items.length, manual: 0, cloud: 0 };
        for (const entry of list.items) {
          const key = connectorSourceOf(entry);
          if (key !== "" && sourceCounts[key] !== undefined) sourceCounts[key] += 1;
        }
        const visibleItems = connectorView === "installed" && connSourceView !== "all"
          ? list.items.filter((entry) => connectorSourceOf(entry) === connSourceView)
          : list.items;
        /* 汇总说明按当前视图给数：已安装视图只数眼前这几条，不能把「全仓库 61 个
           不可连接」挂在一个只有 1 条已安装连接器的列表下面（截图里就是这个问题）。 */
        const lockedInView = connectorView === "installed"
          ? visibleItems.filter((entry) => entry.connectable === false).length
          : lockedGlobal;
        /* 列表总数为 0 时，先分清是「云端仓库没同步」还是「真的一个都没有」。 */
        const repoSource = status === null || status === undefined ? null : status.connectorSource;
        const nothingAtAll = repoSource === "none" && list.items.length === 0;
        /* 已安装为空 / 某来源为空 / 搜索无结果 / 一个都没有，四种空态文案分开写。 */
        let emptyNode = null;
        if (list.items.length === 0) {
          if (activeQuery !== "") {
            emptyNode = h("div", { className: "dshe-hint" }, "没有匹配「" + activeQuery + "」的结果");
          } else if (connectorView === "installed") {
            emptyNode = h("div", { className: "dshe-conn-empty" },
              h("div", { className: "dshe-conn-empty-title" }, "还没有安装任何连接器"),
              h("div", null, "点右上「新增连接器」手动填一个，或在「云端 / 全部」里点 + 图标安装")
            );
          } else if (nothingAtAll) {
            /* 云端为 0 且本地为 0：插件不再内置连接器数据，必须先从资源仓库同步。 */
            emptyNode = h("div", { className: "dshe-conn-empty" },
              h("div", { className: "dshe-conn-empty-title" }, "还没有连接器数据"),
              h("div", null, "点右上「刷新」从资源仓库同步，或点「新增连接器」手动添加")
            );
          } else {
            /* 不再用「这里还没有数据」：按视图说清下一步该点哪个按钮。 */
            emptyNode = h("div", { className: "dshe-conn-empty" },
              h("div", { className: "dshe-conn-empty-title" },
                connectorView === "cloud" ? "云端暂无连接器数据" : "暂时没有连接器数据"),
              h("div", null, "点右上「新增连接器」手动添加，或点「刷新」从资源仓库同步"));
          }
        } else if (visibleItems.length === 0) {
          if (activeQuery !== "" && connSourceView === "all") {
            emptyNode = h("div", { className: "dshe-hint" }, "没有匹配「" + activeQuery + "」的结果");
          } else {
            /* 来源 + 关键词同时生效时，说明「是被来源挡住的」，别让用户以为关键词不存在。 */
            const filterLabel = (sourceViews.find(([id]) => id === connSourceView) || ["", "该来源"])[1];
            const tip = activeQuery !== "" && connSourceView !== "all"
              ? "「" + filterLabel + "」里没有匹配「" + activeQuery + "」的，换一个来源或清空搜索试试"
              : "换一个来源，或点「全部」看所有已安装连接器";
            emptyNode = h("div", { className: "dshe-conn-empty" },
              h("div", { className: "dshe-conn-empty-title" }, "没有来自该来源的连接器"),
              h("div", null, tip)
            );
          }
        }
        return h("div", null,
          connectorView === "installed"
            ? h("div", { className: "dshe-conn-sources" },
                h("span", { className: "dshe-conn-sources-label" }, "来源："),
                sourceViews.map(([sourceId, label]) => h("button", {
                  key: sourceId,
                  type: "button",
                  "data-source-filter": sourceId,
                  "aria-pressed": connSourceView === sourceId ? "true" : "false",
                  className: "dshe-conn-source-btn" + (connSourceView === sourceId ? " dshe-conn-source-btn-on" : ""),
                  onClick: () => setConnSourceView(sourceId)
                }, label + " " + String(sourceCounts[sourceId] || 0))))
            : null,
          emptyNode !== null
            ? emptyNode
            : h("div", { className: "dshe-conn-grid" },
                visibleItems.map((item) => h(ConnectorCard, {
                  key: item.id,
                  item,
                  installed: item.installed === true,
                  connected: connectedConnectors.indexOf(String(item.id)) >= 0,
                  onOpen: (target) => openDetail(target, "connector"),
                  onCopy: doCopy,
                  onConnect: connectConnector,
                  onInstall: installConnector,
                  onUninstall: uninstallConnector,
                  onApply: (target) => applyToConversation(target, "connector")
                }))
              ),
          emptyNode !== null ? null : renderMore(list, "连接器"),
          lockedInView > 0
            ? h("div", {
                className: "dshe-conn-skipped",
                title: "CLI 类型没有 MCP 配置；SSE 传输宿主暂不支持（HTTP 已并入 Streamable HTTP）；地址含占位符的要手工填真实值"
              }, connectorView === "installed"
                ? "其中 " + String(lockedInView) + " 个已安装连接器暂不支持在面板内连接（CLI / SSE 类型或地址含占位符），已在卡片上标记「不可连接」"
                : "其中 " + String(lockedInView) + " 个连接器暂不支持在面板内安装 / 连接（CLI / SSE 类型或地址含占位符），已在列表中标记「不可连接」")
            : null
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
       * 渲染四处统一的资源工具栏。
       *
       * 专家 / 专家团 / 技能 / 连接器都返回同一个 ResourceToolbar，只是视图状态、
       * 视图切换回调与 + 按钮的文案 / 行为不同，保证位置与样式完全一致。
       * @returns {any} React 元素
       */
      function renderToolbar() {
        const common = { views: RESOURCE_VIEWS };
        if (tab === "connectors") {
          return h(ResourceToolbar, Object.assign({}, common, {
            toolbarId: "connectors",
            addId: "connector",
            viewLabel: "连接器来源",
            view: connectorView,
            onViewChange: (next) => {
              setConnectorView(next);
              /* 离开「已安装」时清掉来源细分，避免切回来看到莫名的空列表。 */
              if (next !== "installed") setConnSourceView("all");
            },
            addLabel: "新增连接器",
            addDisabled: transferring !== "",
            onAdd: () => setCreateOpen(true)
          }));
        }
        if (tab === "skills") {
          return h(ResourceToolbar, Object.assign({}, common, {
            toolbarId: "skills",
            addId: "skill",
            viewLabel: "技能来源",
            view: skillView,
            onViewChange: (next) => {
              setSkillView(next);
              if (next === "all") setSkillSource("repo");
              else if (next === "cloud") setSkillSource("skillhub");
            },
            addLabel: "添加技能",
            addDisabled: transferring !== "",
            onAdd: () => setFolderImportType("skill")
          }));
        }
        const isTeam = tab === "teams";
        return h(ResourceToolbar, Object.assign({}, common, {
          toolbarId: isTeam ? "teams" : "experts",
          addId: isTeam ? "team" : "expert",
          viewLabel: isTeam ? "专家团来源" : "专家来源",
          view: expertView,
          onViewChange: setExpertView,
          addLabel: isTeam ? "导入专家团" : "导入专家",
          addDisabled: transferring !== "",
          onAdd: () => setFolderImportType(isTeam ? "team" : "expert")
        }));
      }

      /**
       * 按视图渲染专家 / 专家团 / 技能的空态，引导用户用对应的 + 按钮。
       * 不使用「这里还没有数据」这类泛化文案。
       * @param {string} view 当前视图 id
       * @param {'expert'|'team'|'skill'} kind 资源种类
       * @returns {any} React 元素
       */
      function renderResourceEmpty(view, kind) {
        const noun = kind === "team" ? "专家团" : kind === "skill" ? "技能" : "专家";
        const addLabel = kind === "team" ? "导入专家团" : kind === "skill" ? "添加技能" : "导入专家";
        if (activeQuery !== "") {
          return h("div", { className: "dshe-hint" }, "没有匹配「" + activeQuery + "」的结果");
        }
        if (view === "installed") {
          return h("div", { className: "dshe-conn-empty" },
            h("div", { className: "dshe-conn-empty-title" }, "还没有导入任何" + noun),
            h("div", null, "点右上「" + addLabel + "」选择符合格式的文件夹，即可添加一个" + noun));
        }
        if (view === "cloud") {
          return h("div", { className: "dshe-conn-empty" },
            h("div", { className: "dshe-conn-empty-title" }, "仓库里暂无" + noun + "数据"),
            h("div", null, "点「刷新」同步资源仓库，或点右上「" + addLabel + "」从文件夹导入"));
        }
        return h("div", { className: "dshe-conn-empty" },
          h("div", { className: "dshe-conn-empty-title" }, "暂时没有" + noun + "数据"),
          h("div", null, "点右上「" + addLabel + "」从文件夹导入，或点「刷新」同步资源仓库"));
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
        /* 已安装技能库不依赖仓库索引，随时可看可开关。 */
        if (tab === "skills" && skillView === "installed") {
          return h(InstalledSkills, {
            items: installedSkills,
            onToggle: toggleInstalledSkill
          });
        }
        /* SkillHub 商店与仓库数据互不依赖：仓库没同步时也能逛商店，放在同步门禁之前。 */
        if (tab === "skills" && skillSource === "skillhub") {
          return h(SkillHubStore, {
            onToast: setToast,
            installedSkills,
            onApply: (target) => applyToConversation(target, "skill")
          });
        }
        /* 统一视图里的「云端」对技能指 SkillHub 云端商店。 */
        if (tab === "skills" && skillView === "cloud") {
          return h(SkillHubStore, {
            onToast: setToast,
            installedSkills,
            onApply: (target) => applyToConversation(target, "skill")
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
        /* 连接器页自带空态（已安装 → 引导新增/安装；来源筛选 → 提示换来源）。 */
        if (tab === "connectors") return renderConnectors(list);
        if (tab === "skills") {
          return list.items.length === 0
            ? renderResourceEmpty(skillView, "skill")
            : renderSkills(list);
        }
        /* 专家 / 专家团：三视图纯前端过滤，避免动索引。 */
        const items = expertView === "installed"
          ? list.items.filter((item) => item.local === true || importedIds.indexOf(item.id) >= 0)
          : expertView === "cloud"
            ? list.items.filter((item) => item.local !== true)
            : list.items;
        if (items.length === 0) {
          return renderResourceEmpty(expertView, tab === "teams" ? "team" : "expert");
        }
        return h("div", { className: "dshe-grid" },
          items.map((item) => h(ExpertCard, {
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
            h("p", { className: "dshe-sub" }, subtitle),
            /* 切到 git 数据源时旧索引会保留到下次同步：在副标题下方给一条不挡操作的提示。 */
            status !== null && status.indexStale === true
              ? h("p", {
                  className: "dshe-sub-stale",
                  role: "status",
                  "aria-label": "数据源已切换"
                }, "数据源已切换，点「刷新」以应用新数据源")
              : null
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
        /* 技能块的二级子分组：仓库技能 / SkillHub 商店。
           「已安装」已统一到上方工具栏的视图按钮组，不再占用一个 subtab。 */
        groupOfTab(tab) === "skill"
          ? h("div", { className: "dshe-subtabs", role: "tablist", "aria-label": "技能来源" },
              h("button", {
                type: "button",
                className: "dshe-subtab" + (skillSource === "repo" ? " dshe-subtab-on" : ""),
                role: "tab",
                "aria-selected": skillSource === "repo",
                onClick: () => { setSkillSource("repo"); setSkillView("all"); }
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
                onClick: () => { setSkillSource("skillhub"); setSkillView("cloud"); }
              },
                "SkillHub 商店"
              )
            )
          : null,
        h("div", { className: "dshe-body", onScroll: onBodyScroll },
          renderToolbar(),
          renderBody()
        ),
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
        createOpen
          ? h(ConnectorCreateDialog, {
              onClose: () => setCreateOpen(false),
              onToast: setToast,
              onCreated: () => {
                setConnectorView("installed");
                setNonce((value) => value + 1);
              }
            })
          : null,
        folderImportType !== null
          ? h(FolderImportDialog, {
              type: folderImportType,
              onClose: () => setFolderImportType(null),
              onToast: setToast,
              onImported: onFolderImported
            })
          : null,
        connectTarget !== null
          ? h(ConnectorConnectDialog, {
              /* key 保证切换连接器时输入框 state 重新初始化，不残留上一条目的值 */
              key: "connect-" + String(connectTarget.id),
              item: connectTarget,
              onClose: () => setConnectTarget(null),
              onToast: setToast,
              onConnected: () => setNonce((value) => value + 1)
            })
          : null,
        toast !== null ? h("div", { className: "dshe-toast" }, toast) : null
      );
    }

    /**
     * 侧边栏「个人工作台」独立面板的薄壳。
     *
     * 只负责壳（toast），真正的列表、iframe、父桥、轮询、冲突 UI、
     * 工作台设置弹窗全部由 WorkbenchView 自己管理（设置按钮在每个工作台视图的
     * 固定工具条上），这里不重写第二套实现。
     *
     * 版面：不再有「个人工作台」大标题与功能说明副标题，页面第一行就是
     * WorkbenchView 的固定工具条（当前工作台名称 + 刷新/设置按钮），
     * 下面是「左侧文件树 + 右侧整页 HTML」。
     *
     * 事件解耦：`@` 指令源选中模板后派发 WORKBENCH_OPEN_EVENT，由主资源面板
     * 点击本面板的侧栏入口；本面板展示的就是工作台视图，无需处理该事件。
     *
     * @returns {any} React 元素
     */
    /* =======================================================================
       在线资料库面板：整屏左树 + 右列表（截图版式），颜色全部走宿主 token。
       只做文档增删改查；空间 / 成员 / 权限等管理功能不实现。
       ======================================================================= */

    /* =======================================================================
       HTML 直链（资料库面板 / 工作台面板共用）
       在线资料库的分享现在分两类：LIVE 实时直链、SNAPSHOT 当前页静态快照。
       这里把它们收进独立弹窗，与「分享」弹窗（普通分享管理）彻底分开。
       ======================================================================= */

    /** 快照请求自增序号：不用随机数，保证 id 可复现（图标配色那条守门断言禁止随机源）。 */
    var snapshotSeq = 0;

    /** 插件服务端的 JSON 写请求（两个面板共用，避免各写一份）。 */
    function khubApiSend(path, method, body) {
      return fetch(API + path, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      }).then((resp) => resp.json());
    }

    /** 待回传的快照请求：id → { resolve, reject, timer }。 */
    var snapshotPending = {};

    /**
     * 在已有的 message 监听里处理快照回传。两个面板都调它，不再各自多注册一个监听。
     * @param {any} data event.data
     * @returns {boolean} true 表示这条消息属于快照协议，调用方应直接 return
     */
    function handleSnapshotResult(data) {
      if (data === null || data === undefined || data.type !== "khub:snapshot:result") return false;
      const pending = snapshotPending[data.id];
      if (pending === undefined) return true;
      clearTimeout(pending.timer);
      delete snapshotPending[data.id];
      if (String(data.error || "") !== "") pending.reject(new Error(String(data.error)));
      else pending.resolve(String(data.html || ""));
      return true;
    }

    /**
     * 向 HTML 预览 iframe 请求「当前页静态快照」。
     * iframe 是 opaque origin，父窗口读不到 DOM，只能靠注入的采集器 postMessage 回传。
     * @param {Function} frameWindow 取 iframe.contentWindow 的函数
     * @returns {Promise<string>} 冻结后的 HTML
     */
    function snapshotRequest(frameWindow) {
      return new Promise((resolve, reject) => {
        let win = null;
        try { win = frameWindow(); } catch { win = null; }
        if (win === null) { reject(new Error("预览尚未就绪，请稍后再试")); return; }
        snapshotSeq += 1;
        const id = "snap-" + String(Date.now()) + "-" + String(snapshotSeq);
        const timer = setTimeout(() => {
          delete snapshotPending[id];
          reject(new Error("页面未响应快照请求（8 秒），请刷新预览后重试"));
        }, 8000);
        snapshotPending[id] = { resolve: resolve, reject: reject, timer: timer };
        try { win.postMessage({ type: "khub:snapshot:request", id: id }, "*"); }
        catch (error) { clearTimeout(timer); delete snapshotPending[id]; reject(error); }
      });
    }

    /**
     * 「HTML 直链」弹窗：实时直链 + 当前页分享（静态快照），两类分开列。
     * @param {any} props nodeId / nodeName / requestSnapshot / onClose / onToast
     * @returns {any} React 元素
     */
    function DirectLinkDialog(props) {
      const [shares, setShares] = useState([]);
      const [baseUrl, setBaseUrl] = useState("");
      const [busy, setBusy] = useState("");
      const [errText, setErrText] = useState("");
      const nodeId = Number(props.nodeId || 0);
      const origin = String(baseUrl || "").replace(/\/+$/, "");

      function loadList() {
        return fetchJson("/khub/shares?nodeId=" + encodeURIComponent(String(nodeId)))
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { setShares([]); return; }
            setShares(Array.isArray(res.shares) ? res.shares : []);
          })
          .catch(() => setShares([]));
      }

      useEffect(() => {
        fetchJson("/khub/settings")
          .then((res) => { if (res !== null && res !== undefined && typeof res.baseUrl === "string") setBaseUrl(res.baseUrl); })
          .catch(() => { /* 地址取不到时链接只显示相对部分 */ });
        loadList();
      }, [nodeId]);

      const isSnapshot = (item) => String(item.mode || "").toUpperCase() === "SNAPSHOT";
      const live = shares.filter((item) => isSnapshot(item) === false);
      const snaps = shares.filter(isSnapshot);

      function copy(text) {
        const value = String(text || "");
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
            navigator.clipboard.writeText(value)
              .then(() => props.onToast("已复制链接")).catch(() => props.onToast(value));
            return;
          }
        } catch { /* 无剪贴板权限时把地址直接显示出来 */ }
        props.onToast(value);
      }
      function openLink(url) {
        try { window.open(url, "_blank", "noopener"); }
        catch { props.onToast(url); }
      }
      function failText(res, error) {
        return String((error && (error.message || error.error)) ||
          (res && (res.error || res.message)) || "操作失败");
      }
      function create(kind) {
        setBusy(kind);
        setErrText("");
        const task = kind === "snapshot"
          ? props.requestSnapshot().then((html) => ({
              nodeId: nodeId, permission: "VIEW", mode: "SNAPSHOT", snapshotHtml: html
            }))
          : Promise.resolve({ nodeId: nodeId, permission: "VIEW" });
        task.then((body) => khubApiSend("/khub/share", "POST", body))
          .then((res) => {
            setBusy("");
            if (res === null || res === undefined || res.ok !== true) { setErrText(failText(res, null)); return; }
            props.onToast(kind === "snapshot" ? "当前页快照链接已生成" : "直连链接已生成");
            loadList();
          })
          .catch((error) => { setBusy(""); setErrText(failText(null, error)); });
      }
      function removeShare(item) {
        khubApiSend("/khub/share?id=" + encodeURIComponent(String(item.id)), "DELETE", {})
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { setErrText(failText(res, null)); return; }
            props.onToast("链接已取消，打开将失效");
            loadList();
          })
          .catch((error) => setErrText(failText(null, error)));
      }

      /**
       * 「允许访客编辑」开关：改同一条 LIVE 分享的 permission（token 不变，已发出的链接继续有效）。
       * 后端把非 WRITE 一律归一为 READ；快照分享后端明确禁止改成 WRITE，所以只给实时直链用。
       * 失败时重新拉一次列表，开关自然回滚。
       * @param {any} item 分享条目
       * @param {boolean} writable 是否允许编辑
       */
      function togglePerm(item, writable) {
        const key = "perm-" + String(item.id);
        setBusy(key);
        setErrText("");
        khubApiSend("/khub/share", "PUT", { id: item.id, permission: writable === true ? "WRITE" : "READ" })
          .then((res) => {
            setBusy("");
            if (res === null || res === undefined || res.ok !== true) { setErrText(failText(res, null)); loadList(); return; }
            props.onToast(writable === true ? "已允许访客编辑" : "已改为只读");
            loadList();
          })
          .catch((error) => { setBusy(""); setErrText(failText(null, error)); loadList(); });
      }

      /** 实时直链的权限行：允许访客编辑开关 + 有效期 + 当前状态说明。 */
      function permRow(item) {
        const writable = String(item.permission || "").toUpperCase() === "WRITE";
        const expireAt = String(item.expireAt || "").trim();
        return h("div", { key: "perm-" + String(item.id), className: "dshe-lib-direct-perm" },
          h("button", {
            type: "button",
            className: "dshe-switch" + (writable ? " dshe-switch-on" : ""),
            role: "switch",
            "aria-checked": writable ? "true" : "false",
            "aria-label": "允许访客编辑",
            disabled: busy !== "",
            onClick: () => togglePerm(item, writable === false)
          }, h("span", { className: "dshe-switch-dot" })),
          h("span", { className: "dshe-lib-direct-perm-label" }, "允许访客编辑"),
          h("span", { className: "dshe-lib-direct-perm-expire" },
            item.expired === true ? "已过期" : (expireAt === "" ? "长期有效" : "有效期至 " + expireAt)),
          h("span", { className: "dshe-lib-direct-perm-hint" },
            writable
              ? "页面里的新增行 / 改单元格会写回资料库，链接等同于可写凭证。"
              : "只读：访客的新增行 / 改单元格会失败，放开开关才能编辑。"));
      }

      /** 一条链接：标签 + 等宽地址 + 复制 / 打开 / 取消。 */
      function linkRow(key, label, url, item, removable) {
        return h("div", { key: key, className: "dshe-lib-share-link" },
          h("span", { className: "dshe-lib-share-label" }, label),
          h("code", { className: "dshe-lib-share-url", title: url }, url),
          h("button", { type: "button", className: "dshe-btn", onClick: () => copy(url) }, "复制"),
          h("button", { type: "button", className: "dshe-btn", onClick: () => openLink(url) }, "打开"),
          removable === true
            ? h("button", {
                type: "button", className: "dshe-btn dshe-btn-danger",
                onClick: () => removeShare(item)
              }, "取消")
            : null);
      }

      return h("div", {
          className: "dshe-mask",
          onClick: (event) => { if (event.target === event.currentTarget) props.onClose(); }
        },
        h("div", { className: "dshe-lib-dialog dshe-lib-dialog-wide", role: "dialog", "aria-modal": "true" },
          h("div", { className: "dshe-lib-dialog-title" }, "HTML 直链"),
          h("div", { className: "dshe-lib-dialog-fields" },
            h("p", { className: "dshe-set-desc" },
              "「" + String(props.nodeName || "") + "」的直链分享。普通「分享」在左侧菜单里，这里只管两种直链：实时页面 与 当前页静态快照。"),
            errText !== "" ? h("div", { className: "dshe-lib-error", role: "status" }, errText) : null,

            h("div", { className: "dshe-lib-direct-sec" },
              h("div", { className: "dshe-lib-direct-head" },
                h("b", null, "实时直链"),
                h("span", { className: "dshe-lib-direct-tag" }, "跟随数据变化"),
                h("span", { className: "dshe-lib-direct-spacer" }),
                live.length === 0
                  ? h("button", {
                      type: "button", className: "dshe-btn dshe-btn-primary",
                      disabled: busy !== "", onClick: () => create("live")
                    }, busy === "live" ? "生成中…" : "生成直连链接")
                  : null),
              h("p", { className: "dshe-lib-direct-tip" },
                "打开就是页面本身，数据实时来自资料库；链接即凭证，取消分享后立刻失效。下方开关控制访客能否改动数据。"),
              live.length === 0
                ? h("div", { className: "dshe-lib-direct-empty" }, "还没有实时直链，点右上「生成直连链接」。")
                : live.map((item) => h("div", {
                    key: "live-item-" + String(item.id), className: "dshe-lib-direct-item"
                  },
                    linkRow("live-" + String(item.id), "访问链接",
                      origin + "/p/" + String(item.token) + "/" + String(nodeId), item, true),
                    permRow(item)))),

            h("div", { className: "dshe-lib-direct-sec" },
              h("div", { className: "dshe-lib-direct-head" },
                h("b", null, "当前页分享（静态快照）"),
                h("span", { className: "dshe-lib-direct-tag" }, "只读"),
                h("span", { className: "dshe-lib-direct-spacer" }),
                h("button", {
                  type: "button", className: "dshe-btn dshe-btn-primary",
                  disabled: busy !== "", onClick: () => create("snapshot")
                }, busy === "snapshot" ? "生成中…" : "生成当前页快照")),
              h("p", { className: "dshe-lib-direct-tip" },
                "把此刻预览里的画面冻结成静态页：访客只能看，点不动、不能输入、不能读写数据；之后文档再改，链接里的画面也不变。生成前请先把预览调整到希望别人看到的样子。"),
              snaps.length === 0
                ? h("div", { className: "dshe-lib-direct-empty" }, "还没有快照链接。")
                : snaps.map((item) => linkRow("snap-" + String(item.id), "快照链接",
                    origin + "/p/" + String(item.token), item, true)))
          ),
          h("div", { className: "dshe-lib-dialog-foot" },
            h("button", { type: "button", className: "dshe-btn", onClick: props.onClose }, "关闭"))
        )
      );
    }

    /**
     * 「外部数据同步」弹窗：给定时任务写入的批次一个可视化出口。
     *
     * 数据是脚本（python / node）或 dsh 自动化任务写进 `ingest/inbox` 的，
     * 也可能是直接 POST 到 `/workbench/ingest`。这里只做「看状态 + 手动催一轮」，
     * 不做编辑 —— 数据归属仍然是用户自己的脚本。
     * @param {any} props info / onRefresh / onClose / onToast
     * @returns {any} React 元素
     */
    function IngestDialog(props) {
      const [busy, setBusy] = useState("");
      const [errText, setErrText] = useState("");
      const info = props.info !== null && typeof props.info === "object" ? props.info : {};
      const inboxCount = Number(info.inboxCount || 0);
      const pendingCount = Number(info.pendingCount || 0);
      const failedCount = Number(info.failedCount || 0);
      const pending = Array.isArray(info.pending) ? info.pending : [];
      const recent = Array.isArray(info.recent) ? info.recent : [];

      function copyPath() {
        const value = String(info.inboxDir || "");
        if (value === "") return;
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard !== undefined) {
            navigator.clipboard.writeText(value)
              .then(() => props.onToast("已复制 inbox 路径")).catch(() => props.onToast(value));
            return;
          }
        } catch { /* 无剪贴板权限时把路径显示出来 */ }
        props.onToast(value);
      }

      function run() {
        setBusy("flush");
        setErrText("");
        khubApiSend("/workbench/ingest/flush", "POST", {})
          .then((res) => {
            setBusy("");
            if (res === null || res === undefined || res.ok !== true) {
              setErrText(String((res && (res.error || res.message)) || "处理失败"));
              return;
            }
            const inbox = res.inbox !== null && typeof res.inbox === "object" ? res.inbox : {};
            const flush = res.pending !== null && typeof res.pending === "object" ? res.pending : {};
            props.onToast("已处理 " + String(Number(inbox.processed || 0)) + " 个批次，补推 " +
              String(Number(flush.flushed || 0)) + " 张表");
            props.onRefresh();
          })
          .catch((error) => { setBusy(""); setErrText(String((error && error.message) || error)); });
      }

      const fmt = (iso) => {
        const text = String(iso || "");
        if (text === "") return "";
        return text.replace("T", " ").replace("Z", "").slice(0, 19);
      };
      /* 同步方式：服务端按主键 / 逐格增量 / 整表覆盖 / 仅本地 */
      const onlineLabel = (value) => {
        const key = String(value || "");
        if (key === "" || key === "none") return "仅本地";
        if (key === "server-upsert") return "在线·按主键";
        if (key === "incremental") return "在线·增量";
        if (key === "matrix") return "在线·整表";
        return "在线·" + key;
      };

      return h("div", {
          className: "dshe-mask",
          onClick: (event) => { if (event.target === event.currentTarget) props.onClose(); }
        },
        h("div", { className: "dshe-lib-dialog dshe-lib-dialog-wide", role: "dialog", "aria-modal": "true" },
          h("div", { className: "dshe-lib-dialog-title" }, "外部数据同步"),
          h("div", { className: "dshe-lib-dialog-fields" },
            h("p", { className: "dshe-set-desc" },
              "定时采集脚本（python / node）或 dsh 自动化任务把批次 JSON 写进下面的 inbox 目录，" +
              "工作台会按主键增量合并到本地数据表，再同步到在线资料库；断网时先落本地，联网后自动补推。"),
            errText !== "" ? h("div", { className: "dshe-lib-error", role: "status" }, errText) : null,
            h("div", { className: "dshe-ingest-path" },
              h("span", { className: "dshe-lib-share-label" }, "inbox"),
              h("code", { className: "dshe-lib-share-url", title: String(info.inboxDir || "") },
                String(info.inboxDir || "（未初始化）")),
              h("button", { type: "button", className: "dshe-btn", onClick: copyPath }, "复制")),
            h("div", { className: "dshe-ingest-stat" },
              h("span", { className: "dshe-lib-share-tag" }, "待处理 " + String(inboxCount)),
              h("span", { className: "dshe-lib-share-tag" }, "待补推 " + String(pendingCount)),
              failedCount > 0
                ? h("span", { className: "dshe-lib-share-tag dshe-lib-share-tag-warn" }, "失败 " + String(failedCount))
                : null,
              h("span", { className: "dshe-lib-share-tag" }, "已处理 " + String(Number(info.appliedCount || 0))),
              h("span", { className: "dshe-lib-direct-spacer" }),
              h("button", {
                type: "button", className: "dshe-btn dshe-btn-primary",
                disabled: busy !== "", onClick: run
              }, busy === "flush" ? "处理中…" : "立即处理")),
            info.dataDir === ""
              ? h("div", { className: "dshe-lib-error", role: "status" },
                  "还没配置工作台数据目录：" + String(info.dataDirError || "") + "（设置 → 个人工作台）")
              : null,
            pending.length > 0
              ? h("div", { className: "dshe-ingest-block" },
                  h("div", { className: "dshe-ingest-block-title" }, "待补推的表"),
                  pending.map((item) => h("div", { key: item.key, className: "dshe-ingest-row" },
                    h("span", { className: "dshe-lib-name" }, String(item.table || "")),
                    h("span", { className: "dshe-lib-share-tag" }, "尝试 " + String(Number(item.attempts || 0))),
                    h("span", { className: "dshe-ingest-err" }, String(item.lastError || "")))))
              : null,
            h("div", { className: "dshe-ingest-block" },
              h("div", { className: "dshe-ingest-block-title" }, "最近处理"),
              recent.length === 0
                ? h("div", { className: "dshe-lib-meta" }, "还没有摄入记录。脚本第一次写入后这里就会显示。")
                : recent.slice(0, 8).map((item, i) => h("div", {
                    key: "rc-" + String(i), className: "dshe-ingest-row"
                  },
                    h("span", { className: "dshe-ingest-time" }, fmt(item.at)),
                    h("span", { className: "dshe-lib-name" }, String(item.batchId || "")),
                    h("span", { className: "dshe-lib-share-tag" }, "新增 " + String(Number(item.added || 0))),
                    h("span", { className: "dshe-lib-share-tag" }, "改 " + String(Number(item.updated || 0))),
                    Number(item.onlineSkipped || item.skipped || 0) > 0
                      ? h("span", { className: "dshe-lib-share-tag dshe-lib-share-tag-warn" },
                          "跳过 " + String(Number(item.onlineSkipped || item.skipped || 0)))
                      : null,
                    h("span", {
                      className: "dshe-lib-share-tag",
                      title: item.fallback === "delta"
                        ? "在线表没有这个主键列，已降级为逐格增量"
                        : onlineLabel(item.online)
                    }, onlineLabel(item.online) + (item.fallback === "delta" ? "（降级）" : "")))))
          ),
          h("div", { className: "dshe-lib-dialog-foot" },
            h("button", { type: "button", className: "dshe-btn", onClick: props.onClose }, "关闭"))
        )
      );
    }

    /** 侧栏「资料库」入口图标。 */
    function LibraryPanelIcon(props) {
      const size = typeof props.size === "number" ? props.size : 18;
      const active = props.active === true;
      return h("span", {
        className: "dshe-panel-icon" + (active ? " dshe-panel-icon-on" : ""),
        "aria-hidden": "true",
        "data-dsh-buddy-expert-hub-library-trigger": "1",
        style: { display: "inline-flex", alignItems: "center", justifyContent: "center" }
      }, h(Icon, { name: "book", size: size }));
    }

    var LIB_CREATE_TYPES = [
      { value: "FOLDER", label: "目录" },
      { value: "MD", label: "Markdown 文档" },
      { value: "CSV", label: "CSV 数据表" },
      { value: "HTML", label: "HTML 页面" }
    ];

    /** 节点类型的中文名，用于列表元信息。 */
    function libTypeText(nodeType) {
      const map = {
        FOLDER: "目录", MD: "Markdown", CSV: "CSV", HTML: "HTML",
        WORD: "Word", EXCEL: "Excel", PPT: "PPT", IMAGE: "图片", FILE: "文件"
      };
      return map[String(nodeType || "").toUpperCase()] || String(nodeType || "文件");
    }

    /** 新建节点的初始正文：给一个能直接用起来的最小骨架。 */
    function libInitialContent(type, name) {
      if (type === "MD") return "# " + String(name || "新建文档").replace(/\.md$/i, "") + "\n\n";
      if (type === "CSV") return "列1,列2,列3\n";
      if (type === "HTML") return "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head><meta charset=\"utf-8\"><title>" +
        String(name || "新建页面") + "</title></head>\n<body>\n  <h1>" + String(name || "新建页面") +
        "</h1>\n</body>\n</html>\n";
      return "";
    }

    /** 节点类型的图标名（用现有 ICON_SHAPES，不新增资源）。 */
    function libTypeIcon(type) {
      const t = String(type || "").toUpperCase();
      if (t === "FOLDER") return "layers";
      if (t === "CSV") return "list";
      if (t === "HTML") return "book";
      if (t === "IMAGE") return "spark";
      return "file";
    }

    /** 节点类型的颜色类后缀（颜色全部在 CSS 里走宿主 token）。 */
    function libTypeClass(type) {
      const t = String(type || "").toUpperCase();
      if (t === "FOLDER") return "folder";
      if (t === "MD") return "md";
      if (t === "CSV") return "csv";
      if (t === "HTML") return "html";
      if (t === "IMAGE") return "image";
      if (t === "WORD" || t === "EXCEL" || t === "PPT") return "office";
      return "file";
    }

    /** 视口尺寸：拿不到 window 时给保守默认值，保证坐标计算不产生 NaN。 */
    function viewSize() {
      const vw = typeof window !== "undefined" && Number(window.innerWidth) > 0 ? Number(window.innerWidth) : 1280;
      const vh = typeof window !== "undefined" && Number(window.innerHeight) > 0 ? Number(window.innerHeight) : 800;
      return { vw: vw, vh: vh };
    }

    /**
     * 下拉菜单的视口坐标：贴在触发按钮右侧弹出；右侧放不下就翻到左侧；
     * 上下按估计高度夹在视口内（菜单本身还有 max-height + 滚动兜底）。
     * @param {any} event React 点击事件，用 currentTarget 的位置定位
     * @param {number} width 菜单宽度（px）
     * @param {number} height 菜单估计高度（px）
     * @returns {{left: number, top: number}} 视口坐标
     */
    function popCoords(event, width, height) {
      const el = event && event.currentTarget ? event.currentTarget : null;
      const rect = el !== null && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      const size = viewSize();
      const w = Number(width) > 0 ? Number(width) : 210;
      const hgt = Number(height) > 0 ? Number(height) : 280;
      let left = rect === null ? 16 : rect.right + 8;
      if (left + w > size.vw - 8) left = rect === null ? 8 : rect.left - w - 8;
      if (left < 8) left = 8;
      let top = rect === null ? 16 : rect.top - 6;
      if (top + hgt > size.vh - 8) top = size.vh - 8 - hgt;
      if (top < 8) top = 8;
      return { left: Math.round(left), top: Math.round(top) };
    }

    /**
     * 光标锚点坐标（右键菜单用）：菜单左上角落在光标右下方 2px；
     * 右边 / 下边放不下就翻到光标另一侧，最后夹进视口。
     * @param {number} x 光标 clientX
     * @param {number} y 光标 clientY
     * @param {number} width 菜单宽度（px）
     * @param {number} height 菜单估计高度（px）
     * @returns {{left: number, top: number}} 视口坐标
     */
    function popCoordsAt(x, y, width, height) {
      const size = viewSize();
      const w = Number(width) > 0 ? Number(width) : 210;
      const hgt = Number(height) > 0 ? Number(height) : 280;
      const px = Number.isFinite(Number(x)) ? Number(x) : 16;
      const py = Number.isFinite(Number(y)) ? Number(y) : 16;
      let left = px + 2;
      let top = py + 2;
      if (left + w > size.vw - 8) left = px - w - 2;
      if (left < 8) left = 8;
      if (top + hgt > size.vh - 8) top = py - hgt - 2;
      if (top < 8) top = 8;
      return { left: Math.round(left), top: Math.round(top) };
    }

    /** 轻量 Markdown 渲染：先转义再按行识别，够看文档；不引第三方依赖。 */
    /**
     * Markdown → HTML（够用的子集），支持知识库内部引用：
     *   ![](kb:28) / ![](./素材/a.png) → 走 /khub/raw 代理，图片能直接显示
     *   [名](kb:23) / [名](素材/a.html) → 渲染成带 data-kb 的链接，点击就地打开
     * @param {string} text Markdown 正文
     * @param {{ assets?: any[] }} [refs] 容器附件清单（含 relPath），用于解析相对路径
     * @returns {string} HTML
     */
    /**
     * 命中测试：光标是不是压在单元格的右缘 / 下缘上。
     * @param {any} event 鼠标事件
     * @returns {{cell: any, kind: string}|null} kind 为 col / row
     */
    function tableHit(event) {
      const target = event === null || event === undefined ? null : event.target;
      const cell = tagUp(target, ["TD", "TH"]);
      if (cell === null || typeof cell.getBoundingClientRect !== "function") return null;
      const rect = cell.getBoundingClientRect();
      const dx = rect.right - Number(event.clientX);
      const dy = rect.bottom - Number(event.clientY);
      if (dx >= 0 && dx <= 6) return { cell: cell, kind: "col" };
      if (dy >= 0 && dy <= 5) return { cell: cell, kind: "row" };
      return null;
    }

    /**
     * 拖动中：列宽改 col 的 px 并同步表格总宽；行高改 tr 的 px。
     * 最小列宽 36px、最小行高 26px，免得拖成一条线之后再也抓不回来。
     * @param {any} st 拖拽状态（onRichMouseDown 里建立）
     * @param {any} event 鼠标事件
     */
    function applyResize(st, event) {
      if (st === null || st === undefined) return;
      if (event !== null && event !== undefined && event.preventDefault) event.preventDefault();
      if (st.kind === "col") {
        if (st.col === undefined || st.col === null) return;
        const w = Math.max(36, Number(st.base) + (Number(event.clientX) - Number(st.start)));
        st.col.style.width = String(Math.round(w)) + "px";
        let total = 0;
        const cols = typeof st.table.querySelectorAll === "function" ? st.table.querySelectorAll("col") : [];
        Array.prototype.forEach.call(cols, (col) => { total += parseFloat(col.style.width) || 0; });
        if (total > 0) st.table.style.width = String(Math.round(total)) + "px";
        return;
      }
      const h = Math.max(26, Number(st.base) + (Number(event.clientY) - Number(st.start)));
      st.row.style.height = String(Math.round(h)) + "px";
    }

    /**
     * 表格 colgroup 里的 col 列表（没建过 colgroup 时是空数组）。
     * @param {any} table 表格元素
     * @returns {any[]} col 元素
     */
    function colGroupCols(table) {
      const out = [];
      if (table === null || table === undefined) return out;
      Array.prototype.forEach.call(table.children === null || table.children === undefined ? [] : table.children, (child) => {
        if (String(child.tagName || "").toUpperCase() !== "COLGROUP") return;
        Array.prototype.forEach.call(child.children === null || child.children === undefined ? [] : child.children, (col) => out.push(col));
      });
      return out;
    }

    /**
     * 按 colgroup 各列宽之和同步表格总宽（增删列之后调用，免得 fixed 布局把宽度重分配）。
     * @param {any} table 表格元素
     * @param {any} doc 所属 document（保留参数位，便于调用处统一传）
     */
    function syncTableWidth(table, doc) {
      if (table === null || table === undefined) return;
      let total = 0;
      colGroupCols(table).forEach((col) => { total += parseFloat(col.style.width) || 0; });
      if (total > 0) table.style.width = String(Math.round(total)) + "px";
    }

    /**
     * 单元格在行里的列序。
     * @param {any} cell 单元格
     * @returns {number} 列下标，找不到行时 0
     */
    function colIndexOf(cell) {
      const row = tagUp(cell, ["TR"]);
      if (row === null) return 0;
      let index = 0;
      Array.prototype.forEach.call(row.children === null || row.children === undefined ? [] : row.children, (child, k) => {
        if (child === cell) index = k;
      });
      return index;
    }

    /**
     * 把表格切成固定布局并回填当前各列宽度（第一次拖的时候视觉不跳）。
     *
     * 100% 宽的表格在 table-layout:fixed 下没法按 px 拖，所以这里先量出每列现状宽度，
     * 写进 colgroup 的 `<col>`，再按总和把 table 宽度定成 px。
     * @param {any} table 表格元素
     * @returns {any[]} colgroup 里的 col 列表
     */
    function ensureColgroup(table) {
      if (table === null || table === undefined) return [];
      const rows = tableRows(table);
      const firstRow = rows.length === 0 ? null : rows[0];
      const cells = firstRow === null || firstRow.children === null || firstRow.children === undefined ? [] : firstRow.children;
      let group = null;
      Array.prototype.forEach.call(table.children === null || table.children === undefined ? [] : table.children, (child) => {
        if (String(child.tagName || "").toUpperCase() === "COLGROUP") group = child;
      });
      if (group === null) {
        const doc = table.ownerDocument;
        group = doc.createElement("colgroup");
        let total = 0;
        Array.prototype.forEach.call(cells, (cell) => {
          const w = typeof cell.getBoundingClientRect === "function" ? Math.round(cell.getBoundingClientRect().width) : 0;
          total += w;
          const col = doc.createElement("col");
          col.style.width = String(w > 0 ? w : 80) + "px";
          group.appendChild(col);
        });
        table.insertBefore(group, table.firstChild);
        table.style.tableLayout = "fixed";
        if (total > 0) table.style.width = String(total) + "px";
        table.setAttribute("data-resized", "1");
      }
      const cols = [];
      Array.prototype.forEach.call(group.children === null || group.children === undefined ? [] : group.children, (col) => cols.push(col));
      return cols;
    }

    /* ---------------- Markdown 表格：解析 ---------------- */

    /** 一行表格：`| a | b |`。 */
    const MD_TABLE_LINE = /^\s*\|.*\|\s*$/;

    /**
     * 是否表格分隔行（`| --- |:--:|`）。必须同时含 `-` 与 `|`，且只由 `| - : 空格` 组成。
     * @param {string} text 行文本
     * @returns {boolean} 是分隔行
     */
    function mdTableSep(text) {
      const s = String(text === null || text === undefined ? "" : text).trim();
      if (s === "" || s.indexOf("-") < 0 || s.indexOf("|") < 0) return false;
      return /^[\s|:-]+$/.test(s);
    }

    /**
     * 拆一行表格单元格；`\|` 视为单元格内部的竖线（htmlToMarkdown 写出来就是这样）。
     * @param {string} text 行文本
     * @returns {string[]} 单元格文本
     */
    function mdSplitRow(text) {
      const s = String(text === null || text === undefined ? "" : text).trim()
        .replace(/^\|/, "").replace(/\|$/, "");
      const cells = [];
      let cur = "";
      for (let i = 0; i < s.length; i += 1) {
        const ch = s.charAt(i);
        if (ch === "\\" && s.charAt(i + 1) === "|") { cur += "|"; i += 1; continue; }
        if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
        cur += ch;
      }
      cells.push(cur.trim());
      return cells;
    }

    /**
     * 分隔行的对齐：`:--:` 居中、`--:` 右、`:--` 左。
     * @param {string} text 分隔单元格
     * @returns {string} left / center / right / 空串
     */
    function mdAlignOf(text) {
      const s = String(text === null || text === undefined ? "" : text).trim();
      const left = s.charAt(0) === ":";
      const right = s.charAt(s.length - 1) === ":";
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "";
    }

    /**
     * 表格 → HTML。空单元格塞 `<br>`：contenteditable 里空 td 会塌成 0 高、点不进去。
     *
     * `meta` 是从 Markdown 里那行 `<!--khub-table:…-->` 注释还原出来的列宽 / 行高：
     * Markdown 表格语法本身没有宽高概念，所以拖拽结果靠这行注释持久化。
     * @param {string[]} head 表头单元格
     * @param {string[]} aligns 每列对齐
     * @param {string[][]} rows 表体
     * @param {Function} inline 行内渲染函数
     * @param {{cols?: number[], rows?: number[]}} [meta] 列宽 / 行高（px）
     * @returns {string} table HTML
     */
    function mdTableHtml(head, aligns, rows, inline, meta) {
      const alignAttr = (index) => {
        const a = aligns[index];
        return a === undefined || a === "" ? "" : ' style="text-align:' + a + '"';
      };
      const cellHtml = (text, index, tag) => {
        const body = inline(String(text === undefined ? "" : text));
        return "<" + tag + alignAttr(index) + ">" + (body === "" ? "<br>" : body) + "</" + tag + ">";
      };
      const colW = meta !== null && meta !== undefined && Array.isArray(meta.cols) ? meta.cols : [];
      const rowH = meta !== null && meta !== undefined && Array.isArray(meta.rows) ? meta.rows : [];
      const usable = colW.map((w) => Number(w)).filter((w) => Number.isFinite(w) && w > 0);
      const total = usable.reduce((n, w) => n + w, 0);
      const tableAttr = usable.length === 0
        ? ""
        : " data-resized=\"1\" style='table-layout:fixed;width:" + String(Math.round(total)) + "px'";
      const colgroup = usable.length === 0
        ? ""
        : "<colgroup>" + usable.map((w) => "<col style='width:" + String(Math.round(w)) + "px'>").join("") + "</colgroup>";
      const heightOf = (index) => {
        const h = Number(rowH[index]);
        return Number.isFinite(h) && h > 0 ? " style='height:" + String(Math.round(h)) + "px'" : "";
      };
      const headHtml = "<thead><tr" + heightOf(0) + ">" + head.map((c, k) => cellHtml(c, k, "th")).join("") + "</tr></thead>";
      const bodyHtml = rows.map((row, ri) => "<tr" + heightOf(ri + 1) + ">" +
        head.map((c, k) => cellHtml(row[k], k, "td")).join("") + "</tr>").join("");
      const open = "<table" + tableAttr + ">" + colgroup + headHtml;
      if (rows.length === 0) return open + "</table>";
      return open + "<tbody>" + bodyHtml + "</tbody></table>";
    }

    /**
     * 从表格 DOM 里读出列宽 / 行高，序列化成注释用的对象。
     * 只有真的拖过的表格（有 colgroup 宽度或 tr 高度）才返回，避免给普通表格加噪音。
     * @param {any} table 表格元素
     * @returns {{cols: number[], rows: number[]}|null} 没有显式宽高时返回 null
     */
    function tableMetaOf(table) {
      if (table === null || table === undefined) return null;
      const cols = [];
      const rows = [];
      const px = (text) => {
        const m = /^\s*(-?\d+(?:\.\d+)?)\s*px\s*$/i.exec(String(text === null || text === undefined ? "" : text));
        return m === null ? 0 : Math.round(Number(m[1]));
      };
      Array.prototype.forEach.call(table.children === null || table.children === undefined ? [] : table.children, (child) => {
        if (String(child.tagName || "").toUpperCase() !== "COLGROUP") return;
        Array.prototype.forEach.call(child.children === null || child.children === undefined ? [] : child.children, (col) => {
          cols.push(px(col.style === undefined || col.style === null ? "" : col.style.width));
        });
      });
      tableRows(table).forEach((tr) => {
        rows.push(px(tr.style === undefined || tr.style === null ? "" : tr.style.height));
      });
      const hasCols = cols.some((w) => w > 0);
      const hasRows = rows.some((h) => h > 0);
      if (hasCols === false && hasRows === false) return null;
      return {
        cols: hasCols ? cols.map((w) => (w > 0 ? w : 80)) : [],
        rows: hasRows ? rows.map((h) => (h > 0 ? h : 32)) : [],
      };
    }

    /* ---------------- 富文本表格：加行 / 删行 / 加列 / 删列 ---------------- */

    /**
     * 向上找最近的指定标签（不用 closest：宿主/测试环境不一定有这个方法）。
     * @param {any} node 起点
     * @param {string[]} names 大写标签名数组
     * @returns {any} 命中的元素，找不到为 null
     */
    function tagUp(node, names) {
      let cur = node === null || node === undefined ? null : node;
      while (cur !== null && cur !== undefined && cur.nodeType !== 9) {
        const tag = String(cur.tagName || "").toUpperCase();
        if (names.indexOf(tag) >= 0) return cur;
        cur = cur.parentNode;
      }
      return null;
    }

    /**
     * 表格里的所有 tr（thead / tbody 都要）。
     * @param {any} table 表格元素
     * @returns {any[]} tr 列表
     */
    function tableRows(table) {
      const out = [];
      const walk = (node) => {
        const kids = node === null || node === undefined || node.children === null || node.children === undefined
          ? [] : node.children;
        Array.prototype.forEach.call(kids, (child) => {
          if (String(child.tagName || "").toUpperCase() === "TR") out.push(child);
          else walk(child);
        });
      };
      walk(table);
      return out;
    }

    /**
     * 表格行列增删（纯 DOM 操作，不依赖 React，便于单独回归）。
     *
     * 约定：加行插在光标所在行**之后**（光标在表头时插到表体第一行）；
     * 加列插在光标所在列**右侧**；只剩一行/一列时删除即整表删除，不留空表。
     * @param {any} table 目标表格
     * @param {any} cell 光标所在单元格（td / th）
     * @param {string} kind rowAdd / rowDel / colAdd / colDel / tableDel
     * @returns {{ok: boolean, message: string}} 失败时 message 是给用户看的原因
     */
    function tableOpOf(table, cell, kind) {
      const doc = table === null || table === undefined ? null : table.ownerDocument;
      if (table === null || table === undefined || cell === null || cell === undefined || doc === null || doc === undefined) {
        return { ok: false, message: "请先把光标放到表格里" };
      }
      const row = tagUp(cell, ["TR"]);
      if (row === null) return { ok: false, message: "请先把光标放到表格里" };
      const cellsOfRow = row.children === null || row.children === undefined ? [] : row.children;
      let index = -1;
      Array.prototype.forEach.call(cellsOfRow, (child, k) => { if (child === cell) index = k; });
      if (index < 0) index = 0;
      const cols = cellsOfRow.length < 1 ? 1 : cellsOfRow.length;
      const makeCell = (tag) => {
        const node = doc.createElement(tag);
        node.innerHTML = "<br>";
        return node;
      };
      const dropTable = () => {
        if (table.parentNode === null || table.parentNode === undefined) return { ok: false, message: "删除表格失败" };
        table.parentNode.removeChild(table);
        return { ok: true, message: "已删除表格" };
      };
      const parentTag = String(row.parentNode === null || row.parentNode === undefined ? "" : row.parentNode.tagName || "").toUpperCase();

      if (kind === "tableDel") return dropTable();

      if (kind === "rowAdd") {
        const inHead = parentTag === "THEAD";
        const tr = doc.createElement("tr");
        /* 新增的始终是表体行（td）：表头只保留原来那一行，光标在表头时新行落到表体第一行 */
        for (let k = 0; k < cols; k += 1) tr.appendChild(makeCell("td"));
        if (inHead) {
          let tbody = null;
          Array.prototype.forEach.call(table.children === null || table.children === undefined ? [] : table.children, (child) => {
            if (String(child.tagName || "").toUpperCase() === "TBODY") tbody = child;
          });
          if (tbody === null) table.appendChild(tr);
          else tbody.insertBefore(tr, tbody.firstChild);
        } else {
          row.parentNode.insertBefore(tr, row.nextSibling);
        }
        return { ok: true, message: "已新增一行" };
      }

      if (kind === "rowDel") {
        if (tableRows(table).length <= 1) return dropTable();
        row.parentNode.removeChild(row);
        return { ok: true, message: "已删除一行" };
      }

      if (kind === "colAdd") {
        tableRows(table).forEach((tr) => {
          const ref = tr.children === null || tr.children === undefined ? undefined : tr.children[index];
          const tag = ref !== undefined && String(ref.tagName || "").toUpperCase() === "TH" ? "th" : "td";
          const node = makeCell(tag);
          if (ref === undefined) tr.appendChild(node);
          else tr.insertBefore(node, ref.nextSibling);
        });
        /* 拖过列宽的表格有 colgroup，列数必须跟着改，否则固定布局会把宽度分错 */
        const grip = colGroupCols(table);
        if (grip.length > 0) {
          const ref = grip[index];
          const col = doc.createElement("col");
          col.style.width = ref === undefined || ref.style.width === "" ? "100px" : String(ref.style.width);
          if (ref === undefined) grip[grip.length - 1].parentNode.appendChild(col);
          else ref.parentNode.insertBefore(col, ref.nextSibling);
          syncTableWidth(table, doc);
        }
        return { ok: true, message: "已新增一列" };
      }

      if (kind === "colDel") {
        if (cols <= 1) return dropTable();
        tableRows(table).forEach((tr) => {
          const ref = tr.children === null || tr.children === undefined ? undefined : tr.children[index];
          if (ref !== undefined) tr.removeChild(ref);
        });
        const grip = colGroupCols(table);
        if (grip.length > 1 && grip[index] !== undefined) {
          grip[index].parentNode.removeChild(grip[index]);
          syncTableWidth(table, doc);
        }
        return { ok: true, message: "已删除一列" };
      }

      return { ok: false, message: "未知的表格操作" };
    }

    function markdownToHtml(text, refs) {
      const escape = (raw) => String(raw)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      /* 属性值里只需再挡一次双引号：正文已整体转义过一遍，重复转义会把 & 变成 &amp;amp; */
      const attr = (raw) => String(raw).replace(/"/g, "&quot;");
      const assets = refs !== null && refs !== undefined && Array.isArray(refs.assets) ? refs.assets : [];

      /** 解析一个引用目标；返回 null 表示解析不出来（保持原样，不制造破图）。 */
      function resolveRef(target) {
        const raw = String(target === null || target === undefined ? "" : target).trim();
        if (raw === "") return null;
        if (/^https?:\/\//i.test(raw)) return { url: raw, external: true };
        if (/^data:/i.test(raw)) return { url: raw, external: true };
        const kb = /^kb:(\d+)$/i.exec(raw);
        if (kb !== null) {
          const id = Number(kb[1]);
          const hit = assets.find((it) => Number(it.id) === id);
          return { id: id, asset: hit === undefined ? null : hit };
        }
        const clean = raw.replace(/^\.\//, "").replace(/^\/+/, "").toLowerCase();
        const baseName = clean.split("/").pop();
        let hit = assets.find((it) => String(it.relPath || "").toLowerCase() === clean);
        if (hit === undefined) hit = assets.find((it) => String(it.name || "").toLowerCase() === baseName);
        if (hit === undefined) return null;
        return { id: Number(hit.id), asset: hit };
      }

      function imageHtml(alt, src) {
        const hit = resolveRef(src);
        /* 解析不出来的相对路径不要去请求插件源（必然 404 破图），给一行占位文字 */
        if (hit === null) return '<span class="dshe-lib-md-miss">图片未找到：' + escape(src) + '</span>';
        if (hit.url !== undefined) return '<img class="dshe-lib-md-img" alt="' + attr(alt) + '" src="' + attr(hit.url) + '">';
        const type = hit.asset === null ? "" : String(hit.asset.nodeType || "").toUpperCase();
        if (type !== "" && type !== "IMAGE") {
          /* 引用了非图片节点：给一行可点的文字，而不是一个破图 */
          return '<a href="#" data-kb="' + String(hit.id) + '" class="dshe-lib-md-link">' +
            escape(alt !== "" ? alt : (hit.asset === null ? src : String(hit.asset.name || src))) + "</a>";
        }
        return '<img class="dshe-lib-md-img" alt="' + attr(alt) + '" src="' + API + "/khub/raw?id=" + String(hit.id) + '">';
      }

      function linkHtml(label, target) {
        const hit = resolveRef(target);
        if (hit === null) return escape(label);
        if (hit.url !== undefined) {
          return '<a href="' + attr(hit.url) + '" target="_blank" rel="noreferrer noopener">' + label + "</a>";
        }
        return '<a href="#" data-kb="' + String(hit.id) + '" class="dshe-lib-md-link">' + label + "</a>";
      }

      /* 行内代码要先抽出来，否则其中的 ![](...) / [x](y) 会被后面的图片与链接规则吃掉 */
      const inline = (raw) => {
        const codes = [];
        const guarded = escape(raw).replace(/`([^`]+)`/g, (m, code) => {
          codes.push(code);
          return "\u0000" + String(codes.length - 1) + "\u0000";
        });
        const html = guarded
        .replace(/~~([^~]+)~~/g, "<del>$1</del>")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
        /* 图片先于链接处理，否则 ![x](y) 会被链接规则截走 */
        .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => imageHtml(alt, src))
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
        /* 双链 [[文件名]]：按文件名匹配附件，渲染成可点链接 */
        .replace(/\[\[([^\]]+)\]\]/g, (m, name) => {
          const hit = resolveRef(name);
          if (hit === null) return "[[" + name + "]]";
          if (hit.url !== undefined) return '<a href="' + attr(hit.url) + '" target="_blank" rel="noreferrer noopener">' + name + "</a>";
          return '<a href="#" data-kb="' + String(hit.id) + '" class="dshe-lib-md-link">' + name + "</a>";
        })
        .replace(/\[([^\]]+)\]\((?!https?:\/\/)([^)]+)\)/g, (m, label, target) => linkHtml(label, target));
        return html.replace(/ (\d+) /g, (m, index) => "<code>" + String(codes[Number(index)] || "") + "</code>");
      };
      const lines = String(text === null || text === undefined ? "" : text).split("\n");
      const out = [];
      let inCode = false;
      let inList = false;
      let inOrdered = false;
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        if (/^```/.test(line)) {
          if (inCode) { out.push("</code></pre>"); inCode = false; } else { out.push("<pre><code>"); inCode = true; }
          continue;
        }
        if (inCode) { out.push(escape(line)); continue; }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading !== null) {
          const level = heading[1].length;
          out.push("<h" + String(level) + ">" + inline(heading[2]) + "</h" + String(level) + ">");
          continue;
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
        if (bullet !== null || ordered !== null) {
          const wantOrdered = ordered !== null;
          if (inList === false || inOrdered !== wantOrdered) {
            if (inList === true) out.push(inOrdered ? "</ol>" : "</ul>");
            out.push(wantOrdered ? "<ol>" : "<ul>");
            inList = true;
            inOrdered = wantOrdered;
          }
          out.push("<li>" + inline((bullet !== null ? bullet : ordered)[1]) + "</li>");
          continue;
        }
        if (inList === true) { out.push(inOrdered ? "</ol>" : "</ul>"); inList = false; }
        if (/^\s*$/.test(line)) { out.push(""); continue; }
        /* Markdown 表格：表头行 + 分隔行才开始，后面连续的 | 行合并进同一张表。
           没有这条，编辑器里插入的表格保存后重开会变成一堆竖线文本，自然也就没法再加行加列。 */
        if (MD_TABLE_LINE.test(line) && lineIndex + 1 < lines.length && mdTableSep(lines[lineIndex + 1])) {
          const head = mdSplitRow(line);
          const aligns = mdSplitRow(lines[lineIndex + 1]).map(mdAlignOf);
          const body = [];
          let next = lineIndex + 2;
          while (next < lines.length && MD_TABLE_LINE.test(lines[next])) {
            body.push(mdSplitRow(lines[next]));
            next += 1;
          }
          /* 紧跟表格的那行 `<!--khub-table:{...}-->` 是列宽 / 行高（拖拽结果），渲染器看不见 */
          let tableMeta = null;
          if (next < lines.length) {
            const metaHit = /^<!--khub-table:(.*?)-->$/.exec(String(lines[next]).trim());
            if (metaHit !== null) {
              try { tableMeta = JSON.parse(metaHit[1]); } catch { tableMeta = null; }
              if (tableMeta !== null) next += 1;
            }
          }
          out.push(mdTableHtml(head, aligns, body, inline, tableMeta));
          lineIndex = next - 1;
          continue;
        }
        if (/^>\s?/.test(line)) { out.push("<blockquote>" + inline(line.replace(/^>\s?/, "")) + "</blockquote>"); continue; }
        if (/^---+$/.test(line)) { out.push("<hr>"); continue; }
        out.push("<p>" + inline(line) + "</p>");
      }
      if (inList === true) out.push(inOrdered ? "</ol>" : "</ul>");
      if (inCode === true) out.push("</code></pre>");
      return out.join("\n");
    }

    /**
     * 富文本 → Markdown：把 contenteditable 的 DOM 序列化回 Markdown 源码。
     * 只覆盖编辑器工具栏能产出的标签，未知标签按纯文本处理，保证不丢内容。
     * @param {any} root 编辑区根元素
     * @returns {string} Markdown 文本
     */
    function htmlToMarkdown(root) {
      if (root === null || root === undefined) return "";
      const blocks = [];
      function inlineOf(node) {
        let out = "";
        const kids = node.childNodes === undefined || node.childNodes === null ? [] : node.childNodes;
        Array.prototype.forEach.call(kids, (child) => {
          if (child.nodeType === 3) { out += String(child.nodeValue || ""); return; }
          if (child.nodeType !== 1) return;
          const tag = String(child.tagName || "").toLowerCase();
          const inner = inlineOf(child);
          if (tag === "strong" || tag === "b") out += "**" + inner + "**";
          else if (tag === "em" || tag === "i") out += "*" + inner + "*";
          else if (tag === "del" || tag === "s" || tag === "strike") out += "~~" + inner + "~~";
          else if (tag === "code") out += "`" + inner + "`";
          else if (tag === "a") {
            const kb = child.getAttribute("data-kb");
            const href = kb !== null && kb !== "" ? "kb:" + kb : String(child.getAttribute("href") || "");
            out += "[" + inner + "](" + href + ")";
          } else if (tag === "img") {
            const kb = child.getAttribute("data-kb");
            const src = kb !== null && kb !== "" ? "kb:" + kb : String(child.getAttribute("src") || "");
            out += "![" + String(child.getAttribute("alt") || "") + "](" + src + ")";
          }
          else if (tag === "br") out += "\n";
          else out += inner;
        });
        return out;
      }
      function blockOf(node) {
        const tag = String(node.tagName || "").toLowerCase();
        if (/^h[1-6]$/.test(tag)) { blocks.push(new Array(Number(tag[1]) + 1).join("#") + " " + inlineOf(node).trim()); return; }
        if (tag === "p") { blocks.push(inlineOf(node).trim()); return; }
        if (tag === "blockquote") {
          blocks.push(inlineOf(node).split("\n").map((line) => "> " + line).join("\n"));
          return;
        }
        if (tag === "pre") { blocks.push("```\n" + String(node.textContent || "").replace(/\n$/, "") + "\n```"); return; }
        if (tag === "ul" || tag === "ol") {
          const items = [];
          Array.prototype.forEach.call(node.children, (li, index) => {
            items.push((tag === "ol" ? String(index + 1) + ". " : "- ") + inlineOf(li).trim());
          });
          blocks.push(items.join("\n"));
          return;
        }
        if (tag === "hr") { blocks.push("---"); return; }
        if (tag === "table") {
          const rows = [];
          Array.prototype.forEach.call(node.querySelectorAll === undefined ? [] : node.querySelectorAll("tr"), (tr) => {
            const cells = [];
            Array.prototype.forEach.call(tr.children, (cell) => {
              cells.push(String(inlineOf(cell) || "").replace(/\|/g, "\\|").trim());
            });
            if (cells.length > 0) rows.push(cells);
          });
          if (rows.length === 0) return;
          const width = rows.reduce((n, row) => Math.max(n, row.length), 0);
          const line = (row) => {
            const filled = row.slice();
            while (filled.length < width) filled.push("");
            return "| " + filled.join(" | ") + " |";
          };
          const out = [line(rows[0]), "|" + new Array(width).fill(" --- ").join("|") + "|"];
          for (let i = 1; i < rows.length; i += 1) out.push(line(rows[i]));
          /* 列宽 / 行高在 Markdown 表格语法里没有位置，用一行 HTML 注释紧跟在表格后面带上
             （渲染器看不见）。必须贴着表格写、不能靠块间空行，否则解析时找不到它。
             没拖过的表格不写，避免给普通表格加噪音。 */
          const meta = tableMetaOf(node);
          const metaLine = meta === null ? "" : "\n" + "<!--khub-table:" + JSON.stringify(meta) + "-->";
          blocks.push(out.join("\n") + metaLine);
          return;
        }
        const elementKids = node.children === undefined || node.children === null ? [] : node.children;
        if (elementKids.length > 0) {
          Array.prototype.forEach.call(elementKids, (child) => {
            if (child.nodeType === 1) blockOf(child);
          });
          const rest = inlineOf(node).trim();
          if (rest !== "") blocks.push(rest);
          return;
        }
        blocks.push(inlineOf(node).trim());
      }
      Array.prototype.forEach.call(root.childNodes === undefined || root.childNodes === null ? [] : root.childNodes, (node) => {
        if (node.nodeType === 3) {
          const text = String(node.nodeValue || "").trim();
          if (text !== "") blocks.push(text);
          return;
        }
        if (node.nodeType === 1) blockOf(node);
      });
      return blocks.filter((block) => block !== "").join("\n\n") + "\n";
    }

    /**
     * 在线资料库主面板：左侧空间树 + 右侧列表 / 编辑器 / 收藏 / 共享。
     *
     * 功能对齐在线资料库的文档区：树形浏览、新建、重命名、移动、删除、收藏（含分组）、
     * 分享（只读/可写、有效期、密码、HTML 直链）、版本历史与回滚、站内搜索、最近访问。
     * 不发散到空间/成员/权限管理等后台功能。
     *
     * @returns {any} React 元素
     */
    function LibraryPanel() {
      const [toast, setToast] = useState(null);
      const [ready, setReady] = useState(false);
      /* 左栏宽度 / 是否收起：都可拖拽 + 可隐藏，选择记在本地，重启保持 */
      const [libSideWidth, setLibSideWidth] = useState(() => readWidthPref(LIB_SIDE_WIDTH_KEY, LIB_SIDE_WIDTH_MIN, LIB_SIDE_WIDTH_MAX, LIB_SIDE_WIDTH_DEFAULT));
      const [libSideCollapsed, setLibSideCollapsed] = useState(() => readBoolPref(LIB_SIDE_COLLAPSED_KEY, false));
      const [baseUrl, setBaseUrl] = useState("");
      const [spaces, setSpaces] = useState([]);
      const [trees, setTrees] = useState({});
      const [expanded, setExpanded] = useState({});
      const [spaceId, setSpaceId] = useState(0);
      const [spaceName, setSpaceName] = useState("");
      const [selId, setSelId] = useState(0);
      /* 树里高亮用的节点 id：目录和文件都算，仅影响视觉，不参与「新建到哪个目录」 */
      const [pickedId, setPickedId] = useState(0);
      const [selName, setSelName] = useState("全部内容");
      const [view, setView] = useState("list");
      const [loading, setLoading] = useState(false);
      const [errorText, setErrorText] = useState("");
      const [keyword, setKeyword] = useState("");
      const [items, setItems] = useState([]);
      const [listTitle, setListTitle] = useState("");
      const [editing, setEditing] = useState(null);
      const [editorMode, setEditorMode] = useState("rich");
      const [busy, setBusy] = useState(false);
      const [hoverId, setHoverId] = useState(0);
      const [menuNode, setMenuNode] = useState(null);
      /* 下拉菜单的视口坐标：贴触发按钮弹出（不做居中弹窗），null 表示未打开 */
      const [menuAt, setMenuAt] = useState(null);
      const [newMenuAt, setNewMenuAt] = useState(null);
      /* 从菜单发起「重命名 / 删除」时的操作目标：菜单关掉了也要记住是谁 */
      const [opNode, setOpNode] = useState(null);
      const [dialog, setDialog] = useState("");
      const [createName, setCreateName] = useState("");
      const [createType, setCreateType] = useState("MD");
      const [renameValue, setRenameValue] = useState("");
      const [favGroups, setFavGroups] = useState([]);
      const [favGroupId, setFavGroupId] = useState(0);
      const [favIds, setFavIds] = useState({});
      const [shareTab, setShareTab] = useState("out");
      const [shareNode, setShareNode] = useState(null);
      const [shareList, setShareList] = useState([]);
      const [sharePerm, setSharePerm] = useState("VIEW");
      const [shareExpire, setShareExpire] = useState("");
      const [sharePwd, setSharePwd] = useState("");
      const [versionNode, setVersionNode] = useState(null);
      const [versionList, setVersionList] = useState([]);
      const [versionPreview, setVersionPreview] = useState(null);
      const [moveNode, setMoveNode] = useState(null);
      const [moveTargetId, setMoveTargetId] = useState(0);
      const [htmlKey, setHtmlKey] = useState(0);
      /* Office 内置编辑：解析后的模型（doc 段落 / sheet 矩阵 / pptx 只读页文本） */
      const [officeModel, setOfficeModel] = useState(null);
      const [officeLoading, setOfficeLoading] = useState(false);
      const [officeSheet, setOfficeSheet] = useState(0);
      const htmlFrameRef = useRef(null);
      const editorRef = useRef(null);
      /* 表格拖拽的临时状态：不放进 state，拖动过程每帧都变、不需要重渲染 */
      const resizeRef = useRef(null);
      const editingRef = useRef(null);
      /* 版式级预览 / 编辑（OnlyOffice iframe）：mode 决定 frame 的 view|edit；
         canWrite / nodeVersion 只来自 frame 的 dshe:office:ready，面板不自行推断权限，
         也不接触 token。错误文案单独存；打开序号作废过期的在途探测。 */
      const [officeFrameMode, setOfficeFrameMode] = useState("view");
      const [officeCanWrite, setOfficeCanWrite] = useState(false);
      const [officeNodeVersion, setOfficeNodeVersion] = useState(null);
      const [officeFrameError, setOfficeFrameError] = useState("");
      const officeFrameRef = useRef(null);
      const officeProbeTokenRef = useRef(0);

      useEffect(() => { editingRef.current = editing; }, [editing]);

      /** 取 HTML 预览 iframe 的 contentWindow；父窗口桥与快照采集共用同一个取法。 */
      function libFrameWindow() {
        const frame = htmlFrameRef.current;
        let win = frame === null || frame === undefined ? null : frame.contentWindow;
        /* ref 可能还没挂到真实 iframe（或指向一个没有 contentWindow 的桩），
           这时按类名兜底找一遍，否则请求会被静默丢弃、页面又变成「加载中」。 */
        if (win === null || win === undefined) {
          try {
            const alt = document.querySelector(".dshe-lib-frame");
            win = alt === null || alt === undefined ? null : alt.contentWindow;
          } catch { win = null; }
        }
        return win === null || win === undefined ? null : win;
      }
      const requestSnapshot = () => snapshotRequest(libFrameWindow);

      /**
       * 资料库 HTML 预览的父窗口桥。
       *
       * /khub/html 注入了 BRIDGE_SOURCE + window.KB 适配器，页面里的 KB.getCsv /
       * updateCell 最终都要 postMessage 回父窗口。但资料库面板以前**没有**这个监听器
       * （只有工作台面板有），于是请求永远等不到回信，页面一直停在「加载中」。
       * 服务端内联的 seed 能让首屏零请求渲染，这里的监听器负责刷新与写回。
       */
      useEffect(() => {
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        const handler = (event) => {
          const data = event === null || event === undefined ? null : event.data;
          if (data === null || data === undefined) return;
          if (handleSnapshotResult(data) === true) return;
          if (data.magic !== WB_BRIDGE_MAGIC) return;
          if (data.kind !== "ready" && data.kind !== "read" && data.kind !== "write") return;
          const win = libFrameWindow();
          if (win === null) return;
          /* 不严格校验 event.source：Electron 的 sandbox iframe 上 source 经常取不到或
             不是 contentWindow，严格比较会把真实请求全丢掉。magic + kind 白名单 +
             requestId 回显已经足够识别，写操作也只影响当前资料库节点。 */
          const reply = (ok, payload) => {
            try {
              win.postMessage({
                magic: WB_BRIDGE_MAGIC, kind: "response",
                requestId: data.requestId, ok: ok === true, payload: payload || {}
              }, "*");
            } catch { /* iframe 已卸载，丢弃这次回信 */ }
          };
          if (data.kind === "ready") { reply(true, { ok: true }); return; }
          const payload = data.payload !== null && typeof data.payload === "object" ? data.payload : {};
          const hit = /^node-(\d+)\.csv$/i.exec(String(payload.table || ""));
          const nodeId = hit === null ? 0 : Number(hit[1]);
          if (nodeId <= 0) { reply(false, { error: "无法识别的数据表：" + String(payload.table || "") }); return; }
          const errOf = (res, error) => String((error && (error.message || error.error)) ||
            (res && (res.error || res.message)) || "资料库请求失败");

          if (data.kind === "read") {
            khubGet("/khub/csv?id=" + encodeURIComponent(String(nodeId)))
              .then((res) => {
                if (res === null || res === undefined || res.ok !== true) { reply(false, { error: errOf(res, null) }); return; }
                const csv = res.csv !== null && typeof res.csv === "object" ? res.csv : {};
                const matrix = Array.isArray(csv.matrix) ? csv.matrix : [];
                const columns = (matrix[0] || []).map((cell) => String(cell === null || cell === undefined ? "" : cell));
                const rows = matrix.slice(1).map((line) => {
                  const obj = {};
                  columns.forEach((name, i) => {
                    const cell = Array.isArray(line) ? line[i] : undefined;
                    obj[name] = String(cell === null || cell === undefined ? "" : cell);
                  });
                  return obj;
                });
                reply(true, {
                  table: payload.table, columns: columns, rows: rows,
                  hash: "v" + String(Number(csv.version || 0))
                });
              })
              .catch((error) => reply(false, { error: errOf(null, error) }));
            return;
          }

          const columns = Array.isArray(payload.columns) ? payload.columns.map((c) => String(c)) : [];
          const srcRows = Array.isArray(payload.rows) ? payload.rows : [];
          const matrix = [columns].concat(srcRows.map((row) => columns.map((name) => {
            const cell = row !== null && typeof row === "object" ? row[name] : undefined;
            return String(cell === null || cell === undefined ? "" : cell);
          })));
          const base = /^v(\d+)$/.exec(String(payload.baseHash || ""));
          khubSend("/khub/csv", "PUT", {
            id: nodeId, matrix: matrix, baseVersion: base === null ? null : Number(base[1])
          })
            .then((res) => {
              if (res === null || res === undefined || res.ok !== true) { reply(false, { error: errOf(res, null) }); return; }
              reply(true, { table: payload.table, hash: "v" + String(Number(res.version || 0)) });
            })
            .catch((error) => reply(false, { error: errOf(null, error) }));
        };
        window.addEventListener("message", handler);
        return () => {
          if (typeof window.removeEventListener === "function") window.removeEventListener("message", handler);
        };
      }, []);

      /* Office 版式预览 / 编辑 iframe 的 postMessage 通道。
         只在 office-frame 模式挂监听；切走（mode 变化 / 关闭编辑）由 cleanup 摘除，避免泄漏。
         安全加固：只接受同源消息，且 event.source 必须是当前 iframe 的 contentWindow，
         挡住同页其它 iframe 与 OnlyOffice 内部那一层 frame 伪造的控制消息。 */
      useEffect(() => {
        if (editing === null || editing.mode !== "office-frame") return undefined;
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        const nodeId = Number(editing.id);
        const hostOrigin = typeof window.location !== "undefined" ? String(window.location.origin || "") : "";
        const kinds = ["dshe:office:ready", "dshe:office:saved", "dshe:office:close", "dshe:office:error", "dshe:office:fallback"];
        const handler = (event) => {
          if (event === null || event === undefined) return;
          if (hostOrigin !== "" && String(event.origin || "") !== hostOrigin) return;
          const frame = officeFrameRef.current;
          const frameWin = frame === null || frame === undefined ? null : frame.contentWindow;
          if (frameWin === null || frameWin === undefined || event.source !== frameWin) return;
          const data = event.data;
          if (data === null || typeof data !== "object") return;
          const kind = String(data.type || "");
          if (kinds.indexOf(kind) < 0) return;
          if (data.id !== undefined && data.id !== null && Number(data.id) > 0 && Number(data.id) !== nodeId) return;
          if (kind === "dshe:office:ready") {
            setOfficeCanWrite(data.canWrite === true);
            setOfficeNodeVersion(data.nodeVersion === undefined ? null : data.nodeVersion);
            setOfficeFrameError("");
            return;
          }
          if (kind === "dshe:office:saved") {
            setOfficeNodeVersion(data.nodeVersion === undefined ? null : data.nodeVersion);
            loadTree(spaceId).then(() => setToast("已保存为在线新版本"));
            return;
          }
          if (kind === "dshe:office:close") {
            if (data.dirty === true && typeof window.confirm === "function") {
              if (window.confirm("文档可能仍在保存，确定关闭？") === false) return;
            }
            backToList();
            return;
          }
          if (kind === "dshe:office:error") {
            const message = String(data.message || "版式预览加载失败，可切回轻量视图");
            /* /api/office/status 是公开端点，PAT 过期时探测仍会返回 true；
               这类认证 / 权限错误直接静默回退，不让用户卡在错误卡片上。 */
            if (/401|403|登录|未登录|没有编辑权限/.test(message)) {
              switchOfficeToLight(nodeId);
              return;
            }
            setOfficeFrameError(message);
            return;
          }
          /* fallback：编辑态的「切回预览」回 view；其余（含旧版无 target）回轻量视图。 */
          if (data.target === "preview" && officeFrameMode === "edit") {
            setOfficeFrameError("");
            setOfficeCanWrite(false);
            setOfficeFrameMode("view");
            return;
          }
          switchOfficeToLight(nodeId);
        };
        window.addEventListener("message", handler);
        return () => {
          if (typeof window.removeEventListener === "function") window.removeEventListener("message", handler);
        };
      }, [editing === null ? "" : editing.mode, editing === null ? 0 : editing.id, officeFrameMode, spaceId]);

      /* 视图离开编辑器时作废在途的 Office 能力探测（收藏 / 共享 / 最近 / 搜索等虚拟视图同样覆盖），
         避免迟到的探测结果把用户已经切走的页面重新拉回版式预览。 */
      useEffect(() => {
        if (view !== "edit") officeProbeTokenRef.current += 1;
      }, [view]);

      useEffect(() => {
        if (toast === null) return undefined;
        const timer = setTimeout(() => setToast(null), 3200);
        return () => clearTimeout(timer);
      }, [toast]);

      function khubGet(path) { return fetchJson(path); }
      function khubSend(path, method, body) {
        return fetch(API + path, {
          method: method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {})
        }).then((resp) => resp.json());
      }
      function showError(error) {
        setErrorText(String((error && (error.message || error.error)) || error || "操作失败"));
      }
      function clearError() { setErrorText(""); }

      /* ---------------- 数据加载 ---------------- */

      function loadTree(sid) {
        const key = String(sid);
        return khubGet("/khub/tree?spaceId=" + encodeURIComponent(key))
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            const tree = Array.isArray(res.tree) ? res.tree : [];
            setTrees((prev) => Object.assign({}, prev, { [key]: tree }));
            setExpanded((prev) => Object.assign({}, prev, { ["s" + key]: true }));
          })
          .catch(showError);
      }

      function loadFavorites(groupId) {
        return khubGet("/khub/favorites" + (groupId ? "?groupId=" + encodeURIComponent(String(groupId)) : ""))
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            setItems(Array.isArray(res.items) ? res.items : []);
            setListTitle(groupId ? "收藏夹" : "全部收藏");
            setView("favorites");
          })
          .catch(showError);
      }

      function loadFavGroups() {
        return khubGet("/khub/fav-groups")
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) return;
            setFavGroups(Array.isArray(res.groups) ? res.groups : []);
            const marks = {};
            (Array.isArray(res.favorites) ? res.favorites : []).forEach((it) => {
              marks[Number(it.nodeId || it.id)] = true;
            });
            setFavIds(marks);
          })
          .catch(() => { /* 收藏读不到不影响主流程 */ });
      }

      function loadShares(tab) {
        const which = tab === "in" ? "in" : "out";
        return khubGet("/khub/shares-" + which)
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            setItems(Array.isArray(res.shares) ? res.shares : []);
            setListTitle(which === "in" ? "收到的共享" : "我发出的共享");
            setShareTab(which);
            setView("shares");
          })
          .catch(showError);
      }

      function loadRecent() {
        return khubGet("/khub/recent?limit=60")
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            setItems(Array.isArray(res.items) ? res.items : []);
            setListTitle("最近访问");
            setPickedId(0);
            setView("recent");
          })
          .catch(showError);
      }

      useEffect(() => {
        khubGet("/khub/settings")
          .then((sett) => {
            if (sett === null || sett === undefined || sett.ready !== true) {
              setReady(false);
              setErrorText("尚未启用在线资料库。请到「设置 → Buddy 工作台 → 在线资料库」填写服务地址与密钥，保存后自动生效。");
              return null;
            }
            setReady(true);
            setBaseUrl(String(sett.baseUrl || ""));
            loadFavGroups();
            return khubGet("/khub/spaces");
          })
          .then((res) => {
            if (res === null || res === undefined) return;
            if (res.ok !== true) { showError(res); return; }
            const list = Array.isArray(res.spaces) ? res.spaces : [];
            setSpaces(list);
            if (list.length > 0) {
              const first = list[0];
              setSpaceId(Number(first.id));
              setSpaceName(String(first.name || ""));
              loadTree(Number(first.id));
            }
          })
          .catch(showError);
      }, []);

      /* ---------------- 树与选中 ---------------- */

      function treeOf(sid) {
        const tree = trees[String(sid)];
        return Array.isArray(tree) ? tree : [];
      }

      function findNode(nodes, id) {
        const list = Array.isArray(nodes) ? nodes : [];
        for (const node of list) {
          if (Number(node.id) === Number(id)) return node;
          if (Array.isArray(node.children) && node.children.length > 0) {
            const hit = findNode(node.children, id);
            if (hit !== null) return hit;
          }
        }
        return null;
      }

      function childrenOf(sid, id) {
        if (Number(id) === 0) return treeOf(sid);
        const node = findNode(treeOf(sid), id);
        return node !== null && Array.isArray(node.children) ? node.children : [];
      }

      function selectSpace(space) {
        officeProbeTokenRef.current += 1; /* 作废在途的 Office 能力探测 */
        setSpaceId(Number(space.id));
        setSpaceName(String(space.name || ""));
        setSelId(0);
        setPickedId(0);
        setSelName("全部内容");
        setKeyword("");
        setView("list");
        setEditing(null);
        if (trees[String(space.id)] === undefined) loadTree(Number(space.id));
        else setExpanded((prev) => Object.assign({}, prev, { ["s" + String(space.id)]: true }));
      }

      function toggleExpand(id) {
        setExpanded((prev) => Object.assign({}, prev, { ["n" + String(id)]: prev["n" + String(id)] !== true }));
      }

      function selectFolder(node) {
        officeProbeTokenRef.current += 1; /* 作废在途的 Office 能力探测 */
        setSelId(Number(node.id));
        setPickedId(Number(node.id));
        setSelName(String(node.name || "目录"));
        setExpanded((prev) => Object.assign({}, prev, { ["n" + String(node.id)]: true }));
        setView("list");
        setEditing(null);
        clearError();
      }

      function refreshCurrent() {
        loadTree(spaceId).then(() => setToast("已刷新目录"));
      }

      /* ---------------- 文档打开 ---------------- */

      /**
       * 加载内置 Office 轻量模型（GET /khub/office）：打开文档与「切回轻量视图」共用，
       * 不复制第二份取 model 的代码。
       * @param {number} nodeId 节点 id
       * @returns {Promise<void>}
       */
      function loadOfficeModel(nodeId) {
        setOfficeLoading(true);
        return khubGet("/khub/office?id=" + encodeURIComponent(String(nodeId)))
          .then((res) => {
            setOfficeLoading(false);
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            setOfficeModel(res.model === null || typeof res.model !== "object" ? null : res.model);
            setEditing((prev) => (prev === null ? prev : Object.assign({}, prev, {
              version: res.node !== undefined && res.node !== null ? Number(res.node.version || 0) : prev.version,
              dirty: false
            })));
          })
          .catch((error) => { setOfficeLoading(false); showError(error); });
      }

      /** 从版式预览 / 编辑切回内置轻量视图：复用 loadOfficeModel，不复制第二份取 model 代码。 */
      function switchOfficeToLight(nodeId) {
        const id = Number(nodeId) > 0 ? Number(nodeId) : (editing === null ? 0 : Number(editing.id));
        if (id <= 0) return;
        setOfficeFrameMode("view");
        setOfficeCanWrite(false);
        setOfficeNodeVersion(null);
        setOfficeFrameError("");
        setOfficeModel(null);
        setOfficeSheet(0);
        clearError();
        setEditing((prev) => (prev === null ? prev : Object.assign({}, prev, { mode: "office", dirty: false })));
        loadOfficeModel(id);
      }

      function openNode(node) {
        const type = String(node.nodeType || "").toUpperCase();
        /* 任何新的打开都作废上一次在途的 Office 能力探测，避免过期结果覆盖当前文档。 */
        officeProbeTokenRef.current += 1;
        const probeToken = officeProbeTokenRef.current;
        if (type === "FOLDER") { selectFolder(node); return; }
        if (type === "WORD" || type === "EXCEL" || type === "PPT") {
          /* Office：先探测在线是否启用了 ONLYOFFICE 版式预览（可用则自动启用）；
             探测失败一律静默降级到原内置轻量视图，不弹错误、不阻塞打开。
             先铺一份轻量底稿，探测期间编辑区也有加载态而不是空白。
             打开一律从 view 起步，是否可编辑由 frame 的 ready(canWrite) 决定；
             原 /khub/office 轻量编辑链路保持不动。 */
          const nodeId = Number(node.id);
          setPickedId(nodeId);
          setEditing({ id: nodeId, name: String(node.name || ""), nodeType: type, mode: "office", dirty: false, version: 0 });
          setOfficeModel(null);
          setOfficeSheet(0);
          setOfficeLoading(true);
          setOfficeFrameMode("view");
          setOfficeCanWrite(false);
          setOfficeNodeVersion(null);
          setOfficeFrameError("");
          setView("edit");
          clearError();
          probeOfficeCapability().then((available) => {
            if (officeProbeTokenRef.current !== probeToken) return;
            if (available === true) {
              setOfficeLoading(false);
              setEditing((prev) => (prev === null ? prev : Object.assign({}, prev, { mode: "office-frame" })));
            } else {
              loadOfficeModel(nodeId);
            }
          });
          return;
        }
        const base = { id: Number(node.id), name: String(node.name || ""), nodeType: type, mode: "source", dirty: false };
        /* 打开文件时把高亮移到它自己身上，否则树里会一直停在最后点过的那个目录 */
        setPickedId(Number(node.id));
        setLoading(true);
        clearError();
        fetch(API + "/khub/visit", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nodeId: Number(node.id) })
        }).catch(() => { /* 访问计数失败无影响 */ });
        if (type === "IMAGE" || type === "FILE") {
          setLoading(false);
          setEditing(Object.assign({}, base, { mode: type === "IMAGE" ? "image" : "file" }));
          setView("edit");
          return;
        }
        if (type === "CSV") {
          khubGet("/khub/csv?id=" + encodeURIComponent(String(node.id)))
            .then((res) => {
              setLoading(false);
              if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
              const csv = res.csv !== null && typeof res.csv === "object" ? res.csv : {};
              const matrix = Array.isArray(csv.matrix) && csv.matrix.length > 0
                ? csv.matrix.map((row) => (Array.isArray(row) ? row.map((cell) => (cell === null || cell === undefined ? "" : String(cell))) : []))
                : [["列1"]];
              setEditing(Object.assign({}, base, { matrix: matrix, version: Number(csv.version || 0), mode: "grid" }));
              setView("edit");
            })
            .catch((error) => { setLoading(false); showError(error); });
          return;
        }
        if (type === "HTML") {
          Promise.all([
            khubGet("/khub/content?id=" + encodeURIComponent(String(node.id))),
            khubGet("/khub/children?id=" + encodeURIComponent(String(node.id))).catch(() => ({ ok: false }))
          ]).then((pair) => {
            setLoading(false);
            const res = pair[0];
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            const content = res.content !== null && typeof res.content === "object" ? res.content : {};
            const kids = pair[1] !== null && pair[1] !== undefined && pair[1].ok === true && Array.isArray(pair[1].children) ? pair[1].children : [];
            setEditing(Object.assign({}, base, {
              content: typeof content.content === "string" ? content.content : "",
              version: Number(content.version || 0),
              tables: kids.filter((k) => String(k.nodeType || "").toUpperCase() === "CSV").map((k) => ({
                file: "node-" + String(k.id) + ".csv", name: String(k.name || "数据表"), nodeId: Number(k.id)
              })),
              mode: "html"
            }));
            setView("edit");
            setHtmlKey((value) => value + 1);
          }).catch((error) => { setLoading(false); showError(error); });
          return;
        }
        Promise.all([
          khubGet("/khub/content?id=" + encodeURIComponent(String(node.id))),
          khubGet("/khub/attachments?id=" + encodeURIComponent(String(node.id))).catch(() => ({ ok: false }))
        ]).then((pair) => {
            setLoading(false);
            const res = pair[0];
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            const content = res.content !== null && typeof res.content === "object" ? res.content : {};
            /* 附件清单带 relPath，Markdown 里的 ![](素材/x.png) 靠它换成 /khub/raw 直链 */
            const assets = pair[1] !== null && pair[1] !== undefined && pair[1].ok === true && Array.isArray(pair[1].items)
              ? pair[1].items : [];
            setEditing(Object.assign({}, base, {
              content: typeof content.content === "string" ? content.content : "",
              version: Number(content.version || 0),
              assets: assets,
              mode: type === "MD" ? "rich" : "source"
            }));
            setEditorMode(type === "MD" ? "rich" : "source");
            setView("edit");
          })
          .catch((error) => { setLoading(false); showError(error); });
      }

      function backToList() {
        officeProbeTokenRef.current += 1; /* 作废在途的 Office 能力探测 */
        setOfficeFrameMode("view");
        setOfficeCanWrite(false);
        setOfficeNodeVersion(null);
        setOfficeFrameError("");
        setView("list");
        setEditing(null);
        setEditorMode("rich");
      }

      /* ---------------- 新建 / 重命名 / 删除 / 移动 ---------------- */

      function openCreate(type, parentId) {
        setSelId(Number(parentId || selId));
        setCreateName("");
        setCreateType(type || "MD");
        setDialog("create");
        clearError();
      }

      function doCreate() {
        if (busy === true) return;
        const name = createName.trim();
        if (name === "") { setErrorText("名称不能为空"); return; }
        let finalName = name;
        if (createType === "MD" && !/\.md$/i.test(finalName)) finalName += ".md";
        if (createType === "CSV" && !/\.csv$/i.test(finalName)) finalName += ".csv";
        if (createType === "HTML" && !/\.html?$/i.test(finalName)) finalName += ".html";
        setBusy(true);
        clearError();
        khubSend("/khub/node", "POST", {
          spaceId: spaceId, parentId: Number(selId) || 0, name: finalName,
          nodeType: createType, content: libInitialContent(createType, finalName)
        }).then((res) => {
          setBusy(false);
          if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
          setDialog("");
          setToast("已创建「" + finalName + "」");
          loadTree(spaceId);
        }).catch((error) => { setBusy(false); showError(error); });
      }

      function doRename() {
        /* 目标可能来自菜单（opNode）或编辑器头部（editing），菜单路径优先 */
        const target = opNode !== null ? opNode : editing;
        if (busy === true || target === null) return;
        const name = renameValue.trim();
        if (name === "") { setErrorText("名称不能为空"); return; }
        setBusy(true);
        clearError();
        khubSend("/khub/node", "PUT", { id: target.id, action: "rename", name: name })
          .then((res) => {
            setBusy(false);
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            setEditing(editing === null ? editing : Object.assign({}, editing, { name: name }));
            setDialog("");
            setOpNode(null);
            setToast("已重命名");
            loadTree(spaceId);
          }).catch((error) => { setBusy(false); showError(error); });
      }

      function doDelete() {
        if (busy === true) return;
        const target = opNode !== null ? opNode : editing;
        if (target === null) return;
        setBusy(true);
        clearError();
        khubSend("/khub/node?id=" + encodeURIComponent(String(target.id)), "DELETE", {})
          .then((res) => {
            setBusy(false);
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            setDialog("");
            setMenuNode(null);
            setToast("已删除「" + String(target.name) + "」");
            if (editing !== null && Number(editing.id) === Number(target.id)) backToList();
            setOpNode(null);
            loadTree(spaceId);
            loadFavGroups();
          }).catch((error) => { setBusy(false); showError(error); });
      }

      function openMove(node) {
        setMoveNode(node);
        setMoveTargetId(0);
        setDialog("move");
        setMenuNode(null);
      }

      function doMove() {
        if (busy === true || moveNode === null) return;
        const target = Number(moveTargetId) || 0;
        if (target === Number(moveNode.id)) { setErrorText("不能移动到自身"); return; }
        setBusy(true);
        clearError();
        khubSend("/khub/node", "PUT", { id: moveNode.id, action: "rename", name: String(moveNode.name), parentId: target })
          .then((res) => {
            setBusy(false);
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            setDialog("");
            setMenuNode(null);
            setToast("已移动");
            loadTree(spaceId);
          }).catch((error) => { setBusy(false); showError(error); });
      }

      /* ---------------- 收藏 ---------------- */

      function toggleFav(node) {
        const id = Number(node.id);
        const on = favIds[id] === true;
        const req = on
          ? khubSend("/khub/favorite?nodeId=" + encodeURIComponent(String(id)), "DELETE", {})
          : khubSend("/khub/favorite", "POST", { nodeId: id, groupId: null });
        req.then((res) => {
          if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
          setFavIds((prev) => Object.assign({}, prev, { [id]: !on }));
          setToast(on ? "已取消收藏" : "已收藏");
          loadFavGroups();
          if (view === "favorites") loadFavorites(favGroupId);
        }).catch(showError);
        setMenuNode(null);
      }

      /* ---------------- 分享 ---------------- */

      function shareUrlOf(token) {
        return (baseUrl || "").replace(/\/+$/, "") + "/s/" + String(token);
      }
      function openShare(node) {
        setShareNode(node);
        setSharePerm("VIEW");
        setShareExpire("");
        setSharePwd("");
        setDialog("share");
        setMenuNode(null);
        loadShareList(node);
      }

      function loadShareList(node) {
        return khubGet("/khub/shares?nodeId=" + encodeURIComponent(String(node.id)))
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { setShareList([]); return; }
            setShareList(Array.isArray(res.shares) ? res.shares : []);
          })
          .catch(() => setShareList([]));
      }

      function doCreateShare() {
        if (busy === true || shareNode === null) return;
        setBusy(true);
        clearError();
        khubSend("/khub/share", "POST", {
          nodeId: shareNode.id,
          permission: sharePerm,
          expireHours: shareExpire.trim() === "" ? null : Number(shareExpire),
          password: sharePwd.trim()
        }).then((res) => {
          setBusy(false);
          if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
          setToast("分享已创建");
          setSharePwd("");
          loadShareList(shareNode);
        }).catch((error) => { setBusy(false); showError(error); });
      }

      function doDeleteShare(shareId) {
        khubSend("/khub/share?id=" + encodeURIComponent(String(shareId)), "DELETE", {})
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            setToast("分享已取消");
            if (shareNode !== null) loadShareList(shareNode);
            if (view === "shares") loadShares(shareTab);
          }).catch(showError);
      }

      function doToggleSharePerm(item) {
        const next = String(item.permission).toUpperCase() === "WRITE" ? "VIEW" : "WRITE";
        khubSend("/khub/share", "PUT", { id: item.id, permission: next })
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            setToast("权限已改为" + (next === "WRITE" ? "可写" : "只读"));
            if (shareNode !== null) loadShareList(shareNode);
            if (view === "shares") loadShares(shareTab);
          }).catch(showError);
      }

      function copyText(text) {
        const value = String(text || "");
        try {
          if (navigator !== undefined && navigator.clipboard !== undefined) {
            navigator.clipboard.writeText(value).then(() => setToast("已复制链接")).catch(() => setToast(value));
            return;
          }
        } catch { /* 无剪贴板权限时直接把地址显示出来 */ }
        setToast(value);
      }

      /* ---------------- 版本 ---------------- */

      function openVersions(node) {
        setVersionNode(node);
        setVersionPreview(null);
        setDialog("versions");
        setMenuNode(null);
        khubGet("/khub/versions?nodeId=" + encodeURIComponent(String(node.id)))
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { setVersionList([]); return; }
            setVersionList(Array.isArray(res.versions) ? res.versions : []);
          })
          .catch(() => setVersionList([]));
      }

      function previewVersion(no) {
        if (versionNode === null) return;
        khubGet("/khub/version?nodeId=" + encodeURIComponent(String(versionNode.id)) + "&no=" + encodeURIComponent(String(no)))
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            setVersionPreview(res.data !== null && typeof res.data === "object" ? res.data : res);
          }).catch(showError);
      }

      function doRestoreVersion(no) {
        if (versionNode === null || busy === true) return;
        setBusy(true);
        khubSend("/khub/version/restore", "POST", { nodeId: versionNode.id, no: Number(no) })
          .then((res) => {
            setBusy(false);
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            setDialog("");
            setToast("已回滚到 v" + String(no));
            if (editing !== null && Number(editing.id) === Number(versionNode.id)) openNode({ id: editing.id, name: editing.name, nodeType: editing.nodeType });
            loadTree(spaceId);
          }).catch((error) => { setBusy(false); showError(error); });
      }

      /* ---------------- 保存 ---------------- */

      function doSaveContent() {
        if (busy === true || editing === null) return;
        let content = editing.content;
        if (String(editing.nodeType).toUpperCase() === "MD" && editorMode === "rich" && editorRef.current !== null) {
          content = htmlToMarkdown(editorRef.current);
        }
        setBusy(true);
        clearError();
        khubSend("/khub/node", "PUT", { id: editing.id, action: "content", content: content, baseVersion: editing.version })
          .then((res) => {
            setBusy(false);
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            const node = res.node !== null && typeof res.node === "object" ? res.node : {};
            setEditing(Object.assign({}, editing, { content: content, version: Number(node.version || editing.version + 1), dirty: false }));
            setToast("已保存");
            loadTree(spaceId);
          }).catch((error) => { setBusy(false); showError(error); });
      }

      function setCell(rowIndex, colIndex, value) {
        const matrix = editing.matrix.map((row) => row.slice());
        while (matrix.length <= rowIndex) matrix.push([]);
        while (matrix[rowIndex].length <= colIndex) matrix[rowIndex].push("");
        matrix[rowIndex][colIndex] = String(value);
        setEditing(Object.assign({}, editing, { matrix: matrix, dirty: true }));
      }

      function addRow() {
        const width = Array.isArray(editing.matrix[0]) ? editing.matrix[0].length : 1;
        const matrix = editing.matrix.map((row) => row.slice());
        matrix.push(new Array(width).fill(""));
        setEditing(Object.assign({}, editing, { matrix: matrix, dirty: true }));
      }

      function addColumn() {
        const matrix = editing.matrix.map((row) => row.slice());
        matrix.forEach((row, index) => row.push(index === 0 ? "新列" : ""));
        setEditing(Object.assign({}, editing, { matrix: matrix, dirty: true }));
      }

      function doSaveMatrix() {
        if (busy === true || editing === null) return;
        setBusy(true);
        clearError();
        khubSend("/khub/csv", "PUT", { id: editing.id, matrix: editing.matrix, baseVersion: editing.version })
          .then((res) => {
            setBusy(false);
            if (res === null || res === undefined || res.ok !== true) {
              if (res !== null && res !== undefined && res.code === "conflict" && res.csv) {
                setEditing(Object.assign({}, editing, {
                  matrix: Array.isArray(res.csv.matrix) ? res.csv.matrix : editing.matrix,
                  version: Number(res.csv.version || editing.version)
                }));
              }
              showError(res);
              return;
            }
            setEditing(Object.assign({}, editing, { version: Number(res.version || editing.version + 1), dirty: false }));
            setToast("已保存");
          }).catch((error) => { setBusy(false); showError(error); });
      }

      function doSearch() {
        const text = keyword.trim();
        if (text === "") { setView("list"); return; }
        clearError();
        khubGet("/khub/search?spaceId=" + encodeURIComponent(String(spaceId)) + "&keyword=" + encodeURIComponent(text))
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            setItems(Array.isArray(res.items) ? res.items : []);
            setListTitle("搜索「" + text + "」");
            setView("search");
          }).catch(showError);
      }

      /* ---------------- 富文本 Markdown（Word 式） ---------------- */

      function execCommand(command, value) {
        const el = editorRef.current;
        if (el === null) return;
        el.focus();
        try { document.execCommand(command, false, value === undefined ? null : value); } catch { /* 老浏览器降级为无操作 */ }
        setEditing((prev) => (prev === null ? prev : Object.assign({}, prev, { dirty: true })));
      }

      /** 工具栏按钮：mousedown 阻止默认行为，避免点按钮时编辑区丢焦点。 */
      function tbButton(key, label, title, onClick, active) {
        return h("button", {
          key: "tb-" + key,
          type: "button",
          className: "dshe-lib-tool" + (active === true ? " dshe-lib-tool-on" : ""),
          title: title,
          "aria-label": title,
          onMouseDown: (event) => { if (event && event.preventDefault) event.preventDefault(); },
          onClick: onClick
        }, label);
      }

      /**
       * Word 式工具栏：撤销重做 / 段落格式 / 字符样式 / 颜色 / 对齐 / 列表 / 插入。
       * 全部走 document.execCommand（浏览器原生，零依赖），与在线资料库的可视化编辑器同源。
       * @returns {any} 工具栏元素
       */
      function renderToolbar() {
        const block = (tag, title, label) => tbButton(tag, label, title, () => execCommand("formatBlock", "<" + tag + ">"));
        const align = (cmd, title, label) => tbButton(cmd, label, title, () => execCommand(cmd));
        return h("div", { className: "dshe-lib-toolbar", role: "toolbar", "aria-label": "格式工具栏" },
          h("div", { className: "dshe-lib-tb-group" },
            tbButton("undo", "↶", "撤销 (Ctrl+Z)", () => execCommand("undo")),
            tbButton("redo", "↷", "重做 (Ctrl+Y)", () => execCommand("redo"))),
          h("span", { className: "dshe-lib-tb-sep" }),
          h("div", { className: "dshe-lib-tb-group" },
            h("select", {
              className: "dshe-lib-tb-select",
              "aria-label": "段落格式",
              title: "段落格式",
              defaultValue: "p",
              onChange: (event) => {
                const tag = String((event && event.target && event.target.value) || "p");
                execCommand("formatBlock", "<" + tag + ">");
              }
            },
              h("option", { value: "p" }, "正文"),
              h("option", { value: "h1" }, "标题 1"),
              h("option", { value: "h2" }, "标题 2"),
              h("option", { value: "h3" }, "标题 3"),
              h("option", { value: "h4" }, "标题 4"),
              h("option", { value: "blockquote" }, "引用"),
              h("option", { value: "pre" }, "代码块"))),
          h("span", { className: "dshe-lib-tb-sep" }),
          h("div", { className: "dshe-lib-tb-group" },
            tbButton("bold", h("b", null, "B"), "加粗 (Ctrl+B)", () => execCommand("bold")),
            tbButton("italic", h("i", null, "I"), "斜体 (Ctrl+I)", () => execCommand("italic")),
            tbButton("underline", h("u", null, "U"), "下划线 (Ctrl+U)", () => execCommand("underline")),
            tbButton("strike", h("s", null, "S"), "删除线", () => execCommand("strikeThrough")),
            tbButton("code", "</>", "行内代码", () => wrapInline(String.fromCharCode(96), String.fromCharCode(96)))),
          h("span", { className: "dshe-lib-tb-sep" }),
          h("div", { className: "dshe-lib-tb-group" },
            h("label", { className: "dshe-lib-tb-color", title: "文字颜色" },
              h("span", { className: "dshe-lib-tb-swatch" }, "A"),
              h("input", {
                type: "color", value: "#" + "1f2328", "aria-label": "文字颜色",
                onChange: (event) => execCommand("foreColor", String((event && event.target && event.target.value) || "#" + "1f2328"))
              })),
            h("label", { className: "dshe-lib-tb-color", title: "文字高亮" },
              h("span", { className: "dshe-lib-tb-swatch dshe-lib-tb-swatch-hl" }, "H"),
              h("input", {
                type: "color", value: "#" + "fff3a3", "aria-label": "文字高亮",
                onChange: (event) => execCommand("hiliteColor", String((event && event.target && event.target.value) || "#" + "fff3a3"))
              }))),
          h("span", { className: "dshe-lib-tb-sep" }),
          h("div", { className: "dshe-lib-tb-group" },
            align("justifyLeft", "左对齐", "☰"),
            align("justifyCenter", "居中", "≡"),
            align("justifyRight", "右对齐", "☷")),
          h("span", { className: "dshe-lib-tb-sep" }),
          h("div", { className: "dshe-lib-tb-group" },
            tbButton("ul", "•", "无序列表", () => execCommand("insertUnorderedList")),
            tbButton("ol", "1.", "有序列表", () => execCommand("insertOrderedList")),
            tbButton("indent", "→", "增加缩进", () => execCommand("indent")),
            tbButton("outdent", "←", "减少缩进", () => execCommand("outdent"))),
          h("span", { className: "dshe-lib-tb-sep" }),
          h("div", { className: "dshe-lib-tb-group" },
            block("blockquote", "引用", "❝"),
            block("pre", "代码块", "⌘"),
            tbButton("hr", "—", "分割线", () => execCommand("insertHorizontalRule")),
            tbButton("link", "🔗", "插入链接", () => {
              const url = window.prompt("链接地址（https://… 或 kb:节点ID）", "https://");
              if (url === null || url === "") return;
              if (/^kb:\d+$/i.test(url)) {
                const label = window.prompt("显示文字", url) || url;
                insertHtml('<a href="#" data-kb="' + url.slice(3) + '" class="dshe-lib-md-link">' + label + "</a>");
                return;
              }
              execCommand("createLink", url);
            }),
            tbButton("image", "🖼", "插入图片（来自本文件附件）", () => setDialog("assets")),
            tbButton("table", "▦", "插入 3×3 表格", () => insertHtml(tableHtml())),
            tbButton("clear", "⌫", "清除格式", () => execCommand("removeFormat"))),
          h("span", { className: "dshe-lib-tb-sep" }),
          /* 表格矩阵：光标在单元格里才生效，插完不用重新打开文档就能继续加行加列 */
          h("div", { className: "dshe-lib-tb-group", role: "group", "aria-label": "表格操作" },
            tbButton("trow-add", "行+", "在光标所在行下面插入一行", () => tableOp("rowAdd")),
            tbButton("trow-del", "行−", "删除光标所在行", () => tableOp("rowDel")),
            tbButton("tcol-add", "列+", "在光标所在列右侧插入一列", () => tableOp("colAdd")),
            tbButton("tcol-del", "列−", "删除光标所在列", () => tableOp("colDel")),
            tbButton("ttable-del", "删表", "删除整张表格", () => tableOp("tableDel"))));
      }

      /** 行内包裹（行内代码等 execCommand 没有对应命令的）。 */
      function wrapInline(before, after) {
        const el = editorRef.current;
        if (el === null) return;
        el.focus();
        const sel = window.getSelection === undefined ? null : window.getSelection();
        const picked = sel === null ? "" : String(sel);
        insertHtml(before + (picked === "" ? "code" : picked) + after);
      }

      /** 光标所在单元格；不在表格里（或拿不到选区）返回 null。 */
      function currentCell() {
        const sel = typeof window !== "undefined" && typeof window.getSelection === "function" ? window.getSelection() : null;
        if (sel === null || sel === undefined || Number(sel.rangeCount) === 0) return null;
        const range = sel.getRangeAt(0);
        const start = range === null || range === undefined ? null : range.startContainer;
        if (start === null || start === undefined) return null;
        return tagUp(start.nodeType === 3 ? start.parentNode : start, ["TD", "TH"]);
      }

      /**
       * 工具栏的表格操作入口：光标不在表格里就给一句提示，不静默失败。
       * @param {string} kind rowAdd / rowDel / colAdd / colDel / tableDel
       */
      function tableOp(kind) {
        const cell = currentCell();
        const table = cell === null ? null : tagUp(cell, ["TABLE"]);
        if (table === null) { setToast("请先把光标点到表格里再操作"); return; }
        const res = tableOpOf(table, cell, kind);
        if (res.ok !== true) { setToast(res.message); return; }
        setEditing((prev) => (prev === null ? prev : Object.assign({}, prev, { dirty: true })));
        setToast(res.message);
      }

      /* ---------------- 表格列宽 / 行高拖拽 ----------------
         contenteditable 里的 table 没有原生 resize，这里自己算：
         鼠标落在单元格右缘 6px 内 = 拖列宽，落在下缘 5px 内 = 拖行高。 */

      /** 悬停在可拖边缘时换光标（唯一的功能提示，配合 CSS 里表头右缘那条淡线）。 */
      function onRichMouseMove(event) {
        const el = editorRef.current;
        if (el === null || resizeRef.current !== null) return;
        const hit = tableHit(event);
        const want = hit === null ? "" : (hit.kind === "col" ? "col-resize" : "row-resize");
        if (el.style.cursor !== want) el.style.cursor = want;
      }

      /**
       * 按下开始拖拽：document 级监听 move / up，松手时清干净并标脏。
       * @param {any} event 鼠标事件
       */
      function onRichMouseDown(event) {
        const hit = tableHit(event);
        if (hit === null) return;
        const table = tagUp(hit.cell, ["TABLE"]);
        if (table === null) return;
        const doc = table.ownerDocument;
        if (doc === null || doc === undefined) return;
        /* 别让浏览器顺手开始选文字 */
        if (event.preventDefault) event.preventDefault();
        if (hit.kind === "col") {
          const cols = ensureColgroup(table);
          const col = cols[colIndexOf(hit.cell)];
          resizeRef.current = {
            kind: "col", table: table, col: col,
            start: Number(event.clientX),
            base: col === undefined ? 80 : (Math.round(parseFloat(col.style.width)) || 80),
          };
        } else {
          const row = tagUp(hit.cell, ["TR"]);
          if (row === null) return;
          const h = Math.round(row.getBoundingClientRect().height);
          resizeRef.current = { kind: "row", row: row, start: Number(event.clientY), base: h > 0 ? h : 32 };
        }
        const move = (e) => applyResize(resizeRef.current, e);
        const up = () => {
          const st = resizeRef.current;
          resizeRef.current = null;
          doc.removeEventListener("mousemove", move);
          doc.removeEventListener("mouseup", up);
          const el = editorRef.current;
          if (el !== null) el.style.cursor = "";
          if (st !== null) setEditing((prev) => (prev === null ? prev : Object.assign({}, prev, { dirty: true })));
        };
        doc.addEventListener("mousemove", move);
        doc.addEventListener("mouseup", up);
      }

      /** 在当前光标处插入 HTML 片段。 */
      function insertHtml(html) {
        const el = editorRef.current;
        if (el === null) return;
        el.focus();
        try { document.execCommand("insertHTML", false, html); } catch { /* 降级：追加到末尾 */ el.insertAdjacentHTML("beforeend", html); }
        setEditing((prev) => (prev === null ? prev : Object.assign({}, prev, { dirty: true })));
      }

      /** 3×3 空表格的 HTML（表格是 Markdown 里能表达的结构）。 */
      function tableHtml() {
        const cell = '<td><br></td>';
        const row = '<tr>' + cell + cell + cell + '</tr>';
        return '<table><thead><tr><th>列1</th><th>列2</th><th>列3</th></tr></thead><tbody>' + row + row + row + '</tbody></table><p><br></p>';
      }

      function renderRich() {
        const nodeId = editing === null ? "" : String(editing.id);
        return h("div", { className: "dshe-lib-rich-wrap" },
          renderToolbar(),
          h("div", {
            className: "dshe-lib-rich",
            contentEditable: true,
            suppressContentEditableWarning: true,
            "aria-label": "文档正文",
            ref: (el) => {
              editorRef.current = el;
              if (el !== null && el.getAttribute("data-node") !== nodeId) {
                el.innerHTML = markdownToHtml(editing.content, editing);
                el.setAttribute("data-node", nodeId);
              }
            },
            onInput: () => setEditing((prev) => (prev === null ? prev : Object.assign({}, prev, { dirty: true }))),
            onMouseDown: onRichMouseDown,
            onMouseMove: onRichMouseMove,
            onClick: onContentClick
          })
        );
      }

      /**
       * 正文里的 kb 链接点击代理：正文是 dangerouslySetInnerHTML / contenteditable，
       * 没法给每个 <a> 绑事件，所以在容器上做一次委托。
       * @param {any} event 点击事件
       */
      function onContentClick(event) {
        const target = event === null || event === undefined ? null : event.target;
        if (target === null || typeof target.closest !== "function") return;
        const link = target.closest("a[data-kb]");
        if (link === null) return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        if (typeof event.stopPropagation === "function") event.stopPropagation();
        openRef(Number(link.getAttribute("data-kb")));
      }

      /**
       * 打开正文里引用的节点：附件清单里能查到就直接开，查不到再拉一次节点详情。
       * @param {number} id 目标节点 id
       */
      function openRef(id) {
        if (!Number.isFinite(id) || id <= 0) return;
        const assets = editing !== null && Array.isArray(editing.assets) ? editing.assets : [];
        const hit = assets.find((it) => Number(it.id) === Number(id));
        if (hit !== undefined) {
          openNode({ id: hit.id, name: hit.name, nodeType: hit.nodeType });
          return;
        }
        khubGet("/khub/node?id=" + encodeURIComponent(String(id)))
          .then((res) => {
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            openNode({ id: Number(res.id || id), name: String(res.name || ""), nodeType: String(res.nodeType || "") });
          })
          .catch(showError);
      }

      /* ---------------- Office 内置编辑 ---------------- */

      /**
       * 内置 Office 编辑器：Word 按段落编辑，Excel 按单元格网格编辑，PPT 只读页文本。
       * 保存走 /khub/office POST（后端重建 OOXML 并上传为新版本）。
       */
      function renderOffice() {
        if (officeLoading === true) {
          return h("div", { className: "dshe-oe-state" }, "正在解析文档…");
        }
        if (officeModel === null) {
          return h("div", { className: "dshe-oe-state" }, "无法解析该文件，请点「返回」后改用「下载」在本地编辑。");
        }
        const kind = String(officeModel.kind || "");
        if (kind === "doc") {
          const paragraphs = Array.isArray(officeModel.paragraphs) ? officeModel.paragraphs : [];
          return h("div", { className: "dshe-oe" },
            h("div", { className: "dshe-oe-tip" }, "按段落编辑正文；版式、图片、表格结构保持不变，保存后生成新版本。"),
            h("div", { className: "dshe-oe-doc" },
              paragraphs.map((text, index) => h("div", { key: "p-" + String(index), className: "dshe-oe-para" },
                h("span", { className: "dshe-oe-para-no" }, String(index + 1)),
                h("textarea", {
                  className: "dshe-oe-para-input",
                  rows: 1,
                  value: text,
                  spellCheck: false,
                  "aria-label": "第 " + String(index + 1) + " 段",
                  onChange: (event) => {
                    const next = String((event && event.target && event.target.value) || "");
                    setOfficeModel((prev) => {
                      if (prev === null) return prev;
                      const copy = prev.paragraphs.slice();
                      copy[index] = next;
                      return Object.assign({}, prev, { paragraphs: copy });
                    });
                    setEditing((prev) => (prev === null ? prev : Object.assign({}, prev, { dirty: true })));
                  }
                })))
            )
          );
        }
        if (kind === "sheet") {
          const sheets = Array.isArray(officeModel.sheets) ? officeModel.sheets : [];
          const active = Math.min(Math.max(officeSheet, 0), Math.max(sheets.length - 1, 0));
          const sheet = sheets[active] === undefined ? { name: "Sheet1", rows: [] } : sheets[active];
          const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
          const width = rows.reduce((n, row) => Math.max(n, Array.isArray(row) ? row.length : 0), 0);
          const editCell = (r, c, next) => {
            setOfficeModel((prev) => {
              if (prev === null || !Array.isArray(prev.sheets)) return prev;
              const copySheets = prev.sheets.map((it) => ({
                name: it.name,
                rows: (Array.isArray(it.rows) ? it.rows : []).map((rr) => (Array.isArray(rr) ? rr.slice() : []))
              }));
              const target = copySheets[active];
              while (target.rows.length <= r) target.rows.push([]);
              while (target.rows[r].length <= c) target.rows[r].push("");
              target.rows[r][c] = next;
              return Object.assign({}, prev, { sheets: copySheets });
            });
            setEditing((prev) => (prev === null ? prev : Object.assign({}, prev, { dirty: true })));
          };
          const headCells = Array.from({ length: width }).map((ignore, c) => h("th", { key: "h-" + String(c), className: "dshe-oe-colh" }, columnLabel(c)));
          const bodyRows = rows.map((row, r) => {
            const cells = Array.from({ length: width }).map((ignore, c) => h("td", { key: "c-" + String(r) + "-" + String(c) },
              h("input", {
                className: "dshe-oe-cell" + (r === 0 ? " dshe-oe-cell-head" : ""),
                value: Array.isArray(row) && row[c] !== undefined ? String(row[c]) : "",
                spellCheck: false,
                "aria-label": "第 " + String(r + 1) + " 行第 " + String(c + 1) + " 列",
                onChange: (event) => editCell(r, c, String((event && event.target && event.target.value) || ""))
              })));
            return h("tr", { key: "r-" + String(r) }, h("th", { className: "dshe-oe-rown" }, String(r + 1)), cells);
          });
          return h("div", { className: "dshe-oe" },
            h("div", { className: "dshe-oe-tip" }, "按单元格编辑，保留公式与样式；新增行列请留空后在本地 Office 里补格式。"),
            h("div", { className: "dshe-oe-tabs" }, sheets.map((item, index) => h("button", {
              key: "sh-" + String(index),
              type: "button",
              className: "dshe-oe-tab" + (index === active ? " dshe-oe-tab-on" : ""),
              onClick: () => setOfficeSheet(index)
            }, String(item.name || "Sheet" + String(index + 1))))),
            h("div", { className: "dshe-oe-grid-wrap" },
              h("table", { className: "dshe-oe-grid" },
                h("thead", null, h("tr", null, h("th", { className: "dshe-oe-rown" }), headCells)),
                h("tbody", null, bodyRows)
              )
            )
          );
        }
        if (kind === "pptx") {
          const slides = Array.isArray(officeModel.slides) ? officeModel.slides : [];
          return h("div", { className: "dshe-oe" },
            h("div", { className: "dshe-oe-tip" }, "演示文稿暂为只读（逐页文本预览）。要改内容请「下载」后用本地 Office / WPS 编辑，再上传新版本。"),
            h("div", { className: "dshe-oe-slides" }, slides.map((texts, index) => {
              const lines = (Array.isArray(texts) ? texts : []).map((text, i) => h("p", { key: "t-" + String(i), className: "dshe-oe-slide-text" }, String(text)));
              return h("div", { key: "slide-" + String(index), className: "dshe-oe-slide" },
                h("div", { className: "dshe-oe-slide-no" }, "第 " + String(index + 1) + " 页"),
                lines);
            }))
          );
        }
        return h("div", { className: "dshe-oe-state" }, "该类型暂不支持内置编辑。");
      }

      /** 保存 Office 新版本：把当前模型发给后端重建 OOXML 并上传。 */
      function saveOffice() {
        if (editing === null || busy === true) return;
        const model = officeModel;
        if (model === null) return;
        if (String(model.kind || "") === "pptx") { setToast("演示文稿为只读，无法保存"); return; }
        setBusy(true);
        fetch(API + "/khub/office?id=" + encodeURIComponent(String(editing.id)), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: model })
        })
          .then((resp) => resp.json())
          .then((res) => {
            setBusy(false);
            if (res === null || res === undefined || res.ok !== true) { showError(res); return; }
            const version = Number(res.version || 0);
            setEditing((prev) => (prev === null ? prev : Object.assign({}, prev, { version: version, dirty: false })));
            setToast("已保存为新版本 v" + String(version));
            if (trees[String(spaceId)] !== undefined) loadTree(spaceId);
          })
          .catch((error) => { setBusy(false); showError(error); });
      }

      /** 列号：0→A，25→Z，26→AA。 */
      function columnLabel(index) {
        let n = Number(index) + 1;
        let out = "";
        while (n > 0) {
          const rem = (n - 1) % 26;
          out = String.fromCharCode(65 + rem) + out;
          n = Math.floor((n - 1) / 26);
        }
        return out;
      }

      /* ---------------- 右侧列表 ---------------- */

      /** 资料库左栏：宽度夹取 / 落盘 / 拖拽 / 键盘微调 / 双击复位 / 收起切换。 */
      function clampLibWidth(value) {
        return clampWidth(value, LIB_SIDE_WIDTH_MIN, LIB_SIDE_WIDTH_MAX, LIB_SIDE_WIDTH_DEFAULT);
      }
      function toggleLibSide() {
        const next = !libSideCollapsed;
        setLibSideCollapsed(next);
        writePref(LIB_SIDE_COLLAPSED_KEY, next ? "1" : "0");
      }
      /** 拖拽分隔条：按下后跟随鼠标改宽度，松手落盘。 */
      function startLibResize(event) {
        if (typeof event.button === "number" && event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = libSideWidth;
        let latest = startWidth;
        const onMove = (moveEvent) => {
          latest = clampLibWidth(startWidth + (moveEvent.clientX - startX));
          setLibSideWidth(latest);
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          writePref(LIB_SIDE_WIDTH_KEY, latest);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }
      /** 键盘调整宽度：← → 小步、Shift+← → 大步。 */
      function onLibResizeKey(event) {
        const step = event.shiftKey === true ? 32 : 8;
        let next = null;
        if (event.key === "ArrowLeft") next = clampLibWidth(libSideWidth - step);
        else if (event.key === "ArrowRight") next = clampLibWidth(libSideWidth + step);
        if (next === null) return;
        event.preventDefault();
        setLibSideWidth(next);
        writePref(LIB_SIDE_WIDTH_KEY, next);
      }
      /** 双击分隔条恢复默认宽度。 */
      function resetLibWidth() {
        setLibSideWidth(LIB_SIDE_WIDTH_DEFAULT);
        writePref(LIB_SIDE_WIDTH_KEY, LIB_SIDE_WIDTH_DEFAULT);
      }

      function renderSide() {
        /* 收起后只留一条 32px 窄条：点按钮或按标题即可展开，不占内容区 */
        if (libSideCollapsed === true) {
          return h("aside", { className: "dshe-side-rail", "aria-label": "资料库导航（已收起）" },
            h("button", {
              type: "button",
              className: "dshe-side-rail-btn",
              title: "展开侧栏",
              "aria-label": "展开资料库侧栏",
              onClick: toggleLibSide
            }, h("span", { style: { display: "inline-flex", transform: "rotate(-90deg)" } },
              h(Icon, { name: "chevron-down", size: 14 }))),
            h("span", { className: "dshe-side-rail-label" }, "资料库")
          );
        }
        const personal = spaces.filter((it) => String(it.type).toUpperCase() === "PERSONAL");
        const team = spaces.filter((it) => String(it.type).toUpperCase() === "TEAM");
        const quick = (id, label, icon, onClick, active) => h("button", {
          key: "quick-" + id,
          type: "button",
          className: "dshe-lib-quick" + (active ? " dshe-lib-quick-on" : ""),
          onClick: onClick
        }, h(Icon, { name: icon, size: 15 }), h("span", null, label));

        function treeNodes(nodes, depth) {
          const list = Array.isArray(nodes) ? nodes : [];
          return list.map((node) => {
            const type = String(node.nodeType || "").toUpperCase();
            const isFolder = type === "FOLDER";
            const kids = Array.isArray(node.children) ? node.children : [];
            const open = expanded["n" + String(node.id)] === true;
            const on = Number(pickedId) === Number(node.id);
            /* 菜单实际高度（项数×33 + 分隔 11 + 内边距 14），定位时用它判断要不要翻转：
               估少了会把菜单顶出视口，估多了会让翻转后的菜单离光标很远 */
            const menuH = isFolder ? 370 : 226;
            return h("div", { key: "tn-" + String(node.id), className: "dshe-lib-tnode-wrap" },
              h("div", {
                className: "dshe-lib-tnode" + (on ? " dshe-lib-tnode-on" : ""),
                style: { paddingLeft: String(6 + depth * 13) + "px" },
                onMouseEnter: () => setHoverId(Number(node.id)),
                onMouseLeave: () => setHoverId(0),
                /* 右键同样弹出这份菜单（坐标跟光标走，和「···」同一套面板） */
                onContextMenu: (event) => {
                  if (event && event.preventDefault) event.preventDefault();
                  if (event && event.stopPropagation) event.stopPropagation();
                  setNewMenuAt(null);
                  setMenuAt(popCoordsAt(event === null || event === undefined ? 0 : event.clientX,
                    event === null || event === undefined ? 0 : event.clientY, 214, menuH));
                  setMenuNode(node);
                }
              },
                kids.length > 0
                  ? h("button", {
                      type: "button", className: "dshe-lib-tcaret", "aria-label": open ? "收起" : "展开",
                      onClick: () => toggleExpand(node.id)
                    }, h(Icon, { name: open ? "chevron-down" : "chevron-up", size: 12 }))
                  : h("span", { className: "dshe-lib-tcaret dshe-lib-tcaret-empty" }),
                h("span", { className: "dshe-lib-tico dshe-lib-tico-" + libTypeClass(type) },
                  h(Icon, { name: libTypeIcon(type), size: 14 })),
                h("button", {
                  type: "button",
                  className: "dshe-lib-tname",
                  title: String(node.name || ""),
                  onClick: () => (isFolder ? selectFolder(node) : openNode(node))
                }, String(node.name || "未命名")),
                favIds[Number(node.id)] === true
                  ? h("span", { className: "dshe-lib-tstar" }, h(Icon, { name: "star", size: 11 }))
                  : null,
                hoverId === Number(node.id) || (menuNode !== null && Number(menuNode.id) === Number(node.id))
                  ? h("button", {
                      type: "button", className: "dshe-lib-tmore", title: "更多操作",
                      "aria-haspopup": "menu",
                      onClick: (event) => {
                        if (event && event.stopPropagation) event.stopPropagation();
                        setNewMenuAt(null);
                        setMenuAt(popCoords(event, 214, menuH));
                        setMenuNode(node);
                      }
                    }, "···")
                  : null
              ),
              open ? treeNodes(kids, depth + 1) : null
            );
          });
        }

        function spaceBlock(space) {
          const key = String(space.id);
          const open = expanded["s" + key] === true;
          return h("div", { key: "space-" + key, className: "dshe-lib-space-block" },
            h("div", { className: "dshe-lib-space-row" },
              h("button", {
                type: "button", className: "dshe-lib-tcaret", "aria-label": open ? "收起" : "展开",
                onClick: () => {
                  if (open === false && trees[key] === undefined) loadTree(space.id);
                  setExpanded((prev) => Object.assign({}, prev, { ["s" + key]: !open }));
                }
              }, h(Icon, { name: open ? "chevron-down" : "chevron-up", size: 12 })),
              h("button", {
                type: "button",
                className: "dshe-lib-space" + (Number(spaceId) === Number(space.id) && Number(selId) === 0 ? " dshe-lib-space-on" : ""),
                onClick: () => selectSpace(space),
                title: String(space.name || "")
              },
                h("span", { className: "dshe-lib-space-ico" }, String(space.icon || "·")),
                h("span", { className: "dshe-lib-space-name" }, String(space.name || "未命名")),
                h("span", { className: "dshe-lib-count" }, String(space.nodeCount || 0))
              )
            ),
            open ? h("div", { className: "dshe-lib-tree" }, treeNodes(treeOf(space.id), 0)) : null
          );
        }

        return h("aside", {
          className: "dshe-lib-side",
          "aria-label": "资料库导航",
          style: { width: String(libSideWidth) + "px" }
        },
          h("div", { className: "dshe-lib-head" },
            h("span", { className: "dshe-lib-logo" }, "KH"),
            h("span", { className: "dshe-lib-title" }, "资料库"),
            h("div", { className: "dshe-lib-head-actions" },
              h("button", {
                type: "button",
                className: "dshe-side-fold",
                title: "收起侧栏",
                "aria-label": "收起资料库侧栏",
                onClick: toggleLibSide
              }, h("span", { style: { display: "inline-flex", transform: "rotate(90deg)" } },
                h(Icon, { name: "chevron-down", size: 13 }))),
              h("span", { className: "dshe-lib-avatar" }, h(Icon, { name: "person", size: 14 }))
            )
          ),
          h("div", { className: "dshe-lib-search-row" },
            h("input", {
              className: "dshe-lib-search", type: "search", value: keyword,
              placeholder: "搜索当前空间", "aria-label": "搜索文档",
              onChange: (event) => setKeyword(String((event && event.target && event.target.value) || "")),
              onKeyDown: (event) => { if (event && event.key === "Enter") doSearch(); }
            }),
            h("button", { type: "button", className: "dshe-lib-search-btn", onClick: doSearch }, "搜索")
          ),
          h("div", { className: "dshe-lib-quicks" },
            /* 「新建」不再是「直接建一个 md」，而是贴着按钮弹出新建菜单 */
            quick("new", "新建", "plus", (event) => {
              setMenuNode(null);
              setNewMenuAt(popCoords(event, 224, 190));
            }, newMenuAt !== null),
            quick("recent", "最近", "v", loadRecent, view === "recent"),
            quick("shares", "共享", "users", () => loadShares(shareTab), view === "shares"),
            quick("fav", "收藏", "star", () => loadFavorites(favGroupId), view === "favorites")
          ),
          h("div", { className: "dshe-lib-groups" },
            h("div", { className: "dshe-lib-group-head" },
              h("span", null, "我的资料"),
              h("span", { className: "dshe-lib-group-count" }, String(personal.length))),
            personal.map(spaceBlock),
            h("div", { className: "dshe-lib-group-head" },
              h("span", null, "团队空间"),
              h("span", { className: "dshe-lib-group-count" }, String(team.length))),
            team.map(spaceBlock)
          ),
          ready === false
            ? h("div", { className: "dshe-lib-offline" }, "在线未启用 · 工作台数据仍走本地")
            : h("div", { className: "dshe-lib-online" }, "在线已连接 · 文档 " + String(spaces.reduce((n, s2) => n + Number(s2.nodeCount || 0), 0)))
        );
      }

      function rowOf(node, metaText, onClick, extra) {
        const type = String(node.nodeType || "").toUpperCase();
        return h("div", {
          key: "row-" + String(node.id || node.nodeId),
          className: "dshe-lib-row",
          role: "button",
          tabIndex: 0,
          onClick: onClick,
          onKeyDown: (event) => { if (event && event.key === "Enter") onClick(); }
        },
          h("span", { className: "dshe-lib-ico dshe-lib-ico-" + libTypeClass(type) },
            h(Icon, { name: libTypeIcon(type), size: 18 })),
          h("div", { className: "dshe-lib-row-main" },
            h("div", { className: "dshe-lib-name" }, String(node.name || node.nodeName || "未命名")),
            h("div", { className: "dshe-lib-meta" }, metaText)
          ),
          extra === undefined ? null : extra
        );
      }

      function nodeMeta(node) {
        const type = String(node.nodeType || "").toUpperCase();
        const parts = [libTypeText(type)];
        if (node.version !== undefined) parts.push("v" + String(node.version));
        if (node.updatedAt) parts.push(String(node.updatedAt));
        if (node.spaceName) parts.push(String(node.spaceName));
        return parts.join(" · ");
      }

      function renderList() {
        const isVirtual = view === "favorites" || view === "shares" || view === "recent" || view === "search";
        const rows = isVirtual ? items : childrenOf(spaceId, selId);
        const title = isVirtual ? listTitle : selName;
        const crumb = h("div", { className: "dshe-lib-crumb" },
          h("span", { className: "dshe-lib-crumb-space" }, String(spaceName || "资料库")),
          h("span", { className: "dshe-lib-crumb-sep" }, "/"),
          h("span", { className: "dshe-lib-crumb-now" }, title),
          h("span", { className: "dshe-lib-crumb-actions" },
            view === "shares"
              ? h("span", { className: "dshe-lib-tabs" },
                  h("button", {
                    type: "button", className: "dshe-lib-tab" + (shareTab === "out" ? " dshe-lib-tab-on" : ""),
                    onClick: () => loadShares("out")
                  }, "我发出的"),
                  h("button", {
                    type: "button", className: "dshe-lib-tab" + (shareTab === "in" ? " dshe-lib-tab-on" : ""),
                    onClick: () => loadShares("in")
                  }, "收到的"))
              : null,
            view === "favorites"
              ? h("select", {
                  className: "dshe-lib-select", value: String(favGroupId),
                  onChange: (event) => {
                    const next = Number((event && event.target && event.target.value) || 0);
                    setFavGroupId(next);
                    loadFavorites(next);
                  }
                }, h("option", { value: "0" }, "全部"),
                  favGroups.map((group) => h("option", { key: "fg-" + String(group.id), value: String(group.id) },
                    String(group.name) + "（" + String(group.count || 0) + "）")))
              : null,
            isVirtual
              ? h("button", { type: "button", className: "dshe-btn", onClick: () => setView("list") }, "返回浏览")
              : null,
            !isVirtual
              ? h("button", { type: "button", className: "dshe-btn", onClick: refreshCurrent }, "刷新")
              : null
          )
        );
        const body = view === "shares"
          ? rows.map((item) => rowOf(
              { id: item.nodeId, name: item.nodeName, nodeType: item.nodeType },
              [String(item.permission).toUpperCase() === "WRITE" ? "可写" : "只读",
                item.hasPassword === true ? "有密码" : "无密码",
                item.expired === true ? "已过期" : "有效",
                String(item.createdAt || "")].filter(Boolean).join(" · "),
              () => openNode({ id: item.nodeId, name: item.nodeName, nodeType: item.nodeType }),
              h("span", { className: "dshe-lib-row-actions" },
                h("button", {
                  type: "button", className: "dshe-btn",
                  onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); copyText(shareUrlOf(item.token)); }
                }, "复制链接"),
                h("button", {
                  type: "button", className: "dshe-btn",
                  onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); doDeleteShare(item.id); }
                }, "取消"))
            ))
          : rows.map((node) => rowOf(node, nodeMeta(node), () => openNode(node), null));

        return h("div", { className: "dshe-lib-main" },
          crumb,
          errorText !== "" ? h("div", { className: "dshe-lib-error", role: "status" }, errorText) : null,
          h("div", { className: "dshe-lib-card" },
            rows.length === 0
              ? h("div", { className: "dshe-lib-empty" },
                  h("div", { className: "dshe-lib-empty-title" }, loading === true ? "加载中…" : "这里还没有内容"),
                  h("div", { className: "dshe-lib-meta" }, loading === true ? "正在读取在线资料库" : "点左侧「新建」创建第一个文档或目录"))
              /* 必须渲染映射后的元素数组 body；直接把 rows（原始节点对象）当子元素
                 会让 React 抛「Objects are not valid as a React child」并卸载整个面板。 */
              : body
          )
        );
      }

      /* ---------------- 编辑器 ---------------- */

      /**
       * 版式级预览 / 编辑：iframe 只指向插件自身同源的 /khub/office/frame，
       * 页面由服务端带 PAT 取 OnlyOffice config 后内联生成，面板 state 不接触 token。
       * sandbox 必须带 allow-same-origin：OnlyOffice 编辑器内部还会再嵌一层 iframe
       * 指向 Document Server，缺了它 localStorage / postMessage 会异常。
       * mode 进 src 与 key：切换 view/edit 时重建 iframe，避免复用旧文档的编辑器实例。
       * @returns {any} React 元素
       */
      function renderOfficeFrame() {
        const frameMode = officeFrameMode === "edit" ? "edit" : "view";
        const label = frameMode === "edit" ? "版式编辑" : "版式预览";
        return h("div", { className: "dshe-office-frame" },
          h("div", { className: "dshe-office-frame-bar" },
            h("span", { className: "dshe-office-frame-title" },
              label + " · " + String(editing.name || "") +
              (officeNodeVersion === null || officeNodeVersion === undefined ? "" : " · 在线 v" + String(officeNodeVersion))),
            h("button", {
              type: "button", className: "dshe-btn",
              onClick: () => switchOfficeToLight(Number(editing.id))
            }, "切换轻量视图")
          ),
          officeFrameError !== ""
            ? h("div", { className: "dshe-lib-error", role: "status" }, officeFrameError)
            : null,
          h("iframe", {
            key: "dshe-office-frame-" + String(editing.id) + "-" + String(editing.mode) + "-" + frameMode,
            ref: officeFrameRef,
            className: "dshe-office-frame-iframe",
            title: label + "：" + String(editing.name || ""),
            src: API + "/khub/office/frame?id=" + encodeURIComponent(String(editing.id)) +
              "&mode=" + encodeURIComponent(frameMode),
            sandbox: "allow-same-origin allow-scripts allow-forms allow-popups allow-downloads",
            style: { width: "100%", height: "100%", border: 0 }
          })
        );
      }

      function renderEditorBody() {
        const type = String(editing.nodeType || "").toUpperCase();
        if (editing.mode === "office-frame") return renderOfficeFrame();
        if (editing.mode === "office") return renderOffice();
        if (editing.mode === "image") {
          return h("div", { className: "dshe-lib-image" },
            h("img", { src: API + "/khub/raw?id=" + encodeURIComponent(String(editing.id)), alt: editing.name }));
        }
        if (editing.mode === "file") {
          return h("div", { className: "dshe-lib-file" },
            h("iframe", {
              className: "dshe-lib-frame",
              src: API + "/khub/raw?id=" + encodeURIComponent(String(editing.id)),
              sandbox: "allow-scripts allow-forms allow-popups", title: editing.name
            }),
            h("p", { className: "dshe-lib-meta" }, "浏览器能内嵌显示的类型（如 PDF、纯文本）会直接展示；其它类型请点「下载」。")
          );
        }
        if (editing.mode === "grid") {
          const matrix = Array.isArray(editing.matrix) ? editing.matrix : [[]];
          const head = Array.isArray(matrix[0]) ? matrix[0] : [];
          return h("div", { className: "dshe-lib-grid-wrap" },
            h("table", { className: "dshe-lib-grid" },
              h("thead", null, h("tr", null, head.map((cell, col) => h("th", { key: "h-" + String(col) },
                h("input", {
                  className: "dshe-lib-grid-input dshe-lib-grid-head",
                  value: String(cell === null || cell === undefined ? "" : cell),
                  "aria-label": "第 " + String(col + 1) + " 列表头",
                  onChange: (event) => setCell(0, col, String((event && event.target && event.target.value) || ""))
                })
              )))),
              h("tbody", null, matrix.slice(1).map((row, index) => h("tr", { key: "r-" + String(index) },
                head.map((_, col) => h("td", { key: "c-" + String(col) },
                  h("input", {
                    className: "dshe-lib-grid-input",
                    value: String(row[col] === null || row[col] === undefined ? "" : row[col]),
                    "aria-label": "第 " + String(index + 2) + " 行第 " + String(col + 1) + " 列",
                    onChange: (event) => setCell(index + 1, col, String((event && event.target && event.target.value) || ""))
                  })
                ))
              )))
            )
          );
        }
        if (type === "HTML") {
          if (editing.mode === "html") {
            return h("iframe", {
              key: "lib-html-" + String(htmlKey),
              ref: htmlFrameRef,
              className: "dshe-lib-frame",
              sandbox: "allow-scripts allow-forms allow-modals allow-popups",
              src: API + "/khub/html?id=" + encodeURIComponent(String(editing.id)) + "&t=" + String(htmlKey),
              title: editing.name
            });
          }
          return h("textarea", {
            className: "dshe-lib-textarea", value: editing.content, spellCheck: false,
            "aria-label": "HTML 源码",
            onChange: (event) => setEditing(Object.assign({}, editing, {
              content: String((event && event.target && event.target.value) || ""), dirty: true
            }))
          });
        }
        if (editorMode === "rich" && type === "MD") return renderRich();
        if (editorMode === "preview") {
          return h("div", {
            className: "dshe-lib-md-view",
            onClick: onContentClick,
            dangerouslySetInnerHTML: { __html: markdownToHtml(editing.content, editing) }
          });
        }
        return h("textarea", {
          className: "dshe-lib-textarea", value: editing.content, spellCheck: false,
          "aria-label": "文档正文",
          onChange: (event) => setEditing(Object.assign({}, editing, {
            content: String((event && event.target && event.target.value) || ""), dirty: true
          }))
        });
      }

      function renderEditor() {
        if (editing === null) return renderList();
        const type = String(editing.nodeType || "").toUpperCase();
        const isMd = type === "MD";
        const isHtml = type === "HTML";
        const isCsv = type === "CSV";
        const canEditText = isMd || isHtml || editing.mode === "source";
        return h("div", { className: "dshe-lib-main" },
          h("div", { className: "dshe-lib-crumb" },
            h("button", { type: "button", className: "dshe-btn", onClick: backToList }, "← 返回"),
            h("span", { className: "dshe-lib-crumb-space" }, String(spaceName)),
            h("span", { className: "dshe-lib-crumb-sep" }, "/"),
            h("span", { className: "dshe-lib-crumb-now" }, editing.name)
          ),
          errorText !== "" ? h("div", { className: "dshe-lib-error", role: "status" }, errorText) : null,
          h("div", { className: "dshe-lib-editor" },
            h("div", { className: "dshe-lib-editor-head" },
              h("div", null,
                h("div", { className: "dshe-lib-name" }, editing.name),
                h("div", { className: "dshe-lib-meta" },
                  libTypeText(type) + " · v" + String(editing.version) + " · 节点 #" + String(editing.id) +
                  (editing.dirty === true ? " · 未保存" : ""))
              ),
              h("div", { className: "dshe-lib-editor-actions" },
                isMd
                  ? h("span", { className: "dshe-lib-modes" },
                      h("button", {
                        type: "button", className: "dshe-lib-mode" + (editorMode === "rich" ? " dshe-lib-mode-on" : ""),
                        onClick: () => { setEditorMode("rich"); setEditing(Object.assign({}, editing, { mode: "rich" })); }
                      }, "编辑"),
                      h("button", {
                        type: "button", className: "dshe-lib-mode" + (editorMode === "source" ? " dshe-lib-mode-on" : ""),
                        onClick: () => { setEditorMode("source"); setEditing(Object.assign({}, editing, { mode: "source" })); }
                      }, "源码"),
                      h("button", {
                        type: "button", className: "dshe-lib-mode" + (editorMode === "preview" ? " dshe-lib-mode-on" : ""),
                        onClick: () => { setEditorMode("preview"); setEditing(Object.assign({}, editing, { mode: "preview" })); }
                      }, "预览"))
                  : null,
                isHtml
                  ? h("span", { className: "dshe-lib-modes" },
                      h("button", {
                        type: "button", className: "dshe-lib-mode" + (editing.mode === "html" ? " dshe-lib-mode-on" : ""),
                        onClick: () => setEditing(Object.assign({}, editing, { mode: "html" }))
                      }, "预览"),
                      h("button", {
                        type: "button", className: "dshe-lib-mode" + (editing.mode === "source" ? " dshe-lib-mode-on" : ""),
                        onClick: () => setEditing(Object.assign({}, editing, { mode: "source" }))
                      }, "源码"),
                      h("button", {
                        type: "button", className: "dshe-lib-mode",
                        onClick: () => { setHtmlKey((value) => value + 1); setToast("已刷新预览"); }
                      }, "刷新"))
                  : null,
                isCsv
                  ? h("span", { className: "dshe-lib-modes" },
                      h("button", { type: "button", className: "dshe-lib-mode", onClick: addRow }, "加行"),
                      h("button", { type: "button", className: "dshe-lib-mode", onClick: addColumn }, "加列"))
                  : null,
                isHtml
                  ? h("button", {
                      type: "button", className: "dshe-btn",
                      title: "HTML 直链：实时页面 / 当前页分享（静态快照）",
                      onClick: () => setDialog("direct")
                    }, "直链")
                  : null,
                isCsv
                  ? h("button", {
                      type: "button", className: "dshe-btn dshe-btn-primary",
                      disabled: busy === true, onClick: doSaveMatrix
                    }, busy === true ? "保存中…" : "保存")
                  : null,
                canEditText
                  ? h("button", {
                      type: "button", className: "dshe-btn dshe-btn-primary",
                      disabled: busy === true, onClick: doSaveContent
                    }, busy === true ? "保存中…" : "保存")
                  : null,
                editing.mode === "office" && String(editing.nodeType || "").toUpperCase() !== "PPT"
                  ? h("button", {
                      type: "button", className: "dshe-btn dshe-btn-primary",
                      disabled: busy === true, onClick: saveOffice
                    }, busy === true ? "保存中…" : "保存为新版本")
                  : null,
                editing.mode === "image" || editing.mode === "file"
                  ? h("a", {
                      className: "dshe-btn",
                      href: API + "/khub/raw?id=" + encodeURIComponent(String(editing.id)) +
                        "&download=1&name=" + encodeURIComponent(editing.name),
                      download: editing.name
                    }, "下载")
                  : null,
                /* 版式预览 / 编辑：不显示轻量编辑的「保存为新版本」，只给下载。 */
                editing.mode === "office-frame"
                  ? h("a", {
                      className: "dshe-btn",
                      href: API + "/khub/raw?id=" + encodeURIComponent(String(editing.id)) +
                        "&download=1&name=" + encodeURIComponent(editing.name),
                      download: editing.name
                    }, "下载")
                  : null,
                /* 只读态且 frame 明确回报 canWrite=true 才给「编辑」入口；
                   切到 edit 后清掉旧标记，等新 frame 的 ready 再决定后续状态。 */
                editing.mode === "office-frame" && officeFrameMode === "view" && officeCanWrite === true
                  ? h("button", {
                      type: "button", className: "dshe-btn dshe-btn-primary",
                      onClick: () => { setOfficeFrameError(""); setOfficeCanWrite(false); setOfficeFrameMode("edit"); }
                    }, "编辑")
                  : null,
                editing.mode === "office-frame" && officeFrameMode === "edit"
                  ? h("button", {
                      type: "button", className: "dshe-btn",
                      onClick: () => { setOfficeFrameError(""); setOfficeCanWrite(false); setOfficeFrameMode("view"); }
                    }, "返回预览")
                  : null,
                editing.mode === "office-frame" && officeFrameMode === "edit"
                  ? h("span", { className: "dshe-lib-meta" }, "保存由在线资料库异步完成，关闭前请稍候")
                  : null,
              )
            ),
            isHtml && editing.mode === "html" && editing.dirty === true
              ? h("p", { className: "dshe-lib-meta" }, "源码已改动，点「保存」后预览才会更新到最新版本。")
              : null,
            renderEditorBody()
          )
        );
      }

      /* ---------------- 弹窗 ---------------- */

      function dialogShell(title, children, foot) {
        return h("div", {
          className: "dshe-mask",
          onClick: (event) => { if (event.target === event.currentTarget) setDialog(""); }
        },
          h("div", { className: "dshe-lib-dialog" + (title === "分享" || title === "版本历史" ? " dshe-lib-dialog-wide" : ""), role: "dialog", "aria-modal": "true" },
            h("div", { className: "dshe-lib-dialog-title" }, title),
            children,
            h("div", { className: "dshe-lib-dialog-foot" }, foot)
          )
        );
      }

      function renderDialog() {
        if (dialog === "") return null;
        if (dialog === "direct") {
          return editing === null ? null : h(DirectLinkDialog, {
            nodeId: editing.id,
            nodeName: editing.name,
            requestSnapshot: requestSnapshot,
            onClose: () => setDialog(""),
            onToast: (text) => setToast(text)
          });
        }
        if (dialog === "assets") {
          const assets = editing !== null && Array.isArray(editing.assets) ? editing.assets : [];
          const images = assets.filter((it) => String(it.nodeType || "").toUpperCase() === "IMAGE");
          const list = images.length === 0
            ? h("p", { className: "dshe-set-desc" }, "本文件下还没有图片。可以在在线资料库上传图片后回来再插。")
            : h("div", { className: "dshe-lib-assets" }, images.map((item) => {
                const src = API + "/khub/raw?id=" + String(item.id);
                return h("button", {
                  key: "asset-" + String(item.id),
                  type: "button",
                  className: "dshe-lib-asset",
                  title: String(item.relPath || item.name || ""),
                  onClick: () => {
                    insertHtml('<img class="dshe-lib-md-img" src="' + src + '" data-kb="' + String(item.id) + '" alt="' + String(item.name || "") + '">');
                    setDialog("");
                  }
                },
                  h("img", { className: "dshe-lib-asset-thumb", src: src, alt: String(item.name || "") }),
                  h("span", { className: "dshe-lib-asset-name" }, String(item.name || "")));
              }));
          return dialogShell("插入图片",
            h("div", { className: "dshe-lib-dialog-fields" }, list),
            h("button", { type: "button", className: "dshe-btn", onClick: () => setDialog("") }, "取消"));
        }
        if (dialog === "create") {
          return dialogShell("新建", h("div", { className: "dshe-lib-dialog-fields" },
            h("label", { className: "dshe-settings-field" },
              h("span", { className: "dshe-settings-label" }, "名称"),
              h("input", {
                className: "dshe-settings-input", value: createName, placeholder: "例如：本周计划",
                onChange: (event) => setCreateName(String((event && event.target && event.target.value) || ""))
              })),
            h("label", { className: "dshe-settings-field" },
              h("span", { className: "dshe-settings-label" }, "类型"),
              h("select", {
                className: "dshe-settings-input", value: createType,
                onChange: (event) => setCreateType(String((event && event.target && event.target.value) || "MD"))
              }, LIB_CREATE_TYPES.map((it) => h("option", { key: it.value, value: it.value }, it.label))))
          ), [
            h("button", { key: "c", type: "button", className: "dshe-btn", onClick: () => setDialog("") }, "取消"),
            h("button", { key: "o", type: "button", className: "dshe-btn dshe-btn-primary", disabled: busy === true, onClick: doCreate }, "创建")
          ]);
        }
        if (dialog === "rename") {
          return dialogShell("重命名", h("label", { className: "dshe-settings-field" },
            h("span", { className: "dshe-settings-label" }, "新名称"),
            h("input", {
              className: "dshe-settings-input", value: renameValue,
              onChange: (event) => setRenameValue(String((event && event.target && event.target.value) || ""))
            })
          ), [
            h("button", { key: "c", type: "button", className: "dshe-btn", onClick: () => setDialog("") }, "取消"),
            h("button", { key: "o", type: "button", className: "dshe-btn dshe-btn-primary", disabled: busy === true, onClick: doRename }, "保存")
          ]);
        }
        if (dialog === "delete") {
          const target = opNode !== null ? opNode : editing;
          return dialogShell("删除确认", h("p", { className: "dshe-set-desc" },
            "将删除「" + String(target === null ? "" : target.name) + "」及其所有子项。在线资料库的删除不可恢复，请确认。"
          ), [
            h("button", { key: "c", type: "button", className: "dshe-btn", onClick: () => setDialog("") }, "取消"),
            h("button", { key: "o", type: "button", className: "dshe-btn dshe-btn-danger", disabled: busy === true, onClick: doDelete }, "确认删除")
          ]);
        }
        if (dialog === "move") {
          const options = [];
          const walk = (nodes, depth) => {
            (Array.isArray(nodes) ? nodes : []).forEach((node) => {
              if (String(node.nodeType || "").toUpperCase() === "FOLDER") {
                options.push(h("option", { key: "mv-" + String(node.id), value: String(node.id) },
                  new Array(depth + 1).join("　") + String(node.name)));
                walk(node.children, depth + 1);
              }
            });
          };
          walk(treeOf(spaceId), 0);
          return dialogShell("移动到", h("div", { className: "dshe-lib-dialog-fields" },
            h("label", { className: "dshe-settings-field" },
              h("span", { className: "dshe-settings-label" }, "目标目录"),
              h("select", {
                className: "dshe-settings-input", value: String(moveTargetId),
                onChange: (event) => setMoveTargetId(Number((event && event.target && event.target.value) || 0))
              }, h("option", { value: "0" }, "空间根目录"), options))
          ), [
            h("button", { key: "c", type: "button", className: "dshe-btn", onClick: () => setDialog("") }, "取消"),
            h("button", { key: "o", type: "button", className: "dshe-btn dshe-btn-primary", disabled: busy === true, onClick: doMove }, "移动")
          ]);
        }
        if (dialog === "share") {
          const node = shareNode;
          const linkRow = (key, label, url) => h("div", { key: key, className: "dshe-lib-share-link" },
            h("span", { className: "dshe-lib-share-label" }, label),
            h("code", { className: "dshe-lib-share-url", title: url }, url),
            h("button", { type: "button", className: "dshe-btn", onClick: () => copyText(url) }, "复制"));
          return dialogShell("分享", h("div", { className: "dshe-lib-dialog-fields" },
            h("p", { className: "dshe-set-desc" },
              "分享「" + String(node === null ? "" : node.name) + "」：只读只能查看，可写能让对方直接改内容。有效期与访问密码都可以留空。HTML 页面的直链（实时页面 / 当前页静态快照）在顶栏「直链」里单独管理。"),
            /* 三个字段各自一列，输入框宽度不再被挤扁、placeholder 也能完整显示 */
            h("div", { className: "dshe-lib-share-form" },
              h("label", { className: "dshe-settings-field" },
                h("span", { className: "dshe-settings-label" }, "权限"),
                h("select", {
                  className: "dshe-settings-input", value: sharePerm,
                  onChange: (event) => setSharePerm(String((event && event.target && event.target.value) || "VIEW"))
                },
                  h("option", { value: "VIEW" }, "只读（可查看）"),
                  h("option", { value: "WRITE" }, "可写（可编辑）"))),
              h("label", { className: "dshe-settings-field" },
                h("span", { className: "dshe-settings-label" }, "有效期（小时）"),
                h("input", {
                  className: "dshe-settings-input", value: shareExpire, type: "number", min: "1",
                  placeholder: "留空 = 永久有效",
                  onChange: (event) => setShareExpire(String((event && event.target && event.target.value) || ""))
                })),
              h("label", { className: "dshe-settings-field" },
                h("span", { className: "dshe-settings-label" }, "访问密码"),
                h("input", {
                  className: "dshe-settings-input", value: sharePwd,
                  placeholder: "留空 = 不需要密码",
                  onChange: (event) => setSharePwd(String((event && event.target && event.target.value) || ""))
                }))),
            h("div", { className: "dshe-lib-share-actions" },
              h("button", {
                type: "button", className: "dshe-btn dshe-btn-primary",
                disabled: busy === true, onClick: doCreateShare
              }, busy === true ? "创建中…" : "新建分享")),
            h("div", { className: "dshe-lib-share-list" },
              shareList.length === 0
                ? h("div", { className: "dshe-lib-meta" }, "还没有分享链接，点上面的「新建分享」生成一个。")
                : shareList.map((item) => h("div", { key: "sh-" + String(item.id), className: "dshe-lib-share-card" },
                    h("div", { className: "dshe-lib-share-top" },
                      h("span", { className: "dshe-lib-name" },
                        String(item.permission).toUpperCase() === "WRITE" ? "可写" : "只读"),
                      item.hasPassword === true
                        ? h("span", { className: "dshe-lib-share-tag" }, "有密码")
                        : h("span", { className: "dshe-lib-share-tag" }, "免密码"),
                      item.expired === true
                        ? h("span", { className: "dshe-lib-share-tag dshe-lib-share-tag-warn" }, "已过期")
                        : null,
                      h("div", { className: "dshe-lib-row-actions" },
                        h("button", { type: "button", className: "dshe-btn", onClick: () => doToggleSharePerm(item) },
                          String(item.permission).toUpperCase() === "WRITE" ? "改只读" : "改可写"),
                        h("button", { type: "button", className: "dshe-btn dshe-btn-danger", onClick: () => doDeleteShare(item.id) }, "取消分享"))),
                    linkRow("url", "访问链接", shareUrlOf(item.token))
                  )))
          ), [h("button", { key: "c", type: "button", className: "dshe-btn", onClick: () => setDialog("") }, "关闭")]);
        }
        if (dialog === "versions") {
          return dialogShell("版本历史", h("div", { className: "dshe-lib-dialog-fields" },
            h("p", { className: "dshe-set-desc" }, "共 " + String(versionList.length) + " 个历史版本。查看可预览内容，回滚会把正文恢复成该版本（生成一个新版本）。"),
            h("div", { className: "dshe-lib-share-list" },
              versionList.length === 0
                ? h("div", { className: "dshe-lib-meta" }, "还没有历史版本")
                : versionList.map((item) => h("div", { key: "ver-" + String(item.versionNo), className: "dshe-lib-share-row" },
                    h("div", { className: "dshe-lib-share-main" },
                      h("div", { className: "dshe-lib-name" }, "v" + String(item.versionNo) + (item.remark ? " · " + String(item.remark) : "")),
                      h("div", { className: "dshe-lib-meta" },
                        String(item.editorName || "") + " · " + String(item.size || 0) + " 字节 · " + String(item.createdAt || ""))
                    ),
                    h("div", { className: "dshe-lib-row-actions" },
                      h("button", { type: "button", className: "dshe-btn", onClick: () => previewVersion(item.versionNo) }, "查看"),
                      h("button", { type: "button", className: "dshe-btn", disabled: busy === true, onClick: () => doRestoreVersion(item.versionNo) }, "回滚")
                    )
                  ))),
            versionPreview === null
              ? null
              : h("pre", { className: "dshe-lib-version-pre" }, String(versionPreview.content === undefined ? JSON.stringify(versionPreview, null, 2) : versionPreview.content))
          ), [h("button", { key: "c", type: "button", className: "dshe-btn", onClick: () => { setDialog(""); setVersionPreview(null); } }, "关闭")]);
        }
        return null;
      }

      /* ---------------- 下拉菜单：贴触发按钮弹出（不做居中弹窗） ---------------- */

      /**
       * 一个菜单项：图标 + 文案，横排。
       * @param {string} label 文案
       * @param {string} icon 图标名（ICON_SHAPES 里已有的名字）
       * @param {Function} onClick 点击回调
       * @param {boolean} [danger] 是否危险项（删除）
       * @returns {any} React 元素
       */
      function popItem(label, icon, onClick, danger) {
        return h("button", {
          key: "pi-" + label,
          type: "button",
          role: "menuitem",
          className: "dshe-lib-pop-item" + (danger === true ? " dshe-lib-pop-danger" : ""),
          onClick: onClick
        },
          h("span", { className: "dshe-lib-pop-ico" }, h(Icon, { name: icon, size: 14 })),
          h("span", { className: "dshe-lib-pop-label" }, label)
        );
      }

      function popSep(key) {
        return h("div", { key: "ps-" + key, className: "dshe-lib-pop-sep" });
      }

      /**
       * 菜单外壳：一层全透明遮罩（点空白关闭）+ 按视口坐标 fixed 定位的面板。
       * @param {string} key 前缀 key
       * @param {{left: number, top: number}|null} at 视口坐标
       * @param {Array<any>} children 菜单内容
       * @returns {Array<any>} 遮罩 + 面板
       */
      function popShell(key, at, children) {
        const pos = at === null ? { left: 16, top: 60 } : at;
        const close = () => { setMenuNode(null); setNewMenuAt(null); };
        return [
          h("div", {
            key: key + "-mask", className: "dshe-lib-pop-mask",
            onClick: close,
            /* 右键落在菜单外侧：关掉菜单，且不让浏览器默认菜单盖上来 */
            onContextMenu: (event) => {
              if (event && event.preventDefault) event.preventDefault();
              close();
            }
          }),
          h("div", {
            key: key + "-panel",
            className: "dshe-lib-pop",
            role: "menu",
            style: { left: String(pos.left) + "px", top: String(pos.top) + "px" },
            onClick: (event) => { if (event && event.stopPropagation) event.stopPropagation(); },
            onContextMenu: (event) => { if (event && event.preventDefault) event.preventDefault(); }
          }, children)
        ];
      }

      /** 侧栏「新建」菜单：只列后端真能创建的类型，不放假入口。 */
      function renderNewMenu() {
        if (newMenuAt === null || dialog !== "") return null;
        const mk = (label, icon, type) => popItem(label, icon, () => {
          setNewMenuAt(null);
          openCreate(type, selId);
        });
        return popShell("newmenu", newMenuAt, [
          mk("新建文档 (.md)", "file", "MD"),
          mk("新建表格 (.csv)", "list", "CSV"),
          mk("生成网页 (.html)", "book", "HTML"),
          popSep("a"),
          mk("新建文件夹", "layers", "FOLDER")
        ]);
      }

      /* ---------------- 节点的「···」菜单 ---------------- */

      function renderMenu() {
        if (menuNode === null || dialog !== "") return null;
        const isFolder = String(menuNode.nodeType || "").toUpperCase() === "FOLDER";
        const favOn = favIds[Number(menuNode.id)] === true;
        const rows = [];
        if (isFolder) {
          const createIn = (type) => () => {
            setMenuNode(null);
            selectFolder(menuNode);
            setCreateType(type);
            setCreateName("");
            setDialog("create");
          };
          rows.push(popItem("新建 Markdown", "file", createIn("MD")));
          rows.push(popItem("新建 CSV", "list", createIn("CSV")));
          rows.push(popItem("新建 HTML 页面", "book", createIn("HTML")));
          rows.push(popItem("新建子目录", "layers", createIn("FOLDER")));
          rows.push(popSep("a"));
        }
        rows.push(popItem("重命名", "tag", () => {
          setOpNode(menuNode);
          setMenuNode(null);
          setRenameValue(String(menuNode.name || ""));
          setDialog("rename");
        }));
        rows.push(popItem(favOn ? "取消收藏" : "加入收藏", "star", () => toggleFav(menuNode)));
        rows.push(popItem("分享", "users", () => openShare(menuNode)));
        rows.push(popItem("历史版本", "copy", () => openVersions(menuNode)));
        rows.push(popItem("移动到…", "download", () => openMove(menuNode)));
        rows.push(popSep("b"));
        rows.push(popItem("删除", "close", () => {
          setOpNode(menuNode);
          setMenuNode(null);
          setDialog("delete");
        }, true));
        return popShell("nodemenu", menuAt, rows);
      }

      return h("div", { className: "dshe-root dshe-root-lib" },
        h("div", { className: "dshe-body dshe-lib" },
          renderSide(),
          /* 分隔条：拖动改左栏宽度，双击复位，← → 可键盘微调；收起时不渲染 */
          libSideCollapsed === true ? null : h("div", {
            key: "lib-resizer",
            className: "dshe-lib-resizer",
            role: "separator",
            "aria-orientation": "vertical",
            "aria-label": "拖动调整资料库侧栏宽度",
            "aria-valuemin": LIB_SIDE_WIDTH_MIN,
            "aria-valuemax": LIB_SIDE_WIDTH_MAX,
            "aria-valuenow": libSideWidth,
            tabIndex: 0,
            title: "拖动调整宽度，双击恢复默认",
            onMouseDown: startLibResize,
            onDoubleClick: resetLibWidth,
            onKeyDown: onLibResizeKey
          }),
          view === "edit" ? renderEditor() : renderList()
        ),
        renderDialog(),
        renderMenu(),
        renderNewMenu(),
        toast !== null ? h("div", { className: "dshe-toast" }, toast) : null
      );
    }

    function WorkbenchPanel() {
      const [toast, setToast] = useState(null);

      /* 与主面板一致的 toast 自动消失节奏。 */
      useEffect(() => {
        if (toast === null) return undefined;
        const timer = setTimeout(() => setToast(null), 3200);
        return () => clearTimeout(timer);
      }, [toast]);

      /* 注册工作台 toast sink：谁后挂载谁生效，cleanup 置 null，不弹两份。 */
      useEffect(() => {
        setWorkbenchToastSink(setToast);
        return () => setWorkbenchToastSink(null);
      }, []);

      return h("div", { className: "dshe-root dshe-root-wb" },
        /* 无面板头：页面第一行直接是「当前工作台名称 + 操作按钮」，不再有
           「个人工作台」大标题与功能说明副标题。 */
        h("div", { className: "dshe-body" },
          h(WorkbenchView, { onToast: setToast })
        ),
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
    /** `/` 技能触发源的注册结果（中文诊断串，供 `__expertHubDiag()` 与降级排查使用）。 */
    var skillTriggerStatus = "未注册";
    /** `@` 工作台指令源的注册结果（与技能源互不影响，供 `__expertHubDiag()` 如实上报）。 */
    var workbenchTriggerStatus = "未注册";
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
     * 宿主是否具备「新建会话」的能力。与 canSwitchSession() 相互独立：
     * 只要 sessions.create 可用，就能建出一个没有专家注入历史的新会话并把
     * 专家挂上去（后端 /attach 对该新 id 不会命中 SESSION_EXPERT_LOCKED）；
     * open/select 只决定要不要自动把主视图切过去，缺失时用户仍可在左侧会话
     * 列表点开新会话。实测宿主常见「能 create、没有 open」的裁剪版 face，
     * 不能因为不能自动切换就误判为「不能新建会话」。
     * @returns {boolean} 是否可创建会话
     */
    function canCreateSession() {
      return sessions !== null && sessions !== undefined && typeof sessions.create === "function";
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

    /** 智聊「打开与它的会话」桥：applyComposer 就绪后注入 create/open/show 三能力。 */
    var zhiliaOpenChatBridge = null;

    /** 宿主跨 workspace 导航服务：apply() 时从 ctx 读取，优先用它选中新会话。 */
    var zhiliaUiWorkspace = null;
    /** 宿主 workspaceNavigation.openWorkspace：在指定工作区打开会话（顶部"选择工作区"用的就是它）。 */
    var zhiliaWorkspaceNav = null;

    /**
     * 宿主 sessions.create() 返回值兼容解析：string / {sessionId} / {value:{sessionId}}。
     * 与 startSummon 里的 createdId 同逻辑，抽到模块级给智聊按钮复用。
     * @param {any} result create 返回值
     * @returns {string} 会话 id，解析失败为空串
     */
    function zhiliaCreatedId(result) {
      if (typeof result === "string" && result !== "") return result;
      if (result !== null && typeof result === "object") {
        if (result.ok === false) return "";
        const value = result.value;
        if (value !== null && typeof value === "object" && typeof value.sessionId === "string") return value.sessionId;
        if (typeof result.sessionId === "string") return result.sessionId;
      }
      return "";
    }

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
     * @param {{ onToast: Function, onClose: Function, onFallbackCopy?: Function, forceNewSession?: boolean }} hooks UI 回调
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
            /* 会话注入历史命中：绝不再挂回旧会话（新旧专家的子智能体会混在一起）。
               新会话理论上不会命中，这里是防御式兜底，防止宿主降级路径又挂回原会话。 */
            if (res !== null && res !== undefined && res.code === "SESSION_EXPERT_LOCKED") {
              hooks.onToast("该会话已注入过专家/专家团，请新建会话后再选择");
              return false;
            }
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

      /* 「能否新建会话」与「能否切换会话」是两件事，别再混为一谈：
         sessions.create 决定能不能建出一个没有专家注入历史的新会话并把专家
         挂上去；open/select 只决定要不要自动把主视图切过去，缺失时用户仍可
         在左侧会话列表点开新会话。实测宿主常见「能 create、没有 open」的
         裁剪版 face，此前把「不能自动切换」等同于「不能新建会话」，于是强制
         新会话模式直接放弃并弹失败提示（用户反馈「不能新建一个会话吗」）。 */
      if (hooks.forceNewSession === true) {
        /* 强制新会话（删了专家再选、命中会话注入锁时走这里）：只看 create。
           连 create 都没有才是真的「宿主不支持新建会话」。 */
        if (canCreateSession() === false) {
          hooks.onToast("宿主不支持新建会话：请手动新建会话后再选择专家/专家团");
          return;
        }
        /* 能 create：落到下方 create() → attachTo(newSid) 流程。不降级挂回当前
           会话（会命中历史锁），也不因不能自动切换而放弃；切换能力缺失由
           openSessionSafe 静默处理。 */
      } else if (canSwitchSession() === false) {
        /* 非强制模式沿用原有降级语义：宿主没有选中会话的能力时，create() 出来
           的新会话永远不会被打开，专家挂上去用户根本看不到（用户反馈「专家
           跳转，没有出现专家」）。降级为直接挂到当前会话：dock 里立刻出现
           chip，语义从「开新会话」变成「挂到本会话」，并明确告知用户原因。 */
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
        /* 强制新会话模式：create() 已成功，新会话没有专家注入历史，attach 必然
           成功；能否自动切换只影响视图跳转，切换缺失/失败一律静默（不弹失败
           toast），用户可在左侧会话列表点开新会话，绝不挂回当前会话（会命中
           历史锁）。非强制模式：运行时切换仍失败（例如 manager.select 抛错）
           则回退挂到当前会话，保证 dock 里能看见。 */
        if (switched === false && hooks.forceNewSession !== true) {
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
    /** ctx.inject 回调是否执行过（诊断「专家选择不显示」：回调没跑则三个槽都没注册）。 */
    var slotsInjectStarted = false;
    /** 槽位注入相关错误记录，供 __expertHubDiag() 排查。 */
    var slotInjectErrors = [];
    /** overlay 组件晚于按钮挂载时的重试节奏（毫秒）与去重标记。 */
    var pickerRetryDelays = [120, 400, 1000];
    var pickerRetryPending = false;
    var dockMultiWarned = false;
    /** 会话通知桥：applyComposer 里挂上 notifySession，供模块层组件提示用。 */
    var expertNotify = null;
    /** 草稿引用插入桥：二级菜单选技能/连接器时插入结构化 chip（不插文本提示词）。 */
    var pickerInsertRef = null;

    /** 已安装技能只读快照：由 Panel 的 refreshInstalledSkills() 写入，供工具栏选择器校验。 */
    var installedSkillRows = [];

    /**
     * 从已安装技能快照里找 `/pick` 技能条目对应的宿主原生技能记录。
     *
     * `/pick` 的 skill 条目 id 是仓库相对路径（`skills/<集合>/<名字>`），既没有
     * `dir` 也没有 `slug`，所以按末段（basename）与展示名分别净化后与 `row.dir`
     * 比对（大小写不敏感）；命中后才允许插入 `skill:<dir>`。
     * @param {any} entry 选择器条目
     * @returns {any|null} 已安装记录；未安装返回 null
     */
    function installedRowForPicker(entry) {
      const safeEntry = entry === null || entry === undefined ? {} : entry;
      const rawId = trimmed(safeEntry.id);
      const segments = rawId.split(/[\\/]/).filter((seg) => seg !== "");
      const base = segments.length > 0 ? segments[segments.length - 1] : rawId;
      const name = trimmed(safeEntry.name) || base;
      const byId = skillDirNameOfClient(base).toLowerCase();
      const byName = skillDirNameOfClient(name).toLowerCase();
      if (byId === "" && byName === "") return null;
      const hit = installedSkillRows.find((row) => row !== null && row !== undefined &&
        (trimmed(row.dir).toLowerCase() === byId || trimmed(row.dir).toLowerCase() === byName));
      return hit === undefined ? null : hit;
    }

    /** 最近一次插入引用失败的原因（供 toast 透出）。 */
    var lastInsertError = "";

    /**
     * 请求打开专家选择面板。
     * @returns {void}
     */
    function togglePickerOpen() {
      if (typeof pickerOpenSetter !== "function") return false;
      /* 每次点击都从一级分类开始；已打开时再点则关闭（toggle 直觉）。 */
      pickerOpenSetter((prev) => (prev === true ? false : true));
      return true;
    }

    /**
     * 请求打开专家选择面板。
     *
     * overlay 槽组件可能晚于工具栏按钮挂载（宿主切换会话 / 重建 composer 时尤其常见）。
     * 旧实现在 setter 为空时只 console.warn 一次，之后被 pickerWarned 门闩吞掉，
     * 用户看到的就是「点按钮没反应、专家选择不显示」。现在做有限重试；彻底失败时
     * 只在控制台留可诊断的告警（不弹 toast —— 用户明确要求不要提示）。
     * @returns {void}
     */
    function openExpertPicker() {
      if (togglePickerOpen() === true) return;
      if (pickerRetryPending === true) return;
      pickerRetryPending = true;
      let attempt = 1;
      const retry = () => {
        if (typeof pickerOpenSetter === "function") {
          pickerRetryPending = false;
          togglePickerOpen();
          return;
        }
        if (attempt < pickerRetryDelays.length) {
          const delay = pickerRetryDelays[attempt];
          attempt += 1;
          try { setTimeout(retry, delay); } catch { pickerRetryPending = false; }
          return;
        }
        pickerRetryPending = false;
        try {
          console.warn("[dsh-buddy-expert-hub] 专家选择器 overlay 槽未挂载（已重试 " +
            String(pickerRetryDelays.length) + " 次）；请执行 __expertHubDiag() 查看 pickerMounted / slotsInjectStarted");
        } catch { /* 忽略 */ }
      };
      try { setTimeout(retry, pickerRetryDelays[0]); } catch { pickerRetryPending = false; }
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
              className: "dshe-hub-get dshe-hub-hero-get" + (done ? "" : " dshe-add-btn"),
              disabled: done || installing,
              "aria-label": (done ? "已安装 " : installing ? "获取中 " : "获取 ") + String(props.name || props.slug),
              onClick: () => doInstall(props.slug)
            }, done ? "已安装" : (installing
              ? h("span", { className: "dshe-spin" })
              : h(Icon, { name: "plus", size: 15 })))
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
     * 已安装技能库视图（技能页统一工具栏的「已安装」视图）。
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
        const label = skillDisplayNameOf(it) || String(it.dir);
        const version = versionLabel(it.version);
        const color = skillTileColor(label);
        return h("div", { key: it.dir, className: "dshe-inst-card", "data-skill-dir": it.dir },
          h(SkillIconTile, { icon: it.icon, name: label, color: color, className: "dshe-inst-tile" }),
          h("div", { className: "dshe-inst-info" },
            h("div", { className: "dshe-inst-name", title: label },
              label,
              it.source === "market" ? h("span", { className: "dshe-inst-tag" }, "市场") : null,
              version !== "" ? h("span", { className: "dshe-skill-ver", title: "版本 " + version }, version) : null
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
            "aria-label": (it.enabled !== false ? "关闭 " : "开启 ") + label,
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
          ? h("div", { className: "dshe-hub-state" },
              "还没有安装任何技能：点右上「添加技能」从文件夹导入，或去「仓库技能」「SkillHub 商店」点 + 安装")
          : sections.length === 0
            ? h("div", { className: "dshe-hub-state" }, "没有匹配「" + query + "」的技能")
            : sections.map((section) => h("div", { key: section.id, className: "dshe-inst-group" },
                h("h3", { className: "dshe-inst-group-title" }, section.label + " (" + String(section.rows.length) + ")"),
                h("div", { className: "dshe-inst-grid" }, section.rows.map(row))
              ))
      );
    }

    /**
     * SkillHub 商店视图（技能块下的第二个子分组，也是统一工具栏的「云端」视图）。
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
              className: done ? "dshe-card-apply" : "dshe-hub-get dshe-add-btn",
              disabled: busy,
              "aria-label": (done ? "引用 " : "获取 ") + item.name,
              onClick: (event) => {
                event.stopPropagation();
                if (done) props.onApply(item);
                else doInstall(item);
              }
            }, done
              ? h(Icon, { name: "chat", size: 15 })
              : (busy ? h("span", { className: "dshe-spin" }) : h(Icon, { name: "plus", size: 15 })))
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
      /* 已连接 id（来自 /connectors/connected）：选择器据此判断能否直接 /attach。 */
      const [connectedIds, setConnectedIds] = useState([]);
      /* 需先完成连接的连接器：与列表页共用同一个连接弹窗。 */
      const [connectTarget, setConnectTarget] = useState(null);
      /* 连接完成后重拉 /pick，刷新条目里的 connected 标记。 */
      const [pickNonce, setPickNonce] = useState(0);
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

      /* 打开时同步「已连接」列表：选择器与列表页用同一份连接状态，避免绕过参数收集。 */
      useEffect(() => {
        if (!open) return;
        fetchJson("/connectors/connected")
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true && Array.isArray(res.ids)) {
              setConnectedIds(res.ids.map((id) => String(id)));
            }
          })
          .catch(() => { /* 拉取失败不阻断选择器，条目里还有 /pick 的 connected 标记兜底 */ });
      }, [open, pickNonce]);

      /* 打开时刷新「已安装技能」只读快照：选择器不在 Panel 组件树里，拿不到 Panel
         的 useState，必须自己拉一次 /skills/installed，才能用 row.dir / row.enabled
         校验技能引用。安装 / 开关后重开选择器即生效；响应异常时保留上一次快照。 */
      useEffect(() => {
        if (!open) return undefined;
        let cancelled = false;
        fetch(API + "/skills/installed", { headers: { Accept: "application/json" } })
          .then((resp) => resp.json())
          .then((res) => {
            if (cancelled) return;
            if (res !== null && res !== undefined && res.ok === true && Array.isArray(res.items)) {
              installedSkillRows = res.items;
            }
          })
          .catch(() => { /* 保留上一次快照，不阻断选择器 */ });
        return () => { cancelled = true; };
      }, [open, pickNonce]);

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
         agent / team），技能与连接器各自成组。
         `installed=1`：面板从专家按钮进入，只列**已安装**的专家 / 专家团 / 技能 / 连接器
         （过滤在服务端做，技能有数千条，前端过滤既慢又多一次全量下发）。 */
      useEffect(() => {
        if (!open || level !== "list") return undefined;
        const controller = new AbortController();
        const timer = setTimeout(() => {
          setLoading(true);
          setErrorText("");
          fetch(API + "/pick?q=" + encodeURIComponent(query) + "&limit=20&installed=1", {
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
                  const mapped = {
                    id: String(entry.id || ""),
                    name: String(entry.name || entry.id || ""),
                    avatar: typeof entry.avatar === "string" ? entry.avatar : "",
                    profession: typeof entry.profession === "string" ? entry.profession : "",
                    type: group.kind
                  };
                  /* 技能条目：后端在 installed=1 下会额外下发 dir（宿主原生技能名）
                     与 enabled，直接透传，省掉前端二次解析；老响应没有这两个字段时
                     choose() 会回落到 installedRowForPicker(entry) 兜底。 */
                  if (group.kind === "skill") {
                    if (typeof entry.dir === "string") mapped.dir = entry.dir;
                    if (typeof entry.enabled === "boolean") mapped.enabled = entry.enabled;
                    if (typeof entry.version === "string") mapped.version = entry.version;
                  }
                  /* 只透传后端确实下发的连接元数据；老数据完全没有这些字段时
                     connectorSetupOf 会走 legacy 兼容分支，行为与改版前一致。 */
                  if (group.kind === "connector") {
                    if (typeof entry.needsSetup === "boolean") mapped.needsSetup = entry.needsSetup;
                    if (typeof entry.authMode === "string") mapped.authMode = entry.authMode;
                    if (Array.isArray(entry.requiredParams)) mapped.requiredParams = entry.requiredParams;
                    if (Array.isArray(entry.optionalParams)) mapped.optionalParams = entry.optionalParams;
                    if (Array.isArray(entry.paramFields)) mapped.paramFields = entry.paramFields;
                    if (entry.setupSchema !== null && typeof entry.setupSchema === "object") {
                      mapped.setupSchema = entry.setupSchema;
                    }
                    if (typeof entry.oauthReady === "boolean") mapped.oauthReady = entry.oauthReady;
                    if (typeof entry.connected === "boolean") mapped.connected = entry.connected;
                  }
                  merged.push(mapped);
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
      }, [open, level, category, expertKind, query, pickNonce]);

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
        /* 技能保持一次性引用语义：插入结构化 chip，不插文本提示词。
           与列表页 applyToConversation 同一口径：必须已安装且开启，并用宿主
           原生技能名 row.dir 作 / 指令名，绝不把仓库相对路径塞进 ref。 */
        if (entry.type === "skill") {
          const label = trimmed(entry.name) || String(entry.id);
          /* 后端 `installed=1` 时已下发 dir / enabled，直接用；老响应 / 老缓存里
             没有这两个字段时回落到本地快照 installedRowForPicker(entry) —— 兜底
             不能删：缓存与旧版本后端都还可能没有 dir。 */
          const declaredDir = trimmed(entry.dir);
          const row = declaredDir !== ""
            ? { dir: declaredDir, enabled: entry.enabled !== false }
            : installedRowForPicker(entry);
          if (row === null) {
            setErrorText("「" + label + "」还没安装：先点卡片上的 + 安装到本地技能库");
            return;
          }
          if (row.enabled === false) {
            setErrorText("「" + label + "」已关闭：到「已安装」里开启后再引用");
            return;
          }
          const refId = trimmed(row.dir);
          const inserted = typeof pickerInsertRef === "function"
            ? pickerInsertRef(sessionId, entry.type, refId, entry.name) : false;
          if (inserted === true) {
            setOpen(false);
          } else {
            setErrorText("插入引用失败，请在输入框输入 / 选择技能，或到列表页点技能卡片的引用气泡");
          }
          return;
        }
        /* 连接器与专家同款：挂到本会话 system prompt，dock 里常驻图标 chip，可多选。
           这里必须走 /attach —— 之前这一支还在走 insertReference 一次性引用，
           所以从输入框选择器里选连接器时，工具栏里根本不会出现 chip。 */
        if (entry.type === "connector") {
          const connectorId = String(entry.id);
          const attached = selectedConnectorIds.indexOf(connectorId) >= 0;
          const setup = connectorSetupOf(entry);
          const alreadyConnected = connectedIds.indexOf(connectorId) >= 0 || entry.connected === true;
          /* 与列表页 connectConnector 同一套状态机：需设置且未连接时先开连接弹窗，
             绝不把带 ${VAR} 占位符的无效 MCP 配置挂进会话。免认证 / 已连接照常放行。 */
          if (attached === false && setup.needsSetup === true && setup.legacy === false && alreadyConnected === false) {
            setConnectTarget(entry);
            return;
          }
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
                /* 列表页的「已连接」态同步登记/清除，两处入口行为一致。
                   登记失败不能静默吞掉：给可读提示并广播对账，避免「会话挂上了、列表还是 +」。 */
                fetch(API + (attached ? "/connectors/disconnect" : "/connectors/connect"), {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id: connectorId })
                })
                  .then((resp) => resp.json())
                  .then((registerRes) => {
                    if (attached === false && (registerRes === null || registerRes === undefined || registerRes.ok !== true)) {
                      const failure = "已挂到本会话，但连接状态登记失败：" +
                        String((registerRes && (registerRes.error || registerRes.message)) || "未知错误");
                      if (typeof expertNotify === "function") expertNotify(sessionId, failure, "error");
                    }
                    try { window.dispatchEvent(new CustomEvent("dsh-buddy-expert-hub:connections-changed")); } catch { /* 忽略 */ }
                  })
                  .catch(() => {
                    try { window.dispatchEvent(new CustomEvent("dsh-buddy-expert-hub:connections-changed")); } catch { /* 忽略 */ }
                  });
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
            /* 防御式兜底：后端已撤销 SESSION_EXPERT_LOCKED 拦截（新建会话不会
               自动成为当前会话，用户看不到 chip），此分支正常情况下不会命中。
               新专家因此不会与旧专家的子智能体、历史消息混在同一上下文里
               （实测「chip 换了但 AI 还在给 design-system-expert 发消息」即由此而来）。
               startSummon 与 ExpertPicker 同处模块作用域，直接复用 create→open→attach。 */
            if (res !== null && res !== undefined && res.code === "SESSION_EXPERT_LOCKED") {
              setOpen(false);
              if (typeof startSummon === "function") {
                startSummon({
                  id: entry.id,
                  type: entry.type === "team" ? "team" : "agent",
                  displayName: entry.name || entry.id,
                  name: entry.name || entry.id
                }, {
                  onToast: (msg) => {
                    /* 成功路径不弹提示；仅 create 真不可用等失败时透出准确原因，
                       不再额外拼接旧的前缀（用户明确不要那个失败提示）。 */
                    const text = String(msg);
                    setErrorText(text);
                    if (typeof expertNotify === "function") expertNotify(sessionId, text, "error");
                  },
                  onClose: () => setOpen(false),
                  forceNewSession: true,
                  onFallbackCopy: () => setErrorText("该会话已注入过专家/专家团，请新建会话后再选择")
                });
              } else {
                setErrorText("该会话已注入过专家/专家团，请新建会话后再选择");
              }
              return;
            }
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
        /* 一级：三项可注入资源分类；二级：细分列表。Escape 在二级先返回一级。 */
        const count = level === "root" ? PICKER_GROUPS.length : items.length;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setCursor((value) => Math.min(value + 1, count - 1));
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          setCursor((value) => Math.max(value - 1, 0));
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (level === "root") {
            const group = PICKER_GROUPS[cursor];
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

      /* 一级：三大块可注入资源分类，各带原生 SVG 图标与 > 箭头。 */
      const rootRows = PICKER_GROUPS.map((group, index) => h("button", {
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
          versionLabel(entry.version) !== ""
            ? h("span", { className: "dshe-picker-ver" }, versionLabel(entry.version))
            : null,
          selected ? h("span", { className: "dshe-picker-check", "aria-hidden": "true" }, "✓") : null
        );
      });

      const groupLabel = category === "expert" ? "专家" : category === "skill" ? "技能" : "连接器";
      const placeholder = category === "expert" ? "搜索专家" : category === "skill" ? "搜索技能" : "搜索连接器";

      /* 空态：面板只列已安装的东西，一条都没有时必须告诉用户「为什么空 + 去哪装」，
         而不是干瘪的「没有匹配的」。文案按类型区分，按钮复用侧栏入口（同一个 openSidebarPanel）。 */
      const emptyHint = category === "expert"
        ? "还没有已安装的专家，先到面板里安装或导入"
        : category === "skill"
          ? "还没有已安装的技能，先到面板里安装"
          : "还没有已安装的连接器，先到面板里安装";
      const emptyNode = h("div", {
        className: "dshe-picker-empty",
        role: "status",
        "aria-live": "polite"
      },
        h("span", { className: "dshe-picker-empty-text" }, emptyHint),
        h("button", {
          type: "button",
          className: "dshe-picker-empty-btn",
          onClick: openSidebarPanel
        }, "打开面板安装")
      );

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
        /* 连接弹窗是 fixed 遮罩（z-index 1200）：把父级选择器一并抬到同一层级，
           否则遮罩会被困在选择器 z-index:120 的堆叠上下文里，压不住宿主其他浮层。 */
        style: connectTarget !== null ? { zIndex: 1300 } : undefined,
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
                      ? (trimmed(query) === ""
                          ? emptyNode
                          : h("div", { className: "dshe-picker-state" }, "没有匹配的" + groupLabel))
                      : visible
              ),
              category === "expert"
                ? h("div", { key: "foot", className: "dshe-picker-foot" },
                    h("button", { type: "button", className: "dshe-picker-more", onClick: openSidebarPanel }, "↗ 召唤更多专家")
                  )
                : null
            ],
        connectTarget !== null
          ? h(ConnectorConnectDialog, {
              key: "connect-" + String(connectTarget.id),
              item: connectTarget,
              onClose: () => setConnectTarget(null),
              onToast: (message) => {
                const notifySid = sid !== "" ? sid : resolveSessionId(null);
                if (typeof expertNotify === "function") expertNotify(notifySid, String(message), "info");
              },
              onConnected: (connectedId) => {
                setConnectedIds((prev) => prev.indexOf(connectedId) >= 0 ? prev : prev.concat([connectedId]));
                setPickNonce((value) => value + 1);
                try { window.dispatchEvent(new CustomEvent("dsh-buddy-expert-hub:connections-changed")); } catch { /* 忽略 */ }
              }
            })
          : null
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

    // =======================================================================
    // 个人工作台 `@` 指令：历史模板 + 纯函数（已停用触发源，仅留作离线回归）
    //
    // `@` 模板指令源与 workbench-creator 技能均已删除；创建工作台改走
    // 「在线工作台搭建师」专家。本区块只保留数据与纯函数供历史回归验证，
    // 不再注册任何输入触发源，也不产生技能引用。
    // =======================================================================

    /** 工作台指令源选中模板后派发的解耦事件：主资源面板收到即点开侧栏「个人工作台」面板。 */
    var WORKBENCH_OPEN_EVENT = "dsh-buddy-expert-hub:open-workbench";

    /** 目录同步结果 toast 事件：指令源不持有组件实例，用 sink / 事件解耦。 */
    var WORKBENCH_TOAST_EVENT = "dsh-buddy-expert-hub:workbench-toast";

    /** toast 接收器：模块级单一引用，谁后挂载谁生效；cleanup 置 null，不弹两份。 */
    var workbenchToastSink = null;

    /**
     * 注册 / 注销 toast 接收器（Panel 与 WorkbenchPanel 各自在 useEffect 里调用）。
     * @param {Function|null} fn 显示 toast 的函数；传 null 表示注销
     * @returns {void}
     */
    function setWorkbenchToastSink(fn) {
      workbenchToastSink = typeof fn === "function" ? fn : null;
    }

    /**
     * 发一条工作台 toast。优先调 sink；无 sink 才派发 CustomEvent；
     * 再无 window / CustomEvent 则静默跳过，绝不影响发送、绝不抛错。
     * @param {string} text 提示文案
     * @param {'info'|'error'} [level='info'] 级别（仅写入事件 detail，供接收方区分）
     * @returns {void}
     */
    function emitWorkbenchToast(text, level) {
      const value = String(text === null || text === undefined ? "" : text);
      const kind = level === "error" ? "error" : "info";
      try {
        if (typeof workbenchToastSink === "function") {
          workbenchToastSink(value);
          return;
        }
      } catch { /* sink 抛错不能影响发送 */ }
      try {
        if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" &&
            typeof window.CustomEvent === "function") {
          window.dispatchEvent(new window.CustomEvent(WORKBENCH_TOAST_EVENT, {
            detail: { text: value, level: kind }
          }));
        }
      } catch { /* 宿主禁用事件：静默跳过 */ }
    }

    /** 用户手填目录的长度上限（Windows MAX_PATH 量级），超出截断，防提示语注入。 */
    var WORKBENCH_DIR_LIMIT = 260;

    /**
     * 5 个静态工作台模板。字段与菜单声明与 docs/workbench-example.html 同口径：
     * tables[].fields[] 支持 key/label/type/required/options，menu[] 提供二级视图。
     * 只用于拼候选列表与提示语，不落盘、不发请求。
     */
    var WORKBENCH_TEMPLATES = [
      {
        id: "reading-log",
        name: "读书记录",
        table: "books.csv",
        description: "记录想读 / 在读 / 已读的书，含评分与备注",
        keywords: ["读书", "阅读", "书单", "books", "reading", "book"],
        fields: [
          { key: "title", label: "书名", type: "string", required: true },
          { key: "rating", label: "评分", type: "number" },
          { key: "status", label: "状态", type: "enum", options: ["想读", "在读", "已读"] },
          { key: "note", label: "备注", type: "string" }
        ],
        menu: [
          { id: "overview", label: "总览", view: "overview", prompt: "帮我汇总这个月的读书进度，按状态分组" },
          { id: "add", label: "添加记录", view: "add", prompt: "帮我在读书记录里新增一条读书记录" }
        ]
      },
      {
        id: "task-board",
        name: "任务看板",
        table: "tasks.csv",
        description: "按状态与优先级管理待办，支持截止日期",
        keywords: ["任务", "待办", "看板", "todo", "task", "kanban"],
        fields: [
          { key: "title", label: "任务", type: "string", required: true },
          { key: "status", label: "状态", type: "enum", options: ["待办", "进行中", "已完成"] },
          { key: "priority", label: "优先级", type: "enum", options: ["高", "中", "低"] },
          { key: "due", label: "截止日期", type: "date" },
          { key: "note", label: "备注", type: "string" }
        ],
        menu: [
          { id: "all", label: "全部任务", view: "all", prompt: "帮我列出当前所有未完成任务，按优先级排序" },
          { id: "today", label: "今日待办", view: "today", prompt: "帮我挑出今天到期的任务并排个顺序" }
        ]
      },
      {
        id: "expense",
        name: "家庭开支",
        table: "expenses.csv",
        description: "逐笔记录餐饮、交通、购物等开销并做月度汇总",
        keywords: ["开支", "记账", "消费", "账单", "expense", "budget", "money"],
        fields: [
          { key: "date", label: "日期", type: "date", required: true },
          { key: "category", label: "分类", type: "enum", options: ["餐饮", "交通", "购物", "居住", "娱乐", "其他"] },
          { key: "item", label: "项目", type: "string" },
          { key: "amount", label: "金额", type: "number", required: true },
          { key: "note", label: "备注", type: "string" }
        ],
        menu: [
          { id: "overview", label: "流水总览", view: "overview", prompt: "帮我汇总这个月的家庭开支，按分类分组" },
          { id: "monthly", label: "月度报表", view: "monthly", prompt: "帮我生成本月的开支报表，指出花得最多的分类" }
        ]
      },
      {
        id: "fitness",
        name: "健身打卡",
        table: "checkins.csv",
        description: "记录每次训练的项目、时长与强度，看趋势",
        keywords: ["健身", "运动", "打卡", "训练", "fitness", "workout", "checkin"],
        fields: [
          { key: "date", label: "日期", type: "date", required: true },
          { key: "activity", label: "项目", type: "string", required: true },
          { key: "duration", label: "时长(分钟)", type: "number" },
          { key: "intensity", label: "强度", type: "enum", options: ["低", "中", "高"] },
          { key: "note", label: "备注", type: "string" }
        ],
        menu: [
          { id: "overview", label: "打卡总览", view: "overview", prompt: "帮我统计这个月的训练次数和总时长" },
          { id: "trend", label: "趋势", view: "trend", prompt: "帮我画出近 8 周训练时长的变化趋势" }
        ]
      },
      {
        id: "blank",
        name: "自定义空白工作台",
        table: "data.csv",
        description: "最小可用骨架：名称 / 数值 / 标签 / 备注，字段与菜单可自行扩展",
        keywords: ["空白", "自定义", "通用", "blank", "custom", "template"],
        fields: [
          { key: "name", label: "名称", type: "string", required: true },
          { key: "value", label: "数值", type: "number" },
          { key: "tag", label: "标签", type: "string" },
          { key: "note", label: "备注", type: "string" }
        ],
        menu: [
          { id: "overview", label: "总览", view: "overview", prompt: "帮我概览这张表里的数据" },
          { id: "edit", label: "编辑数据", view: "edit", prompt: "帮我在这张表里新增一条记录" }
        ]
      }
    ];

    /**
     * 目录净化：逐字符丢掉控制字符（含换行、制表符）、尖括号、反引号与竖线，
     * 再限制长度。竖线是 ref 的分隔符，必须过滤，否则 serialize 解析会错位。
     * @param {any} raw 原始路径
     * @returns {string} 净化后的路径；非法输入返回空串
     */
    function sanitizeWorkbenchDir(raw) {
      const input = String(raw === null || raw === undefined ? "" : raw);
      const banned = "<>`|";
      let out = "";
      for (let i = 0; i < input.length; i += 1) {
        const ch = input.charAt(i);
        const code = input.charCodeAt(i);
        if (code < 32 || code === 127) continue;
        if (banned.indexOf(ch) >= 0) continue;
        out += ch;
      }
      const text = out.trim();
      return text === "" ? "" : text.slice(0, WORKBENCH_DIR_LIMIT);
    }

    /**
     * 解析 @ query：去掉前导 @（宿主可能把触发符本身带进 query）与可选的
     * `workbench` 自定义前缀，再把末尾的绝对路径（Windows `X:\\...` 或
     * POSIX `/...`）从关键词里剥离。路径允许含空格，因此取「从路径起点到
     * 行尾」整段——用户把目录放在最后即可。
     *
     * 全程手写扫描，不依赖正则转义，避免把反斜杠路径吃成 JS 转义序列。
     * @param {any} rawQuery 宿主传入的 query
     * @returns {{ keyword: string, dir: string }} 小写关键词与净化后的目录
     */
    function parseWorkbenchQuery(rawQuery) {
      let raw = trimmed(rawQuery);
      while (raw.charAt(0) === "@") raw = raw.slice(1);
      if (raw.slice(0, 9).toLowerCase() === "workbench") {
        const after = raw.slice(9);
        if (after === "" || after.charCodeAt(0) === 32) raw = after.trim();
      }
      raw = trimmed(raw);

      const backslash = String.fromCharCode(92);
      let pathStart = -1;
      for (let i = 0; i < raw.length; i += 1) {
        const atBoundary = i === 0 || raw.charCodeAt(i - 1) === 32;
        if (!atBoundary) continue;
        const ch = raw.charAt(i);
        const code = ch.charCodeAt(0);
        const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
        const isDrive = isLetter && i + 2 < raw.length &&
          raw.charAt(i + 1) === ":" &&
          (raw.charAt(i + 2) === backslash || raw.charAt(i + 2) === "/");
        if (isDrive || (ch === "/" && i + 1 < raw.length)) {
          pathStart = i;
          break;
        }
      }
      if (pathStart < 0) {
        return { keyword: raw.toLowerCase(), dir: "" };
      }
      return {
        keyword: trimmed(raw.slice(0, pathStart)).toLowerCase(),
        dir: sanitizeWorkbenchDir(raw.slice(pathStart))
      };
    }

    /**
     * 生成 @ 工作台指令候选（静态、不联网）。value 形如 `<id>` 或 `<id>|<绝对路径>`，
     * 目录由 candidates 编码进 value，onPick 再原样写进 ref，serialize 优先采用。
     * @param {any} rawQuery 宿主 query
     * @returns {Array<{section:string,name:string,description:string,value:string,icon:string}>} 候选
     */
    function workbenchCandidates(rawQuery) {
      const parsed = parseWorkbenchQuery(rawQuery);
      const keyword = parsed.keyword;
      const suffix = parsed.dir !== "" ? "|" + parsed.dir : "";
      const items = [];
      for (const tpl of WORKBENCH_TEMPLATES) {
        const matches = keyword === "" ||
          tpl.name.toLowerCase().indexOf(keyword) >= 0 ||
          tpl.id.indexOf(keyword) >= 0 ||
          tpl.table.toLowerCase().indexOf(keyword) >= 0 ||
          tpl.description.toLowerCase().indexOf(keyword) >= 0 ||
          tpl.keywords.some((word) => word.toLowerCase().indexOf(keyword) >= 0);
        if (!matches) continue;
        items.push({
          section: "个人工作台",
          name: tpl.name,
          description: tpl.description + "；可在 @ 后附加绝对路径指定数据位置",
          value: tpl.id + suffix,
          icon: "grid"
        });
      }
      return items;
    }

    /**
     * 按 id 查模板。
     * @param {string} id 模板 id
     * @returns {object|null} 模板或 null
     */
    function findWorkbenchTemplate(id) {
      for (const tpl of WORKBENCH_TEMPLATES) {
        if (tpl.id === id) return tpl;
      }
      return null;
    }

    /**
     * 由候选 value 生成 chip 的 ref。
     * @param {any} value candidate.value
     * @returns {string} `workbench:<id>` 或 `workbench:<id>|<dir>`
     */
    function workbenchRefOf(value) {
      return "workbench:" + String(value === null || value === undefined ? "" : value);
    }

    /**
     * 解析 ref，返回模板与用户覆盖目录；异常 id 一律回落到第一个模板，
     * 保证旧草稿 / 手填 ref 也能序列化，绝不让发送失败。
     * @param {any} ref 引用字符串
     * @returns {{ template: object, dir: string }} 模板与目录
     */
    function parseWorkbenchRef(ref) {
      const raw = String(ref === null || ref === undefined ? "" : ref);
      const body = raw.indexOf("workbench:") === 0 ? raw.slice("workbench:".length) : raw;
      const sep = body.indexOf("|");
      const id = trimmed(sep >= 0 ? body.slice(0, sep) : body);
      const dir = sep >= 0 ? sanitizeWorkbenchDir(body.slice(sep + 1)) : "";
      const tpl = findWorkbenchTemplate(id);
      return { template: tpl !== null ? tpl : WORKBENCH_TEMPLATES[0], dir: dir };
    }

    /**
     * 历史遗留的模板引用文本（≤120 字）；`@` 指令源已停用，此函数只供离线回归。
     * 只编码模板 id 与中文名，不再引用任何技能。
     * @param {object} tpl 模板
     * @param {string} [overrideDir=''] 用户覆盖的绝对数据目录
     * @returns {string} 短引用
     */
    function buildWorkbenchSkillRef(tpl, overrideDir) {
      const dir = sanitizeWorkbenchDir(overrideDir);
      const base = "个人工作台模板：" + String(tpl.id || "") + " " + String(tpl.name || "");
      const full = dir === "" ? base : base + " dir=" + dir;
      return full.length <= 120 ? full : full.slice(0, 120);
    }

    /**
     * 派发工作台打开事件，让面板切到工作台大块。指令源不持有组件实例，
     * 用 window 事件解耦；无 CustomEvent / 无 window 的环境静默跳过。
     * @returns {void}
     */
    function emitWorkbenchOpen() {
      try {
        if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
        if (typeof window.CustomEvent === "function") {
          window.dispatchEvent(new window.CustomEvent(WORKBENCH_OPEN_EVENT));
        }
      } catch {
        /* 宿主禁用事件：忽略，不影响 chip 插入 */
      }
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
       * 引用编解码：宿主把草稿里的 chip 展开成用户消息时回调这里。
       *
       * **为什么三个分支都要保留**：本 codec 只挂 `/` 技能源；新增的 `@` 工作台
       * 指令源有自己的 codec（只展开一段生成任务提示语），不复用这里。
       * 但这不代表三分支是死代码 —— 旧草稿 / 旧会话里可能残留
       * `connector:xxx`、`expert:xxx`、`skill:xxx` 三类 chip，宿主仍会按 `source`
       * 名找到本 codec 并回调 serialize / clipboardText。删掉任何一支，老草稿
       * 一发送就会抛错。
       * 注：`@` 现在重新启用，但**只**承载「生成个人工作台」指令候选，与资源
       * 候选无关；专家 / 专家团 / 技能 / 连接器仍从输入框的专家按钮选择。
       *
       * 分支语义：
       *  - skill → 只输出 `/指令名`（正文由宿主原生 skill 机制按需加载，插件不内联）；
       *  - connector → 内联 `<mcp-config>` + 一句调用说明，逐字不变；
       *  - expert / team → 已改为会话常驻，只给一句最小降级说明。
       */
      const hubCodec = {
        clipboardText: (ref) => {
          const parts = String(ref === null || ref === undefined ? "" : ref).split(":");
          if (parts[0] === "skill") {
            return "/" + slashNameOf(parts.slice(1).join(":"));
          }
          return "@" + ref;
        },
        serialize: async (ref, signal) => {
          const parts = ref.split(":");
          if (parts.length !== 2) {
            throw new Error("无法解析引用：" + ref);
          }
          const [type, id] = parts;

          /* 技能不发 /detail：没有正文要取，旧草稿的仓库相对路径只做本地净化，
             任何情况下都不会因为详情接口失败而抛错。 */
          let item = {};
          let name = String(id);
          let description = "";
          if (type !== "skill") {
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
            item = data.item;
            name = item.displayName || item.name || item.id;
            description = item.description || "";
          }

          let block = "<dsh-buddy-expert-hub type=\"" + type + "\" id=\"" + id + "\" name=\"" + name + "\">\n";
          block += "<description>" + description + "</description>\n";

          if (type === "connector") {
            const config = item.config ? JSON.stringify(item.config, null, 2) : "";
            block += "<mcp-config>" + config.slice(0, SERIALIZE_LIMIT) + "</mcp-config>\n";
            block += "如需使用该连接器，请按上述 MCP 配置调用\n";
          } else if (type === "skill") {
            /* 技能正文由宿主原生 skill 机制按需加载，插件不再内联，避免污染用户消息。
               这里直接返回 /指令名，不带 <dsh-buddy-expert-hub> 包装、不带正文、
               不带资源指针；旧草稿的 `skill:skills/集合/名字` 由 slashNameOf()
               取末段净化成合法指令名，安全降级不抛异常。 */
            return "/" + slashNameOf(id);
          } else {
            /* 专家/团队已改为会话常驻（system prompt 注入 + runtime skill），
               不再插草稿；这个分支只为兼容旧草稿里可能残留的 expert 引用 ——
               给一句最小降级说明，绝不再展开 <dsh-buddy-expert-hub> 大块。 */
            block += "@" + name + "（该专家已改为会话常驻；若本会话未生效，请在输入框工具栏重新选择一次）\n";
          }

          block += "</dsh-buddy-expert-hub>";
          return block;
        }
      };

      /**
       * `/` 触发源：唯一注册的触发源，技能候选只在这里出现。
       * 候选取自 GET /skills/installed，只保留 enabled === true 的已安装技能；
       * `value` 用 row.dir（宿主原生技能名 / `/` 指令名），不是 /pick 的仓库相对路径。
       * 复用上面的 hubCodec：技能发送时统一展开成 `/指令名`。
       */
      const skillSource = {
        trigger: "/",
        name: "dsh-buddy-expert-hub-skills",
        order: 50,
        candidates: async (session, { query, signal }) => {
          const resp = await fetch(API + "/skills/installed", {
            headers: { Accept: "application/json" },
            signal
          });
          if (!resp.ok) return [];
          const data = await resp.json();
          if (data === null || data === undefined || data.ok !== true || !Array.isArray(data.items)) return [];
          /* 宿主可能把触发符本身也带进 query（`/pdf` 或纯 `/`），先去掉前缀再匹配，
             否则一个字符就会让所有候选被过滤掉。 */
          const keyword = trimmed(query).replace(/^\/+/, "").toLowerCase();
          const items = [];
          for (const row of data.items) {
            if (row === null || row === undefined || row.enabled !== true) continue;
            const dir = trimmed(row.dir);
            if (dir === "") continue;
            const name = trimmed(row.name) || dir;
            const description = trimmed(row.description);
            if (keyword !== "" &&
                name.toLowerCase().indexOf(keyword) < 0 &&
                description.toLowerCase().indexOf(keyword) < 0 &&
                dir.toLowerCase().indexOf(keyword) < 0) continue;
            items.push({
              section: "技能",
              name: name,
              description: description,
              value: dir,
              icon: "folder"
            });
          }
          return items;
        },
        onPick: ({ candidate }) => {
          const dir = slashNameOf(candidate.value);
          return {
            insert: {
              source: "dsh-buddy-expert-hub-skills",
              ref: "skill:" + dir,
              label: candidate.name,
              appearance: "session",
              clipboardText: "/" + dir
            }
          };
        },
        codec: hubCodec
      };

      /**
       * `@` 触发源：只提供「生成个人工作台」这一类指令候选，静态模板、不联网。
       *
       * 绝对不把专家 / 专家团 / 技能 / 连接器 / 团队等资源候选塞回 @ 菜单 ——
       * 那些仍统一从输入框的专家按钮（自绘紧凑面板）选择。这是用户新增的
       * 工作台指令，与历史「资源候选进 @ 菜单」的语义无关。
       *
       * 与 `/` 技能源 name / trigger / codec / order 各自独立，互不干扰；
       * 注册也走各自独立的 ctx.effect，一个失败不影响另一个。
       */
      const workbenchSource = {
        trigger: "@",
        name: "dsh-buddy-expert-hub-workbench",
        order: 51,
        candidates: async (session, { query, signal }) => {
          /* 纯静态：不联网、不看 signal；session 保留在签名里对齐宿主契约。 */
          void session;
          void signal;
          return workbenchCandidates(query);
        },
        onPick: ({ candidate }) => {
          const value = String((candidate && candidate.value) || "");
          const parsed = parseWorkbenchRef(workbenchRefOf(value));
          /* 事件解耦：不持有组件实例，选中模板就请主资源面板切到工作台大块。 */
          emitWorkbenchOpen();
          return {
            insert: {
              source: "dsh-buddy-expert-hub-workbench",
              ref: workbenchRefOf(value),
              label: "生成工作台 · " + parsed.template.name,
              appearance: "session",
              clipboardText: "生成『" + parsed.template.name + "』个人工作台（数据外置 + 双向同步）"
            }
          };
        },
        codec: {
          clipboardText: (ref) => {
            const parsed = parseWorkbenchRef(ref);
            return "生成工作台 · " + parsed.template.name;
          },
          serialize: async (ref, signal) => {
            const parsed = parseWorkbenchRef(ref);
            const tpl = parsed.template;
            const overrideDir = parsed.dir;

            /* 1) 读设置拿 sourceUrl + workbenchDataDir。读不到 → 跳过目录同步、
               不抛错、不 POST、不发 toast，仍返回可用短技能引用。 */
            let settings = null;
            try {
              const resp = await fetch(API + "/settings", {
                headers: { Accept: "application/json" },
                signal
              });
              if (resp !== null && resp !== undefined && resp.ok === true) {
                const data = await resp.json();
                if (data !== null && data !== undefined && typeof data === "object" &&
                    typeof data.workbenchDataDir === "string") {
                  settings = data;
                }
              }
            } catch {
              /* 网络 / 门禁 / 解析失败：settings 保持 null */
            }

            /* 2) overrideDir 非空且与当前设置目录不同 → 仍恰好 1 次 POST /settings。
               body 只带 sourceUrl + workbenchDataDir；sourceUrl 缺失时不发注定 400 的请求。 */
            if (settings !== null) {
              const settingsDataDir = sanitizeWorkbenchDir(settings.workbenchDataDir);
              const sourceUrl = typeof settings.sourceUrl === "string" ? settings.sourceUrl : "";
              if (overrideDir !== "" && overrideDir !== settingsDataDir && sourceUrl !== "") {
                let synced = false;
                try {
                  const post = await fetch(API + "/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      sourceUrl: sourceUrl,
                      workbenchDataDir: overrideDir
                    }),
                    signal
                  });
                  let result = null;
                  if (post !== null && post !== undefined && typeof post.json === "function") {
                    try { result = await post.json(); } catch { result = null; }
                  }
                  synced = post !== null && post !== undefined && post.ok === true &&
                    result !== null && result !== undefined && typeof result === "object" &&
                    result.ok === true;
                } catch {
                  /* 网络异常：走失败 toast，不抛错、不阻断发送 */
                }
                /* 3) POST settle 后主动 emit toast（serialize 不持有组件实例，
                   用模块级 sink / window 事件解耦）。结果只走 toast，
                   返回文本里绝不写任何目录说明、绝不暴露规则正文。 */
                if (synced === true) {
                  emitWorkbenchToast("已把工作台数据目录同步为 " + overrideDir, "info");
                } else {
                  emitWorkbenchToast("目录未同步，已沿用当前设置目录；可在「工作台设置」里手动修改", "error");
                }
              }
            }

            /* 4) 无论目录同步成功 / 失败 / 未发生，都只返回短技能引用。 */
            return buildWorkbenchSkillRef(tpl, overrideDir);
          }
        }
      };

      /**
       * 探测宿主 inputTriggers 契约并注册 `/` 技能触发源，返回 cleanup。
       *
       * `/` 同时是宿主内置 slash-menu 的触发符，注册可能被拒或与内置菜单冲突，
       * 不能静默假设成功。顺序：
       *  1. 检查服务与 registerSource 是否可用；
       *  2. 若宿主暴露 listSources / getSources / sources，检查是否已有同名源，
       *     并留痕记录「宿主已占用 /」；
       *  3. 先按 `/` 注册；抛错视为被拒，再试自定义前缀 `/skill`；
       *  4. 仍失败：明确中文告警「宿主不允许，需要宿主侧配合」，**绝不静默退回 @**。
       * @returns {() => void} 注销函数（失败时为空函数）
       */
      function registerSkillSource() {
        const noop = () => {};
        const fail = (reason) => {
          skillTriggerStatus = "注册失败：" + reason + "；宿主不允许 / 触发源，需要宿主侧配合；技能引用暂不可用（绝不退回 @ 菜单）";
          try { console.warn("[dsh-buddy-expert-hub] " + skillTriggerStatus); } catch { /* 忽略 */ }
          return noop;
        };
        if (inputTriggers === null || inputTriggers === undefined ||
            typeof inputTriggers.registerSource !== "function") {
          return fail("inputTriggers.registerSource 不可用");
        }

        /* 能力探测：宿主若暴露已注册源清单，先看同名源与 `/` 占用情况。 */
        let existing = [];
        try {
          let probe = null;
          if (typeof inputTriggers.listSources === "function") probe = inputTriggers.listSources();
          else if (typeof inputTriggers.getSources === "function") probe = inputTriggers.getSources();
          else if (Array.isArray(inputTriggers.sources)) probe = inputTriggers.sources;
          if (Array.isArray(probe)) existing = probe;
        } catch { /* 探测不支持或抛错都不阻断注册，交给下面的 try/catch */ }
        if (existing.some((entry) => entry !== null && entry !== undefined &&
            entry.name === "dsh-buddy-expert-hub-skills")) {
          skillTriggerStatus = "已注册：/（宿主已存在同名技能源，跳过重复注册）";
          return noop;
        }
        const occupied = existing.some((entry) => entry !== null && entry !== undefined && entry.trigger === "/");
        if (occupied === true) {
          /* 宿主内置 slash-menu 占用 `/` 是常见情况：不放弃，仍尝试注册插件源；
             真被拒时下面会走 /skill 前缀或给出明确告警。 */
          try { console.info("[dsh-buddy-expert-hub] 宿主已存在 / 触发源（内置 slash-menu），仍在尝试注册插件技能源"); } catch { /* 忽略 */ }
        }

        const attempts = [
          { trigger: "/", status: "已注册：/" },
          { trigger: "/skill", status: "已注册：/skill（宿主占用 /，改用自定义前缀）" }
        ];
        let lastReason = "未知原因";
        for (const attempt of attempts) {
          try {
            const dispose = inputTriggers.registerSource(Object.assign({}, skillSource, { trigger: attempt.trigger }));
            skillTriggerStatus = attempt.status;
            return typeof dispose === "function" ? dispose : noop;
          } catch (error) {
            lastReason = String((error && error.message) || error);
          }
        }
        return fail("registerSource 对 / 与 /skill 均拒绝（" + lastReason + "）");
      }

      /**
       * 「@ 工作台模板」指令源已停用。
       *
       * 创建工作台的唯一入口改为召唤「在线工作台搭建师」专家
       * （dsh-buddy-expert-hub-resource/experts/khub-workbench-builder），
       * 宿主不再注册 @ 工作台触发源，用户输入 @ 不会再出现「生成工作台」候选。
       *
       * workbenchSource 及其纯函数（模板 / codec / 目录净化）仍保留供离线回归验证
       * 历史契约；这里只把它挂到调试钩子，不调用 inputTriggers.registerSource。
       * @returns {() => void} 空 cleanup
       */
      function registerWorkbenchSource() {
        workbenchTriggerStatus = "已停用：@ 工作台指令源（改用召唤「在线工作台搭建师」专家创建工作台）";
        if (typeof window !== "undefined") {
          try { window.__DSH_BUDDY_WB_SOURCE__ = workbenchSource; }
          catch { /* 只读 window 环境忽略 */ }
        }
        return () => {};
      }

      /* 只注册 `/` 技能源。`@` 工作台模板源已停用（见 registerWorkbenchSource），
         创建工作台请召唤「在线工作台搭建师」专家；保留独立 ctx.effect 是为了
         让设置页状态文案仍显示「已停用」并暴露回归钩子，不影响 / 技能源。 */
      ctx.effect(() => registerSkillSource(), "dsh-buddy-expert-hub: slash skills trigger source");
      ctx.effect(() => registerWorkbenchSource(), "dsh-buddy-expert-hub: at workbench trigger source");

      ctx.inject(["slots", "sessions", "conversation", "inputTriggers"], (scope) => {
        slotsInjectStarted = true;
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
                /* 不再 toggleSource：专家 / 专家团 / 技能 / 连接器全部改由
                   conversation.input.overlay 槽里的自绘紧凑面板负责，绝不进 @ 菜单。
                   `@` 触发源现在只承载「生成个人工作台」指令候选（静态模板），
                   `/` 触发源仍只承载技能指令；两个源并列、互不影响。 */
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
              /* 宿主按 source 名找已注册源的 codec 来展开 chip。草稿里的资源 chip
                 一律挂 `/` 技能源名下（hubCodec 三分支齐全：skill / connector /
                 expert）；沿用旧的 "dsh-buddy-expert-hub" 会让宿主找不到 codec、
                 发送直接失败。新增的 `@` 工作台源有独立 codec（只展开任务提示语），
                 由触发源自己 insert，不走这条手工插入桥。 */
              source: "dsh-buddy-expert-hub-skills",
              ref: refType + ":" + refId,
              label: label,
              appearance: "session",
              /* 技能复制出来是 /指令名（宿主原生技能名），连接器仍是 @name，行为不变。 */
              clipboardText: refType === "skill" ? "/" + slashNameOf(refId) : "@" + label
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
          /* 透传 opts：智聊会话要带 cwd 建，才能与后端 prompt 的 cwd 一致。 */
          create: (opts) => {
            if (sessions !== null && sessions !== undefined && typeof sessions.create === "function") {
              return sessions.create(opts);
            }
            return Promise.reject(new Error("宿主 sessions.create 不可用"));
          },
          /* 防御式：宿主没有 open 时只留痕、不抛错，召唤流程继续挂载专家。 */
          open: (id) => openSessionSafe(id),
          currentSessionId: () => resolveSessionId(null)
        };
        /* 智聊面板只读这个模块级引用，不碰 applyComposer 内部闭包。 */
        zhiliaOpenChatBridge = {
          create: summonBridge.create,
          /* 会话改名：宿主 sessions.rename 可用则用，否则返 false 由调用方忽略 */
          rename: (id, title) => {
            if (sessions !== null && sessions !== undefined && typeof sessions.rename === "function") {
              return Promise.resolve(sessions.rename(id, title));
            }
            return Promise.resolve(false);
          },
          /* 优先用宿主的跨 workspace 导航；sessions face 没有 select，只能这样让新会话可见。 */
          open: (id) => {
            if (zhiliaUiWorkspace !== null && typeof zhiliaUiWorkspace.openSession === "function") {
              try {
                zhiliaUiWorkspace.openSession(id);
                return true;
              } catch (error) {
                try { console.warn("[dsh-buddy-expert-hub] uiWorkspace.openSession 失败：" + String((error && error.message) || error)); } catch { /* 忽略 */ }
              }
            }
            return summonBridge.open(id);
          },
          /* 在指定工作区打开/选中会话：等价于顶部"选择工作区"下拉，
             供归档旧会话后重建新会话时确保工作区被选中。 */
          selectWorkspace: (workspaceId, sessionId) => {
            const nav = zhiliaWorkspaceNav;
            if (nav === null || typeof nav.openWorkspace !== "function" || String(workspaceId || "") === "") {
              return Promise.resolve(false);
            }
            try {
              return Promise.resolve(nav.openWorkspace(workspaceId, (nextId) => {
                if (String(sessionId || "") !== "" && nextId !== sessionId) {
                  try { zhiliaUiWorkspace.openSession(sessionId); } catch (err) { /* 忽略 */ }
                }
              })).then(() => true).catch(() => false);
            } catch (err) { return Promise.resolve(false); }
          },
          currentSessionId: () => summonBridge.currentSessionId(),
          show: () => showConversationSafe(),
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
              /* `/` 技能源注册结果：宿主占用 / 时会写明降级前缀或「需要宿主侧配合」。 */
              skillTrigger: skillTriggerStatus,
              /* `@` 工作台指令源注册结果：如实上报，避免排查者以为 @ 还给资源候选。 */
              workbenchTrigger: workbenchTriggerStatus,
              atTrigger: "已停用（@ 工作台模板指令源已下线；创建工作台请召唤「在线工作台搭建师」专家，资源候选仍从输入框专家按钮选择）",
              /* 宿主能力探测：open 缺失时只跳过会话切换，不影响引用与视图跳转。 */
              hasSessionsOpen: sessions !== null && sessions !== undefined && typeof sessions.open === "function",
              hasSessionsCreate: sessions !== null && sessions !== undefined && typeof sessions.create === "function",
              sessionsKeys: sessions !== null && sessions !== undefined ? Object.keys(sessions).slice(0, 20) : [],
              layoutOk: layout !== null && layout !== undefined && typeof layout.selectPanel === "function",
              /* 「专家选择不显示」定位：pickerMounted=false 说明 overlay 槽组件没挂载；
                 slotsInjectStarted=false 说明宿主依赖未就绪、ctx.inject 回调根本没跑。 */
              pickerMounted: typeof pickerOpenSetter === "function",
              pickerRetryPending: pickerRetryPending === true,
              slotsInjectStarted: slotsInjectStarted === true,
              slotErrors: slotInjectErrors.slice()
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

    // =======================================================================
    // dsh 设置页（设置 → 插件）：插件自己的配置页
    //
    // 原来面板里的两个设置弹窗（资源仓库 / 个人工作台）整体搬到这里，
    // 以 embedded 模式复用原组件（不遮罩、不弹窗），另外加「插件升级」与
    // 「关于与反馈」两个分区。面板与工作台工具条不再有齿轮入口。
    // =======================================================================

    /** 拉插件自身元数据（版本 / 仓库地址 / 介绍已读版本 / 升级历史）。 */
    function fetchMeta() {
      return fetchJson("/meta").catch(() => null);
    }

    /** 把 ISO 时间显示成本地「MM-DD HH:mm」。 */
    function shortTime(value) {
      const date = new Date(String(value));
      if (!Number.isFinite(date.getTime())) return "";
      const pad = (n) => (n < 10 ? "0" + String(n) : String(n));
      return pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
    }

    /* 示例 JSON 内置兜底：与服务端 sampleConfigText() 内容一致（含 // 中文说明）。
       下载按钮不依赖 GET /config/remote 的返回 —— 即使该请求超时 / 失败，示例照样能下载。
       用户改完直接上传也能解析：服务端加载时会先剥离注释。 */
    const REMOTE_SAMPLE_JSON = [
      '{',
      '  // 远程配置示例：改完可直接上传，或把文件内容放到 http(s) 地址后填 URL 加载',
      '  // 说明：留空字符串表示「不改动 / 使用默认」；密钥留空表示不覆盖本地已保存的密钥',
      '  // 安全：密钥会明文经过网络，请只对可信的配置地址使用',
      '',
      '  // 资源仓库地址（git 仓库 URL 或本机绝对路径）；留空忽略',
      '  "sourceUrl": "https://gitcode.com/zzx_2446/dsh-buddy-expert-hub-resource.git",',
      '  // 资源仓库分支；留空跟随远端默认分支（不要写死 main/master）',
      '  "sourceBranch": "",',
      '  // SkillHub 地址；默认 https://api.skillhub.cn，留空回落默认',
      '  "skillhubUrl": "https://api.skillhub.cn",',
      '',
      '  // 个人工作台',
      '  "workbench": {',
      '    // 数据目录：本机已存在的绝对路径；空串表示清除（无通用默认值）',
      '    "dataDir": "",',
      '    // 检查间隔（毫秒），500–60000，越界自动收敛到 2000',
      '    "syncMs": 2000',
      '  },',
      '',
      '  // 在线资料库',
      '  "khub": {',
      '    // 服务地址；留空表示不使用在线资料库',
      '    "baseUrl": "",',
      '    // 客户端 ID（非敏感，可远程下发）',
      '    "clientId": "",',
      '    // 客户端密钥：写入本地加密文件；留空表示不改动（不要明文分享本文件）',
      '    "clientSecret": "",',
      '    // 用户 API Key：写入本地加密文件；留空表示不改动',
      '    "apiKey": "",',
      '    // 在线优先开关；需先配好地址与密钥才真正生效',
      '    "enabled": true',
      '  },',
      '',
      '  // 智聊',
      '  "zhiliao": {',
      '    // 智聊服务端地址（http(s)）；留空表示清除',
      '    "replyBaseUrl": "",',
      '    // 启用智聊',
      '    "enabled": true',
      '  },',
      '',
      '  // 关于与反馈页的链接',
      '  "about": {',
      '    // 仓库地址；留空回落插件内置地址',
      '    "repoUrl": "https://github.com/zhangzexu/dsh-buddy-expert-hub",',
      '    // 点 Star 地址；留空跟随仓库地址',
      '    "starUrl": "",',
      '    // 反馈问题地址；留空使用「仓库地址 + /issues」',
      '    "feedbackUrl": "https://github.com/zhangzexu/dsh-buddy-expert-hub/issues"',
      '  }',
      '}',
    ].join('\n') + '\n';

    /**
     * 「远程配置」分区：填 http(s) JSON 地址或上传 JSON 文件 → 覆盖设置页参数。
     * 读取到就用远程值，没加载 / 清除后用本地默认设置。
     * 密钥类字段与内置技能开关刻意不支持远程下发（见组件内说明与服务端白名单）。
     * @param {{ onToast?: Function }} props 属性
     * @returns {any} React 元素
     */
    function RemoteConfigSection(props) {
      const [state, setState] = useState(null);
      const [sample, setSample] = useState(REMOTE_SAMPLE_JSON);
      const [url, setUrl] = useState("");
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState("");
      const [messageOk, setMessageOk] = useState(false);
      const [loadFailed, setLoadFailed] = useState(false);
      const fileRef = useRef(null);

      function reload() {
        return fetchJson("/config/remote")
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setState(res.config);
              setLoadFailed(false);
              /* 服务端有示例就用服务端的（保持单一权威源）；否则保留内置兜底。 */
              if (typeof res.sample === "string" && res.sample.trim() !== "") setSample(res.sample);
              setUrl(typeof res.config.url === "string" ? res.config.url : "");
            } else {
              setLoadFailed(true);
            }
          })
          .catch((error) => {
            setLoadFailed(true);
            setMessage("读取远程配置状态失败：" + String((error && error.message) || error));
          });
      }
      useEffect(() => { reload(); }, []);

      function report(res, okText) {
        if (res !== null && res !== undefined && res.ok === true) {
          const ignored = Array.isArray(res.ignoredFields) && res.ignoredFields.length > 0
            ? "（已忽略不支持的字段：" + res.ignoredFields.join("、") + "）"
            : "";
          const warnings = Array.isArray(res.warnings) && res.warnings.length > 0
            ? "（部分字段未生效：" + res.warnings.join("；") + "）"
            : "";
          setMessage(okText + "，已覆盖 " + String((res.appliedFields || []).length) + " 项" + ignored + warnings);
          setMessageOk(true);
          if (typeof props.onToast === "function") props.onToast(okText);
          reload();
          return true;
        }
        setMessage(String((res && res.error) || "操作失败"));
        setMessageOk(false);
        return false;
      }

      function failCatch(error) {
        setMessage("操作失败：" + String((error && error.message) || error));
        setMessageOk(false);
      }

      function loadUrl() {
        if (busy === true || url.trim() === "") return;
        setBusy(true);
        setMessage("");
        fetch(API + "/config/remote/load", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "url", url: url.trim() })
        })
          .then((resp) => resp.json())
          .then((res) => report(res, "远程配置已加载"))
          .catch(failCatch)
          .finally(() => setBusy(false));
      }

      function onFileChange(event) {
        const input = event.target;
        const file = input !== null && input.files !== null && input.files.length > 0 ? input.files[0] : null;
        input.value = "";
        if (file === null || busy === true) return;
        setBusy(true);
        setMessage("");
        readFileText(file)
          .then((text) => fetch(API + "/config/remote/load", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "upload", content: text, filename: file.name || "" })
          }))
          .then((resp) => resp.json())
          .then((res) => report(res, "配置文件已上传并应用"))
          .catch(failCatch)
          .finally(() => setBusy(false));
      }

      function clear() {
        if (busy === true) return;
        setBusy(true);
        setMessage("");
        fetch(API + "/config/remote/clear", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setMessage(String(res.message || "已清除远程配置"));
              setMessageOk(true);
              if (typeof props.onToast === "function") props.onToast("远程配置已清除");
              reload();
              return;
            }
            setMessage(String((res && res.error) || "清除失败"));
            setMessageOk(false);
          })
          .catch(failCatch)
          .finally(() => setBusy(false));
      }

      function downloadSample() {
        const text = sample.trim() !== "" ? sample : REMOTE_SAMPLE_JSON;
        try {
          const blob = new Blob([text], { type: "application/json;charset=utf-8" });
          const objectUrl = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = objectUrl;
          link.download = "dsh-remote-config-example.json";
          document.body.append(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
          if (typeof props.onToast === "function") props.onToast("示例配置已下载");
        } catch (error) {
          setMessage("下载示例失败：" + String((error && error.message) || error));
          setMessageOk(false);
        }
      }

      const active = state !== null && state.active === true;
      const statusText = state === null
        ? (loadFailed ? "状态读取失败 · 可重试加载（下方功能不受影响）" : "读取中…")
        : active
          ? "已启用 · " + (state.source === "url" ? "URL：" + String(state.url || "") : "上传：" + String(state.filename || ""))
          : "未启用 · 当前使用本地设置";

      return h("section", { className: "dshe-set-card" },
        h("div", { className: "dshe-set-card-head" },
          h("h3", { className: "dshe-set-card-title" }, "远程配置"),
          h("span", { className: "dshe-set-badge" }, active ? "已启用" : "未启用")
        ),
        h("p", { className: "dshe-set-desc" },
          "填一个 http(s) 的 JSON 文件地址，或直接上传 JSON 文件，读取后即可覆盖上面这些设置页参数（下次同步生效）；清除后恢复本地设置。密钥类字段与「内置技能」开关出于安全考虑不支持远程下发。"),
        h("div", { className: "dshe-rc-status" + (active ? " dshe-rc-status-on" : "") },
          h("span", { className: active ? "dshe-set-ok" : "dshe-set-hint", role: "status" }, statusText),
          state !== null && state.loadedAt
            ? h("span", { className: "dshe-set-hint" }, "加载时间：" + String(state.loadedAt))
            : null
        ),
        h("div", { className: "dshe-rc-url" },
          h("input", {
            id: "dshe-remote-url",
            className: "dshe-settings-input",
            type: "text",
            value: url,
            placeholder: "https://example.com/config.json",
            "aria-label": "远程配置文件地址",
            onChange: (event) => setUrl(event.target.value)
          }),
          h("button", {
            type: "button",
            id: "dshe-remote-load",
            className: "dshe-btn dshe-btn-primary",
            disabled: busy === true || url.trim() === "",
            onClick: loadUrl
          }, busy === true ? "处理中…" : "从 URL 加载")
        ),
        h("div", { className: "dshe-set-row" },
          h("input", {
            ref: fileRef,
            type: "file",
            accept: "application/json,.json",
            style: { display: "none" },
            onChange: onFileChange
          }),
          h("button", {
            type: "button",
            id: "dshe-remote-upload",
            className: "dshe-btn",
            disabled: busy === true,
            onClick: () => { if (fileRef.current !== null) { fileRef.current.value = ""; fileRef.current.click(); } }
          }, "上传 JSON 文件"),
          active
            ? h("button", {
                type: "button",
                id: "dshe-remote-clear",
                className: "dshe-btn dshe-btn-danger",
                disabled: busy === true,
                onClick: clear
              }, "清除远程配置")
            : null,
          h("button", {
            type: "button",
            id: "dshe-remote-sample",
            className: "dshe-btn",
            title: "下载一份可直接修改的示例配置 JSON 文件",
            onClick: downloadSample
          }, "下载示例 JSON")
        ),
        message !== "" ? h("p", { className: messageOk ? "dshe-set-hint" : "dshe-settings-hint-err", role: "status" }, message) : null
      );
    }

    /**
     * 「插件升级」分区：查 npm 最新版 → 一键升级（下载 / 校验 / 备份 / 覆盖 / 回滚）。
     * @param {{ onToast?: Function }} props 属性
     * @returns {any} React 元素
     */
    function UpdateSection(props) {
      const [meta, setMeta] = useState(null);
      const [checking, setChecking] = useState(false);
      const [applying, setApplying] = useState(false);
      const [result, setResult] = useState(null);
      const [message, setMessage] = useState("");

      function reloadMeta() {
        fetchMeta().then((res) => { if (res !== null && res.ok === true) setMeta(res); });
      }
      useEffect(() => { reloadMeta(); }, []);

      function check() {
        setChecking(true);
        setMessage("");
        fetchJson("/update/check?force=1")
          .then((res) => {
            setResult(res);
            if (res === null || res.ok !== true) setMessage(String((res && res.error) || "检查更新失败"));
          })
          .catch((error) => setMessage("检查更新失败：" + String((error && error.message) || error)))
          .finally(() => setChecking(false));
      }

      function apply() {
        if (applying === true) return;
        setApplying(true);
        setMessage("");
        fetch(API + "/update/apply", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
          .then((resp) => resp.json())
          .then((res) => {
            if (res !== null && res !== undefined && res.ok === true) {
              setMessage("已升级到 " + String(res.to) + "（覆盖 " + String(res.files) + " 个文件）。请重启 dsh 以加载新版本。");
              setResult(null);
              reloadMeta();
              if (typeof props.onToast === "function") props.onToast("升级完成，请重启 dsh");
              return;
            }
            setMessage(String((res && (res.error || res.message)) || "升级失败"));
            reloadMeta();
          })
          .catch((error) => setMessage("升级失败：" + String((error && error.message) || error)))
          .finally(() => setApplying(false));
      }

      const current = meta !== null && typeof meta.version === "string" && meta.version !== "" ? meta.version : "—";
      const hasUpdate = result !== null && result.ok === true && result.hasUpdate === true;
      const latest = result !== null && typeof result.latest === "string" ? result.latest : "";
      const history = meta !== null && Array.isArray(meta.updateHistory) ? meta.updateHistory : [];

      return h("section", { className: "dshe-set-card" },
        h("div", { className: "dshe-set-card-head" },
          h("h3", { className: "dshe-set-card-title" }, "插件升级"),
          h("span", { className: "dshe-set-badge" }, "当前 v" + current)
        ),
        h("p", { className: "dshe-set-desc" }, "从 npm registry 检查新版本。升级会下载安装包、校验 sha512、备份当前版本后覆盖文件；任一步失败自动回滚到原版本。"),
        h("div", { className: "dshe-set-row" },
          h("button", {
            type: "button",
            id: "dshe-update-check",
            className: "dshe-btn",
            disabled: checking === true || applying === true,
            onClick: check
          }, checking === true ? "检查中…" : "检查更新"),
          hasUpdate
            ? h("button", {
                type: "button",
                id: "dshe-update-apply",
                className: "dshe-btn dshe-btn-primary",
                disabled: applying === true,
                onClick: apply
              }, applying === true ? "升级中…" : "立即升级到 " + latest)
            : null
        ),
        result !== null && result.ok === true
          ? h("p", { className: "dshe-set-hint" }, hasUpdate === true
              ? "发现新版本 " + latest + (typeof result.publishedAt === "string" && result.publishedAt !== "" ? "（发布于 " + shortTime(result.publishedAt) + "）" : "")
              : "已是最新版本")
          : null,
        message !== "" ? h("p", { className: "dshe-set-hint", role: "status" }, message) : null,
        history.length > 0
          ? h("div", { className: "dshe-set-history" },
              h("div", { className: "dshe-set-history-title" }, "最近升级"),
              history.map((item, index) => h("div", { key: "hist-" + String(index), className: "dshe-set-history-item" },
                h("span", { className: item.ok === true ? "dshe-set-ok" : "dshe-set-bad" }, item.ok === true ? "成功" : "失败"),
                h("span", null, String(item.from || "?") + " → " + String(item.to || "?")),
                h("span", { className: "dshe-set-history-time" }, shortTime(item.at)),
                typeof item.message === "string" && item.message !== ""
                  ? h("span", { className: "dshe-set-history-msg" }, "· " + item.message)
                  : null
              )))
            : null
      );
    }

    /**
     * 「在线资料库」设置分区：整个插件共用一套后端地址与凭据。
     *
     * 安全边界：clientSecret / 用户 API Key 只在本次保存请求里出现，服务端写入
     * credentials.enc（AES-256-GCM），GET 只回显「是否已配置」，输入框永远回填空。
     * 留空表示不改动，勾「清除」才会删掉已存密钥。
     * @param {{ onToast?: Function }} props 属性
     * @returns {any} React 元素
     */
    function KhubSettingsSection(props) {
      const [loaded, setLoaded] = useState(false);
      const [baseUrl, setBaseUrl] = useState("");
      const [clientId, setClientId] = useState("");
      const [clientSecret, setClientSecret] = useState("");
      const [apiKey, setApiKey] = useState("");
      const [enabled, setEnabled] = useState(true);
      const [clearClientSecret, setClearClientSecret] = useState(false);
      const [clearApiKey, setClearApiKey] = useState(false);
      const [secretConfigured, setSecretConfigured] = useState(false);
      const [keyConfigured, setKeyConfigured] = useState(false);
      const [saving, setSaving] = useState(false);
      const [testing, setTesting] = useState(false);
      const [hint, setHint] = useState("");
      const [errorText, setErrorText] = useState("");

      function applySettings(res) {
        if (res === null || res === undefined || res.ok !== true) return;
        setBaseUrl(typeof res.baseUrl === "string" ? res.baseUrl : "");
        setClientId(typeof res.clientId === "string" ? res.clientId : "");
        setEnabled(res.enabled !== false);
        setSecretConfigured(res.clientSecretConfigured === true);
        setKeyConfigured(res.apiKeyConfigured === true);
        setLoaded(true);
      }

      useEffect(() => {
        fetchJson("/khub/settings")
          .then(applySettings)
          .catch(() => { setLoaded(true); });
      }, []);

      function urlProblem() {
        const text = baseUrl.trim().replace(/\/+$/, "");
        if (text === "") return "";
        if (!/^https?:\/\//i.test(text) || /\s/.test(text)) return "服务地址必须是 http(s):// 开头的合法 URL";
        return "";
      }

      function buildPayload() {
        const url = baseUrl.trim().replace(/\/+$/, "");
        const payload = { baseUrl: url, clientId: clientId.trim(), enabled: enabled };
        if (clientSecret.trim() !== "") payload.clientSecret = clientSecret.trim();
        if (apiKey.trim() !== "") payload.apiKey = apiKey.trim();
        if (clearClientSecret === true) payload.clearClientSecret = true;
        if (clearApiKey === true) payload.clearApiKey = true;
        return payload;
      }

      function doSave() {
        if (saving === true || loaded === false) return;
        const problem = urlProblem();
        if (problem !== "") { setErrorText(problem); return; }
        setErrorText("");
        setSaving(true);
        fetch(API + "/khub/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildPayload())
        })
          .then((resp) => resp.json())
          .then((res) => {
            setSaving(false);
            if (res === null || res === undefined || res.ok !== true) {
              setHint("");
              setErrorText(String((res && res.error) || "保存失败"));
              return;
            }
            applySettings(res);
            setClientSecret("");
            setApiKey("");
            setClearClientSecret(false);
            setClearApiKey(false);
            setErrorText("");
            setHint("配置已保存；在线优先" + (res.enabled !== false ? "已自动启用" : "已关闭") + "。");
            if (typeof props.onToast === "function") props.onToast("在线资料库配置已保存");
          })
          .catch((error) => {
            setSaving(false);
            setErrorText("保存失败：" + String((error && error.message) || error));
          });
      }

      function doProbe() {
        if (testing === true) return;
        setTesting(true);
        setErrorText("");
        setHint("正在连接…");
        fetch(API + "/khub/probe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        })
          .then((resp) => resp.json())
          .then((res) => {
            setTesting(false);
            if (res === null || res === undefined || res.ok !== true) {
              setHint("");
              setErrorText(String((res && res.error) || "连接失败"));
              return;
            }
            setHint(String(res.message || "连接成功") +
              (Array.isArray(res.spaces) && res.spaces.length > 0
                ? "：" + res.spaces.map((it) => String(it.name)).join("、") : ""));
          })
          .catch((error) => {
            setTesting(false);
            setHint("");
            setErrorText("连接失败：" + String((error && error.message) || error));
          });
      }

      const urlError = urlProblem();
      /* 只要地址 + 用户 API Key 就能保存并自动启用；客户端凭据仅用于「测试连接」校验，可留空。 */
      const canSave = loaded === true && saving === false && urlError === "" &&
        (baseUrl.trim() === "" || keyConfigured === true || apiKey.trim() !== "");

      function field(label, value, onChange, placeholder, type) {
        return h("label", { className: "dshe-settings-field" },
          h("span", { className: "dshe-settings-label" }, label),
          h("input", {
            className: "dshe-settings-input",
            type: type || "text",
            value: value,
            placeholder: placeholder || "",
            autoComplete: "off",
            spellCheck: false,
            onChange: (event) => { onChange(String((event && event.target && event.target.value) || "")); }
          })
        );
      }

      return h("section", { className: "dshe-set-card" },
        h("div", { className: "dshe-set-card-head" },
          h("h3", { className: "dshe-set-card-title" }, "在线资料库"),
          h("span", { className: "dshe-set-badge" }, keyConfigured === true ? "密钥已配置" : "未配置")
        ),
        h("p", { className: "dshe-set-desc" },
          "整个插件共用这一套后端与凭据。工作台的 HTML / CSV 与「资料库」文档都从这里读取；" +
          "在线不可用时自动回落到本机目录，本地只作为备用。"),
        field("后端服务地址", baseUrl, setBaseUrl, "http://127.0.0.1:8080"),
        field("客户端 ID", clientId, setClientId, "cli_xxx"),
        field("客户端密钥", clientSecret, setClientSecret,
          secretConfigured === true ? "已保存，留空表示不修改" : "clientSecret", "password"),
        field("用户 API Key", apiKey, setApiKey,
          keyConfigured === true ? "已保存，留空表示不修改" : "khub_pat_xxx", "password"),
        h("div", { className: "dshe-set-row" },
          h("label", { className: "dshe-settings-check" },
            h("input", {
              type: "checkbox", checked: clearClientSecret,
              onChange: (event) => setClearClientSecret(event && event.target ? event.target.checked === true : false)
            }),
            h("span", null, "清除客户端密钥")),
          h("label", { className: "dshe-settings-check" },
            h("input", {
              type: "checkbox", checked: clearApiKey,
              onChange: (event) => setClearApiKey(event && event.target ? event.target.checked === true : false)
            }),
            h("span", null, "清除 API Key"))
        ),
        h("div", { className: "dshe-set-row" },
          h("span", { className: "dshe-set-desc" }, "在线优先（填好地址与密钥后自动启用；关掉则只用本机目录）"),
          h("button", {
            type: "button",
            id: "dshe-khub-enabled",
            className: "dshe-switch" + (enabled === true ? " dshe-switch-on" : ""),
            role: "switch",
            "aria-checked": enabled === true ? "true" : "false",
            "aria-label": "在线优先",
            onClick: () => setEnabled(!enabled)
          }, h("span", { className: "dshe-switch-dot" }))
        ),
        h("div", { className: "dshe-settings-foot" },
          h("button", {
            type: "button", id: "dshe-khub-save", className: "dshe-btn dshe-btn-primary",
            disabled: !canSave, onClick: doSave
          }, saving === true ? "保存中…" : "保存配置"),
          h("button", {
            type: "button", id: "dshe-khub-probe", className: "dshe-btn",
            disabled: testing === true || baseUrl.trim() === "" ||
              (keyConfigured === false && apiKey.trim() === ""), onClick: doProbe
          }, testing === true ? "连接中…" : "测试连接")
        ),
        urlError !== "" ? h("p", { className: "dshe-settings-hint dshe-settings-hint-err" }, urlError) : null,
        errorText !== "" ? h("p", { className: "dshe-settings-hint dshe-settings-hint-err", role: "status" }, errorText) : null,
        hint !== "" ? h("p", { className: "dshe-settings-hint", role: "status" }, hint) : null
      );
    }

    /**
     * 「关于与反馈」分区：GitHub Star、仓库链接、反馈入口、重看介绍。
     * @param {{ meta: any, onShowIntro: Function }} props 属性
     * @returns {any} React 元素
     */
    function AboutSection(props) {
      const meta = props.meta;
      const repoUrl = meta !== null && typeof meta.repoUrl === "string" && meta.repoUrl !== ""
        ? meta.repoUrl
        : "https://github.com/zhangzexu/dsh-buddy-expert-hub";
      /* 点 Star / 反馈地址：后端 /meta 已下发可配置值（带默认回退），前端只读，不再自行拼接。 */
      const starUrl = meta !== null && typeof meta.starUrl === "string" && meta.starUrl !== ""
        ? meta.starUrl : repoUrl;
      const feedbackUrl = meta !== null && typeof meta.feedbackUrl === "string" && meta.feedbackUrl !== ""
        ? meta.feedbackUrl : (repoUrl + "/issues");
      return h("section", { className: "dshe-set-card" },
        h("div", { className: "dshe-set-card-head" },
          h("h3", { className: "dshe-set-card-title" }, "关于与反馈"),
          h("span", { className: "dshe-set-badge" }, "MIT")
        ),
        h("p", { className: "dshe-set-desc" }, "Buddy 工作台是开源的 dsh 插件：专家、专家团、技能、连接器都在一个面板里，另带个人工作台。如果它帮到了你，去 GitHub 点个 Star，或把问题发到 Issues。"),
        h("div", { className: "dshe-set-row" },
          h("a", {
            id: "dshe-star-about",
            className: "dshe-btn dshe-btn-primary",
            href: starUrl,
            target: "_blank",
            rel: "noreferrer noopener",
            title: "在 GitHub 打开仓库并点 Star"
          }, h(Icon, { name: "star", size: 14 }), h("span", null, "去 GitHub 点 Star")),
          h("a", {
            id: "dshe-feedback",
            className: "dshe-btn",
            href: feedbackUrl,
            target: "_blank",
            rel: "noreferrer noopener"
          }, "反馈问题"),
          h("button", {
            type: "button",
            className: "dshe-btn",
            onClick: () => { if (typeof props.onShowIntro === "function") props.onShowIntro(); }
          }, "再看一次插件介绍")
        )
      );
    }

    /** 介绍弹窗的分页内容：改文案时把 `introVersion` 一起改掉即可再弹一次。 */
    var INTRO_PAGES = [
      {
        title: "Buddy 工作台 · 一页看完",
        bullets: [
          "左侧栏两个入口：「专家·技能·连接器」与「个人工作台」。",
          "资源和配置都在面板里，数据不出本机（除资源仓库同步与连接器鉴权）。",
          "配色跟随 dsh 的深浅色外观，不需要单独设置。"
        ]
      },
      {
        title: "专家 / 专家团 / 技能 / 连接器",
        bullets: [
          "专家与专家团：浏览、搜索、一键召唤到当前会话，或从文件夹导入自己的。",
          "技能：输入框的专家按钮和 `/` 指令都能用，内置技能可一键安装到本地技能库。",
          "连接器：云端与本地两源合并，三步完成接入；凭据加密保存在本机。"
        ]
      },
      {
        title: "个人工作台（HTML + CSV）",
        bullets: [
          "让 dsh 生成一个工作台页面，数据存在旁边的 CSV 表里，页面和 Excel 改的是同一份文件。",
          "左侧文件树、右侧整页；「刷新」手动同步，工具条上的「自动刷新」开关控制后台检测。",
          "页面配色同样跟随 dsh 深浅色。"
        ]
      },
      {
        title: "升级与反馈",
        bullets: [
          "设置 → Buddy 工作台，可以检查更新并一键升级；升级失败会自动回滚。",
          "如果这个插件对你有用，欢迎去 GitHub 点个 Star。",
          "介绍随时可以在「关于与反馈」里重看。"
        ]
      }
    ];

    /**
     * 插件介绍弹窗：首次安装或版本变化后弹一次，确认后写入已读版本。
     * @param {{ version: string, onAck: Function }} props 属性
     * @returns {any} React 元素
     */
    function IntroDialog(props) {
      const [page, setPage] = useState(0);
      const total = INTRO_PAGES.length;
      const current = INTRO_PAGES[Math.min(page, total - 1)];
      const last = page >= total - 1;

      function ack() {
        const body = JSON.stringify({ version: String(props.version || "") });
        fetch(API + "/intro/ack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body
        })
          .then((resp) => resp.json())
          .catch(() => null)
          .then(() => { if (typeof props.onAck === "function") props.onAck(); });
      }

      return h("div", {
        className: "dshe-mask",
        onClick: (event) => { if (event.target === event.currentTarget) ack(); }
      },
        h("div", { className: "dshe-intro", role: "dialog", "aria-modal": "true", "aria-label": "插件介绍" },
          h("button", {
            type: "button",
            className: "dshe-drawer-close",
            "aria-label": "关闭",
            title: "关闭",
            onClick: ack
          }, h(Icon, { name: "close", size: 18 })),
          h("div", { className: "dshe-intro-dots", "aria-hidden": "true" },
            INTRO_PAGES.map((item, index) => h("span", {
              key: "dot-" + String(index),
              className: "dshe-intro-dot" + (index === page ? " dshe-intro-dot-on" : "")
            }))),
          h("h2", { className: "dshe-intro-title" }, current.title),
          h("ul", { className: "dshe-intro-list" },
            current.bullets.map((line, index) => h("li", { key: "li-" + String(index) }, line))),
          h("div", { className: "dshe-intro-foot" },
            h("span", { className: "dshe-intro-step" }, String(page + 1) + " / " + String(total)),
            h("div", { className: "dshe-intro-actions" },
              page > 0
                ? h("button", { type: "button", className: "dshe-btn", onClick: () => setPage(page - 1) }, "上一页")
                : null,
              last
                ? h("button", { type: "button", id: "dshe-intro-done", className: "dshe-btn dshe-btn-primary", onClick: ack }, "开始使用")
                : h("button", { type: "button", className: "dshe-btn dshe-btn-primary", onClick: () => setPage(page + 1) }, "下一页")
            )
          )
        )
      );
    }

    /**
     * 全局介绍触发器：挂在 shell.overlay 上，拉一次 /meta 决定是否弹。
     * 已读版本与当前版本不同就弹（首次安装是 null ≠ 版本号）。
     * @returns {any} React 元素或 null
     */
    function IntroOverlay() {
      const [meta, setMeta] = useState(null);
      const [open, setOpen] = useState(false);
      const [closed, setClosed] = useState(false);

      useEffect(() => {
        let cancelled = false;
        fetchMeta().then((res) => {
          if (cancelled || res === null || res.ok !== true) return;
          setMeta(res);
          const seen = typeof res.introSeenVersion === "string" ? res.introSeenVersion : "";
          if (seen !== String(res.version || "")) setOpen(true);
        });
        return () => { cancelled = true; };
      }, []);

      if (open !== true || closed === true) return null;
      return h(IntroDialog, {
        version: meta !== null && typeof meta.version === "string" ? meta.version : "",
        onAck: () => { setClosed(true); setOpen(false); }
      });
    }

    /** 视觉特效开关的本机存储键（只存在当前浏览器，与参考项目一致）。 */
    var EFFECTS_KEY = "dsh-buddy-expert-hub:visual-effects:v2";

    /**
     * 智聊「运行状态 + 全局设置」共享状态：侧栏面板与设置页的新「智聊」tab 共用这一份逻辑，
     * 避免两处 saveSettings / 回显漂移。status 与 settings 都来自同一后端接口。
     * @returns {{status: any, settings: Object, setSettings: Function, saveSettings: Function, toast: string, setToast: Function, load: Function}} 共享状态
     */
    function useZhiliaStatusSettings() {
      const [status, setStatus] = useState(null);
      const [settings, setSettings] = useState({ replyBaseUrl: "", enabled: true });
      const [toast, setToast] = useState("");
      /** 只刷新运行状态（高频轮询用） */
      const loadStatus = useCallback(() => fetchJson("/zhiliao/status")
        .then((next) => setStatus(next))
        .catch((error) => setToast(String((error && error.message) || error))), []);
      /** 读取表单设置（仅初始化、保存后调用，避免覆盖用户正在输入的内容） */
      const loadSettings = useCallback(() => fetchJson("/zhiliao/settings")
        .then((rows) => {
          if (rows && rows.settings) {
            setSettings({
              replyBaseUrl: String(rows.settings.replyBaseUrl || ""),
              enabled: rows.settings.enabled !== false
            });
          }
        })
        .catch((error) => setToast(String((error && error.message) || error))), []);
      const load = useCallback(() => Promise.all([loadStatus(), loadSettings()]), [loadStatus, loadSettings]);
      useEffect(() => {
        load();
        // 只轮询运行状态：settings 是用户正在编辑的输入，若跟着轮询一起回填，
        // 输入框会出现「改不了 / 打几个字就被还原」。
        const timer = setInterval(loadStatus, 5000);
        return () => clearInterval(timer);
      }, [load, loadStatus]);
      useEffect(() => {
        if (toast === "") return undefined;
        const timer = setTimeout(() => setToast(""), 3200);
        return () => clearTimeout(timer);
      }, [toast]);
      const saveSettings = useCallback(() => zhiliaPost("/zhiliao/settings", settings).then((res) => {
        setToast(res.ok === true ? "智聊设置已保存" : zhiliaErrorText(res));
        loadSettings();
      }).catch((error) => setToast(String((error && error.message) || error))), [settings, loadSettings]);
      return { status, settings, setSettings, saveSettings, toast, setToast, load };
    }

    /**
     * 运行状态 + Webhook 设置的共享卡片（只搬位置，不改颜色/字段）。
     * @param {{status: any, settings: Object, setSettings: Function, saveSettings: Function, writePaused: boolean}} props 属性
     * @returns {any} React 元素
     */
    /** 仅运行状态卡片：供智聊面板放在绑定列表上方复用。 */
    function ZhiliaStatusOnlyCard(props) {
      const status = props.status;
      return h("div", { className: "dshe-zl-card" },
          h("h3", { className: "dshe-zl-title" }, "运行状态"),
          h("div", { className: "dshe-zl-meta" },
            "启用：" + (status !== null && status.enabled ? "是" : "否"),
            " · 绑定：" + (status !== null ? status.bindingCount : "-"),
            " · 会话：" + (status !== null ? status.chatSessionCount : "-"),
            " · 待发：" + (status !== null ? status.pendingCount : "-"),
            " · 测试模式：" + (status !== null && status.qaMode ? "开" : "关")
            + " · WS：" + (status !== null && status.ws && status.ws.authenticated ? "已连接" : "未连接")),
          h("div", { className: "dshe-zl-meta" },
            "队列：在飞 " + (status !== null && status.queue ? status.queue.inflight : "-")
            + " / 并发上限 " + (status !== null && status.queue ? status.queue.maxConcurrent : "-")
            + " · 排队 " + (status !== null && status.queue ? status.queue.queued : "-")
            + " · 每会话上限 " + (status !== null && status.queue ? status.queue.perKeyLimit : "-")
            + " · 全局上限 " + (status !== null && status.queue ? status.queue.globalLimit : "-")
            + " · 活跃会话 " + (status !== null && status.queue ? status.queue.activeChatKeys : "-")),
          h("div", { className: "dshe-zl-meta" },
            "回收：" + (status !== null && status.recycle && status.recycle.enabled ? "开" : "关")
            + " · 已回收 " + (status !== null && status.recycle ? status.recycle.recycled : "-")
            + " · 跳过 " + (status !== null && status.recycle ? status.recycle.recycleSkipped : "-")
            + (status !== null && status.uptimeMs ? " · 运行 " + Math.round(status.uptimeMs / 1000) + "s" : "")),
          h("div", {
            className: "dshe-zl-meta",
            style: status !== null && status.state !== undefined && status.state !== null
              && (status.state.dirty === true || status.state.lastError !== "")
              ? { color: "var(--dsw-alias-state-warning-primary,#9a6700)" }
              : undefined
          },
          "账本：" + (status !== null && status.state !== undefined && status.state !== null
            ? (status.state.dirty === true ? "待落盘" : "已落盘")
            : "-")
            + (status !== null && status.state !== undefined && status.state !== null && status.state.lastError !== ""
              ? " · 落盘失败：" + String(status.state.lastError) : "")),
          status !== null && status.multiHost === true
            ? h("div", {
                className: "dshe-zl-meta",
                style: { color: "var(--dsw-alias-state-warning-primary,#9a6700)" }
              },
              "检测到另一个 dsh 实例共用此 profile（pid "
              + (status.otherHost ? status.otherHost.pid : "?")
              + "），账本可能互相覆盖，请只保留一个；写入已暂停")
            : null,
          status !== null && status.bindings !== undefined && status.bindings !== null
            && status.bindings.expiredCount > 0
            ? h("div", {
                className: "dshe-zl-meta",
                style: { color: "var(--dsw-alias-state-warning-primary,#9a6700)" }
              }, "当前绑定凭证已失效 " + String(status.bindings.expiredCount) + " 个，请重新绑定")
            : null
        );
    }

    function ZhiliaStatusAndSettingsCard(props) {
      const settings = props.settings;
      const setSettings = props.setSettings;
      const saveSettings = props.saveSettings;
      const writePaused = props.writePaused === true;
      return h("div", null,
        h("div", { className: "dshe-zl-card" },
          h("h3", { className: "dshe-zl-title" }, "服务连接"),
          h("div", { className: "dshe-zl-form" },
            h("label", { className: "dshe-zl-label" }, "zhiliao-server 地址（可随时修改）",
              h("input", {
                className: "dshe-zl-input", type: "text", value: settings.replyBaseUrl,
                placeholder: "http://127.0.0.1:8080",
                onChange: (e) => setSettings(Object.assign({}, settings, { replyBaseUrl: e.target.value }))
              })),
            h("label", { className: "dshe-zl-check" },
              h("input", { type: "checkbox", checked: settings.enabled,
                onChange: (e) => setSettings(Object.assign({}, settings, { enabled: e.target.checked })) }),
              "启用智聊")),
          h("div", { style: { marginTop: "10px" } },
            h("button", { type: "button", className: "dshe-btn dshe-btn-primary", disabled: writePaused, onClick: saveSettings }, "保存设置"))
        )
      );
    }

    /** 设置页「智聊」tab：共享 hook + 共享卡片，不重复实现状态管理。 */
    function ZhiliaSettingsSection() {
      const shared = useZhiliaStatusSettings();
      const writePaused = shared.status !== null && shared.status.multiHost === true;
      return h("div", { className: "dshe-zl-wrap" },
        h(ZhiliaStatusAndSettingsCard, {
          status: shared.status,
          settings: shared.settings,
          setSettings: shared.setSettings,
          saveSettings: shared.saveSettings,
          writePaused,
        }),
        shared.toast !== "" ? h("div", { className: "dshe-toast" }, shared.toast) : null
      );
    }

    /**
     * dsh 设置页里的一页：头部（头像 / 标题 / 视觉特效 / Star）+ 横向分区导航 + 内容。
     *
     * dsh 的 SettingsRoot 只 renderSlot、不画标题，所以页头由这里自己给。
     * 前两个分区直接复用原设置弹窗组件（embedded 模式），保证行为与原来一致。
     * @param {{ onToast?: Function }} props 属性
     * @returns {any} React 元素
     */
    function SettingsTab(props) {
      const [section, setSection] = useState("remote");
      const [toast, setToast] = useState("");
      const [meta, setMeta] = useState(null);
      const [introOpen, setIntroOpen] = useState(false);
      /* 视觉特效：默认开启（没有动效就看不出这个开关在做什么），显式关过才保持关闭；
         开关状态只记在当前浏览器。 */
      const [effects, setEffects] = useState(() => {
        try {
          return window.localStorage.getItem(EFFECTS_KEY) !== "0";
        } catch {
          return true;
        }
      });

      useEffect(() => {
        fetchMeta().then((res) => { if (res !== null && res.ok === true) setMeta(res); });
      }, []);
      useEffect(() => {
        if (toast === "") return undefined;
        const timer = setTimeout(() => setToast(""), 3200);
        return () => clearTimeout(timer);
      }, [toast]);

      function toggleEffects() {
        const next = effects !== true;
        setEffects(next);
        try {
          window.localStorage.setItem(EFFECTS_KEY, next ? "1" : "0");
        } catch { /* 隐私模式写不了就只影响本次会话 */ }
      }

      const repoUrl = meta !== null && typeof meta.repoUrl === "string" && meta.repoUrl !== ""
        ? meta.repoUrl
        : "https://github.com/zhangzexu/dsh-buddy-expert-hub";
      const starUrl = meta !== null && typeof meta.starUrl === "string" && meta.starUrl !== ""
        ? meta.starUrl : repoUrl;
      const sections = [
        { id: "remote", label: "远程配置" },
        { id: "repo", label: "资源仓库" },
        { id: "workbench", label: "个人工作台" },
        { id: "khub", label: "在线资料库" },
        { id: "zhiliao", label: "智聊" },
        { id: "update", label: "插件升级" },
        { id: "about", label: "关于与反馈" }
      ];

      return h("div", { className: "dshe-setpage" + (effects === true ? " dshe-setpage-effects" : "") },
        h("div", { className: "dshe-setpage-head" },
          h("img", {
            className: "dshe-setpage-avatar",
            src: API + "/avatar",
            alt: "",
            width: 40,
            height: 40
          }),
          h("div", { className: "dshe-setpage-head-main" },
            h("h2", { className: "dshe-setpage-title" }, "Buddy 工作台"),
            h("p", { className: "dshe-setpage-sub" }, "专家 · 专家团 · 技能 · 连接器，以及个人工作台")
          ),
          h("div", { className: "dshe-setpage-head-actions" },
            h("span", { className: "dshe-setpage-effects" },
              h("span", null, "视觉特效"),
              h("button", {
                type: "button",
                id: "dshe-effects-toggle",
                className: "dshe-switch" + (effects === true ? " dshe-switch-on" : ""),
                role: "switch",
                "aria-checked": effects === true ? "true" : "false",
                "aria-label": "视觉特效",
                title: "开启后有常驻流光 / 呼吸光晕，切分区与悬浮也会动（只记在当前浏览器）",
                onClick: toggleEffects
              }, h("span", { className: "dshe-switch-dot" }))
            ),
            h("a", {
              id: "dshe-star-btn",
              className: "dshe-setpage-star",
              href: starUrl,
              target: "_blank",
              rel: "noreferrer noopener",
              title: "在 GitHub 打开仓库并点 Star"
            }, h(Icon, { name: "star", size: 14 }), h("span", null, "点个 Star"))
          )
        ),
        h("div", { className: "dshe-setpage-nav", role: "tablist", "aria-label": "Buddy 工作台设置分区" },
          sections.map((item) => h("button", {
            key: item.id,
            type: "button",
            role: "tab",
            "aria-selected": section === item.id ? "true" : "false",
            className: "dshe-setpage-tab" + (section === item.id ? " dshe-setpage-tab-on" : ""),
            onClick: () => setSection(item.id)
          },
            h("span", { className: "dshe-setpage-tab-label" }, item.label)
          ))
        ),
        h("div", { className: "dshe-setpage-body" },
          section === "repo"
            ? h(SettingsDialog, { embedded: true, onClose: () => {}, onToast: setToast })
            : null,
          section === "remote" ? h(RemoteConfigSection, { onToast: setToast }) : null,
          section === "workbench"
            ? h(WorkbenchSettingsDialog, { embedded: true, onClose: () => {}, onToast: setToast, onSaved: () => {} })
            : null,
          section === "zhiliao" ? h(ZhiliaSettingsSection) : null,
          section === "update" ? h(UpdateSection, { onToast: setToast }) : null,
          section === "about"
            ? h(AboutSection, {
                meta,
                onShowIntro: () => setIntroOpen(true)
              })
            : null,
          section === "khub"
            ? h(KhubSettingsSection, { onToast: setToast })
            : null
        ),
        introOpen
          ? h(IntroDialog, {
              version: meta !== null && typeof meta.version === "string" ? meta.version : "",
              onAck: () => { setIntroOpen(false); fetchMeta().then((res) => { if (res) setMeta(res); }); }
            })
          : null,
        toast !== "" ? h("div", { className: "dshe-toast" }, toast) : null
      );
    }

    // =======================================================================
    // 智聊面板（阶段 2）
    // =======================================================================

    /** 智聊侧栏入口图标：复用宿主通用气泡图标，不新增 svg 资源。 */
    function ZhiliaPanelIcon(props) {
      const size = typeof props.size === "number" ? props.size : 18;
      const active = props.active === true;
      return h("span", {
        className: "dshe-panel-icon" + (active ? " dshe-panel-icon-on" : ""),
        "aria-hidden": "true",
        "data-dsh-buddy-expert-hub-zhiliao-trigger": "1",
        style: { display: "inline-flex", alignItems: "center", justifyContent: "center" }
      }, h(Icon, { name: "chat", size: size }));
    }

    /** 智聊面板 JSON POST 简封装（同源，沿用 localRequestGuard）。 */
    function zhiliaPost(path, body) {
      return fetch(API + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body === undefined || body === null ? {} : body)
      }).then((resp) => resp.json());
    }

    /** 智聊面板 JSON DELETE 简封装。 */
    function zhiliaDelete(path) {
      return fetch(API + path, { method: "DELETE" }).then((resp) => resp.json());
    }

    /** 智聊接口错误文案：multi-host 503 直接展示后端 detail，其余回落 error/detail。 */
    /** 常见错误码 → 中文提示；detail 是后端给出的更具体说明，优先展示。 */
    var ZHILIA_ERROR_LABELS = {
      "invalid-arg": "参数不正确",
      "api-key-invalid": "API Key 无效",
      "target-not-found": "找不到这个测试对象",
      "test-failed": "测试消息发送失败",
      "delivery-failed": "回复发送失败",
      "not-found": "记录不存在",
      "not-bound": "当前还没有绑定",
      "api-key-save-failed": "API Key 保存失败",
      "register-failed": "绑定注册失败",
      "queue-full": "消息太多，稍后重试",
      "multi-host": "检测到另一个 dsh 实例，智聊写入已暂停"
    };

    function zhiliaErrorText(res) {
      if (res === null || typeof res !== "object") return String(res || "操作失败");
      var detail = String(res.detail || "").trim();
      // detail 是后端写好的中文说明，优先给用户看
      if (detail !== "") return detail;
      var code = String(res.error || res.message || "").trim();
      if (code === "") return "操作失败";
      return ZHILIA_ERROR_LABELS[code] || ("操作失败：" + code);
    }

    /** 上次poll到的待发数：只在「变多」时提醒，避免 5 秒轮询刷屏。 */
    var zhiliaoLastPendingCount = -1;

    var ZHILIA_EMPTY_FORM = {
      bindingId: "", apiKey: "", testTarget: "", replyPrefix: "", autoReply: true, requireConfirm: false,
      enabled: true, mentionOnly: true, groups: ""
    };

    /**
     * 智聊面板：绑定管理 + 策略配置 + 待发草稿 + webhook 设置。
     * 与资料库/工作台面板并列的第三个侧栏入口（order 15）。
     * @returns {any} React 元素
     */
    function ZhiliaPanel() {
      /* 运行状态 / 全局设置由共享 hook 管理，设置页「智聊」tab 用的是同一份逻辑。 */
      const shared = useZhiliaStatusSettings();
      const status = shared.status;
      const toast = shared.toast;
      const setToast = shared.setToast;
      const [bindings, setBindings] = useState([]);
      const [pending, setPending] = useState([]);
      const [form, setForm] = useState(ZHILIA_EMPTY_FORM);
      const [editing, setEditing] = useState(false);
      const [formOpen, setFormOpen] = useState(false);
      const [testResult, setTestResult] = useState(null);
      const [atUid, setAtUid] = useState("");
      const [openHint, setOpenHint] = useState("");
      /* 多实例时后端对写路径返 503：面板把写操作按钮禁用，避免用户白点。 */
      const writePaused = status !== null && status.multiHost === true;

      const load = useCallback(() => {
        Promise.all([
          fetchJson("/zhiliao/bindings"), fetchJson("/zhiliao/pending")
        ]).then((rows) => {
          setBindings(Array.isArray(rows[0].bindings) ? rows[0].bindings : []);
          const nextPending = Array.isArray(rows[1].pending) ? rows[1].pending : [];
          setPending(nextPending);
          /* 新增待发草稿时广播一个 DOM 事件，apply 里的监听器再走 notifySession 提醒。 */
          if (zhiliaoLastPendingCount >= 0 && nextPending.length > zhiliaoLastPendingCount) {
            try {
              const event = new CustomEvent("dsh-buddy-expert-hub:zhiliao-pending", { detail: { count: nextPending.length } });
              window.dispatchEvent(event);
            } catch { /* 非 DOM 环境降级 */ }
          }
          zhiliaoLastPendingCount = nextPending.length;
        }).catch((error) => setToast(String((error && error.message) || error)));
      }, [setToast]);

      useEffect(() => {
        load();
        const timer = setInterval(load, 5000);
        return () => clearInterval(timer);
      }, [load]);

      /* 业务写操作后同时刷新共享状态（status/settings）与绑定/草稿列表。 */
      const reloadAll = () => { shared.load(); load(); };

      const setField = (key, value) => setForm((old) => Object.assign({}, old, { [key]: value }));

      /** 打开新增表单 */
      const openNewForm = () => {
        setForm(ZHILIA_EMPTY_FORM);
        setEditing(false);
        setTestResult(null);
        setOpenHint("");
        setFormOpen(true);
      };

      const resetForm = () => {
        setForm(ZHILIA_EMPTY_FORM);
        setEditing(false);
        setFormOpen(false);
        setTestResult(null);
        setOpenHint("");
      };

      const saveBinding = () => {
        const body = {
          baseUrl: String(shared.settings.replyBaseUrl || "").trim(),
          replyPrefix: form.replyPrefix,
          autoReply: form.autoReply, requireConfirm: form.requireConfirm,
          enabled: form.enabled !== false,
          scope: {
            groups: String(form.groups || "").split(/[,，\s]+/).filter((v) => v !== ""),
            mentionOnly: form.mentionOnly,
            dms: true
          }
        };
        if (String(form.apiKey || "").trim() !== "") body.apiKey = String(form.apiKey).trim();
        if (String(form.bindingId || "").trim() !== "") body.bindingId = String(form.bindingId).trim();
        if (editing !== true && body.apiKey === undefined) { setToast("请填写 API Key"); return; }
        zhiliaPost("/zhiliao/binding", body).then((res) => {
          setToast(res.ok === true ? (editing === true ? "修改已保存" : "绑定成功") : zhiliaErrorText(res));
          if (res.ok === true) {
            setEditing(false);
            setFormOpen(false);
            setForm(Object.assign({}, ZHILIA_EMPTY_FORM, { testTarget: form.testTarget || "" }));
            reloadAll();
          }
        }).catch((error) => setToast(String((error && error.message) || error)));
      };

      const testBinding = () => {
        const payload = {
          baseUrl: String(shared.settings.replyBaseUrl || "").trim(),
          testTarget: String(form.testTarget || "").trim(),
        };
        if (String(form.apiKey || "").trim() !== "") payload.apiKey = String(form.apiKey).trim();
        if (String(atUid || "").trim() !== "") payload.atUidList = [String(atUid).trim()];
        zhiliaPost("/zhiliao/binding/test", payload).then((res) => {
          if (res.ok !== true) { setTestResult(null); setToast(zhiliaErrorText(res)); return; }
          setTestResult({
            to: String(res.targetName || res.targetId || res.targetAccount || ""),
            targetId: String(res.targetId || res.targetAccount || ""),
            targetType: res.targetType === "group" ? "group" : "user",
            targetAccount: String(res.targetId || res.targetAccount || ""),
            convKey: String(res.convKey || ""),
            convKeyDesc: String(res.convKeyDesc || ""),
            existingSessionId: String(res.existingSessionId || ""),
            as: res.as === "user" ? "user" : "ai",
            testUid: "",
            content: "智聊绑定测试",
            msgId: String(res.msgId || "-"),
            seq: String(res.seq || ""),
            sentAt: new Date().toLocaleString("zh-CN", { hour12: false }),
            saved: false,
            saveError: "",
          });
          setOpenHint("");
          setToast("绑定测试消息已发送");
        }).catch((error) => setToast(String((error && error.message) || error)));
      };

      const editBinding = (b) => {
        setEditing(true);
        setFormOpen(true);
        setTestResult(null);
        setOpenHint("");
        setForm({
          bindingId: b.bindingId || "",
          apiKey: "",
          testTarget: b.userId ? "u:" + String(b.userId) : "",
          replyPrefix: b.replyPrefix || "",
          autoReply: b.autoReply !== false, requireConfirm: b.requireConfirm === true,
          enabled: b.enabled !== false,
          mentionOnly: b.scope === null || b.scope === undefined || b.scope.mentionOnly !== false,
          groups: Array.isArray(b.scope && b.scope.groups) ? b.scope.groups.join(",") : ""
        });
      };

      const pendingAction = (kind, msgId) => zhiliaPost("/zhiliao/pending/" + kind, { msgId: msgId })
        .then((res) => { setToast(res.ok === true ? (kind === "send" ? "已发送" : "已丢弃") : zhiliaErrorText(res)); reloadAll(); })
        .catch((error) => setToast(String((error && error.message) || error)));

      /* 测试成功后打开专属会话：create → open → 把 chatKey→sessionId 写回后端，
         确保后续该联系人的消息进入刚打开的这个会话。宿主能力未就绪时保留行内提示。 */
      /** 把 DSH 当前打开的会话绑定到该聊天对象：归档旧会话后用它指定新会话接收消息。 */
      const bindCurrentChatSession = async () => {
        const bridge = zhiliaOpenChatBridge;
        const chatKey = String(testResult.convKey || "");
        if (bridge === null || typeof bridge.currentSessionId !== "function" || chatKey === "") {
          setOpenHint("当前无法读取会话，请先打开一个会话再绑定");
          return;
        }
        const sid = String(bridge.currentSessionId() || "");
        if (sid === "") { setOpenHint("当前没有打开的会话，请先在 DSH 打开一个会话"); return; }
        try {
          const bound = await zhiliaPost("/zhiliao/chat-session/bind", { chatKey, dshSessionId: sid });
          if (bound.ok !== true) { setOpenHint("绑定失败：" + zhiliaErrorText(bound)); return; }
          setTestResult(Object.assign({}, testResult, { dshSessionId: sid, reused: true, opened: true }));
          setOpenHint("已把当前会话绑定到该联系人，之后 TA 的消息会进入这里");
        } catch (error) {
          setOpenHint("绑定失败：" + String((error && error.message) || error));
        }
      };

      const openTestChat = async () => {
        const bridge = zhiliaOpenChatBridge;
        const chatKey = String(testResult.convKey || "");
        if (bridge === null || typeof bridge.open !== "function" || chatKey === "") {
          setOpenHint("会话桥尚未就绪或缺少会话键");
          return;
        }
        try {
          /* 交给后端自愈：确保工作区存在（删了会重建）、会话可见（归档会重建），
             返回可用的 sessionId + workspaceId；前端只负责打开并选中工作区。 */
          const title = (testResult.to || "智聊") + " · " + chatKey;
          const ensured = await zhiliaPost("/zhiliao/session/ensure", {
            chatKey,
            bindingId: bindings.length > 0 ? String(bindings[0].bindingId || "") : "",
            title,
          });
          if (ensured.ok !== true) { setOpenHint("会话准备失败：" + zhiliaErrorText(ensured)); return; }
          const sid = String(ensured.sessionId || "");
          const workspaceId = String(ensured.workspaceId || "");
          if (sid === "") { setOpenHint("会话准备失败：未获得会话 id"); return; }

          // 先在工作区打开/选中（等价于顶部"选择工作区"），再打开目标会话
          if (workspaceId !== "" && typeof bridge.selectWorkspace === "function") {
            await bridge.selectWorkspace(workspaceId, sid);
          }
          const opened = bridge.open(sid) === true;
          setTestResult(Object.assign({}, testResult, {
            opened, dshSessionId: sid, reused: ensured.reused === true,
          }));
          setOpenHint(ensured.reused === true
            ? "已打开该联系人原有会话"
            : "已在该联系人的工作区新建并打开会话");
          if (typeof bridge.show === "function") bridge.show();
        } catch (error) {
          setOpenHint("打开会话失败：" + String((error && error.message) || error));
        }
      };

      return h("div", { className: "dshe-root" },
        h("div", { className: "dshe-zl-wrap" },

          /* 运行状态前置到绑定列表上方（服务连接地址仍在 设置→Buddy 工作台→智聊） */
          h(ZhiliaStatusOnlyCard, { status: shared.status }),

          h("div", { className: "dshe-zl-card" },
            h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", marginBottom: "6px" } },
              h("h3", { className: "dshe-zl-title" }, "身份绑定"),
              h("button", { type: "button", className: "dshe-btn dshe-btn-primary", disabled: writePaused, onClick: openNewForm }, "＋ 新增绑定")),
            bindings.length === 0
              ? h("div", { className: "dshe-zl-empty" }, "还没有绑定，点右上角「＋ 新增绑定」添加")
              : bindings.map((b) => h("div", { className: "dshe-zl-row", key: b.bindingId },
                h("span", { className: "dshe-zl-name" }, b.displayName || b.bindingId),
                h("span", { className: "dshe-zl-tag" }, b.needsRebind === true ? "待重新绑定" : (b.aiId ? "AI" : "本人")),
                h("span", { className: "dshe-zl-meta" }, "会话 " + (b.chatSessionCount || 0)),
                h("span", { className: "dshe-zl-meta" }, b.enabled === false ? "已停用" : (b.paused ? "已暂停" : "运行中")),
                h("span", {
                  className: "dshe-zl-meta",
                  style: b.ws !== null && b.ws !== undefined && b.ws.authenticated === true
                    ? { color: "var(--dsw-alias-state-success-primary,#1a7f37)" } : null
                }, "WS " + (b.ws !== null && b.ws !== undefined && b.ws.authenticated === true
                  ? "已连接" : (b.ws !== null && b.ws !== undefined && b.ws.connected === true ? "连接中" : "未连接"))),
                h("span", { className: "dshe-zl-meta", title: String(b.workDir || "") },
                  "工作区 " + (String(b.workDir || "").split(/[\\/]/).filter(Boolean).pop() || "-")),
                b.needsRebind === true
                  ? h("span", {
                      className: "dshe-zl-tag",
                      style: { color: "var(--dsw-alias-state-warning-primary,#9a6700)" }
                    }, "旧 HuLa 绑定已失效，请用 API Key 重新绑定")
                  : null,
                h("button", { type: "button", className: "dshe-btn", onClick: () => editBinding(b) }, "编辑"),
                h("button", { type: "button", className: "dshe-btn dshe-btn-danger", disabled: writePaused,
                  onClick: () => zhiliaDelete("/zhiliao/binding?id=" + encodeURIComponent(b.bindingId))
                    .then((res) => { setToast(res.ok === true ? "已删除" : zhiliaErrorText(res)); reloadAll(); })
                    .catch((error) => setToast(String((error && error.message) || error))) }, "删除"))),
          ),
          formOpen
          ? h("div", {
              style: {
                position: "fixed", inset: 0, zIndex: 1000, display: "flex",
                alignItems: "center", justifyContent: "center",
                background: "rgba(0,0,0,0.55)",
              },
              onClick: (e) => { if (e.target === e.currentTarget) resetForm(); },
            },
              h("div", {
                style: {
                  width: "min(680px, 92vw)", maxHeight: "88vh", overflowY: "auto",
                  padding: "16px 18px", borderRadius: "10px",
                  background: "var(--dsw-alias-bg-layer-2,#252525)",
                  border: "1px solid var(--dsw-alias-border-l1,#d0d7de)",
                  boxShadow: "0 12px 40px rgba(0,0,0,0.4)",
                },
              },
h("div", { style: { marginTop: "12px" } },
              h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" } },
                h("h4", { className: "dshe-zl-title" }, editing === true
                  ? "编辑绑定：" + ((bindings.find((x) => x.bindingId === form.bindingId) || {}).displayName || form.bindingId || "")
                  : "新增绑定（填另一个账号的 API Key）"),
                h("button", { type: "button", className: "dshe-btn", onClick: resetForm, title: "关闭" }, "× 关闭")),
              h("div", { className: "dshe-zl-form" },
                h("label", { className: "dshe-zl-label" }, "API Key",
                  h("input", {
                    className: "dshe-zl-input", type: "password", value: form.apiKey,
                    placeholder: editing === true ? "留空表示沿用已保存 Key" : "sk_...",
                    onChange: (e) => setField("apiKey", e.target.value)
                  })),
                h("div", { className: "dshe-zl-meta" }, "API Key 用 AES-256-GCM 加密保存在本地，state 只存引用，不会回显"),
                h("label", { className: "dshe-zl-label" }, "绑定测试目标（用户账号 / 手机号 / 邮箱，或群 ID）",
                  h("input", {
                    className: "dshe-zl-input", value: form.testTarget,
                    placeholder: "如 10000001 / 138xxxx0000 / a@b.com / AI账号；群填 g:456",
                    onChange: (e) => setField("testTarget", e.target.value)
                  })),
                h("label", { className: "dshe-zl-label" }, "@ 用户 ID（群测试可选，留空不 @）",
                  h("input", {
                    className: "dshe-zl-input", value: atUid,
                    placeholder: "群测试要 @ 的 userId",
                    onChange: (e) => setAtUid(e.target.value)
                  })),
                h("label", { className: "dshe-zl-label" }, "回复前缀",
                  h("input", { className: "dshe-zl-input", value: form.replyPrefix, onChange: (e) => setField("replyPrefix", e.target.value) })),
                h("label", { className: "dshe-zl-label" }, "群白名单（逗号分隔）",
                  h("input", { className: "dshe-zl-input", value: form.groups, onChange: (e) => setField("groups", e.target.value) })),
                h("label", { className: "dshe-zl-check" },
                  h("input", { type: "checkbox", checked: form.autoReply, onChange: (e) => setField("autoReply", e.target.checked) }), "自动回复"),
                h("label", { className: "dshe-zl-check" },
                  h("input", { type: "checkbox", checked: form.requireConfirm, onChange: (e) => setField("requireConfirm", e.target.checked) }), "发送前确认"),
                h("label", { className: "dshe-zl-check" },
                  h("input", { type: "checkbox", checked: form.mentionOnly, onChange: (e) => setField("mentionOnly", e.target.checked) }), "群聊必须 @ 才触发"),
                h("div", { className: "dshe-zl-meta" },
                  "勾选时，群里只有 @ 你绑定的账号才会触发智聊；未勾选则群内所有消息都会进入智聊"),
                h("label", { className: "dshe-zl-check" },
                  h("input", { type: "checkbox", checked: form.enabled !== false, onChange: (e) => setField("enabled", e.target.checked) }), "启用该绑定（取消即手动停用）")),
              h("div", { style: { marginTop: "10px", display: "flex", gap: "8px" } },
                h("button", { type: "button", className: "dshe-btn dshe-btn-primary", disabled: writePaused, onClick: saveBinding }, editing === true ? "保存修改" : "保存绑定"),
                editing === true
                  ? null
                  : h("button", {
                      type: "button", className: "dshe-btn",
                      disabled: writePaused || String(form.testTarget || "").trim() === "",
                      onClick: testBinding
                    }, "绑定测试"),
                h("button", { type: "button", className: "dshe-btn", onClick: resetForm }, editing === true ? "取消" : "清空")))
              ))
          : null,

          testResult !== null
            ? h("div", { className: "dshe-zl-card" },
                h("h3", { className: "dshe-zl-title" }, "绑定测试结果"),
                h("div", { className: "dshe-zl-meta" },
                  "发送给：" + testResult.to
                  + "（" + (testResult.targetType === "group" ? "群聊" : "用户") + "，ID " + (testResult.targetId || "-") + "）"),
                h("div", { className: "dshe-zl-meta", title: "会话键用于唯一标识这段对话" },
                  "会话：" + (testResult.convKeyDesc || "与对方的一对一私聊")
                  + "（内部标识 " + testResult.convKey + "）"),
                h("div", { className: "dshe-zl-text" }, testResult.content),
                h("div", { className: "dshe-zl-meta" }, "消息编号：" + testResult.msgId + (testResult.seq !== "" ? " · 序号 " + testResult.seq : "")),
                h("div", { className: "dshe-zl-meta" }, "以谁的身份发送：" + (testResult.as === "user" ? "真人本人（AI 代你回复）" : "AI 好友自己")),
                h("div", { className: "dshe-zl-meta" }, "发送时间：" + testResult.sentAt),
                h("div", { className: "dshe-zl-meta", style: { lineHeight: 1.6 } },
                  "这条测试消息已真实发出。点击「保存绑定」后，插件会连接智聊并实时接收对方发来的消息，交给 AI 自动生成回复。"),
                /* 会话入口卡片：文字头像 + 对方名称，点击直接打开；不再用宿主那条通知条 */
                h("div", {
                  role: "button",
                  tabIndex: 0,
                  title: "点击打开与该联系人的会话",
                  onClick: (testResult.saved === true || bindings.length > 0) ? openTestChat : undefined,
                  style: {
                    marginTop: "10px", display: "flex", alignItems: "center", gap: "10px",
                    padding: "8px 10px", borderRadius: "8px", cursor: "pointer",
                    border: "1px solid var(--dsw-alias-border-l1,#d0d7de)",
                    background: "var(--dsw-alias-bg-layer-1,rgba(127,127,127,0.08))",
                    opacity: (testResult.saved === true || bindings.length > 0) ? 1 : 0.6,
                  },
                },
                  h("span", {
                    style: {
                      width: "32px", height: "32px", flex: "0 0 32px", borderRadius: "50%",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: "14px", fontWeight: 600, color: "#fff",
                      background: "var(--dsw-alias-brand-primary,#4c8bf5)",
                    },
                  }, String(testResult.to || "?").slice(0, 1).toUpperCase()),
                  h("span", { style: { flex: 1, minWidth: 0 } },
                    h("div", { style: { fontSize: "12px", fontWeight: 600 } },
                      "与 " + (testResult.to || "该联系人") + " 的会话"),
                    h("div", { className: "dshe-zl-meta", style: { fontSize: "11px" } },
                      testResult.reused === true
                        ? "点击打开原有会话（含此前消息）"
                        : (testResult.opened === true ? "点击再次打开" : "点击打开会话"))),
                  h("span", { style: { fontSize: "12px", opacity: 0.7 } }, "→")),
                /* 归档旧会话后：把 DSH 当前打开的会话指定给该联系人接收消息 */
                h("button", {
                  type: "button",
                  className: "dshe-btn",
                  style: { marginTop: "6px", width: "100%", fontSize: "11px" },
                  title: "先在 DSH 打开一个会话，再点这里，之后 TA 的消息就进这个会话",
                  onClick: bindCurrentChatSession,
                }, "用当前 DSH 会话接收 TA 的消息"),
                /* openHint 只在出错时显示（打开成功不再用宿主通知条）；
                   注意上面必须带逗号分隔，否则 (...) 会被当成函数调用导致渲染崩溃 */
                (openHint !== "" && testResult.opened !== true)
                  ? h("div", { className: "dshe-zl-meta", style: { marginTop: "6px" } }, openHint)
                  : null
              )
            : null,

          h("div", { className: "dshe-zl-card" },
            h("h3", { className: "dshe-zl-title" }, "待发草稿（requireConfirm）"),
            pending.length === 0
              ? h("div", { className: "dshe-zl-empty" }, "暂无待发草稿")
              : pending.map((p) => h("div", { className: "dshe-zl-row", key: p.msgId },
                h("div", { style: { flex: "1 1 100%" } },
                  h("div", { className: "dshe-zl-meta" }, p.msgId + " · " + p.chatKey),
                  h("div", { className: "dshe-zl-text" }, p.text)),
                h("button", { type: "button", className: "dshe-btn dshe-btn-primary", disabled: writePaused, onClick: () => pendingAction("send", p.msgId) }, "发送"),
                h("button", { type: "button", className: "dshe-btn", disabled: writePaused, onClick: () => pendingAction("discard", p.msgId) }, "丢弃"))))
        ),
        toast !== "" ? h("div", { className: "dshe-toast" }, toast) : null
      );
    }

    /**
     * 注册主面板与侧边栏入口。
     * @param {any} ctx 插件上下文
     * @returns {void}
     */
    function apply(ctx) {
      applyStyles(ctx);
      /* 宿主声明 ctx.uiWorkspace: UiWorkspace；但插件 inject 未声明该服务，
         直接读属性会触发 inject 代理抛错，必须用安全访问器（ctx.get / ctx.reflect + try/catch）。 */
      zhiliaUiWorkspace = pickHostService(ctx, "uiWorkspace", "openSession");
      // workspaceNavigation 可能挂在 uiWorkspace 上，也可能是独立服务；两个都试
      zhiliaWorkspaceNav = pickHostService(ctx, "uiWorkspace", "openWorkspace")
        || pickHostService(ctx, "workspaceNavigation", "openWorkspace");

      /* 智聊待发提醒：面板轮询发现新草稿后发 DOM 事件，这里接到既有的
         notifySession sink 上；composer 没挂载（sink 为空）时静默跳过。 */
      ctx.effect(() => {
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        const handler = () => {
          if (typeof expertNotify !== "function") return;
          const sid = resolveSessionId(null);
          if (sid !== "") expertNotify(sid, "智聊有新的待发草稿，请在智聊面板确认发送", "info");
        };
        window.addEventListener("dsh-buddy-expert-hub:zhiliao-pending", handler);
        return () => window.removeEventListener("dsh-buddy-expert-hub:zhiliao-pending", handler);
      }, "dsh-buddy-expert-hub: zhiliao pending notify");

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

      /* 个人工作台：与「专家·技能·连接器」并列的独立侧栏入口 + 独立主面板。
         原有的两个注册 options 逐字不变，这里只做追加。
         order 13 > 现有 12，宿主按 order 升序渲染即可排在下方 ——
         【需宿主实机验证】排序规则由宿主决定，插件侧无法自证，属运行时不可证项。 */
      ctx.slots.inject("main", () =>
        ctx.slots.register({
          name: "main",
          key: PANEL_ID + "-workbench",
          inject: () => ({})
        }, WorkbenchPanel)
      );

      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID + "-workbench",
          order: 13,
          label: () => "个人工作台"
        }, WorkbenchPanelIcon)
      );

      /* 在线资料库：与「专家·技能·连接器」「个人工作台」并列的独立侧栏入口。 */
      ctx.slots.inject("main", () =>
        ctx.slots.register({
          name: "main",
          key: PANEL_ID + "-library",
          inject: () => ({})
        }, LibraryPanel)
      );

      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID + "-library",
          order: 14,
          label: () => "资料库"
        }, LibraryPanelIcon)
      );

      /* 智聊：第四个小节，order 15 > 现有 14；绑定 / 策略 / 待发草稿都在这块。 */
      ctx.slots.inject("main", () =>
        ctx.slots.register({
          name: "main",
          key: PANEL_ID + "-zhiliao",
          inject: () => ({})
        }, ZhiliaPanel)
      );

      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID + "-zhiliao",
          order: 15,
          label: () => "智聊"
        }, ZhiliaPanelIcon)
      );

      /* dsh 设置页（设置左侧导航）：「Buddy 工作台」与「内置插件」同级，
         一页放资源仓库 / 个人工作台 / 插件升级 / 关于与反馈四个分区；
         面板与工作台工具条不再有齿轮入口。 */
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register({
          name: "settings.section",
          id: PANEL_ID,
          order: 16,
          label: () => "Buddy 工作台"
        }, SettingsTab)
      );

      /* 首次安装 / 版本变化后的介绍弹窗：挂全局 overlay，不占任何布局空间。 */
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register({
          name: "shell.overlay",
          id: PANEL_ID + "-intro"
        }, IntroOverlay)
      );

      applyComposer(ctx);
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
