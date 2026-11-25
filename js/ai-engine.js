import { APP_CONFIG } from "./app-env.js";
import { getSubjectList, nextOrderId, normalizeOrder } from "./order-format.js";
import { normalizePublicAddress, safeOptimizedPublicAddress } from "./address-normalizer.js";
import { guardSiteActions } from "./ai-command-guard.js?v=4";

const gatewayStatus=new Set([502,503,504,520,521,522,523,524]);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function callServerlessAI(action,payload={},onProgress=()=>{},signal){
 const started=Date.now(),budget=95000;
 const retryAllowed=action!=="recommend_orders"&&action!=="model_probe";
 let token="";try{token=localStorage.getItem("tutorhub_token_v3")||"";}catch{}
 for(let attempt=0;attempt<2;attempt++){
   if(signal?.aborted)throw new Error("已取消 AI 请求");
   let response,data,error,retry=false;
   try{
     response=await fetch(APP_CONFIG.apiBase+"/ai",{
       method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{})},
       body:JSON.stringify({action,payload}),
       signal:signal?AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,budget-(Date.now()-started)))]):AbortSignal.timeout(Math.max(1,budget-(Date.now()-started)))
     });
     try{data=await response.json();}catch{
       retry=gatewayStatus.has(response.status);
       const ray=response.headers.get("cf-ray");
       const suffix=ray&&/^[a-zA-Z0-9-]{1,60}$/.test(ray)?"，网关编号 "+ray:"";
       error=new Error(retry?"网站网关暂时异常（HTTP "+response.status+suffix+"），请稍后重试；原始输入和草稿不会丢失":"网站 AI 接口响应异常（HTTP "+response.status+"，非 JSON）");
     }
     if(!error&&(!response.ok||!data?.ok)){
       const id=data?.requestId;
       error=new Error((data?.error||"AI 接口错误 HTTP "+response.status)+(id?"（诊断编号 "+id+"）":""));
     }
     if(!error){
       const result=data.result;
       if(["parse_orders","revise_drafts","model_probe"].includes(action)&&result&&typeof result==="object"){
         const elapsedMs=Math.max(0,Date.now()-started),t=result.timing;
         return {...result,timing:{elapsedMs,upstreamMs:Number.isFinite(t?.upstreamMs)?t.upstreamMs:null,serverMs:Number.isFinite(t?.serverMs)?t.serverMs:null}};
       }
       return result;
     }
   }catch(e){
     if(signal?.aborted)throw new Error("已取消 AI 请求");
     const timeout=e?.name==="TimeoutError"||e?.name==="AbortError";
     retry=!timeout;
     error=new Error(timeout?"AI 请求超时，请减少单次输入数量或切换更快的模型；原始输入仍保留":"网站 AI 网络连接异常，请检查网络后重试");
   }
   // Retry only rapid, unstructured gateway failures; upstream JSON errors have already
   // passed the server retry policy and must not trigger another round of model calls.
   if(attempt===0&&retryAllowed&&retry&&Date.now()-started<12000){
     onProgress("连接暂时异常，正在自动重试…");await pause(1000);continue;
   }
   throw error;
 }
}

export async function probeAIProvider(providerId, model) {
  try {
    const response = await callServerlessAI("model_probe", providerId ? {providerId, ...(model ? {model} : {})} : {});
    return response?.health === "ok" ? { ok:true, provider:response.provider || "已配置的模型", timing:response.timing } :
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

// Explicit administrator corrections outrank old draft IDs. Only match number-shaped
// clauses, never scores, fees, addresses or arbitrary numbers in a conversation.
export function explicitDraftRenumber(instruction, previousDrafts = []) {
  if (!previousDrafts.length) return null;
  const text = String(instruction || "").normalize("NFKC").trim();
  if(/(?:编号|单号)\s*(?:不是|不要|别改|不改)|(?:不要|别|不用)\s*(?:修改|改|调整).{0,6}(?:编号|单号)/.test(text)&&!/(?:而是|正确的是|应该是|改成|改为)\s*#?\d{3,7}/.test(text))return null;
  const pair = text.match(/(?:把|将)?\s*#(\d{3,7}(?:-\d+)?)\s*(?:的)?\s*(?:编号|单号)?\s*(?:改为|改成|改到|改作|更正为|调整为|换成|换为|应为|应该是)\s*#?(\d{3,7}(?:-\d+)?)(?=$|[\s，。；、,.!?！？])/);
  const named = [...text.matchAll(/(?:编号|单号)\s*(?:应该是|应为|改为|改成|改到|更正为|调整为|换成|换为|就是|是|为|[:：])?\s*#?(\d{3,7}(?:-\d+)?)(?=$|[\s，。；、,.!?！？])/g)];
  const standalone = text.match(/(?:^|[。！？；;,\n，])\s*(?:嗯[，,]?\s*)?(?:应该是|应为|就是|是|改成|改为|更正为)?\s*#?(\d{3,7}(?:-\d+)?)\s*[。！？.!?]?\s*$/);
  const targets = [...new Set((pair ? [pair[2]] : named.length ? named.map(m=>m[1]) : standalone ? [standalone[1]] : []).map(n=>"#"+n))];
  if (!targets.length) return null;
  if (targets.length !== 1) throw new Error("检测到多个新编号，请逐条指定要修改的草稿");
  const number = targets[0];
  const matching = pair ? previousDrafts.filter(o=>String(o.orderNumber||o.id)==="#"+pair[1]) : previousDrafts;
  if (matching.length !== 1) throw new Error("请指定要改号的草稿，例如：把#3070改成#3080");
  const old = matching[0];
  const oldNumber = String(old.orderNumber||old.id||"");
  if (number === oldNumber) return null;
  if (old.existingOrderId) throw new Error("这是已发布原单的更新草稿；请在订单管理中修改原单编号，避免新建或覆盖其他订单");
  return {old, oldNumber, number};
}

// 模型只负责提取需求，订单 ID 始终由网站根据真实旧单或明确原文生成，避免模型幻造单号。
export function prepareAIDrafts(rawText, parsed, existingOrders = [], previousDrafts = []) {
  const rawOrders = Array.isArray(parsed?.orders) ? parsed.orders : [];
  if (!rawOrders.length || rawOrders.length > 30) throw new Error("AI 未返回有效数量的家教草稿");
  const reserved = [...existingOrders];
  let explicitIds = [...new Set([...String(rawText || "").matchAll(/#\d{3,7}(?:-\d+)?/g)].map(m=>m[0]))];
  const prev = Array.isArray(previousDrafts) ? previousDrafts : [];
  if(!prev.length){
    const text=String(rawText||"").normalize("NFKC");
    const named=[...text.matchAll(/(?:编号|单号)\s*(?:是|为|[:：])?\s*#?(\d{3,7}(?:-\d+)?)(?=$|[\s，。；、,.!?！？])/g)].map(m=>"#"+m[1]);
    const last=text.match(/(?:^|[。；;,\n，])\s*(?:编号|单号|是|就是|应该是)\s*[:：]?\s*#?(\d{3,7}(?:-\d+)?)\s*[。！？.!?]?\s*$/);
    explicitIds=[...new Set([...explicitIds,...named,...(last?["#"+last[1]]:[])])];
  }
  const renumber = explicitDraftRenumber(rawText,prev);
  if (renumber && (existingOrders.some(o=>o.id && (o.id===renumber.number || o.orderNumber===renumber.number)) ||
    prev.some(o=>o!==renumber.old && (o.id===renumber.number || o.orderNumber===renumber.number))))
    throw new Error("编号 "+renumber.number+" 已存在，请使用其他编号；原草稿未改变");
  if (renumber && rawOrders.length !== prev.length) throw new Error("改号时草稿数量发生变化，请将拆合单与改号分别操作");
  // A rename target must not be assigned to an unrelated draft by generic numbering.
  if (renumber) explicitIds = explicitIds.filter(id=>id!==renumber.number);
  const root=id=>String(id||"").replace(/-\d+$/,"");
  const addr=o=>String(o.publicAddress||o.address||"").replace(/天津市|\s/g,"");
  const singleFamily=rawOrders.length>1 && explicitIds.length<=1 &&
    /拆单|拆分|分成.{0,12}单|分别招|单科|每科.*老师|各科.*老师|各.*一位老师/.test(rawText) &&
    !/不同学生|两名学生|两个学生|两个家庭|不同家庭/.test(rawText) &&
    rawOrders.every(o=>o.grade===rawOrders[0].grade && addr(o).length>3 && addr(o)===addr(rawOrders[0]) && o.studentGender===rawOrders[0].studentGender) &&
    new Set(rawOrders.flatMap(o=>getSubjectList(o.subject))).size===rawOrders.reduce((n,o)=>n+getSubjectList(o.subject).length,0) &&
    (!prev.length||new Set(prev.map(o=>root(o.id))).size===1);
  const mainId=singleFamily?root(explicitIds[0]||prev[0]?.id||nextOrderId(reserved)):"";
  const explicitSplit=Boolean(mainId);
  const allocated=new Set();
  const source=String(rawText||"");
  const position=o=>Math.min(...getSubjectList(o.subject).map(sub=>source.includes(sub)?source.indexOf(sub):Infinity));
  const ordered=singleFamily?[...rawOrders].sort((a,b)=>position(a)-position(b)):rawOrders;
  let renameIndex=-1;
  if (renumber) {
    if (prev.length===1) renameIndex=0;
    else {
      const byId=ordered.map((o,i)=>({o,i})).filter(({o})=>[o.id,o.orderNumber].some(id=>id===renumber.oldNumber||id===renumber.number));
      const byContent=ordered.map((o,i)=>({o,i})).filter(({o})=>o.grade===renumber.old.grade&&o.subject===renumber.old.subject&&addr(o)===addr(renumber.old));
      const matches=byId.length?byId:byContent;
      if(matches.length!==1)throw new Error("无法唯一确认要改号的草稿，请单独修改该单");
      renameIndex=matches[0].i;
    }
  }
  const finalDrafts=ordered.map((raw,index)=>{
    const candidate = normalizeOrder(raw || {});
    const stated = String(raw.orderNumber || raw.id || "");
    const isRename=renumber && index===renameIndex;
    const old=isRename ? renumber.old : prev.find(o=>o.id===stated||o.orderNumber===stated) ||
      prev.find(o=>o.grade===candidate.grade && o.subject===candidate.subject && addr(o)===addr(candidate)) ||
      (prev.length===rawOrders.length?prev[index]:null);
    const prevId = String(old?.orderNumber || old?.id || "");
    const canonical = /^#\d{3,7}(?:-\d+)?$/.test(stated) &&
      (explicitIds.includes(stated) || prev.some(o=>o.id === stated));
    let id = canonical ? stated : /^#\d{3,7}(?:-\d+)?$/.test(prevId) ? prevId : "";
    if (explicitSplit) id = `${mainId}-${index+1}`;
    if (!id && explicitIds[index]) id = explicitIds[index];
    if (!id || allocated.has(id)) id = nextOrderId(reserved);
    if (reserved.some(o=>o.id===id || o.orderNumber===id)) {
      // 已有真实编号可能是管理员指定的旧单：允许原始来源明确指定的旧单，
      // 但新草稿发生碰撞时保留草稿供管理员检查，不静默覆盖。
      if (!explicitSplit && !explicitIds.includes(id) && !prev.some(o=>o.id===id)) id = nextOrderId(reserved);
    }
    // Model output cannot authorize an overwrite. Only current records and explicit admin input can.
    delete candidate.existingOrderId;delete candidate.explicitNumberReuse;delete candidate.splitFromId;
    const known=existingOrders.filter(o=>o.id && String(o.orderNumber||o.id)===id);
    const exactKeys=["grade","subject","studentGender","currentScores","publicAddress","weeklyFrequency","hoursPerSession","teacherCount","requirements","salaryText"];
    const complete=!/待补充|待协商/.test([candidate.grade,candidate.subject,candidate.studentGender,candidate.currentScores,candidate.publicAddress,candidate.weeklyFrequency].join(" "));
    const exact=!explicitSplit && !old && complete && !/新学生|另一个学生|重号新单/.test(rawText) ? existingOrders.filter(o=>o.id&&(!explicitIds.length||explicitIds.includes(String(o.orderNumber||o.id)))&&exactKeys.every(k=>String(normalizeOrder(o)[k])===String(candidate[k]))) : [];
    if(exact.length===1&&!allocated.has(String(exact[0].orderNumber||exact[0].id))){
      id=String(exact[0].orderNumber||exact[0].id);
      candidate.existingOrderId=exact[0].id;
    } else if(old?.existingOrderId && id===prevId){
      candidate.existingOrderId=old.existingOrderId;
    } else if(known.length && explicitIds.includes(id) && /修改|补充|更新|重新发布|重新上架|改为|改成/.test(rawText) && known.length===1){
      candidate.existingOrderId=known[0].id;
    } else if(known.length && explicitIds.includes(id) && !/修改|补充|更新|重新发布|重新上架|改为|改成/.test(rawText)){
      candidate.explicitNumberReuse=true;
    }
    if(explicitSplit && prev.length===1 && prev[0].existingOrderId && !/-\d+$/.test(prevId))
      candidate.splitFromId=prev[0].existingOrderId;
    else if(old?.splitFromId)candidate.splitFromId=old.splitFromId;
    if(old?.explicitNumberReuse&&id===prevId)candidate.explicitNumberReuse=true;
    if (isRename) {
      id=renumber.number;
      delete candidate.existingOrderId;delete candidate.explicitNumberReuse;delete candidate.splitFromId;
    }
    candidate.id = id;
    candidate.orderNumber = id;
    candidate.title = `${candidate.grade}${candidate.subject}家教`;
    candidate.groupingDecision = String(raw.groupingDecision || "待确认").slice(0, 12);
    candidate.groupingReason = String(raw.groupingReason || "").slice(0, 150);
    allocated.add(id); reserved.push(candidate);
    return candidate;
  });
  if(renumber && (finalDrafts.filter(o=>o.orderNumber===renumber.number).length!==1 ||
    finalDrafts.some(o=>o.orderNumber===renumber.oldNumber) ||
    new Set(finalDrafts.map(o=>o.orderNumber)).size!==finalDrafts.length))
    throw new Error("改号校验未通过，原草稿未改变");
  return finalDrafts;
}

export async function parseMessyOrders(rawText, existingOrders = [], history = [], onProgress, signal) {
  if (!String(rawText || "").trim()) throw new Error("请先输入家长提供的零散需求");
  const result = await callServerlessAI("parse_orders", { text:String(rawText).slice(0,14000), history:[] },onProgress,signal);
  return {source: result.provider || "外部模型 API", reply:String(result.reply || ""),
    groupingNotes:result.groupingNotes || [], questions:result.questions || [], timing:result.timing,
    orders:prepareAIDrafts(rawText,result,existingOrders)};
}

const patchFields=new Set(["grade","subject","studentGender","teacherCount","currentScores","address","publicAddress","district","weeklyFrequency","sessionsPerWeek","hoursPerSession","requirements","salaryText","mode","onlineAllowed","trialTime","notes","genderPref","urgent","omitStudentGender","groupingDecision","groupingReason"]);
export function applyDraftPatches(instruction,result,drafts,existingOrders=[]){
  const rename=explicitDraftRenumber(instruction,drafts);
  const items=result?.orders;
  if(!Array.isArray(items)||!items.length||items.length>30)throw new Error("AI 未返回有效修改，原草稿保留");
  const changes=new Map();
  for(const item of items){
    const id=String(item?.id||item?.orderNumber||"");
    if(drafts.filter(o=>(o.orderNumber||o.id)===id).length!==1||changes.has(id))throw new Error("AI 修改对象不明确，原草稿保留");
    const patch=item.changes;
    if(!patch||typeof patch!=="object"||Array.isArray(patch))throw new Error("模型未按字段返回修改，请重试，原草稿保留");
    for(const [k,v] of Object.entries(patch)){
      if(!patchFields.has(k))throw new Error("不允许修改字段："+k);
      if(["teacherCount","sessionsPerWeek","hoursPerSession"].includes(k)){if(typeof v!=="number"||!Number.isFinite(v)||v<0)throw new Error("无效数值："+k);}
      else if(["onlineAllowed","urgent","omitStudentGender"].includes(k)){if(typeof v!=="boolean")throw new Error("无效开关："+k);}
      else if(typeof v!=="string"||v.length>2000)throw new Error("无效字段："+k);
      if(["grade","subject"].includes(k)&&!v.trim())throw new Error("年级科目不可清空");
    }
    changes.set(id,patch);
  }
  if(rename&&(existingOrders.some(o=>o.id&&(o.id===rename.number||o.orderNumber===rename.number))||drafts.some(o=>o!==rename.old&&(o.id===rename.number||o.orderNumber===rename.number))))throw new Error("编号 "+rename.number+" 已存在");
  return drafts.map(old=>{
    const patch=changes.get(old.orderNumber||old.id)||{};
    if(!Object.keys(patch).length&&rename?.old!==old)return old;
    const raw={...old,...patch},fields=new Set(Object.keys(patch));
    if("address" in patch||"publicAddress" in patch){
      if(!("publicAddress" in patch))raw.publicAddress=patch.address;
      if(!("address" in patch))raw.address=patch.publicAddress;
      if(!("district" in patch))delete raw.district;
      for(const k of ["address","publicAddress","district"])fields.add(k);
    }
    if("weeklyFrequency" in patch){if(!("sessionsPerWeek" in patch))delete raw.sessionsPerWeek;fields.add("sessionsPerWeek");}
    if("salaryText" in patch){raw.hourlyRate=0;fields.add("hourlyRate");}
    if("grade" in patch||"subject" in patch){delete raw.title;fields.add("title");}
    if(rename?.old===old){raw.id=raw.orderNumber=rename.number;fields.add("id");fields.add("orderNumber");}
    const next=normalizeOrder(raw),out={...old};
    for(const k of fields)out[k]=next[k];
    if(rename?.old===old){delete out.explicitNumberReuse;delete out.splitFromId;}
    return out;
  });
}
export function structuralDraftRevision(text){
  const commands=/拆单|拆分|分成.{0,12}单|合并|合成.{0,8}单|另加.{0,8}单|新增.{0,8}单|删除.{0,8}草稿|移除.{0,8}草稿|分别招|各科.{0,6}老师|每科.{0,6}老师/g;
  const value=String(text||"");
  return [...value.matchAll(commands)].some(m=>{
    const prefix=value.slice(0,m.index).split(/[，。；,;！!？?\n]/).pop()||"";
    return !/(?:不要|不用|不必|无需|不需要|禁止|别|不准|取消|不想|不)\s*(?:再|进行|自动|把.{0,15}|将.{0,15})?\s*$/.test(prefix);
  });
}
export async function reviseDraftsWithAI(instruction, drafts, history = [], existingOrders = [], onProgress, signal) {
  if (!Array.isArray(drafts) || !drafts.length) throw new Error("请先整理出草稿");
  const renumber=explicitDraftRenumber(instruction,drafts);
  const structural=structuralDraftRevision(instruction);
  const result = await callServerlessAI("revise_drafts", { instruction, drafts, history, structural },onProgress,signal);
  if(structural&&renumber)throw new Error("拆合单与改号请分别操作");
  const orders=structural?prepareAIDrafts(instruction,result,existingOrders,drafts):applyDraftPatches(instruction,result,drafts,existingOrders);
  const changed=JSON.stringify(orders)!==JSON.stringify(drafts);
  const reply=renumber ? "草稿编号已由 "+renumber.oldNumber+" 更新为 "+renumber.number+"，请核对其余字段后发布。" : changed ? (String(result.reply || "")||"已更新草稿，请核对。") : "本轮未修改草稿，请核对或补充指令。";
  return {source:result.provider || "外部模型 API", reply,
    groupingNotes:result.groupingNotes || [], questions:result.questions || [], timing:result.timing, orders};
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
  // 不把每次查询都附上全部历史单：只有指令涉及的单号才传入对应公开摘要。
  const userContext=[...history.filter(h=>h?.role==="user").map(h=>h.content),commandText].join("\n");
  const orderNumbers=new Set([...userContext.matchAll(/#\d{3,7}(?:-\d+)?/g)].map(m=>m[0]));
  const pool=Array.isArray(orders)?orders:[];
  const relevant=orderNumbers.size ? pool.filter(o=>orderNumbers.has(String(o.orderNumber||"")) ||
    orderNumbers.has(String(o.id||""))) :
    /家教单|订单|单号|改.*单|那个单|时薪|科目|学生|上课/.test(commandText) ? pool.slice(0,25) : [];
  const summaries=relevant.slice(0,60).map(o=>({
    id:o.id,orderNumber:o.orderNumber,title:o.title,grade:o.grade,subject:o.subject,
    publicAddress:o.publicAddress,status:o.status,salaryText:o.salaryText,
    weeklyFrequency:o.weeklyFrequency,requirements:o.requirements
  }));
  const remote=await callServerlessAI("site_command",{
    command:commandText,history,siteConfig:currentSiteConfig,orders:summaries
  });
  const checked=guardSiteActions(remote,userContext,orders);
  return {source:remote.provider || "外部模型 API",reply:String(remote.reply || ""),
    questions:Array.isArray(remote.questions)?remote.questions:[],...checked};
}

