import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {onRequest} from "../functions/api/store.js";
const fixture=()=>{const data=new Map();return {TUTOR_KV:{get:async k=>data.get(k)||null,put:async(k,v)=>data.set(k,v)},AUTH_SECRET:"unique-test-secret",ADMIN_PASSWORD:"test-password"};};
async function post(env,orders){
  const c=btoa(JSON.stringify({role:"admin",id:"admin",jti:"test-publish-numbering-123",exp:Date.now()+60000}));
  const token=c+"."+createHmac("sha256",env.AUTH_SECRET).update(c).digest("hex");
  const response=await onRequest({env,request:new Request("https://test.pages.dev/api/store",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify({action:"admin_publish_ai_drafts",orders})})});
  return {status:response.status,data:await response.json()};
}
const order=(id,subject,extra={})=>({id,orderNumber:id,grade:"高一",subject,...extra});
test("发布历史拆单保留原单，重号独立，主序号不倒退",async()=>{
  const env=fixture();
  let r=await post(env,[order("#2770","数学、物理"),order("#3063","生物")]);
  assert.equal(r.status,200);assert.equal(r.data.orderSequence,3063);
  r=await post(env,[order("#2770-1","数学",{splitFromId:"#2770"}),order("#2770-2","物理",{splitFromId:"#2770"})]);
  assert.equal(r.status,200);assert.equal(r.data.orderSequence,3063);
  assert.equal(r.data.orders.find(o=>o.id==="#2770").status,"已关闭");
  r=await post(env,[order("#3063","英语",{explicitNumberReuse:true})]);
  assert.equal(r.status,200);assert.equal(r.data.orders.filter(o=>o.orderNumber==="#3063").length,2);
  assert.notEqual(r.data.published[0].id,"#3063");
  r=await post(env,[order("#3063","化学")]);assert.equal(r.status,409);
});
