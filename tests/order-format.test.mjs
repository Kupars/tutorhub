import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOrderText, getGenderFromText, getSubjectList, mergeOrders, nextOrderId,
  normalizeOrder, parseFormattedOrder, splitOrderBySubject
} from "../js/order-format.js";
import { importOrderTable } from "../js/order-import.js";
import { parseMessyOrders } from "../js/ai-engine.js";

test("编号从 #2992 开始，并跳过旧式 JJ 编号", () => {
  assert.equal(nextOrderId([]), "#2992");
  assert.equal(nextOrderId([{ id: "JJ-2026-105" }, { id: "#2994-1" }]), "#2995");
});

test("学生性别与教师性别不混淆，缺失成绩不编造", () => {
  assert.equal(getGenderFromText("高一男孩，需要女老师"), "男生");
  assert.equal(getGenderFromText("要求：女老师有耐心"), "待补充");
  const order = normalizeOrder({ grade: "高一", subject: "数学" });
  assert.equal(order.currentScores, "成绩待补充");
  assert.equal(order.salaryText, "110～120元/小时（可报价）");
  assert.equal(order.teacherCount, 1);
});

test("标准九字段、试课和网课标注可以往返转换", () => {
  const original = normalizeOrder({
    id: "#2992", grade: "初二", subject: "数学、物理", studentGender: "女生",
    teacherCount: 1, currentScores: "数学60分，物理70分",
    address: "天津市河西区某小区", weeklyFrequency: "每周1次，周六下午",
    hoursPerSession: 2, salaryText: "80～100元/小时（可报价）",
    requirements: "有耐心", trialTime: "周日13:00—15:00", onlineAllowed: true
  });
  const txt = formatOrderText(original);
  assert.ok(txt.startsWith("#可网课\n#2992/初二数学、物理家教\n"));
  assert.equal((txt.match(/【/g) || []).length, 10);
  assert.ok(txt.includes("【试课时间】周日13:00—15:00"));
  const back = parseFormattedOrder(txt);
  assert.equal(back.id, "#2992");
  assert.equal(back.studentGender, "女生");
  assert.equal(back.subject, "数学、物理");
  assert.equal(back.currentScores, "数学60分，物理70分");
  assert.equal(back.salaryText, "80～100元/小时（可报价）");
  assert.equal(back.onlineAllowed, true);
});

test("多科拆单保留主编号、只保留各科成绩", () => {
  const two = splitOrderBySubject(normalizeOrder({
    id: "#2992", grade: "高一", subject: "数学、物理",
    currentScores: "数学60分，物理70分",
    address: "天津市南开区", weeklyFrequency: "每周1次，周六"
  }));
  assert.deepEqual(two.map((o) => o.id), ["#2992-1", "#2992-2"]);
  assert.deepEqual(two.map((o) => o.currentScores), ["数学60分", "物理70分"]);
  assert.deepEqual(two.map((o) => o.address), ["天津市南开区", "天津市南开区"]);
  const combined = mergeOrders(two, "#2992-1");
  assert.equal(combined.subject, "数学、物理");
  assert.equal(combined.teacherCount, 1);
});

test("CSV 文件中的带逗号字段和中文表头被正确导入", () => {
  const csv = [
    "年级,学生性别,补习科目,现阶段成绩（多少分）,补课地址（区＋小区）,薪资",
    '高一,男生,"数学,物理","数学60分,物理70分",天津市津南区富力桃园,110～120元/小时'
  ].join("\n");
  const records = importOrderTable(csv);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "#2992");
  assert.equal(records[0].studentGender, "男生");
  assert.equal(records[0].subject, "数学、物理");
  assert.equal(records[0].address, "天津市津南区富力桃园");
});

test("输入已有格式的旧单不调用网络，也不随意修改编号", async () => {
  const text = "#2911/高三英语家教\n【年级性别】高三，男孩\n【补习科目】英语\n【需要几个老师】1位\n【现阶段成绩】90分\n【补课地址】天津市河西区\n【一周几次】每周1次，周末\n【每次几小时】2小时\n【对老师要求】有耐心\n【薪资】130元/小时（可报价）";
  const result = await parseMessyOrders(text, [{ id: "#2999" }]);
  assert.equal(result.orders[0].id, "#2911");
  assert.equal(result.orders[0].currentScores, "90分");
});

test("科目按多个分隔符筛选并去重", () => {
  assert.deepEqual(getSubjectList("数学, 物理、数学+化学"), ["数学", "物理", "化学"]);
});

test("AI 失效时的规则解析仍保留多科、学生性别和真实薪资区间", async () => {
  const raw = "#2861 高一男孩，需要女老师，补习化学、生物，天津市津南区富力桃园，每周1次，周日，110～120元/小时";
  const result = await parseMessyOrders(raw);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].id, "#2861");
  assert.equal(result.orders[0].studentGender, "男生");
  assert.equal(result.orders[0].genderPref, "女老师优先");
  assert.equal(result.orders[0].subject, "化学、生物");
  assert.equal(result.orders[0].salaryText, "110～120元/小时（可报价）");
});
