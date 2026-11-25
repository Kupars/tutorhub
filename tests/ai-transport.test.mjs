import test from "node:test";
import assert from "node:assert/strict";
import {requestAIJSON,safeProviderDetail} from "../shared/ai-transport.js";
import {callServerlessAI} from "../js/ai-engine.js";
test("an early HTML 502 from the model relay gets exactly one bounded retry",async()=>{
 let calls=0;const result=await requestAIJSON("https://example.com",{},{
  fetcher:async()=>++calls===1?new Response("<html>Bad gateway</html>",{status:502}):new Response('{"choices":[]}'),
  sleep:async()=>{}
 });
 assert.equal(calls,2);assert.deepEqual(result,{choices:[]});
});
test("permanent errors and late gateway failure are not retried; secrets redacted",async()=>{
 let calls=0;
 await assert.rejects(requestAIJSON("https://example.com",{},{
  secret:"secret-test",fetcher:async()=>{calls++;return new Response('{"error":{"message":"余额不足 secret-test"}}',{status:402});},sleep:async()=>{}
 }),e=>e.code==="AI_UPSTREAM_REJECTED"&&!e.message.includes("secret-test"));
 assert.equal(calls,1);
 let time=0;calls=0;
 await assert.rejects(requestAIJSON("https://example.com",{},{
  clock:()=>time,fetcher:async()=>{calls++;time=45000;return new Response("bad gateway",{status:502});},sleep:async()=>{}
 }),e=>e.code==="AI_UPSTREAM_NON_JSON");
 assert.equal(calls,1);
});
test("website gateway error retries once but structured upstream errors never repeat",async()=>{
 const old=globalThis.fetch;let n=0,progress="";
 try{
  globalThis.fetch=async()=>++n===1?new Response("<html>gateway</html>",{status:502}):new Response('{"ok":true,"result":{"orders":[]}}');
  assert.deepEqual(await callServerlessAI("parse_orders",{},v=>{progress=v;}),{orders:[]});assert.equal(n,2);assert.match(progress,/重试/);
  n=0;globalThis.fetch=async()=>{n++;return new Response('{"ok":false,"error":"模型中转站异常","errorCode":"AI_UPSTREAM_GATEWAY","requestId":"abcd"}',{status:502});};
  await assert.rejects(callServerlessAI("parse_orders"),/诊断编号 abcd/);assert.equal(n,1);
 }finally{globalThis.fetch=old;}
});
