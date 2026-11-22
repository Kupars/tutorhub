// 看板的排序与微信选单文案：纯函数，便于测试且不会修改原始数据。
import { formatOrderText } from "./order-format.js";

function commuteMinutes(order) {
  if (order.commute?.isOnline) return 0;
  const value = Number(order.commute?.bestMin);
  return Number.isFinite(value) && value >= 0 && order.commute?.bestMin != null ? value : null;
}

function rate(order) {
  const value = Number(order.hourlyRate);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function latest(a, b) {
  return (Date.parse(b.createdAt || "") || 0) - (Date.parse(a.createdAt || "") || 0);
}

export function sortBoardOrders(orders, mode = "recommend") {
  const result = [...orders];
  if (mode === "rate") return result.sort((a, b) => rate(b) - rate(a) || latest(a, b));
  if (mode === "commute") {
    return result.sort((a, b) => {
      const am = commuteMinutes(a);
      const bm = commuteMinutes(b);
      return (am ?? Number.POSITIVE_INFINITY) - (bm ?? Number.POSITIVE_INFINITY) || rate(b) - rate(a) || latest(a, b);
    });
  }
  if (mode === "latest") return result.sort(latest);

  // 综合推荐权衡时薪与大致通勤时间；未取得位置时只参考时薪。
  const score = (order) => {
    const minutes = commuteMinutes(order);
    return rate(order) * 0.65 - (minutes == null ? 0 : Math.min(minutes, 180) * 0.5);
  };
  return result.sort((a, b) => score(b) - score(a) || latest(a, b));
}

export function buildWechatSelectionText(orders) {
  if (!orders.length) return "";
  const header = `小木同学你好，我看中了以下 ${orders.length} 条家教需求，想咨询是否还在招募：`;
  const body = orders.map((order) => formatOrderText(order)).join("\n\n");
  return `${header}\n\n${body}\n\n麻烦帮我确认一下，谢谢！`;
}
