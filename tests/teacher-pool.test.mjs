import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { onRequest as storeHandler } from "../functions/api/store.js";
import { onRequestPost as aiHandler } from "../functions/api/ai.js";
import { recommendTeacherProfiles, wantedTeacherGender, nextFamilySubIds } from "../js/teacher-profile-utils.js";
import { groupDraftsUnderParent, checkDraftIds } from "../js/draft-grouping.js";
import { teacherResumePrompt, sanitizeTeacherResumeResult } from "../shared/teacher-resume-skill.js";

const fixture=()=>{
  const kv=new Map();
  return {AUTH_SECRET:"teacher-pool-test-secret-0123456789",ADMIN_PASSWORD:"strong-test-password",
    OPENAI_API_KEY:"fake-key",OPENAI_BASE_URL:"https://api.example.com/v1",OPENAI_MODEL:"fake-vision",
    TUTOR_KV:{get:async key=>kv.get(key)||null,put:async(key,v)=>kv.set(key,v)}};
};
function token(env){
  const raw=btoa(JSON.stringify({role:"admin",id:"admin",jti:"test-session-teacher-1234",exp:Date.now()+60000}));
  return raw+"."+createHmac("sha256",env.AUTH_SECRET).update(raw).digest("hex");
}
async function postStore(env,action,payload={}){
  const request=new Request("https://test.pages.dev/api/store",{method:"POST",
    headers:{"Content-Type":"application/json",Authorization:"Bearer "+token(env)},
    body:JSON.stringify({action,...payload})});
  const response=await storeHandler({env,request});
  return {status:response.status,data:await response.json()};
}

test("一份档案可储备未投任何订单的老师，三位老师可投同一单且不会自动关闭",async()=>{
  const env=fixture();
  const names=["王老师","李老师","张老师"];
  let ids=[];
  for(const name of names){
    const r=await postStore(env,"admin_save_teacher_profile",{profile:{
      name,canTeach:"数学、物理",school:"天津大学",gender:"男",availability:"可接单"}});
    assert.equal(r.status,200);
    ids.push(r.data.profileId);
  }
  const create=await postStore(env,"admin_add_orders",{orders:[
    {id:"#3003",orderNumber:"#3003",grade:"高二",subject:"数学、物理",status:"招募中",district:"津南区",publicAddress:"津南区"}
  ]});
  assert.equal(create.status,200);
  for(const teacherId of ids) {
    const r=await postStore(env,"admin_save_teacher_application",{teacherId,orderId:"#3003",status:"已投递",agentName:"小木代理"});
    assert.equal(r.status,200);
    assert.equal(r.data.teacherApplications.find(x=>x.teacherId===teacherId).agentName,"小木代理");
  }
  const all=await postStore(env,"admin_data");
  assert.equal(all.data.teacherProfiles.length,3);
  assert.equal(all.data.teacherApplications.length,3);
  assert.equal(all.data.orders[0].status,"招募中");
  const publicRes=await storeHandler({env,request:new Request("https://test.pages.dev/api/store")});
  const publicData=await publicRes.json();
  assert.equal(publicData.orders.length,1);
  assert(!JSON.stringify(publicData).includes("王老师"));
  assert(!JSON.stringify(publicData).includes("小木代理"));
});

test("已接满和未确认老师不进入推荐，老师性别与学科按实际条件校验",()=>{
  const p=[
    {id:"a",name:"甲",gender:"男",canTeach:"数学、物理",availability:"可接单"},
    {id:"b",name:"乙",gender:"女",canTeach:"数学、物理",availability:"已接满"},
    {id:"c",name:"丙",gender:"女",canTeach:"数学",availability:"可接单"},
    {id:"d",name:"丁",gender:"女",canTeach:"数学、物理",availability:"可接单"},
    {id:"e",name:"戊",gender:"女",canTeach:"数学、物理",availability:"待确认"}
  ];
  const order={id:"#3010",subject:"数学、物理",teacherCount:1,requirements:"女老师优先"};
  assert.deepEqual(recommendTeacherProfiles(order,p).map(x=>x.name),["丁","甲"]);
  assert.deepEqual(recommendTeacherProfiles({...order,requirements:"仅限女老师"},p).map(x=>x.name),["丁"]);
  assert.deepEqual(wantedTeacherGender({requirements:"男老师优先"}),{gender:"男",strict:false});
});

test("投递经历提供历史地区偏好，但不是老师住址；没有明确可教科目不推荐",()=>{
  const profiles=[{id:"a",name:"刘老师",gender:"未知",canTeach:"数学",availability:"可接单"},
    {id:"b",name:"空档案",gender:"未知",canTeach:"",availability:"可接单"}];
  const candidacies=[{id:"c",teacherId:"a",orderId:"#2801",status:"已投递"}];
  const orders=[{id:"#2801",subject:"数学",district:"河西区",publicAddress:"河西区某小区"}];
  const rec=recommendTeacherProfiles({id:"#3000",subject:"数学",district:"河西区",publicAddress:"河西区某小区"},profiles,candidacies,orders);
  assert.equal(rec.length,1);
  assert.match(rec[0].reasons.join(" "),/过去曾投递/);
  assert.match(rec[0].warning,/不代表老师住址/);
});

test("相同来源需求可编成主编号-1、主编号-2，绝不合并两名学生内容",()=>{
  const drafts=[
    {id:"#3011",orderNumber:"#3011",grade:"高一",subject:"数学",studentGender:"男生"},
    {id:"#3012",orderNumber:"#3012",grade:"高三",subject:"英语",studentGender:"女生"}
  ];
  const grouped=groupDraftsUnderParent(drafts,[0,1],[]);
  assert.deepEqual(grouped.map(o=>o.id),["#3011-1","#3011-2"]);
  assert.deepEqual(grouped.map(o=>o.grade),["高一","高三"]);
  assert.deepEqual(checkDraftIds(grouped,[]),[]);
  assert.deepEqual(nextFamilySubIds("#3011",2,[{id:"#3011-1"}]),["#3011-2","#3011-3"]);
});

test("AI 简历提取只保留姓名学校、明确老师性别、能教科目；不回传微信",()=>{
  const prompt=teacherResumePrompt("姓名王老师，性别男，天津大学，能带高中物理");
  assert.match(prompt.system,/不能.*姓名.*照片/);
  assert.match(prompt.user,/高中物理/);
  const safe=sanitizeTeacherResumeResult({
    teacherName:"王老师",teacherSchool:"天津大学",teacherGender:"男",canTeach:"物理",
    teacherType:"在校生",teacherContact:"wx_private",phone:"13800000000",confidence:"高"});
  assert.equal(safe.teacherName,"王老师");
  assert.equal(safe.teacherGender,"男");
  assert.equal(safe.canTeach,"物理");
  assert(!JSON.stringify(safe).includes("wx_private"));
});
test("简历图片在有权限情况下提交到视觉模型，不存储原文件",async()=>{
  const env=fixture();
  const original=globalThis.fetch;
  let sentImage=false;
  globalThis.fetch=async(_url,request)=>{
    const body=JSON.parse(request.body);
    sentImage=Array.isArray(body.messages[1].content) && body.messages[1].content[1].type==="image_url";
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
      teacherName:"王老师",teacherGender:"未知",teacherSchool:"天津大学",
      canTeach:"数学",teacherType:"在校生",confidence:"中",teacherContact:"should_not_leak"
    })}}]}),{status:200});
  };
  try{
    const request=new Request("https://test.pages.dev/api/ai",{method:"POST",
      headers:{Authorization:"Bearer "+token(env),"Content-Type":"application/json"},
      body:JSON.stringify({action:"extract_teacher_resume",payload:{
        text:"简历，数学老师",consent:true,imageData:"data:image/jpeg;base64,aGVsbG8="
      }})});
    const res=await aiHandler({request,env});
    assert.equal(res.status,200);
    const data=await res.json();
    assert.equal(data.result.teacherName,"王老师");
    assert.equal(sentImage,true);
    assert(!JSON.stringify(data.result).includes("should_not_leak"));
  }finally{globalThis.fetch=original;}
});
