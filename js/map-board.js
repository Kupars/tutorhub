import { adoptVerifiedPublicLocations, inferCoordsFromText, inferNamedLandmarkCoords, isPlausiblePublicGeocode, verifiedPublicLandmarkCoords } from "./commute.js?v=5";
import { isDistrictOnlyAddress, mapGeocodeQuery } from "./address-normalizer.js";

let map = null;
let orderLayer = null;
let originLayer = null;
let pendingOrders = [];
let mapLoading = null;
let firstTilesReady = null;
const GEO_CACHE_KEY = "tutorhub_public_address_geocodes_v2";
let geocodeCache = {};
let verifiedIndexLoading = null;
let geocodeStarted = false;
let onToggleOrder = null;
let isOrderSelected = () => false;
let markerSignature = "";
let markerGroups = [];
try { geocodeCache = JSON.parse(localStorage.getItem(GEO_CACHE_KEY) || "{}"); } catch { /* private mode */ }

function loadVerifiedPublicLocations() {
  if (verifiedIndexLoading) return verifiedIndexLoading;
  verifiedIndexLoading = (async () => {
    try {
      const res = await fetch("./data/public-geocodes.json?v=2", { cache: "no-cache", signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const data = await res.json();
      if (data && typeof data === "object" && !Array.isArray(data)) {
        // 静态已核验的公开地点优先于设备上可能过期的旧缓存。
        geocodeCache = { ...geocodeCache, ...data };
        try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geocodeCache)); } catch { /* 隐私模式或存储限制 */ }
        adoptVerifiedPublicLocations(geocodeCache);
        document.dispatchEvent(new Event("tutorhub-geocodes-updated"));
      }
    } catch { /* 静态文件暂不可用时继续实时定位 */ }
  })();
  return verifiedIndexLoading;
}

function publicAddress(order) {
  return String(order.publicAddress || order.address || "").trim();
}

export function gcj02ToWgs84(lat, lng) {
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

// 已核实的镇政府公开 POI，作为无法找到小区位置时的镇级示意锚点。
// 原始坐标来自高德 GCJ-02，地图使用时转为 WGS84；不是学生的精确地址。
const TOWN_CENTER_POIS = [
  { district: "西青区", keyword: "大寺镇", name: "大寺镇", lat: 39.020127, lng: 117.240027 },
  { district: "西青区", keyword: "张家窝镇", name: "张家窝镇", lat: 39.057629, lng: 117.042172 },
  { district: "津南区", keyword: "咸水沽", name: "咸水沽镇", lat: 38.978913, lng: 117.395151 },
  { district: "津南区", keyword: "辛庄镇", name: "辛庄镇", lat: 39.026265, lng: 117.350040 }
];

function approximatePublicCenter(address, district) {
  const normalizedDistrict = String(district || "").replace(/^天津市/, "");
  const town = TOWN_CENTER_POIS.find((entry) =>
    entry.district === normalizedDistrict && address.includes(entry.keyword));
  if (town) return { ...gcj02ToWgs84(town.lat, town.lng), district: normalizedDistrict,
    geocoded: false, fallback: true, fallbackLevel: "town", fallbackLabel: `${town.name}中心示意` };
  const districtCenter = inferCoordsFromText(normalizedDistrict);
  return districtCenter ? { lat: districtCenter.lat, lng: districtCenter.lng,
    district: normalizedDistrict, geocoded: false, fallback: true, fallbackLevel: "district",
    fallbackLabel: `${normalizedDistrict}中心示意` } : null;
}

function loadLeaflet() {
  if (globalThis.L) return Promise.resolve(globalThis.L);
  if (mapLoading) return mapLoading;
  mapLoading = new Promise((resolve, reject) => {
    // 地图 CSS 与脚本一起按需加载，不阻塞家教单首屏的样式和展示。
    if (!document.getElementById("leaflet-map-styles")) {
      const stylesheet = document.createElement("link");
      stylesheet.id = "leaflet-map-styles";
      stylesheet.rel = "stylesheet";
      stylesheet.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.append(stylesheet);
    }
    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = () => globalThis.L ? resolve(globalThis.L) : reject(new Error("地图脚本不可用"));
    script.onerror = () => reject(new Error("地图服务加载失败，请检查网络"));
    document.head.append(script);
  }).catch((error) => { mapLoading = null; throw error; });
  return mapLoading;
}

// 只能从对外展示的公开地址求坐标；未通过核验时显示镇或区中心示意，不冒充真实小区。
export function getPublicMapLocation(order) {
  if (order.mode === "线上") return null;
  const district = order.district || "";
  const address = publicAddress(order);
  const query = mapGeocodeQuery(address, district);
  const landmark = verifiedPublicLandmarkCoords(address);
  if (landmark) return { ...landmark, district, geocoded: true, landmark: true };
  const geocoded = geocodeCache[query];
  if (isPlausiblePublicGeocode({ district, publicAddress: address }, geocoded)) {
    return { lat: geocoded.lat, lng: geocoded.lng, district, geocoded: true };
  }
  const namedPlace = inferNamedLandmarkCoords(address, district);
  if (namedPlace) return { lat: namedPlace.lat, lng: namedPlace.lng, district, geocoded: false, landmark: true };
  return approximatePublicCenter(address, district);
}

export function groupPublicMapOrders(orders) {
  const groups = new Map();
  for (const order of orders) {
    const pos = getPublicMapLocation(order);
    if (!pos) continue;
    const key = `${pos.district}|${pos.lat}|${pos.lng}`;
    if (!groups.has(key)) groups.set(key, { ...pos, orders: [] });
    groups.get(key).orders.push({ id: order.id, orderNumber: order.orderNumber || order.id,
      fallback: !!pos.fallback,
      grade: order.grade, subject: order.subject, studentGender: order.studentGender,
      teacherCount: order.teacherCount, address: publicAddress(order),
      weeklyFrequency: order.weeklyFrequency, hoursPerSession: order.hoursPerSession,
      salaryText: order.salaryText, currentScores: order.currentScores,
      requirements: order.requirements, trialTime: order.trialTime });
  }
  return [...groups.values()];
}

// 使用当前缩放级别下的屏幕像素距离合并标记：点开合并标记仍能查看全部原始公开家教单。
// 放大时像素间距增大，便会自动拆分；绝不修改实际家教单地址或后台坐标。
export function clusterNearbyMapGroups(groups, project, radiusPx = 54) {
  if (groups.length < 2) return groups;
  const points = groups.map((group) => project(group.lat, group.lng));
  const limit = radiusPx * radiusPx;
  // 以大标记作为聚合中心，其他点只与“中心”比较，避免 A 靠 B、B 靠 C
  // 造成整片城区被链式聚合成一个超大标记。
  const priority = groups.map((_, index) => index)
    .sort((a, b) => groups[b].orders.length - groups[a].orders.length || a - b);
  const buckets = [];
  for (const index of priority) {
    let target = null;
    let closestDistance = limit + 1;
    for (const bucket of buckets) {
      const anchor = points[bucket.anchor];
      const dx = points[index].x - anchor.x;
      const dy = points[index].y - anchor.y;
      const distance = dx * dx + dy * dy;
      if (distance <= limit && distance < closestDistance) {
        closestDistance = distance;
        target = bucket;
      }
    }
    if (target) target.indices.push(index);
    else buckets.push({ anchor: index, indices: [index] });
  }
  buckets.sort((a, b) => Math.min(...a.indices) - Math.min(...b.indices));
  return buckets.map((bucket) => {
    const members = bucket.indices.sort((a, b) => a - b).map((index) => groups[index]);
    if (members.length === 1) return members[0];
    const anchor = groups[bucket.anchor];
    return {
      lat: anchor.lat,
      lng: anchor.lng,
      district: members.every((member) => member.district === members[0].district)
        ? members[0].district : "多个区域",
      geocoded: members.every((member) => member.geocoded),
      landmark: members.every((member) => member.landmark),
      fallback: members.some((member) => member.fallback),
      fallbackLabel: members.find((member) => member.fallback)?.fallbackLabel,
      locationsCount: members.length,
      orders: members.flatMap((member) => member.orders)
    };
  });
}

export function setMapOrderSelectionHandlers(toggle, selected) {
  onToggleOrder = toggle;
  isOrderSelected = selected;
}

function popupDetail(label, value) {
  if (value == null || value === "") return null;
  const row = document.createElement("div");
  row.className = "map-order-detail";
  const bold = document.createElement("strong");
  bold.textContent = `${label}：`;
  row.append(bold, document.createTextNode(String(value)));
  return row;
}

function syncPopupSelections() {
  document.querySelectorAll(".map-order-toggle[data-map-order-id]").forEach((button) => {
    const selected = isOrderSelected(button.dataset.mapOrderId);
    button.classList.toggle("is-added", selected);
    button.textContent = selected ? "✓ 已添加" : "+ 添加";
    button.setAttribute("aria-pressed", String(selected));
  });
}

export function markerStyleForGroup(group, selected = () => false) {
  const hasSelected = group.orders.some((order) => selected(order.id));
  return { color: hasSelected ? "#15803d" : group.fallback ? "#b45309" : "#4338ca",
    fillColor: hasSelected ? "#4ade80" : group.fallback ? "#fbbf24" : "#818cf8",
    fillOpacity: hasSelected ? 0.87 : 0.7 };
}

function syncMarkerColors() {
  for (const { marker, group } of markerGroups) {
    marker.setStyle(markerStyleForGroup(group, isOrderSelected));
  }
}

export function popupTitleForGroup(group) {
  return `这个标记对应 ${group.orders.length} 条家教单`;
}

function buildMapPopup(group) {
  const panel = document.createElement("div");
  panel.className = "map-popup-compact";
  const heading = document.createElement("strong");
  heading.className = "map-popup-count";
  heading.textContent = popupTitleForGroup(group);
  const caption = document.createElement("p");
  caption.className = "map-popup-caption";
  caption.textContent = group.locationsCount > 1
    ? `${group.locationsCount} 个公开位置靠得很近，已合并标记；放大地图可分别查看。${group.fallback ? "其中含区/镇中心示意点，非实际住址。" : ""}` :
    group.fallback ? `${group.fallbackLabel || "区域中心示意"}，非学生实际住址；路程时间暂不作精确估算。` :
    group.landmark ? "按公开地标定位（非学生精确住址）" :
    group.geocoded ? "按公开地址定位（大致位置）" : "区域示意点（不是学生具体住址）";
  const list = document.createElement("div");
  list.className = "map-popup-orders";
  for (const order of group.orders) {
    const card = document.createElement("article");
    card.className = "map-compact-order";
    const summary = document.createElement("button");
    summary.type = "button";
    summary.className = "map-order-expand";
    summary.setAttribute("aria-expanded", "false");
    const top = document.createElement("div");
    top.className = "map-order-top";
    const name = document.createElement("strong");
    name.className = "map-order-title";
    name.textContent = `${order.orderNumber} · ${order.grade || ""}${order.subject || ""}`;
    const rate = document.createElement("span");
    rate.className = "map-order-salary";
    rate.textContent = (order.salaryText || "老师报价").replace("（可报价）", "");
    top.append(name, rate);
    const address = document.createElement("span");
    address.className = "map-order-brief";
    address.textContent = `📍 ${order.address || "公开地址待补充"}`;
    const bottom = document.createElement("span");
    bottom.className = "map-order-brief map-order-schedule";
    bottom.textContent = `🕒 ${order.weeklyFrequency || "时间待协商"}`;
    const hint = document.createElement("span");
    hint.className = "map-order-expand-hint";
    hint.textContent = "展开详情 ▼";
    summary.append(top, address, bottom, hint);
    const details = document.createElement("div");
    details.className = "map-order-expanded-card";
    details.hidden = true;
    for (const [name, value] of [["学生", [order.grade, order.studentGender].filter(Boolean).join("、")],
      ["补习科目", order.subject], ["需要老师", Number(order.teacherCount) > 1 ? `${order.teacherCount}位` : ""],
      ["公开地点", order.address], ["上课时间", order.weeklyFrequency],
      ["每次时长", order.hoursPerSession ? `${order.hoursPerSession}小时` : ""],
      ["当前成绩", order.currentScores], ["老师要求", order.requirements], ["试课", order.trialTime]]) {
      const detail = popupDetail(name, value);
      if (detail) details.append(detail);
    }
    summary.onclick = () => {
      details.hidden = !details.hidden;
      const opened = !details.hidden;
      summary.setAttribute("aria-expanded", String(opened));
      hint.textContent = opened ? "收起详情 ▲" : "展开详情 ▼";
      card.classList.toggle("expanded", opened);
    };
    const add = document.createElement("button");
    add.type = "button";
    add.className = "map-order-toggle";
    add.dataset.mapOrderId = order.id;
    const selected = isOrderSelected(order.id);
    add.textContent = selected ? "✓ 已添加" : "+ 添加";
    add.classList.toggle("is-added", selected);
    add.setAttribute("aria-pressed", String(selected));
    add.onclick = () => {
      onToggleOrder?.(order.id);
      syncPopupSelections();
    };
    card.append(summary, add, details);
    list.append(card);
  }
  panel.append(heading, caption, list);
  return panel;
}

function renderOrderMarkers() {
  if (!map) return;
  const groups = clusterNearbyMapGroups(groupPublicMapOrders(pendingOrders),
    (lat, lng) => map.project([lat, lng], map.getZoom()));
  const nextSignature = `${map.getZoom()}|` + groups.map((g) =>
    `${g.district}/${g.lat}/${g.lng}/${g.orders.map((o) => o.id).join(",")}`).join("|");
  if (nextSignature === markerSignature) { syncPopupSelections(); syncMarkerColors(); return; }
  markerSignature = nextSignature;
  orderLayer.clearLayers();
  markerGroups = [];
  for (const group of groups) {
    const n = group.orders.length;
    const marker = globalThis.L.circleMarker([group.lat, group.lng], {
      radius: Math.min(24, 9 + Math.sqrt(n) * 2.3),
      color: "#4338ca", fillColor: "#818cf8", fillOpacity: 0.7, weight: 2, bubblingMouseEvents: false
    }).addTo(orderLayer);
    markerGroups.push({ marker, group });
    marker.bindTooltip(group.fallback ? `${n} 条家教单 · 含区/镇示意位置，点击查看` :
      n > 1 ? `${n} 条家教单 · 点击查看详情` : "点击查看详情",
      { sticky: true, direction: "top", className: "tutor-map-hint", offset: [0, -8] });
    marker.bindPopup(buildMapPopup(group), { className: "tutor-map-popup", minWidth: 290, maxWidth: 360,
      autoPan: true, autoPanPadding: [24, 24] });
    marker.on("popupopen", syncPopupSelections);
  }
  syncMarkerColors();
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
  const addresses = [...new Set(pendingOrders.map((order) => mapGeocodeQuery(publicAddress(order), order.district)))]
    .filter((address) => address.length > 5 && !verifiedPublicLandmarkCoords(address) &&
      !isDistrictOnlyAddress(address) &&
      (!geocodeCache[address] || (geocodeCache[address].failedAt && Date.now() - geocodeCache[address].failedAt > 86400000)) &&
      !/待补充|待协商|线上|网课|某小区/.test(address));
  let nextIndex = 0;
  let missingKey = false;
  const worker = async () => {
    while (nextIndex < addresses.length && !missingKey) {
      const address = addresses[nextIndex++];
      try {
        const res = await fetch("/api/commute", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "geocode", address }),
          signal: AbortSignal.timeout(7000) });
        const body = await res.json();
        if (body?.error?.includes("AMAP_KEY")) {
          missingKey = true;
          const info = document.getElementById("mapLocationNote");
          if (info) info.textContent = "当前未配置高德地理编码 Key，地图根据公开地标或区域示意定位；配置 Cloudflare AMAP_KEY 后可按公开地址更精确定位。";
          break;
        }
        if (body?.ok && Number.isFinite(body.lat) && Number.isFinite(body.lng)) {
          const corrected = { ...gcj02ToWgs84(body.lat, body.lng), district: body.district,
            province: body.province, level: body.level, formattedAddress: body.formattedAddress };
          const order = pendingOrders.find((item) => mapGeocodeQuery(publicAddress(item), item.district) === address);
          if (isPlausiblePublicGeocode({ district: order?.district, publicAddress: address }, corrected)) {
            geocodeCache[address] = corrected;
            renderOrderMarkers();
          } else geocodeCache[address] = { failedAt: Date.now() };
        } else geocodeCache[address] = { failedAt: Date.now() };
      } catch { geocodeCache[address] = { failedAt: Date.now() }; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  try { localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geocodeCache)); } catch { /* storage quota */ }
  adoptVerifiedPublicLocations(geocodeCache);
  geocodeStarted = false;
  if (!missingKey && addresses.length) document.dispatchEvent(new Event("tutorhub-geocodes-updated"));
}

export function updateMapOrigin(origin) {
  if (!map || !originLayer) return;
  originLayer.clearLayers();
  if (Number.isFinite(Number(origin?.lat)) && Number.isFinite(Number(origin?.lng)) && origin?.lat != null && origin?.lng != null) {
    const pin = globalThis.L.divIcon({ className: "user-location-icon",
      html: '<span class="user-location-pin"><span></span></span>', iconSize: [32, 42], iconAnchor: [16, 39] });
    globalThis.L.marker([origin.lat, origin.lng], { icon: pin, zIndexOffset: 1100 })
      .addTo(originLayer).bindPopup("📍 我的位置（仅存储于本设备）");
  }
}

export async function openMapBoard(origin) {
  const [L] = await Promise.all([loadLeaflet(), loadVerifiedPublicLocations()]);
  if (!map) {
    const hasOrigin = origin?.lat != null && origin?.lng != null && Number.isFinite(Number(origin.lat)) && Number.isFinite(Number(origin.lng));
    // 手机初次进入要一眼看见若干家教标记，不要因为默认过度放大而像空地图。
    const initialZoom = globalThis.matchMedia?.("(max-width: 640px)").matches ? 10 : 11;
    map = L.map("tutorMap", { zoomControl: true }).setView(hasOrigin ? [origin.lat, origin.lng] : [39.115, 117.215], initialZoom);
    const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    });
    // 地图区域单独等待首批底图瓦片；不会遮挡已经可用的家教列表。
    firstTilesReady = new Promise((resolve) => {
      let settled = false;
      const done = (loaded) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(loaded);
      };
      const timer = setTimeout(() => done(false), 7000);
      tiles.once("load", () => done(true));
    });
    tiles.addTo(map);
    orderLayer = L.layerGroup().addTo(map);
    originLayer = L.layerGroup().addTo(map);
    map.on("zoomend", renderOrderMarkers);
    renderOrderMarkers();
    void geocodePublicAddresses();
  }
  setTimeout(() => map.invalidateSize(), 50);
  updateMapOrigin(origin);
  if (firstTilesReady) await firstTilesReady;
  return map;
}

export function moveMapTo(lat, lng, zoom = 13) {
  map?.setView([lat, lng], zoom);
}

export function refreshMapSize() {
  map?.invalidateSize({ pan: false });
}

export function getMapCenter() {
  const center = map?.getCenter();
  return center ? { lat: Number(center.lat.toFixed(5)), lng: Number(center.lng.toFixed(5)) } : null;
}
