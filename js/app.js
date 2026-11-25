import {commuteForOrder,orderRoutePoint,queryOrderCommute,routeLabel,routeLink,runLimited} from "./route-client.js?v=3";
import { APP_CONFIG } from "./app-env.js";
import { SUBJECTS, GRADES } from "./data.js";
import { inferCoordsFromText, resolveUserAddress } from "./commute.js?v=6";
import { gcj02ToWgs84, getPublicMapLocation, moveMapTo, openMapBoard, refreshMapSize, setMapOrderSelectionHandlers, updateMapOrders, updateMapOrigin } from "./map-board.js?v=14";
import { parseMessyOrders, reviseDraftsWithAI, interpretSiteCommand, optimizeOrderAddressesWithAI, recommendOrdersWithAI, probeAIProvider } from "./ai-engine.js?v=12";
import { Store } from "./store.js?v=9";
import { canonicalDistrict, formatOrderText, getSubjectList, mergeOrders, nextOrderId, normalizeOrder, parseFormattedOrder, splitOrderBySubject } from "./order-format.js";
import { importOrderTable } from "./order-import.js";
import { buildWechatSelectionText, isPubliclyOpenOrder, sortBoardOrders, teacherGenderRequirement } from "./board-utils.js?v=4";
import { cardCopyableAddress, cardSchedule, cardStudentGenderTag, cardTeacherGenderTag, cardTitleSegments } from "./card-presentation.js?v=6";
import { getSeasonForDate, SEASON_DETAILS } from "./season-theme.js";
import { findPotentialDuplicates, orderFreshness } from "./order-extras.js";
import { MULTI_FILTER_LABELS, MULTI_FILTER_OPTIONS, matchesMultiFilters, normalizeMultiSelection, countSelectedFilters } from "./multi-filter.js?v=1";

import { splitDraftSubjects, mergeDraftSubjects, groupDraftsUnderParent, checkDraftIds, missingDraftFields } from "./draft-grouping.js?v=4";

const state = {
  view: "hall",
  layout: "cards",
  onlySelected: false,
  multiFilters: {},
  parsedDraftOrders: [],
  aiRawText: "",
  aiDraftBusy: false,
  aiDraftError: "",
  aiDraftTiming: null,
  aiDraftStarted: 0,
  lastPublishedDrafts: [],
  aiDraftHistory: [],
  aiDraftGroupingNotes: [],
  aiDraftQuestions: [],
  aiDraftReply: "",
  selectedDraftSubjects: new Set(),
  selectedDraftFamilies: new Set(),
  aiSiteHistory: [],
  aiSiteInput: "",
  aiSiteReply: "",
  editingOrderId: null,
  editingPartTimeId: null,
  adminQuery: "",
  adminStatus: "all",
  adminPageSize: 40,
  adminPage: "home"
};
let teacherPoolModulePromise=null;
let pendingTeacherApplicationScroll=false;
function loadTeacherPoolModule() {
  // 只在打开管理后台时下载老师档案和推荐模块，不影响普通老师的首屏加载。
  if(!teacherPoolModulePromise)teacherPoolModulePromise=import("./admin-teacher-pool.js?v=13")
    .catch(err=>{teacherPoolModulePromise=null;throw err;});
  return teacherPoolModulePromise;
}
let aiModelsModulePromise=null;
function hydrateAIModelManager() {
  if(state.adminPage!=="aiModels" || Store.getCurrentUser()?.role!=="admin")return;
  const slot=document.getElementById("aiModelManagerSlot");
  if(!slot)return;
  if(!aiModelsModulePromise)aiModelsModulePromise=import("./admin-ai-models.js?v=1")
    .catch(error=>{aiModelsModulePromise=null;throw error;});
  void aiModelsModulePromise.then(module=>{
    const target=document.getElementById("aiModelManagerSlot");
    if(!target || state.adminPage!=="aiModels" || Store.getCurrentUser()?.role!=="admin")return;
    module.mountAIModelManager(target,{Store,toast:showToast});
  }).catch(error=>{
    const target=document.getElementById("aiModelManagerSlot");
    if(target)target.textContent="AI 模型管理加载失败："+error.message;
  });
}
function hydrateTeacherPool() {
  if (state.adminPage !== "teachers") return;
  const container=$("adminContainer");
  if(!container?.querySelector("#teacherPoolSlot"))return;
  void loadTeacherPoolModule().then(module=>{
    const slot=container.querySelector("#teacherPoolSlot");
    if(!slot || Store.getCurrentUser()?.role!=="admin")return;
    slot.outerHTML=module.renderTeacherPool(Store.getOrders(),Store.getTeacherProfiles(),
      Store.getTeacherApplications(),Store.getAssignments(),Store.isCloudMode());
    module.bindTeacherPool(container,Store,renderAll,showToast,copyText);
    if (pendingTeacherApplicationScroll) {
      pendingTeacherApplicationScroll=false;
      requestAnimationFrame(() => document.getElementById("teacherApplicationPanel")?.scrollIntoView({
        behavior:"smooth",block:"start"
      }));
    }
  }).catch(err=>{
    const slot=container.querySelector("#teacherPoolSlot");
    if(slot)slot.textContent="老师档案库加载失败："+err.message;
  });
}
async function showNewTeacherRecommendations(orders) {
  try {
    const module=await loadTeacherPoolModule();
    await module.presentTeacherMatches(orders,Store);
  }catch(err){showToast("老师推荐面板加载失败："+err.message);}
}

const adminCheckedOrders = new Set();
let visibleBoardOrders = [];
let routeBatchBusy=false;
let routeOriginKey="";
let routeObserver=null;
const autoRouteQueue=new Set();
let autoRouteTimer=null;
let autoRouteEnabled=true;
try{autoRouteEnabled=localStorage.getItem("tutorhub_auto_amap_routes")!=="off";}catch{}
let expandedOrderId = null;
// 升级展示偏好版本：之前的默认列表偏好不影响新版默认卡片。
const BOARD_LAYOUT_KEY = "tutorhub_board_layout_v2";
const COLOR_MODE_KEY = "tutorhub_color_mode_v1";
const FILTERS_KEY = "tutorhub_filters_v1";
const PERSISTED_FILTER_IDS = ["qSearch", "qSubject", "qGrade", "qMode", "qSort", "qStudentGender", "qTeacherGender", "qDistrict", "qTime", "qMinRate", "aiPreference"];
const MULTI_FILTER_IDS = Object.keys(MULTI_FILTER_LABELS);

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

function aiTimingText(t){
 if(!t||!Number.isFinite(t.elapsedMs))return "";
 const sec=n=>(n/1000).toFixed(1)+" 秒";
 return "本次耗时 "+sec(t.elapsedMs)+(Number.isFinite(t.upstreamMs)?" · 模型接口 "+sec(t.upstreamMs):"")+(Number.isFinite(t.serverMs)?" · 网站其他处理/网络约 "+sec(Math.max(0,t.elapsedMs-(t.upstreamMs??0))):"");
}
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


function selectedValues(id) {
  return normalizeMultiSelection(state.multiFilters[id]);
}

function saveFilters() {
  const values = Object.fromEntries(PERSISTED_FILTER_IDS.map(id =>
    [id, MULTI_FILTER_IDS.includes(id) ? selectedValues(id) : ($(id)?.value || "")]));
  values.onlySelected = state.onlySelected;
  try { localStorage.setItem(FILTERS_KEY, JSON.stringify(values)); } catch { /* 无痕模式 */ }
}

function loadSavedFilters() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || "null"); } catch { /* 无痕模式 */ }
  if (!saved || typeof saved !== "object") return;
  for (const id of PERSISTED_FILTER_IDS) {
    if (MULTI_FILTER_IDS.includes(id)) {
      // 兼容旧版只保存一个选项的本地配置：转换为数组即可使用。
      state.multiFilters[id] = normalizeMultiSelection(saved[id]);
      continue;
    }
    const el = $(id);
    if (!el) continue;
    if (id === "qSearch" || id === "qMinRate") {
      el.value = typeof saved[id] === "string" ? saved[id] : "";
    } else if (typeof saved[id] === "string" && [...(el.options || [])].some(o => o.value === saved[id])) {
      el.value = saved[id];
    }
  }
  state.onlySelected = saved.onlySelected === true;
  $("onlySelected").checked = state.onlySelected;
}

function renderMultiFilter(id, supplied = []) {
  const details = $(id);
  if (!details) return;
  const label = MULTI_FILTER_LABELS[id];
  const chosen = selectedValues(id);
  const optionList = [...new Set([...supplied.map(item => typeof item === "string" ? item : item.value), ...chosen])];
  const labels = new Map((MULTI_FILTER_OPTIONS[id] || []).map(item => [item.value, item.label]));
  const options = optionList.map(value => ({ value, label: labels.get(value) || value }));
  const list = details.querySelector(".multi-filter-items");
  const signature = JSON.stringify(options);
  if (list.dataset.signature !== signature) {
    list.innerHTML = options.length
      ? options.map(option => '<label class="multi-filter-option"><input type="checkbox" value="' +
          escapeHtml(option.value) + '" /><span>' + escapeHtml(option.label) + '</span></label>').join("")
      : '<p class="multi-filter-empty">暂无可选条件</p>';
    list.dataset.signature = signature;
  }
  const selectedSet = new Set(chosen);
  list.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.checked = selectedSet.has(input.value);
  });
  const shortLabel = chosen.length === 1 ? (labels.get(chosen[0]) || chosen[0]) : "";
  details.querySelector(".multi-filter-summary").textContent = chosen.length === 0 ? label
    : chosen.length === 1 ? label + "：" + shortLabel
    : label + " · " + chosen.length + "项";
  details.classList.toggle("has-selected", chosen.length > 0);
  details.querySelector("summary").title = chosen.length ? chosen.map(x => labels.get(x) || x).join("、") : "点击勾选多个" + label;
}

function renderSelectedFilterChips() {
  const area = $("selectedFilterChips");
  if (!area) return;
  const chips = [];
  for (const id of MULTI_FILTER_IDS) {
    const labels = new Map((MULTI_FILTER_OPTIONS[id] || []).map(option => [option.value, option.label]));
    for (const value of selectedValues(id)) {
      const display = labels.get(value) || value;
      chips.push('<button type="button" data-clear-filter-id="' + escapeHtml(id) +
        '" data-clear-filter-value="' + escapeHtml(value) + '" aria-label="移除筛选：' +
        escapeHtml(MULTI_FILTER_LABELS[id] + display) + '">' +
        escapeHtml(MULTI_FILTER_LABELS[id] + "：" + display) + ' ×</button>');
    }
  }
  if ($("qMinRate").value) chips.push('<button type="button" data-clear-filter-id="qMinRate">时薪 ≥ ' +
    escapeHtml($("qMinRate").value) + ' ×</button>');
  if (state.onlySelected) chips.push('<button type="button" data-clear-filter-id="onlySelected">仅看已选单 ×</button>');
  area.hidden = chips.length === 0;
  area.innerHTML = chips.join("");
}

function initializeMultiFilters() {
  for (const id of MULTI_FILTER_IDS) {
    const details = $(id);
    if (!details) continue;
    details.addEventListener("toggle", () => {
      if (details.open) document.querySelectorAll(".multi-filter[open]").forEach(other => {
        if (other !== details) other.open = false;
      });
    });
    details.addEventListener("change", event => {
      if (!(event.target instanceof HTMLInputElement) || event.target.type !== "checkbox") return;
      state.multiFilters[id] = [...details.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
      $("aiSelectionSummary").hidden = true;
      saveFilters();
      renderHall();
    });
    details.addEventListener("click", event => {
      const button = event.target.closest("[data-multi-action]");
      if (!button) return;
      event.preventDefault();
      const values = [...details.querySelectorAll('input[type="checkbox"]')].map(input => input.value);
      state.multiFilters[id] = button.dataset.multiAction === "all" ? values : [];
      $("aiSelectionSummary").hidden = true;
      saveFilters();
      renderHall();
    });
  }
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
  document.title = (cfg.siteName || "小木学长") + " · 天津家教看板";
  const heroTitle = document.querySelector(".usage-card h1");
  const heroDescription = document.querySelector(".usage-card-copy > p");
  if (heroTitle) heroTitle.textContent = cfg.heroTitle || "筛选心仪家教，勾选后一键复制，发给南开小木同学";
  if (heroDescription) heroDescription.textContent = cfg.heroDescription || "筛选或在地图上挑选家教单，添加到选单清单，再把复制的内容发给「南开小木同学」微信。也可以让智能推荐帮你先挑选。";
  const notice = (cfg.announcement || "").trim();
  // 旧站公告可能提到账号与自动投递，不再展示过时的使用指引。
  $("siteAnnouncement").textContent = /自动投递|简历|登录|注册|账号|选中感兴趣的家教单|复制后微信联系/.test(notice) ? "" : notice;
  $("siteAnnouncement").hidden = !$("siteAnnouncement").textContent;
  $("modeBadge").textContent = Store.isCloudMode() ? "🟢 云端已同步" : "⚠️ 数据服务暂不可用，已暂停显示家教单";
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
function originRouteKey(origin){return JSON.stringify([origin.lat,origin.lng,Boolean(origin.gcj02)]);}
function resetRouteOrigin(origin){
 const key=originRouteKey(origin);
 if(routeOriginKey!==key){routeOriginKey=key;autoRouteQueue.clear();}
 return key;
}
function queueVisibleRoutes(grid){
 routeObserver?.disconnect();routeObserver=null;
 if(!autoRouteEnabled||state.view!=="hall")return;
 const origin=Store.getOrigin();resetRouteOrigin(origin);
 if(origin.lat==null||origin.lng==null)return;
 const enqueue=id=>{
   const o=visibleBoardOrders.find(x=>x.id===id);
   if(!o||commuteForOrder(origin,o).status!=="unqueried")return;
   autoRouteQueue.add(id);
   clearTimeout(autoRouteTimer);autoRouteTimer=setTimeout(drainAutoRoutes,120);
 };
 const nodes=grid.querySelectorAll("[data-route-order]");
 if(!window.IntersectionObserver){[...nodes].slice(0,6).forEach(n=>enqueue(n.dataset.routeOrder));return;}
 routeObserver=new IntersectionObserver(entries=>{
   for(const entry of entries)if(entry.isIntersecting){enqueue(entry.target.dataset.routeOrder);routeObserver?.unobserve(entry.target);}
 },{rootMargin:"200px 0px"});
 nodes.forEach(n=>routeObserver.observe(n));
}
async function drainAutoRoutes(){
 if(!autoRouteEnabled||routeBatchBusy||state.view!=="hall"){return;}
 const origin=Store.getOrigin();resetRouteOrigin(origin);
 const items=[...autoRouteQueue].map(id=>visibleBoardOrders.find(o=>o.id===id)).filter(Boolean).slice(0,6);
 autoRouteQueue.clear();
 if(items.length)await planVisibleRoutes(items,true);
}
async function planVisibleRoutes(single,automatic=false){
 if(routeBatchBusy)return;
 const origin=Store.getOrigin();
 if(origin.lat==null||origin.lng==null){if(!automatic)showToast("请先在地图上选择出发地");return;}
 const originKey=resetRouteOrigin(origin);
 const eligible=visibleBoardOrders.filter(o=>!["origin_missing","address_missing","loading"].includes(commuteForOrder(origin,o).status)&&o.mode!=="线上"&&commuteForOrder(origin,o).source!=="amap");
 const orders=single||eligible.slice(0,10);
 if(!orders.length){if(!automatic)showToast("当前没有需要查询的线下订单");return;}
 routeBatchBusy=true;const btn=$("btnPlanRoutes");if(btn)btn.disabled=true;
 try{
   const results=await runLimited(orders,async o=>{
     if(originRouteKey(Store.getOrigin())!==originKey||state.view!=="hall"||(automatic&&!autoRouteEnabled))return null;
     const job=queryOrderCommute(origin,o,{retry:!automatic});
     // Update only the status chip while a request runs; do not disturb the scroll position.
     for(const node of document.querySelectorAll("[data-route-label]"))if(node.dataset.routeLabel===o.id)node.textContent=routeLabel(commuteForOrder(origin,o));
     return job;
   });
   if(state.view==="hall")renderHall();
   if(!automatic)showToast("已获取 "+results.filter(x=>x?.source==="amap").length+" / "+orders.length+" 条高德路线");
 }finally{
   routeBatchBusy=false;if(btn)btn.disabled=false;
   if(state.view==="hall"&&autoRouteQueue.size)void drainAutoRoutes();
 }
}
function renderHall() {
  const publicOrders = Store.getOrders().filter(isPubliclyOpenOrder);
  const subjects = [...new Set([...SUBJECTS, "作业辅导", "陪读", "道法",
    ...publicOrders.flatMap(order => getSubjectList(order.subject))
      .filter(value => value.length <= 8)])];
  const grades = [...new Set([...GRADES, ...publicOrders.map(order => order.grade)
    .filter(value => typeof value === "string" && value && value.length <= 10)])];
  const districts = [...new Set(publicOrders.map(order => canonicalDistrict(order.district))
    .filter(value => value && value !== "区域待补充"))].sort();
  renderMultiFilter("qSubject", subjects);
  renderMultiFilter("qGrade", grades);
  renderMultiFilter("qDistrict", districts);
  for (const id of ["qMode", "qStudentGender", "qTeacherGender", "qTime"]) {
    renderMultiFilter(id, MULTI_FILTER_OPTIONS[id] || []);
  }
  const q = $("qSearch").value.trim().toLowerCase();



  const sort = $("qSort").value;




  const minRate = Number($("qMinRate").value) || 0;
  const origin = Store.getOrigin();
  const selected = Store.getSelectedOrderIds();

  let items = Store.getOrders().map((order) => ({
    ...order,
    commute: commuteForOrder(origin, order),
    selected: selected.includes(order.id)
  }));

  items = items.filter((o) => {
    if (!isPubliclyOpenOrder(o)) return false;
    if (state.onlySelected && !o.selected) return false;
    if (!matchesMultiFilters(o, state.multiFilters)) return false;
    if (minRate && o.hourlyRate < minRate) return false;
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
  resetRouteOrigin(origin);
  const routeNote=$("routeBatchNote");
  if(routeNote)routeNote.textContent=`${items.filter(o=>o.commute?.source==="amap").length} 条已获高德路线。${autoRouteEnabled?"自动查询可见订单":"自动查询已关闭"}；查询时发送约百米精度的起终点给高德。`;
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
      approximate ? "这类位置不参与高德通勤查询。" : ""
    ].filter(Boolean).join(" ");
  }

  $("resultStats").textContent = `共匹配 ${items.length} 条家教单（当前出发地址：${origin.name}）`;
  const activeCount = countSelectedFilters(state.multiFilters, $("qMinRate").value, state.onlySelected);
  $("activeFilterCount").textContent = activeCount ? ` · 已选 ${activeCount} 项` : "";
  $("quickFilterCount").textContent = activeCount ? String(activeCount) : "";
  renderSelectedFilterChips();
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
    routeObserver?.disconnect();autoRouteQueue.clear();
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
    const dest=orderRoutePoint(o);
    const commuteHtml = `<span class="chip commute" data-route-label="${escapeHtml(o.id)}">${escapeHtml(routeLabel(o.commute))}</span>`;
    const routeActions=o.mode==="线上"?"":`<div class="route-actions"><button type="button" class="btn btn-sm" data-plan-route="${escapeHtml(o.id)}" ${o.commute?.source==="amap"||o.commute?.status==="loading"?"disabled":""}>${o.commute?.source==="amap"?"已查询":o.commute?.status==="unqueried"?"立即查询":"重试高德通勤"}</button>${dest&&origin.lat!=null&&origin.lng!=null?`<a href="${escapeHtml(routeLink(origin,dest,"ride"))}" target="_blank" rel="noopener noreferrer">骑行路线（手机）</a><a href="${escapeHtml(routeLink(origin,dest,"bus"))}" target="_blank" rel="noopener noreferrer">公交路线</a>`:""}</div>`;
    const routeDetails=o.commute?.source==="amap"?`<details class="route-details"><summary>路线详情</summary>${o.commute.transitLines?.length?`<p>公交/地铁：${escapeHtml(o.commute.transitLines.join(" → "))}</p>`:""}${o.commute.bikeSteps?.length?`<ol>${o.commute.bikeSteps.map(x=>`<li>${escapeHtml(x)}</li>`).join("")}</ol>`:""}<p>高德规划耗时，实际以出行时情况为准。</p></details>`:"";
    return `
      <article class="order-card ${o.selected ? "order-selected" : ""}" data-route-order="${escapeHtml(o.id)}">
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
        ${routeActions}${routeDetails}

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
        queueVisibleRoutes(grid);
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
      return `<div class="orders-list-item ${expanded ? "expanded" : ""} ${o.selected ? "is-selected" : ""}" data-route-order="${escapeHtml(o.id)}">
        <button type="button" class="orders-list-row" data-expand-order="${escapeHtml(o.id)}" aria-expanded="${expanded}" aria-controls="${detailsId}">
          <span class="list-cell list-id">${escapeHtml(o.orderNumber || o.id)}</span>
          <span class="list-cell list-area">${escapeHtml(area)}</span>
          <span class="list-cell list-grade">${escapeHtml(o.grade)}</span>
          <span class="list-cell list-gender">${escapeHtml(o.studentGender)}</span>
          <span class="list-cell list-subject" title="${escapeHtml(o.subject)}">${escapeHtml(o.subject)}</span>
          <span class="list-cell list-rate">${escapeHtml(rate)}</span>
          <span class="list-cell list-frequency" title="${escapeHtml(o.weeklyFrequency)}">${escapeHtml(o.weeklyFrequency)}<small class="list-route-status" data-route-label="${escapeHtml(o.id)}">${escapeHtml(routeLabel(o.commute))}</small></span>
          <span class="list-cell list-expand">${o.selected ? "✓ 已选 · " : ""}${expanded ? "收起 ▲" : "展开 ▼"}</span>
        </button>
        ${expanded ? `<div id="${detailsId}" class="orders-list-detail">${renderDetailCard(o)}</div>` : ""}
      </div>`;
    }).join("")}</div>`;
  }

  queueVisibleRoutes(grid);
  // 事件委托：滚动新增的卡片无需重复绑定监听器。
  grid.onclick = (event) => {
    const routeButton=event.target.closest("[data-plan-route]");
    if(routeButton){
      const o=Store.getOrders().find(x=>x.id===routeButton.dataset.planRoute);
      if(o)void planVisibleRoutes([o]);
      return;
    }
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
  $("manualPublishedAt").value = o.publishedAt ? String(o.publishedAt).slice(0, 10) : "";
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
    publishedAt: $("manualPublishedAt").value ? new Date(`${$("manualPublishedAt").value}T00:00:00+08:00`).toISOString() : (original.publishedAt || ""),
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

const ADMIN_PAGES = {
  home: { name: "工作台首页", icon: "🏠" },
  orders: { name: "家教单管理", icon: "📋" },
  manual: { name: "手动录单", icon: "✍️" },
  aiOrders: { name: "编单与推荐老师", icon: "✨" },
  teachers: { name: "老师库与推荐订单", icon: "👩‍🏫" },
  aiSite: { name: "AI 修改网站与订单", icon: "🤖" },
  aiModels: { name: "AI 模型管理", icon: "🧠" },
  parttime: { name: "其他兼职", icon: "💼" }
};

function navigateAdminPage(page) {
  if (!Object.hasOwn(ADMIN_PAGES, page)) return;
  state.adminPage = page;
  renderAdminView();
  $("view-admin")?.scrollIntoView({ behavior: "smooth", block: "start" });
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

  const openedPage = Object.hasOwn(ADMIN_PAGES, state.adminPage) ? state.adminPage : "home";
  const activeLabel = ADMIN_PAGES[openedPage].name;
  const moduleCards = [
    {id:"orders", detail:"统一搜索、筛选、编辑、上架及批量处理", metric:`${orders.length} 条家教单`},
    {id:"aiOrders", detail:"一次识别多条微信需求，AI 对话修改并自由拆合科目", metric:`${state.parsedDraftOrders.length} 条待发布草稿`},
    {id:"manual", detail:"按九字段模板手动新建或编辑家教单", metric:"规范录入"},
    {id:"teachers", detail:"老师档案、历史接单记录、投递与推荐匹配", metric:"管理员专用"},
    {id:"aiSite", detail:"通过对话预览并确认修改网站设置和已有订单", metric:"修改前确认"},
    {id:"aiModels", detail:"添加多个中转站、保存模型名称、测试 API 并全站切换", metric:"统一模型设置"},
    {id:"parttime", detail:"发布、编辑和管理兼职招募信息", metric:`${Store.getPartTimePosts().length} 条兼职`}
  ];

  box.innerHTML = `
    <div class="admin-workspace-top">
      <div class="admin-workspace-crumb">
        ${openedPage === "home" ? "" : '<button class="btn btn-sm admin-home-button" id="btnAdminHome" type="button">← 工作台</button>'}
        <strong>${ADMIN_PAGES[openedPage].icon} ${activeLabel}</strong>
      </div>
      ${openedPage === "home" ? '<span class="admin-workspace-label">选择一个模块进入管理</span>' :
        `<select id="adminPageSwitcher" aria-label="切换后台模块">
          ${Object.entries(ADMIN_PAGES).map(([key, info]) =>
            `<option value="${key}" ${openedPage===key?"selected":""}>${info.icon} ${info.name}</option>`).join("")}
        </select>`}
    </div>
    <section class="admin-dashboard" data-admin-page="home" ${openedPage==="home"?"":"hidden"}>
      <div class="admin-dashboard-hero"><h2>家教工作台</h2><p>家长来了，整理订单找老师；老师来了，整理简历找订单。</p></div>
      <div class="admin-dashboard-stats">
        <span><strong>${orders.filter(isPubliclyOpenOrder).length}</strong> 招募中</span>
        <span><strong>${orders.length - orders.filter(isPubliclyOpenOrder).length}</strong> 已关闭</span>
        <span><strong>${state.parsedDraftOrders.length}</strong> 待发布草稿</span>
      </div>
      <div class="admin-module-grid admin-primary-workflows">
        <button type="button" class="admin-module-card admin-workflow-card" data-admin-go="aiOrders"><span class="admin-module-icon">📋</span><span class="admin-module-main"><strong>整理订单 · 推荐老师</strong><small>粘贴家长需求 → AI 编单及修改 → 复制 / 发布 → 推荐空闲老师</small><em>${state.parsedDraftOrders.length} 条待发布草稿</em></span><span class="admin-module-arrow" aria-hidden="true">›</span></button>
        <button type="button" class="admin-module-card admin-workflow-card" data-admin-go="teachers"><span class="admin-module-icon">👩‍🏫</span><span class="admin-module-main"><strong>维护老师库 · 推荐订单</strong><small>粘贴简历及意向 → 推荐订单 → 选择入库、更新状态与星标</small><em>${Store.getTeacherProfiles().length} 位储备老师</em></span><span class="admin-module-arrow" aria-hidden="true">›</span></button>
      </div>
      <details class="admin-secondary-modules"><summary>其他管理功能</summary><div class="admin-module-grid">
        ${moduleCards.filter(item=>!["aiOrders","teachers"].includes(item.id)).map(item => `<button type="button" class="admin-module-card" data-admin-go="${item.id}">
          <span class="admin-module-icon">${ADMIN_PAGES[item.id].icon}</span>
          <span class="admin-module-main"><strong>${ADMIN_PAGES[item.id].name}</strong>
            <small>${item.detail}</small><em>${item.metric}</em></span>
          <span class="admin-module-arrow" aria-hidden="true">›</span>
        </button>`).join("")}
      </div></details>
    </section>
    ${!Store.isCloudMode() ? `
      <div class="panel" data-admin-page="home" style="border-color:#f59e0b;background:#fffbeb;" ${openedPage === "home" ? "" : "hidden"}>
        <strong>提示：尚未绑定 Cloudflare KV 云端存储</strong>
        <p style="font-size:13px;color:#92400e;margin-top:4px;">
          当前数据仅保存在本机浏览器。在 Cloudflare Pages 后台 <strong>Settings → Bindings → Add → KV Namespace</strong> 中绑定变量名 <code>TUTOR_KV</code> 并重新部署后，即可自动开启多人云端同步。
        </p>
      </div>
    ` : ""}

    <div class="panel admin-module-page" data-admin-page="parttime" ${openedPage==="parttime"?"":"hidden"}>
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

    <div class="panel admin-module-page" data-admin-page="manual" ${openedPage==="manual"?"":"hidden"}>
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
          <div class="field"><label for="manualPublishedAt">真实招募开始日期（可选）</label><input id="manualPublishedAt" type="date" title="历史导入单日期未知时，请人工确认后填写；用于超时提醒，不会把导入日期当发单日期" /></div>
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


    <div class="panel admin-module-page" data-admin-page="aiOrders" ${openedPage==="aiOrders"?"":"hidden"}>

      <div class="ai-workspace-title"><div><h2>AI 编单</h2><p class="admin-helper">发送需求，继续对话修改；满意后复制到微信或一键发布。</p></div><button class="btn btn-sm" id="btnNewAIOrder" type="button">＋ 新单</button></div>
      <div class="ai-chat-panel ai-order-history" id="aiDraftHistory" aria-live="polite"></div>
      <div id="parsedPreview" style="margin-top:12px;"></div>
      <div class="ai-workspace-actions">
        <button class="btn btn-primary" id="btnPublishDrafts" style="display:${state.parsedDraftOrders.length ? "inline-flex" : "none"};">一键发布（${state.parsedDraftOrders.length} 条）</button>
        <button class="btn" id="btnCopyDrafts" style="display:${state.parsedDraftOrders.length ? "inline-flex" : "none"};">复制全部到微信</button>
        <button class="btn" id="btnMatchDrafts" style="display:${state.parsedDraftOrders.length?"inline-flex":"none"};">推荐老师（不发布）</button>
        ${state.lastPublishedDrafts.length?'<button class="btn btn-sm" id="btnCopyPublishedDrafts" type="button">复制上次已发布单</button><button class="btn btn-sm" id="btnMatchPublishedDrafts" type="button">推荐储备老师</button>':""}
      </div>
      <div class="ai-chat-compose ai-workspace-compose">
        <label for="rawOrderInput">${state.parsedDraftOrders.length?"继续说要怎么修改":"输入新家教需求"}</label>
        <textarea id="rawOrderInput" rows="4" placeholder="${state.parsedDraftOrders.length?"例如：数学改周日下午，物理时薪120":"直接粘贴家长需求，例如高一男生，数学74物理48，河西区津沽东里，周末2小时，分成两单"}"></textarea>
        <button class="btn btn-primary" id="btnParseOrders" type="button" ${state.aiDraftBusy?"disabled":""}>${state.aiDraftBusy?"AI 正在整理…":"发送"}</button>
        <p id="aiDraftTiming" class="admin-helper" role="status">${state.aiDraftBusy?"模型正在处理，请勿重复发送。":escapeHtml(aiTimingText(state.aiDraftTiming))}</p>
        <p id="aiDraftError" class="admin-helper" role="alert" ${state.aiDraftError?"":"hidden"}>${state.aiDraftError?escapeHtml("整理失败："+state.aiDraftError+"。输入及原草稿已保留，可直接再次发送。"):""}</p>
      </div>
      <details class="ai-workspace-advanced"><summary>其他导入方式</summary><div class="field">
        <label for="csvImportInput">导入结构化家教单（CSV / TSV / JSON）</label>
        <input type="file" id="csvImportInput" accept=".csv,.tsv,.txt,.json,text/csv,text/plain,application/json" />
      </div></details>
    </div>

    <section class="admin-module-page" data-admin-page="aiModels" ${openedPage==="aiModels"?"":"hidden"}><div id="aiModelManagerSlot" class="panel"><p class="admin-helper">正在加载模型管理…</p></div></section>

    <div class="panel admin-module-page" data-admin-page="aiSite" ${openedPage==="aiSite"?"":"hidden"}>
      <h2>🤖 AI 辅助修改（管理员确认后执行）</h2>
      <p style="font-size:13px;color:var(--muted);margin-bottom:8px;">支持连续对话修改现有单的科目、时薪、时间、要求、状态及首页标题、公告、配色。每次先预览、再确认；网页代码和新功能仍需通过 GitHub 修改：</p>
      <div style="display:flex;gap:8px;">
        <textarea id="aiSiteCmd" rows="2" placeholder="例如：把 #2517 的时薪改为150元。下一条还可以说：把刚才那单的时间改到周日"></textarea>
        <button class="btn btn-primary" id="btnRunSiteCmd" style="white-space:nowrap;">生成修改预览</button>
      </div>
      <div class="admin-editor-actions"><button class="btn btn-sm" id="btnProbeAI" type="button">检测 AI 接口是否接通</button><span class="admin-helper" id="aiProbeResult">请到「AI 模型管理」添加中转站并切换模型；Cloudflare 环境变量仍可作为备用设置。</span></div>
      <div class="ai-chat-panel" id="aiSiteHistory" aria-live="polite"></div><p id="aiSiteReply" style="font-size:13px;color:var(--primary);margin-top:8px;"></p>
    </div>


    <section class="admin-module-page" data-admin-page="teachers" ${openedPage==="teachers"?"":"hidden"}><div id="teacherPoolSlot" class="panel"><p class="admin-helper">正在加载老师档案库…</p></div></section>

    <div class="panel admin-module-page" data-admin-page="orders" ${openedPage==="orders"?"":"hidden"}>
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
              <button class="btn btn-sm" data-open-app="${escapeHtml(o.id)}">登记投递</button>
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

  box.querySelectorAll("[data-admin-go]").forEach(button => {
    button.onclick = () => navigateAdminPage(button.dataset.adminGo);
  });
  $("btnAdminHome")?.addEventListener("click", () => navigateAdminPage("home"));
  $("adminPageSwitcher")?.addEventListener("change", event => navigateAdminPage(event.target.value));
  box.querySelectorAll("[data-open-app]").forEach(button => {
    button.onclick = async () => {
      try {
        const module = await loadTeacherPoolModule();
        module.selectTeacherApplication(button.dataset.openApp);
        pendingTeacherApplicationScroll=true;
        state.adminPage = "teachers";
        renderAdminView();
        $("view-admin")?.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (err) { showToast("打开老师投递页面失败：" + err.message); }
    };
  });
  $("rawOrderInput").value = state.aiRawText;
  $("aiSiteCmd").value = state.aiSiteInput;
  $("aiSiteReply").textContent = state.aiSiteReply;
  $("aiDraftHistory").innerHTML = state.aiDraftHistory.map(entry => `<div class="ai-message ai-message-${entry.role}"><b>${entry.role === "user" ? "管理员" : "AI"}</b> ${escapeHtml(entry.content)}</div>`).join("");
  $("aiSiteHistory").innerHTML = state.aiSiteHistory.map(entry => `<div class="ai-message ai-message-${entry.role}"><b>${entry.role === "user" ? "管理员" : "AI"}</b> ${escapeHtml(entry.content)}</div>`).join("");
  $("rawOrderInput").oninput = (event) => { state.aiRawText = event.target.value; };
  $("aiSiteCmd").oninput = (event) => { state.aiSiteInput = event.target.value; };
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
      if(!old) void showNewTeacherRecommendations([item]);
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


  $("btnNewAIOrder").onclick=()=>{
    if(state.aiDraftBusy)return;
    if(state.parsedDraftOrders.length && !confirm("当前草稿尚未发布，开始新单会清空草稿。继续吗？"))return;
    state.parsedDraftOrders=[];state.aiDraftHistory=[];state.aiRawText="";state.aiDraftError="";state.aiDraftTiming=null;
    state.aiDraftGroupingNotes=[];state.aiDraftQuestions=[];
    state.selectedDraftSubjects.clear();state.selectedDraftFamilies.clear();
    renderAdminView();$("rawOrderInput")?.focus();
  };
  $("btnParseOrders").onclick = async () => {
    if(state.aiDraftBusy)return;
    const raw=$("rawOrderInput").value.trim();
    if(!raw)return showToast("请输入家教需求或修改指令");
    syncDraftTextareas();
    state.aiRawText=raw;state.aiDraftError="";state.aiDraftTiming=null;state.aiDraftStarted=Date.now();
    const errorBox=$("aiDraftError");if(errorBox){errorBox.hidden=true;errorBox.textContent="";}
    state.aiDraftBusy=true;
    $("btnParseOrders").disabled=true;$("btnParseOrders").textContent="AI 正在整理…";
    $("btnPublishDrafts").disabled=true;
    let progressMessage="AI 正在整理";
    const updateElapsed=()=>{const node=$("aiDraftTiming");if(node)node.textContent=progressMessage+" · 已用时 "+Math.floor((Date.now()-state.aiDraftStarted)/1000)+" 秒";};
    updateElapsed();const elapsedTimer=setInterval(updateElapsed,1000);
    try{
      const existing=[...Store.getOrders(),{orderNumber:"#"+Store.getOrderSequence()}];
      let previous=state.parsedDraftOrders;
      if(!previous.length && /修改|补充|更新|重新发布|重新上架|改为|改成|拆单|拆分|分成.{0,12}单/.test(raw)){
        const labels=[...new Set([...raw.matchAll(/#\d{3,7}(?:-\d+)?/g)].map(m=>m[0]))];
        if(labels.length===1){
          const found=Store.getOrders().filter(o=>String(o.orderNumber||o.id)===labels[0]);
          if(found.length>1)throw new Error("此编号对应多条历史订单，请在订单管理中选择原单，避免修改错人");
          if(found.length===1)previous=[{...found[0],id:labels[0],existingOrderId:found[0].id}];
        }
      }
      const onProgress=message=>{progressMessage=message;updateElapsed();const btn=$("btnParseOrders");if(btn)btn.textContent=message;};
      const result=previous.length ?
        await reviseDraftsWithAI(raw,previous,state.aiDraftHistory,existing,onProgress):
        await parseMessyOrders(raw,existing,state.aiDraftHistory,onProgress);
      state.parsedDraftOrders=result.orders;
      state.aiDraftTiming=result.timing||{elapsedMs:Date.now()-state.aiDraftStarted};
      state.aiDraftReply=result.reply;state.aiDraftGroupingNotes=result.groupingNotes;state.aiDraftQuestions=result.questions;
      state.selectedDraftSubjects.clear();state.selectedDraftFamilies.clear();
      state.aiDraftHistory.push({role:"user",content:raw},{role:"assistant",content:result.reply||"已整理，请查看标准文案"});
      state.aiDraftHistory=state.aiDraftHistory.slice(-12);state.aiRawText="";
    }catch(error){state.aiDraftTiming={elapsedMs:Date.now()-state.aiDraftStarted};state.aiDraftError=error.message;showToast("AI 整理失败："+error.message);}
    finally{clearInterval(elapsedTimer);state.aiDraftBusy=false;renderAdminView();}
  };
  $("rawOrderInput").onkeydown=event=>{
    if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)){event.preventDefault();$("btnParseOrders").click();}
  };
  $("btnPublishDrafts").onclick = async () => {
    if(!state.parsedDraftOrders.length||state.aiDraftBusy) return;
    syncDraftTextareas();
    const items = state.parsedDraftOrders.map(order => normalizeOrder(order));
    const ordinary=items.filter(o=>!o.existingOrderId&&!o.explicitNumberReuse);
    const idIssues = checkDraftIds(ordinary,Store.getOrders());
    if(idIssues.length) return showToast("单号重复或不合法："+idIssues.slice(0,3).join("、")+"；请核对草稿编号");
    if(items.some(o=>o.grade==="年级待补充"||o.subject==="科目待补充"))
      return showToast("请先补全所有草稿的年级和科目，再发布");
    if(!confirmDuplicateRisks(ordinary))return;
    if(items.some(o=>o.existingOrderId||o.explicitNumberReuse||o.splitFromId) && !confirm("此批含原单更新、历史拆单或明确指定的重号新单。请核对编号及学生身份；发布将保留原记录关联，历史拆单会下架原主单，重号新单不会覆盖旧单。继续吗？"))return;
    if(!Store.isCloudMode())return showToast("服务器存储不可用，未发布");
    state.aiDraftBusy=true;
    const button = $("btnPublishDrafts");
    button.disabled=true;
    button.textContent="正在写入云端…";
    try {
      // API 模型已经处理过结构化地址；不再额外发起一次容易失败的 AI 解析调用。
      const published=await Store.publishAIDrafts(items);
      const count=items.length;
      state.lastPublishedDrafts=published;
      state.aiRawText="";
      state.parsedDraftOrders=[];
      state.aiDraftHistory=[];
      state.aiDraftQuestions=[];
      state.aiDraftGroupingNotes=[];
      state.selectedDraftSubjects.clear();
      state.selectedDraftFamilies.clear();
      renderAll();
      showToast("已发布 "+count+" 条家教单，可复制上次已发布单");
      void showNewTeacherRecommendations(published);
    }catch(error){showToast("发布失败："+error.message);}
    finally {state.aiDraftBusy=false;renderAdminView();}
  };
  $("btnCopyDrafts").onclick = () => {
    syncDraftTextareas();
    copyText(state.parsedDraftOrders.map(formatOrderText).join("\n\n"),"已复制全部九字段草稿");
  };
  $("btnMatchDrafts").onclick=()=>{if(state.aiDraftBusy)return;syncDraftTextareas();void showNewTeacherRecommendations(state.parsedDraftOrders);};
  if($("btnCopyPublishedDrafts"))$("btnCopyPublishedDrafts").onclick=()=>copyText(state.lastPublishedDrafts.map(formatOrderText).join("\n\n"),"已复制已发布家教单");
  if($("btnMatchPublishedDrafts"))$("btnMatchPublishedDrafts").onclick=()=>void showNewTeacherRecommendations(state.lastPublishedDrafts);
  $("csvImportInput").onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (/\.json$/i.test(file.name)) {
        if (!Store.isCloudMode()) throw new Error("云端存储不可用，未写入任何数据");
        const doc = JSON.parse(await file.text());
        if (doc.schema !== "tutorhub-structured-orders-v1" || !Array.isArray(doc.orders) || doc.orders.length > 2000)
          throw new Error("不是有效的 TutorHub 标准家教单文件");
        // 将静态单（包括已隐藏单）和云端记录一同纳入重复检查，不覆盖现有状态。
        const staticResponse = await fetch("./data/imported-orders.json", {cache:"no-store"});
        if (!staticResponse.ok) throw new Error("无法核对历史静态单，已停止导入");
        const staticOrders = await staticResponse.json();
        if (!Array.isArray(staticOrders)) throw new Error("历史单格式异常");
        const existing = [...staticOrders, ...Store.getOrders()];
        const label = o => String(o.orderNumber || o.id || "").match(/#?(\d+(?:-\d+)?)/)?.[1] || "";
        const base = o => label(o).split("-")[0];
        const subject = o => {
          const s = String(o.subject || "").replace(/数理化/g,"数学物理化学").replace(/道德与法治/g,"道法");
          const core = ["数学","语文","英语","物理","化学","生物","历史","地理","政治","道法","全科","陪读","作业","奥数","编程","钢琴"].filter(x=>s.includes(x));
          return core.length ? core.sort().join("|") : s.replace(/[、，,\s]/g,"");
        };
        const accepted = [];
        let skipped = 0;
        for (const raw of doc.orders) {
          if (!raw || !/^#\d+(?:-\d+)?$/.test(raw.orderNumber || "") || !raw.grade || !raw.subject)
            throw new Error("文件包含无效编号、年级或科目");
          const related = [...existing,...accepted].filter(o=>base(o)===base(raw));
          const same = related.some(o=>subject(o)===subject(raw) && (label(o)===label(raw) || !label(o).includes("-") || !label(raw).includes("-")));
          if (same) { skipped++; continue; }
          let number = raw.orderNumber;
          const used = new Set([...existing,...accepted].map(label));
          if (used.has(label(raw))) {
            let suffix=1; while(used.has(base(raw)+"-"+suffix)) suffix++;
            number="#"+base(raw)+"-"+suffix;
          }
          const allowed = ["title","grade","studentGender","subject","teacherCount","currentScores","address","publicAddress","district","weeklyFrequency","hoursPerSession","requirements","salaryText","trialTime","notes","mode","onlineAllowed","urgent","createdAt"];
          const record=Object.fromEntries(allowed.filter(k=>raw[k]!==undefined).map(k=>[k,raw[k]]));
          accepted.push(normalizeOrder({...record,id:number,orderNumber:number,source:"structured-history",status:"待确认（暂停招募）"}));
        }
        if (!accepted.length) { showToast("全部记录已存在，无需重复导入"); return; }
        if (!confirm("标准文件共 "+doc.orders.length+" 条，跳过已存在 "+skipped+" 条，新增 "+accepted.length+" 条历史单（待确认、暂停招募，不覆盖旧状态）。确认写入云端？")) return;
        const input=event.target;
        input.disabled=true;
        let saved=0;
        try {
          for(let i=0;i<accepted.length;i+=80) {
            await Store.addOrders(accepted.slice(i,i+80));
            saved+=Math.min(80,accepted.length-i);
          }
          renderAll();
          showToast("已新增 "+saved+" 条，跳过 "+skipped+" 条；请在家教单管理核实后上架");
        } catch(error) {
          renderAll();
          showToast("已新增 "+saved+" 条，后续写入失败："+error.message+"；可重新导入同一文件");
        } finally { input.disabled=false; }
        return;
      }
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
        ? `✅ 模型调用成功：${result.provider}。${aiTimingText(result.timing)}。这是实际接口测试，不是内置规则引擎。`
        : `⚠️ 模型未通过检测：${result.error}。已禁用内置解析器，请修复 API 后重试。`;
    } catch (error) { $("aiProbeResult").textContent = `模型检测出错：${error.message}`; }
    finally { button.disabled = false; }
  };

  $("btnRunSiteCmd").onclick = async () => {
    const command=$("aiSiteCmd").value.trim();
    if(!command)return showToast("请输入要修改的网站设置或家教单内容");
    state.aiSiteInput=command;
    const button=$("btnRunSiteCmd");
    button.disabled=true;button.textContent="正在调用 AI 分析…";
    try {
      const result=await interpretSiteCommand(command,Store.getSiteConfig(),Store.getOrders(),state.aiSiteHistory);
      const actions=result.actions||[];
      const details=actions.map(action=>{
        if(action.type==="update_site")return "网站设置："+JSON.stringify(action.patch);
        const order=Store.getOrders().find(x=>x.id===action.id);
        return "家教单 "+(order?.orderNumber||action.id)+"："+JSON.stringify(action.patch);
      }).join("\n");
      let status="未执行任何操作";
      if(actions.length){
        const approved=confirm("下面是 AI 提议，尚未修改：\n\n"+details+
          "\n\n这些操作均经安全白名单过滤。确认修改吗？");
        if(approved){
          let count=0;
          for(const action of actions){
            if(action.type==="update_site")await Store.updateSiteConfig(action.patch);
            else if(action.type==="update_order")await Store.updateOrder(action.id,action.patch);
            count++;
          }
          status="已确认并执行 "+count+" 项修改";
        }else status="管理员取消，本次未修改";
      }
      const response=[result.reply,status,
        ...(result.questions||[]),...(result.discarded||[]).map(x=>"未通过校验："+x)].filter(Boolean).join("；");
      state.aiSiteHistory.push({role:"user",content:command},{role:"assistant",content:response});
      state.aiSiteHistory=state.aiSiteHistory.slice(-12);
      state.aiSiteReply=response;
      state.aiSiteInput="";
      applySiteConfig();renderAdminView();
      showToast(status);
    }catch(error){
      state.aiSiteReply="AI 修改失败："+error.message;
      $("aiSiteReply").textContent=state.aiSiteReply;
      showToast(state.aiSiteReply);
    }finally{button.disabled=false;button.textContent="生成修改预览";}
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
      state.adminPage = "manual";
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
      state.adminPage = "manual";
      renderAdminView();
      $("manualOrderForm").scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });
  box.querySelectorAll("[data-split-order]").forEach((btn) => {
    btn.onclick = () => {
      const item = Store.getOrders().find((o) => o.id === btn.dataset.splitOrder);
      if (!item) return;
      state.parsedDraftOrders = splitOrderBySubject(item);
      state.adminPage = "aiOrders";
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
  hydrateTeacherPool();
  hydrateAIModelManager();
}


function syncDraftTextareas() {
  const wrap=$("parsedPreview");
  if(!wrap)return;
  wrap.querySelectorAll("[data-draft-text]").forEach(el=>{
    const i=Number(el.dataset.draftText),parsed=parseFormattedOrder(el.value);
    const old=state.parsedDraftOrders[i];
    if(parsed&&old){
      const next={...old,...parsed,orderNumber:parsed.id||old.orderNumber,mode:old.mode,publicAddress:parsed.address};
      if(next.orderNumber!==old.orderNumber){delete next.existingOrderId;delete next.explicitNumberReuse;delete next.splitFromId;}
      state.parsedDraftOrders[i]=next;
    }
  });
}
function renderParsedPreview() {
  const wrap=$("parsedPreview");
  if(!wrap)return;
  const drafts=state.parsedDraftOrders;
  if(!drafts.length){wrap.innerHTML="";return;}
  const notes=[...state.aiDraftGroupingNotes,...state.aiDraftQuestions.map(s=>"待确认："+s)];
  wrap.innerHTML=`
    <div class="ai-group-summary"><strong>AI 生成了 ${drafts.length} 条草稿</strong>
      ${notes.length ? `<p>${notes.map(escapeHtml).join("；")}</p>` : ""}
      <p>直接编辑标准文案或继续对话；核对后即可发布。</p>
    </div>
    <details class="ai-workspace-advanced"><summary>手动拆单 / 合并 / 编组（可选）</summary><div class="ai-group-toolbar">
      <button class="btn btn-sm" type="button" id="btnSplitSelectedSubjects">拆分所选科目</button>
      <button class="btn btn-sm" type="button" id="btnMergeSelectedSubjects">合并所选科目</button>
      <button class="btn btn-sm" type="button" id="btnGroupRelatedDrafts">将选中草稿编为同一主单号</button>
      <button class="btn btn-sm" type="button" id="btnClearSubjectSelections">取消勾选</button>
      <span class="admin-helper">当前勾选 <strong id="selectedSubjectCount">${state.selectedDraftSubjects.size}</strong> 个科目</span>
    </div></details>
    ${drafts.map((o,index)=>`
      <div class="order-draft">
        <div class="ai-draft-head"><label class="ai-family-label"><input type="checkbox" data-group-family="${index}" ${state.selectedDraftFamilies.has(index)?"checked":""} />编为一组</label><strong>${o.existingOrderId?"更新原单":o.explicitNumberReuse?"指定重号新单":o.splitFromId?"历史拆单":"草稿 "+(index+1)} · ${escapeHtml(o.orderNumber||o.id)} · ${escapeHtml(o.grade)}</strong>
          <div class="ai-draft-actions">
            <button class="btn btn-sm" type="button" data-split-draft="${index}">全部按单科拆分</button>
            <button class="btn btn-sm" type="button" data-copy-draft="${index}">复制</button>
            <button class="btn btn-danger btn-sm" type="button" data-remove-draft="${index}">移除</button>
          </div>
        </div>
        <details class="ai-workspace-advanced"><summary>科目选择</summary><div class="ai-subject-picker" role="group" aria-label="草稿 ${index+1} 科目选择">
          ${getSubjectList(o.subject).map(subject=>{
            const key=index+"::"+subject;
            return `<label class="ai-subject-chip"><input type="checkbox" data-subject-key="${escapeHtml(key)}" ${state.selectedDraftSubjects.has(key)?"checked":""}/><span>${escapeHtml(subject)}</span></label>`;
          }).join("")}
        </div>
        </details>
        ${o.groupingReason ? `<p class="admin-helper">AI 判断：${escapeHtml(o.groupingDecision||"待确认")} · ${escapeHtml(o.groupingReason)}</p>`:""}
        ${missingDraftFields(o).length ? `<p class="admin-helper ai-draft-warning">待核实：${escapeHtml(missingDraftFields(o).join("、"))}</p>`:""}
        ${!o.existingOrderId && findPotentialDuplicates([o],Store.getOrders()).length ?
          `<p class="admin-helper ai-draft-warning">疑似重复单：${escapeHtml(findPotentialDuplicates([o],Store.getOrders()).slice(0,3).map(x=>x.existing.orderNumber||x.existing.id).join("、"))}</p>`:""}
        <textarea data-draft-text="${index}" aria-label="草稿 ${index+1} 的标准九字段">${escapeHtml(formatOrderText(o))}</textarea>
        <p class="admin-helper">可手动编辑九字段。只有确认发布才会保存到云端。</p>
      </div>`).join("")}
  `;
  wrap.querySelectorAll("[data-draft-text]").forEach(el=>el.onchange=syncDraftTextareas);
  wrap.querySelectorAll("[data-group-family]").forEach(box=>box.onchange=()=>{
    const i=Number(box.dataset.groupFamily);
    if(box.checked)state.selectedDraftFamilies.add(i);else state.selectedDraftFamilies.delete(i);
  });
  $("btnGroupRelatedDrafts").onclick=()=>{
    syncDraftTextareas();
    if(state.selectedDraftFamilies.size<2)return showToast("请选择至少两条同来源需求的草稿");
    if(!confirm("确认这几条草稿属于同一组家长需求吗？\n仅改变显示编号为 #主单号-1、-2 等，不会把不同学生合并为同一条单。"))return;
    try{
      state.parsedDraftOrders=groupDraftsUnderParent(state.parsedDraftOrders,[...state.selectedDraftFamilies],Store.getOrders());
      state.selectedDraftFamilies.clear();renderAdminView();showToast("已按同一主编号编组，独立需求和科目未改变");
    }catch(err){showToast("编组失败："+err.message);}
  };
  wrap.querySelectorAll("[data-subject-key]").forEach(box=>{
    box.onchange=()=>{
      if(box.checked)state.selectedDraftSubjects.add(box.dataset.subjectKey);
      else state.selectedDraftSubjects.delete(box.dataset.subjectKey);
      $("selectedSubjectCount").textContent=String(state.selectedDraftSubjects.size);
    };
  });
  $("btnClearSubjectSelections").onclick=()=>{state.selectedDraftSubjects.clear();state.selectedDraftFamilies.clear();renderParsedPreview();};
  $("btnSplitSelectedSubjects").onclick=()=>{
    syncDraftTextareas();
    if(!state.selectedDraftSubjects.size)return showToast("请先勾选要拆开的科目");
    state.parsedDraftOrders=splitDraftSubjects(state.parsedDraftOrders,[...state.selectedDraftSubjects]);
    state.selectedDraftSubjects.clear();state.selectedDraftFamilies.clear();renderAdminView();
    showToast("已拆分科目，未勾选的科目仍保留");
  };
  $("btnMergeSelectedSubjects").onclick=()=>{
    syncDraftTextareas();
    const keys=[...state.selectedDraftSubjects];
    if(keys.length<2)return showToast("请至少从两条草稿中分别选中科目");
    if(!confirm("请确认这些科目来自同一名学生、希望由一位老师授课。确认合并吗？"))return;
    try{
      state.parsedDraftOrders=mergeDraftSubjects(state.parsedDraftOrders,keys,true);
      state.selectedDraftSubjects.clear();state.selectedDraftFamilies.clear();renderAdminView();
      showToast("已合并选定科目，其余科目保留");
    }catch(err){showToast("合并失败："+err.message);}
  };
  wrap.querySelectorAll("[data-split-draft]").forEach(btn=>{
    btn.onclick=()=>{
      syncDraftTextareas();
      const i=Number(btn.dataset.splitDraft);
      const keys=getSubjectList(state.parsedDraftOrders[i].subject).map(s=>i+"::"+s);
      state.parsedDraftOrders=splitDraftSubjects(state.parsedDraftOrders,keys);
      state.selectedDraftSubjects.clear();renderAdminView();
    };
  });
  wrap.querySelectorAll("[data-copy-draft]").forEach(btn=>{
    btn.onclick=()=>copyText(wrap.querySelector('[data-draft-text="'+btn.dataset.copyDraft+'"]').value,"已复制家教单");
  });
  wrap.querySelectorAll("[data-remove-draft]").forEach(btn=>{
    btn.onclick=()=>{
      syncDraftTextareas();
      state.parsedDraftOrders.splice(Number(btn.dataset.removeDraft),1);
      state.selectedDraftSubjects.clear();renderAdminView();
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
      $("mapLocationNote").textContent = `已将「${place.name}」设为我的位置，红色标记与通勤查询已更新。紫色家教点仅来自公开地址。`;
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
    if (!result.ok && result.errorCode) $( "mapLocationNote" ).textContent = "高德地点搜索暂不可用（"+result.errorCode+"），仍可选择本地预设和已知地点。";
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
    if (!event.target.closest(".multi-filter")) {
      document.querySelectorAll(".multi-filter[open]").forEach(details => { details.open = false; });
    }
    if (!$("advancedFilters").hidden && !$("searchPanel").contains(event.target)) setAdvancedFiltersOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      document.querySelectorAll(".multi-filter[open]").forEach(details => { details.open = false; });
      if (!$("advancedFilters").hidden) setAdvancedFiltersOpen(false);
    }
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
  $("btnPlanRoutes")?.addEventListener("click",()=>void planVisibleRoutes());
  const autoRouteToggle=$("autoRouteToggle");
  if(autoRouteToggle){autoRouteToggle.checked=autoRouteEnabled;autoRouteToggle.onchange=()=>{autoRouteEnabled=autoRouteToggle.checked;try{localStorage.setItem("tutorhub_auto_amap_routes",autoRouteEnabled?"on":"off");}catch{}if(!autoRouteEnabled){autoRouteQueue.clear();routeObserver?.disconnect();}renderHall();};}
  initializeMultiFilters();
  loadSavedFilters();
  $("selectedFilterChips").addEventListener("click", event => {
    const button = event.target.closest("[data-clear-filter-id]");
    if (!button) return;
    const id = button.dataset.clearFilterId;
    if (id === "onlySelected") {
      state.onlySelected = false;
      $("onlySelected").checked = false;
    } else if (id === "qMinRate") {
      $("qMinRate").value = "";
    } else if (MULTI_FILTER_IDS.includes(id)) {
      state.multiFilters[id] = selectedValues(id).filter(v => v !== button.dataset.clearFilterValue);
    }
    $("aiSelectionSummary").hidden = true;
    saveFilters();
    renderHall();
  });

  ["qSearch", "qSort", "qMinRate"].forEach((id) => {
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
    ["qSearch", "qMinRate"].forEach(id => { $(id).value = ""; });
    for (const id of MULTI_FILTER_IDS) state.multiFilters[id] = [];
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

  $("btnAdminEntry").onclick = () => { state.adminPage = "home"; switchView("admin"); };
  $("btnBackToHall").onclick = () => switchView("hall");
  $("btnViewTutoring").onclick = () => switchView("hall");
  $("btnViewPartTime").onclick = () => switchView("parttime");
  $("btnMobileTutoring").onclick = () => switchView("hall");
  $("btnMobileMore").onclick = () => switchView("parttime");
  $("btnMobileAdminEntry").onclick = () => { state.adminPage = "home"; switchView("admin"); };
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
    button.textContent = "✨ AI 模型正在挑选…";

    let recommendation;
    try {
      recommendation=await recommendOrdersWithAI(candidates,preference);
      if(!recommendation?.picks?.length)throw new Error("模型没有返回有效候选单");
      const picks=recommendation.picks;
      const previous=Store.getSelectedOrderIds();
      Store.setSelectedOrderIds([...new Set([...previous,...picks.map(p=>p.id)])]);
      renderHall();
      $("aiSelectionSummary").textContent="模型推荐（"+recommendation.provider+"）："+
        picks.map(p=>p.id+" "+p.reason).join("；")+"。请核对后复制发送微信。";
      $("aiSelectionSummary").hidden=false;
      showToast("已按模型建议勾选 "+picks.length+" 条");
    }catch(error){
      $("aiSelectionSummary").textContent="AI 调用失败："+error.message+"。未改变原选单，请检查 API 设置。";
      $("aiSelectionSummary").hidden=false;
      showToast("AI 推荐失败，请检查 API");
    }finally{
      button.disabled=false;button.textContent="✨ AI 自动勾选";
    }
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
      $("mapLocationNote").textContent = `已将「${text}」设为我的位置；地图上的红色标记和通勤查询已更新。`;
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
