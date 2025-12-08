/* ======================================================
   勇者公會成績系統 v7.9（乾淨整合版）
   - 新增 / 刪除學童（選單彈窗）
   - 新增 / 刪除單元（選單彈窗）
   - 單元拖拉排序
   - 成績新增 / 修改 / 補考（保留所有歷史）
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

let Students = window.Students || {};
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
    const payload = { units, Students };

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
    Students = json.Students;

    normalizeAllStudents();

    const prevInit = isInitializing;
    isInitializing = true;
    try {
      localStorage.setItem("V7Students", JSON.stringify({ units, Students }));
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

function calcStudentStats(stu) {
  let scores = [];
  let incomplete = 0;
  let retake = 0;

  units.forEach(unit => {
    const arr = stu?.scores?.[unit];
    if (!arr || arr.length === 0) {
      incomplete++;
      return;
    }
    const latest = arr[arr.length - 1];
    const v = Number(latest.value);
    if (!Number.isNaN(v)) {
      scores.push(v);
      if (v < 80) retake++;
    }
  });

  const avg = scores.length ? scores.reduce((a,b)=>a+b,0) / scores.length : 0;
  return { avg, incomplete, retake };
}

function getSortedStudentIds() {
  const ids = Object.keys(Students);
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

  let html = `
    <tr>
      <th class="leftFreeze" style="left:0;">年級</th>
      <th class="leftFreeze" style="left:70px;">姓名</th>
  `;

  units.forEach(u => {
    html += `<th class="unitHeader" draggable="true" data-unit="${u}">${u}</th>`;
  });

  html += `<th>未完成</th><th>補考數</th></tr>`;

  const { ids, statsMap } = getSortedStudentIds();

  ids.forEach(id => {
    const stu = Students[id];
    if (!stu?.name) return;
    if (keyword && !stu.name.includes(keyword)) return;

    const { incomplete, retake } = statsMap[id];

    html += `
      <tr>
        <td class="leftFreeze" style="left:0;">${stu.grade ?? ""}</td>
        <td class="leftFreeze nameCell" style="left:70px;" onclick="openScroll('${id}')">${stu.name}</td>
    `;

    units.forEach(unit => {
      const arr = stu.scores?.[unit];

      if (arr && arr.length > 0) {
        const latest = arr[arr.length - 1];
        const score = Number(latest.value);
        const date = latest.date ?? "";

        if (!Number.isNaN(score) && score < 80) {
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
              <span class="edit-btn" onclick="openEditScore('${id}','${unit}',${arr.length - 1})">✒️</span>
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

    html += `<td>${incomplete === 0 ? "✔" : "✘"}</td>`;
    html += `<td>${retake}</td>`;
    html += `</tr>`;
  });

  const table = document.getElementById("scoreTable");
  if (table) table.innerHTML = html;

  enableUnitDrag();
}

/* ======================================================
   單元拖拉排序
   ====================================================== */

function enableUnitDrag() {
  const headers = document.querySelectorAll("#scoreTable th.unitHeader");
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

  const fromIndex = units.indexOf(fromUnit);
  const toIndex = units.indexOf(targetUnit);
  if (fromIndex < 0 || toIndex < 0) return;

  units.splice(fromIndex, 1);
  units.splice(toIndex, 0, fromUnit);

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
  document.querySelectorAll("#scoreTable th.unitHeader").forEach(th => {
    th.classList.remove("unit-drag-over", "unit-dragging");
  });
}

/* ======================================================
   成績：新增 / 修改 / 補考新增
   ====================================================== */

function openInput(id, unit) {
  editingID = id;
  editingUnit = unit;
  editingIndex = null;

  const stu = Students[id];
  document.getElementById("inputTitle").innerText =
    `新增成績｜${stu ? stu.name : ""}｜${unit}`;

  document.getElementById("inputDate").value = "";
  document.getElementById("inputScore").value = "";
  document.getElementById("inputBox").classList.remove("hidden");
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
}

function openRetakeInput(id, unit) {
  editingID = id;
  editingUnit = unit;
  editingIndex = null;

  const stu = Students[id];
  document.getElementById("inputTitle").innerText =
    `補考新增｜${stu ? stu.name : ""}｜${unit}`;

  document.getElementById("inputDate").value = "";
  document.getElementById("inputScore").value = "";
  document.getElementById("inputBox").classList.remove("hidden");
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
   單元：新增 + 刪除（選單彈窗）
   ====================================================== */

function openAddUnit() {
  document.getElementById("unitName").value = "";
  document.getElementById("unitBox").classList.remove("hidden");
}

function closeUnit() {
  document.getElementById("unitBox").classList.add("hidden");
}

function saveUnit() {
  const u = document.getElementById("unitName").value.trim();
  if (!u) return alert("請輸入單元名稱。");
  if (units.includes(u)) return alert("此單元已存在。");

  units.push(u);
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

  select.innerHTML = "";
  units.forEach(u => {
    const opt = document.createElement("option");
    opt.value = u;
    opt.textContent = u;
    select.appendChild(opt);
  });

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

  units = units.filter(u => u !== unit);
  Object.values(Students).forEach(stu => {
    if (stu.scores) delete stu.scores[unit];
  });

  saveData();
  renderTable();
  if (currentScrollID) openScroll(currentScrollID);
  closeDeleteUnitBox();
}

/* ======================================================
   學童：新增 + 刪除（選單彈窗）
   ====================================================== */

function openAddStudent() {
  document.getElementById("studentName").value = "";
  document.getElementById("studentGrade").value = "";
  document.getElementById("studentBox").classList.remove("hidden");
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

function openScroll(id) {
  const stu = Students[id];
  if (!stu) return;

  currentScrollID = id;

  document.getElementById("stuName").innerText = `小勇者 ${stu.name}`;

  let html = `
    <tr>
      <th>單元</th>
      <th>日期</th>
      <th>分數</th>
      <th>刪除</th>
    </tr>
  `;

  const labels = [];
  const values = [];

  units.forEach(unit => {
    const arr = stu.scores?.[unit];
    if (!arr || arr.length === 0) return;

    arr.forEach((s, index) => {
      const v = Number(s.value);
      html += `
        <tr>
          <td>${unit}</td>
          <td>${s.date ?? ""}</td>
          <td class="${v < 80 ? "low-score" : ""}">
            ${Number.isNaN(v) ? "" : v}
            <span class="edit-btn" style="margin-left:6px; cursor:pointer;"
              onclick="openEditScore('${id}','${unit}',${index})">✒️</span>
            ${(!Number.isNaN(v) && v < 80) ? '<span class="danger-icon">🔻補考</span>' : ""}
          </td>
          <td>
            <span class="check-no" style="cursor:pointer;"
              onclick="deleteScore('${id}','${unit}',${index})">❌</span>
          </td>
        </tr>
      `;
    });

    const latest = arr[arr.length - 1];
    values.push(Number(latest.value));
    labels.push(unit);
  });

  document.getElementById("recordTable").innerHTML = html;

  const canvas = document.getElementById("chartCanvas");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "最新成績",
          data: values,
          borderWidth: 3,
          tension: 0.3
        }]
      }
    });
  }

  const retakeLatest = values.filter(v => typeof v === "number" && v < 80).length;
  document.getElementById("aiText").innerHTML =
    getAIAdvice(values) + `<br>🔻 最新補考單元數：${retakeLatest}`;

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

function getAIAdvice(values) {
  if (!values || values.length === 0) return "目前沒有成績資料。";
  const valid = values.filter(v => typeof v === "number" && !Number.isNaN(v));
  if (valid.length === 0) return "目前沒有有效成績資料。";

  const avg = valid.reduce((a,b)=>a+b,0) / valid.length;
  const min = Math.min(...valid);

  let msg = "";
  if (min < 80) msg += "🔻 有需要補考的單元，記得加油！<br>";
  if (avg >= 95) msg += "🌟 整體表現非常優秀！<br>";
  else if (avg >= 85) msg += "✨ 表現不錯，持續保持！<br>";
  else msg += "🌱 多練習一點會更棒！<br>";

  msg += `📘 最新平均：${avg.toFixed(1)} 分`;
  return msg;
}

/* ======================================================
   匯出 / 匯入
   ====================================================== */

function exportData() {
  const obj = { units, Students };
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
      Students = json.Students;
      normalizeAllStudents();

      const prevInit = isInitializing;
      isInitializing = true;
      try {
        localStorage.setItem("V7Students", JSON.stringify({ units, Students }));
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
    localStorage.setItem("V7Students", JSON.stringify({ units, Students }));
  } catch (_) {}
  markDirtyForExport();
}

function loadData() {
  const saved = localStorage.getItem("V7Students");
  if (!saved) return;
  try {
    const obj = JSON.parse(saved);
    if (obj.units) units = obj.units;
    if (obj.Students) Students = obj.Students;
  } catch (_) {}
}

function normalizeAllStudents() {
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
    #deleteUnitBox, #deleteStudentBox{
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
    #deleteUnitInner, #deleteStudentInner{
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
   初始化
   ====================================================== */

(function init() {
  ensureBackupBanner();
  loadData();
  normalizeAllStudents();

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
  deleteScore,

  // unit
  openAddUnit,
  closeUnit,
  saveUnit,
  openDeleteUnitMenu,
  closeDeleteUnitBox,
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
