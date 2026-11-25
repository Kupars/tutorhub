// Official AMap JSAPI security-code proxy. Only known AMap service hosts, no caller-selected host.
export async function handleAmapProxy(request,env){
 const url=new URL(request.url),prefix="/_AMapService/";
 const reply=(code,status)=>new Response(JSON.stringify({ok:false,errorCode:code}),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
 if(request.method!=="GET")return reply("METHOD_NOT_ALLOWED",405);
 if(!env.AMAP_JS_KEY||!env.AMAP_JS_SECURITY_CODE)return reply("AMAP_JS_NOT_CONFIGURED",503);
 const origin=request.headers.get("origin"),referer=request.headers.get("referer");
 const expected=new Set([url.origin,"https://tutor.kupars.top"]);
 let referringOrigin="";
 try{if(referer)referringOrigin=new URL(referer).origin;}catch{}
 // Browser origin checks protect against ordinary cross-site calls, not forged non-browser headers.
 if((origin&&!expected.has(origin))||(referer&&!expected.has(referringOrigin))||(!origin&&!referer))return reply("ORIGIN_NOT_ALLOWED",403);
 const path=url.pathname.slice(prefix.length);
 if(!url.pathname.startsWith(prefix)||!/^v[1-5]\/[A-Za-z0-9_/-]+$/.test(path)||path.includes("//")||path.includes("..")||url.search.length>8192)return reply("INVALID_PATH",400);
 // JS API only; do not expose a Web service key or arbitrary service endpoints.
 if(!/^(?:v[1-5]\/(?:map|log|config|assistant|place|geocode|direction|district|traffic|ip|weather|sdk|jsapi)(?:\/|$))/.test(path))return reply("PATH_NOT_ALLOWED",403);
 if(url.searchParams.has("key")&&url.searchParams.get("key")!==String(env.AMAP_JS_KEY))return reply("KEY_NOT_ALLOWED",403);
 const upstream=new URL("/"+path,path==="v4/map/styles"?"https://webapi.amap.com":"https://restapi.amap.com");
 for(const [name,value] of url.searchParams)if(!["jscode","key"].includes(name.toLowerCase()))upstream.searchParams.append(name,value);
 upstream.searchParams.set("key",String(env.AMAP_JS_KEY));
 upstream.searchParams.set("jscode",String(env.AMAP_JS_SECURITY_CODE));
 try{
   const response=await fetch(upstream,{signal:AbortSignal.timeout(10000),redirect:"error",headers:{Referer:referer||[...expected][0]+"/"}});
   const type=response.headers.get("content-type")||"application/json";
   if(!/^(?:application\/(?:json|javascript|x-javascript|octet-stream)|text\/(?:plain|javascript|json))\b/i.test(type))return reply("UNEXPECTED_UPSTREAM_CONTENT",502);
   const raw=await response.text();
   if(raw.includes(String(env.AMAP_JS_SECURITY_CODE)))return reply("UNEXPECTED_UPSTREAM_CONTENT",502);
   return new Response(raw,{status:response.status,headers:{"Content-Type":type,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
 }catch{return reply("AMAP_PROXY_UNREACHABLE",502);}
}
