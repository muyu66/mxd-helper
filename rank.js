// ---- 待办清单数据 ----
const todos = [
  { text: "波动的技能如何输入伤害值", status: "pending" },
  { text: "属性克制", status: "done", date: "2026-08-07" },
  { text: "怪物图片", status: "done", date: "2026-08-10" },
  { text: "开放所有怪物排行", status: "done", date: "2026-08-10" },
  { text: "掉落装备等级计算", status: "done", date: "2026-08-10" },
  { text: "怪物密集程度计算", status: "pending" },
  { text: "掉落装备平均价值", status: "done", date: "2026-08-10" },
  { text: "修复属性克制公式", status: "done", date: "2026-08-07" },
  { text: "计算时考虑MISS", status: "pending" },
];

function renderChecklist() {
  const container = document.getElementById("checklist");
  container.innerHTML = todos
    .map((t) => {
      const isDone = t.status === "done";
      const icon = isDone ? "✓" : "○";
      const cls = isDone ? "done" : "";
      const dateHtml = isDone && t.date
        ? `<span class="check-date">${esc(t.date)}</span>`
        : "";
      return `
      <div class="checklist-item ${cls}">
        <span class="check-icon ${cls}">${icon}</span>
        <span class="check-text">${esc(t.text)}</span>
        ${dateHtml}
      </div>`;
    })
    .join("");
}

renderChecklist();

// 全局 tippy（表单等静态元素）
tippy('[data-tippy-content]', {
  placement: 'top',
  arrow: true,
  animation: 'shift-away',
  delay: [200, 0],
  theme: 'light',
});

let monsterData = [];
let equipMap = {}; // mobid → [{level, rate}, ...]
let currentRanked = [];

(async function loadData() {
  const res = document.getElementById("result");
  res.innerHTML = `
    <div class="empty-state">
      <div class="loading-dots"><span></span><span></span><span></span></div>
      <p>加载怪物数据中...</p>
    </div>
  `;

  try {
    const [respData, respEquip] = await Promise.all([
      fetch("data.json"),
      fetch("equipment.json"),
    ]);
    if (!respData.ok) throw new Error(`data.json HTTP ${respData.status}`);

    const json = await respData.json();
    monsterData = (json.items || []).filter(
      (m) => (m.maxMonsterCount ?? 0) >= 10,
    );
    document.getElementById("stat-total").textContent = monsterData.length;

    // 构建装备查找表
    if (respEquip.ok) {
      const equipData = await respEquip.json();
      for (const e of equipData) {
        if (!equipMap[e.mobid]) equipMap[e.mobid] = [];
        equipMap[e.mobid].push({ level: e.level, rate: e.rate, money: e.money });
      }
    }

    res.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎯</div>
        <p>输入参数后点击「计算排行」查看结果</p>
        <span class="hint">全部怪物按经验效率排序</span>
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

  const X = parseFloat(document.getElementById("X").value) || 530;
  if (isNaN(X) || X <= 0) {
    showError("较低单次伤害必须是一个大于 0 的数字");
    return;
  }
  const C = parseFloat(document.getElementById("C").value) || 1;
  if (isNaN(C) || C <= 0) {
    showError("C 必须是一个大于 0 的数字");
    return;
  }
  const M = parseFloat(document.getElementById("M").value) || 20;
  if (isNaN(M) || M <= 0) {
    showError("M 必须是一个大于 0 的数字");
    return;
  }
  if (!monsterData.length) {
    showError("数据尚未加载完成，请稍候再试");
    return;
  }

  // 属性克制: 无→A=1; 选中属性且怪物有对应弱点→A=1, 无弱点→A=0.8
  const elem = document.getElementById("elem").value;
  const weaknessMap = {
    雷: "雷弱点",
    冰: "冰弱点",
    火: "火弱点",
    圣: "圣弱点",
  };
  const targetWeakness = weaknessMap[elem] || null;

  const ranked = [];
  for (const m of monsterData) {
    const hp = parseFloat(m.hp);
    const exp = parseFloat(m.exp);
    if (isNaN(hp) || hp <= 0 || isNaN(exp) || exp < 0) continue;

    let A = 1;
    if (targetWeakness) {
      const tags = m.elementTags || [];
      const hasWeakness = tags.some(
        (t) => (t.label || t) === targetWeakness,
      );
      A = hasWeakness ? 1 : 0.8;
    }

    const divisor = Math.ceil(hp / (X * A));
    if (divisor <= 0) continue;
    const score = (exp / divisor) * C;

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

    // 耗蓝装备价值 = 总期望金币 / 总耗蓝
    const _goldPerMp = _avgEquipMoney != null
      ? (_avgEquipMoney * C) / (divisor * M)
      : null;

    ranked.push({
      ...m,
      _score: score,
      _perMp: score / M,
      _divisor: divisor,
      _avgEquipLevel,
      _avgEquipMoney,
      _goldPerMp,
      _weakness: (m.elementTags || [])
        .map((t) => (t.label || t))
        .filter((l) => l.endsWith("弱点"))
        .map((l) => {
          const e = l.replace("弱点", "");
          return `<span class="weak-tag weak-${e}">${e}</span>`;
        })
        .join(""),
    });
  }

  // 计算效率百分比（相对于最高效率）
  const maxScore = Math.max(...ranked.map((r) => r._score));
  ranked.forEach((r) => {
    r._score_percent = r._score / maxScore;
  });

  // default sort by score desc
  const DEF_SORT = { col: "level", asc: true };
  let sortState = { col: DEF_SORT.col, asc: DEF_SORT.asc };

  const COLS = [
    { key: "level", label: "等级", tip: "怪物等级" },
    { key: "mobname", label: "怪物", cls: "monster-name", tip: "怪物名称" },
    { key: "hp", label: "HP", tip: "怪物血量" },
    { key: "mp", label: "MP", tip: "怪物蓝量" },
    { key: "exp", label: "EXP", tip: "怪物经验值" },
    { key: "_score", label: "平均经验收益", tip: "每次攻击获得的经验" },
    { key: "_score_percent", label: "效率", cls: "score", tip: "与最高效率相比的百分比" },
    { key: "_perMp", label: "每点蓝量经验比", cls: "per-mp", tip: "效率 ÷ 技能耗蓝，衡量蓝量利用效率" },
    { key: "_goldPerMp", label: "每点耗蓝收益比", cls: "gold-mp", tip: "每消耗1点蓝量期望获得的装备金币价值，不是直接收益，只是对比值" },
    { key: "_avgEquipLevel", label: "平均掉落装等", cls: "avg-equip", tip: "掉落装备的掉率加权平均等级" },
    { key: "_avgEquipMoney", label: "掉落装备平均价格", cls: "avg-money", tip: "掉落装备的加权平均售价（金币）" },
    { key: "maxMonsterCount", label: "单地图最大数量", tip: "该怪物在单个地图中的最大刷新数量" },
    { key: "locationCount", label: "出现地图数", tip: "该怪物出现的地图数量" },
    { key: "_weakness", label: "弱点", tip: "怪物属性弱点" },
  ];

  function val(m, col) {
    const raw = m[col];
    if (raw == null || raw === "") return "";
    const n = parseFloat(raw);
    return isNaN(n) ? String(raw).toLowerCase() : n;
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

  function renderTable() {
    const sorted = sortData(ranked);
    if (!sorted.length) {
      document.getElementById("result").innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🤷</div>
          <p>没有匹配的怪物数据</p>
        </div>
      `;
      return;
    }

    const headerCells = COLS.map((c) => {
      const isSorted = sortState.col === c.key;
      const arrow = isSorted ? (sortState.asc ? "▲" : "▼") : "";
      return `<th class="${isSorted ? "sorted" : ""}" data-col="${c.key}" data-tippy-content="${c.tip || ""}">${c.label}${arrow ? `<span class="arrow">${arrow}</span>` : ""}</th>`;
    }).join("");

    const rows = sorted
      .map((m, i) => {
        const idx = ranked.indexOf(m) + 1;
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
    <tr>
      <td>${m.level}</td>
      <td class="monster-name"><div class="mob-cell">${iconHtml}<span>${esc(m.mobname)}</span></div></td>
      <td>${Number(m.hp)}</td>
      <td>${Number(m.mp)}</td>
      <td>${Number(m.exp)}</td>
      <td>${m._score.toFixed(1)}</td>
      <td class="score">${(m._score_percent * 100).toFixed(0)}%</td>
      <td class="per-mp">${m._perMp.toFixed(2)}</td>
      <td class="gold-mp">${m._goldPerMp != null ? m._goldPerMp.toFixed(2) : "--"}</td>
      <td class="avg-equip">${m._avgEquipLevel != null ? "Lv." + m._avgEquipLevel.toFixed(0) : "--"}</td>
      <td class="avg-money">${m._avgEquipMoney != null ? fmtMoney(m._avgEquipMoney) : "--"}</td>
      <td>${m.maxMonsterCount ?? "--"}</td>
      <td>${m.locationCount ?? "--"}</td>
      <td>${m._weakness || "--"}</td>
    </tr>`;
      })
      .join("");

    document.getElementById("result").innerHTML = `
    <div class="table-card">
      <div class="table-card-header">
        <div class="title">
          🏆 排行
          <span class="badge">全部</span>
        </div>
        <span style="font-size:0.8rem;color:var(--text-secondary)">
          X=${X} &nbsp; C=${C} &nbsp; M=${M}
        </span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

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
    tippy('[data-tippy-content]', {
      placement: 'top',
      arrow: true,
      animation: 'shift-away',
      delay: [300, 0],
      theme: 'light',
    });
  }

  renderTable();
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
