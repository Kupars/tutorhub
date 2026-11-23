import { APP_CONFIG } from "./app-env.js";
import { DEFAULT_SITE_CONFIG, SAMPLE_ORDERS } from "./data.js";
import { normalizeOrder } from "./order-format.js";

const KEYS = {
  orders: "tutorhub_orders_v3",
  site: "tutorhub_site_v3",
  users: "tutorhub_users_v3",
  session: "tutorhub_session_v3",
  token: "tutorhub_token_v3",
  resumes: "tutorhub_resumes_v3",
  apps: "tutorhub_apps_v3",
  bookmarks: "tutorhub_bookmarks_v3",
  selectedOrders: "tutorhub_selected_orders_v1",
  hiddenImported: "tutorhub_hidden_imported_v1",
  partTime: "tutorhub_parttime_v1",
  origin: "tutorhub_origin_v3"
};
const LEGACY_DEMO_IDS = new Set(["JJ-2026-101", "JJ-2026-102", "JJ-2026-103", "JJ-2026-104", "JJ-2026-105",
  "JJ-2026-4737", "JJ-2026-4738", "JJ-2026-888"]);

let cloudReady = false;
let importedOrders = [];
let cloudState = {
  siteConfig: DEFAULT_SITE_CONFIG,
  orders: SAMPLE_ORDERS,
  hiddenImported: [],
  partTimePosts: [],
  assignments: [],
  teacherProfiles: [],
  teacherApplications: [],
  orderSequence: 2991,
  teachers: [],
  applications: [],
  myResume: null
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

// 生产环境没有本地管理员模式。管理员身份必须由云端服务端鉴权。
function ensureLocalInit() {
  // 仅保留本机筛选和位置偏好，不创建可猜测的默认管理员账号。
}
ensureLocalInit();

async function apiPost(payload) {
  const token = localStorage.getItem(KEYS.token) || "";
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${APP_CONFIG.apiBase}/store`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  return await res.json();
}

export const Store = {
  // AI credentials live exclusively in Cloudflare KV, encrypted at rest.
  async listAIProviders() {
    if (!cloudReady) throw new Error("需要 Cloudflare KV 云端后台才能管理模型");
    const data=await apiPost({action:"admin_ai_provider_list"});
    if (!data?.ok) throw new Error(data?.error || "读取模型列表失败");
    return data.registry;
  },
  async saveAIProvider(provider) {
    if (!cloudReady) throw new Error("云端后台不可用");
    const data=await apiPost({action:"admin_ai_provider_save",provider});
    if (!data?.ok) throw new Error(data?.error || "保存中转站失败");
    return data.registry;
  },
  async activateAIProvider(id,model) {
    if (!cloudReady) throw new Error("云端后台不可用");
    const data=await apiPost({action:"admin_ai_provider_activate",id,model});
    if (!data?.ok) throw new Error(data?.error || "切换模型失败");
    return data.registry;
  },
  async deleteAIProvider(id) {
    if (!cloudReady) throw new Error("云端后台不可用");
    const data=await apiPost({action:"admin_ai_provider_delete",id});
    if (!data?.ok) throw new Error(data?.error || "删除中转站失败");
    return data.registry;
  },
  isCloudMode() {
    return cloudReady;
  },

  // 启动时自动探测 Cloudflare KV 云端存储；绑定后自动进入多人云端模式
  async init() {
    // 公开导入单与云端更新互不依赖，并行获取，避免手机上串行等待两次网络请求。
    const importedTask = (async () => {
      try {
        const imported = await fetch("./data/imported-orders.json?v=privacy2", { cache: "no-cache" });
        if (imported.ok) {
          const rows = await imported.json();
          importedOrders = Array.isArray(rows) ? rows : [];
        }
      } catch { importedOrders = []; }
    })();
    const cloudTask = (async () => {
      try {
        const res = await fetch(`${APP_CONFIG.apiBase}/store`, {
          cache: "no-store", signal: AbortSignal.timeout(12000)
        });
        return res.ok ? await res.json() : null;
      } catch {
        // 未绑定 KV 或本地 file:// 打开时平滑回退本地存储。
        return null;
      }
    })();
    const [, data] = await Promise.all([importedTask, cloudTask]);
    if (data?.ok && data.cloud) {
      cloudReady = true;
      cloudState.siteConfig = { ...DEFAULT_SITE_CONFIG, ...(data.siteConfig || {}) };
      // [] 是有效的云端状态：已清空家教单时绝不能恢复演示数据。
      cloudState.orders = Array.isArray(data.orders) ? data.orders : [];
      cloudState.hiddenImported = Array.isArray(data.hiddenImported) ? data.hiddenImported : [];
      cloudState.partTimePosts = Array.isArray(data.partTimePosts) ? data.partTimePosts : [];

      if (localStorage.getItem(KEYS.token)) {
        await this.syncSessionFromCloud();
      }
      return true;
    }
    cloudReady = false;
    return false;
  },

  async syncSessionFromCloud() {
    if (!cloudReady) return;
    try {
      const meRes = await apiPost({ action: "me" });
      if (meRes?.ok && meRes.user) {
        writeJSON(KEYS.session, meRes.user);
        cloudState.myResume = meRes.resume;
        cloudState.applications = meRes.applications || [];
        if (meRes.user.role === "admin") {
          const adm = await apiPost({ action: "admin_data" });
          if (adm?.ok) {
            cloudState.assignments = Array.isArray(adm.assignments) ? adm.assignments : [];
            cloudState.teacherProfiles = Array.isArray(adm.teacherProfiles) ? adm.teacherProfiles : [];
            cloudState.teacherApplications = Array.isArray(adm.teacherApplications) ? adm.teacherApplications : [];
            cloudState.orderSequence = Number(adm.orderSequence) || 2991;
            cloudState.teachers = adm.teachers || [];
            cloudState.applications = adm.applications || [];
            if (Array.isArray(adm.orders)) cloudState.orders = adm.orders;
            if (Array.isArray(adm.hiddenImported)) cloudState.hiddenImported = adm.hiddenImported;
            if (Array.isArray(adm.partTimePosts)) cloudState.partTimePosts = adm.partTimePosts;
            if (adm.siteConfig) cloudState.siteConfig = { ...DEFAULT_SITE_CONFIG, ...adm.siteConfig };
          }
        }
      } else {
        localStorage.removeItem(KEYS.token);
        localStorage.removeItem(KEYS.session);
        cloudState.assignments = [];
        cloudState.teacherProfiles = [];
        cloudState.teacherApplications = [];
      }
    } catch {
      // ignore
    }
  },

  getTeacherProfiles() {
    return cloudReady && this.getCurrentUser()?.role==="admin" ? cloudState.teacherProfiles : [];
  },
  getTeacherApplications() {
    return cloudReady && this.getCurrentUser()?.role==="admin" ? cloudState.teacherApplications : [];
  },
  async saveTeacherProfile(profile) {
    if(!cloudReady || this.getCurrentUser()?.role!=="admin")throw new Error("老师档案只允许云端管理员编辑");
    const response=await apiPost({action:"admin_save_teacher_profile",profile});
    if(!response?.ok)throw new Error(response?.error||"老师档案保存失败");
    cloudState.teacherProfiles=response.teacherProfiles;
    return response.profileId;
  },
  async setTeacherAvailability(teacherId,availability) {
    if(!cloudReady || this.getCurrentUser()?.role!=="admin")throw new Error("请先登录云端管理员");
    const response=await apiPost({action:"admin_set_teacher_availability",teacherId,availability});
    if(!response?.ok)throw new Error(response?.error||"状态更新失败");
    cloudState.teacherProfiles=response.teacherProfiles;
  },
  async deleteTeacherProfile(teacherId) {
    if(!cloudReady || this.getCurrentUser()?.role!=="admin")throw new Error("请先登录云端管理员");
    const response=await apiPost({action:"admin_delete_teacher_profile",teacherId});
    if(!response?.ok)throw new Error(response?.error||"删除失败");
    cloudState.teacherProfiles=response.teacherProfiles;
    cloudState.teacherApplications=response.teacherApplications;
  },
  async saveTeacherApplication(record) {
    if(!cloudReady || this.getCurrentUser()?.role!=="admin")throw new Error("仅云端管理员可关联投递记录");
    const importedOverride=importedOrders.find(o=>o.id===record.orderId);
    const response=await apiPost({action:"admin_save_teacher_application",...record,importedOverride});
    if(!response?.ok)throw new Error(response?.error||"投递记录保存失败");
    cloudState.teacherApplications=response.teacherApplications;
  },
  async deleteTeacherApplication(applicationId) {
    if(!cloudReady || this.getCurrentUser()?.role!=="admin")throw new Error("仅云端管理员可移除投递");
    const response=await apiPost({action:"admin_delete_teacher_application",applicationId});
    if(!response?.ok)throw new Error(response?.error||"删除投递记录失败");
    cloudState.teacherApplications=response.teacherApplications;
  },
  getOrderSequence() {
    return cloudReady ? (cloudState.orderSequence || 2991) : 2991;
  },
  getAssignments() {
    return this.getCurrentUser()?.role === "admin" && cloudReady ? cloudState.assignments : [];
  },
  async saveAssignment(record) {
    if (!cloudReady) throw new Error("老师接单记录需要 Cloudflare KV 云端存储，当前未连接");
    if (this.getCurrentUser()?.role !== "admin") throw new Error("只有管理员可以登记接单老师");
    const importedOverride = importedOrders.find((o) => o.id === record.orderId);
    const res = await apiPost({ action: "admin_save_assignment", ...record, importedOverride });
    if (!res?.ok) throw new Error(res?.error || "老师接单记录保存失败");
    cloudState.assignments = res.assignments;
    if (Array.isArray(res.orders)) cloudState.orders = res.orders;
    return cloudState.assignments;
  },
  async deleteAssignment(assignmentId) {
    if (!cloudReady || this.getCurrentUser()?.role !== "admin") throw new Error("仅云端管理员可以删除匹配记录");
    const res = await apiPost({ action: "admin_delete_assignment", assignmentId });
    if (!res?.ok) throw new Error(res?.error || "删除失败");
    cloudState.assignments = res.assignments;
    return cloudState.assignments;
  },

  getSiteConfig() {
    return cloudReady ? cloudState.siteConfig : readJSON(KEYS.site, DEFAULT_SITE_CONFIG);
  },
  getPartTimePosts() {
    return cloudReady ? cloudState.partTimePosts : readJSON(KEYS.partTime, []);
  },
  async savePartTime(post) {
    if (cloudReady) {
      const res = await apiPost({ action: "admin_save_parttime", post });
      if (!res?.ok) throw new Error(res?.error || "发布失败");
      cloudState.partTimePosts = res.partTimePosts;
      return res.partTimePosts;
    }
    const id = post.id || `pt-${Date.now()}`;
    const current = this.getPartTimePosts();
    const updated = [{ ...post, id, createdAt: current.find((p) => p.id === id)?.createdAt || new Date().toISOString() },
      ...current.filter((p) => p.id !== id)];
    writeJSON(KEYS.partTime, updated);
    return updated;
  },
  async deletePartTime(id) {
    if (cloudReady) {
      const res = await apiPost({ action: "admin_delete_parttime", id });
      if (!res?.ok) throw new Error(res?.error || "删除失败");
      cloudState.partTimePosts = res.partTimePosts;
      return res.partTimePosts;
    }
    const updated = this.getPartTimePosts().filter((p) => p.id !== id);
    writeJSON(KEYS.partTime, updated);
    return updated;
  },
  async updateSiteConfig(patch) {
    if (cloudReady) {
      const res = await apiPost({ action: "admin_update_site", patch });
      if (!res?.ok) throw new Error(res?.error || "网站设置保存失败");
      cloudState.siteConfig = res.siteConfig;
      return cloudState.siteConfig;
    }
    const next = { ...this.getSiteConfig(), ...patch };
    writeJSON(KEYS.site, next);
    return next;
  },

  getOrigin() {
    // 无账号看板：出发地只保存在当前设备，不与管理员登录状态绑定。
    return readJSON(KEYS.origin, { name: "未设置", lat: null, lng: null });
  },
  async setOrigin(loc) {
    writeJSON(KEYS.origin, loc);
    return loc;
  },

  getOrders() {
    // 云端失联时不可展示本机缓存订单或未经核实仍开放的历史单。
    // 避免把已经关闭/设为私密的单子重新公开。
    if (!cloudReady) return [];
    const orders = cloudState.orders;
    const hidden = cloudState.hiddenImported;
    const byId = new Map(importedOrders.filter((o) => !hidden.includes(o.id)).map((o) => [o.id, o]));
    for (const order of Array.isArray(orders) ? orders : []) byId.set(order.id, order);
    return [...byId.values()].filter((o) => !hidden.includes(o.id) && !LEGACY_DEMO_IDS.has(o.id)).map((raw) => {
      const { privateAddress, internalAddress, exactAddress, fullAddress, privateNotes,
        lat, lng, exactLat, exactLng, ...order } = raw;
      const publicAddress = raw.publicAddress || (raw.addressVisibility === "private" ? (raw.district || "地址请咨询") : raw.address);
      return normalizeOrder({ ...order, address: publicAddress, publicAddress });
    });
  },
  async addOrders(newOrders) {
    const normalized = newOrders.map((o) => normalizeOrder(o));
    if (cloudReady) {
      const res = await apiPost({ action: "admin_add_orders", orders: normalized });
      if (!res?.ok) throw new Error(res?.error || "云端发布失败");
      cloudState.orders = res.orders;
      cloudState.orderSequence = Number(res.orderSequence) || cloudState.orderSequence;
      cloudState.hiddenImported = res.hiddenImported || cloudState.hiddenImported;
      return cloudState.orders;
    }
    const merged = [...normalized, ...this.getOrders()];
    writeJSON(KEYS.orders, merged);
    return merged;
  },
  async updateOrder(id, patch) {
    if (cloudReady) {
      const isImported = importedOrders.some((o) => o.id === id);
      const original = isImported ? importedOrders.find((o) => o.id === id) : {};
      const res = await apiPost({ action: "admin_update_order", id, patch: { ...original, ...patch } });
      if (!res?.ok) throw new Error(res?.error || "云端更新失败");
      cloudState.orders = res.orders;
      return cloudState.orders;
    }
    const updated = readJSON(KEYS.orders, SAMPLE_ORDERS).filter((o) => o.id !== id);
    updated.unshift({ ...this.getOrders().find((o) => o.id === id), ...patch, id });
    writeJSON(KEYS.orders, updated);
    return updated;
  },
  async batchUpdateOrderStatus(ids, status) {
    const uniqueIds = [...new Set(ids)].filter(Boolean);
    if (!uniqueIds.length) return this.getOrders();
    if (!["招募中", "已匹配"].includes(status) || uniqueIds.length > 100) throw new Error("批量状态更新参数无效");
    if (cloudReady) {
      // 静态飞书单首次修改必须附带完整公开记录，防止只写入状态时丢失其他字段。
      const importedOverrides = importedOrders.filter((o) => uniqueIds.includes(o.id));
      const res = await apiPost({ action: "admin_batch_status", ids: uniqueIds, status, importedOverrides });
      if (!res?.ok) throw new Error(res?.error || "批量更新失败");
      cloudState.orders = res.orders;
      return this.getOrders();
    }
    const local = readJSON(KEYS.orders, SAMPLE_ORDERS);
    const next = [...local];
    for (const id of uniqueIds) {
      const index = next.findIndex((o) => o.id === id);
      if (index >= 0) next[index] = { ...next[index], status, updatedAt: new Date().toISOString() };
      else {
        const imported = importedOrders.find((o) => o.id === id);
        if (imported) next.unshift({ ...imported, status, updatedAt: new Date().toISOString() });
      }
    }
    writeJSON(KEYS.orders, next);
    return this.getOrders();
  },
  async deleteOrder(id) {
    if (cloudReady) {
      const res = await apiPost({ action: "admin_delete_order", id });
      if (!res?.ok) throw new Error(res?.error || "云端删除失败");
      cloudState.orders = res.orders;
      cloudState.hiddenImported = res.hiddenImported || cloudState.hiddenImported;
      return cloudState.orders;
    }
    if (importedOrders.some((o) => o.id === id)) {
      const hidden = new Set(readJSON(KEYS.hiddenImported, []));
      hidden.add(id);
      writeJSON(KEYS.hiddenImported, [...hidden]);
    }
    const filtered = readJSON(KEYS.orders, SAMPLE_ORDERS).filter((o) => o.id !== id);
    writeJSON(KEYS.orders, filtered);
    return filtered;
  },

  getCurrentUser() {
    return cloudReady ? readJSON(KEYS.session, null) : null;
  },
  getTeachers() {
    if (cloudReady) return cloudState.teachers;
    return readJSON(KEYS.users, [])
      .filter((u) => u.role === "teacher")
      .map(({ passwordHash, ...safe }) => safe);
  },

  async login(email, password) {
    if (!cloudReady) return { ok: false, error: "安全云端服务暂不可用，不能使用本机离线管理员登录" };
    const res = await apiPost({ action: "login", email, password });
    if (!res?.ok) return { ok: false, error: res?.error || "登录失败" };
    localStorage.setItem(KEYS.token, res.token);
    writeJSON(KEYS.session, res.user);
    await this.syncSessionFromCloud();
    return { ok: true, user: res.user };
  },

  async register({ name, wechat, email, password, defaultOrigin }) {
    if (!wechat || !wechat.trim()) return { ok: false, error: "请填写微信号，以便管理员联系派单" };
    if (cloudReady) {
      const res = await apiPost({ action: "register", name, wechat, email, password, defaultOrigin });
      if (!res?.ok) return { ok: false, error: res?.error || "注册失败" };
      localStorage.setItem(KEYS.token, res.token);
      writeJSON(KEYS.session, res.user);
      await this.syncSessionFromCloud();
      return { ok: true, user: res.user };
    }
    const users = readJSON(KEYS.users, []);
    if (users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase())) {
      return { ok: false, error: "该邮箱已注册，请直接登录" };
    }
    const originObj = defaultOrigin || readJSON(KEYS.origin, APP_CONFIG.presetLocations[0]);
    const newUser = {
      id: `teacher-${Date.now()}`,
      email: email.trim().toLowerCase(),
      passwordHash: btoa(password),
      name: name.trim(),
      wechat: wechat.trim(),
      role: "teacher",
      defaultOrigin: originObj,
      createdAt: new Date().toISOString()
    };
    users.push(newUser);
    writeJSON(KEYS.users, users);
    const safeUser = { id: newUser.id, email: newUser.email, name: newUser.name, wechat: newUser.wechat, role: "teacher", defaultOrigin: originObj };
    writeJSON(KEYS.session, safeUser);
    writeJSON(KEYS.origin, originObj);
    return { ok: true, user: safeUser };
  },

  logout() {
    const token = localStorage.getItem(KEYS.token);
    localStorage.removeItem(KEYS.session);
    localStorage.removeItem(KEYS.token);
    if (token && cloudReady) {
      // 通知服务端撤销本次会话；即使离线也先在本机退出。
      void fetch(`${APP_CONFIG.apiBase}/store`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "logout" }),
        cache: "no-store", keepalive: true
      }).catch(() => {});
    }
    cloudState.myResume = null;
    cloudState.teachers = [];
    cloudState.applications = [];
    cloudState.assignments = [];
    cloudState.teacherProfiles = [];
    cloudState.teacherApplications = [];
  },

  getResume(userId) {
    const cur = this.getCurrentUser();
    const base = {
      name: cur?.name || "",
      wechat: cur?.wechat || "",
      school: "",
      major: "",
      subjects: [],
      highlights: "",
      experience: "",
      availableTime: "",
      autoApplyRules: { subjects: [], maxCommuteMin: 45, minRate: 100 }
    };
    if (cloudReady) return { ...base, ...(cloudState.myResume || {}) };
    const all = readJSON(KEYS.resumes, {});
    return { ...base, ...(all[userId] || {}) };
  },

  async saveResume(userId, resume) {
    if (cloudReady) {
      const res = await apiPost({ action: "save_resume", resume });
      if (res?.ok) cloudState.myResume = res.resume;
      return cloudState.myResume;
    }
    const all = readJSON(KEYS.resumes, {});
    all[userId] = { ...resume, updatedAt: new Date().toISOString() };
    writeJSON(KEYS.resumes, all);
    return all[userId];
  },

  getApplications() {
    return cloudReady ? cloudState.applications : readJSON(KEYS.apps, []);
  },
  getUserApplications(userId) {
    return this.getApplications().filter((a) => a.teacherId === userId);
  },

  async applyOrder(payload) {
    if (cloudReady) {
      const res = await apiPost({ action: "apply", ...payload });
      if (res?.ok) cloudState.applications.unshift(res.record);
      return res;
    }
    const apps = this.getApplications();
    if (apps.some((a) => a.orderId === payload.orderId && a.teacherId === payload.teacherId && a.status !== "已撤回")) {
      return { ok: false, error: "你已经投递过该家教单了" };
    }
    const record = {
      id: `APP-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      ...payload,
      status: "已投递",
      teacherNote: "",
      createdAt: new Date().toISOString()
    };
    apps.unshift(record);
    writeJSON(KEYS.apps, apps);
    return { ok: true, record };
  },

  async updateApplication(appId, patch, isAdminAction = false) {
    if (cloudReady) {
      const action = isAdminAction ? "admin_update_app" : "update_my_app";
      await apiPost({ action, appId, patch });
      cloudState.applications = cloudState.applications.map((a) => (a.id === appId ? { ...a, ...patch } : a));
      return cloudState.applications;
    }
    const apps = this.getApplications().map((a) => (a.id === appId ? { ...a, ...patch } : a));
    writeJSON(KEYS.apps, apps);
    return apps;
  },

  getBookmarks() {
    return readJSON(KEYS.bookmarks, []);
  },
  toggleBookmark(orderId) {
    const list = this.getBookmarks();
    const next = list.includes(orderId) ? list.filter((id) => id !== orderId) : [...list, orderId];
    writeJSON(KEYS.bookmarks, next);
    return next;
  },

  getSelectedOrderIds() {
    const stored = readJSON(KEYS.selectedOrders, null);
    // 以前的收藏单可直接沿用为选单，避免用户升级后丢失已保存的意向。
    const ids = Array.isArray(stored) ? stored : readJSON(KEYS.bookmarks, []);
    return Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === "string"))] : [];
  },
  toggleSelectedOrder(orderId) {
    const selected = this.getSelectedOrderIds();
    const next = selected.includes(orderId) ? selected.filter((id) => id !== orderId) : [...selected, orderId];
    writeJSON(KEYS.selectedOrders, next);
    return next;
  },
  setSelectedOrderIds(ids) {
    const available = new Set(this.getOrders().map((o) => o.id));
    const selected = [...new Set(ids)].filter((id) => available.has(id));
    writeJSON(KEYS.selectedOrders, selected);
    return selected;
  },
  clearSelectedOrders() {
    writeJSON(KEYS.selectedOrders, []);
  }
};
