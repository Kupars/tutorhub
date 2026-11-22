import { inferCoordsFromText } from "./commute.js";

let map = null;
let orderLayer = null;
let originLayer = null;
let pendingOrders = [];
let mapLoading = null;
const GEO_CACHE_KEY = "tutorhub_public_address_geocodes_v1";
let geocodeCache = {};
let geocodeStarted = false;
try { geocodeCache = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || "{}"); } catch { /* private mode */ }

function publicAddress(order) {
  return String(order.publicAddress || order.address || "").trim();
}

function gcj02ToWgs84(lat, lng) {
  // 高德 GCJ-02 → OSM WGS84，避免将地标误置到道路另一侧。
  if (lat < 0.8 || lat > 55.8 || lng < 72 || lng > 137.8) return { lat, lng };
  const x = lng - 105;
  const y = lat - 35;
  let deltaLat = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
  deltaLat += (20*Math.sin(6*x*Math.PI)+20*Math.sin(2*x*Math.PI))*2/3;
  deltaLat += (20*Math.sin(y*Math.PI)+40*Math.sin(y/3*Math.PI))*2/3;
  deltaLat += (160*Math.sin(y/12*Math.PI)+320*Math.sin(y*Math.PI/30))*2/3;
  let deltaLng = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
  deltaLng += (20*Math.sin(6*x*Math.PI)+20*Math.sin(2*x*Math.PI))*2/3;
  deltaLng += (20*Math.sin(x*Math.PI)+40*Math.sin(x/3*Math.PI))*2/3;
  deltaLng += (150*Math.sin(x/12*Math.PI)+300*Math.sin(x/30*Math.PI))*2/3;
  const radLat = lat / 180 * Math.PI;
  const magic = 1 - 0.00669342162296594323 * Math.sin(radLat) ** 2;
  const sqrtMagic = Math.sqrt(magic);
  deltaLat = deltaLat * 180 / ((6335552.717000426 / (magic * sqrtMagic)) * Math.PI);
  deltaLng = deltaLng * 180 / ((6378245 / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return { lat: lat - deltaLat, lng: lng - deltaLng };
}

function loadLeaflet() {
  if (globalThis.L) return Promise.resolve(globalThis.L);
  if (mapLoading) return mapLoading;
  mapLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => globalThis.L ? resolve(globalThis.L) : reject(new Error("地图脚本不可用"));
    script.onerror = () => reject(new Error("地图服务加载失败，请检查网络"));
    document.head.append(script);
  }).catch((error) => { mapLoading = null; throw error; });
  return mapLoading;
}

// 只能从对外展示的公开地址求坐标；没有可解析坐标时显示行政区示意。
export function getPublicMapLocation(order) {
  if (order.mode === "线上") return null;
  const district = order.district || "";
  const address = publicAddress(order);
  const geocoded = geocodeCache[address];
  if (geocoded?.lat && geocoded?.lng) return { lat: geocoded.lat, lng: geocoded.lng, district, geocoded: true };
  const place = inferCoordsFromText(address) || inferCoordsFromText(district);
  return place ? { lat: place.lat, lng: place.lng, district, geocoded: false } : null;
}

export function groupPublicMapOrders(orders) {
  const groups = new Map();
  for (const order of orders) {
    const pos = getPublicMapLocation(order);
    if (!pos) continue;
    const key = `${pos.district}|${pos.lat}|${pos.lng}`;
    if (!groups.has(key)) groups.set(key, { ...pos, orders: [] });
    groups.get(key).orders.push({ id: order.id, orderNumber: order.orderNumber || order.id,
      grade: order.grade, subject: order.subject, address: publicAddress(order) });
  }
  return [...groups.values()];
}

function renderOrderMarkers() {
  if (!map) return;
  orderLayer.clearLayers();
  for (const group of groupPublicMapOrders(pendingOrders)) {
    const n = group.orders.length;
    const marker = globalThis.L.circleMarker([group.lat, group.lng], {
      radius: Math.min(24, 9 + Math.sqrt(n) * 2.3),
      color: "#4338ca", fillColor: "#818cf8", fillOpacity: 0.7, weight: 2
    }).addTo(orderLayer);
    const label = document.createElement("div");
    const header = document.createElement("strong");
    header.textContent = `${group.district} · ${n} 条家教单`;
    const caption = document.createElement("p");
    caption.textContent = group.geocoded ? "📍 按公开地址定位（大致位置）" : "📍 暂按行政区中心示意（不是学生住址）";
    caption.style.cssText = "margin:5px 0;color:#64748b;font-size:12px";
    const list = document.createElement("p");
    list.textContent = group.orders.slice(0, 8).map((o) => `${o.orderNumber} ${o.grade}${o.subject} · ${o.address}`).join("；");
    list.style.cssText = "margin:5px 0 0;font-size:12px";
    label.append(header, caption, list);
    marker.bindPopup(label, { maxWidth: 280 });
    marker.bindTooltip(`${group.district}：${n}单`, { direction: "top" });
  }
}

export function updateMapOrders(orders) {
  pendingOrders = orders || [];
  renderOrderMarkers();
  if (map) void geocodePublicAddresses();
}

async function geocodePublicAddresses() {
  if (geocodeStarted) return;
  geocodeStarted = true;
  // 控制并发；仅在地图被打开时请求公开地址，不发送任何内部后台字段。
  const addresses = [...new Set(pendingOrders.map(publicAddress))]
    .filter((address) => address.length > 5 && !geocodeCache[address] && !/待补充|待协商|线上|网课|某小区/.test(address));
  let nextIndex = 0;
  let missingKey = false;
  const worker = async () => {
    while (nextIndex < addresses.length && !missingKey) {
      const address = addresses[nextIndex++];
      try {
        const res = await fetch("/api/commute", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "geocode", address }) });
        const body = await res.json();
        if (body?.error?.includes("AMAP_KEY")) { missingKey = true; break; }
        if (body?.ok && Number.isFinite(body.lat) && Number.isFinite(body.lng)) {
          geocodeCache[address] = gcj02ToWgs84(body.lat, body.lng);
          renderOrderMarkers();
        } else geocodeCache[address] = { failed: true };
      } catch { geocodeCache[address] = { failed: true }; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geocodeCache)); } catch { /* storage quota */ }
  geocodeStarted = false;
  if (!missingKey && addresses.length) document.dispatchEvent(new Event("tutorhub-geocodes-updated"));
}

export function updateMapOrigin(origin) {
  if (!map || !originLayer) return;
  originLayer.clearLayers();
  if (Number.isFinite(Number(origin?.lat)) && Number.isFinite(Number(origin?.lng)) && origin?.lat != null && origin?.lng != null) {
    globalThis.L.circleMarker([origin.lat, origin.lng], {
      radius: 10, color: "#0369a1", fillColor: "#38bdf8", fillOpacity: 0.9, weight: 3
    }).addTo(originLayer).bindPopup("我的出发点（仅存储于本设备）");
  }
}

export async function openMapBoard(origin) {
  const L = await loadLeaflet();
  if (!map) {
    map = L.map("tutorMap", { zoomControl: true }).setView([39.115, 117.215], 11);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).addTo(map);
    orderLayer = L.layerGroup().addTo(map);
    originLayer = L.layerGroup().addTo(map);
    renderOrderMarkers();
    void geocodePublicAddresses();
  }
  setTimeout(() => map.invalidateSize(), 50);
  updateMapOrigin(origin);
  return map;
}

export function moveMapTo(lat, lng, zoom = 13) {
  map?.setView([lat, lng], zoom);
}

export function getMapCenter() {
  const center = map?.getCenter();
  return center ? { lat: Number(center.lat.toFixed(5)), lng: Number(center.lng.toFixed(5)) } : null;
}
