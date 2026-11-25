import {planCommute} from "../../shared/route-service.js";
// /api/commute (Cloudflare Pages or VPS)
// Server-side AMap Web Service key. Never return the key or upstream request URLs.

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const body = await request.json();
    if(body.action==="map_config"){
      // JS key is intentionally public; the Web service key and security code are never returned.
      const key=String(env.AMAP_JS_KEY||"").trim();
      return new Response(JSON.stringify({ok:Boolean(key&&env.AMAP_JS_SECURITY_CODE),jsKey:key&&env.AMAP_JS_SECURITY_CODE?key:"",serviceHost:"/_AMapService"}),{headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});
    }
    if(!env.AMAP_KEY)return jsonResp({ok:false,error:"AMAP_KEY 未配置，通勤查询暂不可用",errorCode:"AMAP_KEY_NOT_CONFIGURED"});

    // 输入提示：仅向前端返回公开地点的名称、行政区、地址及坐标，不泄露服务 Key。
    if (body.action === "suggest") {
      const keywords = String(body.keywords || "").trim().slice(0, 80);
      if (!keywords) return jsonResp({ ok: true, suggestions: [] });
      const suggestUrl = new URL("https://restapi.amap.com/v3/assistant/inputtips");
      suggestUrl.searchParams.set("keywords", keywords);
      suggestUrl.searchParams.set("city", "天津");
      suggestUrl.searchParams.set("datatype", "poi");
      suggestUrl.searchParams.set("key", env.AMAP_KEY);
      const response = await fetch(suggestUrl.toString(), { signal: AbortSignal.timeout(6500) });
      const data = await readAmap(response);
      if(data.status!=="1")return amapFailure(data,{suggestions:[]});
      const suggestions = (Array.isArray(data.tips) ? data.tips : []).slice(0, 10).flatMap((tip) => {
        if (typeof tip.location !== "string") return [];
        const [lng, lat] = tip.location.split(",").map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !tip.name) return [];
        return [{ name: String(tip.name), address: typeof tip.address === "string" ? tip.address : "",
          district: typeof tip.district === "string" ? tip.district : "", lat, lng, gcj02: true }];
      });
      return jsonResp({ ok: data.status === "1", suggestions });
    }

    // 已知小区/学校/地标优先查 POI 名称，避免地理编码把“小区”降级命中同名公交站或整区中心。
    if (body.action === "poi_lookup") {
      const keywords = String(body.keywords || "").trim().slice(0, 70);
      if (!keywords) return jsonResp({ ok: true, candidates: [] });
      const city = String(body.city || "天津").slice(0, 16);
      const searchUrl = new URL("https://restapi.amap.com/v3/place/text");
      searchUrl.searchParams.set("keywords", keywords);
      searchUrl.searchParams.set("city", city);
      searchUrl.searchParams.set("citylimit", "true");
      searchUrl.searchParams.set("offset", "10");
      searchUrl.searchParams.set("key", env.AMAP_KEY);
      const result = await fetch(searchUrl.toString(), { signal: AbortSignal.timeout(20000) });
      const data = await readAmap(result);
      if(data.status!=="1")return amapFailure(data,{candidates:[]});
      const candidates = (Array.isArray(data.pois) ? data.pois : []).flatMap((poi) => {
        if (typeof poi.location !== "string") return [];
        const [lng, lat] = poi.location.split(",").map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
        return [{ name: String(poi.name || ""), district: String(poi.adname || ""),
          province: String(poi.pname || ""), address: typeof poi.address === "string" ? poi.address : "",
          type: String(poi.type || ""), lat, lng }];
      });
      return jsonResp({ ok: data.status === "1", candidates });
    }

    // 1. 地址转经纬度（供用户填写自定义默认地址时精确定位）
    if (body.action === "geocode" && body.address) {
      const address = String(body.address).trim().slice(0, 120);
      const city = address.includes("北京市") ? "北京" : address.includes("上海市") ? "上海"
        : address.includes("天津市") ? "天津" : "";
      const geoUrl = new URL("https://restapi.amap.com/v3/geocode/geo");
      geoUrl.searchParams.set("address", address);
      if (city) geoUrl.searchParams.set("city", city);
      geoUrl.searchParams.set("key", env.AMAP_KEY);
      const geoRes = await fetch(geoUrl.toString(), { signal: AbortSignal.timeout(9000) });
      const geoData = await readAmap(geoRes);
      if(geoData.status!=="1")return amapFailure(geoData);
      const place = geoData?.geocodes?.[0];
      const loc = place?.location;
      if (geoData?.status !== "1" || typeof loc !== "string") return jsonResp({ ok: false, error: geoData?.info || "未找到匹配地址" });
      const [lng, lat] = loc.split(",").map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return jsonResp({ ok: false, error: "地址坐标异常" });
      return jsonResp({ ok: true, lat, lng,
        district: typeof place.district === "string" ? place.district : "",
        province: typeof place.province === "string" ? place.province : "",
        level: typeof place.level === "string" ? place.level : "",
        formattedAddress: typeof place.formatted_address === "string" ? place.formatted_address : "" });
    }

    // Route requests use GCJ-02. The caller explicitly supplies approximate coordinates.
    if(body.action!=="route" && body.action!==undefined)return jsonResp({ok:false,errorCode:"UNKNOWN_ACTION"},400);
    const result=await planCommute(body,env);
    return jsonResp(result);
  } catch (err) {
    const code=["AMAP_UPSTREAM_HTTP","AMAP_INVALID_RESPONSE"].includes(err?.message)?err.message:"AMAP_UPSTREAM_UNREACHABLE";
    return jsonResp({ok:false,error:"高德服务连接或响应异常",errorCode:code},502);
  }
}

async function readAmap(response){
 if(!response.ok)throw new Error("AMAP_UPSTREAM_HTTP");
 try{return await response.json();}catch{throw new Error("AMAP_INVALID_RESPONSE");}
}
function amapFailure(data,extra={}){
 const code=String(data?.infocode??data?.errcode??"AMAP_INVALID_RESPONSE");
 const safeCode=/^\d{5}$/.test(code)?code:"AMAP_INVALID_RESPONSE";
 return jsonResp({ok:false,...extra,error:"高德服务返回错误（"+safeCode+"）",errorCode:safeCode});
}
function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
