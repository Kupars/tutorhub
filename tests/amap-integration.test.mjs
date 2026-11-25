import test from "node:test";
import assert from "node:assert/strict";
import {onRequestPost} from "../functions/api/commute.js";
import {handleAmapProxy} from "../shared/amap-proxy.js";
import {gcj02ToWgs84,wgs84ToGcj02} from "../js/map-board.js";
const env={AMAP_JS_KEY:"public-js-key",AMAP_JS_SECURITY_CODE:"private-code",AMAP_KEY:"private-web-key"};
test("JS config exposes only the public JS key",async()=>{
 const request=new Request("https://tutor.kupars.top/api/commute",{method:"POST",body:JSON.stringify({action:"map_config"})});
 const res=await onRequestPost({request,env});const raw=await res.text();
 assert.equal(JSON.parse(raw).jsKey,"public-js-key");assert(!raw.includes("private-code"));assert(!raw.includes("private-web-key"));
});
test("AMap proxy adds server security code and rejects arbitrary keys or origins",async()=>{
 const original=globalThis.fetch;
 try{
  let upstream;
  globalThis.fetch=async u=>{upstream=new URL(u);return new Response('{"status":"1"}',{headers:{"Content-Type":"application/json"}});};
  const req=(query,referer="https://tutor.kupars.top/")=>new Request("https://tutor.kupars.top/_AMapService/v3/log/init?"+query,{headers:{Referer:referer}});
  const res=await handleAmapProxy(req("key=public-js-key&jscode=wrong"),env);
  assert.equal(res.status,200);assert.equal(upstream.host,"restapi.amap.com");assert.equal(upstream.searchParams.get("jscode"),"private-code");assert(!(await res.text()).includes("private-code"));
  assert.equal((await handleAmapProxy(req("key=private-web-key"),env)).status,403);
  assert.equal((await handleAmapProxy(req("key=public-js-key","https://example.org"),env)).status,403);
 }finally{globalThis.fetch=original;}
});
test("existing WGS84 pins convert back to GCJ02 without duplicate offset",()=>{
 const p={lat:39.1,lng:117.2};const g=wgs84ToGcj02(p.lat,p.lng),w=gcj02ToWgs84(g.lat,g.lng);
 assert(Math.abs(w.lat-p.lat)<1e-7);assert(Math.abs(w.lng-p.lng)<1e-7);
});

test("JSONP responses retain nosniff and are valid JavaScript with only a validated callback",async()=>{
 const original=globalThis.fetch;
 try{
  const req=callback=>new Request("https://tutor.kupars.top/_AMapService/v3/log/init?key=public-js-key&callback="+encodeURIComponent(callback),{headers:{Referer:"https://tutor.kupars.top/"}});
  for(const upstream of ['{"status":"1"}','jsonp_123({"status":"1"});']){
   globalThis.fetch=async()=>new Response(upstream,{headers:{"Content-Type":"text/plain"}});
   const res=await handleAmapProxy(req("jsonp_123"),env);
   assert.equal(res.status,200);assert.match(res.headers.get("content-type"),/^application\/javascript/);assert.equal(res.headers.get("x-content-type-options"),"nosniff");assert.equal(await res.text(),'jsonp_123({"status":"1"});');
  }
  globalThis.fetch=async()=>new Response('jsonp_123({});alert(1)',{headers:{"Content-Type":"text/html"}});
  assert.equal((await handleAmapProxy(req("jsonp_123"),env)).status,502);
  assert.equal((await handleAmapProxy(req("foo);alert(1)//"),env)).status,400);
 }finally{globalThis.fetch=original;}
});
