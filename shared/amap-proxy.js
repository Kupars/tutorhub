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
 const callbacks=url.searchParams.getAll("callback");
 const callback=callbacks[0]||"";
 if(callbacks.length>1||(callbacks.length&&(!/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(callback)||["eval","Function","constructor","__proto__","prototype"].includes(callback))))return reply("INVALID_CALLBACK",400);
 const upstream=new URL("/"+path,path==="v4/map/styles"?"https://webapi.amap.com":"https://restapi.amap.com");
 for(const [name,value] of url.searchParams)if(!["jscode","key"].includes(name.toLowerCase()))upstream.searchParams.append(name,value);
 upstream.searchParams.set("key",String(env.AMAP_JS_KEY));
 upstream.searchParams.set("jscode",String(env.AMAP_JS_SECURITY_CODE));
 try{
   const response=await fetch(upstream,{signal:AbortSignal.timeout(10000),redirect:"error",headers:{Referer:referer||[...expected][0]+"/"}});
   const type=response.headers.get("content-type")||"application/json";
   const raw=await response.text();
   if(raw.length>2_000_000||raw.includes(String(env.AMAP_JS_SECURITY_CODE)))return reply("UNEXPECTED_UPSTREAM_CONTENT",502);
   if(callback){
     // JSONP is a script request. Parse the payload as JSON and reconstruct only the validated callback,
     // never serve arbitrary upstream HTML, JavaScript, or an executable error object.
     let payload;
     try{
       const body=raw.trim().replace(/^\/\*\*\/\s*/,"");
       if(body.startsWith(callback+"(")&&/\)\s*;?$/.test(body)){
         payload=JSON.parse(body.slice(callback.length+1).replace(/\)\s*;?$/,""));
       }else payload=JSON.parse(body);
     }catch{return reply("INVALID_JSONP_RESPONSE",502);}
     if(JSON.stringify(payload).includes(String(env.AMAP_JS_SECURITY_CODE)))return reply("UNEXPECTED_UPSTREAM_CONTENT",502);
     return new Response(callback+"("+JSON.stringify(payload).replace(/</g,"\\u003c")+");",{status:response.status,headers:{"Content-Type":"application/javascript; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
   }
   if(!/^(?:application\/(?:json|javascript|x-javascript|octet-stream)|text\/(?:plain|javascript|json))\b/i.test(type))return reply("UNEXPECTED_UPSTREAM_CONTENT",502);
   // Non-JSONP endpoints return data, not scripts. Reject active or malformed content.
   let payload;try{payload=JSON.parse(raw);}catch{return reply("INVALID_JSON_RESPONSE",502);}
   if(JSON.stringify(payload).includes(String(env.AMAP_JS_SECURITY_CODE)))return reply("UNEXPECTED_UPSTREAM_CONTENT",502);
   return new Response(JSON.stringify(payload),{status:response.status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
 }catch{return reply("AMAP_PROXY_UNREACHABLE",502);}
}
