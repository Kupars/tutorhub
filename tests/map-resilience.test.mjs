import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {onRequestPost} from "../functions/api/commute.js";
import {isGeocodeServiceUnavailable} from "../js/map-board.js";
const req=body=>new Request("https://test.example/api/commute",{method:"POST",body:JSON.stringify(body),headers:{"Content-Type":"application/json"}});
test("本地地图组件不依赖 unpkg，保留示意图和在线底图重试",()=>{
 const s=readFileSync(new URL("../js/map-board.js",import.meta.url),"utf8");
 assert.match(s,/\.\/js\/vendor\/leaflet\.js/);assert.match(s,/showSchematic/);assert.doesNotMatch(s,/unpkg\.com/);
 assert(readFileSync(new URL("../js/vendor/leaflet.js",import.meta.url),"utf8").includes("Leaflet 1.9.4"));
});
test("高德配置缺失与 IP 白名单错误可区分且不泄露 Key",async()=>{
 const original=globalThis.fetch;
 try{
  let res=await onRequestPost({request:req({action:"geocode",address:"天津大学"}),env:{}});
  assert.equal((await res.json()).errorCode,"AMAP_KEY_NOT_CONFIGURED");
  globalThis.fetch=async()=>new Response(JSON.stringify({status:"0",infocode:"10005",info:"INVALID_USER_IP"}));
  res=await onRequestPost({request:req({action:"suggest",keywords:"天津大学"}),env:{AMAP_KEY:"private-test-key"}});
  const body=await res.json();assert.equal(body.errorCode,"10005");assert(isGeocodeServiceUnavailable(body));assert(!JSON.stringify(body).includes("private-test-key"));
  globalThis.fetch=async()=>{throw new Error("URL contains private-test-key");};
  res=await onRequestPost({request:req({action:"geocode",address:"天津大学"}),env:{AMAP_KEY:"private-test-key"}});
  const failure=await res.json();assert.equal(failure.errorCode,"AMAP_UPSTREAM_UNREACHABLE");assert(!JSON.stringify(failure).includes("private-test-key"));
 }finally{globalThis.fetch=original;}
});
