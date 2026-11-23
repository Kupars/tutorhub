import { APP_CONFIG } from "./app-env.js";
import { SUBJECTS, GRADES } from "./data.js";
import { estimateCommuteLocal, inferCoordsFromText, resolveUserAddress } from "./commute.js?v=5";
import { gcj02ToWgs84, getPublicMapLocation, moveMapTo, openMapBoard, refreshMapSize, setMapOrderSelectionHandlers, updateMapOrders, updateMapOrigin } from "./map-board.js?v=9";
import { parseMessyOrders, interpretSiteCommand, optimizeOrderAddressesWithAI, recommendOrdersWithAI, probeAIProvider } from "./ai-engine.js?v=3";
import { Store } from "./store.js";
import { canonicalDistrict, formatOrderText, getSubjectList, mergeOrders, nextOrderId, normalizeOrder, parseFormattedOrder, splitOrderBySubject } from "./order-format.js";
import { importOrderTable } from "./order-import.js";
import { buildWechatSelectionText, isPubliclyOpenOrder, sortBoardOrders, teacherGenderRequirement } from "./board-utils.js?v=4";
import { cardCopyableAddress, cardSchedule, cardStudentGenderTag, cardTeacherGenderTag, cardTitleSegments } from "./card-presentation.js?v=6";
import { getSeasonForDate, SEASON_DETAILS } from "./season-theme.js";
import { findPotentialDuplicates, orderFreshness } from "./order-extras.js";
import { renderAssignmentAdmin, bindAssignmentAdmin } from "./admin-assignment-view.js?v=1";
import { missingDraftFields } from "./structured-order-extractor.js";

const state = {
  view: "hall",
  layout: "cards",
  onlySelected: false,
  parsedDraftOrders: [],
  editingOrderId: null,
  editingPartTimeId: null,
  adminQuery: "",
  adminStatus: "all",
  adminPageSize: 40
};
const adminCheckedOrders = new Set();
let visibleBoardOrders = [];
let expandedOrderId = null;
// 升级展示偏好版本：之前的默认列表偏好不影响新版默认卡片。
const BOARD_LAYOUT_KEY = "tutorhub_board_layout_v2";
const COLOR_MODE_KEY = "tutorhub_color_mode_v1";
const FILTERS_KEY = "tutorhub_filters_v1";
const PERSISTED_FILTER_IDS = ["qSearch", "qSubject", "qGrade", "qMode", "qSort", "qStudentGender", "qTeacherGender", "qDistrict", "qTime", "qMinRate", "aiPreference"];
let savedFilters = null;
let mapCandidates = [];
let mapSearchVersion = 0;
let mapSearchTimer = null;
let startupFinished = false;
let mapOpenScheduled = false;
let mapOpenPromise = null;
let cardResultsKey = "";
let shownCardCount = 24;
let cardLoadObserver = null;
const CARD_BATCH_SIZE = 24;

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

function saveFilters() {
  const values = Object.fromEntries(PERSISTED_FILTER_IDS.map((id) => [id, $(id)?.value || ""]));
  values.onlySelected = state.onlySelected;
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(values)); } catch { /* 无痕模式 */ }
}

function loadSavedFilters() {
  try { savedFilters = JSON.parse(localStorage.getItem(FILTERS_KEY) || "null"); } catch { savedFilters = null; }
  if (!savedFilters || typeof savedFilters !== "object") return;
  for (const id of PERSISTED_FILTER_IDS) {
    if (id === "qSubject" || id === "qDistrict") continue; // 必须等动态选项加载完毕。
    const el = $(id);
    if (el && typeof savedFilters[id] === "string" && [...(el.options || [])].some((o) => o.value === savedFilters[id])) el.value = savedFilters[id];
    else if (id === "qSearch" || id === "qMinRate") el.value = savedFilters[id] || "";
  }
  state.onlySelected = savedFilters.onlySelected === true;
  $("onlySelected").checked = state.onlySelected;
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
  if (viewName === "hall") {
    renderHall();
    if (startupFinished) scheduleMapOpen();
  }
  if (viewName === "parttime") renderPartTime();
  if (viewName === "admin") renderAdminView();
}

// ---------------- 视图 1：招募大厅 ----------------
function renderHall() {
  const subjectSelect = $("qSubject");
  const selectedSubject = subjectSelect.value || (savedFilters?.qSubject || "");
  const subjects = [...SUBJECTS, "作业辅导", "陪读", "道法"];
  subjectSelect.innerHTML = '<option value="">科目</option>' +
    subjects.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  subjectSelect.value = subjects.includes(selectedSubject) ? selectedSubject : "";
  const districtSelect = $("qDistrict");
  const selectedDistrict = districtSelect.value || (savedFilters?.qDistrict || "");
  const districts = [...new Set(Store.getOrders().filter(isPubliclyOpenOrder).map((o) => canonicalDistrict(o.district)).filter((d) => d && d !== "区域待补充"))].sort();
  districtSelect.innerHTML = '<option value="">区域</option>' +
    districts.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  districtSelect.value = districts.includes(selectedDistrict) ? selectedDistrict : "";
  savedFilters = null;
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
    if (!isPubliclyOpenOrder(o)) return false;
    if (state.onlySelected && !o.selected) return false;
    if (subject && o.subject !== subject && !getSubjectList(o.subject).includes(subject) && !o.subject.includes(subject)) return false;
    if (grade && o.grade !== grade && !o.grade.includes(grade) && !(grade === "小学" && /[一二三四五六1-6]年级/.test(o.grade))) return false;
    if (mode && o.mode !== mode) return false;
    if (studentGender && o.studentGender !== studentGender) return false;
    const teacherPref = teacherGenderRequirement(o);
    if (teacherGender === "不限" && teacherPref !== "不限") return false;
    if (["男生", "女生"].includes(teacherGender) && teacherPref !== teacherGender) return false;
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

  const onSiteLocations = items.filter((order) => order.mode !== "线上")
    .map((order) => getPublicMapLocation(order));
  const approximate = onSiteLocations.filter((place) => place?.fallback).length;
  const unresolved = onSiteLocations.filter((place) => !place).length;
  const mapVerificationNote = $("mapVerificationNote");
  if (mapVerificationNote) {
    mapVerificationNote.hidden = approximate === 0 && unresolved === 0;
    mapVerificationNote.textContent = [
      approximate ? `${approximate} 条家教单尚未核实到具体地点，已标在镇/区中心（橙色示意点，非实际授课位置）。` : "",
      unresolved ? `${unresolved} 条家教单因缺少可确定的行政区，暂时无法绘制标记。` : "",
      approximate ? "这类位置不参与精确通勤时间估算。" : ""
    ].filter(Boolean).join(" ");
  }

  $("resultStats").textContent = `共匹配 ${items.length} 条家教单（当前出发地址：${origin.name}）`;
  const advancedIds = ["qSubject", "qGrade", "qMode", "qStudentGender", "qTeacherGender", "qDistrict", "qTime", "qMinRate"];
  const activeCount = advancedIds.filter((id) => $(id).value).length + Number(state.onlySelected);
  $("activeFilterCount").textContent = activeCount ? ` · 已选 ${activeCount} 项` : "";
  $("quickFilterCount").textContent = activeCount ? String(activeCount) : "";
  $("btnListMode").classList.toggle("active", state.layout === "list");
  $("btnCardMode").classList.toggle("active", state.layout === "cards");
  $("btnListMode").setAttribute("aria-pressed", String(state.layout === "list"));
  $("btnCardMode").setAttribute("aria-pressed", String(state.layout === "cards"));
  renderCart();

  const grid = $("ordersGrid");
  cardLoadObserver?.disconnect();
  cardLoadObserver = null;
  grid.classList.toggle("is-list-mode", state.layout === "list");
  if (items.length === 0) {
    const hasOpenOrders = Store.getOrders().some(isPubliclyOpenOrder);
    grid.innerHTML = `<div class="panel" style="grid-column:1/-1;text-align:center;color:var(--muted);">${hasOpenOrders ? "没有符合条件的家教单，试试放宽筛选条件吧。" : "目前暂无正在招募的家教单，可以稍后再来看看。"} </div>`;
    return;
  }

  const renderDetailCard = (o) => {
    const schedule = cardSchedule(o);
    const studentTag = cardStudentGenderTag(o);
    const teacherTag = cardTeacherGenderTag(o);
    const addressToCopy = cardCopyableAddress(o);
    const title = cardTitleSegments(o.title, o.subject);
    const freshness = orderFreshness(o);
    const titleHtml = `${escapeHtml(title.before)}${title.subject ? `<span class="card-subject">${escapeHtml(title.subject)}</span>` : ""}${escapeHtml(title.after)}`;
    const displayDistrict = o.district === "线上" ? "线上" : canonicalDistrict(o.district) || "地点待补充";
    const commuteHtml = o.commute
      ? o.commute.isOnline
        ? `<span class="chip commute">💻 线上免通勤</span>`
        : `<span class="chip commute">路程约：骑行 ${o.commute.bikeMin} 分 / 公交 ${o.commute.transitMin} 分</span>`
      : "";
    return `
      <article class="order-card ${o.selected ? "order-selected" : ""}">
        <div class="card-head">
          <div>
            <div class="order-number">${escapeHtml(o.orderNumber || o.id)}</div>
            <div class="card-title"><span class="card-district">${escapeHtml(displayDistrict)}</span><span class="card-title-text">${titleHtml}</span></div>
          </div>
          <div class="price-badge">${escapeHtml((o.salaryText || "老师报价").replace("（可报价）", ""))}</div>
        </div>

        <div class="meta-row">
          ${o.urgent ? `<span class="chip urgent">🔥 急招</span>` : ""}
          ${o.onlineAllowed ? '<span class="chip">💻 可网课</span>' : ""}
          ${freshness ? `<span class="chip card-freshness">${escapeHtml(freshness)}</span>` : ""}
          <span class="chip duration-chip">⏱ 每次${escapeHtml(schedule.duration)}</span>
          ${studentTag ? `<span class="chip student-gender-chip">${escapeHtml(studentTag)}</span>` : ""}
          ${teacherTag ? `<span class="chip teacher-gender-chip">${escapeHtml(teacherTag)}</span>` : ""}
          ${commuteHtml}
        </div>

        <div class="schedule-summary" aria-label="家教上课频率和上课日期">
          <div class="schedule-metric"><span class="schedule-metric-label">↻ 上课频率</span><strong>${escapeHtml(schedule.frequency)}</strong></div>
          <div class="schedule-metric schedule-metric-date" title="${escapeHtml(schedule.original)}"><span class="schedule-metric-label">🗓 上课日期</span><strong>${escapeHtml(schedule.dayLabel || "日期待协商")}</strong></div>
        </div>

        <div class="card-desc">
          <div><strong>成绩：</strong>${escapeHtml(o.currentScores)}</div>
          ${Number(o.teacherCount) > 1 ? `<div class="teacher-count-row"><strong>需要老师：</strong>${Number(o.teacherCount)}位</div>` : ""}
          ${o.trialTime ? `<div><strong>试课：</strong>${escapeHtml(o.trialTime)}</div>` : ""}
          ${o.studentInfo ? `<div><strong>补充：</strong>${escapeHtml(o.studentInfo)}</div>` : ""}
          <div><strong>要求：</strong>${escapeHtml(o.requirements)}</div>
        </div>

        <div class="card-location-row">
          <div class="card-location"><span class="card-location-icon" aria-hidden="true">📍</span><span class="card-location-text">${escapeHtml(o.publicAddress || o.address || "公开地址待补充")}</span></div>
          ${addressToCopy ? `<button type="button" class="btn btn-sm btn-copy-address" data-copy-address="${escapeHtml(o.id)}">复制地址</button>` : ""}
        </div>
        <div class="card-foot">
          <button type="button" class="btn btn-sm" data-copy="${escapeHtml(o.id)}">📋 复制整单</button>
          <button type="button" class="order-check ${o.selected ? "is-selected" : ""}" data-select="${escapeHtml(o.id)}" aria-pressed="${o.selected}"><span class="order-check-emoji" aria-hidden="true">${o.selected ? "✅" : "🛒"}</span><span>${o.selected ? "已加入选单" : "加入选单"}</span></button>
        </div>
      </article>
    `;
  };

  const nextResultsKey = `${state.layout}|${items.map((o) => o.id).join("|")}`;
  if (cardResultsKey !== nextResultsKey) {
    cardResultsKey = nextResultsKey;
    shownCardCount = CARD_BATCH_SIZE;
  }
  if (state.layout === "cards") {
    grid.innerHTML = items.slice(0, shownCardCount).map(renderDetailCard).join("");
    if (shownCardCount < items.length) {
      grid.insertAdjacentHTML("beforeend", `<div class="load-more-orders" id="loadMoreOrders"><button class="btn btn-sm" type="button" id="btnLoadMoreOrders">加载更多家教单 · 还剩 ${items.length - shownCardCount} 条</button></div>`);
      const loadMore = $("loadMoreOrders");
      const appendNextBatch = () => {
        if (!loadMore.isConnected) return;
        cardLoadObserver?.disconnect();
        cardLoadObserver = null;
        const nextCount = Math.min(items.length, shownCardCount + CARD_BATCH_SIZE);
        loadMore.insertAdjacentHTML("beforebegin", items.slice(shownCardCount, nextCount).map(renderDetailCard).join(""));
        shownCardCount = nextCount;
        if (nextCount >= items.length) loadMore.remove();
        else {
          $("btnLoadMoreOrders").textContent = `加载更多家教单 · 还剩 ${items.length - nextCount} 条`;
          observeLoadMore();
        }
      };
      const observeLoadMore = () => {
        if (!window.IntersectionObserver) return;
        cardLoadObserver = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) appendNextBatch();
        }, { rootMargin: "400px 0px" });
        cardLoadObserver.observe(loadMore);
      };
      $("btnLoadMoreOrders").onclick = appendNextBatch;
      observeLoadMore();
    }
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

  // 事件委托：滚动新增的卡片无需重复绑定监听器。
  grid.onclick = (event) => {
    const selectionButton = event.target.closest("[data-select]");
    if (selectionButton) {
      Store.toggleSelectedOrder(selectionButton.dataset.select);
      renderHall();
      showToast(Store.getSelectedOrderIds().includes(selectionButton.dataset.select) ? "已加入选单" : "已移出选单");
      return;
    }
    const button = event.target.closest("[data-expand-order]");
    if (button) {
      expandedOrderId = expandedOrderId === button.dataset.expandOrder ? null : button.dataset.expandOrder;
      renderHall();
      return;
    }
    const copyButton = event.target.closest("[data-copy]");
    if (copyButton) {
      const order = Store.getOrders().find((item) => item.id === copyButton.dataset.copy);
      if (order) copyText(formatOrderText(order), "已复制标准九字段家教单");
      return;
    }
    const addressButton = event.target.closest("[data-copy-address]");
    if (addressButton) {
      const order = Store.getOrders().find((item) => item.id === addressButton.dataset.copyAddress);
      const address = order && cardCopyableAddress(order);
      if (address) copyText(address, "已复制公开地址，可粘贴到地图导航软件");
      else showToast("这条家教单暂无可导航的线下地址");
    }
  };
}

function getSelectedOrders() {
  const byId = new Map(Store.getOrders().filter(isPubliclyOpenOrder).map((order) => [order.id, order]));
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
  `).join("") : `<div class="cart-empty">清单还是空的。回到看板，点击家教卡片上的「🛒 加入选单」就可以开始挑选。</div>`;
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
function confirmDuplicateRisks(incoming, excludingIds = []) {
  const existing = Store.getOrders().filter((o) => !excludingIds.includes(o.id));
  const matches = findPotentialDuplicates(incoming, existing);
  const withinBatch = findPotentialDuplicates(incoming, incoming).filter((pair) => pair.incoming !== pair.existing);
  const duplicates = [...matches, ...withinBatch];
  if (!duplicates.length) return true;
  const sameInternalId = duplicates.find((item) => item.reason === "内部编号相同");
  if (sameInternalId) {
    showToast(`编号 ${sameInternalId.incoming.id} 已存在，请先修改草稿编号`);
    return false;
  }
  const overview = duplicates.slice(0, 5).map((pair) =>
    `${pair.incoming.orderNumber || pair.incoming.id} ↔ ${pair.existing.orderNumber || pair.existing.id}：${pair.reason}`).join("\n");
  return confirm(`发现 ${duplicates.length} 组可能重复的家教单：\n${overview}\n\n同地点可能是不同学生。请先核对家长需求，确认不是重复发布再继续。`);
}

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
  const addressQueue = orders.filter((o) => o.mode !== "线上" && (!getPublicMapLocation(o) || getPublicMapLocation(o)?.fallback));
  const search = state.adminQuery.toLowerCase().trim();
  const adminFilteredOrders = orders.filter((o) => {
    if (state.adminStatus === "open" && !isPubliclyOpenOrder(o)) return false;
    if (state.adminStatus === "closed" && isPubliclyOpenOrder(o)) return false;
    if (state.adminStatus === "address" && !addressQueue.some((item) => item.id === o.id)) return false;
    if (!search) return true;
    return [o.id, o.orderNumber, o.title, o.grade, o.subject, o.district, o.publicAddress, o.address, o.requirements]
      .some((value) => String(value || "").toLowerCase().includes(search));
  });
  const adminShownOrders = adminFilteredOrders.slice(0, state.adminPageSize);

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
          <div class="field"><label for="manualId">编号</label><input id="manualId" required value="${escapeHtml(state.editingOrderId || nextOrderId([...orders, { orderNumber: `#${Store.getOrderSequence()}` }]))}" placeholder="#2992" /></div>
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
      <h2>🤖 AI 辅助修改（管理员确认后执行）</h2>
      <p style="font-size:13px;color:var(--muted);margin-bottom:8px;">当前仅支持公告、主题和指定家教单的时薪／状态。不能直接修改网页代码，也不允许 AI 自动执行操作：</p>
      <div style="display:flex;gap:8px;">
        <input id="aiSiteCmd" placeholder="例如：把公告改成寒假特惠招募中，切换成温暖橙主题，把 JJ-2026-101 课时费改成 180 元" />
        <button class="btn btn-primary" id="btnRunSiteCmd" style="white-space:nowrap;">执行更新</button>
      </div>
      <div class="admin-editor-actions"><button class="btn btn-sm" id="btnProbeAI" type="button">检测 AI 接口是否接通</button><span class="admin-helper" id="aiProbeResult">更换模型可在 Cloudflare 环境变量设置 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL，密钥不放网页。</span></div>
      <p id="aiSiteReply" style="font-size:13px;color:var(--primary);margin-top:8px;"></p>
    </div>


    ${renderAssignmentAdmin(orders, Store.getAssignments(), Store.isCloudMode())}

    <div class="panel">
      <h2>📋 家教单管理（展示中 ${orders.filter(isPubliclyOpenOrder).length} 条 · 已关闭 ${orders.filter((o) => !isPubliclyOpenOrder(o)).length} 条）</h2>
      <p class="admin-helper">点击“关闭展示”后，老师端看板、筛选和地图都不再显示该单；数据保留在后台，可以随时重新上架。</p>
      <div class="admin-bulk-toolbar">
        <input id="adminOrderSearch" type="search" aria-label="搜索后台家教单" placeholder="搜索单号 / 小区 / 科目 / 要求" value="${escapeHtml(state.adminQuery)}" />
        <select id="adminOrderStatus" aria-label="按状态筛选后台家教单">
          <option value="all" ${state.adminStatus === "all" ? "selected" : ""}>全部（${orders.length}）</option>
          <option value="open" ${state.adminStatus === "open" ? "selected" : ""}>展示中（${orders.filter(isPubliclyOpenOrder).length}）</option>
          <option value="closed" ${state.adminStatus === "closed" ? "selected" : ""}>已关闭（${orders.filter((o) => !isPubliclyOpenOrder(o)).length}）</option>
          <option value="address" ${state.adminStatus === "address" ? "selected" : ""}>地址待核验（${addressQueue.length}）</option>
        </select>
        <button class="btn btn-sm" type="button" id="btnAdminSelectPage">选中本页</button>
        <button class="btn btn-sm" type="button" id="btnAdminClearSelected">取消选中</button>
      </div>
      <div class="admin-bulk-toolbar">
        <span id="adminSelectedCount">已选择 ${adminCheckedOrders.size} 条 · 当前筛选 ${adminFilteredOrders.length} 条</span>
        <button class="btn btn-sm" id="btnAdminBatchClose" type="button">批量关闭展示</button>
        <button class="btn btn-sm" id="btnAdminBatchOpen" type="button">批量重新上架</button>
        <button class="btn btn-sm" id="btnMergeSelected" type="button">合并选中的同学多科单</button>
      </div>
      ${state.adminStatus === "address" ? `<p class="admin-helper">这些单只有区/镇中心示意点或无法定位，不能当作已核验小区。请点“核对地址”，对照家长确认的信息修改公开地点；没有更具体信息的继续留在区/镇中心即可。</p>` : ""}
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${adminShownOrders.length ? adminShownOrders.map((o) => `
          <div style="border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div>
              <label style="display:inline-flex;gap:8px;align-items:center;">
                <input type="checkbox" data-merge-id="${escapeHtml(o.id)}" ${adminCheckedOrders.has(o.id) ? "checked" : ""} style="width:auto;" aria-label="选中 ${escapeHtml(o.id)} 用于批量管理" />
                <strong>${escapeHtml(o.id)}</strong>
              </label>
              · ${escapeHtml(o.title)} <span class="chip">${escapeHtml(o.salaryText)}</span>
              <span class="chip">${escapeHtml(o.studentGender)}</span><span class="chip">${escapeHtml(o.status)}</span>
              ${addressQueue.some((item) => item.id === o.id) ? `<span class="chip">📍 区/镇中心示意</span><small style="display:block;color:var(--muted)">公开地点：${escapeHtml(o.publicAddress || o.address || o.district || "未提供")}</small>` : ""}
            </div>
            <div style="display:flex;gap:6px;">
              <button class="btn btn-sm" data-edit-order="${escapeHtml(o.id)}">编辑</button>
              <button class="btn btn-sm" data-open-assignment="${escapeHtml(o.id)}">登记老师</button>
              ${addressQueue.some((item) => item.id === o.id) ? `<button class="btn btn-sm" data-fix-address="${escapeHtml(o.id)}">核对地址</button>` : ""}
              ${getSubjectList(o.subject).length > 1 ? `<button class="btn btn-sm" data-split-order="${escapeHtml(o.id)}">按科目拆单</button>` : ""}
              <button class="btn btn-sm" data-toggle-status="${escapeHtml(o.id)}">${isPubliclyOpenOrder(o) ? "关闭展示" : "重新上架"}</button>
              <button class="btn btn-danger btn-sm" data-del-order="${o.id}">删除</button>
            </div>
          </div>
        `).join("") : '<p class="admin-helper">当前筛选条件下没有家教单。</p>'}
      </div>
      ${adminFilteredOrders.length > adminShownOrders.length ? `<div class="admin-editor-actions"><button class="btn btn-sm" id="btnAdminLoadMore">再显示 ${Math.min(40, adminFilteredOrders.length - adminShownOrders.length)} 条（剩余 ${adminFilteredOrders.length - adminShownOrders.length} 条）</button></div>` : ""}

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
      if (!confirmDuplicateRisks([item], old ? [old.id] : [])) return;
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
    const res = await parseMessyOrders(raw, [...Store.getOrders(), { orderNumber: `#${Store.getOrderSequence()}` }]);
    state.parsedDraftOrders = res.orders;
    renderAdminView();
    showToast(`解析完成（${res.source}），共识别 ${res.orders.length} 条`);
  };

  $("btnPublishDrafts").onclick = async () => {
    if (!state.parsedDraftOrders.length) return;
    const drafts = [...$("parsedPreview").querySelectorAll("[data-draft-text]")];
    const items = drafts.map((el) => parseFormattedOrder(el.value));
    if (items.some((o) => !o || !o.id)) return showToast("草稿字段不完整，请确认每条编号和九字段");
    if (!confirmDuplicateRisks(items)) return;
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
      state.parsedDraftOrders = importOrderTable(await file.text(), [...Store.getOrders(), { orderNumber: `#${Store.getOrderSequence()}` }]);
      if (!state.parsedDraftOrders.length) throw new Error("文件中没有识别到有效家教单");
      renderAdminView();
      showToast(`已导入 ${state.parsedDraftOrders.length} 条草稿，请校对后发布`);
    } catch (err) { showToast(`导入失败：${err.message}`); }
  };


  $("btnProbeAI").onclick = async () => {
    const button = $("btnProbeAI");
    button.disabled = true;
    $("aiProbeResult").textContent = "正在向已配置的真实模型发送测试请求…";
    try {
      const result = await probeAIProvider();
      $("aiProbeResult").textContent = result.ok
        ? `✅ 模型调用成功：${result.provider}。这是实际接口测试，不是内置规则引擎。`
        : `⚠️ 模型未通过检测：${result.error}。当前仍可使用保守的规则提取。`;
    } catch (error) { $("aiProbeResult").textContent = `模型检测出错：${error.message}`; }
    finally { button.disabled = false; }
  };
  $("btnRunSiteCmd").onclick = async () => {
    const cmd = $("aiSiteCmd").value.trim();
    if (!cmd) return;
    const button = $("btnRunSiteCmd");
    button.disabled = true;
    let reply = "";
    try {
      const res = await interpretSiteCommand(cmd, Store.getSiteConfig(), Store.getOrders());
      const actions = res.actions || [];
      if (!actions.length) { $("aiSiteReply").textContent = `${res.reply}（${res.source}）`; return; }
      const preview = actions.map((a) => {
        if (a.type === "update_site") return `网站设置：${JSON.stringify(a.patch)}`;
        const matched = Store.getOrders().find((o) => o.id === a.id);
        return `家教单 ${matched?.orderNumber || a.id}：${JSON.stringify(a.patch)}`;
      }).join("\\n");
      if (!confirm(`模型仅提出以下操作（${res.source}），尚未执行：\\n\\n${preview}\\n\\n确认执行吗？`)) {
        $("aiSiteReply").textContent = "已取消，本次没有修改网站。"; return;
      }
      let done = 0;
      for (const action of actions) {
        if (action.type === "update_site") await Store.updateSiteConfig(action.patch);
        else if (action.type === "update_order") await Store.updateOrder(action.id, action.patch);
        done++;
      }
      reply = `✅ 已执行 ${done} 项已确认操作。其余网站代码修改仍需通过 GitHub 更新。`;
      applySiteConfig();
      renderAdminView();
      $("aiSiteReply").textContent = reply;
    } catch (error) { showToast(`执行失败：${error.message}`); $("aiSiteReply").textContent = `执行失败，请检查后台数据：${error.message}`; }
    finally { button.disabled = false; }
  };

  $("adminOrderSearch").oninput = (event) => {
    const cursor = event.target.selectionStart;
    state.adminQuery = event.target.value;
    state.adminPageSize = 40;
    renderAdminView();
    $("adminOrderSearch").focus();
    $("adminOrderSearch").setSelectionRange(cursor, cursor);
  };
  $("adminOrderStatus").onchange = (event) => {
    state.adminStatus = event.target.value;
    state.adminPageSize = 40;
    renderAdminView();
  };
  box.querySelectorAll("[data-merge-id]").forEach((input) => {
    input.onchange = () => {
      if (input.checked) adminCheckedOrders.add(input.dataset.mergeId);
      else adminCheckedOrders.delete(input.dataset.mergeId);
      $("adminSelectedCount").textContent = `已选择 ${adminCheckedOrders.size} 条 · 当前筛选 ${adminFilteredOrders.length} 条`;
    };
  });
  $("btnAdminSelectPage").onclick = () => {
    adminShownOrders.forEach((o) => adminCheckedOrders.add(o.id));
    renderAdminView();
  };
  $("btnAdminClearSelected").onclick = () => { adminCheckedOrders.clear(); renderAdminView(); };
  if ($("btnAdminLoadMore")) $("btnAdminLoadMore").onclick = () => {
    state.adminPageSize += 40;
    renderAdminView();
  };
  const batchChangeStatus = async (status) => {
    const items = Store.getOrders().filter((o) => adminCheckedOrders.has(o.id) &&
      (status === "招募中" ? !isPubliclyOpenOrder(o) : isPubliclyOpenOrder(o)));
    if (!items.length) return showToast("请先选中需要变更状态的家教单");
    if (items.length > 100) return showToast("每次最多批量处理100条，请分批选择");
    if (!confirm(`确定将 ${items.length} 条家教单${status === "招募中" ? "重新上架" : "关闭展示"}吗？此操作可在后台恢复。`)) return;
    $("btnAdminBatchClose").disabled = $("btnAdminBatchOpen").disabled = true;
    try {
      await Store.batchUpdateOrderStatus(items.map((o) => o.id), status);
      adminCheckedOrders.clear();
      renderAll();
      showToast(`已批量${status === "招募中" ? "上架" : "关闭"} ${items.length} 条家教单`);
    } catch (err) { showToast(`批量操作失败：${err.message}`); }
    finally {
      if ($("btnAdminBatchClose")) $("btnAdminBatchClose").disabled = false;
      if ($("btnAdminBatchOpen")) $("btnAdminBatchOpen").disabled = false;
    }
  };
  $("btnAdminBatchClose").onclick = () => batchChangeStatus("已匹配");
  $("btnAdminBatchOpen").onclick = () => batchChangeStatus("招募中");
  box.querySelectorAll("[data-fix-address]").forEach((btn) => {
    btn.onclick = () => {
      state.editingOrderId = btn.dataset.fixAddress;
      renderAdminView();
      $("manualAddress").focus();
      $("manualAddress").scrollIntoView({ behavior: "smooth", block: "center" });
      showToast("请依据家长提供的真实公开地点核对；不确定时保留区/镇中心示意");
    };
  });

  box.querySelectorAll("[data-toggle-status]").forEach((btn) => {
    btn.onclick = async () => {
      const o = Store.getOrders().find((x) => x.id === btn.dataset.toggleStatus);
      if (!o) return;
      try {
        await Store.updateOrder(o.id, { status: isPubliclyOpenOrder(o) ? "已匹配" : "招募中" });
        renderAdminView();
        showToast(isPubliclyOpenOrder(o) ? "已关闭展示，老师端和地图将不再显示此单" : "已重新上架");
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
    const ids = [...adminCheckedOrders];
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
      adminCheckedOrders.clear();
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
  bindAssignmentAdmin(box, Store, renderAll, showToast);
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
      ${missingDraftFields(o).length ? `<p class="admin-helper" style="color:#a65d07">需要向家长核实：${escapeHtml(missingDraftFields(o).join("、"))}。默认格式不代表家长已确认。</p>` : ""}
      ${findPotentialDuplicates([o], Store.getOrders()).length
        ? `<p class="admin-helper" style="color:#a65d07">⚠️ 可能与已有单重复：${escapeHtml(findPotentialDuplicates([o], Store.getOrders()).slice(0, 3).map((item) => item.existing.orderNumber || item.existing.id).join("、"))}；发布前请核对。</p>`
        : ""}
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
      moveMapTo(lat, lng, silent ? (window.matchMedia?.("(max-width: 640px)").matches ? 10 : 11) : 13);
      renderHall();
      if (!silent) showToast("定位成功，已重新计算大致路程");
    } catch { if (!silent) showToast("更新当前位置失败，请稍后重试"); }
    finally { finish(); }
  }, () => { finish(); if (!silent) showToast("定位未授权或不可用，可以手动输入地点"); },
  { enableHighAccuracy: false, timeout: 9000, maximumAge: 180000 });
}

function scheduleMapOpen() {
  if (mapOpenScheduled) return;
  mapOpenScheduled = true;
  // 手机先保证首批卡片可交互，再在浏览器空闲时加载地图，避免 Leaflet 与首屏渲染抢主线程。
  const launch = () => {
    mapOpenScheduled = false;
    if (state.view === "hall") void openMap();
  };
  requestAnimationFrame(() => {
    if ("requestIdleCallback" in window) window.requestIdleCallback(launch, { timeout: 1800 });
    else setTimeout(launch, 400);
  });
}

function openMap() {
  if (mapOpenPromise) return mapOpenPromise;
  const loadingNote = $("mapLoadingNote");
  const retryButton = $("btnRetryMap");
  if (!loadingNote.hidden) {
    loadingNote.firstChild.textContent = "🗺 地图正在单独加载，家教单已经可以浏览…";
    retryButton.hidden = true;
  }
  mapOpenPromise = (async () => {
    try {
      await openMapBoard(Store.getOrigin());
      updateMapOrders(visibleBoardOrders);
      loadingNote.hidden = true;
      return true;
    } catch (error) {
      $("mapLocationNote").textContent = `${error.message}；家教单和筛选仍可正常使用。`;
      loadingNote.firstChild.textContent = "地图暂时未能加载，家教卡片不受影响。";
      retryButton.hidden = false;
      return false;
    } finally {
      mapOpenPromise = null;
    }
  })();
  return mapOpenPromise;
}

function updateStartupLoading(message) {
  $("startupLoadingDetail").textContent = message;
}

function completeStartupLoading() {
  $("startupLoading").hidden = true;
}

function setBoardLayout(layout) {
  if (layout !== "list" && layout !== "cards") return;
  state.layout = layout;
  try { localStorage.setItem(BOARD_LAYOUT_KEY, layout); } catch { /* private mode */ }
  renderHall();
}

function setAdvancedFiltersOpen(open) {
  $("advancedFilters").hidden = !open;
  $("btnToggleFilters").setAttribute("aria-expanded", String(open));
}

function initFloatingWechat(dialog) {
  const button = $("btnFloatingWechat");
  let start = null;
  let ignoreClick = false;
  button.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const rect = button.getBoundingClientRect();
    start = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, top: rect.top, width: rect.width, height: rect.height, moved: false };
    button.setPointerCapture?.(event.pointerId);
  });
  button.addEventListener("pointermove", (event) => {
    if (!start || start.pointerId !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 6) return;
    start.moved = true;
    const bottomInset = window.matchMedia?.("(max-width: 640px)").matches ? 84 : 12;
    const left = Math.max(8, Math.min(window.innerWidth - start.width - 8, start.left + dx));
    const top = Math.max(8, Math.min(window.innerHeight - start.height - bottomInset, start.top + dy));
    Object.assign(button.style, { left: `${left}px`, top: `${top}px`, right: "auto", bottom: "auto" });
  });
  const finishDrag = (event) => {
    if (!start || start.pointerId !== event.pointerId) return;
    if (start.moved) {
      ignoreClick = true;
      setTimeout(() => { ignoreClick = false; }, 0);
    }
    start = null;
  };
  button.addEventListener("pointerup", finishDrag);
  button.addEventListener("pointercancel", finishDrag);
  button.onclick = () => {
    if (ignoreClick) { ignoreClick = false; return; }
    dialog.showModal();
  };
}

function initControls() {
  $("btnRetryMap").onclick = () => { void openMap(); };
  $("btnExpandMap").onclick = () => {
    const expanded = $("mapBoard").classList.toggle("map-expanded");
    $("btnExpandMap").textContent = expanded ? "↙ 收起地图" : "⛶ 展开地图";
    $("btnExpandMap").setAttribute("aria-expanded", String(expanded));
    requestAnimationFrame(() => refreshMapSize());
    setTimeout(refreshMapSize, 220);
  };
  document.querySelectorAll("[data-copy-wechat]").forEach((button) => {
    button.onclick = () => copyText("cheerpup012", "微信号已复制，在微信搜索添加小木同学");
  });
  const wechatQrDialog = $("wechatQrDialog");
  initFloatingWechat(wechatQrDialog);
  $("btnOpenWechatQr").onclick = () => wechatQrDialog.showModal();
  $("btnCloseWechatQr").onclick = () => wechatQrDialog.close();
  wechatQrDialog.onclick = (event) => {
    if (event.target === wechatQrDialog) wechatQrDialog.close();
  };
  $("btnToggleFilters").onclick = () => setAdvancedFiltersOpen($("advancedFilters").hidden);
  $("btnCloseFilters").onclick = () => setAdvancedFiltersOpen(false);
  document.addEventListener("pointerdown", (event) => {
    if (!$("advancedFilters").hidden && !$("searchPanel").contains(event.target)) setAdvancedFiltersOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("advancedFilters").hidden) setAdvancedFiltersOpen(false);
  });
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
  loadSavedFilters();

  ["qSearch", "qSubject", "qGrade", "qMode", "qSort", "qStudentGender", "qTeacherGender", "qDistrict", "qTime", "qMinRate"].forEach((id) => {
    const changed = () => {
      $("aiSelectionSummary").hidden = true;
      saveFilters();
      renderHall();
    };
    $(id).addEventListener("input", changed);
    $(id).addEventListener("change", changed);
  });
  $("aiPreference").onchange = saveFilters;
  $("btnClearFilters").onclick = () => {
    ["qSearch", "qSubject", "qGrade", "qMode", "qStudentGender", "qTeacherGender", "qDistrict", "qTime", "qMinRate"].forEach((id) => { $(id).value = ""; });
    $("qSort").value = "recommend";
    state.onlySelected = false;
    $("onlySelected").checked = false;
    $("aiPreference").value = "balanced";
    $("aiSelectionSummary").hidden = true;
    saveFilters();
    renderHall();
  };
  $("onlySelected").onchange = (event) => {
    state.onlySelected = event.target.checked;
    saveFilters();
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

  $("btnSmartSelect").onclick = async () => {
    const preference = $("aiPreference").value;
    const sortMode = preference === "commute" ? "commute" : preference === "income" ? "rate" : "recommend";
    const candidates = sortBoardOrders(visibleBoardOrders, sortMode).slice(0, 30);
    if (!candidates.length) return showToast("当前筛选条件下没有可推荐的家教单");
    const button = $("btnSmartSelect");
    button.disabled = true;
    button.textContent = "✨ GLM 正在挑选…";
    let recommendation = null;
    try { recommendation = await recommendOrdersWithAI(candidates, preference); }
    catch { /* 网络或 GLM 不可用时切换本地排序 */ }
    finally { button.disabled = false; button.textContent = "✨ AI 自动勾选"; }
    const picks = recommendation?.picks || candidates.slice(0, 5).map((o) => ({ id: o.id, reason: "按时薪和预估路程排序" }));
    const previous = Store.getSelectedOrderIds();
    Store.setSelectedOrderIds([...new Set([...previous, ...picks.map((pick) => pick.id)])]);
    renderHall();
    const modeLabel = recommendation ? `模型推荐（${recommendation.provider}）` : "本地智能排序（模型暂不可用）";
    $("aiSelectionSummary").textContent = `${modeLabel}：${picks.map((pick) => `${pick.id} ${pick.reason}`).join("；")}。请核对后复制发送微信。`;
    $("aiSelectionSummary").hidden = false;
    showToast(`已勾选 ${picks.length} 条，${recommendation ? "GLM 推荐完成" : "已切换本地排序"}`);
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
  $("startupRetry").onclick = () => window.location.reload();
  const slowTimer = setTimeout(() => {
    updateStartupLoading("网络有点慢，仍在加载中，可点击重新加载重试。");
    $("startupRetry").hidden = false;
  }, 15000);
  try {
    initColorMode();
    initControls();
    await Store.init();
    renderAll();
    completeStartupLoading();
    startupFinished = true;
    scheduleMapOpen();
    if (!Store.getOrigin()?.manuallyChosen) locateMe(true);
  } catch (error) {
    console.error("看板初始化失败", error);
    updateStartupLoading("加载失败，请检查网络后重试。");
    $("startupRetry").hidden = false;
  } finally {
    clearTimeout(slowTimer);
  }
})();
