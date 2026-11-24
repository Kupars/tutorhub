import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {onRequest} from "../functions/api/store.js";
const fixture=()=>{const map=new Map();return {TUTOR_KV:{get:async k=>map.get(k)||null,put:async(k,v)=>map.set(k,v)},AUTH_SECRET:"teacher-storage-test-secret",ADMIN_PASSWORD:"test-password"};};
async function call(env,action,body={},auth=true){
 const raw=btoa(JSON.stringify({role:"admin",id:"admin",jti:"profile-storage-test-123",exp:Date.now()+60000}));
 const token=raw+"."+createHmac("sha256",env.AUTH_SECRET).update(raw).digest("hex");
 const r=await onRequest({env,request:new Request("https://test.pages.dev/api/store",{method:"POST",headers:{"Content-Type":"application/json",...(auth?{Authorization:"Bearer "+token}:{})},body:JSON.stringify({action,...body})})});
 return {status:r.status,data:await r.json()};
}
test("结构化老师档案持久化、独立星标及私有读取",async()=>{
 const env=fixture(),profile={name:"王老师",gender:"男",teacherType:"在校生",currentSchool:"天津大学",graduatedSchool:"某学校",age:20,studyLevel:"本科生",studyYear:"大二",tianjinGaokao:"是",availability:"可接单",agentName:"某代理",specialties:"书法",teachingPairs:[{stage:"初中",subject:"数学"},{stage:"高中",subject:"物理"}],companionOptions:[{stage:"初中",time:"每天晚上"}]};
 let r=await call(env,"admin_save_teacher_profile",{profile});assert.equal(r.status,200);const id=r.data.profileId;
 r=await call(env,"admin_set_teacher_star",{teacherId:id,starred:true});assert.equal(r.status,200);
 r=await call(env,"admin_data");const p=r.data.teacherProfiles.find(x=>x.id===id);
 assert.equal(p.starred,true);assert.equal(p.currentSchool,"天津大学");assert.equal(p.age,20);assert.equal(p.tianjinGaokao,"是");assert.deepEqual(p.teachingPairs,profile.teachingPairs);assert.deepEqual(p.companionOptions,profile.companionOptions);assert.equal(p.agentName,"某代理");
 r=await call(env,"admin_set_teacher_star",{teacherId:id,starred:false},false);assert.equal(r.status,401);
 const pub=await onRequest({env,request:new Request("https://test.pages.dev/api/store")});assert(!JSON.stringify(await pub.json()).includes("王老师"));
});
