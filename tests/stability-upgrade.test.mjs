import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {normalizeOrder,formatOrderText,parseFormattedOrder} from "../js/order-format.js";
import {structuralDraftRevision,applyDraftPatches} from "../js/ai-engine.js";
import {isPubliclyOpenOrder} from "../js/board-utils.js";
import {onRequest} from "../functions/api/store.js";
import {setAIProviderFallback,saveAIProvider} from "../shared/ai-provider-registry.js";

function fixture(){
  const data=new Map();
  return {TUTOR_KV:{get:async k=>data.get(k)||null,put:async(k,v)=>data.set(k,v)},AUTH_SECRET:"test-secret",ADMIN_PASSWORD:"test-password",OPENAI_API_KEY:"test-env-key"};
}
async function post(env,body,auth=true){
  const c=btoa(JSON.stringify({role:"admin",id:"admin",jti:"test-stability-1234567890",exp:Date.now()+60000}));
  const token=c+"."+createHmac("sha256",env.AUTH_SECRET).update(c).digest("hex");
  const response=await onRequest({env,request:new Request("https://test.pages.dev/api/store",{method:"POST",headers:{"Content-Type":"application/json",...(auth?{Authorization:"Bearer "+token}:{})},body:JSON.stringify(body)})});
  return {status:response.status,data:await response.json()};
}
const order=(id,extra={})=>({id,orderNumber:id,grade:"高一",subject:"数学",publicAddress:"天津市和平区岳阳道",salaryText:"150元/小时",...extra});
test("未知课时、人数、薪资不凭空补全，标准文案往返保持未知",()=>{
  const o=normalizeOrder({id:"#3080",grade:"高一",subject:"数学"});
  assert.equal(o.teacherCount,0);assert.equal(o.hoursPerSession,0);
  assert.equal(o.salaryText,"薪资待补充");assert.equal(o.requirements,"要求待补充");
  const roundTrip=parseFormattedOrder(formatOrderText(o));
  assert.equal(roundTrip.hoursPerSession,0);assert.equal(roundTrip.teacherCount,0);
  assert.equal(roundTrip.salaryText,"薪资待补充");
});
test("否定结构修改不会进入拆合流程，肯定指令仍可识别",()=>{
  for(const s of ["不要拆单","不需要合并","保持科目，不要拆分","不用把数学物理合并"])assert.equal(structuralDraftRevision(s),false,s);
  for(const s of ["拆分数学和物理","把数学物理合并","不要拆单，但新增一单"])assert.equal(structuralDraftRevision(s),true,s);
});
test("发布重试幂等、内部ID稳定、原单改号不复制订单",async()=>{
  const env=fixture(),initial=await post(env,{action:"admin_data"});
  const body={action:"admin_publish_ai_drafts",stableIds:true,idempotencyKey:"test-publish-123456789",orders:[order("#3080")],orderRevision:initial.data.orderRevision};
  const first=await post(env,body);assert.equal(first.status,200);
  const id=first.data.published[0].id;assert.match(id,/^order-/);
  const retry=await post(env,body);assert.equal(retry.status,200);assert.equal(retry.data.replayed,true);
  assert.equal(retry.data.orders.length,1);assert.equal(retry.data.published[0].id,id);
  const linked={...first.data.published[0],id:"#3080",existingOrderId:id};
  const [draft]=applyDraftPatches("编号改成3081",{orders:[{id:"#3080",changes:{}}]},[linked],first.data.orders);
  assert.equal(draft.renameFromNumber,"#3080");
  const renamed=await post(env,{action:"admin_publish_ai_drafts",stableIds:true,orders:[draft],orderRevision:first.data.orderRevision});
  assert.equal(renamed.status,200);assert.equal(renamed.data.orders.length,1);assert.equal(renamed.data.published[0].id,id);assert.equal(renamed.data.published[0].orderNumber,"#3081");
});
test("静态单迁移只补缺失且保留旧隐藏记录",async()=>{
  const env=fixture();
  await env.TUTOR_KV.put("orders",JSON.stringify([order("fs-0001",{orderNumber:"#3001",salaryText:"200元/小时"})]));
  await env.TUTOR_KV.put("hidden_imported_orders",JSON.stringify(["fs-0002"]));
  const rows=[order("fs-0001",{orderNumber:"#3001"}),order("fs-0002",{orderNumber:"#3002"}),order("fs-0003",{orderNumber:"#3003"})];
  const result=await post(env,{action:"admin_migrate_static_orders",orders:rows});
  assert.equal(result.status,200);assert.equal(result.data.added,1);assert.equal(result.data.staticImportMigrated,true);
  assert.equal(result.data.orders.find(o=>o.id==="fs-0001").salaryText,"200元/小时");
  assert(!result.data.orders.some(o=>o.id==="fs-0002"));
  const retry=await post(env,{action:"admin_migrate_static_orders",orders:rows});assert.equal(retry.data.added,0);
});
test("回收站停止公开展示，可恢复原状态；备份日志仅管理员可读",async()=>{
  const env=fixture();
  let result=await post(env,{action:"admin_add_orders",orders:[order("#3080",{status:"招募中"})]});
  result=await post(env,{action:"admin_trash_order",id:"#3080",orderRevision:result.data.orderRevision});
  assert.equal(result.status,200);assert.equal(result.data.orders[0].status,"已删除");
  assert.equal(isPubliclyOpenOrder(result.data.orders[0]),false);
  const publicRes=await onRequest({env,request:new Request("https://test.pages.dev/api/store")});
  assert.equal((await publicRes.json()).orders.length,0);
  const restored=await post(env,{action:"admin_restore_order",id:"#3080",orderRevision:result.data.orderRevision});
  assert.equal(restored.data.orders[0].status,"招募中");
  const audit=await post(env,{action:"admin_audit_log"});assert(audit.data.entries.some(e=>e.action==="admin_trash_order"));
  const backup=await post(env,{action:"admin_export_current"});assert(backup.data.backup.data.orders.length);
  assert(!JSON.stringify(backup.data).includes("test-env-key"));
  assert.equal((await post(env,{action:"admin_export_current"},false)).status,401);
});
test("服务器拒绝异常薪资区间",async()=>{
  const env=fixture();const r=await post(env,{action:"admin_add_orders",orders:[order("#3080",{salaryText:"150～100元/小时"})]});
  assert.equal(r.status,400);
});
test("备用模型默认关闭，必须显式配置，且不会回显密钥",async()=>{
  const env=fixture();const registry=await saveAIProvider(env.TUTOR_KV,env,{name:"备用",baseUrl:"https://api.example.com/v1",apiKey:"test-backup-key",models:["model-b"]});
  const id=registry.profiles[0].id;
  assert.equal(registry.fallbackId,"");
  const enabled=await setAIProviderFallback(env.TUTOR_KV,env,id,"model-b");
  assert.equal(enabled.fallbackId,id);assert(!JSON.stringify(enabled).includes("test-backup-key"));
  assert.equal((await setAIProviderFallback(env.TUTOR_KV,env,"","")).fallbackId,"");
});
