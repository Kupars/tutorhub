// 看板的排序与微信选单文案：纯函数，便于测试且不会修改原始数据。
import { formatOrderText } from "./order-format.js";

export function teacherGenderRequirement(order) {
  const raw = String(order.requirements || "");
  const explicit = String(order.genderPref || "");
  if (/^(男|男生|男老师)$/.test(explicit)) return "男生";
  if (/^(女|女生|女老师)$/.test(explicit)) return "女生";
  // 老师性别与学生性别是不同字段；只读招聘要求中的明确性别条件。
  const female = /女(老师|教师|大学生|教员)|女性(老师|教师)|限女|女生优先|女老师优先/.test(raw);
  const male = /男(老师|教师|大学生|教员)|男性(老师|教师)|限男|男生优先|男老师优先/.test(raw);
  if (female && !male) return "女生";
  if (male && !female) return "男生";
  return "不限";
}

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
