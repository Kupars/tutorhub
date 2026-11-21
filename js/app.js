import { APP_CONFIG } from "./app-env.js";
import { SUBJECTS, GRADES } from "./data.js";
import { estimateCommuteLocal, resolveUserAddress } from "./commute.js";
import { parseMessyOrders, optimizeResumeWithAI, interpretSiteCommand } from "./ai-engine.js";
import { Store } from "./store.js";
import { formatOrderText, getSubjectList, mergeOrders, nextOrderId, normalizeOrder, parseFormattedOrder, splitOrderBySubject } from "./order-format.js";
import { importOrderTable } from "./order-import.js";

const state = {
  view: "hall",
  onlyOpen: true,
  onlyBookmarks: false,
  authMode: "login",
  activeApplyOrderId: null,
  parsedDraftOrders: [],
  editingOrderId: null
};

const $ = (id) => document.getElementById(id);

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

function copyText(text, successMsg = "已复制") {
  navigator.clipboard?.writeText(text)
    .then(() => showToast(successMsg))
    .catch(() => showToast("复制失败，请手动复制"));
}

function applySiteConfig() {
  const cfg = Store.getSiteConfig();
  document.documentElement.setAttribute("data-theme", cfg.theme || "indigo");
  document.title = cfg.siteName || "家教招募大厅";
  $("siteAnnouncement").textContent = cfg.announcement;
  $("modeBadge").textContent = Store.isCloudMode() ? "🟢 云端已同步" : "";
}

function syncOriginInput() {
  const origin = Store.getOrigin();
  const input = $("originAddressInput");
  if (input && origin?.name) input.value = origin.name;
}

function renderUserActions() {
  const user = Store.getCurrentUser();
  const wrap = $("userActions");
  if (!user) {
    wrap.innerHTML = `<button class="btn btn-primary btn-sm" id="btnOpenAuth">登录 / 注册</button>`;
    $("btnOpenAuth").onclick = () => openAuthModal("login");
  } else {
    const roleTag = user.role === "admin" ? "🛡️ 管理员" : "🎓 老师";
    wrap.innerHTML = `
      <span style="font-size:13px;font-weight:600;">${roleTag} · ${escapeHtml(user.name)}</span>
      <button class="btn btn-sm" id="btnLogout">退出</button>
    `;
    $("btnLogout").onclick = () => {
      Store.logout();
      renderAll();
      showToast("已安全退出登录");
    };
  }
}

function switchView(viewName) {
  state.view = viewName;
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(`view-${viewName}`).classList.add("active");
  document.querySelectorAll("[data-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === viewName);
  });
  if (viewName === "hall") renderHall();
  if (viewName === "my-orders") renderMyOrders();
  if (viewName === "resume") renderResumeView();
  if (viewName === "admin") renderAdminView();
}

// ---------------- 视图 1：招募大厅 ----------------
function renderHall() {
  syncOriginInput();
  const districtSelect = $("qDistrict");
  const selectedDistrict = districtSelect.value;
  const districts = [...new Set(Store.getOrders().map((o) => o.district).filter((d) => d && d !== "区域待补充"))].sort();
  districtSelect.innerHTML = '<option value="">全部区域</option>' +
    districts.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
  districtSelect.value = districts.includes(selectedDistrict) ? selectedDistrict : "";
  const q = $("qSearch").value.trim().toLowerCase();
  const subject = $("qSubject").value;
  const grade = $("qGrade").value;
  const mode = $("qMode").value;
  const sort = $("qSort").value;
  const studentGender = $("qStudentGender").value;
  const district = $("qDistrict").value;
  const time = $("qTime").value;
  const minRate = Number($("qMinRate").value) || 0;
  const origin = Store.getOrigin();
  const bookmarks = Store.getBookmarks();
  const user = Store.getCurrentUser();
  const myApps = user ? Store.getUserApplications(user.id) : [];

  let items = Store.getOrders().map((order) => ({
    ...order,
    commute: estimateCommuteLocal(origin, order),
    bookmarked: bookmarks.includes(order.id),
    applied: myApps.some((a) => a.orderId === order.id && a.status !== "已撤回")
  }));

  items = items.filter((o) => {
    if (state.onlyOpen && o.status !== "招募中") return false;
    if (state.onlyBookmarks && !o.bookmarked) return false;
    if (subject && o.subject !== subject && !getSubjectList(o.subject).includes(subject)) return false;
    if (grade && o.grade !== grade) return false;
    if (mode && o.mode !== mode) return false;
    if (studentGender && o.studentGender !== studentGender) return false;
    if (district && o.district !== district) return false;
    if (minRate && o.hourlyRate < minRate) return false;
    if (time === "weekend" && !/周末|周六|周日|周天/.test(o.weeklyFrequency || o.schedule || "")) return false;
    if (time === "weekday" && !/周中|周一|周二|周三|周四|周五/.test(o.weeklyFrequency || o.schedule || "")) return false;
    if (q) {
      const hay = [o.id, o.title, o.subject, o.grade, o.studentGender, o.teacherCount,
        o.currentScores, o.weeklyFrequency, o.trialTime, o.salaryText, o.district, o.address,
        o.studentInfo, o.requirements, ...(o.tags || [])]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  if (sort === "rate") {
    items.sort((a, b) => b.hourlyRate - a.hourlyRate);
  } else if (sort === "commute") {
    items.sort((a, b) => (a.commute?.bestMin ?? 999) - (b.commute?.bestMin ?? 999));
  } else {
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  $("resultStats").textContent = `共匹配 ${items.length} 条家教单（当前出发地址：${origin.name}）`;

  const grid = $("ordersGrid");
  if (items.length === 0) {
    grid.innerHTML = `<div class="panel" style="grid-column:1/-1;text-align:center;color:var(--muted);">${Store.getOrders().length ? "没有符合条件的家教单，试试放宽筛选条件吧。" : "暂无家教单，管理员可在「安全后台」新增或批量导入。"} </div>`;
    return;
  }

  grid.innerHTML = items.map((o) => {
    const monthlyEst = o.hourlyRate && o.sessionsPerWeek
      ? Math.round(o.hourlyRate * o.hoursPerSession * o.sessionsPerWeek * 4) : null;
    const commuteHtml = o.commute
      ? o.commute.isOnline
        ? `<span class="chip commute">💻 线上免通勤</span>`
        : `<span class="chip commute">🚲 骑行 ${o.commute.bikeMin} 分钟</span><span class="chip commute">🚌 公交 ${o.commute.transitMin} 分钟 · ${o.commute.distanceKm}km</span>`
      : "";
    const statusClass = o.status === "招募中" ? "status-open" : "status-closed";
    return `
      <article class="order-card">
        <div class="card-head">
          <div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:2px;">${escapeHtml(o.id)} · ${escapeHtml(o.district || o.mode)}</div>
            <div class="card-title">${escapeHtml(o.title)}</div>
          </div>
          <div class="price-badge">${escapeHtml((o.salaryText || "老师报价").replace("（可报价）", ""))}</div>
        </div>

        <div class="meta-row">
          <span class="chip ${statusClass}">${escapeHtml(o.status)}</span>
          ${o.urgent ? `<span class="chip urgent">🔥 急招</span>` : ""}
          <span class="chip">${escapeHtml(o.grade)} · ${escapeHtml(o.subject)}</span>
          <span class="chip">${escapeHtml(o.mode)}</span>
          <span class="chip">👤 学生：${escapeHtml(o.studentGender)}</span>
          <span class="chip">招 ${o.teacherCount} 位老师</span>
          ${o.onlineAllowed ? '<span class="chip">💻 可网课</span>' : ""}
          ${commuteHtml}
        </div>

        <div class="card-desc">
          <div><strong>地点：</strong>${escapeHtml(o.address)}</div>
          <div><strong>时间：</strong>${escapeHtml(o.weeklyFrequency)} · 每次 ${o.hoursPerSession}小时${monthlyEst ? ` · 按最低时薪约 ¥${monthlyEst}/月` : ""}</div>
          <div><strong>成绩：</strong>${escapeHtml(o.currentScores)}</div>
          ${o.trialTime ? `<div><strong>试课：</strong>${escapeHtml(o.trialTime)}</div>` : ""}
          ${o.studentInfo ? `<div><strong>补充：</strong>${escapeHtml(o.studentInfo)}</div>` : ""}
          <div><strong>要求：</strong>${escapeHtml(o.requirements)}</div>
        </div>

        <div class="card-foot">
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm" data-bookmark="${o.id}">${o.bookmarked ? "★ 已收藏" : "☆ 收藏"}</button>
            <button class="btn btn-sm" data-copy="${o.id}">📋 复制单子</button>
          </div>
          <div>
            ${
              o.status !== "招募中"
                ? `<button class="btn btn-sm" disabled>已停止招募</button>`
                : o.applied
                ? `<button class="btn btn-sm" disabled>✓ 已投递</button>`
                : `<button class="btn btn-primary btn-sm" data-apply="${o.id}">🚀 一键投递</button>`
            }
          </div>
        </div>
      </article>
    `;
  }).join("");

  grid.querySelectorAll("[data-bookmark]").forEach((btn) => {
    btn.onclick = () => {
      Store.toggleBookmark(btn.dataset.bookmark);
      renderHall();
    };
  });
  grid.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.onclick = () => {
      const o = Store.getOrders().find((x) => x.id === btn.dataset.copy);
      if (!o) return;
      copyText(formatOrderText(o), "已复制标准九字段家教单");
    };
  });
  grid.querySelectorAll("[data-apply]").forEach((btn) => {
    btn.onclick = () => openApplyModal(btn.dataset.apply);
  });
}

// ---------------- 投递与自动匹配投递 ----------------
async function openApplyModal(orderId) {
  const user = Store.getCurrentUser();
  if (!user) {
    showToast("请先登录老师账号再投递");
    openAuthModal("login");
    return;
  }
  const order = Store.getOrders().find((o) => o.id === orderId);
  if (!order) return;
  state.activeApplyOrderId = orderId;

  const resume = Store.getResume(user.id);
  $("applyModalTitle").textContent = `投递：${order.id}`;
  $("applyOrderSummary").textContent = `${order.title} · ¥${order.hourlyRate}/时 · ${order.schedule}`;
  $("applyPitch").value = "正在根据你的简历生成针对性自荐语...";
  $("applyModal").classList.add("open");

  const aiRes = await optimizeResumeWithAI(resume, order);
  $("applyPitch").value = aiRes.pitch;
}

async function runAutoApply() {
  const user = Store.getCurrentUser();
  if (!user) {
    showToast("请先登录老师账号并设置自动投递规则");
    openAuthModal("login");
    return;
  }
  const resume = Store.getResume(user.id);
  const rules = resume.autoApplyRules || { subjects: [], maxCommuteMin: 45, minRate: 100 };
  const origin = Store.getOrigin();
  const myApps = Store.getUserApplications(user.id);

  const candidates = Store.getOrders().filter((o) => {
    if (o.status !== "招募中") return false;
    if (myApps.some((a) => a.orderId === o.id && a.status !== "已撤回")) return false;
    if (rules.subjects?.length && !getSubjectList(o.subject).some((s) => rules.subjects.includes(s))) return false;
    if (o.hourlyRate < (rules.minRate || 0)) return false;
    const commute = estimateCommuteLocal(origin, o);
    if (commute && !commute.isOnline && commute.bestMin > (rules.maxCommuteMin || 60)) return false;
    return true;
  });

  if (candidates.length === 0) {
    showToast("当前没有新单满足你的自动投递规则（可在「简历与自动投递」中调整）");
    return;
  }

  let count = 0;
  for (const order of candidates) {
    const aiRes = await optimizeResumeWithAI(resume, order);
    const res = await Store.applyOrder({
      orderId: order.id,
      teacherId: user.id,
      teacherName: resume.name || user.name,
      teacherWechat: resume.wechat || user.wechat || "",
      pitch: aiRes.pitch,
      resumeSnapshot: resume,
      isAuto: true
    });
    if (res.ok) count++;
  }
  renderHall();
  showToast(`已为你智能匹配并自动投递 ${count} 条家教单！`);
}

// ---------------- 视图 2：我的接单 ----------------
function renderMyOrders() {
  const user = Store.getCurrentUser();
  const box = $("myAppsContainer");
  if (!user) {
    box.innerHTML = `<p style="color:var(--muted);">请先登录后查看你的投递记录与接单进度。</p>`;
    return;
  }
  const apps = Store.getUserApplications(user.id);
  const orders = Store.getOrders();
  if (apps.length === 0) {
    box.innerHTML = `<p style="color:var(--muted);">你还没有投递过家教单，去招募大厅看看吧！</p>`;
    return;
  }

  box.innerHTML = apps.map((app) => {
    const order = orders.find((o) => o.id === app.orderId);
    return `
      <div class="panel" style="margin:10px 0;padding:14px;">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <strong>${escapeHtml(app.orderId)} · ${escapeHtml(order?.title || "已归档家教单")}</strong>
          <div style="display:flex;gap:6px;align-items:center;">
            ${app.isAuto ? `<span class="chip commute">🤖 自动投递</span>` : ""}
            <span class="chip status-open">${escapeHtml(app.status)}</span>
          </div>
        </div>
        <p style="font-size:13px;color:#334155;margin:8px 0;"><strong>自荐语：</strong>${escapeHtml(app.pitch)}</p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <input style="max-width:360px;" placeholder="添加个人备忘（如：周六10点试讲）" value="${escapeHtml(app.teacherNote || "")}" data-note-input="${app.id}" />
          <button class="btn btn-sm" data-save-note="${app.id}">保存备注</button>
          ${app.status !== "已撤回" ? `<button class="btn btn-danger btn-sm" data-withdraw="${app.id}">撤回投递</button>` : ""}
        </div>
      </div>
    `;
  }).join("");

  box.querySelectorAll("[data-save-note]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.saveNote;
      const val = box.querySelector(`[data-note-input="${id}"]`).value;
      await Store.updateApplication(id, { teacherNote: val }, false);
      showToast("接单备注已保存");
    };
  });
  box.querySelectorAll("[data-withdraw]").forEach((btn) => {
    btn.onclick = async () => {
      await Store.updateApplication(btn.dataset.withdraw, { status: "已撤回" }, false);
      renderMyOrders();
      showToast("已撤回该次投递");
    };
  });
}

// ---------------- 视图 3：简历模板 + AI 优化 + 自动投递规则 ----------------
function renderResumeView() {
  const user = Store.getCurrentUser();
  const box = $("resumeFormContainer");
  if (!user) {
    box.innerHTML = `<p style="color:var(--muted);">请先登录老师账号，即可按模板填写简历、使用 AI 润色并开启一键自动投递。</p>`;
    return;
  }
  const r = Store.getResume(user.id);
  const rules = r.autoApplyRules || { subjects: [], maxCommuteMin: 45, minRate: 100 };

  box.innerHTML = `
    <div class="grid-3">
      <div class="field"><label>姓名/称呼</label><input id="rName" value="${escapeHtml(r.name)}" /></div>
      <div class="field"><label>微信号（管理员派单联系）</label><input id="rWechat" value="${escapeHtml(r.wechat || user.wechat || "")}" placeholder="请填写微信号" /></div>
      <div class="field"><label>学校</label><input id="rSchool" value="${escapeHtml(r.school)}" placeholder="如：天津大学" /></div>
    </div>
    <div class="grid-3" style="margin-top:12px;">
      <div class="field"><label>专业与年级</label><input id="rMajor" value="${escapeHtml(r.major)}" placeholder="如：自动化 · 大三" /></div>
      <div class="field"><label>擅长科目（逗号分隔）</label><input id="rSubjects" value="${escapeHtml((r.subjects || []).join("，"))}" placeholder="数学，物理，化学" /></div>
      <div class="field"><label>可授课时间</label><input id="rAvail" value="${escapeHtml(r.availableTime)}" placeholder="周三晚、周末全天" /></div>
    </div>
    <div class="field" style="margin-top:12px;">
      <label>成绩与亮点（高考分、竞赛奖项、证书等）</label>
      <textarea id="rHighlights" rows="3">${escapeHtml(r.highlights)}</textarea>
    </div>
    <div class="field" style="margin-top:12px;">
      <label>家教经历与教学方法</label>
      <textarea id="rExperience" rows="3">${escapeHtml(r.experience)}</textarea>
    </div>

    <h3>🤖 自动匹配投递规则</h3>
    <div class="grid-3">
      <div class="field"><label>目标科目（逗号分隔，留空不限）</label><input id="ruleSubjects" value="${escapeHtml((rules.subjects || []).join("，"))}" /></div>
      <div class="field"><label>最低时薪要求（元/小时）</label><input id="ruleMinRate" type="number" value="${rules.minRate || 100}" /></div>
      <div class="field"><label>最长可接受通勤（分钟）</label><input id="ruleMaxCommute" type="number" value="${rules.maxCommuteMin || 45}" /></div>
    </div>
  `;
}

function collectResumeFromForm() {
  const splitList = (v) => v.split(/[，,、\s]+/).map((s) => s.trim()).filter(Boolean);
  return {
    name: $("rName").value.trim(),
    wechat: $("rWechat").value.trim(),
    school: $("rSchool").value.trim(),
    major: $("rMajor").value.trim(),
    subjects: splitList($("rSubjects").value),
    availableTime: $("rAvail").value.trim(),
    highlights: $("rHighlights").value.trim(),
    experience: $("rExperience").value.trim(),
    autoApplyRules: {
      subjects: splitList($("ruleSubjects").value),
      minRate: Number($("ruleMinRate").value) || 0,
      maxCommuteMin: Number($("ruleMaxCommute").value) || 60
    }
  };
}

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
  const apps = Store.getApplications();
  const teachers = Store.getTeachers();

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
      <h2>✍️ ${state.editingOrderId ? "编辑已有家教单" : "新增家教单"} <span class="chip">九字段标准模板</span></h2>
      <p class="admin-helper">家长微信可以直接粘贴到下方 AI 整理区；也可以手动填表。只读大厅中的筛选不会修改数据库。</p>
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
      <h2>👥 已注册老师与微信号（${teachers.length} 位）</h2>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${teachers.map((t) => `
          <div style="border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <div>
              <strong>${escapeHtml(t.name)}</strong>
              <span class="chip status-open">微信号：${escapeHtml(t.wechat || "未填写")}</span>
              <span class="chip">${escapeHtml(t.email)}</span>
              ${t.defaultOrigin?.name ? `<span class="chip">📍 ${escapeHtml(t.defaultOrigin.name)}</span>` : ""}
            </div>
            ${t.wechat ? `<button class="btn btn-sm" data-copy-wx="${escapeHtml(t.wechat)}">📋 复制微信号</button>` : ""}
          </div>
        `).join("")}
      </div>
    </div>

    <div class="panel">
      <h2>📋 家教单管理（${orders.length} 条） & 投递审核（${apps.length} 条）</h2>
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

      ${apps.length ? `
        <h3>最新老师投递</h3>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${apps.map((a) => `
            <div style="border:1px solid var(--border);border-radius:10px;padding:12px;">
              <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;align-items:center;">
                <div>
                  <strong>${escapeHtml(a.teacherName)}</strong> 投递了 <strong>${escapeHtml(a.orderId)}</strong>
                  <span class="chip status-open">微信：${escapeHtml(a.teacherWechat || a.resumeSnapshot?.wechat || "未填")}</span>
                </div>
                <div style="display:flex;gap:6px;align-items:center;">
                  ${(a.teacherWechat || a.resumeSnapshot?.wechat) ? `<button class="btn btn-sm" data-copy-wx="${escapeHtml(a.teacherWechat || a.resumeSnapshot?.wechat)}">复制微信</button>` : ""}
                  <span class="chip">${escapeHtml(a.status)}</span>
                </div>
              </div>
              <p style="font-size:13px;color:#334155;margin:6px 0;">${escapeHtml(a.pitch)}</p>
              <div style="display:flex;gap:6px;">
                <button class="btn btn-sm" data-app-status="${a.id}" data-val="试讲中">安排试讲</button>
                <button class="btn btn-primary btn-sm" data-app-status="${a.id}" data-val="已录用">标记录用</button>
                <button class="btn btn-danger btn-sm" data-app-status="${a.id}" data-val="未通过">未通过</button>
              </div>
            </div>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;

  if (state.editingOrderId) {
    const editing = orders.find((o) => o.id === state.editingOrderId);
    if (editing) fillManualOrder(editing);
  }

  $("manualOrderForm").onsubmit = async (event) => {
    event.preventDefault();
    try {
      const old = orders.find((o) => o.id === state.editingOrderId);
      const item = collectManualOrder(old || {});
      if (!item.subject || item.subject === "科目待补充") return showToast("请填写补习科目");
      if (old) await Store.updateOrder(old.id, item);
      else await Store.addOrders([item]);
      state.editingOrderId = null;
      renderAll();
      showToast(old ? "家教单已保存修改" : `家教单 ${item.id} 已发布`);
    } catch (err) { showToast(`保存失败：${err.message}`); }
  };
  $("btnResetManual").onclick = () => { state.editingOrderId = null; renderAdminView(); };
  $("btnCopyQuestionnaire").onclick = () => copyText([
    "【学生性别】", "【年级】", "【补习科目】", "【需要几个老师】",
    "【现阶段成绩（多少分）】", "【补课地址（区＋小区）】",
    "【一周几次（周中还是周末）】", "【每次几小时】",
    "【对老师要求】", "【薪资（元/小时）】", "【试课时间（如有）】"
  ].join("\n"), "已复制家长问询模板");

  renderParsedPreview();

  box.querySelectorAll("[data-copy-wx]").forEach((btn) => {
    btn.onclick = () => copyText(btn.dataset.copyWx, `已复制微信号：${btn.dataset.copyWx}`);
  });

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
    try {
      await Store.addOrders(items);
      const n = items.length;
      state.parsedDraftOrders = [];
      renderAll();
      showToast(`已发布 ${n} 条家教单到招募大厅`);
    } catch (err) { showToast(`发布失败：${err.message}`); }
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
  box.querySelectorAll("[data-app-status]").forEach((btn) => {
    btn.onclick = async () => {
      await Store.updateApplication(btn.dataset.appStatus, { status: btn.dataset.val }, true);
      renderAdminView();
      showToast(`已更新状态为「${btn.dataset.val}」`);
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
function openAuthModal(mode = "login") {
  state.authMode = mode;
  const isReg = mode === "register";
  $("registerNameField").style.display = isReg ? "flex" : "none";
  $("registerWechatField").style.display = isReg ? "flex" : "none";
  $("registerAddressField").style.display = isReg ? "flex" : "none";
  $("tabLogin").className = !isReg ? "btn btn-primary btn-sm" : "btn btn-sm";
  $("tabRegister").className = isReg ? "btn btn-primary btn-sm" : "btn btn-sm";
  $("authModal").classList.add("open");
}

async function handleSaveOriginAddress() {
  const raw = $("originAddressInput").value.trim();
  if (!raw) return showToast("请输入你的默认出发地址");
  const resolved = await resolveUserAddress(raw);
  await Store.setOrigin(resolved);
  renderHall();
  showToast(`默认地址已更新为「${resolved.name}」，骑行与公交耗时已刷新`);
}

function initControls() {
  SUBJECTS.forEach((s) => $("qSubject").insertAdjacentHTML("beforeend", `<option value="${s}">${s}</option>`));
  GRADES.forEach((g) => $("qGrade").insertAdjacentHTML("beforeend", `<option value="${g}">${g}</option>`));

  APP_CONFIG.presetLocations.forEach((loc) => {
    $("originPresets").insertAdjacentHTML("beforeend", `<option value="${escapeHtml(loc.name)}"></option>`);
  });

  $("btnSaveOrigin").onclick = handleSaveOriginAddress;
  $("originAddressInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSaveOriginAddress();
  });

  ["qSearch", "qSubject", "qGrade", "qMode", "qSort", "qStudentGender", "qDistrict", "qTime", "qMinRate"].forEach((id) => {
    $(id).addEventListener("input", renderHall);
    $(id).addEventListener("change", renderHall);
  });
  $("btnClearFilters").onclick = () => {
    ["qSearch", "qSubject", "qGrade", "qMode", "qStudentGender", "qDistrict", "qTime", "qMinRate"].forEach((id) => { $(id).value = ""; });
    $("qSort").value = "latest";
    renderHall();
  };

  $("btnOnlyOpen").onclick = () => {
    state.onlyOpen = !state.onlyOpen;
    $("btnOnlyOpen").textContent = `仅看招募中：${state.onlyOpen ? "开" : "关"}`;
    renderHall();
  };
  $("btnOnlyBookmarks").onclick = () => {
    state.onlyBookmarks = !state.onlyBookmarks;
    $("btnOnlyBookmarks").classList.toggle("btn-primary", state.onlyBookmarks);
    renderHall();
  };
  $("btnRunAutoApply").onclick = runAutoApply;

  document.querySelectorAll("[data-view]").forEach((btn) => {
    btn.onclick = () => switchView(btn.dataset.view);
  });

  $("tabLogin").onclick = () => openAuthModal("login");
  $("tabRegister").onclick = () => openAuthModal("register");
  $("closeAuthModal").onclick = () => $("authModal").classList.remove("open");
  $("btnSubmitAuth").onclick = async () => {
    const email = $("authEmail").value.trim();
    const password = $("authPassword").value;
    if (!email || !password) return showToast("请输入邮箱和密码");

    let res;
    if (state.authMode === "register") {
      const name = $("authName").value.trim();
      const wechat = $("authWechat").value.trim();
      const addr = $("authAddress").value.trim();
      if (!name) return showToast("请填写姓名或称呼");
      if (!wechat) return showToast("请填写微信号，以便管理员联系");
      const defaultOrigin = addr ? await resolveUserAddress(addr) : Store.getOrigin();
      res = await Store.register({ name, wechat, email, password, defaultOrigin });
    } else {
      res = await Store.login(email, password);
    }

    if (!res.ok) return showToast(res.error);
    $("authModal").classList.remove("open");
    renderAll();
    showToast(`欢迎回来，${res.user.name}`);
  };

  $("closeApplyModal").onclick = () => $("applyModal").classList.remove("open");
  $("btnConfirmApply").onclick = async () => {
    const user = Store.getCurrentUser();
    if (!user || !state.activeApplyOrderId) return;
    const resume = Store.getResume(user.id);
    const res = await Store.applyOrder({
      orderId: state.activeApplyOrderId,
      teacherId: user.id,
      teacherName: resume.name || user.name,
      teacherWechat: resume.wechat || user.wechat || "",
      pitch: $("applyPitch").value.trim(),
      resumeSnapshot: resume
    });
    if (!res.ok) return showToast(res.error);
    $("applyModal").classList.remove("open");
    renderHall();
    showToast("投递成功！可在「我的接单」中查看进度");
  };

  $("btnSaveResume").onclick = async () => {
    const user = Store.getCurrentUser();
    if (!user) return openAuthModal("login");
    await Store.saveResume(user.id, collectResumeFromForm());
    showToast("简历模板与自动投递规则已保存");
  };

  $("btnOptimizeResume").onclick = async () => {
    const user = Store.getCurrentUser();
    if (!user) return openAuthModal("login");
    showToast("正在使用 AI 润色简历...");
    const draft = collectResumeFromForm();
    const res = await optimizeResumeWithAI(draft);
    $("rHighlights").value = res.highlights;
    $("rExperience").value = res.experience;
    showToast(`润色完成（${res.source}），请记得点击保存`);
  };
}

function renderAll() {
  applySiteConfig();
  renderUserActions();
  syncOriginInput();
  switchView(state.view);
}

(async () => {
  initControls();
  await Store.init();
  renderAll();
})();
