// Cloudflare Pages Function: /api/commute
// 可选配置高德地图 Web 服务 Key（环境变量 AMAP_KEY），支持地址地理编码与骑行/公交实时耗时

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.AMAP_KEY) {
    return jsonResp({ ok: false, error: "AMAP_KEY 未配置，使用前端估算" });
  }
  try {
    const body = await request.json();

    // 1. 地址转经纬度（供用户填写自定义默认地址时精确定位）
    if (body.action === "geocode" && body.address) {
      const geoUrl = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(body.address)}&key=${env.AMAP_KEY}`;
      const geoRes = await fetch(geoUrl);
      const geoData = await geoRes.json();
      const loc = geoData?.geocodes?.[0]?.location;
      if (!loc) return jsonResp({ ok: false });
      const [lng, lat] = loc.split(",").map(Number);
      return jsonResp({ ok: true, lat, lng });
    }

    // 2. 骑行 + 公交耗时估算
    const { origin, dest, city = "天津" } = body;
    const oStr = `${origin.lng},${origin.lat}`;
    const dStr = `${dest.lng},${dest.lat}`;

    const [bikeRes, transitRes] = await Promise.all([
      fetch(`https://restapi.amap.com/v4/direction/bicycling?origin=${oStr}&destination=${dStr}&key=${env.AMAP_KEY}`),
      fetch(`https://restapi.amap.com/v3/direction/transit/integrated?origin=${oStr}&destination=${dStr}&city=${encodeURIComponent(city)}&key=${env.AMAP_KEY}`)
    ]);

    const bikeData = await bikeRes.json();
    const transitData = await transitRes.json();

    const bikePath = bikeData?.data?.paths?.[0];
    const transitPath = transitData?.route?.transits?.[0];

    return jsonResp({
      ok: true,
      distanceKm: bikePath ? Number((Number(bikePath.distance) / 1000).toFixed(1)) : null,
      bikeMin: bikePath ? Math.max(3, Math.round(Number(bikePath.duration) / 60)) : null,
      transitMin: transitPath ? Math.max(5, Math.round(Number(transitPath.duration) / 60)) : null
    });
  } catch (err) {
    return jsonResp({ ok: false, error: String(err) }, 500);
  }
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
