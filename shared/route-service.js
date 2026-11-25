// Bounded in-memory cache, no persistent location history.
const cache=new Map(),pending=new Map();
let day="",spent=0;
const round=v=>Math.round(v*1000)/1000;
const valid=p=>p&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&p.lat>=18&&p.lat<=54&&p.lng>=73&&p.lng<=135;
const metric=(v,factor,precision=0)=>v!==null&&v!==undefined&&v!==""&&Number.isFinite(Number(v))&&Number(v)>=0?Number((Number(v)/factor).toFixed(precision)):null;
const clean=v=>typeof v==="string"?v.slice(0,120):"";
const cityOf=p=>p.lat>=38.5&&p.lat<=40.4&&p.lng>=116.5&&p.lng<=118.5?"天津":null;
export async function planCommute(body,env,fetcher=fetch,now=Date.now()){
 if(!valid(body.origin)||!valid(body.dest))return {ok:false,errorCode:"INVALID_COORDINATES"};
 const origin={lat:round(body.origin.lat),lng:round(body.origin.lng)},dest={lat:round(body.dest.lat),lng:round(body.dest.lng)};
 const city=cityOf(origin);
 if(!city||city!==cityOf(dest))return {ok:false,errorCode:"UNSUPPORTED_CITY"};
 const key=[origin.lng,origin.lat,dest.lng,dest.lat].join(",");
 const hit=cache.get(key);if(hit&&hit.until>now)return {...hit.value,cached:true};
 if(pending.has(key))return pending.get(key);
 const today=new Date(now+8*3600000).toISOString().slice(0,10);
 if(day!==today){day=today;spent=0;}
 const limit=Math.min(5000,Math.max(1,Number(env.AMAP_ROUTE_DAILY_LIMIT)||150));
 if(spent>=limit)return {ok:false,errorCode:"ROUTE_DAILY_LIMIT"};
 if(pending.size>=3)return {ok:false,errorCode:"ROUTE_BUSY"};
 spent++;
 const job=(async()=>{
  const params=new URLSearchParams({origin:origin.lng+","+origin.lat,destination:dest.lng+","+dest.lat,key:env.AMAP_KEY});
  const transit=new URLSearchParams(params);transit.set("city",city);transit.set("strategy","0");
  const request=async url=>{try{const r=await fetcher(url,{signal:AbortSignal.timeout(8000)});return r.ok?await r.json():null;}catch{return null;}};
  const [b,t]=await Promise.all([request("https://restapi.amap.com/v4/direction/bicycling?"+params),request("https://restapi.amap.com/v3/direction/transit/integrated?"+transit)]);
  const bike=String(b?.errcode)==="0"?b?.data?.paths?.[0]:null;
  const transitPaths=t?.status==="1"&&Array.isArray(t.route?.transits)?t.route.transits.filter(p=>metric(p.duration,60)!==null):[];
  const bus=transitPaths.sort((a,b)=>Number(a.duration)-Number(b.duration))[0];
  const bikeMin=metric(bike?.duration,60),transitMin=metric(bus?.duration,60);
  const bikeKm=metric(bike?.distance,1000,1),transitKm=metric(bus?.distance,1000,1);
  const bikeSteps=Array.isArray(bike?.steps)?bike.steps.map(x=>clean(x.instruction||x.road)).filter(Boolean).slice(0,35):[];
  const transitLines=Array.isArray(bus?.segments)?bus.segments.flatMap(x=>{const line=x.bus?.buslines?.[0];return line?.name?[clean(line.name)]:[];}).slice(0,12):[];
  const value={ok:bikeMin!==null||transitMin!==null,bikeMin,transitMin,bikeKm,transitKm,distanceKm:bikeKm??transitKm,bikeSteps,transitLines,source:"amap",calculatedAt:now};
  if(!value.ok)value.errorCode=/^\d{5}$/.test(String(t?.infocode))&&t.infocode!=="10000"?String(t.infocode):"NO_ROUTE";
  if(cache.size>=500)cache.delete(cache.keys().next().value);
  cache.set(key,{value,until:now+(value.ok?30*60000:60000)});
  return value;
 })().finally(()=>pending.delete(key));
 pending.set(key,job);return job;
}
