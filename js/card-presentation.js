// 仅处理家教看板的视觉文案；不修改原单、编号或复制整单时的九字段内容。
import { teacherGenderRequirement } from "./board-utils.js?v=2";

export function cardDisplayTitle(title) {
  return String(title || "").replace(/家教(?!.*家教)/, "").trim();
}

export function cardSchedule(order) {
  const original = String(order.weeklyFrequency || "").trim();
  const count = "[0-9一二两三四五六七八九十]+";
  const frequencyPattern = new RegExp(`(?:暂定)?(?:每(?:隔)?(?:[0-9一二两三四五六])?周|隔周|一周|两周|每月)(?:至少|约)?${count}(?:[～~－至到-]${count})?次`);
  const matched = original.match(frequencyPattern);
  const loose = !matched && original.match(/(?:周中|周末)([一二两三四五六七八九十0-9]+)次/);
  const numericCount = Number(order.sessionsPerWeek);
  let frequency = matched?.[0] || "";
  if (!frequency && loose) {
    const n = loose[1] === "两三" ? "2～3" : loose[1];
    frequency = `每周${n}次`;
  }
  if (!frequency && Number.isFinite(numericCount) && numericCount > 0) frequency = `每周${numericCount}次`;
  if (!frequency && /隔周上课|每两周上课/.test(original)) frequency = "隔周上课";
  if (!frequency) frequency = "次数待协商";

  const remaining = matched ? original.replace(matched[0], "") : original;
  const days = remaining.split(/[，,；;]/).map((part) => part.trim())
    .filter((part) => /周中|周末|周[一二三四五六日天]|星期[一二三四五六日天]/.test(part))
    .map((part) => part.replace(/^(?:或者|或者在|或在|或)\s*/, ""));
  const dayLabel = days.join(" / ").replace(/周天/g, "周日");
  const hours = Number(order.hoursPerSession);
  return {
    frequency,
    duration: Number.isFinite(hours) && hours > 0 ? `${hours}小时` : "时长待协商",
    dayLabel,
    original
  };
}

export function cardTeacherGenderTag(order) {
  const gender = teacherGenderRequirement(order);
  if (gender === "不限") return "";
  const raw = String(order.requirements || "");
  const term = gender === "男生" ? "(?:男老师|男教师|男大学生|男性老师|男生)"
    : "(?:女老师|女教师|女大学生|女性老师|女生)";
  const prefers = new RegExp(`${term}.{0,8}(?:优先|最好)|(?:优先|最好|尽量).{0,8}${term}`).test(raw);
  return `${gender === "男生" ? "♂" : "♀"} ${gender === "男生" ? "男老师" : "女老师"}${prefers ? "优先" : ""}`;
}

// 只能复制公开地址；不触碰后台 privateAddress、后台精确坐标或门牌。
export function cardCopyableAddress(order) {
  if (order.mode === "线上") return "";
  const publicAddress = String(order.publicAddress || order.address || "").trim()
    .replace(/^线上网课[；;，,]\s*线下/, "");
  if (!publicAddress || /^(?:线上|网课|待补充|地址待补充|地点待补充)/.test(publicAddress)) return "";
  return publicAddress;
}
