import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { onRequestPost as aiHandler, parseModelJSON } from "../functions/api/ai.js";
import { guardSiteActions } from "../js/ai-command-guard.js";

const env={TUTOR_KV:{get:async()=>null,put:async()=>{}},AUTH_SECRET:"ai-test-secret",
  OPENAI_API_KEY:"test-key-only",OPENAI_BASE_URL:"https://lingyuapi.com/v1",OPENAI_MODEL:"example-available-model"};
const token=()=>{
  const payload=btoa(JSON.stringify({id:"admin",role:"admin",exp:Date.now()+100000}));
  return payload+"."+createHash("sha256").update(payload+"."+env.AUTH_SECRET).digest("hex");
};
const post=(action,payload,authenticated=true)=>aiHandler({
  env,request:new Request("https://test.pages.dev/api/ai",{
    method:"POST",headers:{"Content-Type":"application/json",...(authenticated?{Authorization:"Bearer "+token()}:{})},
    body:JSON.stringify({action,payload})
  })
});
test("模型解析支持多条不同需求，不调用内置解析",async()=>{
  const previous=globalThis.fetch;let actualInput="";
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,"https://lingyuapi.com/v1/chat/completions");
    const body=JSON.parse(options.body);
    actualInput=body.messages[0].content+"\n"+body.messages[1].content;
    assert.equal(body.model,"example-available-model");
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
      reply:"提取到两位不同学生，共两张单",groupingNotes:["不同学生分别建单"],
      orders:[
        {id:"",grade:"高二",subject:"数学",studentGender:"女生",address:"天津市河西区",weeklyFrequency:"每周1次",hoursPerSession:2},
        {id:"",grade:"初二",subject:"物理",studentGender:"男生",address:"天津市津南区",weeklyFrequency:"每周2次",hoursPerSession:1.5}
      ]
    })}}]}),{status:200});
  };
  try{
    const res=await post("parse_orders",{text:"甲家长高二数学和乙家长初二物理"});
    assert.equal(res.status,200);
    const output=await res.json();
    assert.equal(output.result.orders.length,2);
    assert.match(actualInput,/tutoring-order-formatter/);
    assert.match(actualInput,/真实历史家教单写法样例/);
    assert(!JSON.stringify(output).includes("test-key-only"));
  }finally{globalThis.fetch=previous;}
});
test("管理员缺失身份时不调用外部模型",async()=>{
  const original=globalThis.fetch;let called=false;
  globalThis.fetch=async()=>{called=true;throw Error("should not call");};
  try{const r=await post("parse_orders",{text:"高一数学"},false);
    assert.equal(r.status,401);assert.equal(called,false);}
  finally{globalThis.fetch=original;}
});
test("模型失效后返回明确错误，不偷偷启用本地规则",async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:"API 余额不足"}}),{status:402});
  try{
    const r=await post("revise_drafts",{instruction:"第二条换成周日",drafts:[{id:"#2992",subject:"数学"}]});
    assert.equal(r.status,500);
    assert.match((await r.json()).error,/余额不足/);
  }finally{globalThis.fetch=original;}
});
test("模型回复含 think 和 JSON 围栏时仅解析完整 JSON",()=>{
  const fence=String.fromCharCode(96).repeat(3);
  assert.deepEqual(parseModelJSON("<think>analysis</think>"+fence+"json\n"+'{"orders":[{"subject":"数学"}]}'+"\n"+fence),
    {orders:[{subject:"数学"}]});
  assert.deepEqual(parseModelJSON('结果如下：{"reply":"你好","actions":[]} 谢谢'),
    {reply:"你好",actions:[]});
  assert.throws(()=>parseModelJSON("没有 JSON"));
});
test("网站对话只能提出经核对的改动，任意脚本与私密字段被丢弃",()=>{
  const orders=[{id:"fs-0041",orderNumber:"#2517",grade:"高一",subject:"物理"}];
  const r=guardSiteActions({actions:[
    {type:"update_order",id:"#2517",patch:{salaryText:"150元/小时（可报价）",requirements:"有耐心",privateAddress:"楼号"}},
    {type:"update_site",patch:{heroTitle:"找家教更快",customJavaScript:"alert(1)"}},
    {type:"delete_order",id:"#2517"}
  ]},"把 #2517 时薪改成150元，要求有耐心。把首页大标题改成找家教更快",orders);
  assert.equal(r.actions.length,2);
  assert.equal(r.actions[0].patch.privateAddress,undefined);
  assert.equal(r.actions[1].patch.customJavaScript,undefined);
  assert(r.discarded.length>0);
});
