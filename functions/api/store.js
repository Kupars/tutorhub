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
      const [orders, siteConfig] = await Promise.all([
        kvGet(env.TUTOR_KV, "orders", []),
        kvGet(env.TUTOR_KV, "site_config", DEFAULT_SITE)
      ]);
      return jsonResp({
        ok: true,
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
