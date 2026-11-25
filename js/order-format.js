// TutorHub 家教需求单统一结构：AI、手动表单、复制和筛选共用此模块。
import { compactPublicAddress } from "./address-normalizer.js";
export const START_ORDER_NUMBER = 2991;
export const DEFAULT_SALARY = {
  小学: "70～90元/小时",
  初一: "80～100元/小时",
  初二: "80～100元/小时",
  初三: "90～110元/小时",
  高一: "110～120元/小时",
  高二: "120～130元/小时",
  高三: "130～150元/小时"
};

const subjectNames = ["数学", "物理", "化学", "生物", "英语", "语文", "地理", "历史", "政治", "编程", "全科"];
const gradeNames = ["高三", "高二", "高一", "初三", "初二", "初一", "五年级", "四年级", "三年级", "六年级", "二年级", "一年级", "小学"];
const str = (value) => String(value ?? "").trim();
const pick = (...values) => values.map(str).find(Boolean) || "";

// 年级别名统一为筛选器使用的标准值，AI 草稿和手动编辑共用。
export function normalizeGrade(value) {
  const input = str(value).replace(/\s+/g, "").replace(/[０-９]/g, c => String(c.charCodeAt(0)-0xFF10));
  const secondary = [
    ["初一", /初一|初中[一1]年级|七年级|(?<!\d)7年级/],
    ["初二", /初二|初中[二2]年级|八年级|(?<!\d)8年级/],
    ["初三", /初三|初中[三3]年级|九年级|(?<!\d)9年级/],
    ["高一", /高一|高中[一1]年级|十年级|(?<!\d)10年级/],
    ["高二", /高二|高中[二2]年级|十一年级|(?<!\d)11年级/],
    ["高三", /高三|高中[三3]年级|十二年级|(?<!\d)12年级/]
  ];
  for (const [grade, pattern] of secondary) if (pattern.test(input)) return grade;
  if (/大学|考研/.test(input)) return "大学/考研";
  const primary = input.match(/(?<!\d)([1-6])年级/);
  if (primary) return "一二三四五六"[Number(primary[1])-1]+"年级";
  return gradeNames.find(name => input.includes(name)) || "";
}

// 对行政区字段去掉“天津市”等前缀，避免同一区在筛选器里重复；不修改公开街道/小区地址。
export function canonicalDistrict(value) {
  const input = str(value);
  return input.match(/^(?:天津市|天津|北京市|北京|上海市|上海)?(和平区|河西区|南开区|河东区|河北区|红桥区|津南区|西青区|东丽区|北辰区|武清区|滨海新区|宝坻区|静海区|宁河区|蓟州区|海淀区|朝阳区|徐汇区)$/)?.[1] || input;
}

export function getSubjectList(value) {
  return [...new Set(str(value).split(/[、，,＋+\/和\s]+/).map((s) => s.trim()).filter(Boolean))];
}

export function getStudentGender(value) {
  const input = str(value);
  if (/^(男|男生|男孩|男学员|男学生)$/.test(input)) return "男生";
  if (/^(女|女生|女孩|女学员|女学生)$/.test(input)) return "女生";
  return "待补充";
}

export function getGenderFromText(text) {
  // 教师性别限制不等于学生性别。优先匹配显式学生描述。
  const input = str(text);
  const explicit = input.match(/(?:【年级性别】|【学生性别】|学生(?:性别)?[：:]|学员(?:性别)?[：:])\s*([^\n]+)/);
  if (explicit) {
    const gender = explicit[1].match(/(男孩|男生|男学员|女孩|女生|女学员)/);
    if (gender) return getStudentGender(gender[1]);
  }
  const match = input.match(/(?:高[一二三]|初[一二三]|小学|年级|学员|学生)[^\n，,。]{0,12}?(男孩|男生|男学员|女孩|女生|女学员)/);
  return match ? getStudentGender(match[1]) : "待补充";
}

export function nextOrderId(orders = []) {
  const max = orders.reduce((n, order) => {
    const match = str(order?.orderNumber || order?.id).match(/^#?(\d{3,7})(?:-\d+)?$/);
    return match ? Math.max(n, Number(match[1])) : n;
  }, START_ORDER_NUMBER);
  return `#${max + 1}`;
}

export function normalizeSalary(value, grade, hourlyRate) {
  let salary = str(value);
  if (!salary && Number(hourlyRate) > 0) salary = `${Number(hourlyRate)}元/小时`;
  if (!salary) salary = DEFAULT_SALARY[grade] || "老师报价";
  salary = salary.replace(/[（(]\s*$/, "");
  if (/\/?(?:天|次)|\d+\s*小时.*\d+\s*元|一共|总共/.test(salary) && !/元\/小时/.test(salary)) {
    return salary.includes("可报价") ? salary : `${salary}（可报价）`;
  }
  salary = salary.replace(/\s+/g, "").replace(/块/g, "元").replace(/[-—~～]/g, "～")
    .replace(/(?:元)?(?:一小时|每小时|\/小时|\/时|元时|元)$/, "元/小时");
  if (!/老师报价|可报价/.test(salary) && !/元\/小时/.test(salary)) salary += "元/小时";
  if (!/（可报价）/.test(salary)) salary = salary.replace(/[（(]?\s*可报价[）)]?/g, "")
    .replace(/[（(]\s*$/, "").replace(/（\s*）/g, "") + "（可报价）";
  return salary;
}

export function getSalaryValue(salaryText) {
  const value = str(salaryText);
  if (!/元\/小时/.test(value)) return 0;
  const match = value.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

export function inferFrequency(weeklyFrequency) {
  const text = str(weeklyFrequency);
  const match = text.match(/(?:每周|一周)\s*(\d+|[一二三四五六七])\s*(?:～|至|-)?\s*(?:\d+|[一二三四五六七])?\s*次/);
  const chars = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7 };
  return match ? (chars[match[1]] || Number(match[1]) || 0) : 0;
}

function recoverLegacyFields(raw) {
  // 早期 AI 曾把完整九字段单放入 studentInfo，并把 "】" 混进地址。
  // 只针对明显损坏的旧记录修正读取结果，绝不改写 Cloudflare KV 原数据。
  const source = str(raw.studentInfo);
  const broken = source.includes("【年级性别】") && source.includes("【补习科目】") &&
    (/^】/.test(str(raw.address)) || /^(?:对老师)?要求】/.test(str(raw.requirements)));
  if (!broken) return null;
  const fields = Object.fromEntries([...source.matchAll(/【([^】]+)】([\s\S]*?)(?=【[^】]+】|$)/g)]
    .map((match) => [match[1], match[2].trim()]));
  const gradeSex = fields["年级性别"] || "";
  const grade = normalizeGrade(gradeSex);
  const fromHeader = source.match(/^#\S+\/([^【\s]+)/)?.[1] || "";
  const requirements = str(raw.requirements).replace(/^(?:对老师)?要求】/, "")
    .replace(/【薪资】[\s\S]*$/, "").trim();
  const salary = str(raw.requirements).match(/【薪资】\s*(\d+(?:\.\d+)?\s*[～~—-]\s*\d+(?:\.\d+)?\s*元\/小时|\d+(?:\.\d+)?元\/小时)/)?.[1];
  return {
    grade, title: fromHeader, subject: fields["补习科目"],
    studentGender: getGenderFromText(`【年级性别】${gradeSex}`),
    teacherCount: Number(fields["需要几个老师"]?.match(/\d+/)?.[0]) || 1,
    currentScores: fields["现阶段成绩"],
    address: fields["补课地址"], weeklyFrequency: fields["一周几次"],
    hoursPerSession: Number(fields["每次几小时"]?.match(/\d+(?:\.\d+)?/)?.[0]) || 2,
    requirements: requirements || fields["对老师要求"], salaryText: salary
  };
}

export function normalizeOrder(raw = {}, options = {}) {
  const repaired = recoverLegacyFields(raw);
  const rawGrade = pick(repaired?.grade, raw.grade, options.grade);
  const grade = normalizeGrade(rawGrade) || rawGrade || "年级待补充";
  const subject = getSubjectList(pick(repaired?.subject, raw.subject, raw.subjects, options.subject)).join("、") || "科目待补充";
  const explicitGender = getStudentGender(pick(repaired?.studentGender, raw.studentGender, raw.studentSex, raw.studentInfoGender));
  const studentGender = explicitGender !== "待补充" ? explicitGender : (
    getStudentGender(str(raw.studentInfo).match(/^(男学员|女学员|男生|女生|男孩|女孩)/)?.[1]) !== "待补充"
      ? getStudentGender(str(raw.studentInfo).match(/^(男学员|女学员|男生|女生|男孩|女孩)/)?.[1])
      : getGenderFromText(str(raw.studentInfo))
  );
  const salaryText = normalizeSalary(pick(repaired?.salaryText, raw.salaryText, raw.salary), grade, raw.hourlyRate);
  const weeklyFrequency = pick(repaired?.weeklyFrequency, raw.weeklyFrequency, raw.frequency, raw.schedule) || "待协商";
  const sessionsPerWeek = repaired ? inferFrequency(weeklyFrequency) : Number(raw.sessionsPerWeek) || inferFrequency(weeklyFrequency);
  const mode = pick(raw.mode) || (/网课|线上|远程/.test(raw.notes || "") ? "线上" : "上门");
  const onlineAllowed = raw.onlineAllowed === true || raw.canOnline === true ||
    /可网课/.test(raw.rawText || "");
  const status = pick(raw.status) || "招募中";
  const title = pick(repaired?.title, raw.title) || `${grade}${subject}${/陪读/.test(raw.notes || "") ? "陪读" : ""}家教`;
  const address = compactPublicAddress(pick(repaired?.address, str(raw.address).replace(/^】/, "")) || "地址待补充", raw.district);
  const publicAddress = compactPublicAddress(pick(raw.publicAddress, address), raw.district);
  return {
    ...raw,
    id: pick(raw.id, options.id),
    orderNumber: pick(raw.orderNumber, raw.id, options.id),
    grade,
    subject,
    title,
    studentGender,
    teacherCount: Math.max(1, Math.trunc(Number(repaired?.teacherCount || raw.teacherCount) || 1)),
    currentScores: pick(repaired?.currentScores, raw.currentScores, raw.scores) || "成绩待补充",
    address,
    publicAddress,
    weeklyFrequency,
    sessionsPerWeek,
    hoursPerSession: Number(repaired?.hoursPerSession || raw.hoursPerSession) > 0 ? Number(repaired?.hoursPerSession || raw.hoursPerSession) : 2,
    requirements: pick(repaired?.requirements, raw.requirements) || "无特殊要求",
    salaryText,
    hourlyRate: getSalaryValue(salaryText),
    mode,
    onlineAllowed,
    trialTime: pick(raw.trialTime),
    notes: pick(raw.notes),
    district: canonicalDistrict(pick(raw.district)) || (pick(repaired?.address, raw.address).match(/(?:天津市)?(和平区|河西区|南开区|河东区|河北区|红桥区|津南区|西青区|东丽区|北辰区|武清区|滨海新区|宝坻区|静海区|宁河区|蓟州区)/)?.[1] || (mode === "线上" ? "线上" : "区域待补充")),
    genderPref: pick(raw.genderPref) || "不限",
    studentInfo: repaired ? "" : pick(raw.studentInfo) || "",
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    urgent: Boolean(raw.urgent),
    status,
    createdAt: pick(raw.createdAt) || new Date().toISOString()
  };
}

export function formatOrderText(order) {
  const o = normalizeOrder(order);
  const id = o.orderNumber.startsWith("#") ? o.orderNumber : `#${o.orderNumber || "待编号"}`;
  const sex = o.studentGender === "待补充" ? "性别待补充" : o.studentGender === "男生" ? "男孩" : "女孩";
  const title = /陪读/.test(o.title) ? `${o.grade}${o.subject}陪读家教` : `${o.grade}${o.subject}家教`;
  return [
    ...(o.onlineAllowed ? ["#可网课"] : []),
    `${id}/${title}${o.urgent ? "‼️急急" : ""}`,
    `【年级性别】${o.grade}${o.omitStudentGender ? "" : `，${sex}`}`,
    `【补习科目】${o.subject}`,
    `【需要几个老师】${o.teacherCount}位`,
    `【现阶段成绩】${o.currentScores}`,
    `【补课地址】${o.address}`,
    `【一周几次】${o.weeklyFrequency}`,
    `【每次几小时】${o.hoursPerSession}小时`,
    `【对老师要求】${o.requirements}`,
    `【薪资】${o.salaryText}`,
    ...(o.trialTime ? [`【试课时间】${o.trialTime}`] : []),
    ...(o.notes ? [`【其他说明】${o.notes}`] : [])
  ].join("\n");
}

export function splitOrderBySubject(order) {
  const o = normalizeOrder(order);
  const subjects = getSubjectList(o.subject);
  if (subjects.length <= 1) return [o];
  const parentId = o.id.replace(/-\d+$/, "");
  return subjects.map((subject, i) => normalizeOrder({
    ...o, id: `${parentId}-${i + 1}`, subject,
    currentScores: o.currentScores.includes(subject)
      ? (o.currentScores.split(/[，,；;]/).find((part) => part.includes(subject)) || o.currentScores)
      : (o.currentScores === "成绩待补充" ? o.currentScores : "成绩待补充"),
    title: `${o.grade}${subject}家教`
  }));
}

export function mergeOrders(orders, mainId) {
  if (!orders.length) throw new Error("没有可合并的家教单");
  const base = normalizeOrder(orders.find((o) => o.id === mainId) || orders[0]);
  const subjects = [...new Set(orders.flatMap((o) => getSubjectList(o.subject)))].join("、");
  const scores = [...new Set(orders.map((o) => normalizeOrder(o).currentScores)
    .filter((s) => s && s !== "成绩待补充"))].join("，") || "成绩待补充";
  const requirements = [...new Set(orders.map((o) => normalizeOrder(o).requirements)
    .filter((s) => s && s !== "无特殊要求"))].join("；") || "无特殊要求";
  return normalizeOrder({ ...base, id: mainId || base.id, subject: subjects, teacherCount: 1,
    currentScores: scores, requirements,
    title: `${base.grade}${subjects}家教` });
}

export function parseFormattedOrder(text) {
  const input = str(text);
  const fields = Object.fromEntries([...input.matchAll(/【([^】]+)】([^\n]*)/g)].map((match) => [match[1], match[2].trim()]));
  if (!fields["补习科目"] && !fields["年级性别"]) return null;
  const header = input.match(/#([\w-]+)\s*\//);
  const gradeSex = fields["年级性别"] || "";
  const grade = normalizeGrade(gradeSex) || "年级待补充";
  const number = Number((fields["需要几个老师"] || "").match(/\d+/)?.[0]) || 1;
  const hours = Number((fields["每次几小时"] || "").match(/\d+(?:\.\d+)?/)?.[0]) || 2;
  return normalizeOrder({
    id: header ? `#${header[1]}` : "",
    grade, subject: fields["补习科目"],
    studentGender: getGenderFromText(`【年级性别】${gradeSex}`),
    teacherCount: number,
    currentScores: fields["现阶段成绩"],
    address: fields["补课地址"],
    weeklyFrequency: fields["一周几次"],
    hoursPerSession: hours,
    requirements: fields["对老师要求"],
    salaryText: fields["薪资"],
    trialTime: fields["试课时间"],
    notes: fields["其他说明"],
    onlineAllowed: /#可网课/.test(input),
    mode: /网课|线上/.test(fields["补课地址"] || "") ? "线上" : "上门",
    urgent: /急急|急招/.test(input)
  });
}
