import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {onRequest} from "../functions/api/store.js";
const fixture=()=>{const data=new Map();return {TUTOR_KV:{get:async k=>data.get(k)||null,put:async(k,v)=>data.set(k,v)},AUTH_SECRET:"test-secret",ADMIN_PASSWORD:"test-password"};};
async function post(env,body){
 const c=btoa(JSON.stringify({role:"admin",id:"admin",jti:"test-order-write-safety-123",exp:Date.now()+60000}));
 const token=c+"."+createHmac("sha256",env.AUTH_SECRET).update(c).digest("hex");
 const response=await onRequest({env,request:new Request("https://test.pages.dev/api/store",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify(body)})});
 return {status:response.status,data:await response.json()};
}
const order=(id,subject,extra={})=>({id,orderNumber:id,grade:"高一",subject,studentGender:"女生",publicAddress:"天津市和平区岳阳道",salaryText:"150元/小时",...extra});
test("拒绝过期版本，不覆盖其他写入",async()=>{
 const env=fixture();const initial=await post(env,{action:"admin_data"});
 const revision=initial.data.orderRevision;
 const results=await Promise.all([post(env,{action:"admin_add_orders",orders:[order("#3080","数学")],orderRevision:revision}),post(env,{action:"admin_add_orders",orders:[order("#3081","英语")],orderRevision:revision})]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 const latest=await post(env,{action:"admin_data"});assert.equal(latest.data.orders.length,1);
});
test("合并一笔写入，保留原订单记录并下架子单",async()=>{
 const env=fixture();
 let r=await post(env,{action:"admin_add_orders",orders:[order("#3080","数学"),order("#3081","英语")]});
 r=await post(env,{action:"admin_merge_orders",ids:["#3080","#3081"],merged:{id:"#3080",subject:"数学、英语"},orderRevision:r.data.orderRevision});
 assert.equal(r.status,200);assert.equal(r.data.orders.length,2);assert.equal(r.data.orders.find(o=>o.id==="#3081").status,"已关闭");
 const fail=await post(env,{action:"admin_update_order",id:"#3080",patch:{orderNumber:"#3081"},orderRevision:r.data.orderRevision});assert.equal(fail.status,409);
});
