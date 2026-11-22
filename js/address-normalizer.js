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
