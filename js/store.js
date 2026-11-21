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
  origin: "tutorhub_origin_v3"
};

let cloudReady = false;
let cloudState = {
  siteConfig: DEFAULT_SITE_CONFIG,
  orders: SAMPLE_ORDERS,
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

function ensureLocalInit() {
  if (!localStorage.getItem(KEYS.orders)) writeJSON(KEYS.orders, SAMPLE_ORDERS);
  if (!localStorage.getItem(KEYS.site)) writeJSON(KEYS.site, DEFAULT_SITE_CONFIG);
  if (!localStorage.getItem(KEYS.users)) {
    writeJSON(KEYS.users, [
      {
        id: "admin-1",
        email: "admin@kupars.top",
        passwordHash: btoa("admin123456"),
        name: "管理员",
        wechat: "",
        role: "admin",
        defaultOrigin: APP_CONFIG.presetLocations[0],
        createdAt: "2026-11-01T00:00:00Z"
      },
      {
        id: "teacher-1",
        email: "teacher@tju.edu.cn",
        passwordHash: btoa("123456"),
        name: "林同学",
        wechat: "lin_tutor_tju",
        role: "teacher",
        defaultOrigin: APP_CONFIG.presetLocations[0],
        createdAt: "2026-11-10T00:00:00Z"
      }
    ]);
  }
  if (!localStorage.getItem(KEYS.resumes)) writeJSON(KEYS.resumes, {});
  if (!localStorage.getItem(KEYS.apps)) writeJSON(KEYS.apps, []);
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
  isCloudMode() {
    return cloudReady;
  },

  // 启动时自动探测 Cloudflare KV 云端存储；绑定后自动进入多人云端模式
  async init() {
    try {
      const res = await fetch(`${APP_CONFIG.apiBase}/store`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data?.ok && data.cloud) {
          cloudReady = true;
          cloudState.siteConfig = { ...DEFAULT_SITE_CONFIG, ...(data.siteConfig || {}) };
          // [] 是有效的云端状态：已清空家教单时绝不能恢复演示数据。
          cloudState.orders = Array.isArray(data.orders) ? data.orders : [];

          if (localStorage.getItem(KEYS.token)) {
            await this.syncSessionFromCloud();
          }
          return true;
        }
      }
    } catch {
      // 未绑定 KV 或本地 file:// 打开时平滑回退本地存储
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
            cloudState.teachers = adm.teachers || [];
            cloudState.applications = adm.applications || [];
            if (Array.isArray(adm.orders)) cloudState.orders = adm.orders;
            if (adm.siteConfig) cloudState.siteConfig = { ...DEFAULT_SITE_CONFIG, ...adm.siteConfig };
          }
        }
      } else {
        localStorage.removeItem(KEYS.token);
        localStorage.removeItem(KEYS.session);
      }
    } catch {
      // ignore
    }
  },

  getSiteConfig() {
    return cloudReady ? cloudState.siteConfig : readJSON(KEYS.site, DEFAULT_SITE_CONFIG);
  },
  async updateSiteConfig(patch) {
    if (cloudReady) {
      const res = await apiPost({ action: "admin_update_site", patch });
      if (res?.ok) cloudState.siteConfig = res.siteConfig;
      return cloudState.siteConfig;
    }
    const next = { ...this.getSiteConfig(), ...patch };
    writeJSON(KEYS.site, next);
    return next;
  },

  getOrigin() {
    const user = this.getCurrentUser();
    if (user?.defaultOrigin?.name) return user.defaultOrigin;
    return readJSON(KEYS.origin, APP_CONFIG.presetLocations[0]);
  },
  async setOrigin(loc) {
    writeJSON(KEYS.origin, loc);
    const user = this.getCurrentUser();
    if (user) {
      writeJSON(KEYS.session, { ...user, defaultOrigin: loc });
      if (cloudReady) {
        await apiPost({ action: "save_origin", origin: loc }).catch(() => {});
      } else {
        const users = readJSON(KEYS.users, []).map((u) => (u.id === user.id ? { ...u, defaultOrigin: loc } : u));
        writeJSON(KEYS.users, users);
      }
    }
    return loc;
  },

  getOrders() {
    const orders = cloudReady ? cloudState.orders : readJSON(KEYS.orders, SAMPLE_ORDERS);
    return Array.isArray(orders) ? orders.map((o) => normalizeOrder(o)) : [];
  },
  async addOrders(newOrders) {
    const normalized = newOrders.map((o) => normalizeOrder(o));
    if (cloudReady) {
      const res = await apiPost({ action: "admin_add_orders", orders: normalized });
      if (!res?.ok) throw new Error(res?.error || "云端发布失败");
      cloudState.orders = res.orders;
      return cloudState.orders;
    }
    const merged = [...normalized, ...this.getOrders()];
    writeJSON(KEYS.orders, merged);
    return merged;
  },
  async updateOrder(id, patch) {
    if (cloudReady) {
      const res = await apiPost({ action: "admin_update_order", id, patch });
      if (!res?.ok) throw new Error(res?.error || "云端更新失败");
      cloudState.orders = res.orders;
      return cloudState.orders;
    }
    const updated = this.getOrders().map((o) => (o.id === id ? { ...o, ...patch } : o));
    writeJSON(KEYS.orders, updated);
    return updated;
  },
  async deleteOrder(id) {
    if (cloudReady) {
      const res = await apiPost({ action: "admin_delete_order", id });
      if (!res?.ok) throw new Error(res?.error || "云端删除失败");
      cloudState.orders = res.orders;
      return cloudState.orders;
    }
    const filtered = this.getOrders().filter((o) => o.id !== id);
    writeJSON(KEYS.orders, filtered);
    return filtered;
  },

  getCurrentUser() {
    return readJSON(KEYS.session, null);
  },
  getTeachers() {
    if (cloudReady) return cloudState.teachers;
    return readJSON(KEYS.users, [])
      .filter((u) => u.role === "teacher")
      .map(({ passwordHash, ...safe }) => safe);
  },

  async login(email, password) {
    if (cloudReady) {
      const res = await apiPost({ action: "login", email, password });
      if (!res?.ok) return { ok: false, error: res?.error || "登录失败" };
      localStorage.setItem(KEYS.token, res.token);
      writeJSON(KEYS.session, res.user);
      await this.syncSessionFromCloud();
      return { ok: true, user: res.user };
    }
    const users = readJSON(KEYS.users, []);
    const found = users.find(
      (u) => (u.email.toLowerCase() === email.trim().toLowerCase() || (email.trim().toLowerCase() === "admin@tutorhub.cn" && u.role === "admin")) &&
        u.passwordHash === btoa(password)
    );
    if (!found) return { ok: false, error: "邮箱或密码不正确" };
    const safeUser = {
      id: found.id,
      email: found.email,
      name: found.name,
      wechat: found.wechat || "",
      role: found.role,
      defaultOrigin: found.defaultOrigin || readJSON(KEYS.origin, APP_CONFIG.presetLocations[0])
    };
    writeJSON(KEYS.session, safeUser);
    return { ok: true, user: safeUser };
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
    localStorage.removeItem(KEYS.session);
    localStorage.removeItem(KEYS.token);
    cloudState.myResume = null;
    cloudState.teachers = [];
    cloudState.applications = [];
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
  }
};
