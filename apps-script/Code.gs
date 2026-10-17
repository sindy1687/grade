/* ======================================================
   勇者公會成績系統 v8.0 — Google Sheet 同步（Apps Script）
   貼到試算表的「擴充功能 → Apps Script」，取代原本的 Code.gs

   - doPost：網站「🧾 同步到 Google Sheet」→ 存完整資料 + 產生閱讀用分頁
   - doGet ：網站「📥 從 Google Sheet 讀取」→ 回傳完整資料（?classId=…）
             ?info=1 → 回傳 scriptVersion，網站用來確認腳本已更新
   - 多班級：每個班級分開存
       完整資料：隱藏分頁「_data_<classId>」（網站讀回只用這頁，請勿手動修改）
       閱讀用分頁（每次同步會整頁重寫），名稱前面加「班級名｜」：
         📅 每日單字檢測 / 🏅 單字檢定區 / 📘 單元檢測區：各單元最新成績
         📜 全部紀錄：每一筆成績（含補考 / 重考）
   - 更新這份程式後，請用「部署 → 管理部署作業 → 編輯 → 版本：新版本」，網址才不會變
   ====================================================== */

const SCRIPT_VERSION = 3;   // 網站 main.js 的 SHEET_SCRIPT_MIN_VERSION 需 ≤ 這個數字
                            // v3：缺席紀錄 { absent: true }（不算分數、不算補考，不蓋掉之前的分數）

const ABSENT_COLOR = "#b7791f";

function isAbsent_(rec) {
  return !!(rec && rec.absent);
}

// 最後一筆有分數的紀錄（缺席不算）
function latestScored_(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (!isAbsent_(arr[i])) return arr[i];
  return null;
}

function lastAbsentDate_(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (isAbsent_(arr[i])) return arr[i].date || "";
  return "";
}

// 試算表 ID（Apps Script 綁在試算表上時會自動用目前的試算表，這個只是備用）
const SS_ID = "1HLuezvxBOrzpV64V4pGo_V99Zeo_g2Y70VzkY6-LTME";

const DATA_SHEET = "_data";
const HISTORY_SHEET = "📜 全部紀錄";
const CHUNK = 40000;          // 單一儲存格上限 50000 字，分段存
const CHUNK_PREFIX = "~";     // 避免被試算表當成數字 / 日期 / 公式
const LOW_COLOR = "#d6336c";

// 網站沒送區塊資訊時（舊版網站）的預設值，需與 main.js 的 SECTIONS 一致
const DEFAULT_SECTIONS = [
  { key: "daily", label: "每日單字檢測", icon: "📅" },
  { key: "vocab", label: "單字檢定區",   icon: "🏅" },
  { key: "unit",  label: "單元檢測區",   icon: "📘" }
];

function getSS_() {
  return SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(SS_ID);
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(typeof obj === "string" ? obj : JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 每個班級的完整資料分頁；沒有 classId（舊版網站）用「_data」
function dataSheetName_(classId) {
  if (!classId) return DATA_SHEET;
  if (!/^[A-Za-z0-9_-]+$/.test(classId)) throw new Error("classId 格式不正確");
  return `${DATA_SHEET}_${classId}`;
}

// 閱讀用分頁名稱：「班級名｜區塊名」（去掉分頁名稱不允許的字元）
function viewSheetName_(className, base) {
  if (!className) return base;
  const safe = String(className).replace(/[\[\]\*\?\/\\:]/g, "_").slice(0, 40);
  return `${safe}｜${base}`;
}

/* ---------------- 網站讀取 ---------------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.info) return jsonOut_({ scriptVersion: SCRIPT_VERSION });
  try {
    return jsonOut_(readData_(p.classId) || "{}");
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/* ---------------- 網站寫入 ---------------- */

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const data = JSON.parse(e.postData.contents);
    if (!data.units || !data.Students) throw new Error("資料格式不正確（缺 units / Students）");
    dataSheetName_(data.classId);   // 先檢查 classId

    writeViews_(data);
    writeData_(data);
    return jsonOut_({ ok: true, savedAt: new Date().toISOString() });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- 完整資料（_data） ---------------- */

function readData_(classId) {
  const sh = getSS_().getSheetByName(dataSheetName_(classId));
  if (!sh || sh.getLastRow() === 0) return null;
  return sh.getRange(1, 1, sh.getLastRow(), 1).getValues()
    .map(r => String(r[0]))
    .map(s => s.startsWith(CHUNK_PREFIX) ? s.slice(CHUNK_PREFIX.length) : s)
    .join("");
}

function writeData_(data) {
  const ss = getSS_();
  const name = dataSheetName_(data.classId);
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  const text = JSON.stringify(data);

  const rows = [];
  for (let i = 0; i < text.length; i += CHUNK) {
    rows.push([CHUNK_PREFIX + text.slice(i, i + CHUNK)]);
  }

  sh.clear();
  sh.getRange(1, 1, rows.length, 1).setNumberFormat("@").setValues(rows);
  try { sh.hideSheet(); } catch (_) {}
}

/* ---------------- 閱讀用分頁 ---------------- */

function writeViews_(data) {
  const ss = getSS_();
  const sections = data.sections || DEFAULT_SECTIONS;
  const pass = Number(data.passScore) || 80;
  const students = data.Students;

  // 區塊設定：沒有就全部放到最後一個區塊（單元檢測區）
  const secUnits = data.sectionUnits || { [sections[sections.length - 1].key]: data.units };

  // 學生順序：網站拖移的順序，缺的補在後面
  const order = (data.studentOrder || []).filter(id => students[id]);
  Object.keys(students).forEach(id => { if (order.indexOf(id) === -1) order.push(id); });

  const unitSection = {};
  sections.forEach(sec => (secUnits[sec.key] || []).forEach(u => { unitSection[u] = sec.label; }));

  sections.forEach(sec => {
    writeSectionSheet_(ss, viewSheetName_(data.className, `${sec.icon} ${sec.label}`),
      secUnits[sec.key] || [], order, students, pass);
  });
  writeHistorySheet_(ss, viewSheetName_(data.className, HISTORY_SHEET),
    data.units, unitSection, order, students, pass);
}

function resetSheet_(ss, name) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  sh.setFrozenRows(0);
  sh.setFrozenColumns(0);
  return sh;
}

// 每位學生一列：年級、姓名、各單元最新「日期（分數）」、未完成、補考數、缺席
function writeSectionSheet_(ss, name, unitList, order, students, pass) {
  const sh = resetSheet_(ss, name);

  const header = ["年級", "姓名"].concat(unitList, ["未完成", "補考數", "缺席"]);
  const values = [header];
  const colors = [header.map(() => "#000000")];

  order.forEach(id => {
    const stu = students[id];
    if (!stu || !stu.name) return;

    const row = [String(stu.grade == null ? "" : stu.grade), stu.name];
    const rowColors = ["#000000", "#000000"];
    let incomplete = 0;
    let retake = 0;
    let absent = 0;

    unitList.forEach(u => {
      const arr = (stu.scores && stu.scores[u]) || [];
      const latest = latestScored_(arr);
      if (!latest) {
        incomplete++;
        if (arr.length) {            // 只有缺席，還沒考到
          absent++;
          row.push(`缺席 ${lastAbsentDate_(arr)}`);
          rowColors.push(ABSENT_COLOR);
        } else {
          row.push("");
          rowColors.push("#000000");
        }
        return;
      }
      const v = Number(latest.value);
      const low = !isNaN(v) && v < pass;
      if (low) retake++;
      row.push(`${latest.date || ""}（${latest.value}）${arr.length > 1 ? ` ×${arr.length}` : ""}`);
      rowColors.push(low ? LOW_COLOR : "#000000");
    });

    row.push(String(incomplete), String(retake), String(absent));
    rowColors.push("#000000", retake ? LOW_COLOR : "#000000", absent ? ABSENT_COLOR : "#000000");
    values.push(row);
    colors.push(rowColors);
  });

  const range = sh.getRange(1, 1, values.length, header.length);
  range.setNumberFormat("@").setValues(values).setFontColors(colors);
  sh.getRange(1, 1, 1, header.length).setFontWeight("bold").setBackground("#fde7f1");
  sh.setFrozenRows(1);
  sh.setFrozenColumns(2);
  sh.autoResizeColumns(1, header.length);
}

// 每一筆成績一列（含補考 / 重考的每一次）
function writeHistorySheet_(ss, name, units, unitSection, order, students, pass) {
  const sh = resetSheet_(ss, name);

  const header = ["年級", "姓名", "區塊", "單元", "第幾次", "日期", "分數", "結果"];
  const values = [header];
  const colors = [header.map(() => "#000000")];

  order.forEach(id => {
    const stu = students[id];
    if (!stu || !stu.name) return;
    units.forEach(u => {
      const arr = (stu.scores && stu.scores[u]) || [];
      arr.forEach((s, i) => {
        const absent = isAbsent_(s);
        const v = Number(s.value);
        const low = !absent && !isNaN(v) && v < pass;
        values.push([
          String(stu.grade == null ? "" : stu.grade), stu.name, unitSection[u] || "", u,
          String(i + 1), String(s.date || ""),
          absent ? "" : (isNaN(v) ? String(s.value) : v),
          absent ? "缺席" : (low ? "補考" : "通過")
        ]);
        const color = absent ? ABSENT_COLOR : (low ? LOW_COLOR : "#000000");
        colors.push(header.map((_, c) => c >= 6 ? color : "#000000"));
      });
    });
  });

  const range = sh.getRange(1, 1, values.length, header.length);
  range.setNumberFormat("@");
  if (values.length > 1) sh.getRange(2, 7, values.length - 1, 1).setNumberFormat("0");
  range.setValues(values).setFontColors(colors);
  sh.getRange(1, 1, 1, header.length).setFontWeight("bold").setBackground("#e3f4fd");
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, header.length);
}
