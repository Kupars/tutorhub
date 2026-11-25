import {formatOrderText,parseFormattedOrder,normalizeOrder} from "./order-format.js";
const KEY="tutorhub_admin_workspace_v3";
const fields=["id","orderNumber","grade","subject","studentGender","teacherCount","currentScores","address","weeklyFrequency","hoursPerSession","requirements","salaryText","trialTime","notes","onlineAllowed","urgent"];
export function workspaceSnapshot(state){
  return JSON.parse(JSON.stringify({parsedDraftOrders:state.parsedDraftOrders||[],aiDraftHistory:state.aiDraftHistory||[],aiRawText:state.aiRawText||"",aiDraftGroupingNotes:state.aiDraftGroupingNotes||[],aiDraftQuestions:state.aiDraftQuestions||[],aiDraftReply:state.aiDraftReply||"",pendingDraftText:state.pendingDraftText||{},draftLockNumber:state.draftLockNumber===true,draftLockSalary:state.draftLockSalary===true,pendingPublish:state.pendingPublish||null}));
}
export function loadWorkspace(storage){try{const v=JSON.parse(storage.getItem(KEY)||"null");return v?.current&&Array.isArray(v.current.parsedDraftOrders)?v:null;}catch{return null;}}
export function saveWorkspace(storage,current,history=[]){try{storage.setItem(KEY,JSON.stringify({current,history:history.slice(-12)}));return true;}catch{return false;}}
export function clearWorkspace(storage){try{storage.removeItem(KEY);}catch{}}
export function draftDiff(before,after){
  const a=new Map(before.map(o=>[o.orderNumber||o.id,o])),b=new Map(after.map(o=>[o.orderNumber||o.id,o]));
  const names={grade:"年级",subject:"科目",studentGender:"性别",teacherCount:"老师数量",currentScores:"成绩",address:"地址",weeklyFrequency:"排课",hoursPerSession:"课时",requirements:"要求",salaryText:"薪资",trialTime:"试课",notes:"备注",onlineAllowed:"可网课",urgent:"急招"};
  return [...new Set([...a.keys(),...b.keys()])].flatMap(id=>{
    const old=a.get(id),next=b.get(id);
    if(!old||!next)return [id+" "+(old?"移除":"新增")+" "+(old?.subject||next?.subject||"")];
    return Object.keys(names).filter(k=>String(old[k]??"")!==String(next[k]??"")).map(k=>id+" "+names[k]+"："+String(old[k]??"")+" → "+String(next[k]??""));
  });
}
export function applyManualDraftText(old,text){
  const original=formatOrderText(old);
  if(String(text).trim()===original.trim())return old;
  const parsed=parseFormattedOrder(text),baseline=parseFormattedOrder(original);
  if(!parsed||!baseline||!/^#\d{3,7}(?:-\d+)?$/.test(parsed.id||"")||/待补充/.test(parsed.grade)||/待补充/.test(parsed.subject))throw new Error("标准文案中的编号、年级或科目无效");
  const changed=fields.filter(k=>String(parsed[k]??"")!==String(baseline[k]??""));
  if(!changed.length)return old;
  const raw={...old};for(const k of changed)raw[k]=parsed[k];
  if(changed.includes("id")){if(old.existingOrderId||old.splitFromId)throw new Error("历史关联草稿不能改号，请在订单管理操作");raw.orderNumber=raw.id;delete raw.explicitNumberReuse;}
  if(changed.includes("address")){raw.publicAddress=raw.address;delete raw.district;}
  if(changed.includes("weeklyFrequency"))delete raw.sessionsPerWeek;
  if(changed.includes("salaryText"))raw.hourlyRate=0;
  if(changed.includes("grade")||changed.includes("subject"))delete raw.title;
  return normalizeOrder(raw);
}
