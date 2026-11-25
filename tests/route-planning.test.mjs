import test from "node:test";
import assert from "node:assert/strict";
import {planCommute} from "../shared/route-service.js";
import {applyPlannedRoute} from "../js/teacher-profile-utils.js";
import {routeLabel,routeLink,runLimited} from "../js/route-client.js";
test("route API uses actual duration and per-mode distances, caches identical requests",async()=>{
 let calls=0;const fetcher=async url=>{calls++;return new Response(JSON.stringify(url.includes("bicycling")?{errcode:0,data:{paths:[{duration:1800,distance:7500,steps:[{instruction:"沿道路骑行"}]}]}}:{status:"1",route:{transits:[{duration:1500,distance:8200,segments:[{bus:{buslines:[{name:"地铁1号线"}]}}]}]}}));};
 const body={origin:{lat:39.1,lng:117.2},dest:{lat:39.05,lng:117.23}};
 const env={AMAP_KEY:"test-secret"};
 const r=await planCommute(body,env,fetcher);assert.equal(r.bikeMin,30);assert.equal(r.transitMin,25);assert.equal(r.bikeKm,7.5);assert.equal(r.transitKm,8.2);assert.deepEqual(r.transitLines,["地铁1号线"]);
 assert.equal((await planCommute(body,env,fetcher)).cached,true);assert.equal(calls,2);
 assert(!JSON.stringify(r).includes("test-secret"));
});
test("partial route failure preserves available mode, invalid input rejected",async()=>{
 const r=await planCommute({origin:{lat:39.12,lng:117.2},dest:{lat:39.15,lng:117.22}},{AMAP_KEY:"x"},async u=>{if(u.includes("bicycling"))throw Error();return new Response(JSON.stringify({status:"1",route:{transits:[{duration:"600",distance:"4000"}]}}));});
 assert.equal(r.ok,true);assert.equal(r.bikeMin,null);assert.equal(r.transitMin,10);
 assert.equal((await planCommute({origin:{lat:NaN,lng:1},dest:{}},{})).errorCode,"INVALID_COORDINATES");
});
test("real routes replace distance bonus without removing eligibility or star reasons",()=>{
 const match={score:20,distanceKm:2,reasons:["星标老师","老师明确出发地与订单地标的直线距离约2公里"]};
 const out=applyPlannedRoute(match,{source:"amap",bestMin:30,bikeMin:30,transitMin:40});
 assert.equal(out.score,18);assert(out.reasons[0].includes("高德规划"));assert(out.reasons.includes("星标老师"));
 assert.equal(routeLabel({source:"estimate",bikeMin:10,transitMin:20}),"通勤查询暂不可用");
 assert.match(routeLink({lat:39.1,lng:117.2},{lat:39.2,lng:117.3},"bus"),/^https:\/\/uri\.amap\.com\/navigation\?/);
});
test("client worker concurrency is bounded",async()=>{
 let n=0,max=0;const r=await runLimited([1,2,3,4],async x=>{n++;max=Math.max(max,n);await Promise.resolve();n--;return x;});
 assert.deepEqual(r,[1,2,3,4]);assert(max<=2);
});

test("new public geocode is immediately usable for route calculation and card result",async()=>{
 const {resolveRoutePoint,requestRoute,commuteForOrder,orderRoutePoint}=await import("../js/route-client.js");
 const orig=globalThis.fetch;
 try{
  globalThis.fetch=async (_url,opts)=>{
   const q=JSON.parse(opts.body);
   return new Response(JSON.stringify(q.action==="geocode"?{ok:true,lat:39.12,lng:117.23,district:"河西区",province:"天津市",level:"住宅区",formattedAddress:"天津市河西区测试花园"}:{ok:true,source:"amap",bikeMin:12,transitMin:16,bikeKm:3.2}));
  };
  const o={id:"test-route",publicAddress:"天津市河西区测试花园",district:"河西区",mode:"线下"},origin={lat:39.1,lng:117.2};
  const p=await resolveRoutePoint(o);assert(p);assert(orderRoutePoint(o));
  await requestRoute(origin,p);
  assert.equal(commuteForOrder(origin,o).bikeMin,12);
 }finally{globalThis.fetch=orig;}
});

test("no synthetic commute time is exposed before AMap succeeds or when location is missing",async()=>{
 const {commuteForOrder,routeLabel,queryOrderCommute}=await import("../js/route-client.js");
 const {estimateCommuteLocal}=await import("../js/commute.js");
 const origin={lat:39.1,lng:117.2},order={id:"unknown-address",mode:"线下",publicAddress:"天津市河西区",district:"河西区"};
 assert.equal(estimateCommuteLocal(origin,order),null);
 assert.equal(commuteForOrder(origin,order).bestMin,undefined);
 assert.equal(routeLabel(commuteForOrder(origin,order)),"家教地址待核实");
 assert.equal(routeLabel(commuteForOrder(null,order)),"请先设置出发地");
 assert.equal(commuteForOrder(null,{mode:"线上"}).bestMin,0);
 const orig=globalThis.fetch;
 try{
   globalThis.fetch=async()=>new Response(JSON.stringify({ok:false,errorCode:"AMAP_UPSTREAM_UNREACHABLE"}));
   const validOrder={...order,id:"failure-address",publicAddress:"天津市河西区不存在测试花园"};
   assert.equal(commuteForOrder(origin,validOrder).status,"unqueried");
   const r=await queryOrderCommute(origin,validOrder);
   assert.equal(r.bestMin,undefined);
   assert.equal(commuteForOrder(origin,validOrder).status,"location_unverified");
 }finally{globalThis.fetch=orig;}
});
