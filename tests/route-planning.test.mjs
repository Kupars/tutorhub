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
 assert(routeLabel({source:"estimate",bikeMin:10,transitMin:20}).startsWith("本地估算"));
 assert.match(routeLink({lat:39.1,lng:117.2},{lat:39.2,lng:117.3},"bus"),/^https:\/\/uri\.amap\.com\/navigation\?/);
});
test("client worker concurrency is bounded",async()=>{
 let n=0,max=0;const r=await runLimited([1,2,3,4],async x=>{n++;max=Math.max(max,n);await Promise.resolve();n--;return x;});
 assert.deepEqual(r,[1,2,3,4]);assert(max<=2);
});
