/* ======================================================
   勇者公會成績系統 v8.0
   - 三個成績區塊：每日單字檢測 / 單字檢定區 / 單元檢測區
   - 新增 / 刪除學童（選單彈窗）
   - 新增 / 編輯（改名、換區塊）/ 刪除單元（選單彈窗）
   - 單元拖拉排序（同區塊內）
   - 及格分數集中於 PASS_SCORE
   - 批量輸入成績（各區塊）、姓名拖移排序、Enter 確定 / Esc 取消
   - 成績新增 / 修改 / 補考 / 通過後重考（保留所有歷史）
   - 主表顯示各單元最新一筆
   - 補考提示、未完成 / 補考數統計
   - 匯入 / 匯出 JSON
   - localStorage
   - 匯出備份提醒 Banner
   - Google Sheet 雙向同步
 ====================================================== */

/* ---------------- Google Sheet Web App URL ---------------- */
const SHEET_WEBAPP_URL =
  "https://script.google.com/macros/s/AKfycbzFUNRL7JWo9URZCwbhi_maK1dgeLz5U8E-6KEz7JTN1iYCDZkiHmUe1uWLO0oJ13ciXw/exec";

/* ---------------- 基本資料 ---------------- */

let units = [
  "前測","L1","L2","L1-3","L4",
  "基礎3","基礎4","基礎5",
  "成長一","L5","L4-6",
  "L7","L8","L9","L10"
];

// 及格分數：低於此分數顯示「補考」，主表 / 統計 / 書卷 / 精靈提示都連動
const PASS_SCORE = 80;

/* 三個成績區塊：每個單元只屬於一個區塊（單元名稱全域唯一）
   units 為三區塊合併後的完整清單，供統計 / 同步 / 匯出使用 */
const SECTIONS = [
  { key: "daily", label: "每日單字檢測", icon: "📅" },
  { key: "vocab", label: "單字檢定區",   icon: "🏅" },
  { key: "unit",  label: "單元檢測區",   icon: "📘" }
];
let sectionUnits = null;

function rebuildUnits() {
  units = SECTIONS.flatMap(s => sectionUnits[s.key]);
}

// 沒有區塊設定的單元（舊資料 / Google Sheet 讀回）預設放哪個區塊
function defaultSectionOf(unit) {
  return /^(基礎|成長)/.test(unit) ? "vocab" : "unit";
}

// 補齊區塊結構；沒有被分配的單元依 defaultSectionOf 分配
function ensureSections() {
  if (!sectionUnits || typeof sectionUnits !== "object") sectionUnits = {};
  SECTIONS.forEach(s => {
    if (!Array.isArray(sectionUnits[s.key])) sectionUnits[s.key] = [];
  });
  const assigned = new Set(SECTIONS.flatMap(s => sectionUnits[s.key]));
  units.forEach(u => {
    if (!assigned.has(u)) sectionUnits[defaultSectionOf(u)].push(u);
  });
  rebuildUnits();
}

// 把單元移到指定區塊（放在該區塊最後）；單元不存在時等同新增
function moveUnitToSection(unit, sectionKey) {
  SECTIONS.forEach(s => {
    sectionUnits[s.key] = sectionUnits[s.key].filter(u => u !== unit);
  });
  sectionUnits[sectionKey].push(unit);
  rebuildUnits();
}

function isUnitEmpty(unit) {
  return Object.values(Students).every(stu => !(stu.scores?.[unit]?.length));
}

// 一次性：名稱以「基礎」「成長」開頭的單元移到「單字檢定區」（保持原順序）
function migrateVocabUnits() {
  try {
    if (localStorage.getItem("V7Migrate_vocab2")) return;
  } catch (_) {}

  // 清掉舊版遷移誤建的空白「基礎1」「基礎2」（實際單元名稱帶範圍，如「基礎2(76-150)」）
  ["基礎1", "基礎2"].forEach(u => {
    const hasRealOne = units.some(x => x !== u && x.startsWith(u + "("));
    if (units.includes(u) && hasRealOne && isUnitEmpty(u)) {
      SECTIONS.forEach(s => {
        sectionUnits[s.key] = sectionUnits[s.key].filter(x => x !== u);
      });
      Object.values(Students).forEach(stu => { if (stu.scores) delete stu.scores[u]; });
    }
  });
  rebuildUnits();

  units
    .filter(u => defaultSectionOf(u) === "vocab" && findSectionOfUnit(u) !== "vocab")
    .forEach(u => moveUnitToSection(u, "vocab"));

  normalizeAllStudents();
  saveData();

  try { localStorage.setItem("V7Migrate_vocab2", "1"); } catch (_) {}
}

function findSectionOfUnit(unit) {
  return SECTIONS.find(s => sectionUnits[s.key].includes(unit))?.key || null;
}

function sectionLabel(key) {
  return SECTIONS.find(s => s.key === key)?.label || "";
}

// 下拉選單：依區塊列出所有單元（編輯 / 刪除單元共用）
function fillUnitOptions(select) {
  select.innerHTML = SECTIONS
    .flatMap(s => sectionUnits[s.key].map(u => `<option value="${u}">【${s.label}】${u}</option>`))
    .join("");
}

// 下拉選單：三個區塊（新增 / 編輯單元共用）
function fillSectionOptions(select) {
  select.innerHTML = SECTIONS
    .map(s => `<option value="${s.key}">${s.icon} ${s.label}</option>`)
    .join("");
}

let Students = window.Students || {};

// 學生顯示順序（姓名拖移排序，三個區塊共用）
let studentOrder = [];

function ensureStudentOrder() {
  if (!Array.isArray(studentOrder)) studentOrder = [];
  studentOrder = studentOrder.filter(id => Students[id]);
  Object.keys(Students).forEach(id => {
    if (!studentOrder.includes(id)) studentOrder.push(id);
  });
}

function getDataSnapshot() {
  return { units, sectionUnits, studentOrder, Students };
}

function todayMD() {
  const d = new Date();
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
let sortMode = "default";

let currentScrollID = null;
let editingID = null;
let editingUnit = null;
let editingIndex = null;

let draggingUnit = null;
let chartInstance = null;

/* ---------------- 匯出備份提醒 Banner ---------------- */

let isDirtyForExport = false;
let isInitializing = true;

function ensureBackupBanner() {
  if (document.getElementById("backupBanner")) return;

  const banner = document.createElement("div");
  banner.id = "backupBanner";
  banner.style.display = "none";
  banner.innerHTML = `
    <div class="banner-row">
      <span>🧁 小精靈提醒：資料已更新，記得備份喔！</span>
      <span class="small">可以匯出 JSON 或同步到 Google Sheet</span>
      <span class="banner-actions">
        <button class="primary" onclick="exportData()">📤 立刻匯出</button>
        <button class="ghost" onclick="hideBackupBanner()">我知道了</button>
      </span>
    </div>
  `;

  const actionBar = document.getElementById("actionBar");
  const host = actionBar?.parentNode || document.getElementById("guild-bg") || document.body;
  host.insertBefore(banner, actionBar || host.firstChild);
}

function showBackupBanner() {
  ensureBackupBanner();
  const banner = document.getElementById("backupBanner");
  if (banner) banner.style.display = "block";
}

function hideBackupBanner() {
  const banner = document.getElementById("backupBanner");
  if (banner) banner.style.display = "none";
}

function markDirtyForExport() {
  if (isInitializing) return;
  isDirtyForExport = true;
  showBackupBanner();
}

function clearDirtyForExport() {
  isDirtyForExport = false;
  hideBackupBanner();
}

window.addEventListener("beforeunload", (e) => {
  if (!isDirtyForExport) return;
  e.preventDefault();
  e.returnValue = "";
});

/* ======================================================
   Google Sheet 同步
   ====================================================== */

// 網站 → Google Sheet
async function syncToSheet() {
  if (!SHEET_WEBAPP_URL) {
    alert("請先在 main.js 設定 SHEET_WEBAPP_URL。");
    return;
  }

  try {
    const payload = getDataSnapshot();

    await fetch(SHEET_WEBAPP_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    alert("✅ 已送出同步請求，請到 Google Sheet 確認。");
    clearDirtyForExport();
  } catch (err) {
    console.error(err);
    alert("❌ 同步失敗（請檢查 Web App 權限/網址）。");
  }
}

// Google Sheet → 網站
async function syncFromSheet() {
  if (!SHEET_WEBAPP_URL) {
    alert("請先在 main.js 設定 SHEET_WEBAPP_URL。");
    return;
  }

  try {
    const url = SHEET_WEBAPP_URL + "?t=" + Date.now();
    const res = await fetch(url);
    const json = await res.json();

    if (!json.units || !json.Students) {
      alert("❌ 讀取失敗：Google Sheet 端暫無可用資料。");
      return;
    }

    units = json.units;
    sectionUnits = json.sectionUnits || null;
    studentOrder = json.studentOrder || [];
    Students = json.Students;

    normalizeAllStudents();

    const prevInit = isInitializing;
    isInitializing = true;
    try {
      localStorage.setItem("V7Students", JSON.stringify(getDataSnapshot()));
    } catch (_) {}
    isInitializing = prevInit;

    renderTable();

    const popup = document.getElementById("scrollPopup");
    if (popup && !popup.classList.contains("hidden") && currentScrollID) {
      openScroll(currentScrollID);
    }

    alert("✅ 已從 Google Sheet 更新網站資料。");
  } catch (err) {
    console.error(err);
    alert("❌ 讀取失敗（請檢查 Web App 權限/網址）。");
  }
}

/* ======================================================
   排序與統計
   ====================================================== */

function setSortMode() {
  const el = document.getElementById("sortSelect");
  sortMode = el ? el.value : "default";
  renderTable();
}

function calcStudentStats(stu, unitList = units) {
  let scores = [];
  let incomplete = 0;
  let retake = 0;

  unitList.forEach(unit => {
    const arr = stu?.scores?.[unit];
    if (!arr || arr.length === 0) {
      incomplete++;
      return;
    }
    const latest = arr[arr.length - 1];
    const v = Number(latest.value);
    if (!Number.isNaN(v)) {
      scores.push(v);
      if (v < PASS_SCORE) retake++;
    }
  });

  const avg = scores.length ? scores.reduce((a,b)=>a+b,0) / scores.length : 0;
  return { avg, incomplete, retake };
}

function getSortedStudentIds() {
  ensureStudentOrder();
  const ids = [...studentOrder];
  const statsMap = {};
  ids.forEach(id => statsMap[id] = calcStudentStats(Students[id]));

  ids.sort((a,b) => {
    const sa = statsMap[a];
    const sb = statsMap[b];

    switch (sortMode) {
      case "avgHigh": return sb.avg - sa.avg;
      case "avgLow":  return sa.avg - sb.avg;
      case "incomplete": return sa.incomplete - sb.incomplete;
      case "name":
        return (Students[a].name || "").localeCompare(
          (Students[b].name || ""), "zh-Hant"
        );
      default:
        return 0;
    }
  });

  return { ids, statsMap };
}

/* ======================================================
   主表格渲染
   ====================================================== */

function renderTable() {
  const keyword = (document.getElementById("searchBox")?.value || "").trim();
  const { ids } = getSortedStudentIds();

  const host = document.getElementById("sectionsHost");
  if (!host) return;

  host.innerHTML = SECTIONS.map(sec => `
    <section class="score-section">
      <div class="section-head">
        <h2>${sec.icon} ${sec.label}</h2>
        <button onclick="openAddUnit('${sec.key}')">＋ 新增單元</button>
        <button onclick="openBatchInput('${sec.key}')">📝 批量輸入</button>
      </div>
      <div class="tableWrapper">
        <table class="scoreTable">${buildSectionTable(sec.key, ids, keyword)}</table>
      </div>
    </section>
  `).join("");

  enableUnitDrag();
  enableStudentDrag();
}

function buildSectionTable(sectionKey, ids, keyword) {
  const secUnits = sectionUnits[sectionKey];

  let html = `
    <tr>
      <th class="leftFreeze" style="left:0;">年級</th>
      <th class="leftFreeze" style="left:70px;">姓名</th>
  `;

  secUnits.forEach(u => {
    html += `<th class="unitHeader" draggable="true" data-unit="${u}" data-section="${sectionKey}"
      title="雙擊可編輯單元" ondblclick="openEditUnitMenu(this.dataset.unit)">${u}</th>`;
  });

  if (secUnits.length === 0) {
    html += `<th class="missing">尚無單元，按「＋ 新增單元」開始</th>`;
  }

  html += `<th>未完成</th><th>補考數</th></tr>`;

  ids.forEach(id => {
    const stu = Students[id];
    if (!stu?.name) return;
    if (keyword && !stu.name.includes(keyword)) return;

    const { incomplete, retake } = calcStudentStats(stu, secUnits);

    html += `
      <tr data-id="${id}">
        <td class="leftFreeze" style="left:0;">${stu.grade ?? ""}</td>
        <td class="leftFreeze nameCell" style="left:70px;" draggable="true" data-id="${id}"
          title="點擊查看成績｜拖移調整順序" onclick="openScroll('${id}')">${stu.name}</td>
    `;

    if (secUnits.length === 0) html += `<td></td>`;

    secUnits.forEach(unit => {
      const arr = stu.scores?.[unit];

      if (arr && arr.length > 0) {
        const latest = arr[arr.length - 1];
        const score = Number(latest.value);
        const date = latest.date ?? "";

        if (!Number.isNaN(score) && score < PASS_SCORE) {
          html += `
            <td class="low-score">
              ${date}（${score}）
              <span class="danger-icon">🔻補考</span>
              <span class="edit-btn" onclick="openRetakeInput('${id}','${unit}')">✒️</span>
            </td>`;
        } else {
          html += `
            <td>
              ${date}（${score}）
              <span class="edit-btn" title="修改最新成績" onclick="openEditScore('${id}','${unit}',${arr.length - 1})">✒️</span>
              <span class="edit-btn" title="重考（新增一筆）" onclick="openRetakeInput('${id}','${unit}')">🔁</span>
            </td>`;
        }
      } else {
        html += `
          <td class="missing">
            <span class="check-no">✘</span>
            <span class="add-btn" onclick="openInput('${id}','${unit}')">➕</span>
          </td>`;
      }
    });

    if (secUnits.length === 0) {
      html += `<td>—</td><td>—</td>`;
    } else {
      html += `<td>${incomplete === 0 ? "✔" : "✘"}</td>`;
      html += `<td>${retake}</td>`;
    }
    html += `</tr>`;
  });

  return html;
}

/* ======================================================
   單元拖拉排序
   ====================================================== */

function enableUnitDrag() {
  const headers = document.querySelectorAll(".scoreTable th.unitHeader");
  headers.forEach(th => {
    th.ondragstart = onUnitDragStart;
    th.ondragover = onUnitDragOver;
    th.ondrop = onUnitDrop;
    th.ondragend = onUnitDragEnd;
  });
}

function onUnitDragStart(e) {
  draggingUnit = e.currentTarget.getAttribute("data-unit");
  e.dataTransfer.effectAllowed = "move";
  try { e.dataTransfer.setData("text/plain", draggingUnit); } catch (_) {}
  e.currentTarget.classList.add("unit-dragging");
}

function onUnitDragOver(e) {
  if (!draggingUnit) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  e.currentTarget.classList.add("unit-drag-over");
}

function onUnitDrop(e) {
  e.preventDefault();
  const targetUnit = e.currentTarget.getAttribute("data-unit");
  const fromUnit = draggingUnit;
  clearUnitDragStyles();

  if (!fromUnit || !targetUnit || fromUnit === targetUnit) return;

  // 只能在同一個區塊內排序
  const secKey = findSectionOfUnit(fromUnit);
  if (!secKey || secKey !== findSectionOfUnit(targetUnit)) return;

  const list = sectionUnits[secKey];
  const fromIndex = list.indexOf(fromUnit);
  const toIndex = list.indexOf(targetUnit);
  if (fromIndex < 0 || toIndex < 0) return;

  list.splice(fromIndex, 1);
  list.splice(toIndex, 0, fromUnit);
  rebuildUnits();

  saveData();
  renderTable();

  const popup = document.getElementById("scrollPopup");
  if (popup && !popup.classList.contains("hidden") && currentScrollID) {
    openScroll(currentScrollID);
  }
}

function onUnitDragEnd() {
  clearUnitDragStyles();
  draggingUnit = null;
}

function clearUnitDragStyles() {
  document.querySelectorAll(".scoreTable th.unitHeader").forEach(th => {
    th.classList.remove("unit-drag-over", "unit-dragging");
  });
}

/* ======================================================
   學生（姓名）拖拉排序：三個區塊共用同一個順序
   ====================================================== */

let draggingStudent = null;

function enableStudentDrag() {
  document.querySelectorAll(".scoreTable td.nameCell").forEach(td => {
    td.ondragstart = onStudentDragStart;
    td.ondragend = onStudentDragEnd;
  });
  document.querySelectorAll(".scoreTable tr[data-id]").forEach(tr => {
    tr.ondragover = onStudentDragOver;
    tr.ondragleave = () => tr.classList.remove("row-drag-over");
    tr.ondrop = onStudentDrop;
  });
}

function onStudentDragStart(e) {
  draggingStudent = e.currentTarget.dataset.id;
  e.dataTransfer.effectAllowed = "move";
  try { e.dataTransfer.setData("text/plain", draggingStudent); } catch (_) {}
  e.currentTarget.parentNode.classList.add("row-dragging");
}

function onStudentDragOver(e) {
  if (!draggingStudent) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  e.currentTarget.classList.add("row-drag-over");
}

function onStudentDrop(e) {
  if (!draggingStudent) return;
  e.preventDefault();
  const fromId = draggingStudent;
  const toId = e.currentTarget.dataset.id;
  clearStudentDragStyles();
  if (!toId || fromId === toId) return;

  ensureStudentOrder();
  const fromIndex = studentOrder.indexOf(fromId);
  const toIndex = studentOrder.indexOf(toId);
  if (fromIndex < 0 || toIndex < 0) return;

  studentOrder.splice(fromIndex, 1);
  studentOrder.splice(toIndex, 0, fromId);

  // 拖移的是「原始」順序；若正在用其他排序，切回原始才看得到結果
  if (sortMode !== "default") {
    sortMode = "default";
    const el = document.getElementById("sortSelect");
    if (el) el.value = "default";
  }

  saveData();
  renderTable();
}

function onStudentDragEnd() {
  clearStudentDragStyles();
  draggingStudent = null;
}

function clearStudentDragStyles() {
  document.querySelectorAll(".scoreTable tr.row-drag-over, .scoreTable tr.row-dragging").forEach(tr => {
    tr.classList.remove("row-drag-over", "row-dragging");
  });
}

/* ======================================================
   成績：新增 / 修改 / 補考新增
   ====================================================== */

// 彈窗打開後把游標放到指定欄位（並全選，方便直接覆寫）
function focusField(id) {
  setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.focus();
    if (typeof el.select === "function") el.select();
  }, 0);
}

function openInput(id, unit) {
  editingID = id;
  editingUnit = unit;
  editingIndex = null;

  const stu = Students[id];
  document.getElementById("inputTitle").innerText =
    `新增成績｜${stu ? stu.name : ""}｜${unit}`;

  document.getElementById("inputDate").value = todayMD();
  document.getElementById("inputScore").value = "";
  document.getElementById("inputBox").classList.remove("hidden");
  focusField("inputScore");
}

function openEditScore(id, unit, index) {
  editingID = id;
  editingUnit = unit;
  editingIndex = index;

  const old = Students[id]?.scores?.[unit]?.[index];
  if (!old) return alert("找不到要修改的成績資料。");

  document.getElementById("inputTitle").innerText =
    `修改成績｜${Students[id].name}｜${unit}`;

  document.getElementById("inputDate").value = old.date ?? "";
  document.getElementById("inputScore").value = old.value ?? "";
  document.getElementById("inputBox").classList.remove("hidden");
  focusField("inputScore");
}

function openRetakeInput(id, unit) {
  editingID = id;
  editingUnit = unit;
  editingIndex = null;

  const stu = Students[id];
  const arr = stu?.scores?.[unit] || [];
  const latest = arr[arr.length - 1];
  const passed = latest && Number(latest.value) >= PASS_SCORE;
  document.getElementById("inputTitle").innerText =
    `${passed ? "重考新增" : "補考新增"}｜${stu ? stu.name : ""}｜${unit}`;

  document.getElementById("inputDate").value = todayMD();
  document.getElementById("inputScore").value = "";
  document.getElementById("inputBox").classList.remove("hidden");
  focusField("inputScore");
}

function closeInput() {
  document.getElementById("inputBox").classList.add("hidden");
  editingIndex = null;
}

function saveInput() {
  const date = document.getElementById("inputDate").value.trim();
  const scoreRaw = document.getElementById("inputScore").value.trim();
  const score = Number(scoreRaw);

  if (!date || scoreRaw === "") return alert("請輸入日期與分數。");
  if (Number.isNaN(score)) return alert("分數格式不正確。");

  const stu = Students[editingID];
  if (!stu) return alert("找不到該學童資料。");

  if (!stu.scores) stu.scores = {};
  if (!stu.scores[editingUnit]) stu.scores[editingUnit] = [];

  const arr = stu.scores[editingUnit];

  if (editingIndex !== null) {
    arr[editingIndex] = { date, value: score };
  } else {
    arr.push({ date, value: score });
  }

  saveData();
  closeInput();
  renderTable();

  const popup = document.getElementById("scrollPopup");
  if (popup && !popup.classList.contains("hidden") && currentScrollID) {
    openScroll(currentScrollID);
  }
}

/* ======================================================
   批量輸入成績（一次輸入全班同一單元）
   ====================================================== */

const BATCH_NEW_UNIT = "__new__";
let batchSection = null;

function openBatchInput(sectionKey) {
  batchSection = sectionKey;
  const list = sectionUnits[sectionKey];

  document.getElementById("batchTitle").innerText = `📝 批量輸入｜${sectionLabel(sectionKey)}`;

  const select = document.getElementById("batchUnit");
  select.innerHTML =
    list.map(u => `<option value="${u}">${u}</option>`).join("") +
    `<option value="${BATCH_NEW_UNIT}">＋ 新增單元…</option>`;
  select.value = list.length ? list[list.length - 1] : BATCH_NEW_UNIT;

  document.getElementById("batchNewUnit").value = "";
  document.getElementById("batchDate").value = todayMD();
  document.getElementById("batchList").innerHTML = "";

  renderBatchList();
  document.getElementById("batchBox").classList.remove("hidden");

  if (select.value === BATCH_NEW_UNIT) focusField("batchNewUnit");
  else focusBatchRow(0);
}

function closeBatch() {
  document.getElementById("batchBox").classList.add("hidden");
  batchSection = null;
}

function getBatchInputs() {
  return [...document.querySelectorAll("#batchList input.batch-score")];
}

// 換單元時保留已輸入的分數
function renderBatchList() {
  const unit = document.getElementById("batchUnit").value;
  const isNew = unit === BATCH_NEW_UNIT;
  document.getElementById("batchNewUnit").classList.toggle("hidden", !isNew);

  const typed = {};
  getBatchInputs().forEach(inp => { typed[inp.dataset.id] = inp.value; });

  const { ids } = getSortedStudentIds();
  let html = `<tr><th>年級</th><th>姓名</th><th>目前最新</th><th>本次分數</th></tr>`;

  ids.forEach(id => {
    const stu = Students[id];
    if (!stu?.name) return;
    const arr = isNew ? null : stu.scores?.[unit];
    const latest = arr?.length ? arr[arr.length - 1] : null;
    const low = latest && Number(latest.value) < PASS_SCORE;

    html += `
      <tr>
        <td>${stu.grade ?? ""}</td>
        <td>${stu.name}</td>
        <td class="${low ? "low-score" : "missing"}">${latest ? `${latest.date ?? ""}（${latest.value}）` : "—"}</td>
        <td><input class="batch-score" type="number" data-id="${id}" value="${typed[id] ?? ""}"></td>
      </tr>`;
  });

  document.getElementById("batchList").innerHTML = html;

  getBatchInputs().forEach(inp => {
    inp.onfocus = () => {
      inp.select();
      inp.closest("tr").classList.add("batch-active");
    };
    inp.onblur = () => inp.closest("tr").classList.remove("batch-active");
  });
}

function focusBatchRow(index) {
  setTimeout(() => {
    const inp = getBatchInputs()[index];
    if (inp) {
      inp.focus();
      inp.scrollIntoView({ block: "nearest" });
    }
  }, 0);
}

// Enter / ↓ 下一位、↑ 上一位；最後一位按 Enter 儲存
function onBatchKey(e) {
  const inputs = getBatchInputs();
  const i = inputs.indexOf(e.target);

  if (e.key === "Enter") {
    e.preventDefault();
    if (i === -1) return focusBatchRow(0);   // 從單元 / 日期欄按 Enter → 到第一位
    if (i < inputs.length - 1) return focusBatchRow(i + 1);
    return saveBatch();
  }
  if (i === -1) return;
  if (e.key === "ArrowDown" && i < inputs.length - 1) { e.preventDefault(); focusBatchRow(i + 1); }
  if (e.key === "ArrowUp" && i > 0) { e.preventDefault(); focusBatchRow(i - 1); }
}

function saveBatch() {
  const date = document.getElementById("batchDate").value.trim();
  if (!date) {
    alert("請輸入日期。");
    return focusField("batchDate");
  }

  let unit = document.getElementById("batchUnit").value;
  const isNew = unit === BATCH_NEW_UNIT;
  if (isNew) {
    unit = document.getElementById("batchNewUnit").value.trim();
    if (!unit) {
      alert("請輸入新單元名稱。");
      return focusField("batchNewUnit");
    }
    if (units.includes(unit)) {
      return alert(`此單元已存在於「${sectionLabel(findSectionOfUnit(unit))}」，請直接從清單選擇。`);
    }
  }

  const entries = [];
  for (const inp of getBatchInputs()) {
    const raw = inp.value.trim();
    if (raw === "") continue;
    const score = Number(raw);
    if (Number.isNaN(score)) {
      alert(`「${Students[inp.dataset.id]?.name}」的分數格式不正確。`);
      inp.focus();
      return;
    }
    entries.push({ id: inp.dataset.id, score });
  }
  if (entries.length === 0) return alert("還沒有輸入任何分數。");

  if (isNew) {
    sectionUnits[batchSection].push(unit);
    rebuildUnits();
    normalizeAllStudents();
  }

  entries.forEach(({ id, score }) => {
    const stu = Students[id];
    if (!stu.scores) stu.scores = {};
    if (!stu.scores[unit]) stu.scores[unit] = [];
    stu.scores[unit].push({ date, value: score });
  });

  saveData();
  closeBatch();
  renderTable();

  const popup = document.getElementById("scrollPopup");
  if (popup && !popup.classList.contains("hidden") && currentScrollID) {
    openScroll(currentScrollID);
  }

  alert(`✅ 已儲存 ${entries.length} 筆成績到「${unit}」。`);
}

/* ======================================================
   單元：新增 + 刪除（選單彈窗）
   ====================================================== */

function openAddUnit(sectionKey = "unit") {
  const select = document.getElementById("unitSection");
  if (select) {
    fillSectionOptions(select);
    select.value = sectionKey;
  }
  document.getElementById("unitName").value = "";
  document.getElementById("unitBox").classList.remove("hidden");
  focusField("unitName");
}

function closeUnit() {
  document.getElementById("unitBox").classList.add("hidden");
}

function saveUnit() {
  const u = document.getElementById("unitName").value.trim();
  if (!u) return alert("請輸入單元名稱。");
  if (units.includes(u)) {
    return alert(`此單元已存在於「${sectionLabel(findSectionOfUnit(u))}」。`);
  }

  const secKey = document.getElementById("unitSection")?.value || "unit";
  sectionUnits[secKey].push(u);
  rebuildUnits();
  Object.values(Students).forEach(stu => {
    if (!stu.scores) stu.scores = {};
    stu.scores[u] = [];
  });

  saveData();
  closeUnit();
  renderTable();
  if (currentScrollID) openScroll(currentScrollID);
}

/* ---- 刪除單元：選單彈窗 ---- */

function openDeleteUnitMenu() {
  ensureDeleteUnitBox();

  const box = document.getElementById("deleteUnitBox");
  const select = document.getElementById("deleteUnitSelect");

  if (units.length === 0) {
    alert("目前沒有可刪除的單元。");
    return;
  }

  fillUnitOptions(select);

  box.classList.remove("hidden");
}

function closeDeleteUnitBox() {
  const box = document.getElementById("deleteUnitBox");
  if (box) box.classList.add("hidden");
}

function confirmDeleteUnit() {
  const select = document.getElementById("deleteUnitSelect");
  const unit = select?.value;
  if (!unit) return;

  if (!confirm(`確定刪除單元「${unit}」？\n此操作會移除全部學生在該單元的成績紀錄。`)) return;

  SECTIONS.forEach(s => {
    sectionUnits[s.key] = sectionUnits[s.key].filter(u => u !== unit);
  });
  rebuildUnits();
  Object.values(Students).forEach(stu => {
    if (stu.scores) delete stu.scores[unit];
  });

  saveData();
  renderTable();
  if (currentScrollID) openScroll(currentScrollID);
  closeDeleteUnitBox();
}

/* ---- 編輯單元（改名 / 換區塊）：選單彈窗 ---- */

function openEditUnitMenu(unit) {
  ensureEditUnitBox();

  if (units.length === 0) {
    alert("目前沒有可編輯的單元。");
    return;
  }

  const unitSelect = document.getElementById("editUnitSelect");
  fillUnitOptions(unitSelect);
  fillSectionOptions(document.getElementById("editUnitSection"));

  if (unit && units.includes(unit)) unitSelect.value = unit;
  unitSelect.onchange = fillEditUnitFields;
  fillEditUnitFields();

  document.getElementById("editUnitBox").classList.remove("hidden");
  focusField("editUnitName");
}

function fillEditUnitFields() {
  const unit = document.getElementById("editUnitSelect").value;
  document.getElementById("editUnitName").value = unit;
  document.getElementById("editUnitSection").value = findSectionOfUnit(unit) || "unit";
}

function closeEditUnitBox() {
  const box = document.getElementById("editUnitBox");
  if (box) box.classList.add("hidden");
}

function confirmEditUnit() {
  const oldName = document.getElementById("editUnitSelect")?.value;
  const newName = document.getElementById("editUnitName")?.value.trim();
  const target = document.getElementById("editUnitSection")?.value;
  if (!oldName || !target) return;

  if (!newName) return alert("請輸入單元名稱。");
  if (newName !== oldName && units.includes(newName)) {
    return alert(`「${newName}」已存在於「${sectionLabel(findSectionOfUnit(newName))}」。`);
  }

  // 改名：原地替換，保持在區塊內的位置；成績跟著搬
  if (newName !== oldName) {
    SECTIONS.forEach(s => {
      sectionUnits[s.key] = sectionUnits[s.key].map(u => u === oldName ? newName : u);
    });
    Object.values(Students).forEach(stu => {
      if (!stu.scores) return;
      stu.scores[newName] = stu.scores[oldName] || [];
      delete stu.scores[oldName];
    });
    rebuildUnits();
  }

  // 換區塊：放到新區塊最後
  if (findSectionOfUnit(newName) !== target) moveUnitToSection(newName, target);

  saveData();
  renderTable();
  if (currentScrollID) openScroll(currentScrollID);
  closeEditUnitBox();
}

/* ======================================================
   學童：新增 + 刪除（選單彈窗）
   ====================================================== */

function openAddStudent() {
  document.getElementById("studentName").value = "";
  document.getElementById("studentGrade").value = "";
  document.getElementById("studentBox").classList.remove("hidden");
  focusField("studentGrade");
}

function closeStudent() {
  document.getElementById("studentBox").classList.add("hidden");
}

function generateStudentId() {
  return "S" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function saveStudent() {
  const name = document.getElementById("studentName").value.trim();
  const grade = document.getElementById("studentGrade").value.trim();

  if (!name) return alert("請輸入姓名。");
  if (!grade) return alert("請輸入年級 / 班級。");

  let id = generateStudentId();
  while (Students[id]) id = generateStudentId();

  const scores = {};
  units.forEach(u => scores[u] = []);

  Students[id] = { name, grade, scores };

  saveData();
  closeStudent();
  renderTable();
}

/* ---- 刪除學童：選單彈窗 ---- */

function openDeleteStudentMenu() {
  ensureDeleteStudentBox();

  const idsAll = Object.keys(Students);
  if (idsAll.length === 0) {
    alert("目前沒有學童資料。");
    return;
  }

  const box = document.getElementById("deleteStudentBox");
  const select = document.getElementById("deleteStudentSelect");

  const { ids, statsMap } = getSortedStudentIds();

  select.innerHTML = "";
  ids.forEach(id => {
    const stu = Students[id];
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `${stu.grade ?? ""} ${stu.name ?? ""}`;
    select.appendChild(opt);
  });

  select.onchange = () => updateDeleteStudentInfo(statsMap);
  updateDeleteStudentInfo(statsMap);

  box.classList.remove("hidden");
}

function updateDeleteStudentInfo(statsMap) {
  const select = document.getElementById("deleteStudentSelect");
  const info = document.getElementById("deleteStudentInfo");
  const id = select?.value;
  if (!id || !info) return;

  const stu = Students[id];
  const st = statsMap?.[id] || calcStudentStats(stu);

  info.innerHTML = `
    <div style="line-height:1.6;">
      <div>班級 / 年級：<b>${stu.grade ?? ""}</b></div>
      <div>姓名：<b>${stu.name ?? ""}</b></div>
      <div>最新平均：<b>${(st.avg ?? 0).toFixed(1)}</b></div>
      <div>最新補考數：<b>${st.retake ?? 0}</b></div>
      <div>未完成數：<b>${st.incomplete ?? 0}</b></div>
    </div>
  `;
}

function closeDeleteStudentBox() {
  const box = document.getElementById("deleteStudentBox");
  if (box) box.classList.add("hidden");
}

function confirmDeleteStudent() {
  const select = document.getElementById("deleteStudentSelect");
  const id = select?.value;
  if (!id) return;

  const stu = Students[id];
  if (!stu) return;

  if (!confirm(`確定刪除「${stu.name}」？\n此操作會刪除該生所有成績。`)) return;

  delete Students[id];

  saveData();
  renderTable();

  const popup = document.getElementById("scrollPopup");
  if (popup && !popup.classList.contains("hidden")) {
    closeScroll();
  }

  closeDeleteStudentBox();
}

/* ======================================================
   書卷彈窗（姓名點進去）
   ====================================================== */

// 一位學生在某組單元的完整統計（勇者資訊用）
function getHeroStats(stu, unitList) {
  const done = [];      // { unit, latest, best, count, arr }
  const missing = [];
  const retake = [];

  unitList.forEach(unit => {
    const arr = stu.scores?.[unit];
    if (!arr || arr.length === 0) return missing.push(unit);

    const nums = arr.map(s => Number(s.value)).filter(v => !Number.isNaN(v));
    const latest = Number(arr[arr.length - 1].value);
    const item = { unit, latest, best: nums.length ? Math.max(...nums) : NaN, count: arr.length, arr };
    done.push(item);
    if (!Number.isNaN(latest) && latest < PASS_SCORE) retake.push(item);
  });

  const valid = done.map(d => d.latest).filter(v => !Number.isNaN(v));
  const avg = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;

  return { total: unitList.length, done, missing, retake, avg };
}

function heroCardHtml(title, st, extraClass = "") {
  const pct = st.total ? Math.round(st.done.length / st.total * 100) : 0;
  return `
    <div class="hero-card ${extraClass}">
      <div class="hero-card-title">${title}</div>
      <div class="hero-progress"><span style="width:${pct}%"></span></div>
      <div class="hero-card-row">
        完成 <b>${st.done.length}/${st.total}</b>（${pct}%）｜
        平均 <b>${st.avg === null ? "—" : st.avg.toFixed(1)}</b>｜
        待補考 <b class="${st.retake.length ? "low-score" : ""}">${st.retake.length}</b>
      </div>
    </div>`;
}

const HERO_MISSING_LIMIT = 12;   // 未完成清單每個區塊最多顯示幾個

function openScroll(id) {
  const stu = Students[id];
  if (!stu) return;

  currentScrollID = id;

  const grade = String(stu.grade ?? "").trim();
  const gradeText = !grade ? "" : (/年級|班/.test(grade) ? grade : `${grade} 年級`);
  document.getElementById("stuName").innerText =
    `小勇者 ${stu.name}${gradeText ? `｜${gradeText}` : ""}`;

  const secStats = SECTIONS.map(sec => ({ sec, st: getHeroStats(stu, sectionUnits[sec.key]) }));
  const allStats = getHeroStats(stu, units);

  /* ---- 總覽 ---- */
  document.getElementById("heroSummary").innerHTML =
    heroCardHtml("🛡️ 全部", allStats, "hero-total") +
    secStats.map(({ sec, st }) => heroCardHtml(`${sec.icon} ${sec.label}`, st)).join("");

  /* ---- 待處理：待補考 + 各區塊未完成 ---- */
  let todo = "";
  if (allStats.retake.length) {
    todo += `<div class="hero-todo-group"><b>🔻 待補考</b>` +
      allStats.retake.map(r => `
        <span class="hero-chip low-score">${r.unit}（${r.latest}）
          <span class="edit-btn" title="補考新增" onclick="openRetakeInput('${id}','${r.unit}')">🔁</span>
        </span>`).join("") +
      `</div>`;
  }
  secStats.forEach(({ sec, st }) => {
    if (!st.missing.length) return;
    const shown = st.missing.slice(0, HERO_MISSING_LIMIT);
    const more = st.missing.length - shown.length;
    todo += `<div class="hero-todo-group"><b>✘ 未完成｜${sec.label}（${st.missing.length}）</b>` +
      shown.map(u => `
        <span class="hero-chip">${u}
          <span class="add-btn" title="新增成績" onclick="openInput('${id}','${u}')">➕</span>
        </span>`).join("") +
      (more > 0 ? `<span class="hero-chip">…還有 ${more} 個</span>` : "") +
      `</div>`;
  });
  document.getElementById("heroTodo").innerHTML = todo || "🎉 沒有待處理的項目，太棒了！";

  /* ---- 成績紀錄：依區塊分組，每個單元一列 ---- */
  let html = `
    <tr>
      <th>單元</th>
      <th>最新</th>
      <th>最高</th>
      <th>次數</th>
      <th>歷次紀錄（✒️ 修改 / ❌ 刪除）</th>
    </tr>
  `;
  secStats.forEach(({ sec, st }) => {
    if (!st.done.length) return;
    html += `<tr class="hero-sec-row"><td colspan="5">${sec.icon} ${sec.label}</td></tr>`;
    st.done.forEach(d => {
      const history = d.arr.map((s, index) => {
        const v = Number(s.value);
        return `
          <span class="hero-chip ${v < PASS_SCORE ? "low-score" : ""}">
            ${s.date ?? ""} <b>${Number.isNaN(v) ? "" : v}</b>
            <span class="edit-btn" onclick="openEditScore('${id}','${d.unit}',${index})">✒️</span>
            <span class="check-no" style="cursor:pointer;" onclick="deleteScore('${id}','${d.unit}',${index})">❌</span>
          </span>`;
      }).join("");
      const low = !Number.isNaN(d.latest) && d.latest < PASS_SCORE;
      html += `
        <tr>
          <td>${d.unit}</td>
          <td class="${low ? "low-score" : ""}">${Number.isNaN(d.latest) ? "" : d.latest}${low ? ' <span class="danger-icon">🔻補考</span>' : ""}</td>
          <td>${Number.isNaN(d.best) ? "" : d.best}</td>
          <td>${d.count}</td>
          <td class="hero-history">${history}</td>
        </tr>`;
    });
  });
  if (!allStats.done.length) html += `<tr><td colspan="5" class="missing">還沒有任何成績紀錄。</td></tr>`;
  document.getElementById("recordTable").innerHTML = html;

  /* ---- 進度曲線：每個區塊一條線 ---- */
  const labels = allStats.done.map(d => d.unit);
  const canvas = document.getElementById("chartCanvas");
  if (canvas && typeof Chart !== "undefined") {
    const ctx = canvas.getContext("2d");
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: secStats
          .filter(({ st }) => st.done.length)
          .map(({ sec, st }) => {
            const map = new Map(st.done.map(d => [d.unit, d.latest]));
            return {
              label: `${sec.icon} ${sec.label}`,
              data: labels.map(u => map.has(u) ? map.get(u) : null),
              borderWidth: 3,
              tension: 0.3,
              spanGaps: false
            };
          })
      }
    });
  }

  /* ---- 精靈提示 ---- */
  document.getElementById("aiText").innerHTML = getAIAdvice(allStats, secStats);

  document.getElementById("scrollPopup").classList.remove("hidden");
}

function closeScroll() {
  document.getElementById("scrollPopup").classList.add("hidden");
  currentScrollID = null;
}

function deleteScore(id, unit, index) {
  if (!confirm("確定要刪除此筆成績？")) return;
  const arr = Students[id]?.scores?.[unit];
  if (!arr || !Array.isArray(arr)) return alert("資料格式錯誤。");

  arr.splice(index, 1);

  saveData();
  renderTable();
  if (currentScrollID) openScroll(currentScrollID);
}

function getAIAdvice(allStats, secStats) {
  if (allStats.avg === null) return "目前沒有成績資料。";
  const avg = allStats.avg;

  let msg = "";
  if (avg >= 95) msg += "🌟 整體表現非常優秀！<br>";
  else if (avg >= 85) msg += "✨ 表現不錯，持續保持！<br>";
  else msg += "🌱 多練習一點會更棒！<br>";

  // 最低分的待補考單元優先
  if (allStats.retake.length) {
    const top = [...allStats.retake].sort((a, b) => a.latest - b.latest).slice(0, 3);
    msg += `🔻 建議優先補考：${top.map(r => `${r.unit}（${r.latest}）`).join("、")}<br>`;
  }

  // 平均最低的區塊（至少有成績才比較）
  const ranked = secStats.filter(({ st }) => st.avg !== null).sort((a, b) => a.st.avg - b.st.avg);
  if (ranked.length >= 2) {
    const weak = ranked[0];
    msg += `🎯 最需加強：${weak.sec.label}（平均 ${weak.st.avg.toFixed(1)}）<br>`;
  }

  msg += `📘 最新平均：${avg.toFixed(1)} 分｜完成 ${allStats.done.length}/${allStats.total} 個單元`;
  return msg;
}

/* ======================================================
   匯出 / 匯入
   ====================================================== */

function exportData() {
  const obj = getDataSnapshot();
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "勇者公會成績資料.json";
  a.click();
  URL.revokeObjectURL(url);
  clearDirtyForExport();
}

function importData(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const json = JSON.parse(e.target.result);
      if (!json.units || !json.Students) {
        alert("匯入失敗：格式不正確。");
        return;
      }

      units = json.units;
      sectionUnits = json.sectionUnits || null;
      studentOrder = json.studentOrder || [];
      Students = json.Students;
      normalizeAllStudents();

      const prevInit = isInitializing;
      isInitializing = true;
      try {
        localStorage.setItem("V7Students", JSON.stringify(getDataSnapshot()));
      } catch (_) {}
      isInitializing = prevInit;

      renderTable();
      alert("匯入成功。");
    } catch (err) {
      console.error(err);
      alert("匯入失敗：JSON 解析錯誤。");
    }
  };

  reader.readAsText(file);
  event.target.value = "";
}

/* ======================================================
   localStorage 與防呆補齊
   ====================================================== */

function saveData() {
  try {
    localStorage.setItem("V7Students", JSON.stringify(getDataSnapshot()));
  } catch (_) {}
  markDirtyForExport();
}

function loadData() {
  const saved = localStorage.getItem("V7Students");
  if (!saved) return;
  try {
    const obj = JSON.parse(saved);
    if (obj.units) units = obj.units;
    sectionUnits = obj.sectionUnits || null;
    studentOrder = obj.studentOrder || [];
    if (obj.Students) Students = obj.Students;
  } catch (_) {}
}

function normalizeAllStudents() {
  ensureSections();
  ensureStudentOrder();
  Object.values(Students).forEach(stu => {
    if (!stu.scores) stu.scores = {};
    units.forEach(u => {
      if (!stu.scores[u]) stu.scores[u] = [];
    });
  });
}

/* ======================================================
   刪除彈窗 DOM & 樣式注入（不用改 HTML）
   ====================================================== */

function injectDeleteModalStyles() {
  if (document.getElementById("deleteModalStyle")) return;
  const style = document.createElement("style");
  style.id = "deleteModalStyle";
  style.textContent = `
    #deleteUnitBox, #deleteStudentBox, #editUnitBox{
      position: fixed;
      inset: 0;
      background: rgba(2,6,23,0.75);
      backdrop-filter: blur(6px);
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 18px;
    }
    #deleteUnitInner, #deleteStudentInner, #editUnitInner{
      width: min(420px, 94vw);
      background: linear-gradient(180deg, var(--panel), var(--panel-2));
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 18px 16px;
      box-shadow: var(--shadow);
    }
  `;
  document.head.appendChild(style);
}

function ensureDeleteUnitBox() {
  if (document.getElementById("deleteUnitBox")) return;

  injectDeleteModalStyles();

  const box = document.createElement("div");
  box.id = "deleteUnitBox";
  box.className = "hidden";
  box.innerHTML = `
    <div id="deleteUnitInner">
      <h3>刪除單元</h3>
      <label>請選擇要刪除的單元：</label>
      <select id="deleteUnitSelect"></select>
      <div class="modal-actions">
        <button class="primary" onclick="confirmDeleteUnit()">確定刪除</button>
        <button class="ghost" onclick="closeDeleteUnitBox()">取消</button>
      </div>
    </div>
  `;
  document.body.appendChild(box);
}

function ensureEditUnitBox() {
  if (document.getElementById("editUnitBox")) return;

  injectDeleteModalStyles();

  const box = document.createElement("div");
  box.id = "editUnitBox";
  box.className = "hidden";
  box.innerHTML = `
    <div id="editUnitInner">
      <h3>編輯單元</h3>
      <label>要編輯的單元：</label>
      <select id="editUnitSelect"></select>
      <label>單元名稱：</label>
      <input id="editUnitName">
      <label>所屬區塊：</label>
      <select id="editUnitSection"></select>
      <div class="modal-actions">
        <button class="primary" onclick="confirmEditUnit()">💾 儲存</button>
        <button class="ghost" onclick="closeEditUnitBox()">取消</button>
      </div>
    </div>
  `;
  document.body.appendChild(box);
}

function ensureDeleteStudentBox() {
  if (document.getElementById("deleteStudentBox")) return;

  injectDeleteModalStyles();

  const box = document.createElement("div");
  box.id = "deleteStudentBox";
  box.className = "hidden";
  box.innerHTML = `
    <div id="deleteStudentInner">
      <h3>刪除學童</h3>
      <label>請選擇要刪除的學童：</label>
      <select id="deleteStudentSelect"></select>
      <div id="deleteStudentInfo" style="margin-top:10px;"></div>
      <div class="modal-actions">
        <button class="primary" onclick="confirmDeleteStudent()">確定刪除</button>
        <button class="ghost" onclick="closeDeleteStudentBox()">取消</button>
      </div>
    </div>
  `;
  document.body.appendChild(box);
}

/* ======================================================
   鍵盤：Enter 確定 / Esc 取消（作用在最上層打開的視窗）
   ====================================================== */

// 由上層到下層；onEnter 為 null 表示 Enter 不做事（刪除類避免誤按）
const MODAL_KEYS = [
  { id: "inputBox",         onEnter: () => saveInput(),       onEsc: () => closeInput() },
  { id: "batchBox",         onEnter: onBatchKey,              onEsc: () => closeBatch(), raw: true },
  { id: "unitBox",          onEnter: () => saveUnit(),        onEsc: () => closeUnit() },
  { id: "studentBox",       onEnter: () => saveStudent(),     onEsc: () => closeStudent() },
  { id: "editUnitBox",      onEnter: () => confirmEditUnit(), onEsc: () => closeEditUnitBox() },
  { id: "deleteUnitBox",    onEnter: null,                    onEsc: () => closeDeleteUnitBox() },
  { id: "deleteStudentBox", onEnter: null,                    onEsc: () => closeDeleteStudentBox() },
  { id: "scrollPopup",      onEnter: null,                    onEsc: () => closeScroll() }
];

document.addEventListener("keydown", (e) => {
  // 注音 / 倉頡選字中的 Enter 不算確定
  if (e.isComposing || e.keyCode === 229) return;

  const modal = MODAL_KEYS.find(m => {
    const el = document.getElementById(m.id);
    return el && !el.classList.contains("hidden");
  });
  if (!modal) return;

  if (e.key === "Escape") {
    e.preventDefault();
    modal.onEsc();
    return;
  }

  // 批量輸入自己處理 Enter 與上下鍵
  if (modal.raw) {
    if (e.target.tagName === "BUTTON") return;
    if (["Enter", "ArrowDown", "ArrowUp"].includes(e.key)) modal.onEnter(e);
    return;
  }

  // 焦點在按鈕上時讓按鈕自己處理，避免儲存兩次
  if (e.key === "Enter" && modal.onEnter && e.target.tagName !== "BUTTON") {
    e.preventDefault();
    modal.onEnter();
  }
});

/* ======================================================
   初始化
   ====================================================== */

(function init() {
  ensureBackupBanner();
  loadData();
  normalizeAllStudents();
  migrateVocabUnits();

  const el = document.getElementById("sortSelect");
  if (el) sortMode = el.value || "default";

  renderTable();
  isInitializing = false;
})();

/* ======================================================
   掛到全域（給 HTML onclick 用）
   ====================================================== */

Object.assign(window, {
  // render / sort
  renderTable,
  setSortMode,

  // score
  openInput,
  openEditScore,
  openRetakeInput,
  closeInput,
  saveInput,
  openBatchInput,
  renderBatchList,
  saveBatch,
  closeBatch,
  deleteScore,

  // unit
  openAddUnit,
  closeUnit,
  saveUnit,
  openDeleteUnitMenu,
  closeDeleteUnitBox,
  openEditUnitMenu,
  closeEditUnitBox,
  confirmEditUnit,
  confirmDeleteUnit,

  // student
  openAddStudent,
  closeStudent,
  saveStudent,
  openDeleteStudentMenu,
  closeDeleteStudentBox,
  confirmDeleteStudent,

  // scroll
  openScroll,
  closeScroll,

  // io
  exportData,
  importData,

  // sheets
  syncToSheet,
  syncFromSheet,

  // banner
  hideBackupBanner
});
