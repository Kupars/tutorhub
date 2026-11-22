// 只对家长已经公开的地点进行文字规范化，不猜测小区、门牌或精确坐标。
const TIANJIN_DISTRICTS = ["滨海新区", "和平区", "河东区", "河西区", "南开区", "河北区", "红桥区",
  "东丽区", "西青区", "津南区", "北辰区", "武清区", "宝坻区", "静海区", "宁河区", "蓟州区"];

export function normalizePublicAddress(value, district = "") {
  let address = String(value ?? "").trim()
    .replace(/^(?:【?补课地址】?|【?地址】?)\s*[：:]\s*/, "")
    .replace(/[\s　]+/g, "")
    .replace(/[，,。；;]+$/, "")
    .replace(/^天津天津市/, "天津市")
    .replace(/^天津市天津市/, "天津市")
    .replace(/^天津(?!市)/, "天津市");
  if (!address || /^(?:地址待补充|待补充|待确认)$/.test(address)) return "地址待补充";
  if (/^(?:线上|网课|远程)/.test(address)) return address;

  const knownDistrict = String(district).replace(/^天津市/, "");
  const startsWithDistrict = TIANJIN_DISTRICTS.some((name) => address.startsWith(name));
  if (startsWithDistrict) address = `天津市${address}`;
  else if (address.startsWith("天津市") && TIANJIN_DISTRICTS.includes(knownDistrict)
    && !TIANJIN_DISTRICTS.some((name) => address.slice(3).startsWith(name))) {
    // 例如“天津市西青道跃升里”中的“西青道”并非“西青区”；补回家长已给的行政区。
    address = `天津市${knownDistrict}${address.slice(3)}`;
  }
  else if (!/^(?:天津市|北京市|上海市|重庆市|河北省|山东省|江苏省|浙江省)/.test(address)
    && TIANJIN_DISTRICTS.includes(knownDistrict)) {
    address = `天津市${knownDistrict}${address}`;
  }

  // 两处经核实的公开地标简称。"附近"必须保留，不能改成学生的确切住址。
  if (address.startsWith("天津市河东区")) {
    address = address.replace(/(?:第?45中学?|第四十五中学)/g, "第四十五中学");
  }
  if (address.startsWith("天津市和平区")) {
    address = address.replace(/诚基经贸中心/g, "诚基中心");
  }
  return address;
}

export function compactPublicAddress(value, district = "") {
  return normalizePublicAddress(value, district)
    // 小区已经明确时，地铁线路和步行距离并非地点名称，另由地图计算路线。
    .replace(/（(?:地铁\d+号线|地铁|步行)[^）]*）/g, "")
    .replace(/\((?:地铁\d+号线|地铁|步行)[^)]*\)/g, "");
}

// 地图搜索使用可被地图识别的“区＋小区/道路/地标”，不把上课方式、楼层、地铁说明当作地名。
// 仅取原文公开的第一可选地点；完整的家长描述仍保留在家教单详情中。
export function mapGeocodeQuery(value, district = "") {
  const source = normalizePublicAddress(value, district);
  if (/^(?:地址待补充|线上|网课|远程)/.test(source) && !/线下/.test(source)) return "";
  let query = source.replace(/^(?:线上网课|网课|线上)(?:[；;,，、]?)线下/, "");
  query = query.replace(/[（(][^）)]*[）)]/g, "");
  query = query.split(/[；;，,]|(?:或者|或(?=(?:天津市|北京市|上海市|[\u4e00-\u9fa5]{2,4}区)))/)[0];
  query = query.replace(/(?:附近|周边|旁边|一带|左右|步行约?\d+分钟|步行不到\d+米)$/, "")
    .replace(/(?:具体地点待(?:协商|确认|定)|可以线上|可线上|也可.*)$/, "")
    .trim();
  return query;
}

export function isDistrictOnlyAddress(value, district = "") {
  const query = mapGeocodeQuery(value, district);
  return !query || /^(?:天津市|北京市|上海市|重庆市)?(?:滨海新区|[\u4e00-\u9fa5]{2,4}区)(?:某小区|附近|地址待补充|具体地址待补充|位置待补充)?$/.test(query);
}

export function publicPlaceKeyword(value, district = "") {
  const query = mapGeocodeQuery(value, district);
  if (!query) return "";
  let name = query.replace(/^(?:天津市|北京市|上海市|重庆市)/, "")
    .replace(/^(?:滨海新区|[\u4e00-\u9fa5]{2,4}区)/, "");
  // “大学北门附近学府花园”以小区为准，“宝鸡西道景阳里”以景阳里为准。
  const nearHousing = name.match(/附近(.{2,}(?:小区|花园|家园|公寓|里|苑|园|府|城))$/);
  if (nearHousing) return nearHousing[1];
  const namedHousing = name.match(/(?:镇|街道|路|道|大街)(.{2,}(?:小区|花园|家园|公寓|里|苑|园|府|城|大厦|广场|中心))$/);
  if (namedHousing) name = namedHousing[1];
  return name;
}

// 只自动采纳同城、同行政区且名称足够吻合的高德 POI；公交站与同名小区必须区分。
export function chooseVerifiedPublicPoi(value, district, candidates) {
  const query = mapGeocodeQuery(value, district);
  const keyword = publicPlaceKeyword(value, district);
  if (keyword.length < 2 || !Array.isArray(candidates)) return null;
  const clean = (s) => String(s || "").replace(/[（）()·\s\-]/g, "");
  const expected = String(district || "").replace(/^天津市/, "");
  const expectedCity = query.startsWith("北京市") ? "北京" : query.startsWith("上海市") ? "上海" : "天津";
  let best = null;
  let maxScore = -1;
  for (const item of candidates) {
    if (!Number.isFinite(item?.lat) || !Number.isFinite(item?.lng)) continue;
    if (expected && TIANJIN_DISTRICTS.includes(expected) && item.district && item.district !== expected) continue;
    if (item.province && !String(item.province).includes(expectedCity)) continue;
    const name = clean(item.name);
    const target = clean(keyword);
    const category = String(item.type || "");
    if (/公交|车站|停车|交通设施/.test(category) && !/(?:公交|地铁|车站|站口|站附近)$/.test(target)) continue;
    const exact = name === target;
    const close = target.length >= 3 && (name.includes(target) || target.includes(name));
    if (!exact && !close) continue;
    const score = (exact ? 6 : 3) + (category.includes("住宅") ? 2 : 0) + (item.district === expected ? 1 : 0);
    if (score > maxScore) { best = item; maxScore = score; }
  }
  return best;
}

function landmarkCore(value, district) {
  return normalizePublicAddress(value, district)
    .replace(/^天津市/, "")
    .replace(/(?:滨海新区|和平区|河东区|河西区|南开区|河北区|红桥区|东丽区|西青区|津南区|北辰区|武清区|宝坻区|静海区|宁河区|蓟州区)/, "")
    .replace(/(?:附近|旁边|周边|一带|左右|靠近|周围|地铁口)/g, "")
    .replace(/[()（）\[\]，,。、·\s]/g, "");
}

// 模型只能删冗余和整理顺序；带来新的地名、数字、门牌或把“附近”写成具体住址时拒绝。
export function safeOptimizedPublicAddress(original, suggestion, district = "") {
  const fallback = normalizePublicAddress(original, district);
  if (typeof suggestion !== "string" || !suggestion.trim()) return fallback;
  const candidate = normalizePublicAddress(suggestion, district);
  if (candidate.length > fallback.length + 4) return fallback;
  if (fallback.includes("附近") && !candidate.includes("附近")) return fallback;
  if (fallback.includes("某小区") && !candidate.includes("某小区")) return fallback;
  const expectedDistrict = TIANJIN_DISTRICTS.find((name) => fallback.includes(name));
  const candidateDistrict = TIANJIN_DISTRICTS.find((name) => candidate.includes(name));
  if (expectedDistrict && candidateDistrict !== expectedDistrict) return fallback;
  if (/(?:北京市|上海市|重庆市|河北省)/.test(candidate) && !fallback.includes(candidate.slice(0, 3))) return fallback;
  const digits = candidate.match(/\d+/g) || [];
  if (digits.some((number) => !fallback.includes(number))) return fallback;
  const sourceCore = landmarkCore(fallback, district);
  const nextCore = landmarkCore(candidate, district);
  if (sourceCore.length >= 2 && nextCore.length >= 2 && sourceCore.includes(nextCore)) return candidate;
  return fallback;
}
