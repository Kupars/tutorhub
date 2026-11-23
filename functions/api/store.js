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
// 用户要求移除 JJ 家教测试单：五条早期演示 + 三条现场确认的云端残留。仅匹配确定的旧 ID。
const LEGACY_DEMO_IDS = new Set(["JJ-2026-101", "JJ-2026-102", "JJ-2026-103", "JJ-2026-104", "JJ-2026-105",
  "JJ-2026-4737", "JJ-2026-4738", "JJ-2026-888"]);

function isPubliclyOpenOrder(order) {
  return !/(?:已匹配|已关闭|关闭|已结束|结束|已完成|已招满|招满|已下架|下架|已取消|取消|停止招募|暂停招募)/
    .test(String(order?.status || "").trim());
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    // 浏览器中本域 fetch 不需要开放给其他网站的跨域凭据读取。
    return new Response(null, { status: 204, headers: { "Allow": "GET, POST, OPTIONS", "Cache-Control": "no-store" } });
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
      // 后台关闭的订单不发送给公共 API；静态飞书导入单需要额外屏蔽其原始 ID，避免刷新后复活。
      const publiclyOpen = realOrders.filter(isPubliclyOpenOrder);
      const closedIds = realOrders.filter((order) => !isPubliclyOpenOrder(order)).map((order) => order.id);
      const publicHidden = [...new Set([...hiddenImported, ...closedIds])];
      return jsonResp({ ok: true, cloud: true, siteConfig: toPublicSiteConfig(siteConfig), orders: publiclyOpen.map(toPublicOrder), hiddenImported: publicHidden,
        partTimePosts: partTimePosts.map(toPublicPartTime) });
    }

    if (request.method !== "POST") {
      return jsonResp({ ok: false, error: "Method not allowed" }, 405);
    }
    const origin = request.headers.get("Origin");
    if (origin && origin !== new URL(request.url).origin) {
      return jsonResp({ ok: false, error: "仅允许从本站操作管理员接口" }, 403);
    }
    // 不再按字符长度拒绝管理员凭据，但两项必须显式配置且不能为空。
    // 保留服务端邮箱/密码鉴权、HMAC 会话签名和登录限速，绝不开放匿名后台。
    if (!String(env.ADMIN_PASSWORD ?? "").trim() || !String(env.AUTH_SECRET ?? "").trim()) {
      return jsonResp({ ok: false, code: "ADMIN_SECURITY_NOT_CONFIGURED",
        error: "管理员登录未配置：请在 Cloudflare 设置 ADMIN_PASSWORD 和 AUTH_SECRET（已取消最小长度限制）" }, 503);
    }
    const body = await request.json();
    const { action } = body;
    const secret = String(env.AUTH_SECRET);
    const authUser = await verifyAuthHeader(request, secret, env.TUTOR_KV);

    // 老师端账号、简历与投递功能已下线；历史 KV 数据保留，不做破坏性删除。
    if (["register", "save_origin", "save_resume", "apply", "update_my_app", "admin_update_app"].includes(action)) {
      return jsonResp({ ok: false, error: "该功能已下线，请在家教看板选单后微信联系小木同学" }, 410);
    }


    // 管理员专用登录
    if (action === "login") {
      const { email, password } = body;
      const normEmail = (email || "").trim().toLowerCase();
      const adminEmail = String(env.ADMIN_EMAIL || "admin@tutor.kupars.top").trim().toLowerCase();
      const ipHash = await sha256(String(request.headers.get("CF-Connecting-IP") || "unknown"));
      const key = "auth_failure_" + ipHash;
      const failures = await kvGet(env.TUTOR_KV, key, { count: 0, start: 0 });
      const now = Date.now();
      const count = now - (Number(failures.start)||0) < 900000 ? Number(failures.count)||0 : 0;
      if (count >= 8) return jsonResp({ ok: false, error: "登录尝试次数过多，请15分钟后再试" }, 429);
      if (normEmail === adminEmail && typeof password === "string" && password === env.ADMIN_PASSWORD) {
        await env.TUTOR_KV.put(key, JSON.stringify({ count: 0, start: now }), { expirationTtl: 60 });
        const adminUser = { id: "admin", email: normEmail, name: "管理员", role: "admin" };
        const token = await signToken({ id: "admin", role: "admin", email: normEmail }, secret);
        return jsonResp({ ok: true, user: adminUser, token });
      }
      await env.TUTOR_KV.put(key, JSON.stringify({
        count: count + 1, start: count ? failures.start : now
      }), { expirationTtl: 900 });
      return jsonResp({ ok: false, error: "管理员邮箱或密码不正确" }, 401);
    }

    // 以下只允许管理员使用；普通老师浏览与选单无需登录。
    if (!authUser) {
      return jsonResp({ ok: false, error: "登录状态已失效，请重新登录" }, 401);
    }
    if (authUser.role !== "admin") {
      return jsonResp({ ok: false, error: "仅管理员可以操作后台" }, 403);
    }

    if (action === "logout") {
      if (authUser.jti) {
        await env.TUTOR_KV.put("revoked_session_" + authUser.jti,
          "1", { expirationTtl: 7200 });
      }
      return jsonResp({ ok: true });
    }
    if (action === "me") {
      return jsonResp({ ok: true, user: { id: "admin", email: authUser.email, name: "管理员", role: "admin" } });
    }

    // ---------------- 以下为严格管理员权限接口 ----------------
    if (authUser.role !== "admin") {
      return jsonResp({ ok: false, error: "无管理员权限" }, 403);
    }

    if (action === "admin_data") {
      const [orders, siteConfig, hiddenImported, partTimePosts, assignments, sequence, teacherProfiles, teacherApplications] = await Promise.all([
        kvGet(env.TUTOR_KV, "orders", []),
        kvGet(env.TUTOR_KV, "site_config", DEFAULT_SITE),
        kvGet(env.TUTOR_KV, "hidden_imported_orders", []),
        kvGet(env.TUTOR_KV, "part_time_posts", []),
        kvGet(env.TUTOR_KV, "teacher_assignments", []),
        kvGet(env.TUTOR_KV, "order_sequence", 2991),
        kvGet(env.TUTOR_KV, "teacher_profiles", []),
        kvGet(env.TUTOR_KV, "teacher_applications", [])
      ]);
      return jsonResp({
        ok: true,
        orders,
        siteConfig,
        hiddenImported,
        partTimePosts,
        assignments: env.AUTH_SECRET && env.ADMIN_PASSWORD ? assignments : [],
        teacherProfiles: env.AUTH_SECRET && env.ADMIN_PASSWORD ? teacherProfiles : [],
        teacherApplications: env.AUTH_SECRET && env.ADMIN_PASSWORD ? teacherApplications : [],
        orderSequence: Math.max(2991, Number(sequence) || 0, ...orders.map((o) => Number(String(o.orderNumber || o.id).match(/^#?(\d{3,7})/)?.[1]) || 0))
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

    // 教师姓名和联系信息只保存在独立的管理员 KV 记录中，绝不随公开 GET 输出。
    // 由管理员手动登记；无教师自助注册、无位置追踪。
    // 管理员老师储备池：与具体订单无关，可先收简历后按学科、区域、状态推荐。
    // 个人资料与投递记录只随 admin_data 返回，从不放进公共 GET。
    if (action === "admin_save_teacher_profile") {
      if (!env.AUTH_SECRET || !env.ADMIN_PASSWORD) return jsonResp({ok:false,error:"请先配置 ADMIN_PASSWORD 与独立 AUTH_SECRET 才能保存老师档案"},503);
      const raw=body.profile && typeof body.profile==="object"?body.profile:{};
      const name=String(raw.name||"").trim();
      if (!name || name.length>80) return jsonResp({ok:false,error:"请填写老师姓名（不超过80字）"},400);
      const statuses=["可接单","已接满","暂不接单","待确认"];
      const genders=["男","女","未知"];
      const types=["在校生","专职老师","未知"];
      if (raw.gender && !genders.includes(raw.gender)) return jsonResp({ok:false,error:"老师性别选项无效"},400);
      if (raw.availability && !statuses.includes(raw.availability)) return jsonResp({ok:false,error:"接单状态选项无效"},400);
      if (raw.teacherType && !types.includes(raw.teacherType)) return jsonResp({ok:false,error:"教师类型选项无效"},400);
      const records=await kvGet(env.TUTOR_KV,"teacher_profiles",[]);
      const id=String(raw.id||"").trim();
      const original=id?records.find(o=>o.id===id):null;
      if(id && !original) return jsonResp({ok:false,error:"老师档案不存在，请刷新后重试"},404);
      for(const key of ["school","contact","agentName","canTeach","preferredDistricts","note"]) {
        if(raw[key]!=null && (typeof raw[key]!=="string" || raw[key].length>(key==="note"?800:300)))
          return jsonResp({ok:false,error:"老师档案字段长度超限："+key},400);
      }
      const now=new Date().toISOString();
      const profile={
        id:original?.id||"tp-"+crypto.randomUUID(),
        name,school:String(raw.school||"").trim().slice(0,120),
        gender:raw.gender||"未知",teacherType:raw.teacherType||"未知",
        canTeach:String(raw.canTeach||"").trim().slice(0,200),
        preferredDistricts:String(raw.preferredDistricts||"").trim().slice(0,200),
        availability:raw.availability||"待确认",
        contact:String(raw.contact||"").trim().slice(0,150),
        agentName:String(raw.agentName||"").trim().slice(0,100),
        note:String(raw.note||"").trim().slice(0,800),
        createdAt:original?.createdAt||now,updatedAt:now
      };
      const next=[profile,...records.filter(o=>o.id!==profile.id)];
      await kvPut(env.TUTOR_KV,"teacher_profiles",next);
      return jsonResp({ok:true,teacherProfiles:next,profileId:profile.id});
    }
    if (action === "admin_set_teacher_availability") {
      if (!env.AUTH_SECRET || !env.ADMIN_PASSWORD) return jsonResp({ok:false,error:"管理员个人资料存储未启用"},503);
      const statuses=["可接单","已接满","暂不接单","待确认"];
      if(!statuses.includes(body.availability))return jsonResp({ok:false,error:"老师状态无效"},400);
      const profiles=await kvGet(env.TUTOR_KV,"teacher_profiles",[]);
      if(!profiles.some(p=>p.id===body.teacherId))return jsonResp({ok:false,error:"找不到老师档案"},404);
      const next=profiles.map(p=>p.id===body.teacherId?{...p,availability:body.availability,updatedAt:new Date().toISOString()}:p);
      await kvPut(env.TUTOR_KV,"teacher_profiles",next);
      return jsonResp({ok:true,teacherProfiles:next});
    }
    if (action === "admin_delete_teacher_profile") {
      if (!env.AUTH_SECRET || !env.ADMIN_PASSWORD) return jsonResp({ok:false,error:"管理员个人资料存储未启用"},503);
      const profiles=await kvGet(env.TUTOR_KV,"teacher_profiles",[]);
      const applications=await kvGet(env.TUTOR_KV,"teacher_applications",[]);
      if(!profiles.some(p=>p.id===body.teacherId))return jsonResp({ok:false,error:"找不到老师档案"},404);
      const nextProfiles=profiles.filter(p=>p.id!==body.teacherId);
      const nextApplications=applications.filter(c=>c.teacherId!==body.teacherId);
      await kvPut(env.TUTOR_KV,"teacher_profiles",nextProfiles);
      await kvPut(env.TUTOR_KV,"teacher_applications",nextApplications);
      return jsonResp({ok:true,teacherProfiles:nextProfiles,teacherApplications:nextApplications});
    }
    if (action === "admin_save_teacher_application") {
      if (!env.AUTH_SECRET || !env.ADMIN_PASSWORD) return jsonResp({ok:false,error:"管理员个人资料存储未启用"},503);
      const orderId=String(body.orderId||"").trim(),teacherId=String(body.teacherId||"").trim();
      const profiles=await kvGet(env.TUTOR_KV,"teacher_profiles",[]);
      if(!profiles.some(p=>p.id===teacherId))return jsonResp({ok:false,error:"先把老师存入档案库"},404);
      const orders=await kvGet(env.TUTOR_KV,"orders",[]);
      const override=body.importedOverride;
      const order=orders.find(o=>o.id===orderId)||
        (/^fs-\d{4,}$/.test(orderId)&&override?.id===orderId?override:null);
      if(!order)return jsonResp({ok:false,error:"找不到这条家教单，请刷新后台重试"},404);
      const applications=await kvGet(env.TUTOR_KV,"teacher_applications",[]);
      const recordId=String(body.applicationId||"").trim();
      const existing=recordId?applications.find(x=>x.id===recordId):applications.find(x=>x.teacherId===teacherId && x.orderId===orderId);
      if(recordId&&!existing)return jsonResp({ok:false,error:"该条投递记录不存在"},404);
      const status=String(body.status||"已投递");
      if(!["已投递","待联系","沟通中","试课中","已接单","未录用"].includes(status))
        return jsonResp({ok:false,error:"投递进展选项无效"},400);
      const agent=String(body.agentName||"").trim(),note=String(body.note||"").trim();
      if(agent.length>100||note.length>500)return jsonResp({ok:false,error:"代理名称或备注过长"},400);
      const now=new Date().toISOString();
      const item={id:existing?.id||"ta-"+crypto.randomUUID(),orderId,teacherId,status,
        agentName:agent,note,createdAt:existing?.createdAt||now,updatedAt:now};
      const next=[item,...applications.filter(x=>x.id!==item.id)];
      await kvPut(env.TUTOR_KV,"teacher_applications",next);
      // 登记投递或接单，只更新关联关系；绝不自动关闭家教单。
      return jsonResp({ok:true,teacherApplications:next});
    }
    if (action === "admin_delete_teacher_application") {
      if (!env.AUTH_SECRET || !env.ADMIN_PASSWORD) return jsonResp({ok:false,error:"管理员个人资料存储未启用"},503);
      const applications=await kvGet(env.TUTOR_KV,"teacher_applications",[]);
      const next=applications.filter(x=>x.id!==body.applicationId);
      if(next.length===applications.length)return jsonResp({ok:false,error:"投递记录不存在"},404);
      await kvPut(env.TUTOR_KV,"teacher_applications",next);
      return jsonResp({ok:true,teacherApplications:next});
    }

    if (action === "admin_save_assignment") {
      if (!env.AUTH_SECRET || !env.ADMIN_PASSWORD) return jsonResp({ ok: false, error: "保存老师个人信息前，请在 Cloudflare 配置强密码 ADMIN_PASSWORD 和独立随机 AUTH_SECRET" }, 503);
      const orderId = String(body.orderId || "").trim();
      const name = String(body.teacherName || "").trim();
      const contact = String(body.teacherContact || "").trim();
      const note = String(body.note || "").trim();
      if (!orderId || orderId.length > 60 || !name || name.length > 80 ||
        contact.length > 120 || note.length > 500) {
        return jsonResp({ ok: false, error: "请填写有效的订单编号和老师姓名（联系方式、备注可选）" }, 400);
      }
      const current = await kvGet(env.TUTOR_KV, "orders", []);
      const override = body.importedOverride;
      const order = current.find((o) => o.id === orderId) ||
        (/^fs-\d{4,}$/.test(orderId) && override?.id === orderId ? override : null);
      if (!order) return jsonResp({ ok: false, error: "找不到该家教单，请刷新后重试" }, 404);
      const assignments = await kvGet(env.TUTOR_KV, "teacher_assignments", []);
      const assignmentId = String(body.assignmentId || "");
      const matched = assignments.find((a) => a.id === assignmentId && a.orderId === orderId);
      if (assignmentId && !matched) return jsonResp({ ok: false, error: "未找到要修改的匹配记录" }, 404);
      const now = new Date().toISOString();
      const entry = {
        id: matched?.id || `as-${crypto.randomUUID()}`, orderId,
        teacherName: name, teacherContact: contact, note,
        assignedAt: matched?.assignedAt || now, updatedAt: now,
        district: String(order.district || "").slice(0, 50),
        publicAddress: String(order.publicAddress || (order.addressVisibility === "private" ? order.district : order.address) || "").slice(0, 220),
        subject: String(order.subject || "").slice(0, 90)
      };
      const nextAssignments = [entry, ...assignments.filter((a) => a.id !== entry.id)];
      await kvPut(env.TUTOR_KV, "teacher_assignments", nextAssignments);
      let nextOrders = current;
      if (body.markMatched === true) {
        const updated = { ...order, id: orderId, status: "已匹配", updatedAt: now };
        nextOrders = [updated, ...current.filter((o) => o.id !== orderId)];
        await kvPut(env.TUTOR_KV, "orders", nextOrders);
      }
      return jsonResp({ ok: true, assignments: nextAssignments, orders: nextOrders });
    }
    if (action === "admin_delete_assignment") {
      if (!env.AUTH_SECRET || !env.ADMIN_PASSWORD) return jsonResp({ ok: false, error: "缺少安全管理员密钥，无法操作私人记录" }, 503);
      const assignments = await kvGet(env.TUTOR_KV, "teacher_assignments", []);
      const next = assignments.filter((a) => a.id !== body.assignmentId);
      if (next.length === assignments.length) return jsonResp({ ok: false, error: "该匹配记录不存在" }, 404);
      await kvPut(env.TUTOR_KV, "teacher_assignments", next);
      return jsonResp({ ok: true, assignments: next });
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
      const existingLabels = new Set(existing.map((o) => String(o.orderNumber || o.id)));
      const incomingLabels = body.orders.map((o) => String(o.orderNumber || o.id));
      if (new Set(incomingLabels).size !== incomingLabels.length || incomingLabels.some((label) => existingLabels.has(label))) {
        return jsonResp({ ok: false, error: "家教单展示编号已存在，请核对编号后发布" }, 409);
      }
      const merged = [...(body.orders || []), ...existing];
      await kvPut(env.TUTOR_KV, "orders", merged);
      const previousNumber = Number(await kvGet(env.TUTOR_KV, "order_sequence", 2991)) || 2991;
      const numbers = merged.map((o) => Number(String(o.orderNumber || o.id).match(/^#?(\d{3,7})/)?.[1]) || 0);
      const orderSequence = Math.max(2991, previousNumber, ...numbers);
      await kvPut(env.TUTOR_KV, "order_sequence", orderSequence);
      return jsonResp({ ok: true, orders: merged, orderSequence });
    }

    if (action === "admin_update_order") {
      const existing = await kvGet(env.TUTOR_KV, "orders", []);
      const already = existing.some((o) => o.id === body.id);
      // 飞书静态导入单使用独立内部 ID；首次编辑时新增覆盖记录，不变更公开单号。
      if (!already && !/^fs-\d{4,}$/.test(String(body.id))) return jsonResp({ ok: false, error: "找不到该家教单" }, 404);
      const next = already ? existing.map((o) => (o.id === body.id ? { ...o, ...body.patch, id: body.id, updatedAt: new Date().toISOString() } : o))
        : [{ ...body.patch, id: body.id, updatedAt: new Date().toISOString() }, ...existing];
      await kvPut(env.TUTOR_KV, "orders", next);
      return jsonResp({ ok: true, orders: next });
    }

    if (action === "admin_batch_status") {
      const ids = body.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 ||
          ids.some((id) => typeof id !== "string" || id.length > 50) ||
          !["招募中", "已匹配"].includes(body.status)) {
        return jsonResp({ ok: false, error: "请选择 1～100 条家教单并指定有效状态" }, 400);
      }
      const existing = await kvGet(env.TUTOR_KV, "orders", []);
      const overrides = new Map((Array.isArray(body.importedOverrides) ? body.importedOverrides : [])
        .filter((o) => o && /^fs-\d{4,}$/.test(o.id) && ids.includes(o.id))
        .map((o) => [o.id, o]));
      const index = new Map(existing.map((order) => [order.id, order]));
      const now = new Date().toISOString();
      for (const id of new Set(ids)) {
        const original = index.get(id) || overrides.get(id);
        if (!original) return jsonResp({ ok: false, error: `找不到家教单 ${id}，请刷新后重试` }, 404);
        index.set(id, { ...original, id, status: body.status, updatedAt: now });
      }
      const next = [...index.values()];
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
      const patch = body.patch && typeof body.patch === "object" && !Array.isArray(body.patch) ? body.patch : {};
      const allowed = ["siteName", "subtitle", "announcement", "theme", "contactWechat", "heroTitle", "heroDescription"];
      const safePatch = Object.fromEntries(allowed.filter(k => typeof patch[k] === "string" && patch[k].length <= 600)
        .map(k => [k, patch[k]]));
      if (!Object.keys(safePatch).length)
        return jsonResp({ ok: false, error: "网站设置仅允许更新公开展示的文本与主题" }, 400);
      const next = { ...cur, ...safePatch };
      await kvPut(env.TUTOR_KV, "site_config", next);
      return jsonResp({ ok: true, siteConfig: next });
    }

    return jsonResp({ ok: false, error: "Unknown action" }, 400);
  } catch (err) {
    return jsonResp({ ok: false, error: String(err?.message || err) }, 500);
  }
}


// 公开接口只允许读取经过审核的显示字段。误存入 siteConfig 的后台属性、密钥或老师资料不能对外透传。
function toPublicSiteConfig(config = {}) {
  const keys = ["siteName", "subtitle", "announcement", "theme", "contactWechat", "heroTitle", "heroDescription"];
  return Object.fromEntries(keys.filter(k => typeof config[k] === "string")
    .map(k => [k, stripPublicPersonalData(config[k]).slice(0, 600)]));
}
function stripPublicPersonalData(input) {
  return String(input ?? "")
    .replace(/1[3-9]\d{9}/g, "[联系方式请咨询管理员]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[邮箱已隐藏]")
    .replace(/(?:微信号?|联系微信|WeChat|VX|联系(?:电话|方式)|手机号|电话)\s*[：:=\-]?\s*[A-Za-z0-9_+\-]{5,32}/gi,
      "[联系方式请咨询管理员]");
}
function publicLocation(input) {
  return stripPublicPersonalData(input)
    .replace(/\d{1,4}\s*(?:号楼|栋|幢)\s*(?:\d{1,4}\s*单元)?\s*(?:\d{1,4}\s*(?:室|户))?/g, "附近")
    .replace(/\d{1,3}\s*单元\s*\d{1,4}\s*(?:室|户)/g, "附近")
    .replace(/(?:房间|门牌|房号|室号)\s*[：:]?\s*\d+[A-Za-z-]*/g, "[具体门牌已隐藏]");
}

// 无权限的 GET 只提供允许公开展示的字段；精确坐标和后台内部地址不出现在响应里。
function toPublicOrder(order) {
  const fields = ["id", "orderNumber", "title", "grade", "studentGender", "subject",
    "teacherCount", "currentScores", "district", "weeklyFrequency", "sessionsPerWeek",
    "hoursPerSession", "requirements", "salaryText", "hourlyRate", "mode", "onlineAllowed",
    "trialTime", "urgent", "status", "createdAt", "updatedAt", "tags", "genderPref", "source"];
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
  for (const key of ["title", "currentScores", "requirements", "salaryText", "trialTime", "weeklyFrequency"]) {
    if (typeof safe[key] === "string") safe[key] = stripPublicPersonalData(safe[key]);
  }
  safe.address = publicLocation(safe.address);
  safe.publicAddress = safe.address;
  return safe;
}

function toPublicPartTime(post) {
  return { id: post.id,
    title: stripPublicPersonalData(post.title),
    time: stripPublicPersonalData(post.time),
    location: publicLocation(post.location),
    content: stripPublicPersonalData(post.content),
    createdAt: post.createdAt };
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

async function hmacHex(data, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeHexEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

async function signToken(payload, secret) {
  const data = btoa(unescape(encodeURIComponent(JSON.stringify({
    ...payload, jti: crypto.randomUUID(), exp: Date.now() + 2 * 3600_000
  }))));
  const sig = await hmacHex(data, secret);
  return data + "." + sig;
}

async function verifyAuthHeader(request, secret, kv) {
  const authorization = request.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  const pieces = token.split(".");
  if (pieces.length !== 2 || pieces[0].length > 2500) return null;
  const [data, sig] = pieces;
  const expected = await hmacHex(data, secret);
  if (!constantTimeHexEquals(sig, expected)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(escape(atob(data))));
    if (parsed.role !== "admin" || parsed.id !== "admin" ||
        !parsed.jti || !/^[a-zA-Z0-9-]{16,80}$/.test(parsed.jti) ||
        !Number.isFinite(parsed.exp) ||
        parsed.exp <= Date.now() || parsed.exp > Date.now() + 2 * 3600_000 + 60000) return null;
    if (await kv.get("revoked_session_" + parsed.jti)) return null;
    return parsed;
  } catch { return null; }
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }
  });
}
