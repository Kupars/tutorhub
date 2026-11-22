// Cloudflare Pages Function: /api/store
// 基于 Cloudflare KV 的无服务器生产级后端（与 kupars.top 同域，大陆直连快、无需额外服务器）
// 只需在 Cloudflare Pages 绑定名为 TUTOR_KV 的 KV Namespace 即可自动启用多人云端持久化与服务端鉴权。

const DEFAULT_SITE = {
  siteName: "家教招募大厅",
  subtitle: "",
  announcement: "选中感兴趣的家教单加入清单，复制后微信联系小木同学。",
  theme: "indigo",
  contactWechat: ""
};
// 用户要求移除早期虚构的五条 JJ 家教演示数据。仅匹配这五个确定的旧 ID。
const LEGACY_DEMO_IDS = new Set(["JJ-2026-101", "JJ-2026-102", "JJ-2026-103", "JJ-2026-104", "JJ-2026-105"]);

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  if (!env.TUTOR_KV) {
    return jsonResp({ ok: false, code: "NO_KV", error: "尚未绑定 TUTOR_KV 存储空间" }, 200);
  }

  try {
    if (request.method === "GET") {
      const [siteConfig, orders, hiddenImported, partTimePosts] = await Promise.all([
        kvGet(env.TUTOR_KV, "site_config", DEFAULT_SITE),
        kvGet(env.TUTOR_KV, "orders", []),
        kvGet(env.TUTOR_KV, "hidden_imported_orders", []),
        kvGet(env.TUTOR_KV, "part_time_posts", [])
      ]);
      const realOrders = orders.filter((order) => !LEGACY_DEMO_IDS.has(order.id));
      if (realOrders.length !== orders.length) {
        // 幂等的特定演示数据清理；保留所有真实用户创建的记录。
        await kvPut(env.TUTOR_KV, "orders", realOrders);
      }
      return jsonResp({ ok: true, cloud: true, siteConfig, orders: realOrders.map(toPublicOrder), hiddenImported,
        partTimePosts: partTimePosts.map(toPublicPartTime) });
    }

    if (request.method !== "POST") {
      return jsonResp({ ok: false, error: "Method not allowed" }, 405);
    }

    const body = await request.json();
    const { action } = body;
    const secret = env.AUTH_SECRET || env.ADMIN_PASSWORD || "tutor-hub-default-hmac-secret-change-me";
    const authUser = await verifyAuthHeader(request, secret);

    // 老师端账号、简历与投递功能已下线；历史 KV 数据保留，不做破坏性删除。
    if (["register", "save_origin", "save_resume", "apply", "update_my_app", "admin_update_app"].includes(action)) {
      return jsonResp({ ok: false, error: "该功能已下线，请在家教看板选单后微信联系小木同学" }, 410);
    }


    // 管理员专用登录
    if (action === "login") {
      const { email, password } = body;
      const normEmail = (email || "").trim().toLowerCase();
      const adminEmail = (env.ADMIN_EMAIL || "admin@tutor.kupars.top").toLowerCase();
      const adminPass = env.ADMIN_PASSWORD || "admin123456";

      if (
        (normEmail === adminEmail || normEmail === "admin@kupars.top" || normEmail === "admin@tutorhub.cn") &&
        password === adminPass
      ) {
        const adminUser = { id: "admin", email: normEmail, name: "管理员", wechat: "", role: "admin" };
        const token = await signToken({ id: "admin", role: "admin", email: normEmail }, secret);
        return jsonResp({ ok: true, user: adminUser, token });
      }

      return jsonResp({ ok: false, error: "管理员邮箱或密码不正确" }, 401);
    }

    // 以下只允许管理员使用；普通老师浏览与选单无需登录。
    if (!authUser) {
      return jsonResp({ ok: false, error: "登录状态已失效，请重新登录" }, 401);
    }
    if (authUser.role !== "admin") {
      return jsonResp({ ok: false, error: "仅管理员可以操作后台" }, 403);
    }

    if (action === "me") {
      return jsonResp({ ok: true, user: { id: "admin", email: authUser.email, name: "管理员", role: "admin" } });
    }

    // ---------------- 以下为严格管理员权限接口 ----------------
    if (authUser.role !== "admin") {
      return jsonResp({ ok: false, error: "无管理员权限" }, 403);
    }

    if (action === "admin_data") {
      const [orders, siteConfig, hiddenImported, partTimePosts] = await Promise.all([
        kvGet(env.TUTOR_KV, "orders", []),
        kvGet(env.TUTOR_KV, "site_config", DEFAULT_SITE),
        kvGet(env.TUTOR_KV, "hidden_imported_orders", []),
        kvGet(env.TUTOR_KV, "part_time_posts", [])
      ]);
      return jsonResp({
        ok: true,
        orders,
        siteConfig,
        hiddenImported,
        partTimePosts
      });
    }

    if (action === "admin_save_parttime") {
      const p = body.post || {};
      if (![p.title, p.time, p.location, p.content].every((x) => typeof x === "string" && x.trim())) {
        return jsonResp({ ok: false, error: "请填写兼职标题、时间、地点和详细内容" }, 400);
      }
      const posts = await kvGet(env.TUTOR_KV, "part_time_posts", []);
      const id = String(p.id || `pt-${crypto.randomUUID()}`);
      const entry = { id, title: p.title.trim().slice(0, 120), time: p.time.trim().slice(0, 150),
        location: p.location.trim().slice(0, 200), content: p.content.trim().slice(0, 4000),
        createdAt: posts.find((post) => post.id === id)?.createdAt || new Date().toISOString() };
      const next = [entry, ...posts.filter((post) => post.id !== id)];
      await kvPut(env.TUTOR_KV, "part_time_posts", next);
      return jsonResp({ ok: true, partTimePosts: next });
    }

    if (action === "admin_delete_parttime") {
      const posts = await kvGet(env.TUTOR_KV, "part_time_posts", []);
      const next = posts.filter((post) => post.id !== body.id);
      await kvPut(env.TUTOR_KV, "part_time_posts", next);
      return jsonResp({ ok: true, partTimePosts: next });
    }

    if (action === "admin_add_orders") {
      if (!Array.isArray(body.orders) || !body.orders.length || body.orders.length > 100) {
        return jsonResp({ ok: false, error: "请提供 1～100 条有效家教单" }, 400);
      }
      const existing = await kvGet(env.TUTOR_KV, "orders", []);
      const incomingIds = body.orders.map((o) => String(o.id || ""));
      if (incomingIds.some((id) => !id || id.length > 50) || new Set(incomingIds).size !== incomingIds.length ||
          incomingIds.some((id) => existing.some((item) => item.id === id))) {
        return jsonResp({ ok: false, error: "家教单编号为空或与已有单重复，请确认编号后发布" }, 409);
      }
      const merged = [...(body.orders || []), ...existing];
      await kvPut(env.TUTOR_KV, "orders", merged);
      return jsonResp({ ok: true, orders: merged });
    }

    if (action === "admin_update_order") {
      const existing = await kvGet(env.TUTOR_KV, "orders", []);
      const already = existing.some((o) => o.id === body.id);
      // 飞书静态导入单使用独立内部 ID；首次编辑时新增覆盖记录，不变更公开单号。
      if (!already && !/^fs-\d{4,}$/.test(String(body.id))) return jsonResp({ ok: false, error: "找不到该家教单" }, 404);
      const next = already ? existing.map((o) => (o.id === body.id ? { ...o, ...body.patch, id: body.id } : o))
        : [{ ...body.patch, id: body.id }, ...existing];
      await kvPut(env.TUTOR_KV, "orders", next);
      return jsonResp({ ok: true, orders: next });
    }

    if (action === "admin_delete_order") {
      const existing = await kvGet(env.TUTOR_KV, "orders", []);
      const imported = /^fs-\d{4,}$/.test(String(body.id));
      if (!imported && !existing.some((o) => o.id === body.id)) return jsonResp({ ok: false, error: "家教单不存在或已删除" }, 404);
      const next = existing.filter((o) => o.id !== body.id);
      await kvPut(env.TUTOR_KV, "orders", next);
      const hiddenImported = await kvGet(env.TUTOR_KV, "hidden_imported_orders", []);
      if (imported && !hiddenImported.includes(body.id)) {
        hiddenImported.push(body.id);
        await kvPut(env.TUTOR_KV, "hidden_imported_orders", hiddenImported);
      }
      return jsonResp({ ok: true, orders: next, hiddenImported });
    }

    if (action === "admin_update_site") {
      const cur = await kvGet(env.TUTOR_KV, "site_config", DEFAULT_SITE);
      const next = { ...cur, ...body.patch };
      await kvPut(env.TUTOR_KV, "site_config", next);
      return jsonResp({ ok: true, siteConfig: next });
    }

    return jsonResp({ ok: false, error: "Unknown action" }, 400);
  } catch (err) {
    return jsonResp({ ok: false, error: String(err?.message || err) }, 500);
  }
}

// 无权限的 GET 只提供允许公开展示的字段；精确坐标和后台内部地址不出现在响应里。
function toPublicOrder(order) {
  const fields = ["id", "orderNumber", "title", "grade", "studentGender", "subject",
    "teacherCount", "currentScores", "district", "weeklyFrequency", "sessionsPerWeek",
    "hoursPerSession", "requirements", "salaryText", "hourlyRate", "mode", "onlineAllowed",
    "trialTime", "urgent", "status", "createdAt", "tags", "genderPref"];
  const safe = Object.fromEntries(fields.filter((k) => order[k] !== undefined).map((k) => [k, order[k]]));
  safe.address = order.publicAddress || (order.addressVisibility === "private"
    ? (order.district || "地址请咨询小木同学") : (order.address || "地址待补充"));
  safe.publicAddress = safe.address;
  // 旧版数据将标准九字段误塞入 studentInfo，且将“要求】”和薪资拼到 requirements。
  // 在服务端从原本公开的标准单中恢复展示字段，但不把 studentInfo 或内部地址传回前端。
  const legacyText = String(order.studentInfo || "");
  if (legacyText.includes("【年级性别】") && legacyText.includes("【补习科目】") &&
      (/^】/.test(String(order.address || "")) || /要求】/.test(String(order.requirements || "")))) {
    const fields = Object.fromEntries([...legacyText.matchAll(/【([^】]+)】([^\n\r]*)/g)]
      .map((match) => [match[1], match[2].trim()]));
    safe.subject = fields["补习科目"] || safe.subject;
    safe.currentScores = fields["现阶段成绩"] || safe.currentScores;
    safe.weeklyFrequency = fields["一周几次"] || safe.weeklyFrequency;
    const gender = fields["年级性别"]?.match(/(男孩|男生|女孩|女生)/)?.[1];
    if (gender) safe.studentGender = gender.startsWith("男") ? "男生" : "女生";
    const grades = ["高三", "高二", "高一", "初三", "初二", "初一", "小学", "六年级", "五年级", "四年级", "三年级"];
    const grade = grades.find((g) => (fields["年级性别"] || "").includes(g));
    if (grade) safe.grade = grade;
    safe.requirements = fields["对老师要求"] || String(order.requirements || "").replace(/^.*?要求】/, "").replace(/【薪资】[\s\S]*$/, "").trim() || safe.requirements;
    safe.salaryText = fields["薪资"] || String(order.requirements || "").match(/【薪资】\s*([^\n]*)/)?.[1] || safe.salaryText;
    const h = fields["每次几小时"]?.match(/\d+(?:\.\d+)?/);
    if (h) safe.hoursPerSession = Number(h[0]);
    const n = fields["需要几个老师"]?.match(/\d+/);
    if (n) safe.teacherCount = Number(n[0]);
    if (fields["补课地址"]) {
      safe.address = fields["补课地址"];
      safe.publicAddress = safe.address;
    }
  }
  return safe;
}

function toPublicPartTime(post) {
  return { id: post.id, title: post.title, time: post.time, location: post.location,
    content: post.content, createdAt: post.createdAt };
}

async function kvGet(kv, key, fallback) {
  const raw = await kv.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function kvPut(kv, key, val) {
  await kv.put(key, JSON.stringify(val));
}

async function sha256(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signToken(payload, secret) {
  const data = btoa(unescape(encodeURIComponent(JSON.stringify({ ...payload, exp: Date.now() + 7 * 86400_000 }))));
  const sig = await sha256(`${data}.${secret}`);
  return `${data}.${sig}`;
}

async function verifyAuthHeader(request, secret) {
  const h = request.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expected = await sha256(`${data}.${secret}`);
  if (sig !== expected) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(escape(atob(data))));
    if (parsed.exp && parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization"
  };
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() }
  });
}
