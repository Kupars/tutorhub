import { nextOrderId, normalizeOrder } from "./order-format.js";

function parseRows(text, separator) {
  const rows = [];
  let cell = "", row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') { cell += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (!inQuotes && c === separator) {
      row.push(cell); cell = "";
    } else if (!inQuotes && (c === "\n" || c === "\r")) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function findField(row, ...keys) {
  for (const [header, value] of Object.entries(row)) {
    if (keys.some((key) => header.toLowerCase().includes(key.toLowerCase()))) return String(value || "").trim();
  }
  return "";
}

export function importOrderTable(text, existingOrders = []) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = firstLine.split("\t").length > firstLine.split(",").length ? "\t" : ",";
  const rows = parseRows(text.replace(/^\uFEFF/, ""), delimiter);
  if (rows.length < 2) throw new Error("表格缺少标题行或数据行");
  const headers = rows[0].map((v) => v.trim());
  if (!headers.some((h) => /年级|科目|学生性别/i.test(h))) throw new Error("无法识别表头，请先从飞书导出 CSV/TSV");
  const reserved = [...existingOrders];
  return rows.slice(1).map((cells) => {
    const record = Object.fromEntries(headers.map((key, index) => [key, cells[index] || ""]));
    const grade = findField(record, "年级");
    const subject = findField(record, "补习科目", "科目");
    const rawId = findField(record, "编号", "单号");
    const id = rawId ? (rawId.startsWith("#") ? rawId : `#${rawId}`) : nextOrderId(reserved);
    const genderText = findField(record, "学生性别", "年级性别");
    const studentGender = /女/.test(genderText) ? "女生" : /男/.test(genderText) ? "男生" : "待补充";
    const order = normalizeOrder({
      id, grade, subject, studentGender,
      teacherCount: Number(findField(record, "需要几个老师", "老师人数").match(/\d+/)?.[0]) || 1,
      currentScores: findField(record, "现阶段成绩", "成绩"),
      address: findField(record, "补课地址", "地址"),
      weeklyFrequency: findField(record, "一周几次", "每周", "频率"),
      hoursPerSession: findField(record, "每次几小时", "时长"),
      requirements: findField(record, "对老师要求", "要求"),
      salaryText: findField(record, "薪资", "时薪"),
      trialTime: findField(record, "试课时间"),
      notes: findField(record, "其他说明", "备注"),
      mode: findField(record, "授课方式") || "上门",
      onlineAllowed: /可网课/.test(findField(record, "网课", "授课方式", "其他说明")),
      urgent: /急/.test(findField(record, "紧急", "其他说明"))
    });
    reserved.push(order);
    return order;
  }).filter((order) => order.grade !== "年级待补充" || order.subject !== "科目待补充");
}
