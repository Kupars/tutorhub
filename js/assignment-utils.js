// 仅供管理员查看的历史派单推荐和逾期提示。没有老师自助录入，也不猜测家庭地址。
// 所有推荐是历史接单地点相似度，不代表教师当前位置、可用时间或接单意愿。
const clean = (v) => String(v ?? "").trim();
export function ageOfOpenOrder(order, now = Date.now(), thresholdDays = 10) {
  const status = clean(order?.status);
  if (/已匹配|已关闭|已结束|已完成|已招满|已下架|取消|停止招募|暂停招募/.test(status)) return null;
  // 飞书批量导入时间不是实际发单时间；不能据此发出虚假“超时”警告。
  const dateText = clean(order?.publishedAt) || (order?.source === "feishu-public-orders" ? "" : clean(order?.createdAt));
  if (!dateText) return { kind: "unknown", days: null, message: "历史单发布时间待核实" };
  const time = Date.parse(dateText);
  if (!Number.isFinite(time) || time > now + 60000) return { kind: "unknown", days: null, message: "发布时间待核实" };
  const days = Math.max(0, Math.floor((now - time) / 86400000));
  return { kind: days >= thresholdDays ? "overdue" : "recent", days, message: days >= thresholdDays ? `已招募${days}天，建议跟进` : `已招募${days}天` };
}

const locationKey = (address) => clean(address).replace(/天津市|北京市|天津|北京|[\s，,。()（）]/g, "").toLowerCase();
export function recommendPastTeachers(target, assignments = [], orders = [], limit = 5) {
  const byId = new Map(orders.map((o) => [String(o.id), o]));
  const grouped = new Map();
  for (const entry of assignments) {
    const name = clean(entry.teacherName);
    if (!name || String(entry.orderId) === String(target.id)) continue;
    const oldOrder = byId.get(String(entry.orderId)) || {};
    const district = clean(entry.district || oldOrder.district);
    const address = clean(entry.publicAddress || oldOrder.publicAddress || oldOrder.address);
    const subject = clean(entry.subject || oldOrder.subject);
    const currentDistrict = clean(target.district);
    const currentAddress = locationKey(target.publicAddress || target.address);
    const previousAddress = locationKey(address);
    let score = 0;
    const reasons = [];
    if (district && district === currentDistrict && district !== "区域待补充") {
      score += 5; reasons.push(`曾在${district}接单`);
    }
    if (currentAddress.length >= 5 && previousAddress.length >= 5 && currentAddress === previousAddress) {
      score += 8; reasons.push("曾在同一公开地点接单");
    }
    if (subject && clean(target.subject) && (subject === clean(target.subject) || subject.split("、").some((part) => clean(target.subject).includes(part)))) {
      score += 3; reasons.push("有相同科目接单记录");
    }
    if (!score) continue;
    const contact = clean(entry.teacherContact);
    const key = `${name}| ${contact}`;
    const previous = grouped.get(key);
    const record = { teacherName: name, teacherContact: contact, score, reasons, totalOrders: 1,
      latestAssignedAt: clean(entry.assignedAt), sampleDistrict: district };
    if (!previous) grouped.set(key, record);
    else {
      previous.totalOrders += 1;
      if (record.score > previous.score) { previous.score = record.score; previous.reasons = record.reasons; }
      if (record.latestAssignedAt > previous.latestAssignedAt) previous.latestAssignedAt = record.latestAssignedAt;
    }
  }
  return [...grouped.values()].sort((a, b) => b.score - a.score || b.totalOrders - a.totalOrders ||
    b.latestAssignedAt.localeCompare(a.latestAssignedAt)).slice(0, limit)
    .map(({ teacherName, teacherContact, reasons, totalOrders, sampleDistrict }) => ({
      teacherName, teacherContact, reason: reasons.join("、") || `曾在${sampleDistrict}接单`,
      totalOrders, warning: "仅供管理员联系核实，不能推断老师目前所在位置或是否有空"
    }));
}
