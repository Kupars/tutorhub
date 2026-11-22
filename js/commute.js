import { APP_CONFIG } from "./app-env.js";

// 常见地标与区域坐标库（支持用户直接输入自定义地址进行本地快速定位）
const PLACE_COORDS = {
  "卫津路": { lat: 39.1095, lng: 117.1731, district: "南开区" },
  "天津大学": { lat: 39.1095, lng: 117.1731, district: "南开区" },
  "天大": { lat: 39.1095, lng: 117.1731, district: "南开区" },
  "北洋园": { lat: 38.9998, lng: 117.3137, district: "津南区" },
  "海河教育园": { lat: 39.0122, lng: 117.3265, district: "津南区" },
  "南开大学": { lat: 39.1032, lng: 117.1695, district: "南开区" },
  "八里台": { lat: 39.1032, lng: 117.1695, district: "南开区" },
  "时代奥城": { lat: 39.0762, lng: 117.1785, district: "南开区" },
  "五大道": { lat: 39.1128, lng: 117.2044, district: "和平区" },
  "梅江": { lat: 39.0485, lng: 117.2116, district: "河西区" },
  "天津站": { lat: 39.1353, lng: 117.2102, district: "河北区" },
  "南开区": { lat: 39.1066, lng: 117.1507, district: "南开区" },
  "和平区": { lat: 39.1171, lng: 117.2146, district: "和平区" },
  "河西区": { lat: 39.1095, lng: 117.2233, district: "河西区" },
  "河东区": { lat: 39.1283, lng: 117.2516, district: "河东区" },
  "河北区": { lat: 39.1480, lng: 117.1969, district: "河北区" },
  "红桥区": { lat: 39.1673, lng: 117.1515, district: "红桥区" },
  "津南区": { lat: 38.9914, lng: 117.3573, district: "津南区" },
  "西青区": { lat: 39.1411, lng: 117.0078, district: "西青区" },
  "东丽区": { lat: 39.0865, lng: 117.3143, district: "东丽区" },
  "北辰区": { lat: 39.2248, lng: 117.1355, district: "北辰区" },
  "滨海新区": { lat: 39.0033, lng: 117.7105, district: "滨海新区" },
  "中关村": { lat: 39.9834, lng: 116.3184, district: "海淀区" },
  "海淀区": { lat: 39.9599, lng: 116.2981, district: "海淀区" },
  "朝阳区": { lat: 39.9215, lng: 116.4431, district: "朝阳区" },
  "徐家汇": { lat: 31.1951, lng: 121.4381, district: "徐汇区" },
  "徐汇区": { lat: 31.1883, lng: 121.4368, district: "徐汇区" }
};

// 已公开且经过地图核对的地标锚点（WGS84，非学生家庭经纬度）。
// 诚基中心：amap.com/place/B0FFFSO92Y；天津市第四十五中学：ditu.amap.com/place/B001605214。
const PUBLIC_LANDMARK_ANCHORS = {
  "天津市和平区诚基中心": { lat: 39.115649, lng: 117.195483 },
  "天津市河东区第四十五中学附近": { lat: 39.102760, lng: 117.264776 }
};

export function verifiedPublicLandmarkCoords(address) {
  const anchor = PUBLIC_LANDMARK_ANCHORS[String(address || "").trim()];
  return anchor ? { ...anchor } : null;
}

export function inferCoordsFromText(text) {
  if (!text) return null;
  for (const [key, coords] of Object.entries(PLACE_COORDS)) {
    if (text.includes(key) || (key.endsWith("区") && text.includes(key.slice(0, -1)))) {
      return { ...coords };
    }
  }
  return null;
}

// 解析用户填写的自定义默认地址（优先精确匹配预设/地标，其次尝试地图边缘接口，最后兜底）
export async function resolveUserAddress(addressText) {
  const clean = (addressText || "").trim();
  if (!clean) return APP_CONFIG.presetLocations[0];

  const preset = APP_CONFIG.presetLocations.find((p) => p.name === clean);
  if (preset) return { ...preset };

  // 尝试调用高德地图边缘地理编码（配置了 AMAP_KEY 时返回精确经纬度）
  try {
    const res = await fetch(`${APP_CONFIG.apiBase}/commute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "geocode", address: clean }),
      signal: AbortSignal.timeout(6000)
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.ok && data.lat != null && data.lng != null) {
        return { name: clean, lat: data.lat, lng: data.lng, exact: true, gcj02: true };
      }
    }
  } catch {
    // 忽略网络异常，回退本地匹配
  }

  const inferred = inferCoordsFromText(clean);
  if (inferred) {
    return { name: clean, lat: inferred.lat, lng: inferred.lng };
  }

  // 未命中的地点不能冒充“天津大学”来估算，否则排序和时长会误导用户。
  throw new Error("暂时无法定位该地点，请从地图搜索候选中选择，或输入天津大学、河西区等地标");
}

// Haversine 球面距离（公里）
export function calcDistanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 高德对简称或“附近”有时会返回异地同名点，不能把这个结果当作准确定位。
export function isPlausiblePublicGeocode(order, point) {
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lng)) return false;
  const district = String(order.district || "").replace(/^天津市/, "");
  const source = String(order.publicAddress || order.address || "");
  if ((source.includes("天津") || district.endsWith("区")) && point.province && !String(point.province).includes("天津")) {
    // 北京等非天津订单保留其原有位置，避免错杀其他城市。
    if (/^(?:天津市|天津)/.test(source) || /^(?:和平区|河东区|河西区|南开区|河北区|红桥区|津南区|西青区|东丽区|北辰区|武清区|滨海新区)/.test(district)) return false;
  }
  if (point.district && district && point.district !== district && !String(point.district).includes(district)) return false;
  const center = inferCoordsFromText(district);
  if (!center) return true;
  const maxKm = /^(?:和平区|河东区|河西区|南开区|河北区|红桥区)$/.test(district) ? 16
    : /^(?:津南区|西青区|东丽区|北辰区)$/.test(district) ? 42 : 95;
  return calcDistanceKm(center.lat, center.lng, point.lat, point.lng) <= maxKm;
}

let publicGeoCache = {};
let lastGeoLoad = 0;
function publicGeocodedPoint(order) {
  try {
    if (Date.now() - lastGeoLoad > 2500) {
      publicGeoCache = JSON.parse(localStorage.getItem("tutorhub_public_address_geocodes_v1") || "{}");
      lastGeoLoad = Date.now();
    }
  } catch { return null; }
  const location = publicGeoCache[String(order.publicAddress || order.address || "").trim()];
  return isPlausiblePublicGeocode(order, location) ? location : null;
}

// 计算骑行与公交双耗时（同时返回骑行、公交与距离）
export function estimateCommuteLocal(origin, order) {
  if (order.mode === "线上") {
    return {
      isOnline: true,
      distanceKm: 0,
      bikeMin: 0,
      transitMin: 0,
      bestMin: 0,
      label: "线上免通勤"
    };
  }
  if (!origin || origin.lat == null || origin.lng == null) {
    return null;
  }
  // 公共看板仅用行政区示意坐标估算；不读取后台私有精确坐标。
  const inferred = verifiedPublicLandmarkCoords(order.publicAddress || order.address) || publicGeocodedPoint(order) ||
    inferCoordsFromText(String(order.publicAddress || order.address || "")) || inferCoordsFromText(order.district || "");
  if (!inferred) return null;
  const targetLat = inferred.lat;
  const targetLng = inferred.lng;

  const straightKm = calcDistanceKm(origin.lat, origin.lng, targetLat, targetLng);
  const roadKm = Math.max(0.5, Number((straightKm * 1.28).toFixed(1)));
  const bikeMin = Math.max(5, Math.round((roadKm / 13) * 60));
  const transitMin = Math.max(10, Math.round((roadKm / 20) * 60 + 8));

  return {
    isOnline: false,
    distanceKm: roadKm,
    bikeMin,
    transitMin,
    bestMin: Math.min(bikeMin, transitMin),
    label: `骑行 ${bikeMin} 分钟 · 公交 ${transitMin} 分钟 · ${roadKm}km`
  };
}
