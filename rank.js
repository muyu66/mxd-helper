// ---- 待办清单数据 ----
const todos = [
  { text: "波动的技能如何输入伤害值", status: "pending" },
  { text: "属性克制", status: "done" },
  { text: "等级经验衰减", status: "pending" },
  { text: "怪物图片", status: "done" },
  { text: "优化计算逻辑", status: "pending" },
  { text: "开放所有怪物排行", status: "done" },
  { text: "掉落装备等级计算", status: "done" },
];

function renderChecklist() {
  const container = document.getElementById("checklist");
  container.innerHTML = todos
    .map((t) => {
      const isDone = t.status === "done";
      const icon = isDone ? "✓" : "○";
      const cls = isDone ? "done" : "";
      return `
      <div class="checklist-item ${cls}">
        <span class="check-icon ${cls}">${icon}</span>
        <span class="check-text">${esc(t.text)}</span>
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
        equipMap[e.mobid].push({ level: e.level, rate: e.rate });
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
    showError("X 必须是一个大于 0 的数字");
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

  // 属性克制: 无→A=1; 选中属性且怪物有对应弱点→A=1, 无弱点→A=0.5
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
      A = hasWeakness ? 1 : 0.5;
    }

    const divisor = Math.ceil(hp / (X * A));
    if (divisor <= 0) continue;
    const score = (exp / divisor) * C;

    // 掉落装备加权平均等级
    let _avgEquipLevel = null;
    const eqList = equipMap[m.mobid];
    if (eqList && eqList.length) {
      let totalWeight = 0, weightedSum = 0;
      for (const eq of eqList) {
        weightedSum += eq.level * eq.rate;
        totalWeight += eq.rate;
      }
      _avgEquipLevel = totalWeight > 0 ? weightedSum / totalWeight : null;
    }

    ranked.push({
      ...m,
      _score: score,
      _perMp: score / M,
      _divisor: divisor,
      _avgEquipLevel,
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
  const DEF_SORT = { col: "_score_percent", asc: false };
  let sortState = { col: DEF_SORT.col, asc: DEF_SORT.asc };

  const COLS = [
    { key: "level", label: "等级", tip: "怪物等级" },
    { key: "mobname", label: "怪物", cls: "monster-name", tip: "怪物名称" },
    { key: "hp", label: "HP", tip: "怪物血量" },
    { key: "mp", label: "MP", tip: "怪物蓝量" },
    { key: "exp", label: "EXP", tip: "怪物经验值" },
    { key: "_score", label: "经验值比", tip: "值越大效率越高，单位时间内的经验值比" },
    { key: "_score_percent", label: "效率", cls: "score", tip: "与第一名相比的效率百分比，比如第三只有第一的70%" },
    { key: "_perMp", label: "每点蓝量经验比", cls: "per-mp", tip: "效率 ÷ 技能耗蓝，衡量蓝量利用效率" },
    { key: "_avgEquipLevel", label: "掉落装等", cls: "avg-equip", tip: "掉落装备的掉率加权平均等级，越高说明该怪掉落的装备整体等级越高" },
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
      <td class="avg-equip">${m._avgEquipLevel != null ? "Lv." + m._avgEquipLevel.toFixed(0) : "--"}</td>
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

function esc(s) {
  const el = document.createElement("span");
  el.textContent = s;
  return el.innerHTML;
}
