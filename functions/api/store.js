// Cloudflare Pages Function: /api/store
// 基于 Cloudflare KV 的无服务器生产级后端（与 kupars.top 同域，大陆直连快、无需额外服务器）
// 只需在 Cloudflare Pages 绑定名为 TUTOR_KV 的 KV Namespace 即可自动启用多人云端持久化与服务端鉴权。

const DEFAULT_SITE = {
  siteName: "家教招募大厅",
  subtitle: "",
  announcement: "填写你的默认出发地址即可在每张家教单上自动展示骑行与公交耗时，支持一键套用简历模板投递。",
  theme: "indigo",
  contactWechat: ""
};

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
      const [siteConfig, orders] = await Promise.all([
        kvGet(env.TUTOR_KV, "site_config", DEFAULT_SITE),
        kvGet(env.TUTOR_KV, "orders", [])
      ]);
      return jsonResp({ ok: true, cloud: true, siteConfig, orders });
    }

    if (request.method !== "POST") {
      return jsonResp({ ok: false, error: "Method not allowed" }, 405);
    }

    const body = await request.json();
    const { action } = body;
    const secret = env.AUTH_SECRET || env.ADMIN_PASSWORD || "tutor-hub-default-hmac-secret-change-me";
    const authUser = await verifyAuthHeader(request, secret);

    // 1. 注册老师账号（微信号必填）
    if (action === "register") {
      const { name, wechat, email, password, defaultOrigin } = body;
      if (!name?.trim() || !wechat?.trim() || !email?.trim() || !password) {
        return jsonResp({ ok: false, error: "请完整填写姓名、微信号、邮箱和密码" });
      }
      const normEmail = email.trim().toLowerCase();
      const users = await kvGet(env.TUTOR_KV, "users", []);
      if (users.some((u) => u.email === normEmail)) {
        return jsonResp({ ok: false, error: "该邮箱已注册，请直接登录" });
      }
      const passwordHash = await sha256(`${normEmail}:${password}:${secret}`);
      const newUser = {
        id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        email: normEmail,
        passwordHash,
        name: name.trim(),
        wechat: wechat.trim(),
        role: "teacher",
        defaultOrigin: defaultOrigin || null,
        createdAt: new Date().toISOString()
      };
      users.unshift(newUser);
      await kvPut(env.TUTOR_KV, "users", users);

      const safeUser = stripSecret(newUser);
      const token = await signToken({ id: safeUser.id, role: safeUser.role, email: safeUser.email }, secret);
      return jsonResp({ ok: true, user: safeUser, token });
    }

    // 2. 登录（支持管理员账号与注册老师账号）
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

      const users = await kvGet(env.TUTOR_KV, "users", []);
      const expectedHash = await sha256(`${normEmail}:${password}:${secret}`);
      const found = users.find((u) => u.email === normEmail && u.passwordHash === expectedHash);
      if (!found) {
        return jsonResp({ ok: false, error: "邮箱或密码不正确" });
      }
      const safeUser = stripSecret(found);
      const token = await signToken({ id: safeUser.id, role: safeUser.role, email: safeUser.email }, secret);
      return jsonResp({ ok: true, user: safeUser, token });
    }

    // 以下操作均需已登录
    if (!authUser) {
      return jsonResp({ ok: false, error: "登录状态已失效，请重新登录" }, 401);
    }

    // 3. 获取当前用户个人数据（简历 + 自己的投递记录）
    if (action === "me") {
      const [users, resumes, apps] = await Promise.all([
        kvGet(env.TUTOR_KV, "users", []),
        kvGet(env.TUTOR_KV, "resumes", {}),
        kvGet(env.TUTOR_KV, "applications", [])
      ]);
      const me = authUser.role === "admin"
        ? { id: "admin", email: authUser.email, name: "管理员", role: "admin" }
        : stripSecret(users.find((u) => u.id === authUser.id));
      const myApps = apps.filter((a) => a.teacherId === authUser.id);
      return jsonResp({ ok: true, user: me, resume: resumes[authUser.id] || null, applications: myApps });
    }

    // 4. 保存用户默认出发地址
    if (action === "save_origin") {
      if (authUser.role !== "admin") {
        const users = await kvGet(env.TUTOR_KV, "users", []);
        const next = users.map((u) => (u.id === authUser.id ? { ...u, defaultOrigin: body.origin } : u));
        await kvPut(env.TUTOR_KV, "users", next);
      }
      return jsonResp({ ok: true });
    }

    // 5. 保存老师简历与自动投递规则
    if (action === "save_resume") {
      const resumes = await kvGet(env.TUTOR_KV, "resumes", {});
      resumes[authUser.id] = { ...body.resume, updatedAt: new Date().toISOString() };
      await kvPut(env.TUTOR_KV, "resumes", resumes);
      if (body.resume?.wechat) {
        const users = await kvGet(env.TUTOR_KV, "users", []);
        const next = users.map((u) => (u.id === authUser.id ? { ...u, wechat: body.resume.wechat } : u));
        await kvPut(env.TUTOR_KV, "users", next);
      }
      return jsonResp({ ok: true, resume: resumes[authUser.id] });
    }

    // 6. 老师投递家教单
    if (action === "apply") {
      const apps = await kvGet(env.TUTOR_KV, "applications", []);
      if (apps.some((a) => a.orderId === body.orderId && a.teacherId === authUser.id && a.status !== "已撤回")) {
        return jsonResp({ ok: false, error: "你已经投递过该家教单了" });
      }
      const record = {
        id: `APP-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        orderId: body.orderId,
        teacherId: authUser.id,
        teacherName: body.teacherName || "",
        teacherWechat: body.teacherWechat || "",
        pitch: body.pitch || "",
        resumeSnapshot: body.resumeSnapshot || {},
        status: "已投递",
        teacherNote: "",
        isAuto: Boolean(body.isAuto),
        createdAt: new Date().toISOString()
      };
      apps.unshift(record);
      await kvPut(env.TUTOR_KV, "applications", apps);
      return jsonResp({ ok: true, record });
    }

    // 7. 老师修改自己的投递备注或撤回
    if (action === "update_my_app") {
      const apps = await kvGet(env.TUTOR_KV, "applications", []);
      const next = apps.map((a) => {
        if (a.id !== body.appId || a.teacherId !== authUser.id) return a;
        const patch = {};
        if (body.patch?.teacherNote !== undefined) patch.teacherNote = body.patch.teacherNote;
        if (body.patch?.status === "已撤回") patch.status = "已撤回";
        return { ...a, ...patch };
      });
      await kvPut(env.TUTOR_KV, "applications", next);
      return jsonResp({ ok: true });
    }

    // ---------------- 以下为严格管理员权限接口 ----------------
    if (authUser.role !== "admin") {
      return jsonResp({ ok: false, error: "无管理员权限" }, 403);
    }

    if (action === "admin_data") {
      const [users, apps, orders, siteConfig] = await Promise.all([
        kvGet(env.TUTOR_KV, "users", []),
        kvGet(env.TUTOR_KV, "applications", []),
        kvGet(env.TUTOR_KV, "orders", []),
        kvGet(env.TUTOR_KV, "site_config", DEFAULT_SITE)
      ]);
      return jsonResp({
        ok: true,
        teachers: users.filter((u) => u.role === "teacher").map(stripSecret),
        applications: apps,
        orders,
        siteConfig
      });
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
      if (!existing.some((o) => o.id === body.id)) return jsonResp({ ok: false, error: "找不到该家教单" }, 404);
      const next = existing.map((o) => (o.id === body.id ? { ...o, ...body.patch } : o));
      await kvPut(env.TUTOR_KV, "orders", next);
      return jsonResp({ ok: true, orders: next });
    }

    if (action === "admin_delete_order") {
      const existing = await kvGet(env.TUTOR_KV, "orders", []);
      if (!existing.some((o) => o.id === body.id)) return jsonResp({ ok: false, error: "家教单不存在或已删除" }, 404);
      const next = existing.filter((o) => o.id !== body.id);
      await kvPut(env.TUTOR_KV, "orders", next);
      return jsonResp({ ok: true, orders: next });
    }

    if (action === "admin_update_app") {
      const apps = await kvGet(env.TUTOR_KV, "applications", []);
      const next = apps.map((a) => (a.id === body.appId ? { ...a, ...body.patch } : a));
      await kvPut(env.TUTOR_KV, "applications", next);
      return jsonResp({ ok: true, applications: next });
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

async function kvGet(kv, key, fallback) {
  const raw = await kv.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function kvPut(kv, key, val) {
  await kv.put(key, JSON.stringify(val));
}

function stripSecret(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
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
