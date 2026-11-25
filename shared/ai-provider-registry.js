// Server-only AI relay registry. Keys never appear in public GET, admin metadata, or client storage.
// Stored keys are AES-GCM encrypted with key material derived from AUTH_SECRET.
// Set a high-entropy AUTH_SECRET in production: the encryption is only as strong as that secret.
const STORE_KEY = "ai_provider_registry_v1";
const MAX_PROFILES = 12;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+:@-]{0,119}$/;

function validateBaseUrl(raw) {
  const input = String(raw || "").trim();
  if (!input || input.length > 350) throw new Error("请填写有效的中转站 API 地址（最多350字符）");
  let url;
  try { url = new URL(input); } catch { throw new Error("API 地址格式错误"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("API 地址必须是纯 HTTPS 地址，不能包含账号、密码、查询参数或锚点");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      host.endsWith(".test") || host.endsWith(".invalid") ||
      host.endsWith(".example") || host.indexOf(".") < 0 ||
      /^\d+(?:\.\d+)*$/.test(host) || host.includes(":") ||
      /^(?:0x[0-9a-f]+|0[0-7]+)$/i.test(host)) {
    throw new Error("不允许使用本机、IP、内网或测试域名作为中转站");
  }
  // Models are called via OpenAI-compatible /chat/completions; strip accidental full endpoint.
  let normalized = url.href.replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) normalized = normalized.slice(0, -"/chat/completions".length);
  if (normalized.length > 350) throw new Error("API 地址过长");
  return normalized;
}
function validateModels(raw) {
  const input = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\n,，]+/) : [];
  const models = [...new Set(input.map(x => String(x || "").trim()).filter(Boolean))];
  if (!models.length || models.length > 30 || models.some(x => !MODEL_PATTERN.test(x))) {
    throw new Error("请填写 1～30 个合法的模型名称，每行一个，例如 gpt-4.1、deepseek-chat");
  }
  return models;
}
const encode = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""));
const decode = data => Uint8Array.from(atob(data), c => c.charCodeAt(0));

async function aesKey(secret) {
  if (!String(secret || "").trim()) throw new Error("服务端未配置 AUTH_SECRET");
  const data = new TextEncoder().encode("tutorhub:ai-provider-storage:v1:" + secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptKey(value, secret) {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name:"AES-GCM",iv}, key, new TextEncoder().encode(value));
  return {v:1, iv:encode(iv), data:encode(new Uint8Array(encrypted))};
}
async function decryptKey(stored, secret) {
  if (!stored || stored.v !== 1 || typeof stored.iv !== "string" || typeof stored.data !== "string")
    throw new Error("中转站密钥存储格式异常，请重新设置此中转站的 API Key");
  try {
    const decrypted = await crypto.subtle.decrypt({name:"AES-GCM",iv:decode(stored.iv)},await aesKey(secret),decode(stored.data));
    return new TextDecoder().decode(decrypted);
  } catch {
    throw new Error("无法解密此中转站的 API Key。若更换过 AUTH_SECRET，请在模型管理中重新配置");
  }
}
export async function loadAIRegistry(kv) {
  if (!kv) return {activeId:"env", profiles:[]};
  const raw = await kv.get(STORE_KEY);
  if (!raw) return {activeId:"env", profiles:[]};
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("AI 中转站配置损坏，拒绝自动重置"); }
  if (!parsed || !Array.isArray(parsed.profiles) || typeof parsed.activeId !== "string")
    throw new Error("AI 中转站配置结构异常，拒绝自动重置");
  return parsed;
}
async function persist(kv, registry) {
  if (!kv) throw new Error("尚未绑定 Cloudflare KV");
  await kv.put(STORE_KEY, JSON.stringify(registry));
}
export function safeAIRegistry(registry, env={}) {
  return {
    activeId: registry.activeId,
    fallbackId:registry.fallbackId||"",fallbackModel:registry.fallbackModel||"",
    envConfigured: Boolean(env.OPENAI_API_KEY || env.GEMINI_API_KEY),
    envModel: env.OPENAI_API_KEY ? String(env.OPENAI_MODEL || "glm-4.7-flash") :
      env.GEMINI_API_KEY ? String(env.GEMINI_MODEL || "gemini-2.5-flash") : "",
    envProvider: env.OPENAI_API_KEY ? "Cloudflare 环境变量 · OpenAI 兼容" : 
      env.GEMINI_API_KEY ? "Cloudflare 环境变量 · Gemini" : "未配置",
    profiles: registry.profiles.map(p=>({
      id:p.id, name:p.name, baseUrl:p.baseUrl, models:[...p.models],
      selectedModel:p.selectedModel, hasApiKey:Boolean(p.encryptedKey),
      updatedAt:p.updatedAt
    }))
  };
}
export async function saveAIProvider(kv,env,input={}) {
  const registry = await loadAIRegistry(kv);
  const current = input.id ? registry.profiles.find(p=>p.id===input.id) : null;
  if (input.id && !current) throw new Error("找不到需要编辑的中转站");
  if (!current && registry.profiles.length >= MAX_PROFILES) throw new Error("最多保存 12 个中转站");
  const name = String(input.name || "").trim();
  if (!name || name.length > 60) throw new Error("中转站名称需为 1～60 字符");
  const baseUrl = validateBaseUrl(input.baseUrl);
  const models = validateModels(input.models);
  const selectedModel = String(input.selectedModel || "").trim() || models[0];
  if (!models.includes(selectedModel)) throw new Error("默认模型必须在已添加的模型列表中");
  const supplied = String(input.apiKey || "").trim();
  if (supplied && (supplied.length > 1500 || /[\s\x00-\x1f]/.test(supplied))) throw new Error("API Key 格式不正确");
  if (!supplied && !current?.encryptedKey) throw new Error("首次添加中转站必须填写 API Key");
  const encryptedKey = supplied ? await encryptKey(supplied,String(env.AUTH_SECRET)) : current.encryptedKey;
  const next = {id:current?.id || crypto.randomUUID(),name,baseUrl,models,selectedModel,
    encryptedKey,updatedAt:new Date().toISOString()};
  registry.profiles = [...registry.profiles.filter(p=>p.id!==next.id),next];
  if(registry.fallbackId===next.id&&!next.models.includes(registry.fallbackModel)){delete registry.fallbackId;delete registry.fallbackModel;}
  await persist(kv,registry);
  return safeAIRegistry(registry,env);
}
export async function deleteAIProvider(kv,env,id) {
  const registry = await loadAIRegistry(kv);
  if (!registry.profiles.some(p=>p.id===id)) throw new Error("中转站不存在");
  registry.profiles = registry.profiles.filter(p=>p.id!==id);
  if (registry.activeId===id) registry.activeId="env";
  if(registry.fallbackId===id){delete registry.fallbackId;delete registry.fallbackModel;}
  await persist(kv,registry);
  return safeAIRegistry(registry,env);
}
export async function activateAIProvider(kv,env,id,model) {
  const registry = await loadAIRegistry(kv);
  if (id === "env") {
    registry.activeId = "env";
  } else {
    const profile = registry.profiles.find(p=>p.id===id);
    if (!profile) throw new Error("中转站不存在，请刷新后重试");
    if (!profile.encryptedKey) throw new Error("中转站未配置 API Key");
    if (model != null && !profile.models.includes(model)) throw new Error("模型名称不在该中转站列表中");
    if (model) profile.selectedModel = model;
    registry.activeId = id;
  }
  if(registry.fallbackId===registry.activeId&&(registry.activeId==="env"||registry.profiles.find(p=>p.id===registry.activeId)?.selectedModel===registry.fallbackModel)){delete registry.fallbackId;delete registry.fallbackModel;}
  await persist(kv,registry);
  return safeAIRegistry(registry,env);
}
export async function setAIProviderFallback(kv,env,id,model){
  const registry=await loadAIRegistry(kv);
  if(!id){delete registry.fallbackId;delete registry.fallbackModel;}
  else {
    if(id==="env"){if(!env.OPENAI_API_KEY&&!env.GEMINI_API_KEY)throw new Error("默认模型未配置");model="";}
    else{
      const p=registry.profiles.find(x=>x.id===id);
      if(!p?.encryptedKey||!p.models.includes(model))throw new Error("备用模型无效");
    }
    if(id===registry.activeId&&(id==="env"||registry.profiles.find(p=>p.id===id)?.selectedModel===model))throw new Error("备用模型不能与主模型相同");
    registry.fallbackId=id;registry.fallbackModel=model;
  }
  await persist(kv,registry);
  return safeAIRegistry(registry,env);
}
export async function resolveAIProvider(kv,env,requestedId,requestedModel) {
  const registry = await loadAIRegistry(kv);
  const id = requestedId || registry.activeId;
  if (requestedId && requestedId !== "env" && requestedId !== registry.activeId) {
    // Admin probe is allowed to inspect a saved but non-active relay; not allowed for public requests.
    if (!registry.profiles.some(p=>p.id===requestedId)) throw new Error("测试的中转站不存在");
  }
  if (id === "env") {
    if (env.OPENAI_API_KEY) return {kind:"openai",baseUrl:
      (env.OPENAI_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/,""),
      apiKey:env.OPENAI_API_KEY,model:env.OPENAI_MODEL || "glm-4.7-flash",name:"Cloudflare 默认配置"};
    if (env.GEMINI_API_KEY) return {kind:"gemini",apiKey:env.GEMINI_API_KEY,
      model:env.GEMINI_MODEL || "gemini-2.5-flash",name:"Cloudflare Gemini"};
    return null;
  }
  const profile = registry.profiles.find(p=>p.id===id);
  if (!profile) throw new Error("当前选中的中转站已不存在，请在 AI 模型管理中重新选择");
  if (requestedModel && !profile.models.includes(requestedModel)) throw new Error("只能测试此中转站已保存的模型 ID");
  return {kind:"openai",baseUrl:validateBaseUrl(profile.baseUrl),
    model:requestedModel || profile.selectedModel,
    apiKey:await decryptKey(profile.encryptedKey,String(env.AUTH_SECRET)),name:profile.name};
}
