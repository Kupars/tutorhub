// 仅处理家教看板的视觉文案；不修改原单、编号或复制整单时的九字段内容。
import { teacherGenderRequirement } from "./board-utils.js?v=4";

export function cardDisplayTitle(title) {
  return String(title || "").replace(/家教(?!.*家教)/, "").trim();
}

// 标题只给原有科目文字上色，不额外重复添加科目标签或丢掉紧急标识。
export function cardTitleSegments(title, subject) {
  const display = cardDisplayTitle(title);
  const target = String(subject || "").trim();
  const start = target ? display.indexOf(target) : -1;
  if (start < 0) return { before: display, subject: "", after: "" };
  return { before: display.slice(0, start), subject: target, after: display.slice(start + target.length) };
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
  if (!frequency && /周[一二三四五六日天]/.test(original)) frequency = "按所列时段";
  if (!frequency) frequency = "次数待协商";

  const remaining = matched ? original.replace(matched[0], "") : original;
  const days = remaining.split(/[，,；;]/).map((part) => part.trim())
    .filter((part) => /周中|周末|周[一二三四五六日天]|星期[一二三四五六日天]/.test(part))
    .map((part) => part.replace(/^(?:或者|或者在|或在|或)\s*/, ""));
  const dayLabel = days.join(" / ").replace(/周天/g, "周日")
    .replace(/^(周中|周末)[一二两三四五六七八九十0-9]+次$/, "$1");
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
  const explicit = String(order.genderPref || "");
  const term = gender === "男生" ? "(?:男老师|男教师|男大学生|男性老师|男生)"
    : "(?:女老师|女教师|女大学生|女性老师|女生)";
  // 原文仅说“男老师/女老师”时，展示为倾向标签；不能把它渲染成家长明确规定的硬性门槛。
  // 只有写明“只要、必须、仅限”等条件，才使用不带“优先”的严格标签。
  const hardRequirement = new RegExp(
    `(?:只要|只招|只找|只考虑|只收|必须(?:是)?|仅限|只限|限定|限|要求)[\\s，,、]*${term}|${term}[\\s，,、]*(?:才行|才可以|限定|必须)`
  ).test(`${raw} ${explicit}`);
  return `${gender === "男生" ? "男老师" : "女老师"}${hardRequirement ? "" : "优先"}`;
}

// 学生性别是固定信息；标签必须写明“学生”，避免与老师性别要求混淆。
export function cardStudentGenderTag(order) {
  const gender = String(order.studentGender || "").trim();
  if (gender === "男生" || gender === "男孩") return "男学生";
  if (gender === "女生" || gender === "女孩") return "女学生";
  return "";
}

// 只能复制公开地址；不触碰后台 privateAddress、后台精确坐标或门牌。
export function cardCopyableAddress(order) {
  const original = String(order.publicAddress || order.address || "").trim();
  // 有的“线上”单实际上还给出了公开线下授课地点，仍允许老师复制去导航。
  if (order.mode === "线上" && !/^线上网课[；;，,]\s*线下/.test(original)) return "";
  const publicAddress = original
    .replace(/^线上网课[；;，,]\s*线下/, "");
  if (!publicAddress || /^(?:线上|网课|待补充|地址待补充|地点待补充)/.test(publicAddress)) return "";
  return publicAddress;
}
