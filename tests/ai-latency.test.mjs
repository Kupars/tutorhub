import test from "node:test";
import assert from "node:assert/strict";
import {formatterPrompt,compactDraftContext} from "../shared/tutoring-order-formatter.js";
import {callServerlessAI} from "../js/ai-engine.js";
test("draft context keeps semantic information and excludes private or derived metadata",()=>{
 const draft={id:"#3063",orderNumber:"#3063",grade:"高一",subject:"数学、物理",studentGender:"男生",teacherCount:2,
  address:"私人楼栋",publicAddress:"天津市河西区津沽东里",hoursPerSession:1.5,weeklyFrequency:"周日",notes:"先试课",salaryText:"120元/小时",onlineAllowed:true,
  privateAddress:"私人楼栋",rawText:"冗余原文".repeat(200),hourlyRate:120,lat:39.1,createdAt:"2026"};
 const compact=compactDraftContext(draft);
 assert.equal(compact.address,draft.publicAddress);
 for(const k of ["id","grade","subject","teacherCount","hoursPerSession","weeklyFrequency","notes","salaryText","onlineAllowed"])assert.equal(compact[k],draft[k]);
 for(const k of ["rawText","privateAddress","lat","createdAt","hourlyRate","publicAddress"])assert.equal(compact[k],undefined);
 const prompt=formatterPrompt("revise_drafts",{instruction:"保留数学物理，改成周六",drafts:[draft]});
 assert(!prompt.user.includes("私人楼栋"));assert(prompt.user.includes("周六"));assert(prompt.user.length<JSON.stringify(draft).length);
});
test("AI timing preserves model and server duration separately from browser duration",async()=>{
 const old=globalThis.fetch;
 try{
  globalThis.fetch=async()=>new Response(JSON.stringify({ok:true,result:{orders:[],timing:{upstreamMs:1300,serverMs:1400}}}));
  const result=await callServerlessAI("parse_orders");
  assert.equal(result.timing.upstreamMs,1300);assert.equal(result.timing.serverMs,1400);assert(result.timing.elapsedMs>=0);
 }finally{globalThis.fetch=old;}
});
