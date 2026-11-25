import {TEACHER_TYPES,LOCAL_GAOKAO,STUDY_LEVELS,cleanTeachingPairs,cleanCompanionOptions,normalizeAge} from "../../shared/teacher-capabilities.js";
import {loadAIRegistry, safeAIRegistry, saveAIProvider, deleteAIProvider, activateAIProvider, setAIProviderFallback} from "../../shared/ai-provider-registry.js";
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
  return !/(?:已匹配|已关闭|关闭|已结束|结束|已完成|已招满|招满|已下架|下架|已取消|取消|停止招募|暂停招募|已删除)/
    .test(String(order?.status || "").trim());
}

const ORDER_WRITES=new Set(["admin_publish_ai_drafts","admin_add_orders","admin_update_order","admin_batch_status","admin_delete_order","admin_merge_orders","admin_save_assignment","admin_trash_order","admin_restore_order"]);
const ADMIN_MUTATIONS=new Set([...ORDER_WRITES,"admin_update_site","admin_save_parttime","admin_delete_parttime","admin_save_teacher_profile","admin_set_teacher_star","admin_set_teacher_availability","admin_delete_teacher_profile","admin_save_teacher_application","admin_delete_teacher_application","admin_delete_assignment","admin_ai_provider_save","admin_ai_provider_activate","admin_ai_provider_delete","admin_ai_provider_fallback"]);
const BACKUP_KEYS=["orders","hidden_imported_orders","order_sequence","site_config","part_time_posts","teacher_assignments","teacher_profiles","teacher_applications"];
async function makeBackup(kv){
  const data=Object.fromEntries(await Promise.all(BACKUP_KEYS.map(async k=>[k,await kvGet(kv,k,k==="order_sequence"?2991:k==="site_config"?DEFAULT_SITE:[])])));
  return {version:1,createdAt:new Date().toISOString(),data};
}
async function ensureDailyBackup(kv){
  const day=new Date().toISOString().slice(0,10),key="admin_backup_"+day;
  if(await kv.get(key))return;
  await kv.put(key,JSON.stringify(await makeBackup(kv)),{expirationTtl:30*86400});
}
async function recordAudit(kv,body){
  const entries=await kvGet(kv,"admin_audit_log",[]);
  const ids=[body.id,body.assignmentId,body.applicationId,body.teacherId,...(Array.isArray(body.ids)?body.ids:[]),...(Array.isArray(body.orders)?body.orders.map(o=>o.orderNumber||o.id):[])].filter(v=>typeof v==="string"&&/^[#a-zA-Z0-9-]{1,70}$/.test(v)).slice(0,100);
  await kvPut(kv,"admin_audit_log",[{at:new Date().toISOString(),action:body.action,actor:"admin",ids},...(Array.isArray(entries)?entries:[])].slice(0,200));
}
let orderWriteQueue=Promise.resolve();
async function currentOrderRevision(kv){
  const [orders,hidden]=await Promise.all([kvGet(kv,"orders",[]),kvGet(kv,"hidden_imported_orders",[])]);
  return sha256(JSON.stringify([orders,hidden]));
}
export async function onRequest(context) {
  // Serialize writes within this runtime; KV does not provide cross-region CAS.
  if(context.request.method==="POST"){
    let body;try{body=await context.request.clone().json();}catch{return handleRequest(context);}
    if(ADMIN_MUTATIONS.has(body?.action)){
      const run=orderWriteQueue.then(async()=>{
        const response=await handleRequest(context);
        if(response.ok&&context.env.TUTOR_KV){try{const result=await response.clone().json();if(result.ok&&!result.replayed)await recordAudit(context.env.TUTOR_KV,body);}catch{console.warn("admin audit unavailable");}}
        return response;
      });
      orderWriteQueue=run.catch(()=>{});
      return run;
    }
  }
  return handleRequest(context);
}
async function handleRequest(context) {
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

    // Repeated publication after a lost response returns the recorded result, not another write.
    let publishKey="",publishDigest="";
    if(action==="admin_publish_ai_drafts"&&body.idempotencyKey!==undefined){
      if(!Array.isArray(body.orders)||!body.orders.length||body.orders.length>30)return jsonResp({ok:false,error:"请提供1～30条草稿"},400);
      if(typeof body.idempotencyKey!=="string"||!/^[a-zA-Z0-9-]{16,80}$/.test(body.idempotencyKey))return jsonResp({ok:false,error:"发布请求标识无效"},400);
      publishKey=body.idempotencyKey;publishDigest=await sha256(JSON.stringify(body.orders));
      const all=await kvGet(env.TUTOR_KV,"orders",[]);
      const saved=await kvGet(env.TUTOR_KV,"publish_receipt_"+publishKey,null);
      const matches=all.filter(o=>o.lastPublishKey===publishKey);
      if(saved||matches.length){
        if((saved?.digest||matches[0]?.lastPublishDigest)!==publishDigest)return jsonResp({ok:false,error:"发布请求内容发生变化，请重新确认"},409);
        const ids=saved?.ids||matches.map(o=>o.id);
        const published=ids.map(id=>all.find(o=>o.id===id)).filter(Boolean);
        if(!saved&&published.length!==body.orders?.length)return jsonResp({ok:false,error:"上次发布状态待核对，请查看家教单管理"},409);
        const hidden=await kvGet(env.TUTOR_KV,"hidden_imported_orders",[]);
        const hiddenImported=saved?hidden:hidden.filter(id=>!ids.includes(id));
        const previous=Number(await kvGet(env.TUTOR_KV,"order_sequence",2991))||2991;
        const orderSequence=Math.max(previous,...all.map(o=>Number(String(o.orderNumber||o.id).match(/^#?(\d{3,7})/)?.[1])||0));
        if(hiddenImported.length!==hidden.length)await kvPut(env.TUTOR_KV,"hidden_imported_orders",hiddenImported);
        if(orderSequence!==previous)await kvPut(env.TUTOR_KV,"order_sequence",orderSequence);
        return jsonResp({ok:true,replayed:true,orders:all,published,hiddenImported,orderSequence,orderRevision:await currentOrderRevision(env.TUTOR_KV)});
      }
    }
    if(ORDER_WRITES.has(action)&&body.orderRevision!==undefined&&body.orderRevision!==await currentOrderRevision(env.TUTOR_KV))
      return jsonResp({ok:false,error:"订单已被其他操作更新，请刷新后重新核对；本次未写入",code:"ORDER_CONFLICT"},409);
    const orderResponse=async(data)=>jsonResp({...data,orderRevision:await currentOrderRevision(env.TUTOR_KV)});
    if(ADMIN_MUTATIONS.has(action))await ensureDailyBackup(env.TUTOR_KV);
    if(action==="admin_export_current")return jsonResp({ok:true,backup:await makeBackup(env.TUTOR_KV)});
    if(action==="admin_backup_get"){
      const date=String(body.date||"");if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return jsonResp({ok:false,error:"备份日期无效"},400);
      const backup=await kvGet(env.TUTOR_KV,"admin_backup_"+date,null);
      return backup?jsonResp({ok:true,backup}):jsonResp({ok:false,error:"该日期没有备份（只在发生写入的日期创建）"},404);
    }
    if(action==="admin_audit_log")return jsonResp({ok:true,entries:await kvGet(env.TUTOR_KV,"admin_audit_log",[])});
    // Admin-only provider management; no API key or encrypted key is ever returned to browser.
    if (action === "admin_ai_provider_list") {
      const registry=await loadAIRegistry(env.TUTOR_KV);
      return jsonResp({ok:true,registry:safeAIRegistry(registry,env)});
    }
    if(action==="admin_ai_provider_fallback"){
      const registry=await setAIProviderFallback(env.TUTOR_KV,env,String(body.id||""),String(body.model||""));
      return jsonResp({ok:true,registry});
    }
    if(action==="admin_ai_metrics")return jsonResp({ok:true,entries:await kvGet(env.TUTOR_KV,"admin_ai_metrics_v1",[])});
    if (action === "admin_ai_provider_save") {
      const registry=await saveAIProvider(env.TUTOR_KV,env,body.provider);
      return jsonResp({ok:true,registry});
    }
    if (action === "admin_ai_provider_activate") {
      const registry=await activateAIProvider(env.TUTOR_KV,env,String(body.id||""),body.model);
      return jsonResp({ok:true,registry});
    }
    if (action === "admin_ai_provider_delete") {
      const registry=await deleteAIProvider(env.TUTOR_KV,env,String(body.id||""));
      return jsonResp({ok:true,registry});
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
        orderRevision:await sha256(JSON.stringify([orders,hiddenImported])),
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
      const types=TEACHER_TYPES;
      if (raw.gender && !genders.includes(raw.gender)) return jsonResp({ok:false,error:"老师性别选项无效"},400);
      if (raw.availability && !statuses.includes(raw.availability)) return jsonResp({ok:false,error:"接单状态选项无效"},400);
      if (raw.teacherType && !types.includes(raw.teacherType)) return jsonResp({ok:false,error:"教师类型选项无效"},400);
      const records=await kvGet(env.TUTOR_KV,"teacher_profiles",[]);
      const id=String(raw.id||"").trim();
      const original=id?records.find(o=>o.id===id):null;
      if(id && !original) return jsonResp({ok:false,error:"老师档案不存在，请刷新后重试"},404);
      for(const key of ["school","contact","agentName","canTeach","preferredDistricts","gradeLevels","availableTimes","preferences","departureLandmark","recentOrderRefs","interestLocations","note"]) {
        if(raw[key]!=null && (typeof raw[key]!=="string" || raw[key].length>(key==="note"?800:300)))
          return jsonResp({ok:false,error:"老师档案字段长度超限："+key},400);
      }
      if(raw.tianjinGaokao!=null&&!LOCAL_GAOKAO.includes(raw.tianjinGaokao))return jsonResp({ok:false,error:"天津高考经历选项无效"},400);
      if(raw.studyLevel!=null&&!STUDY_LEVELS.includes(raw.studyLevel))return jsonResp({ok:false,error:"在读阶段无效"},400);
      if(raw.age!=null&&raw.age!==""&&normalizeAge(raw.age)===null)return jsonResp({ok:false,error:"年龄无效"},400);
      for(const field of ["currentSchool","graduatedSchool","studyYear","specialties"]){
        if(raw[field]!=null&&(typeof raw[field]!=="string"||raw[field].length>300))return jsonResp({ok:false,error:"档案字段无效："+field},400);
      }
      for(const field of ["teachingPairs","companionOptions"]){
        if(raw[field]!=null&&(!Array.isArray(raw[field])||raw[field].length>100))return jsonResp({ok:false,error:"能力记录格式无效"},400);
      }
      if(raw.starred!=null&&typeof raw.starred!=="boolean")return jsonResp({ok:false,error:"星标格式无效"},400);
      const now=new Date().toISOString();
      const profile={
        id:original?.id||"tp-"+crypto.randomUUID(),
        name,school:String(raw.school||"").trim().slice(0,120),
        gender:raw.gender||original?.gender||"未知",teacherType:raw.teacherType||original?.teacherType||"未知",
        currentSchool:String(raw.currentSchool??original?.currentSchool??((raw.teacherType||original?.teacherType)==="在校生"?raw.school||original?.school||"":"")).trim().slice(0,120),
        graduatedSchool:String(raw.graduatedSchool??original?.graduatedSchool??"").trim().slice(0,120),
        age:raw.age===undefined?original?.age??null:normalizeAge(raw.age),
        studyLevel:raw.studyLevel??original?.studyLevel??"",
        studyYear:String(raw.studyYear??original?.studyYear??"").trim().slice(0,40),
        tianjinGaokao:raw.tianjinGaokao??original?.tianjinGaokao??"未知",
        starred:raw.starred??original?.starred??false,
        specialties:String(raw.specialties??original?.specialties??"").trim().slice(0,300),
        teachingPairs:cleanTeachingPairs(raw.teachingPairs??original?.teachingPairs),
        companionOptions:cleanCompanionOptions(raw.companionOptions??original?.companionOptions),
        canTeach:String(raw.canTeach||"").trim().slice(0,200),
        preferredDistricts:String(raw.preferredDistricts||"").trim().slice(0,200),
        gradeLevels:String(raw.gradeLevels??original?.gradeLevels??"").trim().slice(0,120),
        availableTimes:String(raw.availableTimes??original?.availableTimes??"").trim().slice(0,200),
        preferences:String(raw.preferences??original?.preferences??"").trim().slice(0,300),
        departureLandmark:String(raw.departureLandmark??original?.departureLandmark??"").trim().slice(0,120),
        recentOrderRefs:String(raw.recentOrderRefs??original?.recentOrderRefs??"").trim().slice(0,300),
        interestLocations:String(raw.interestLocations??original?.interestLocations??"").trim().slice(0,200),
        availability:raw.availability||original?.availability||"待确认",
        availabilityConfirmedAt:raw.availability && raw.availability!==original?.availability?now:original?.availabilityConfirmedAt||"",
        contact:String(raw.contact||"").trim().slice(0,150),
        agentName:String(raw.agentName||"").trim().slice(0,100),
        note:String(raw.note||"").trim().slice(0,800),
        createdAt:original?.createdAt||now,updatedAt:now
      };
      const next=[profile,...records.filter(o=>o.id!==profile.id)];
      await kvPut(env.TUTOR_KV,"teacher_profiles",next);
      return jsonResp({ok:true,teacherProfiles:next,profileId:profile.id});
    }
    if(action==="admin_set_teacher_star"){
      if(typeof body.starred!=="boolean")return jsonResp({ok:false,error:"星标无效"},400);
      const profiles=await kvGet(env.TUTOR_KV,"teacher_profiles",[]);
      if(!profiles.some(p=>p.id===body.teacherId))return jsonResp({ok:false,error:"找不到老师档案"},404);
      const next=profiles.map(p=>p.id===body.teacherId?{...p,starred:body.starred,updatedAt:new Date().toISOString()}:p);
      await kvPut(env.TUTOR_KV,"teacher_profiles",next);
      return jsonResp({ok:true,teacherProfiles:next});
    }
    if (action === "admin_set_teacher_availability") {
      if (!env.AUTH_SECRET || !env.ADMIN_PASSWORD) return jsonResp({ok:false,error:"管理员个人资料存储未启用"},503);
      const statuses=["可接单","已接满","暂不接单","待确认"];
      if(!statuses.includes(body.availability))return jsonResp({ok:false,error:"老师状态无效"},400);
      const profiles=await kvGet(env.TUTOR_KV,"teacher_profiles",[]);
      if(!profiles.some(p=>p.id===body.teacherId))return jsonResp({ok:false,error:"找不到老师档案"},404);
      const next=profiles.map(p=>p.id===body.teacherId?{...p,availability:body.availability,availabilityConfirmedAt:new Date().toISOString(),updatedAt:new Date().toISOString()}:p);
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
      return orderResponse({ ok: true, assignments: nextAssignments, orders: nextOrders });
    }
    if (action === "admin_delete_assignment") {
      if (!env.AUTH_SECRET || !env.ADMIN_PASSWORD) return jsonResp({ ok: false, error: "缺少安全管理员密钥，无法操作私人记录" }, 503);
      const assignments = await kvGet(env.TUTOR_KV, "teacher_assignments", []);
      const next = assignments.filter((a) => a.id !== body.assignmentId);
      if (next.length === assignments.length) return jsonResp({ ok: false, error: "该匹配记录不存在" }, 404);
      await kvPut(env.TUTOR_KV, "teacher_assignments", next);
      return jsonResp({ ok: true, assignments: next });
    }

    if (action === "admin_publish_ai_drafts") {
      if(!Array.isArray(body.orders)||!body.orders.length||body.orders.length>30)
        return jsonResp({ok:false,error:"请提供1～30条草稿"},400);
      const existing=await kvGet(env.TUTOR_KV,"orders",[]);
      const hidden=await kvGet(env.TUTOR_KV,"hidden_imported_orders",[]);
      // Same static imported-order override convention as the existing admin update endpoint.
      const imported=new Map((Array.isArray(body.importedOverrides)?body.importedOverrides:[])
        .filter(o=>o&&/^fs-\d{4,}$/.test(o.id)).map(o=>[o.id,o]));
      const byId=new Map(existing.map(o=>[o.id,o]));
      const find=id=>byId.get(id)||imported.get(id);
      const labelOf=o=>String(o?.orderNumber||o?.id||"");
      const labels=new Set(),updatedIds=new Set(),parents=new Map(),published=[];
      const fields=["title","grade","subject","studentGender","teacherCount","currentScores","address","publicAddress","district",
        "weeklyFrequency","sessionsPerWeek","hoursPerSession","requirements","salaryText","hourlyRate","mode","onlineAllowed","trialTime","notes","genderPref","urgent","tags"];
      const now=new Date().toISOString();
      for(const draft of body.orders){
        const label=labelOf(draft);
        if(!/^#\d{3,7}(?:-\d+)?$/.test(label)||!draft.grade||!draft.subject||labels.has(label))
          return jsonResp({ok:false,error:"草稿编号重复或格式不正确"},409);
        labels.add(label);
        const linked=String(draft.existingOrderId||""),current=linked?find(linked):null;
        if(linked&&(!current||current.status==="已删除"||labelOf(current)!==label||updatedIds.has(linked)))
          return jsonResp({ok:false,error:"原单不存在或编号不一致："+label},409);
        if(!linked && existing.some(o=>labelOf(o)===label||o.id===label) && draft.explicitNumberReuse!==true)
          return jsonResp({ok:false,error:"编号已使用，请确认是修改原单还是指定重号的新单："+label},409);
        const parentId=String(draft.splitFromId||"");
        if(parentId){
          const original=find(parentId),root=label.replace(/-\d+$/,"");
          if(!original||labelOf(original)!==root||label===root||linked)
            return jsonResp({ok:false,error:"历史拆单的主编号不匹配："+label},409);
          parents.set(parentId,original);
        }
        const id=linked || (draft.explicitNumberReuse===true?"order-"+crypto.randomUUID():label);
        if(updatedIds.has(id)||(!linked&&byId.has(id)))return jsonResp({ok:false,error:"内部订单编号冲突"},409);
        updatedIds.add(id);
        const patch=Object.fromEntries(fields.filter(k=>Object.hasOwn(draft,k)).map(k=>[k,draft[k]]));
        published.push({...current,...patch,id,orderNumber:label,status:"招募中",createdAt:current?.createdAt||now,
          ...(publishKey?{lastPublishKey:publishKey,lastPublishDigest:publishDigest}:{}),...(current?{updatedAt:now}:{})});
      }
      for(const [id,original] of parents){
        if(updatedIds.has(id)||published.filter(o=>labelOf(o).replace(/-\d+$/,"")===labelOf(original)).length<2)
          return jsonResp({ok:false,error:"历史拆单至少需两条子单，且不可同时发布主单"},409);
        updatedIds.add(id);
      }
      const closed=[...parents].map(([id,o])=>({...o,id,status:"已关闭",updatedAt:now}));
      const merged=[...published,...closed,...existing.filter(o=>!updatedIds.has(o.id))];
      const previous=Number(await kvGet(env.TUTOR_KV,"order_sequence",2991))||2991;
      const orderSequence=Math.max(3062,previous,...merged.map(o=>Number(labelOf(o).match(/^#?(\d{3,7})/)?.[1])||0));
      const visible=new Set(published.map(o=>o.id));
      const hiddenImported=hidden.filter(id=>!visible.has(id));
      await kvPut(env.TUTOR_KV,"orders",merged);
      await kvPut(env.TUTOR_KV,"order_sequence",orderSequence);
      await kvPut(env.TUTOR_KV,"hidden_imported_orders",hiddenImported);
      if(publishKey){try{await env.TUTOR_KV.put("publish_receipt_"+publishKey,JSON.stringify({digest:publishDigest,ids:published.map(o=>o.id)}),{expirationTtl:86400*7});}catch{console.warn("publication receipt unavailable");}}
      return orderResponse({ok:true,orders:merged,published,orderSequence,hiddenImported});
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
      return orderResponse({ ok: true, orders: merged, orderSequence });
    }

    if (action === "admin_update_order") {
      const existing = await kvGet(env.TUTOR_KV, "orders", []);
      const already = existing.some((o) => o.id === body.id);
      // 飞书静态导入单使用独立内部 ID；首次编辑时新增覆盖记录，不变更公开单号。
      if (!already && !/^fs-\d{4,}$/.test(String(body.id))) return jsonResp({ ok: false, error: "找不到该家教单" }, 404);
      const label=body.patch?.orderNumber;
      const current=existing.find(o=>o.id===body.id);
      if(current?.status==="已删除")return jsonResp({ok:false,error:"请先恢复回收站订单"},409);
      if(label!==undefined&&label!==String(current?.orderNumber||current?.id||"")){
        if(!/^#\d{3,7}(?:-\d+)?$/.test(label))return jsonResp({ok:false,error:"公开编号格式无效"},400);
        if(existing.some(o=>o.id!==body.id&&String(o.orderNumber||o.id)===label))return jsonResp({ok:false,error:"公开编号已存在"},409);
      }
      const next = already ? existing.map((o) => (o.id === body.id ? { ...o, ...body.patch, id: body.id, updatedAt: new Date().toISOString() } : o))
        : [{ ...body.patch, id: body.id, updatedAt: new Date().toISOString() }, ...existing];
      await kvPut(env.TUTOR_KV, "orders", next);
      return orderResponse({ ok: true, orders: next });
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
        if (!original||original.status==="已删除") return jsonResp({ ok: false, error: `找不到可操作家教单 ${id}，请先核对回收站`, }, 404);
        index.set(id, { ...original, id, status: body.status, updatedAt: now });
      }
      const next = [...index.values()];
      await kvPut(env.TUTOR_KV, "orders", next);
      return orderResponse({ ok: true, orders: next });
    }

    if(action==="admin_merge_orders"){
      const ids=Array.isArray(body.ids)?[...new Set(body.ids)]:[];
      if(ids.length<2||ids.length>30||!ids.every(id=>typeof id==="string"))return jsonResp({ok:false,error:"合并订单参数无效"},400);
      const existing=await kvGet(env.TUTOR_KV,"orders",[]);
      const overrides=new Map((Array.isArray(body.importedOverrides)?body.importedOverrides:[]).filter(o=>o&&/^fs-\d{4,}$/.test(o.id)).map(o=>[o.id,o]));
      const selected=ids.map(id=>existing.find(o=>o.id===id)||overrides.get(id));
      if(selected.some(o=>!o||o.status==="已删除"))return jsonResp({ok:false,error:"订单不存在，请刷新后重试"},409);
      const base=selected[0];
      if(new Set(selected.map(o=>[o.grade,o.publicAddress||o.address,o.studentGender].join("|"))).size!==1)return jsonResp({ok:false,error:"仅允许合并同一学生的订单"},400);
      const conditions=["salaryText","weeklyFrequency","hoursPerSession","mode","onlineAllowed","trialTime","genderPref","notes"];
      if(conditions.some(k=>new Set(selected.map(o=>String(o[k]??""))).size>1))return jsonResp({ok:false,error:"授课条件不一致，请先统一后合并"},409);
      const patch=body.merged||{};
      if(!patch.subject||patch.id!==base.id)return jsonResp({ok:false,error:"合并结果无效"},400);
      const allowed=["subject","title","currentScores","requirements","teacherCount"];
      const now=new Date().toISOString();
      const merged={...base,...Object.fromEntries(allowed.filter(k=>Object.hasOwn(patch,k)).map(k=>[k,patch[k]])),updatedAt:now};
      const closed=selected.slice(1).map(o=>({...o,status:"已关闭",updatedAt:now}));
      const next=[merged,...closed,...existing.filter(o=>!ids.includes(o.id))];
      await kvPut(env.TUTOR_KV,"orders",next);
      return orderResponse({ok:true,orders:next});
    }
    if(action==="admin_trash_order"||action==="admin_restore_order"){
      const id=String(body.id||"");if(!id||id.length>70)return jsonResp({ok:false,error:"无效订单编号"},400);
      const existing=await kvGet(env.TUTOR_KV,"orders",[]);
      const hiddenImported=await kvGet(env.TUTOR_KV,"hidden_imported_orders",[]);
      const current=existing.find(o=>o.id===id)||(/^fs-\d{4,}$/.test(id)&&body.importedOverride?.id===id&&!hiddenImported.includes(id)?body.importedOverride:null);
      if(!current)return jsonResp({ok:false,error:"订单不存在"},404);
      let updated;
      if(action==="admin_trash_order"){
        if(current.status==="已删除")return orderResponse({ok:true,orders:existing,hiddenImported});
        updated={...current,previousStatus:current.status||"招募中",status:"已删除",deletedAt:new Date().toISOString()};
      }else{
        if(current.status!=="已删除")return jsonResp({ok:false,error:"此订单不在回收站"},409);
        const label=String(current.orderNumber||current.id);
        if(existing.some(o=>o.id!==id&&String(o.orderNumber||o.id)===label&&isPubliclyOpenOrder(o)))return jsonResp({ok:false,error:"展示编号已被其他订单使用，恢复前请核对"},409);
        updated={...current,status:current.previousStatus||"招募中"};
        delete updated.deletedAt;delete updated.previousStatus;
      }
      updated.updatedAt=new Date().toISOString();
      const next=[updated,...existing.filter(o=>o.id!==id)];
      await kvPut(env.TUTOR_KV,"orders",next);
      return orderResponse({ok:true,orders:next,hiddenImported});
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
      return orderResponse({ ok: true, orders: next, hiddenImported });
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
