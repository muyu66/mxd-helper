// tippy 初始化：库缺失时静默跳过，不影响数据加载与表格渲染
function initTippy(delayMs) {
  if (typeof window.tippy !== "function") return;
  tippy('[data-tippy-content]', {
    placement: 'top',
    arrow: true,
    animation: 'shift-away',
    delay: [delayMs, 0],
    theme: 'light',
  });
}
// 全局 tippy（表单等静态元素）
initTippy(200);

// 点击筛选面板外部时关闭面板
// 用 composedPath 而非 target.closest：行内删除按钮会把所在行从 DOM 移除，
// 事件冒泡到 document 时 target 已脱离 DOM，closest 会误判为面板外部
document.addEventListener("click", (e) => {
  const inFilterWrap = e.composedPath().some(
    (el) => el instanceof Element && el.classList.contains("filter-wrap"),
  );
  if (!inFilterWrap) {
    document.querySelectorAll(".filter-popup.open").forEach((p) => p.classList.remove("open"));
  }
});

// 表头右侧控件：技能耗蓝输入框 + 物防/魔防切换开关 + 计算排行按钮
function headerControlsHtml(mValue) {
  // 尚未计算排行（无表格）时禁用对比按钮
  const cmpDisabled = !currentRender ? " disabled" : "";
  return `
        <button class="btn btn-sm cmp-btn${compareMode ? " active" : ""}"${cmpDisabled} onclick="toggleCompare()" title="对比模式：先点击「计算排行」，开启后依次点击表格两行，第一行为原目标、第二行为对比目标">⚖️ 对比</button>
        <label for="M">技能耗蓝</label>
        <input type="number" id="M" placeholder="默认 20" step="any" min="0.01" value="${mValue}" />
        <label class="def-toggle" title="切换物防/魔防展示">
          <input type="checkbox" id="defToggle"${defenseMode === "pdd" ? " checked" : ""} />
          <span class="def-opt def-mdd">魔防</span>
          <span class="def-opt def-pdd">物防</span>
        </label>
        <button class="btn btn-sm" onclick="calc()"><span>🔍</span> 计算排行</button>`;
}

// 对比模式开关：开启后依次点击表格两行；再次点击或关闭面板即退出并清空选择
function toggleCompare() {
  if (!currentRender) return; // 未计算排行（无表格）时按钮已禁用，双保险
  compareMode = !compareMode;
  if (!compareMode) {
    compareAMobid = null;
    compareBMobid = null;
  }
  currentRender();
}

let monsterData = [];
let equipMap = {}; // mobid → [{level, rate}, ...]
let currentRanked = [];
let filters = []; // 筛选条件 [{col, op, value, logic}]，logic 为该条与上一条的与/或关系（首条忽略）
let defenseMode = "mdd"; // 防具列展示模式："mdd" 魔防 / "pdd" 物防
let currentRender = null; // 最近一次 calc 的 renderTable，供切换开关触发重绘
let compareMode = false; // 对比模式开关：开启后点击表格行选择原目标/对比目标
let compareAMobid = null; // 对比：原目标 mobid
let compareBMobid = null; // 对比：对比目标 mobid

// 物防/魔防切换开关（模块级委托，初始加载页与结果页都能生效）
document.addEventListener("change", (e) => {
  if (e.target.id !== "defToggle") return;
  defenseMode = e.target.checked ? "pdd" : "mdd";
  if (currentRender) currentRender();
});

(async function loadData() {
  const res = document.getElementById("result");
  res.innerHTML = `
    <div class="empty-state">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <p>加载怪物数据中...</p>
    </div>
  `;

  try {
    // 数据读取：优先用 <script> 注入的 window 全局（file:// 双击可用），
    // 缺失时回退 fetch（兼容本地服务器等 http 环境）
    const loadJson = (global, url) =>
      window[global]
        ? Promise.resolve(window[global])
        : fetch(url).then((r) => {
          if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
          return r.json();
        });
    const [json, equipData] = await Promise.all([
      loadJson("RANK_DATA", "data.json"),
      loadJson("RANK_EQUIPMENT", "equipment.json").catch(() => null),
    ]);
    monsterData = (json.items || []).filter(
      (m) => (m.maxMonsterCount ?? 0) >= 10,
    );
    document.getElementById("stat-total").textContent = monsterData.length;

    // 构建装备查找表
    if (equipData) {
      for (const e of equipData) {
        if (!equipMap[e.mobid]) equipMap[e.mobid] = [];
        equipMap[e.mobid].push({ level: e.level, rate: e.rate, money: e.money });
      }
    }

    res.innerHTML = `
      <div class="table-card">
        <div class="table-card-header">
          <div class="title">🏆 排行</div>
          <div class="header-right">${headerControlsHtml("")}</div>
        </div>
        <div class="empty-state">
          <div class="empty-icon">🎯</div>
          <p>输入参数后点击「计算排行」查看结果</p>
          <span class="hint">全部怪物按经验效率排序</span>
        </div>
      </div>
    `;
  } catch (err) {
    res.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">❌</div>
        <p>加载 data.json 失败</p>
        <span class="hint">${err.message}</span>
      </div>
    `;
  }
})();

function calc() {
  const errEl = document.getElementById("error");
  errEl.style.display = "none";
  errEl.textContent = "";

  const M = parseFloat(document.getElementById("M").value) || 20;
  if (isNaN(M) || M <= 0) {
    showError("M 必须是一个大于 0 的数字");
    return;
  }
  if (!monsterData.length) {
    showError("数据尚未加载完成，请稍候再试");
    return;
  }

  const ranked = [];
  for (const m of monsterData) {
    const hp = parseFloat(m.hp);
    const exp = parseFloat(m.exp);
    if (isNaN(hp) || hp <= 0 || isNaN(exp) || exp < 0) continue;

    // 掉落装备加权平均等级 & 价格
    let _avgEquipLevel = null, _avgEquipMoney = null;
    const eqList = equipMap[m.mobid];
    if (eqList && eqList.length) {
      let totalWeight = 0, weightedLevel = 0, weightedMoney = 0;
      for (const eq of eqList) {
        weightedLevel += eq.level * eq.rate;
        weightedMoney += (eq.money || 0) * eq.rate;
        totalWeight += eq.rate;
      }
      if (totalWeight > 0) {
        _avgEquipLevel = weightedLevel / totalWeight;
        _avgEquipMoney = weightedMoney / totalWeight;
      }
    }

    // 弱点元素名列表（筛选用），以及对应的展示 HTML
    const weakElems = (m.elementTags || [])
      .map((t) => (t.label || t))
      .filter((l) => l.endsWith("弱点"))
      .map((l) => l.replace("弱点", ""));

    const entry = {
      ...m,
      _avgEquipLevel,
      _avgEquipMoney,
      _weakElems: weakElems,
      _weakness: weakElems
        .map((e) => `<span class="weak-tag weak-${e}">${e}</span>`)
        .join(""),
    };

    // divisor 直接按列名（打几下）配置，攻击数量 C 固定为 1:
    // 打N下效率 = 经验 ÷ N；打N下每点耗蓝收益比 = 总期望金币 ÷ (N × 技能耗蓝)
    for (const n of [1, 2, 3, 4]) {
      entry[`_eff${n}`] = exp / n;
      entry[`_goldMp${n}`] = _avgEquipMoney != null
        ? _avgEquipMoney / (n * M)
        : null;
    }
    // 升级效率⑥ = 经验 ÷ 6（假设6下击杀）
    entry._eff6 = exp / 6;
    // 回本/升级比 = 回本效率① ÷ 升级效率①
    entry._ratio1 = entry._goldMp1 != null && entry._eff1 > 0
      ? entry._goldMp1 / entry._eff1
      : null;
    // 血量经验比 = 血量 ÷ 经验
    entry._hpExp = exp > 0 ? hp / exp : null;

    ranked.push(entry);
  }

  // default sort by level asc
  const DEF_SORT = { col: "level", asc: true };
  let sortState = { col: DEF_SORT.col, asc: DEF_SORT.asc };

  const COLS = [
    { key: "level", label: "等级", tip: "怪物等级" },
    { key: "mobname", label: "怪物", cls: "monster-name", tip: "怪物名称" },
    { key: "hp", label: "HP", tip: "怪物血量" },
    { key: "mp", label: "MP", tip: "怪物蓝量" },
    { key: "_defense", label: "魔防", tip: "怪物魔防" }, // 实际取 mdd/pdd，随 defenseMode 切换
    { key: "exp", label: "EXP", tip: "怪物经验值" },
    { key: "_hpExp", label: "难度", tip: "怪物血量 ÷ 经验" },
    { key: "_ratio1", label: "性价比", cls: "ratio", tip: "一下秒的情况下，每1点经验的回本价值" },
    { key: "_eff1", label: "升级效率①", cls: "score", tip: "假设1下击杀怪物" },
    { key: "_eff2", label: "升级效率②", cls: "score", tip: "假设2下击杀怪物" },
    { key: "_eff3", label: "升级效率③", cls: "score", tip: "假设3下击杀怪物" },
    { key: "_eff4", label: "升级效率④", cls: "score", tip: "假设4下击杀怪物" },
    { key: "_eff6", label: "升级效率⑥", cls: "score", tip: "假设6下击杀怪物" },
    { key: "_goldMp1", label: "回本效率①", cls: "gold-mp", tip: "假设1下击杀时，每消耗1点蓝量期望获得的装备金币价值，不是直接收益，只是对比值" },
    { key: "_goldMp2", label: "回本效率②", cls: "gold-mp", tip: "假设2下击杀时，每消耗1点蓝量期望获得的装备金币价值，不是直接收益，只是对比值" },
    { key: "_goldMp3", label: "回本效率③", cls: "gold-mp", tip: "假设3下击杀时，每消耗1点蓝量期望获得的装备金币价值，不是直接收益，只是对比值" },
    { key: "_goldMp4", label: "回本效率④", cls: "gold-mp", tip: "假设4下击杀时，每消耗1点蓝量期望获得的装备金币价值，不是直接收益，只是对比值" },
    { key: "_avgEquipLevel", label: "平均掉落装等", cls: "avg-equip", tip: "掉落装备的掉率加权平均等级" },
    { key: "_avgEquipMoney", label: "掉落装备平均价格", cls: "avg-money", tip: "掉落装备的加权平均售价（金币）" },
    { key: "maxMonsterCount", label: "单地图最大数量", tip: "该怪物在单个地图中的最大刷新数量" },
    { key: "locationCount", label: "出现地图数", tip: "该怪物出现的地图数量" },
    { key: "_weakness", label: "弱点", tip: "怪物属性弱点" },
  ];

  function val(m, col) {
    // 防具列按当前展示模式取物防/魔防字段
    const raw = col === "_defense" ? m[defenseMode] : m[col];
    if (raw == null || raw === "") return "";
    const n = parseFloat(raw);
    return isNaN(n) ? String(raw).toLowerCase() : n;
  }

  // 弱点条件为「= 元素」匹配，怪物名为「包含」匹配（不区分大小写），
  // 其余为数值比较（空值行不满足）
  function testFilter(m, f) {
    if (f.col === "_weakness") {
      return (m._weakElems || []).includes(f.value);
    }
    if (f.col === "mobname") {
      return String(m.mobname || "")
        .toLowerCase()
        .includes(String(f.value || "").toLowerCase());
    }
    const v = val(m, f.col);
    if (v === "" || typeof v !== "number") return false;
    switch (f.op) {
      case ">": return v > f.value;
      case ">=": return v >= f.value;
      case "<": return v < f.value;
      case "<=": return v <= f.value;
    }
  }

  // 多条条件之间支持 与(AND)/或(OR)，自上而下顺序求值：
  // 每条条件的 logic 表示它与上一条条件的关系，即 ((c1 AND c2) OR c3) ...
  function applyFilters(data) {
    if (!filters.length) return data;
    return data.filter((m) => {
      let matched = testFilter(m, filters[0]);
      for (let i = 1; i < filters.length; i++) {
        const cur = testFilter(m, filters[i]);
        matched = filters[i].logic === "OR" ? matched || cur : matched && cur;
      }
      return matched;
    });
  }

  function sortData(data) {
    const dir = sortState.asc ? 1 : -1;
    return [...data].sort((a, b) => {
      const va = val(a, sortState.col);
      const vb = val(b, sortState.col);
      if (va === "" && vb === "") return 0;
      if (va === "") return 1;
      if (vb === "") return -1;
      if (typeof va === "number" && typeof vb === "number") {
        return (va - vb) * dir;
      }
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  function renderTable(resetScroll) {
    // 重渲染前记录旧表格滚动位置：对比行选择、排序等交互保持滚动位置不变
    const oldWrap = document.querySelector("#result .table-wrap");
    const oldScroll = oldWrap ? { left: oldWrap.scrollLeft, top: oldWrap.scrollTop } : null;

    // 防具列列名/提示随物防、魔防切换模式更新
    const defCol = COLS.find((c) => c.key === "_defense");
    defCol.label = defenseMode === "pdd" ? "物防" : "魔防";
    defCol.tip = defenseMode === "pdd" ? "怪物物防" : "怪物魔防";

    const sorted = sortData(applyFilters(ranked));
    const mValue = document.getElementById("M") ? document.getElementById("M").value : "";

    // 对比模式：按 mobid 在当前数据集中还原选中的原目标 / 对比目标
    const cmpA = compareAMobid != null ? ranked.find((x) => String(x.mobid) === String(compareAMobid)) : null;
    const cmpB = compareBMobid != null ? ranked.find((x) => String(x.mobid) === String(compareBMobid)) : null;

    // ---- 筛选面板（列 + 操作符 + 值）----
    // 弱点列操作符固定 =，值为属性下拉；怪物名操作符固定 包含，值为文本；
    // 其余数值列操作符 > >= < <=，值为数字
    const FILTER_COLS = COLS;
    const NUM_OPS = [">", ">=", "<", "<="];
    const NAME_OPS = ["包含"];
    const WEAK_ELEMS = [
      { v: "雷", label: "雷属性" },
      { v: "火", label: "火属性" },
      { v: "圣", label: "圣属性" },
      { v: "冰", label: "冰属性" },
    ];
    const colOptions = FILTER_COLS.map((c) => `<option value="${c.key}">${c.label}</option>`).join("");
    const opOptionsNum = NUM_OPS.map((o) => `<option value="${o}">${o}</option>`).join("");
    const weakOptions = WEAK_ELEMS.map((o) => `<option value="${o.v}">${o.label}</option>`).join("");
    const LOGIC_OPS = [
      { v: "AND", label: "与" },
      { v: "OR", label: "或" },
    ];
    const logicOptions = LOGIC_OPS.map((o) => `<option value="${o.v}">${o.label}</option>`).join("");
    function logicSelectHtml(sel) {
      return LOGIC_OPS.map((o) => `<option value="${o.v}"${o.v === sel ? " selected" : ""}>${o.label}</option>`).join("");
    }
    function colSelectHtml(sel) {
      return FILTER_COLS.map((c) => `<option value="${c.key}"${c.key === sel ? " selected" : ""}>${c.label}</option>`).join("");
    }
    function opSelectHtml(sel, ops) {
      return ops.map((o) => `<option value="${o}"${o === sel ? " selected" : ""}>${o}</option>`).join("");
    }
    function weakSelectHtml(sel) {
      return WEAK_ELEMS.map((o) => `<option value="${o.v}"${o.v === sel ? " selected" : ""}>${o.label}</option>`).join("");
    }
    function filterRowHtml(f, i) {
      const isWeak = f && f.col === "_weakness";
      const isName = f && f.col === "mobname";
      const ops = isWeak ? ["="] : isName ? NAME_OPS : NUM_OPS;
      const opSel = isWeak ? "=" : isName ? "包含" : f ? f.op : ">";
      return `
        <div class="filter-row">
          ${i === 0
          ? `<span class="f-logic-start">与</span>`
          : `<select class="f-logic" title="与上方条件的关系">${logicSelectHtml((f && f.logic) || "AND")}</select>`}
          <select class="f-col">${colSelectHtml(f ? f.col : FILTER_COLS[0].key)}</select>
          <select class="f-op">${opSelectHtml(opSel, ops)}</select>
          <span class="f-val-slot">
            <input class="f-val" type="number" step="any" placeholder="数值" value="${f && !isWeak && !isName ? f.value : ""}"${isWeak || isName ? ' style="display:none"' : ""} />
            <input class="f-val-name" placeholder="怪物名" value="${isName && f ? esc(f.value) : ""}"${isName ? "" : ' style="display:none"'} />
            <select class="f-val-weak"${isWeak ? "" : ' style="display:none"'}>${weakSelectHtml(isWeak ? f.value : WEAK_ELEMS[0].v)}</select>
          </span>
          <button class="f-del" title="删除此条件">✕</button>
        </div>`;
    }
    const activeFilters = filters.length ? filters : [null];
    const filterRowsHtml = activeFilters.map((f, i) => filterRowHtml(f, i)).join("");

    // ---- 对比面板：列配置与格式化 ----
    const CMP_COLS = [
      { key: "level", label: "等级", dec: 0 },
      { key: "hp", label: "HP", dec: 0 },
      { key: "mp", label: "MP", dec: 0 },
      { key: "_defense", label: defenseMode === "pdd" ? "物防" : "魔防", dec: 0 },
      { key: "exp", label: "EXP", dec: 0 },
      { key: "_hpExp", label: "难度", dec: 1 },
      { key: "_ratio1", label: "性价比", dec: 1 },
      { key: "_eff1", label: "升级效率①", dec: 1 },
      { key: "_eff2", label: "升级效率②", dec: 1 },
      { key: "_eff3", label: "升级效率③", dec: 1 },
      { key: "_eff4", label: "升级效率④", dec: 1 },
      { key: "_eff6", label: "升级效率⑥", dec: 1 },
      { key: "_goldMp1", label: "回本效率①", dec: 1 },
      { key: "_goldMp2", label: "回本效率②", dec: 1 },
      { key: "_goldMp3", label: "回本效率③", dec: 1 },
      { key: "_goldMp4", label: "回本效率④", dec: 1 },
      { key: "_avgEquipLevel", label: "平均掉落装等", dec: 0, prefix: "Lv." },
      { key: "_avgEquipMoney", label: "掉落装备平均价格", money: true },
      { key: "maxMonsterCount", label: "单地图最大数量", dec: 0 },
      { key: "locationCount", label: "出现地图数", dec: 0 },
    ];

    function fmtCmpVal(col, m) {
      const v = val(m, col.key);
      if (v === "") return "--";
      if (col.money) return fmtMoney(v);
      if (col.prefix) return col.prefix + Number(v).toFixed(col.dec);
      return Number(v).toFixed(col.dec);
    }

    function fmtCmpDiff(col, a, b) {
      const va = val(a, col.key);
      const vb = val(b, col.key);
      if (va === "" || vb === "") return '<span class="cmp-diff">--</span>';
      const d = vb - va;
      // 百分比变化 = 差值 ÷ 原目标；原目标为 0 时无法计算，显示 —
      const pct = va !== 0 ? (d / va) * 100 : null;
      const pctStr = pct == null ? "—" : (pct > 0 ? "+" : "") + pct.toFixed(1) + "%";
      if (col.money) {
        if (d === 0) return '<span class="cmp-diff zero">—</span>';
        return `<span class="cmp-diff ${d > 0 ? "up" : "down"}">${d > 0 ? "↑" : "↓"} ${fmtMoney(Math.abs(d))}（${pctStr}）</span>`;
      }
      const r = Number(d.toFixed(col.dec));
      if (r === 0) return '<span class="cmp-diff zero">—</span>';
      return `<span class="cmp-diff ${r > 0 ? "up" : "down"}">${r > 0 ? "↑" : "↓"} ${Math.abs(r).toFixed(col.dec)}（${pctStr}）</span>`;
    }

    function cmpPanelHtml(a, b) {
      const items = CMP_COLS.map((col) => `
        <div class="cmp-item">
          <div class="cmp-label">${col.label}</div>
          <div class="cmp-vals"><span class="cmp-val-a">${fmtCmpVal(col, a)}</span><span class="cmp-vs">→</span><span class="cmp-val-b">${fmtCmpVal(col, b)}</span></div>
          ${fmtCmpDiff(col, a, b)}
        </div>`).join("");
      const weakA = esc((a._weakElems || []).join(" / ") || "--");
      const weakB = esc((b._weakElems || []).join(" / ") || "--");
      return `
      <div class="cmp-panel">
        <div class="cmp-panel-header">
          <span class="cmp-title">📊 怪物对比</span>
          <span class="cmp-mobs">
            <span class="cmp-mob-a">${esc(a.mobname)} (Lv.${a.level})</span>
            <span class="cmp-arrow">→</span>
            <span class="cmp-mob-b">${esc(b.mobname)} (Lv.${b.level})</span>
          </span>
          <button class="cmp-close" title="退出对比">✕</button>
        </div>
        <div class="cmp-grid">
          ${items}
          <div class="cmp-item">
            <div class="cmp-label">弱点</div>
            <div class="cmp-vals"><span class="cmp-val-a">${weakA}</span><span class="cmp-vs">→</span><span class="cmp-val-b">${weakB}</span></div>
          </div>
        </div>
      </div>`;
    }

    function cmpHintHtml(a) {
      return `
      <div class="cmp-hint">${
        a
          ? `已选原目标「${esc(a.mobname)}」，请点击第二行作为对比目标（点击「⚖️ 对比」按钮可退出）`
          : "对比模式：请点击第一行作为原目标（点击「⚖️ 对比」按钮可退出）"
      }</div>`;
    }

    // 结果为空时也保留表头，用户才能改参数/清筛选
    let bodyHtml;
    if (!sorted.length) {
      bodyHtml = `
        <div class="empty-state">
          <div class="empty-icon">🤷</div>
          <p>没有匹配的怪物数据</p>
          <span class="hint">${filters.length ? "筛选条件过严，试试放宽条件、或将「与」改为「或」" : ""}</span>
        </div>`;
    } else {
      const headerCells = COLS.map((c) => {
        const isSorted = sortState.col === c.key;
        const arrow = isSorted ? (sortState.asc ? "▲" : "▼") : "";
        return `<th class="${isSorted ? "sorted" : ""}" data-col="${c.key}" data-tippy-content="${c.tip || ""}">${c.label}${arrow ? `<span class="arrow">${arrow}</span>` : ""}</th>`;
      }).join("");

      const rows = sorted
        .map((m, i) => {
          const idx = ranked.indexOf(m) + 1;
          const isCmpA = !!cmpA && String(cmpA.mobid) === String(m.mobid);
          const isCmpB = !!cmpB && String(cmpB.mobid) === String(m.mobid);
          const rowCls = isCmpA ? ' class="cmp-a"' : isCmpB ? ' class="cmp-b"' : "";
          let rankHtml;
          if (idx === 1)
            rankHtml = `<span class="rank-badge rank-1">${idx}</span>`;
          else if (idx === 2)
            rankHtml = `<span class="rank-badge rank-2">${idx}</span>`;
          else if (idx === 3)
            rankHtml = `<span class="rank-badge rank-3">${idx}</span>`;
          else rankHtml = `<span class="rank-n">${idx}</span>`;

          const iconSrc = m.icon ? m.icon.replace(/^\//, "") : "";
          const iconHtml = iconSrc
            ? `<img src="${esc(iconSrc)}" alt="${esc(m.mobname)}" class="mob-icon" loading="lazy" />`
            : "";
          return `
    <tr${rowCls} data-mobid="${esc(String(m.mobid))}">
      <td>${m.level}</td>
      <td class="monster-name"><div class="mob-cell">${iconHtml}<span>${esc(m.mobname)}</span></div></td>
      <td>${Number(m.hp)}</td>
      <td>${Number(m.mp)}</td>
      <td>${Number(m[defenseMode])}</td>
      <td>${Number(m.exp)}</td>
      <td>${m._hpExp != null ? m._hpExp.toFixed(1) : "--"}</td>
      <td class="ratio">${m._ratio1 != null ? m._ratio1.toFixed(1) : "--"}</td>
      <td class="score">${m._eff1.toFixed(1)}</td>
      <td class="score">${m._eff2.toFixed(1)}</td>
      <td class="score">${m._eff3.toFixed(1)}</td>
      <td class="score">${m._eff4.toFixed(1)}</td>
      <td class="score">${m._eff6.toFixed(1)}</td>
      <td class="gold-mp">${m._goldMp1 != null ? m._goldMp1.toFixed(1) : "--"}</td>
      <td class="gold-mp">${m._goldMp2 != null ? m._goldMp2.toFixed(1) : "--"}</td>
      <td class="gold-mp">${m._goldMp3 != null ? m._goldMp3.toFixed(1) : "--"}</td>
      <td class="gold-mp">${m._goldMp4 != null ? m._goldMp4.toFixed(1) : "--"}</td>
      <td class="avg-equip">${m._avgEquipLevel != null ? "Lv." + m._avgEquipLevel.toFixed(0) : "--"}</td>
      <td class="avg-money">${m._avgEquipMoney != null ? fmtMoney(m._avgEquipMoney) : "--"}</td>
      <td>${m.maxMonsterCount ?? "--"}</td>
      <td>${m.locationCount ?? "--"}</td>
      <td>${m._weakness || "--"}</td>
    </tr>`;
        })
        .join("");

      bodyHtml = `
      <div class="table-wrap">
        <table${compareMode ? ' class="cmp-active"' : ""}>
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }

    document.getElementById("result").innerHTML = `
    <div class="table-card">
      <div class="table-card-header">
        <div class="title">
          🏆 排行
          <span class="badge">${filters.length ? `筛选×${filters.length}` : "全部"}</span>
          <span class="filter-wrap">
            <button class="filter-btn">🔍 筛选</button>
            <div class="filter-popup">
              <div class="filter-rows">${filterRowsHtml}</div>
              <div class="filter-actions">
                <button class="f-add">+ 添加条件</button>
                <span class="f-spacer"></span>
                <button class="f-clear">清空</button>
                <button class="f-apply">应用</button>
              </div>
            </div>
          </span>
        </div>
        <div class="header-right">
          ${headerControlsHtml(mValue)}
          ${filters.length ? `<span class="header-meta">已显示 ${sorted.length} / ${ranked.length} 条</span>` : ""}
        </div>
      </div>
      ${cmpA && cmpB ? cmpPanelHtml(cmpA, cmpB) : compareMode ? cmpHintHtml(cmpA) : ""}
      ${bodyHtml}
    </div>`;

    // 冻结列偏移：第二列 left = 第一列实际宽度（列宽随内容变化，需动态测量）
    const table = document.querySelector("#result table");
    if (table) {
      const firstTh = table.querySelector("thead th:first-child");
      table.style.setProperty("--col1-w", `${firstTh.offsetWidth}px`);
    }

    // 恢复重渲染前的滚动位置（calc 重算时 resetScroll=true，表格回到顶部）
    const newWrap = document.querySelector("#result .table-wrap");
    if (!resetScroll && oldScroll && newWrap) {
      newWrap.scrollLeft = oldScroll.left;
      newWrap.scrollTop = oldScroll.top;
    }

    // ---- 对比模式：点击行选择原目标 / 对比目标 ----
    if (compareMode && table) {
      table.querySelector("tbody").addEventListener("click", (e) => {
        const tr = e.target.closest("tr");
        if (!tr || !tr.dataset.mobid) return;
        const mobid = tr.dataset.mobid;
        if (compareAMobid != null && compareBMobid == null) {
          if (compareAMobid === mobid) return; // 点击已选原目标行忽略
          compareBMobid = mobid;
        } else {
          compareAMobid = mobid;
          compareBMobid = null;
        }
        renderTable();
      });
    }
    const cmpClose = document.querySelector(".cmp-close");
    if (cmpClose) {
      cmpClose.addEventListener("click", () => {
        compareMode = false;
        compareAMobid = null;
        compareBMobid = null;
        renderTable();
      });
    }

    // ---- 筛选面板事件 ----
    const filterBtn = document.querySelector(".filter-btn");
    const popup = document.querySelector(".filter-popup");
    filterBtn.addEventListener("click", () => popup.classList.toggle("open"));

    // 切换列时调整操作符与值控件：弱点列只允许 =，值用属性下拉
    function updateRowMode(row) {
      const col = row.querySelector(".f-col").value;
      const isWeak = col === "_weakness";
      const isName = col === "mobname";
      row.querySelector(".f-op").innerHTML = isWeak
        ? '<option value="=">=</option>'
        : isName
          ? '<option value="包含">包含</option>'
          : opOptionsNum;
      row.querySelector(".f-val").style.display = isWeak || isName ? "none" : "";
      row.querySelector(".f-val-name").style.display = isName ? "" : "none";
      row.querySelector(".f-val-weak").style.display = isWeak ? "" : "none";
    }
    // 首行「与/或」无意义（没有上一条条件），用静态“与”占位；其余行显示与/或下拉
    function syncRowLogics() {
      document.querySelectorAll(".filter-row").forEach((row, i) => {
        const sel = row.querySelector(".f-logic");
        if (i === 0 && sel) {
          const start = document.createElement("span");
          start.className = "f-logic-start";
          start.textContent = "与";
          sel.replaceWith(start);
        } else if (i > 0 && !sel) {
          const start = row.querySelector(".f-logic-start");
          const newSel = document.createElement("select");
          newSel.className = "f-logic";
          newSel.title = "与上方条件的关系";
          newSel.innerHTML = logicOptions;
          start.replaceWith(newSel);
        }
      });
    }
    function addFilterRow() {
      const wrap = document.querySelector(".filter-rows");
      const div = document.createElement("div");
      div.className = "filter-row";
      div.innerHTML = `
        <select class="f-logic" title="与上方条件的关系">${logicOptions}</select>
        <select class="f-col">${colOptions}</select>
        <select class="f-op">${opOptionsNum}</select>
        <span class="f-val-slot">
          <input class="f-val" type="number" step="any" placeholder="数值" />
          <input class="f-val-name" placeholder="怪物名" style="display:none" />
          <select class="f-val-weak" style="display:none">${weakOptions}</select>
        </span>
        <button class="f-del" title="删除此条件">✕</button>`;
      wrap.appendChild(div);
      div.querySelector(".f-del").addEventListener("click", () => {
        div.remove();
        if (!document.querySelector(".filter-row")) addFilterRow();
        else syncRowLogics();
      });
      div.querySelector(".f-col").addEventListener("change", () => updateRowMode(div));
      syncRowLogics();
    }
    document.querySelectorAll(".filter-row").forEach((row) => {
      row.querySelector(".f-col").addEventListener("change", () => updateRowMode(row));
    });
    document.querySelectorAll(".f-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        btn.closest(".filter-row").remove();
        if (!document.querySelector(".filter-row")) addFilterRow();
        else syncRowLogics();
      });
    });
    document.querySelector(".f-add").addEventListener("click", addFilterRow);
    document.querySelector(".f-apply").addEventListener("click", () => {
      const next = [];
      document.querySelectorAll(".filter-row").forEach((row) => {
        const col = row.querySelector(".f-col").value;
        let raw;
        if (col === "_weakness") {
          raw = row.querySelector(".f-val-weak").value;
        } else if (col === "mobname") {
          raw = row.querySelector(".f-val-name").value.trim();
          if (!raw) return; // 未填名称的行忽略
        } else {
          raw = parseFloat(row.querySelector(".f-val").value);
          if (isNaN(raw)) return; // 未填数值的行忽略
        }
        const logicSel = row.querySelector(".f-logic");
        next.push({
          col,
          op: row.querySelector(".f-op").value,
          value: raw,
          logic: logicSel ? logicSel.value : "AND",
        });
      });
      filters = next;
      popup.classList.remove("open");
      renderTable();
    });
    document.querySelector(".f-clear").addEventListener("click", () => {
      filters = [];
      renderTable();
    });

    document.querySelectorAll("th[data-col]").forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.dataset.col;
        if (sortState.col === col) {
          sortState.asc = !sortState.asc;
        } else {
          sortState.col = col;
          sortState.asc = ["mobname"].includes(col);
        }
        renderTable();
      });
    });

    // 激活 tippy tooltips
    initTippy(300);
  }

  currentRender = renderTable;
  renderTable(true); // 重新计算排行后表格回到顶部
}

function showError(msg) {
  const errEl = document.getElementById("error");
  errEl.textContent = "❌ " + msg;
  errEl.style.display = "block";
}

function fmtMoney(n) {
  if (n >= 10000) return (n / 10000).toFixed(2) + "w";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n).toLocaleString();
}

function esc(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}
