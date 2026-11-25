import {getPublicMapLocation,wgs84ToGcj02,gcj02ToWgs84,adoptPublicRouteLocation} from "./map-board.js?v=14";
import {isPlausiblePublicGeocode,verifiedPublicLandmarkCoords,inferNamedLandmarkCoords} from "./commute.js?v=6";
import {mapGeocodeQuery,isDistrictOnlyAddress} from "./address-normalizer.js";
const cache=new Map(),pending=new Map(),places=new Map(),orderStates=new Map();
const valid=p=>p&&p.lat!=null&&p.lng!=null&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng));
const quantize=p=>{const g=p.gcj02?p:wgs84ToGcj02(Number(p.lat),Number(p.lng));return {lat:Math.round(g.lat*1000)/1000,lng:Math.round(g.lng*1000)/1000};};
const pairKey=(o,d)=>{const a=quantize(o),b=quantize(d);return [a.lat,a.lng,b.lat,b.lng].join("|");};
const post=async body=>{
 const r=await fetch("/api/commute",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
 return await r.json();
};
export function orderRoutePoint(order){
 if(order?.mode==="线上"||!order?.publicAddress||isDistrictOnlyAddress(order.publicAddress,order.district))return null;
 const p=getPublicMapLocation(order);
 return p&&!p.fallback&&valid(p)?p:null;
}
export function hasRouteAddress(order){
 const a=String(order?.publicAddress||"");return Boolean(a&&!isDistrictOnlyAddress(a,order?.district)&&!/待补充|某小区|线上|网课/.test(a));
}
export async function resolveRoutePoint(order){
 const local=orderRoutePoint(order);if(local)return local;
 const address=String(order?.publicAddress||"");
 if(!hasRouteAddress(order))return null;
 const query=mapGeocodeQuery(address,order.district);
 if(!query||query.length<4)return null;
 if(places.has(query))return places.get(query);
 const job=(async()=>{
  try{
   const data=await post({action:"geocode",address:query});
   if(!data.ok||!valid(data))return null;
   const p={...data,...gcj02ToWgs84(data.lat,data.lng),gcj02:false};
   if(!isPlausiblePublicGeocode({publicAddress:address,district:order.district},p))return null;
   adoptPublicRouteLocation(query,p);
   return p;
  }catch{return null;}
 })();
 if(places.size>=200)places.delete(places.keys().next().value);
 places.set(query,job);const p=await job;if(!p)places.delete(query);return p;
}
export async function resolveDepartureLandmark(value){
 const address=String(value||"").trim();
 if(!address||/门牌|单元|室|号楼|\d{5,}/.test(address))return null;
 const district=address.match(/和平区|河西区|南开区|河东区|河北区|红桥区|津南区|西青区|东丽区|北辰区|滨海新区|武清区|宝坻区|静海区|宁河区|蓟州区/)?.[0]||"";
 const local=verifiedPublicLandmarkCoords(address)||inferNamedLandmarkCoords(address,district);
 if(local)return local;
 if(isDistrictOnlyAddress(address,district))return null;
 // Teacher departure landmark: do not persist in the public geocode cache.
 try{
   const data=await post({action:"geocode",address:mapGeocodeQuery(address,district)});
   if(!data.ok||!valid(data))return null;
   const p={...data,...gcj02ToWgs84(data.lat,data.lng),gcj02:false};
   return isPlausiblePublicGeocode({publicAddress:address,district},p)?p:null;
 }catch{return null;}
}
export function getRouteResult(origin,dest){
 if(!valid(origin)||!valid(dest))return null;
 const hit=cache.get(pairKey(origin,dest));return hit&&hit.until>Date.now()?hit.value:null;
}
export async function requestRoute(origin,dest){
 if(!valid(origin)||!valid(dest))return null;
 const key=pairKey(origin,dest),hit=getRouteResult(origin,dest);
 if(hit)return hit;if(pending.has(key))return pending.get(key);
 const job=(async()=>{
  try{
   const data=await post({action:"route",origin:quantize(origin),dest:quantize(dest)});
   const mins=[data.bikeMin,data.transitMin].filter(x=>Number.isFinite(x)&&x>=0);
   const value=data.ok&&data.source==="amap"&&mins.length?{...data,bestMin:Math.min(...mins),isOnline:false}:null;
   if(cache.size>=300)cache.delete(cache.keys().next().value);
   if(value)cache.set(key,{value,until:Date.now()+30*60000});
   return value;
  }catch{return null;}
 })().finally(()=>pending.delete(key));pending.set(key,job);return job;
}
const orderKey=(origin,order)=>JSON.stringify([quantize(origin),order.id,order.publicAddress,order.district]);
export function commuteForOrder(origin,order){
 if(order.mode==="线上")return {isOnline:true,bestMin:0,source:"online"};
 if(!valid(origin))return {status:"origin_missing"};
 if(!hasRouteAddress(order))return {status:"address_missing"};
 const dest=orderRoutePoint(order),result=dest&&getRouteResult(origin,dest);
 if(result)return result;
 const stored=orderStates.get(orderKey(origin,order));
 return stored&&stored.until>Date.now()?{status:stored.status}:{status:"unqueried"};
}
export async function queryOrderCommute(origin,order,{retry=false}={}){
 const current=commuteForOrder(origin,order);
 if(current.isOnline||current.source==="amap"||current.status==="origin_missing"||current.status==="address_missing"||current.status==="loading")return current;
 if(!retry&&current.status!=="unqueried")return current;
 const key=orderKey(origin,order);
 if(orderStates.size>=500)orderStates.delete(orderStates.keys().next().value);
 const set=status=>{orderStates.set(key,{status,until:Date.now()+(status==="loading"?60000:300000)});return {status};};
 set("loading");
 try{
   const dest=await resolveRoutePoint(order);
   if(!dest)return set("location_unverified");
   const route=await requestRoute(origin,dest);
   if(route){orderStates.delete(key);return route;}
   return set("unavailable");
 }catch{return set("unavailable");}
}
export function routeLink(origin,dest,mode){
 if(!valid(origin)||!valid(dest))return "";
 const a=quantize(origin),b=quantize(dest),q=new URLSearchParams({from:a.lng+","+a.lat,to:b.lng+","+b.lat,mode:mode==="ride"?"ride":"bus",src:"TutorHub",callnative:"1"});
 return "https://uri.amap.com/navigation?"+q;
}
export function routeLabel(r){
 if(!r)return "通勤待查询";
 if(r.isOnline)return "线上免通勤";
 if(r.source!=="amap")return ({origin_missing:"请先设置出发地",address_missing:"家教地址待核实",location_unverified:"地址尚未成功定位",loading:"正在查询高德通勤…",unavailable:"通勤查询暂不可用",unqueried:"通勤待查询"})[r.status]||"通勤查询暂不可用";
 return ["高德规划",r.bikeMin!=null?"骑行 "+r.bikeMin+" 分"+(r.bikeKm!=null?" · "+r.bikeKm+" km":""):"骑行暂无路线",r.transitMin!=null?"公交/地铁 "+r.transitMin+" 分"+(r.transitKm!=null?" · "+r.transitKm+" km":""):"公交暂无路线"].join("｜");
}
export async function runLimited(items,worker,limit=2){
 let next=0;const result=new Array(items.length);
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;try{result[i]=await worker(items[i]);}catch{result[i]=null;}}}));
 return result;
}
