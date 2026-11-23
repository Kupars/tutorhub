import { canonicalDistrict, getSubjectList } from "./order-format.js";
import { teacherGenderRequirement } from "./board-utils.js";

// 同一字段的不同选项用 OR；不同字段之间用 AND。
// 规则与页面结构分开，以便验证筛选不会因多选而退化成单选。
export const MULTI_FILTER_LABELS = {
  qSubject: "科目",
  qGrade: "年级",
  qDistrict: "区域",
  qMode: "方式",
  qStudentGender: "学生性别",
  qTeacherGender: "老师性别",
  qTime: "上课时间"
};

export const MULTI_FILTER_OPTIONS = {
  qMode: [{ value: "线上", label: "线上" }, { value: "上门", label: "上门" }, { value: "均可", label: "均可" }],
  qStudentGender: [
    { value: "男生", label: "男生" }, { value: "女生", label: "女生" },
    { value: "待补充", label: "性别待补充" }
  ],
  qTeacherGender: [
    { value: "男生", label: "男老师优先／要求男老师" },
    { value: "女生", label: "女老师优先／要求女老师" },
    { value: "不限", label: "不限性别" }
  ],
  qTime: [{ value: "weekend", label: "周末" }, { value: "weekday", label: "周中" }]
};

export function normalizeMultiSelection(values, allowed = null) {
  const input = Array.isArray(values) ? values : (typeof values === "string" && values ? [values] : []);
  const set = allowed ? new Set(allowed) : null;
  return [...new Set(input.filter(value => typeof value === "string" && value && (!set || set.has(value))))];
}

function anySelected(selections, match) {
  return selections.length === 0 || selections.some(match);
}

export function matchesMultiFilters(order, filters = {}) {
  const values = (id) => normalizeMultiSelection(filters[id]);
  if (!anySelected(values("qSubject"), (subject) =>
    order.subject === subject || getSubjectList(order.subject).includes(subject) ||
    String(order.subject || "").includes(subject))) return false;

  if (!anySelected(values("qGrade"), (grade) =>
    order.grade === grade || (grade === "小学" && /(?:小学|[一二三四五六1-6]年级)/.test(order.grade || "")))) return false;

  if (!anySelected(values("qMode"), (mode) => order.mode === mode)) return false;
  if (!anySelected(values("qStudentGender"), (gender) => order.studentGender === gender)) return false;

  const teacherPref = teacherGenderRequirement(order);
  if (!anySelected(values("qTeacherGender"), (gender) => teacherPref === gender)) return false;

  if (!anySelected(values("qDistrict"), (district) =>
    canonicalDistrict(order.district) === district)) return false;

  const frequency = String(order.weeklyFrequency || order.schedule || "");
  if (!anySelected(values("qTime"), (time) =>
    time === "weekend" ? /周末|周六|周日|周天/.test(frequency) :
      time === "weekday" ? /周中|周一|周二|周三|周四|周五/.test(frequency) : false)) return false;

  return true;
}

export function countSelectedFilters(filters, minRate = false, onlySelected = false) {
  return Object.keys(MULTI_FILTER_LABELS).reduce((count, id) =>
    count + normalizeMultiSelection(filters[id]).length, 0) + Number(Boolean(minRate)) + Number(Boolean(onlySelected));
}
