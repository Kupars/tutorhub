import { APP_CONFIG } from "./app-env.js";
import { SUBJECTS, GRADES } from "./data.js";
import { estimateCommuteLocal, inferCoordsFromText, resolveUserAddress } from "./commute.js?v=2";
import { gcj02ToWgs84, moveMapTo, openMapBoard, setMapOrderSelectionHandlers, updateMapOrders, updateMapOrigin } from "./map-board.js?v=2";
import { parseMessyOrders, interpretSiteCommand, optimizeOrderAddressesWithAI } from "./ai-engine.js";
import { Store } from "./store.js";
import { canonicalDistrict, formatOrderText, getSubjectList, mergeOrders, nextOrderId, normalizeOrder, parseFormattedOrder, splitOrderBySubject } from "./order-format.js";
import { importOrderTable } from "./order-import.js";
import { buildWechatSelectionText, sortBoardOrders, teacherGenderRequirement } from "./board-utils.js";
import { getSeasonForDate, SEASON_DETAILS } from "./season-theme.js";

const state = {
  view: "hall",
  layout: "cards",
  onlyOpen: false,
  onlySelected: false,
  parsedDraftOrders: [],
  editingOrderId: null,
  editingPartTimeId: null
};
let visibleBoardOrders = [];
let expandedOrderId = null;
// 升级展示偏好版本：之前的默认列表偏好不影响新版默认卡片。
const BOARD_LAYOUT_KEY = "tutorhub_board_layout_v2";
const COLOR_MODE_KEY = "tutorhub_color_mode_v1";
let mapCandidates = [];
let mapSearchVersion = 0;
let mapSearchTimer = null;

const $ = (id) => document.getElementById(id);

function savedColorMode() {
  try {
    const stored = localStorage.getItem(COLOR_MODE_KEY);
    return stored === "dark" || stored === "light" ? stored : null;
  } catch { return null; }
}

function applyColorMode(mode) {
  document.documentElement.dataset.colorMode = mode;
  const isDark = mode === "dark";
  const season = SEASON_DETAILS[document.documentElement.dataset.season] || SEASON_DETAILS.winter;
  for (const id of ["btnColorMode", "btnMobileColorMode"]) {
    const button = $(id);
    if (!button) continue;
    button.textContent = isDark ? "☀️ 浅色" : "🌙 深色";
    button.setAttribute("aria-label", isDark ? "切换浅色模式" : "切换深色模式");
    button.setAttribute("aria-pressed", String(isDark));
    button.title = `切换${season.label}${isDark ? "浅色" : "深色"}主题`;
  }
  const browserTheme = document.querySelector('meta[name="theme-color"]');
  if (browserTheme) browserTheme.content = isDark ? "#0b1728" : season.lightThemeColor;
}

function syncSeasonTheme() {
  const season = getSeasonForDate();
  if (document.documentElement.dataset.season === season) return;
  document.documentElement.dataset.season = season;
  applyColorMode(document.documentElement.dataset.colorMode === "dark" ? "dark" : "light");
}

function initColorMode() {
  document.documentElement.dataset.season = getSeasonForDate();
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  applyColorMode(savedColorMode() || (media?.matches ? "dark" : "light"));
  for (const id of ["btnColorMode", "btnMobileColorMode"]) {
    $(id)?.addEventListener("click", () => {
      const next = document.documentElement.dataset.colorMode === "dark" ? "light" : "dark";
      try { localStorage.setItem(COLOR_MODE_KEY, next); } catch { /* 隐私模式仍可切换 */ }
      applyColorMode(next);
    });
  }
  media?.addEventListener?.("change", (event) => {
    if (!savedColorMode()) applyColorMode(event.matches ? "dark" : "light");
  });
  // 页面长时间不关闭时也会在节气更替后自动切换；重新切回标签页立即校对。
  window.setInterval(syncSeasonTheme, 15 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncSeasonTheme(); });
}

function showToast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("show"), 2800);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function copyText(text, successMsg = "已复制") {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    showToast(successMsg);
    return true;
  } catch {
    // 兼容部分微信内置浏览器及未授予剪贴板权限的旧浏览器。
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    let copied = false;
    try { copied = document.execCommand("copy"); } catch { /* 浏览器不支持传统复制 */ }
    input.remove();
    showToast(copied ? successMsg : "自动复制失败，请使用卡片里的单独复制按钮");
    return copied;
  }
}

function applySiteConfig() {
  const cfg = Store.getSiteConfig();
  document.documentElement.setAttribute("data-theme", cfg.theme || "indigo");
  document.title = "小木学长 · 天津家教看板";
  const notice = (cfg.announcement || "").trim();
  // 旧站公告可能提到账号与自动投递，不再展示过时的使用指引。
  $("siteAnnouncement").textContent = /自动投递|简历|登录|注册|账号|选中感兴趣的家教单|复制后微信联系/.test(notice) ? "" : notice;
  $("siteAnnouncement").hidden = !$("siteAnnouncement").textContent;
  $("modeBadge").textContent = Store.isCloudMode() ? "🟢 云端已同步" : "";
}

function renderUserActions() {
  const user = Store.getCurrentUser();
  const wrap = $("userActions");
  wrap.innerHTML = user?.role === "admin" ? `<button class="btn btn-sm" id="btnLogout">退出管理</button>` : "";
  $("btnLogout")?.addEventListener("click", () => {
    Store.logout();
    switchView("hall");
    renderAll();
    showToast("已安全退出管理后台");
  });
}

function switchView(viewName) {
  state.view = viewName;
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(`view-${viewName}`).classList.add("active");
  $("btnAdminEntry").hidden = viewName === "admin";
  $("btnBackToHall").hidden = viewName !== "admin";
  $("cartDock").hidden = viewName !== "hall";
  $("btnViewTutoring").classList.toggle("active", viewName === "hall");
  $("btnViewPartTime").classList.toggle("active", viewName === "parttime");
  $("btnMobileTutoring").classList.toggle("active", viewName === "hall");
  $("btnMobileMore").classList.toggle("active", viewName === "parttime");
  $("btnMobileTutoring").setAttribute("aria-current", viewName === "hall" ? "page" : "false");
  $("btnMobileMore").setAttribute("aria-current", viewName === "parttime" ? "page" : "false");
  document.querySelector(".mobile-bottom-nav").classList.toggle("is-admin", viewName === "admin");
  if (viewName === "hall") { renderHall(); setTimeout(() => { void openMap(); }, 0); }
  if (viewName === "parttime") renderPartTime();
  if (viewName === "admin") renderAdminView();
}

// ---------------- 视图 1：招募大厅 ----------------
function renderHall() {
  const subjectSelect = $("qSubject");
  const selectedSubject = subjectSelect.value;
  const subjects = [...SUBJECTS, "作业辅导", "陪读", "道法"];
  subjectSelect.innerHTML = '<option value="">全部科目</option>' +
    subjects.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  subjectSelect.value = subjects.includes(selectedSubject) ? selectedSubject : "";
  const districtSelect = $("qDistrict");
  const selectedDistrict = districtSelect.value;
  const districts = [...new Set(Store.getOrders().map((o) => canonicalDistrict(o.district)).filter((d) => d && d !== "区域待补充"))].sort();
  districtSelect.innerHTML = '<option value="">全部区域</option>' +
    districts.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  districtSelect.value = districts.includes(selectedDistrict) ? selectedDistrict : "";
  const q = $("qSearch").value.trim().toLowerCase();
  const subject = $("qSubject").value;
  const grade = $("qGrade").value;
  const mode = $("qMode").value;
  const sort = $("qSort").value;
  const studentGender = $("qStudentGender").value;
  const teacherGender = $("qTeacherGender").value;
  const district = $("qDistrict").value;
  const time = $("qTime").value;
  const minRate = Number($("qMinRate").value) || 0;
  const origin = Store.getOrigin();
  const selected = Store.getSelectedOrderIds();

  let items = Store.getOrders().map((order) => ({
    ...order,
    commute: estimateCommuteLocal(origin, order),
    selected: selected.includes(order.id)
  }));

  items = items.filter((o) => {
    if (state.onlyOpen && o.status !== "招募中") return false;
    if (state.onlySelected && !o.selected) return false;
    if (subject && o.subject !== subject && !getSubjectList(o.subject).includes(subject) && !o.subject.includes(subject)) return false;
    if (grade && o.grade !== grade && !o.grade.includes(grade) && !(grade === "小学" && /[一二三四五六1-6]年级/.test(o.grade))) return false;
    if (mode && o.mode !== mode) return false;
    if (studentGender && o.studentGender !== studentGender) return false;
    const teacherPref = teacherGenderRequirement(o);
    if (teacherGender === "不限" && teacherPref !== "不限") return false;
    if (["男生", "女生"].includes(teacherGender) && teacherPref !== "不限" && teacherPref !== teacherGender) return false;
    if (district && canonicalDistrict(o.district) !== district) return false;
    if (minRate && o.hourlyRate < minRate) return false;
    if (time === "weekend" && !/周末|周六|周日|周天/.test(o.weeklyFrequency || o.schedule || "")) return false;
    if (time === "weekday" && !/周中|周一|周二|周三|周四|周五/.test(o.weeklyFrequency || o.schedule || "")) return false;
    if (q) {
      const hay = [o.id, o.orderNumber, o.title, o.subject, o.grade, o.studentGender, o.teacherCount,
        o.currentScores, o.weeklyFrequency, o.trialTime, o.salaryText, o.district, o.address,
        o.studentInfo, o.requirements, ...(o.tags || [])]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  items = sortBoardOrders(items, sort);
  visibleBoardOrders = items;
  updateMapOrders(items);

  $("resultStats").textContent = `共匹配 ${items.length} 条家教单（当前出发地址：${origin.name}）`;
  const advancedIds = ["qSubject", "qGrade", "qMode", "qStudentGender", "qTeacherGender", "qDistrict", "qTime", "qMinRate"];
  const activeCount = advancedIds.filter((id) => $(id).value).length + Number(state.onlyOpen) + Number(state.onlySelected);
  $("activeFilterCount").textContent = activeCount ? ` · 已选 ${activeCount} 项` : "";
  $("btnListMode").classList.toggle("active", state.layout === "list");
  $("btnCardMode").classList.toggle("active", state.layout === "cards");
  $("btnListMode").setAttribute("aria-pressed", String(state.layout === "list"));
  $("btnCardMode").setAttribute("aria-pressed", String(state.layout === "cards"));
  renderCart();

  const grid = $("ordersGrid");
  grid.classList.toggle("is-list-mode", state.layout === "list");
  if (items.length === 0) {
    grid.innerHTML = `<div class="panel" style="grid-column:1/-1;text-align:center;color:var(--muted);">${Store.getOrders().length ? "没有符合条件的家教单，试试放宽筛选条件吧。" : "暂无家教单，管理员可在「安全后台」新增或批量导入。"} </div>`;
    return;
  }

  const renderDetailCard = (o) => {
    const commuteHtml = o.commute
      ? o.commute.isOnline
        ? `<span class="chip commute">💻 线上免通勤</span>`
        : `<span class="chip commute">路程约：骑行 ${o.commute.bikeMin} 分 / 公交 ${o.commute.transitMin} 分</span>`
      : "";
    const statusClass = o.status === "招募中" ? "status-open" : "status-closed";
    return `
      <article class="order-card ${o.selected ? "order-selected" : ""}">
        <div class="card-head">
          <div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:2px;">${escapeHtml(o.orderNumber || o.id)}</div>
            <div class="card-title">${escapeHtml(o.district === "线上" ? "线上" : canonicalDistrict(o.district) || "地点待补充")} · ${escapeHtml(o.title)}</div>
          </div>
          <div class="price-badge">${escapeHtml((o.salaryText || "老师报价").replace("（可报价）", ""))}</div>
        </div>

        <div class="meta-row">
          ${o.status && o.status !== "待确认" ? `<span class="chip ${statusClass}">${escapeHtml(o.status)}</span>` : ""}
          ${o.urgent ? `<span class="chip urgent">🔥 急招</span>` : ""}
          ${o.onlineAllowed ? '<span class="chip">💻 可网课</span>' : ""}
          ${commuteHtml}
        </div>

        <div class="card-desc">
          <div><strong>地点：</strong>${escapeHtml(o.address)}</div>
          <div><strong>时间：</strong>${escapeHtml(o.weeklyFrequency)} · 每次 ${o.hoursPerSession}小时</div>
          <div><strong>成绩：</strong>${escapeHtml(o.currentScores)}</div>
          <div><strong>学生：</strong>${escapeHtml(o.studentGender)}</div>
          ${Number(o.teacherCount) > 1 ? `<div class="teacher-count-row"><strong>需要老师：</strong>${Number(o.teacherCount)}位</div>` : ""}
          ${teacherGenderRequirement(o) === "不限" ? "" : `<div><strong>老师性别：</strong>${teacherGenderRequirement(o) === "男生" ? "男老师" : "女老师"}</div>`}
          ${o.trialTime ? `<div><strong>试课：</strong>${escapeHtml(o.trialTime)}</div>` : ""}
          ${o.studentInfo ? `<div><strong>补充：</strong>${escapeHtml(o.studentInfo)}</div>` : ""}
          <div><strong>要求：</strong>${escapeHtml(o.requirements)}</div>
        </div>

        <div class="card-foot">
          <label class="order-check"><input type="checkbox" data-select="${escapeHtml(o.id)}" ${o.selected ? "checked" : ""} /> 勾选此单</label>
          <button class="btn btn-sm" data-copy="${escapeHtml(o.id)}">📋 单独复制</button>
        </div>
      </article>
    `;
  };

  if (state.layout === "cards") {
    grid.innerHTML = items.map(renderDetailCard).join("");
  } else {
    const header = ["单号", "区域", "年级", "性别", "科目", "时薪", "频率", "详情"]
      .map((label) => `<span>${label}</span>`).join("");
    grid.innerHTML = `<div class="orders-list"><div class="orders-list-header">${header}</div>${items.map((o) => {
      const expanded = expandedOrderId === o.id;
      const area = o.district === "线上" ? "线上" : canonicalDistrict(o.district) || "待补充";
      const rate = (o.salaryText || "老师报价").replace("（可报价）", "");
      const detailsId = `detail-${String(o.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      return `<div class="orders-list-item ${expanded ? "expanded" : ""} ${o.selected ? "is-selected" : ""}">
        <button type="button" class="orders-list-row" data-expand-order="${escapeHtml(o.id)}" aria-expanded="${expanded}" aria-controls="${detailsId}">
          <span class="list-cell list-id">${escapeHtml(o.orderNumber || o.id)}</span>
          <span class="list-cell list-area">${escapeHtml(area)}</span>
          <span class="list-cell list-grade">${escapeHtml(o.grade)}</span>
          <span class="list-cell list-gender">${escapeHtml(o.studentGender)}</span>
          <span class="list-cell list-subject" title="${escapeHtml(o.subject)}">${escapeHtml(o.subject)}</span>
          <span class="list-cell list-rate">${escapeHtml(rate)}</span>
          <span class="list-cell list-frequency" title="${escapeHtml(o.weeklyFrequency)}">${escapeHtml(o.weeklyFrequency)}</span>
          <span class="list-cell list-expand">${o.selected ? "✓ 已选 · " : ""}${expanded ? "收起 ▲" : "展开 ▼"}</span>
        </button>
        ${expanded ? `<div id="${detailsId}" class="orders-list-detail">${renderDetailCard(o)}</div>` : ""}
      </div>`;
    }).join("")}</div>`;
  }

  grid.querySelectorAll("[data-expand-order]").forEach((button) => {
    button.onclick = () => {
      expandedOrderId = expandedOrderId === button.dataset.expandOrder ? null : button.dataset.expandOrder;
      renderHall();
    };
  });

  grid.querySelectorAll("[data-select]").forEach((input) => {
    input.onchange = () => {
      Store.toggleSelectedOrder(input.dataset.select);
      renderHall();
      showToast(Store.getSelectedOrderIds().includes(input.dataset.select) ? "已勾选" : "已取消勾选");
    };
  });
  grid.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.onclick = () => {
      const o = Store.getOrders().find((x) => x.id === btn.dataset.copy);
      if (!o) return;
      copyText(formatOrderText(o), "已复制标准九字段家教单");
    };
  });
}

function getSelectedOrders() {
  const byId = new Map(Store.getOrders().map((order) => [order.id, order]));
  return Store.getSelectedOrderIds().map((id) => byId.get(id)).filter(Boolean);
}

function renderCart() {
  const orders = getSelectedOrders();
  $("cartCount").textContent = String(orders.length);
  $("cartDock").hidden = state.view !== "hall" || !orders.length;
  $("btnCopyCart").disabled = !orders.length;
  $("btnClearCart").disabled = !orders.length;
  const box = $("cartItems");
  box.innerHTML = orders.length ? orders.map((o) => `
    <div class="cart-item">
      <div><strong>${escapeHtml(o.orderNumber || o.id)} · ${escapeHtml(o.title)}</strong><p>${escapeHtml(o.address)} · ${escapeHtml(o.salaryText)}</p></div>
      <button class="btn btn-sm" data-remove-selection="${escapeHtml(o.id)}" aria-label="从选单清单移除 ${escapeHtml(o.id)}">移除</button>
    </div>
  `).join("") : `<div class="cart-empty">清单还是空的。回到看板，点击家教卡片上的「+ 加入选单」就可以开始挑选。</div>`;
  box.querySelectorAll("[data-remove-selection]").forEach((btn) => {
    btn.onclick = () => { Store.toggleSelectedOrder(btn.dataset.removeSelection); renderHall(); };
  });
}

function renderPartTime() {
  const posts = Store.getPartTimePosts();
  $("partTimeGrid").innerHTML = posts.length ? posts.map((post) => `
    <article class="parttime-card">
      <h2>${escapeHtml(post.title)}</h2>
      <div class="parttime-meta"><span>🕒 ${escapeHtml(post.time)}</span><span>📍 ${escapeHtml(post.location)}</span></div>
      <p class="parttime-content">${escapeHtml(post.content)}</p>
      <button class="btn btn-sm" data-copy-parttime="${escapeHtml(post.id)}">📋 复制兼职信息</button>
    </article>
  `).join("") : `<div class="panel" style="text-align:center;color:var(--muted);">暂无其他兼职信息，管理员发布后会在这里显示。</div>`;
  $("partTimeGrid").querySelectorAll("[data-copy-parttime]").forEach((button) => {
    button.onclick = () => {
      const post = posts.find((item) => item.id === button.dataset.copyParttime);
      if (post) copyText(`【兼职】${post.title}\n【时间】${post.time}\n【地点】${post.location}\n【详细内容】${post.content}`, "已复制兼职信息");
    };
  });
}

// 公共看板不再提供用户账号、简历或投递功能。

function fillManualOrder(order) {
  const o = normalizeOrder(order);
  $("manualId").value = o.id;
  $("manualId").readOnly = true;
  if (![...$("manualGrade").options].some((option) => option.value === o.grade)) {
    $("manualGrade").add(new Option(o.grade, o.grade));
  }
  $("manualGrade").value = o.grade;
  $("manualStudentGender").value = o.studentGender;
  $("manualSubject").value = o.subject;
  $("manualTeacherCount").value = o.teacherCount;
  $("manualScores").value = o.currentScores;
  $("manualHours").value = o.hoursPerSession;
  $("manualAddress").value = o.address;
  $("manualMode").value = o.mode;
  $("manualWeekly").value = o.weeklyFrequency;
  $("manualSalary").value = o.salaryText;
  $("manualRequirements").value = o.requirements;
  $("manualTrial").value = o.trialTime;
  $("manualNotes").value = o.notes;
  $("manualOnline").checked = o.onlineAllowed;
  $("manualUrgent").checked = o.urgent;
}

function collectManualOrder(original = {}) {
  const grade = $("manualGrade").value;
  const subject = getSubjectList($("manualSubject").value).join("、");
  const previous = normalizeOrder(original);
  const title = previous.grade === grade && previous.subject === subject && original.title
    ? original.title : `${grade}${subject}家教`;
  return normalizeOrder({
    ...original,
    id: original.id || ($("manualId").value.trim().startsWith("#") ? $("manualId").value.trim() : `#${$("manualId").value.trim()}`),
    grade, subject, title,
    studentGender: $("manualStudentGender").value,
    teacherCount: Number($("manualTeacherCount").value),
    currentScores: $("manualScores").value.trim(),
    hoursPerSession: Number($("manualHours").value),
    address: $("manualAddress").value.trim(),
    publicAddress: $("manualAddress").value.trim(),
    mode: $("manualMode").value,
    weeklyFrequency: $("manualWeekly").value.trim(),
    salaryText: $("manualSalary").value.trim(),
    hourlyRate: 0,
    requirements: $("manualRequirements").value.trim(),
    trialTime: $("manualTrial").value.trim(),
    notes: $("manualNotes").value.trim(),
    onlineAllowed: $("manualOnline").checked,
    urgent: $("manualUrgent").checked,
    createdAt: original.createdAt || new Date().toISOString()
  });
}

// ---------------- 视图 4：安全管理员后台 ----------------
function renderAdminView() {
  const user = Store.getCurrentUser();
  const box = $("adminContainer");
  if (!user || user.role !== "admin") {
    box.innerHTML = `
      <div class="panel">
        <h2>🛡️ 管理员安全后台</h2>
        <p style="color:var(--muted);margin-bottom:12px;">该区域受权限保护，仅管理员账号可进入。</p>
        <button class="btn btn-primary" id="btnAdminLoginPrompt">使用管理员账号登录</button>
      </div>
    `;
    $("btnAdminLoginPrompt").onclick = () => openAuthModal("login");
    return;
  }

  const orders = Store.getOrders();

  box.innerHTML = `
    ${!Store.isCloudMode() ? `
      <div class="panel" style="border-color:#f59e0b;background:#fffbeb;">
        <strong>提示：尚未绑定 Cloudflare KV 云端存储</strong>
        <p style="font-size:13px;color:#92400e;margin-top:4px;">
          当前数据仅保存在本机浏览器。在 Cloudflare Pages 后台 <strong>Settings → Bindings → Add → KV Namespace</strong> 中绑定变量名 <code>TUTOR_KV</code> 并重新部署后，即可自动开启多人云端同步。
        </p>
      </div>
    ` : ""}

    <div class="panel">
      <h2>💼 其他兼职 · ${state.editingPartTimeId ? "修改信息" : "发布信息"}</h2>
      <p class="admin-helper">兼职单独显示在“其他兼职”页面，不会混入家教需求或选单清单。</p>
      <form id="partTimeForm" class="parttime-admin-form">
        <div class="field"><label for="partTimeTitle">兼职标题</label><input id="partTimeTitle" required maxlength="120" placeholder="例：天津高校活动志愿者" /></div>
        <div class="field"><label for="partTimeTime">时间</label><input id="partTimeTime" required maxlength="150" placeholder="例：周六 9:00～17:00" /></div>
        <div class="field"><label for="partTimeLocation">地点（公开信息）</label><input id="partTimeLocation" required maxlength="200" placeholder="例：天津市南开区某活动场馆" /></div>
        <div class="field full"><label for="partTimeContent">详细内容</label><textarea id="partTimeContent" required rows="4" maxlength="4000" placeholder="兼职工作内容、薪酬、要求及报名方式"></textarea></div>
        <div class="full admin-editor-actions"><button type="submit" class="btn btn-primary">${state.editingPartTimeId ? "保存兼职" : "发布兼职"}</button><button type="button" class="btn btn-sm" id="btnResetPartTime">清空</button></div>
      </form>
      <div class="parttime-admin-list">${Store.getPartTimePosts().map((post) => `
        <div class="parttime-admin-item"><span>${escapeHtml(post.title)} · ${escapeHtml(post.time)} · ${escapeHtml(post.location)}</span>
        <div><button class="btn btn-sm" data-edit-parttime="${escapeHtml(post.id)}">编辑</button><button class="btn btn-sm btn-danger" data-del-parttime="${escapeHtml(post.id)}">删除</button></div></div>
      `).join("")}</div>
    </div>

    <div class="panel">
      <h2>✍️ ${state.editingOrderId ? "编辑已有家教单" : "新增家教单"} <span class="chip">九字段标准模板</span></h2>
      <p class="admin-helper">家长微信可以直接粘贴到下方 AI 整理区；也可以手动填表。发布时自动优化公开地址表述，不会猜测未提供的小区或门牌。</p>
      <form id="manualOrderForm">
        <div class="admin-manual-grid">
          <div class="field"><label for="manualId">编号</label><input id="manualId" required value="${escapeHtml(state.editingOrderId || nextOrderId(orders))}" placeholder="#2992" /></div>
          <div class="field"><label for="manualGrade">年级</label><select id="manualGrade">${GRADES.map((g) => `<option>${g}</option>`).join("")}</select></div>
          <div class="field"><label for="manualStudentGender">学生性别</label><select id="manualStudentGender"><option value="待补充">待补充</option><option value="男生">男生</option><option value="女生">女生</option></select></div>
          <div class="field wide"><label for="manualSubject">补习科目</label><input id="manualSubject" required placeholder="数学、物理" /></div>
          <div class="field"><label for="manualTeacherCount">需要几个老师</label><input id="manualTeacherCount" type="number" min="1" max="20" value="1" required /></div>
          <div class="field wide"><label for="manualScores">现阶段成绩</label><input id="manualScores" placeholder="数学60分，物理70分；不知道可留空" /></div>
          <div class="field"><label for="manualHours">每次几小时</label><input id="manualHours" type="number" min="0.5" step="0.5" value="2" required /></div>
          <div class="field wide"><label for="manualAddress">补课地址（区＋小区）</label><input id="manualAddress" placeholder="天津市河西区某小区" /></div>
          <div class="field"><label for="manualMode">授课方式</label><select id="manualMode"><option>上门</option><option>线上</option><option>均可</option></select></div>
          <div class="field wide"><label for="manualWeekly">一周几次（周中/周末）</label><input id="manualWeekly" placeholder="每周1次，周六下午" /></div>
          <div class="field"><label for="manualSalary">薪资（元/小时）</label><input id="manualSalary" placeholder="110～120元/小时（可报价）" /></div>
          <div class="field full"><label for="manualRequirements">对老师要求</label><textarea id="manualRequirements" rows="2" placeholder="无特殊要求"></textarea></div>
          <div class="field wide"><label for="manualTrial">试课时间（可选）</label><input id="manualTrial" placeholder="仅填写家长明确提供的试课时间" /></div>
          <div class="field"><label for="manualNotes">其他说明（可选）</label><input id="manualNotes" placeholder="只写真实信息" /></div>
        </div>
        <div class="admin-editor-actions">
          <label class="chip"><input id="manualOnline" type="checkbox" style="width:auto;vertical-align:middle;" /> 可网课</label>
          <label class="chip"><input id="manualUrgent" type="checkbox" style="width:auto;vertical-align:middle;" /> 急招</label>
        </div>
        <div class="admin-editor-actions">
          <button class="btn btn-primary" type="submit" id="btnSaveManual">${state.editingOrderId ? "保存修改" : "发布新家教单"}</button>
          <button class="btn" type="button" id="btnResetManual">清空 / 新单</button>
          <button class="btn" type="button" id="btnCopyQuestionnaire">📋 复制家长问询模板</button>
        </div>
      </form>
    </div>

    <div class="panel">
      <h2>✨ AI 零散信息一键整理成家教单</h2>
      <p style="font-size:13px;color:var(--muted);margin-bottom:8px;">直接粘贴微信聊天、飞书表格复制内容或旧单（多条以空行分隔），AI 自动整理成九字段，先预览编辑，再确认发布：</p>
      <textarea id="rawOrderInput" rows="4" placeholder="示例：急招！南开区天大附近高二女生找数学老师，每周六上午2小时，160元一小时，要求985理工科有耐心，最好女老师"></textarea>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        <button class="btn btn-primary" id="btnParseOrders">🪄 AI 自动整理成单</button>
        <button class="btn" id="btnPublishDrafts" style="display:${state.parsedDraftOrders.length ? "inline-flex" : "none"};">✅ 确认发布全部（${state.parsedDraftOrders.length} 条）</button>
        <button class="btn btn-sm" id="btnCopyDrafts" style="display:${state.parsedDraftOrders.length ? "inline-flex" : "none"};">复制全部标准文案</button>
      </div>
      <div class="field" style="margin-top:12px;">
        <label for="csvImportInput">📄 从飞书导出的 CSV / TSV 批量导入（只生成草稿，不自动发布）</label>
        <input type="file" id="csvImportInput" accept=".csv,.tsv,.txt,text/csv,text/plain" />
      </div>
      <div id="parsedPreview" style="margin-top:12px;"></div>
    </div>

    <div class="panel">
      <h2>🤖 AI 实时修改 / 更新网站</h2>
      <p style="font-size:13px;color:var(--muted);margin-bottom:8px;">输入自然语言即可实时更新网站公告、主题配色或指定家教单价格与状态：</p>
      <div style="display:flex;gap:8px;">
        <input id="aiSiteCmd" placeholder="例如：把公告改成寒假特惠招募中，切换成温暖橙主题，把 JJ-2026-101 课时费改成 180 元" />
        <button class="btn btn-primary" id="btnRunSiteCmd" style="white-space:nowrap;">执行更新</button>
      </div>
      <p id="aiSiteReply" style="font-size:13px;color:var(--primary);margin-top:8px;"></p>
    </div>


    <div class="panel">
      <h2>📋 家教单管理（${orders.length} 条）</h2>
      <div class="admin-editor-actions"><button class="btn btn-sm" id="btnMergeSelected">合并选中的同学多科单</button></div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${orders.length ? orders.map((o) => `
          <div style="border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div>
              <label style="display:inline-flex;gap:8px;align-items:center;">
                <input type="checkbox" data-merge-id="${escapeHtml(o.id)}" style="width:auto;" aria-label="选中 ${escapeHtml(o.id)} 用于合并" />
                <strong>${escapeHtml(o.id)}</strong>
              </label>
              · ${escapeHtml(o.title)} <span class="chip">${escapeHtml(o.salaryText)}</span>
              <span class="chip">${escapeHtml(o.studentGender)}</span><span class="chip">${escapeHtml(o.status)}</span>
            </div>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-sm" data-edit-order="${escapeHtml(o.id)}">编辑</button>
              ${getSubjectList(o.subject).length > 1 ? `<button class="btn btn-sm" data-split-order="${escapeHtml(o.id)}">按科目拆单</button>` : ""}
              <button class="btn btn-sm" data-toggle-status="${o.id}">${o.status === "招募中" ? "设为已匹配" : "重新上架"}</button>
              <button class="btn btn-danger btn-sm" data-del-order="${o.id}">删除</button>
            </div>
          </div>
        `).join("") : '<p class="admin-helper">目前还没有真实家教单。请在上面填写表单或粘贴微信聊天整理。</p>'}
      </div>

    </div>
  `;

  if (state.editingPartTimeId) {
    const oldPartTime = Store.getPartTimePosts().find((post) => post.id === state.editingPartTimeId);
    if (oldPartTime) {
      $("partTimeTitle").value = oldPartTime.title;
      $("partTimeTime").value = oldPartTime.time;
      $("partTimeLocation").value = oldPartTime.location;
      $("partTimeContent").value = oldPartTime.content;
    }
  }
  $("partTimeForm").onsubmit = async (event) => {
    event.preventDefault();
    try {
      await Store.savePartTime({ id: state.editingPartTimeId, title: $("partTimeTitle").value.trim(),
        time: $("partTimeTime").value.trim(), location: $("partTimeLocation").value.trim(),
        content: $("partTimeContent").value.trim() });
      state.editingPartTimeId = null;
      renderAll();
      showToast("兼职信息已保存");
    } catch (err) { showToast(`保存失败：${err.message}`); }
  };
  $("btnResetPartTime").onclick = () => { state.editingPartTimeId = null; renderAdminView(); };
  box.querySelectorAll("[data-edit-parttime]").forEach((button) => {
    button.onclick = () => { state.editingPartTimeId = button.dataset.editParttime; renderAdminView(); $("partTimeForm").scrollIntoView({ behavior: "smooth" }); };
  });
  box.querySelectorAll("[data-del-parttime]").forEach((button) => {
    button.onclick = async () => {
      if (!confirm("确定删除这条兼职信息吗？")) return;
      try { await Store.deletePartTime(button.dataset.delParttime); state.editingPartTimeId = null; renderAdminView(); showToast("兼职已删除"); }
      catch (err) { showToast(`删除失败：${err.message}`); }
    };
  });

  if (state.editingOrderId) {
    const editing = orders.find((o) => o.id === state.editingOrderId);
    if (editing) fillManualOrder(editing);
  }

  $("manualOrderForm").onsubmit = async (event) => {
    event.preventDefault();
    const saveButton = $("btnSaveManual");
    const saveLabel = saveButton.textContent;
    saveButton.disabled = true;
    saveButton.textContent = "正在优化公开地址…";
    try {
      const old = orders.find((o) => o.id === state.editingOrderId);
      const [item] = await optimizeOrderAddressesWithAI([collectManualOrder(old || {})]);
      if (!item.subject || item.subject === "科目待补充") return showToast("请填写补习科目");
      if (old) await Store.updateOrder(old.id, item);
      else await Store.addOrders([item]);
      state.editingOrderId = null;
      renderAll();
      showToast(old ? "家教单已保存修改" : `家教单 ${item.id} 已发布`);
    } catch (err) { showToast(`保存失败：${err.message}`); }
    finally { saveButton.disabled = false; saveButton.textContent = saveLabel; }
  };
  $("btnResetManual").onclick = () => { state.editingOrderId = null; renderAdminView(); };
  $("btnCopyQuestionnaire").onclick = () => copyText([
    "【学生性别】", "【年级】", "【补习科目】", "【需要几个老师】",
    "【现阶段成绩（多少分）】", "【补课地址（区＋小区）】",
    "【一周几次（周中还是周末）】", "【每次几小时】",
    "【对老师要求】", "【薪资（元/小时）】", "【试课时间（如有）】"
  ].join("\n"), "已复制家长问询模板");

  renderParsedPreview();

  $("btnParseOrders").onclick = async () => {
    const raw = $("rawOrderInput").value.trim();
    if (!raw) return showToast("请先粘贴零散家教信息");
    showToast("正在整理家教单...");
    const res = await parseMessyOrders(raw, Store.getOrders());
    state.parsedDraftOrders = res.orders;
    renderAdminView();
    showToast(`解析完成（${res.source}），共识别 ${res.orders.length} 条`);
  };

  $("btnPublishDrafts").onclick = async () => {
    if (!state.parsedDraftOrders.length) return;
    const drafts = [...$("parsedPreview").querySelectorAll("[data-draft-text]")];
    const items = drafts.map((el) => parseFormattedOrder(el.value));
    if (items.some((o) => !o || !o.id)) return showToast("草稿字段不完整，请确认每条编号和九字段");
    const publishButton = $("btnPublishDrafts");
    const publishLabel = publishButton.textContent;
    publishButton.disabled = true;
    publishButton.textContent = "正在优化地址并发布…";
    try {
      await Store.addOrders(await optimizeOrderAddressesWithAI(items));
      const n = items.length;
      state.parsedDraftOrders = [];
      renderAll();
      showToast(`已发布 ${n} 条家教单到招募大厅`);
    } catch (err) { showToast(`发布失败：${err.message}`); }
    finally { publishButton.disabled = false; publishButton.textContent = publishLabel; }
  };
  $("btnCopyDrafts").onclick = () => copyText([...$("parsedPreview").querySelectorAll("[data-draft-text]")]
    .map((el) => el.value.trim()).join("\n\n"), "已复制全部草稿");
  $("csvImportInput").onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      state.parsedDraftOrders = importOrderTable(await file.text(), Store.getOrders());
      if (!state.parsedDraftOrders.length) throw new Error("文件中没有识别到有效家教单");
      renderAdminView();
      showToast(`已导入 ${state.parsedDraftOrders.length} 条草稿，请校对后发布`);
    } catch (err) { showToast(`导入失败：${err.message}`); }
  };

  $("btnRunSiteCmd").onclick = async () => {
    const cmd = $("aiSiteCmd").value.trim();
    if (!cmd) return;
    const res = await interpretSiteCommand(cmd, Store.getSiteConfig(), Store.getOrders());
    for (const act of res.actions || []) {
      if (act.type === "update_site") await Store.updateSiteConfig(act.patch);
      if (act.type === "update_order") await Store.updateOrder(act.id, act.patch);
    }
    applySiteConfig();
    renderAdminView();
    $("aiSiteReply").textContent = `${res.reply}（${res.source}）`;
  };

  box.querySelectorAll("[data-toggle-status]").forEach((btn) => {
    btn.onclick = async () => {
      const o = Store.getOrders().find((x) => x.id === btn.dataset.toggleStatus);
      if (!o) return;
      try {
        await Store.updateOrder(o.id, { status: o.status === "招募中" ? "已匹配" : "招募中" });
        renderAdminView();
      } catch (err) { showToast(`更新失败：${err.message}`); }
    };
  });
  box.querySelectorAll("[data-edit-order]").forEach((btn) => {
    btn.onclick = () => {
      state.editingOrderId = btn.dataset.editOrder;
      renderAdminView();
      $("manualOrderForm").scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });
  box.querySelectorAll("[data-split-order]").forEach((btn) => {
    btn.onclick = () => {
      const item = Store.getOrders().find((o) => o.id === btn.dataset.splitOrder);
      if (!item) return;
      state.parsedDraftOrders = splitOrderBySubject(item);
      renderAdminView();
      $("parsedPreview").scrollIntoView({ behavior: "smooth", block: "start" });
      showToast("已生成子编号草稿；发布后原单保留，可手动下架");
    };
  });
  $("btnMergeSelected").onclick = async () => {
    const ids = [...box.querySelectorAll("[data-merge-id]:checked")].map((el) => el.dataset.mergeId);
    if (ids.length < 2) return showToast("请至少选中两条需要合并的家教单");
    const chosen = Store.getOrders().filter((o) => ids.includes(o.id));
    if (new Set(chosen.map((o) => `${o.grade}|${o.address}|${o.studentGender}`)).size !== 1) {
      return showToast("只能合并同一学生的家教单（年级、地址及学生性别需一致）");
    }
    if (!confirm(`将 ${chosen.length} 条单合并到 ${chosen[0].id}，并删除其他选中单？操作不可撤销。`)) return;
    try {
      const merged = mergeOrders(chosen, chosen[0].id);
      await Store.updateOrder(merged.id, merged);
      for (const o of chosen.slice(1)) await Store.deleteOrder(o.id);
      renderAll();
      showToast("合并完成，已保留主编号");
    } catch (err) { renderAll(); showToast(`合并未完全完成，请检查订单：${err.message}`); }
  };
  box.querySelectorAll("[data-del-order]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(`确定删除家教单 ${btn.dataset.delOrder} 吗？此操作不能撤销。`)) return;
      try {
        await Store.deleteOrder(btn.dataset.delOrder);
        renderAll();
        showToast("已从云端删除该家教单");
      } catch (err) { showToast(`删除失败：${err.message}`); }
    };
  });
}

function renderParsedPreview() {
  const wrap = $("parsedPreview");
  if (!wrap) return;
  if (!state.parsedDraftOrders.length) { wrap.innerHTML = ""; return; }
  wrap.innerHTML = state.parsedDraftOrders.map((o, index) => `
    <div class="order-draft">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
        <strong>草稿 ${index + 1} · ${escapeHtml(o.id)}</strong>
        <div style="display:flex;gap:6px;">
          ${getSubjectList(o.subject).length > 1 ? `<button class="btn btn-sm" data-split-draft="${index}">拆成单科</button>` : ""}
          <button class="btn btn-sm" data-copy-draft="${index}">复制</button>
          <button class="btn btn-danger btn-sm" data-remove-draft="${index}">移除</button>
        </div>
      </div>
      <textarea data-draft-text="${index}" aria-label="可编辑的标准家教单草稿 ${index + 1}">${escapeHtml(formatOrderText(o))}</textarea>
      <p class="admin-helper">可直接修改上面的九字段文字，确认后才会写入云端。</p>
    </div>
  `).join("");
  const sync = () => {
    wrap.querySelectorAll("[data-draft-text]").forEach((el) => {
      const parsed = parseFormattedOrder(el.value);
      if (parsed) state.parsedDraftOrders[Number(el.dataset.draftText)] = parsed;
    });
  };
  wrap.querySelectorAll("[data-draft-text]").forEach((el) => { el.onchange = sync; });
  wrap.querySelectorAll("[data-copy-draft]").forEach((btn) => {
    btn.onclick = () => copyText(wrap.querySelector(`[data-draft-text="${btn.dataset.copyDraft}"]`).value, "已复制标准家教单");
  });
  wrap.querySelectorAll("[data-remove-draft]").forEach((btn) => {
    btn.onclick = () => {
      sync();
      state.parsedDraftOrders.splice(Number(btn.dataset.removeDraft), 1);
      renderAdminView();
    };
  });
  wrap.querySelectorAll("[data-split-draft]").forEach((btn) => {
    btn.onclick = () => {
      sync();
      const index = Number(btn.dataset.splitDraft);
      const split = splitOrderBySubject(state.parsedDraftOrders[index]);
      state.parsedDraftOrders.splice(index, 1, ...split);
      renderAdminView();
    };
  });
}

// ---------------- 弹窗与初始化 ----------------
function openAuthModal() {
  $("authModal").classList.add("open");
}

async function setMapOrigin(place) {
  // 高德地图服务返回 GCJ-02，Leaflet/OSM 使用 WGS84。GPS 和本地地标无需转换。
  const coords = place.gcj02 ? gcj02ToWgs84(place.lat, place.lng) : { lat: place.lat, lng: place.lng };
  if (!Number.isFinite(Number(coords.lat)) || !Number.isFinite(Number(coords.lng))) throw new Error("此地点没有可用坐标");
  const origin = { name: place.name, lat: Number(coords.lat), lng: Number(coords.lng), manuallyChosen: true };
  await Store.setOrigin(origin);
  $("mapSearchInput").value = origin.name;
  updateMapOrigin(origin);
  moveMapTo(origin.lat, origin.lng, 13);
  renderHall();
}

function hideMapCandidates() {
  mapSearchVersion++;
  mapCandidates = [];
  $("mapSearchSuggestions").replaceChildren();
  $("mapSearchSuggestions").hidden = true;
  $("mapSearchInput").setAttribute("aria-expanded", "false");
}

function showMapCandidates(candidates) {
  mapCandidates = candidates;
  const box = $("mapSearchSuggestions");
  box.replaceChildren();
  box.hidden = !candidates.length;
  $("mapSearchInput").setAttribute("aria-expanded", String(Boolean(candidates.length)));
  candidates.forEach((place) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "map-suggestion";
    button.setAttribute("role", "option");
    const name = document.createElement("strong");
    name.textContent = `📍 ${place.name}`;
    const detail = document.createElement("span");
    detail.textContent = [place.district, place.address].filter(Boolean).join(" · ") || "点击设为我的位置";
    button.append(name, detail);
    button.onclick = async () => {
      hideMapCandidates();
      await setMapOrigin(place);
      $("mapLocationNote").textContent = `已将「${place.name}」设为我的位置，红色标记与通勤估算已更新。紫色家教点仅来自公开地址。`;
      showToast(`位置已更新为「${place.name}」`);
    };
    box.append(button);
  });
}

function localMapCandidates(text) {
  const fromPresets = APP_CONFIG.presetLocations.filter((place) => place.name.includes(text));
  const fromDistricts = [...new Set(Store.getOrders().map((order) => canonicalDistrict(order.district)))]
    .filter((name) => name && name.includes(text))
    .map((name) => { const coords = inferCoordsFromText(name); return coords && { name, ...coords }; })
    .filter(Boolean);
  const matched = [...fromPresets, ...fromDistricts];
  const inferred = inferCoordsFromText(text);
  if (inferred && !matched.some((place) => place.name === text)) matched.push({ name: text, ...inferred });
  return matched.filter((place, i) => matched.findIndex((other) => other.name === place.name) === i).slice(0, 7);
}

async function suggestMapCandidates(text) {
  const version = ++mapSearchVersion;
  if (!text) { hideMapCandidates(); return; }
  const local = localMapCandidates(text);
  showMapCandidates(local);
  try {
    const res = await fetch(`${APP_CONFIG.apiBase}/commute`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "suggest", keywords: text }), signal: AbortSignal.timeout(5000)
    });
    const result = await res.json();
    if (version !== mapSearchVersion || $("mapSearchInput").value.trim() !== text) return;
    if (result.ok && Array.isArray(result.suggestions)) {
      const combined = [...result.suggestions, ...local];
      showMapCandidates(combined.filter((place, i) => combined.findIndex((other) => other.name === place.name && other.district === place.district) === i).slice(0, 10));
    }
  } catch { /* 高德不可用时，保留本地候选，不阻塞搜索 */ }
}

function locateMe(silent = false) {
  if (!navigator.geolocation) return silent ? null : showToast("当前浏览器不支持定位，请手动输入地址");
  if (!silent) showToast("正在请求定位权限…");
  const button = $("btnMapRelocate");
  if (!silent && button) { button.disabled = true; button.textContent = "◎ 定位中…"; }
  const finish = () => {
    if (!silent && button) { button.disabled = false; button.textContent = "◎ 重新定位当前位置"; }
  };
  navigator.geolocation.getCurrentPosition(async (position) => {
    try {
      const { latitude: lat, longitude: lng } = position.coords;
      // GPS 只在当前浏览器本地保存，不上传后台；地图订单仍只使用公开地址。
      await Store.setOrigin({ name: "我的当前位置", lat, lng, isGps: true });
      updateMapOrigin(Store.getOrigin());
      moveMapTo(lat, lng, 13);
      renderHall();
      if (!silent) showToast("定位成功，已重新计算大致路程");
    } catch { if (!silent) showToast("更新当前位置失败，请稍后重试"); }
    finally { finish(); }
  }, () => { finish(); if (!silent) showToast("定位未授权或不可用，可以手动输入地点"); },
  { enableHighAccuracy: false, timeout: 9000, maximumAge: 180000 });
}

async function openMap() {
  try {
    await openMapBoard(Store.getOrigin());
    updateMapOrders(visibleBoardOrders);
  } catch (error) { $("mapLocationNote").textContent = `${error.message}；仍可在上方输入地址计算估算路程。`; }
}

function setBoardLayout(layout) {
  if (layout !== "list" && layout !== "cards") return;
  state.layout = layout;
  try { localStorage.setItem(BOARD_LAYOUT_KEY, layout); } catch { /* private mode */ }
  renderHall();
}

function initControls() {
  try { if (localStorage.getItem(BOARD_LAYOUT_KEY) === "list") state.layout = "list"; } catch { /* private mode */ }
  setMapOrderSelectionHandlers((id) => {
    Store.toggleSelectedOrder(id);
    renderHall();
    showToast(Store.getSelectedOrderIds().includes(id) ? "已添加到选单" : "已从选单移除");
  }, (id) => Store.getSelectedOrderIds().includes(id));
  document.addEventListener("tutorhub-geocodes-updated", () => {
    if (state.view === "hall") renderHall();
  });
  SUBJECTS.forEach((s) => $("qSubject").insertAdjacentHTML("beforeend", `<option value="${s}">${s}</option>`));
  GRADES.forEach((g) => $("qGrade").insertAdjacentHTML("beforeend", `<option value="${g}">${g}</option>`));

  ["qSearch", "qSubject", "qGrade", "qMode", "qSort", "qStudentGender", "qTeacherGender", "qDistrict", "qTime", "qMinRate"].forEach((id) => {
    $(id).addEventListener("input", renderHall);
    $(id).addEventListener("change", renderHall);
  });
  $("btnClearFilters").onclick = () => {
    ["qSearch", "qSubject", "qGrade", "qMode", "qStudentGender", "qTeacherGender", "qDistrict", "qTime", "qMinRate"].forEach((id) => { $(id).value = ""; });
    $("qSort").value = "recommend";
    state.onlyOpen = false;
    state.onlySelected = false;
    $("onlyOpen").checked = false;
    $("onlySelected").checked = false;
    renderHall();
  };

  $("onlyOpen").onchange = (event) => {
    state.onlyOpen = event.target.checked;
    renderHall();
  };
  $("onlySelected").onchange = (event) => {
    state.onlySelected = event.target.checked;
    renderHall();
  };

  $("btnAdminEntry").onclick = () => switchView("admin");
  $("btnBackToHall").onclick = () => switchView("hall");
  $("btnViewTutoring").onclick = () => switchView("hall");
  $("btnViewPartTime").onclick = () => switchView("parttime");
  $("btnMobileTutoring").onclick = () => switchView("hall");
  $("btnMobileMore").onclick = () => switchView("parttime");
  $("btnMobileAdminEntry").onclick = () => switchView("admin");
  $("btnMobileAdminBack").onclick = () => switchView("hall");
  $("btnListMode").onclick = () => setBoardLayout("list");
  $("btnCardMode").onclick = () => setBoardLayout("cards");

  $("btnSmartSelect").onclick = () => {
    const candidates = sortBoardOrders(visibleBoardOrders.filter((order) => order.status !== "已匹配"), "recommend").slice(0, 5);
    if (!candidates.length) return showToast("当前筛选条件下没有可推荐的家教单");
    const previous = Store.getSelectedOrderIds();
    Store.setSelectedOrderIds([...previous, ...candidates.map((order) => order.id)]);
    renderHall();
    showToast(`已按筛选条件、时薪和估算路程智能勾选 ${candidates.length} 条，请核对后复制`);
  };
  $("btnMapRelocate").onclick = () => locateMe(false);
  $("btnMapSearch").onclick = async () => {
    const text = $("mapSearchInput").value.trim();
    if (!text) return showToast("请输入地点名称");
    if (mapCandidates.length && mapCandidates[0].name.includes(text)) {
      $("mapSearchSuggestions").querySelector(".map-suggestion")?.click();
      return;
    }
    $("btnMapSearch").disabled = true;
    $("btnMapSearch").textContent = "正在搜索…";
    try {
      const resolved = await resolveUserAddress(text);
      hideMapCandidates();
      await setMapOrigin(resolved);
      $("mapLocationNote").textContent = `已将「${text}」设为我的位置；地图上的红色标记和通勤估算已更新。`;
      showToast(`位置已更新为「${text}」`);
    } catch (err) { showToast(err.message); }
    finally { $("btnMapSearch").disabled = false; $("btnMapSearch").textContent = "📍 搜索位置"; }
  };
  $("mapSearchInput").addEventListener("input", () => {
    clearTimeout(mapSearchTimer);
    const value = $("mapSearchInput").value.trim();
    mapSearchVersion++;
    if (!value) return hideMapCandidates();
    showMapCandidates(localMapCandidates(value));
    mapSearchTimer = setTimeout(() => { void suggestMapCandidates(value); }, 260);
  });
  $("mapSearchInput").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hideMapCandidates(); return; }
    if (e.key === "ArrowDown" && mapCandidates.length) { e.preventDefault(); $("mapSearchSuggestions").querySelector("button")?.focus(); }
    if (e.key === "Enter") { e.preventDefault(); $("btnMapSearch").click(); }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".map-search-wrap") && !event.target.closest("#btnMapSearch")) hideMapCandidates();
  });

  $("btnOpenCart").onclick = () => { renderCart(); $("cartModal").classList.add("open"); };
  $("btnCloseCart").onclick = () => $("cartModal").classList.remove("open");
  $("cartModal").addEventListener("click", (event) => {
    if (event.target === $("cartModal")) $("cartModal").classList.remove("open");
  });
  $("btnCopyCart").onclick = async () => {
    const orders = getSelectedOrders();
    if (!orders.length) return showToast("请先挑选家教单");
    await copyText(buildWechatSelectionText(orders), `已复制 ${orders.length} 条家教单，请打开微信发送给小木同学`);
  };
  $("btnQuickCopy").onclick = () => $("btnCopyCart").click();
  $("btnClearCart").onclick = () => {
    Store.clearSelectedOrders();
    renderHall();
    showToast("选单清单已清空");
  };

  $("closeAuthModal").onclick = () => $("authModal").classList.remove("open");
  $("btnSubmitAuth").onclick = async () => {
    const email = $("authEmail").value.trim();
    const password = $("authPassword").value;
    if (!email || !password) return showToast("请输入邮箱和密码");

    const res = await Store.login(email, password);
    if (!res.ok) return showToast(res.error);
    if (res.user.role !== "admin") {
      Store.logout();
      return showToast("仅管理员可登录此后台");
    }
    $("authModal").classList.remove("open");
    renderAll();
    showToast(`欢迎回来，${res.user.name}`);
  };
}

function renderAll() {
  applySiteConfig();
  renderUserActions();
  switchView(state.view);
}

(async () => {
  initColorMode();
  initControls();
  await Store.init();
  renderAll();
  void openMap();
  if (!Store.getOrigin()?.manuallyChosen) locateMe(true);
})();
