import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { onRequest as storeEndpoint } from "../functions/api/store.js";
import { onRequestPost as aiEndpoint } from "../functions/api/ai.js";

function fixture(overrides={}) {
  const state=new Map();
  return {
    ADMIN_EMAIL:"admin@security-test.invalid",
    ADMIN_PASSWORD:"secure-admin-password-2026",
    AUTH_SECRET:"secure-session-key-for-tests-0123456789",
    OPENAI_API_KEY:"fake-provider-key",OPENAI_BASE_URL:"https://example.invalid/v1",
    OPENAI_MODEL:"fake-vision",
    TUTOR_KV:{
      get:async key=>state.get(key)||null,
      put:async(key,value)=>{state.set(key,value);},
      delete:async key=>{state.delete(key);}
    },...overrides
  };
}
async function callStore(env,action={},token="",origin="https://example.pages.dev") {
  const request=new Request("https://example.pages.dev/api/store",{
    method:"POST",headers:{"Content-Type":"application/json",Origin:origin,
      ...(token?{Authorization:"Bearer "+token}:{})},
    body:JSON.stringify(action)
  });
  const response=await storeEndpoint({env,request});
  return {status:response.status,headers:response.headers,data:await response.json()};
}
async function login(env) {
  const r=await callStore(env,{action:"login",email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD});
  assert.equal(r.status,200);return r.data.token;
}
test("缺少强密码/随机密钥时，公开 GET 保持可用但管理员操作一律关闭",async()=>{
  const env=fixture({ADMIN_PASSWORD:"",AUTH_SECRET:""});
  const get=await storeEndpoint({env,request:new Request("https://example.pages.dev/api/store")});
  assert.equal(get.status,200);
  assert.equal((await get.json()).cloud,true);
  const auth=await callStore(env,{action:"login",email:"admin@security-test.invalid",password:"admin123456"});
  assert.equal(auth.status,503);
  assert.equal(auth.data.code,"ADMIN_SECURITY_NOT_CONFIGURED");
});
test("仅指定管理员邮箱与强密码可登录，旧默认口令不可登录",async()=>{
  const env=fixture();
  assert.equal((await callStore(env,{action:"login",email:"admin@kupars.top",password:env.ADMIN_PASSWORD})).status,401);
  assert.equal((await callStore(env,{action:"login",email:env.ADMIN_EMAIL,password:"admin123456"})).status,401);
  const token=await login(env);
  assert.equal((await callStore(env,{action:"me"},token)).status,200);
});
test("旧 SHA256 伪签名令牌无效，退出后新的 HMAC 会话被服务端撤销",async()=>{
  const env=fixture();
  const token=await login(env);
  const [payload]=token.split(".");
  assert.equal(token.split(".").length,2);
  const forged=payload+"."+createHash("sha256").update(payload+"."+env.AUTH_SECRET).digest("hex");
  assert.equal((await callStore(env,{action:"admin_data"},forged)).status,401);
  assert.equal((await callStore(env,{action:"logout"},token)).status,200);
  assert.equal((await callStore(env,{action:"admin_data"},token)).status,401);
});
test("管理员接口不允许跨站写入；不登录不能读取老师档案",async()=>{
  const env=fixture();
  const token=await login(env);
  assert.equal((await callStore(env,{action:"admin_data"},token,"https://malicious.example")).status,403);
  assert.equal((await callStore(env,{action:"admin_data"})).status,401);
  const save=await callStore(env,{action:"admin_save_teacher_profile",profile:{
    name:"仅后台可见",contact:"微信私密12345",agentName:"代理测试",canTeach:"数学",availability:"待确认"
  }},token);
  assert.equal(save.status,200);
  const publicResponse=await storeEndpoint({env,request:new Request("https://example.pages.dev/api/store")});
  const publicString=await publicResponse.text();
  assert(!publicString.includes("微信私密12345"));
  assert(!publicString.includes("仅后台可见"));
  assert(!publicString.includes("代理测试"));
});
test("公开订单和网站配置只能返回白名单内容，并隐藏号码、具体楼栋",async()=>{
  const env=fixture();
  const token=await login(env);
  await callStore(env,{action:"admin_add_orders",orders:[{id:"#3400",orderNumber:"#3400",grade:"高一",subject:"数学",
    status:"招募中",district:"河西区",publicAddress:"河西区金华苑12号楼3单元502室",
    requirements:"联系13800001234",privateAddress:"后台地址不公开",notes:"后台内部联系"}]},token);
  await env.TUTOR_KV.put("site_config",JSON.stringify({siteName:"看板",theme:"indigo",
    internalApiToken:"private-server-secret-do-not-leak"}));
  const response=await storeEndpoint({env,request:new Request("https://example.pages.dev/api/store")});
  const text=await response.text();
  assert(!text.includes("private-server-secret-do-not-leak"));
  assert(!text.includes("后台地址不公开"));
  assert(!text.includes("13800001234"));
  assert(!text.includes("12号楼"));
  assert(!text.includes("502室"));
  assert(text.includes("河西区金华苑"));
});
test("未经老师授权不得把简历传给第三方 AI",async()=>{
  const env=fixture();const token=await login(env);
  const request=new Request("https://example.pages.dev/api/ai",{
    method:"POST",headers:{"Content-Type":"application/json",Origin:"https://example.pages.dev",
      Authorization:"Bearer "+token},
    body:JSON.stringify({action:"extract_teacher_resume",payload:{text:"姓名李老师，学校天津大学"}})
  });
  const res=await aiEndpoint({env,request});
  assert.equal(res.status,400);
  assert.match((await res.json()).error,/授权/);
});
