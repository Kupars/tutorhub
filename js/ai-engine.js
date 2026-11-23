import { APP_CONFIG } from "./app-env.js";
import { nextOrderId, normalizeOrder } from "./order-format.js";
import { normalizePublicAddress, safeOptimizedPublicAddress } from "./address-normalizer.js";
import { guardSiteActions } from "./ai-command-guard.js?v=3";

export async function callServerlessAI(action, payload = {}) {
  let response;
  try {
    const token = localStorage.getItem("tutorhub_token_v3") || "";
    response = await fetch(`${APP_CONFIG.apiBase}/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ action, payload }),
      signal: AbortSignal.timeout(action === "optimize_addresses" ? 50000 : 60000)
    });
  } catch (err) { throw new Error(`AI API 网络请求失败：${err.message || "请检查网络连接"}`); }
  let data;
  try { data = await response.json(); } catch { throw new Error(`AI 接口没有返回 JSON（HTTP ${response.status}）`); }
  if (!response.ok || !data?.ok) throw new Error(data?.error || `AI 接口错误 HTTP ${response.status}`);
  return data.result;
}

export async function probeAIProvider() {
  try {
    const response = await callServerlessAI("model_probe", {});
    return response?.health === "ok" ? { ok:true, provider:response.provider || "已配置的模型" } :
      { ok:false, error:"模型接口有响应，但未返回预期检测字段" };
  } catch (err) { return { ok:false, error:err.message }; }
}

// 老师端仅上传筛选后的公开摘要和估算通勤，不传设备定位坐标、微信、后台地址等隐私信息。
export async function recommendOrdersWithAI(orders, preference = "balanced") {
  const candidates = (orders || []).slice(0, 30).map((order) => ({
    id: String(order.id).slice(0, 60),
    grade: String(order.grade || "").slice(0, 25),
    subject: String(order.subject || "").slice(0, 50),
    district: String(order.district || "").slice(0, 32),
    rate: Number(order.hourlyRate) || 0,
    frequency: String(order.weeklyFrequency || "").slice(0, 90),
    travelMinutes: order.commute && !order.commute.isOnline && !order.commute.approximate
      ? Number(order.commute.transitMin) || null : null
  }));
  const result = await callServerlessAI("recommend_orders", { candidates, preference });
  if (!Array.isArray(result?.picks)) return null;
  const allowed = new Set(candidates.map((item) => item.id));
  const ids = new Set();
  const picks = result.picks.filter((pick) => {
    if (!pick || !allowed.has(pick.id) || ids.has(pick.id)) return false;
    ids.add(pick.id);
    return true;
  }).slice(0, 5).map((pick) => ({ id: pick.id, reason: String(pick.reason || "").slice(0, 40) }));
  return picks.length ? { picks, provider: result.provider || "GLM" } : null;
}

// 模型只负责提取需求，订单 ID 始终由网站根据真实旧单或明确原文生成，避免模型幻造单号。
export function prepareAIDrafts(rawText, parsed, existingOrders = [], previousDrafts = []) {
  const rawOrders = Array.isArray(parsed?.orders) ? parsed.orders : [];
  if (!rawOrders.length || rawOrders.length > 30) throw new Error("AI 未返回有效数量的家教草稿");
  const reserved = [...existingOrders];
  const explicitIds = [...String(rawText || "").matchAll(/#\d{3,7}(?:-\d+)?/g)].map(m=>m[0]);
  const mainId = explicitIds.length === 1 ? explicitIds[0].replace(/-\d+$/, "") : "";
  const explicitSplit = rawOrders.length > 1 && mainId && /拆单|拆分|分成.*单|分别招|单科|各科.*老师/.test(rawText);
  const prev = Array.isArray(previousDrafts) ? previousDrafts : [];
  return rawOrders.map((raw,index)=>{
    const candidate = normalizeOrder(raw || {});
    const prevId = String(prev[index]?.id || "");
    const stated = String(raw.id || "");
    const canonical = /^#\d{3,7}(?:-\d+)?$/.test(stated) &&
      (explicitIds.includes(stated) || prev.some(o=>o.id === stated));
    let id = canonical ? stated : /^#\d{3,7}(?:-\d+)?$/.test(prevId) ? prevId : "";
    if (!id && explicitSplit) id = `${mainId}-${index+1}`;
    if (!id && explicitIds[index] && !reserved.some(o=>o.id===explicitIds[index])) id = explicitIds[index];
    if (!id) id = nextOrderId(reserved);
    if (reserved.some(o=>o.id===id || o.orderNumber===id)) {
      // 已有真实编号可能是管理员指定的旧单：允许原始来源明确指定的旧单，
      // 但新草稿发生碰撞时保留草稿供管理员检查，不静默覆盖。
      if (!explicitIds.includes(id) && !prev.some(o=>o.id===id)) id = nextOrderId(reserved);
    }
    candidate.id = id;
    candidate.orderNumber = id;
    candidate.title = `${candidate.grade}${candidate.subject}家教`;
    candidate.groupingDecision = String(raw.groupingDecision || "待确认").slice(0, 12);
    candidate.groupingReason = String(raw.groupingReason || "").slice(0, 150);
    reserved.push(candidate);
    return candidate;
  });
}

export async function parseMessyOrders(rawText, existingOrders = [], history = []) {
  if (!String(rawText || "").trim()) throw new Error("请先输入家长提供的零散需求");
  const result = await callServerlessAI("parse_orders", { text:String(rawText).slice(0,14000), history });
  return {source: result.provider || "外部模型 API", reply:String(result.reply || ""),
    groupingNotes:result.groupingNotes || [], questions:result.questions || [],
    orders:prepareAIDrafts(rawText,result,existingOrders)};
}

export async function reviseDraftsWithAI(instruction, drafts, history = [], existingOrders = []) {
  if (!Array.isArray(drafts) || !drafts.length) throw new Error("请先整理出草稿");
  const result = await callServerlessAI("revise_drafts", { instruction, drafts, history });
  return {source:result.provider || "外部模型 API", reply:String(result.reply || ""),
    groupingNotes:result.groupingNotes || [], questions:result.questions || [],
    orders:prepareAIDrafts(instruction,result,existingOrders,drafts)};
}

// 地址表达交由配置的真实 API 提出建议，随后仍做确定性安全校验。
// API 不可用时明确报错，而不是假装模型已完成润色。
export async function optimizeOrderAddressesWithAI(orders) {
  const result = orders.map(order=> {
    const address = normalizePublicAddress(order.publicAddress || order.address,order.district);
    return {...order,publicAddress:address,address};
  });
  const indexes = result.map((order,index)=>({order,index}))
    .filter(({order})=>order.mode !== "线上" && !/^(?:地址待补充|线上|网课)/.test(order.publicAddress));
  for(let start=0;start<indexes.length;start+=25){
    const batch=indexes.slice(start,start+25);
    const remote=await callServerlessAI("optimize_addresses", {addresses:batch.map(({order})=>({
      address:order.publicAddress,district:order.district
    }))});
    if(!Array.isArray(remote?.addresses)||remote.addresses.length!==batch.length)
      throw new Error("AI 地址润色返回数量与输入不符，未发布任何内容");
    batch.forEach(({order,index},i)=>{
      const address=safeOptimizedPublicAddress(order.publicAddress,remote.addresses[i],order.district);
      result[index]={...order,publicAddress:address,address};
    });
  }
  return result;
}

// 外部模型解析站点/订单修改指令；只返回供管理员确认的安全白名单操作。
// 不允许回退到内置解析器，更不允许直接执行模型返回的任意代码。
export async function interpretSiteCommand(commandText,currentSiteConfig,orders,history=[]) {
  const summaries=(Array.isArray(orders)?orders:[]).slice(0,220).map(o=>({
    id:o.id,orderNumber:o.orderNumber,title:o.title,grade:o.grade,subject:o.subject,
    publicAddress:o.publicAddress,status:o.status,salaryText:o.salaryText,
    weeklyFrequency:o.weeklyFrequency,requirements:o.requirements
  }));
  const remote=await callServerlessAI("site_command",{
    command:commandText,history,siteConfig:currentSiteConfig,orders:summaries
  });
  const userContext=[...history.filter(h=>h?.role==="user").map(h=>h.content),commandText].join("\n");
  const checked=guardSiteActions(remote,userContext,orders);
  return {source:remote.provider || "外部模型 API",reply:String(remote.reply || ""),
    questions:Array.isArray(remote.questions)?remote.questions:[],...checked};
}
