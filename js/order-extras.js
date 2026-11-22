// 纯展示/校验工具：历史飞书导入的时间是批量导入时间，不当作真实发布时间。
export function orderFreshness(order, now = Date.now()) {
  if (order?.updatedAt) {
    const updated = Date.parse(order.updatedAt);
    if (Number.isFinite(updated) && updated <= now + 60000) {
      const days = Math.floor((now - updated) / 86400000);
      if (days === 0) return "今天更新";
      if (days === 1) return "昨天更新";
      if (days <= 7) return `${days}天前更新`;
    }
  }
  if (order?.source === "feishu-public-orders" || !order?.createdAt) return "";
  const time = Date.parse(order.createdAt);
  if (!Number.isFinite(time) || time > now + 60000) return "";
  const days = Math.floor((now - time) / 86400000);
  if (days === 0) return "今天发布";
  if (days === 1) return "昨天发布";
  if (days <= 7) return `${days}天前发布`;
  return "";
}

function normalizedText(text) {
  return String(text || "").toLowerCase().replace(/天津市|\s|[，、,，。·()（）\-]/g, "");
}

export function findPotentialDuplicates(incoming, existing) {
  const found = [];
  for (const draft of incoming || []) {
    for (const order of existing || []) {
      if (draft.id && draft.id === order.id) {
        found.push({ incoming: draft, existing: order, reason: "内部编号相同" });
        continue;
      }
      const address = normalizedText(draft.publicAddress || draft.address);
      const oldAddress = normalizedText(order.publicAddress || order.address);
      if (address.length < 7 || address !== oldAddress || /待补充|某小区|全区|区中心/.test(address)) continue;
      if (normalizedText(draft.grade) !== normalizedText(order.grade)) continue;
      if (normalizedText(draft.subject) !== normalizedText(order.subject)) continue;
      // 只提示“可能重复”；同小区同年级同科目可能确实有不同学生。
      found.push({ incoming: draft, existing: order, reason: "年级、科目和公开地点一致" });
    }
  }
  return found;
}
