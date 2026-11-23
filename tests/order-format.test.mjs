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


test("已有标准单也必须调用真实 API，不再走内置格式识别快捷路径", async () => {
  const originalFetch=globalThis.fetch,originalStorage=globalThis.localStorage;
  let called=false;
  globalThis.localStorage={getItem:()=> "fake-admin-session"};
  globalThis.fetch=async (_url,options) => {
    called=true;
    assert.equal(JSON.parse(options.body).action,"parse_orders");
    return new Response(JSON.stringify({ok:true,result:{provider:"mock-model",
      orders:[{id:"#2911",grade:"高三",studentGender:"男生",subject:"英语",
        currentScores:"90分",address:"天津市河西区",weeklyFrequency:"每周1次，周末",
        hoursPerSession:2,salaryText:"130元/小时（可报价）",requirements:"有耐心"}]}}),{status:200});
  };
  try {
    const old="#2911/高三英语家教\n【年级性别】高三，男孩\n【补习科目】英语";
    const parsed=await parseMessyOrders(old,[{id:"#2999"}]);
    assert(called);
    assert.equal(parsed.orders[0].id,"#2911");
    assert.equal(parsed.orders[0].currentScores,"90分");
  } finally {globalThis.fetch=originalFetch;globalThis.localStorage=originalStorage;}
});

test("科目按多个分隔符筛选并去重", () => {
  assert.deepEqual(getSubjectList("数学, 物理、数学+化学"), ["数学", "物理", "化学"]);
});


test("AI API 不可用时明确失败，不再产生伪装成 AI 的内置解析草稿", async () => {
  const originalFetch=globalThis.fetch,originalStorage=globalThis.localStorage;
  globalThis.localStorage={getItem:()=>""};
  globalThis.fetch=async()=>new Response(JSON.stringify({ok:false,error:"上游模型不可用"}),{status:503});
  try {
    await assert.rejects(()=>parseMessyOrders("高一男生，天津津南区数学，每周1次"),/上游模型不可用/);
  } finally {globalThis.fetch=originalFetch;globalThis.localStorage=originalStorage;}
});

test("旧版误解析的整段家教单可以恢复九字段，不改原始编号及数据", () => {
  const raw = {
    id: "JJ-2026-4738", grade: "小学", subject: "数学", salary: 60,
    studentInfo: "#2932/五年级语文、数学、英语家教 【年级性别】五年级，男孩 【补习科目】语文、数学、英语 【需要几个老师】1位 【现阶段成绩】80分左右 【补课地址】天津市西青区中北镇碧水家园E区 【一周几次】每周4次，周中2次、周末2次 【每次几小时】1.5小时 【对老师要求】能够同时辅",
    address: "】天津市西青区中北镇碧水家园E区",
    requirements: "要求】能够同时辅导语文、数学、英语三科，熟练掌握五年级英语语法知识 【薪资】60元/小时（可报价）",
    sessionsPerWeek: 2, hoursPerSession: 2
  };
  const recovered = normalizeOrder(raw);
  assert.equal(recovered.id, "JJ-2026-4738");
  assert.equal(recovered.grade, "五年级");
  assert.equal(recovered.subject, "语文、数学、英语");
  assert.equal(recovered.studentGender, "男生");
  assert.equal(recovered.currentScores, "80分左右");
  assert.equal(recovered.address, "天津市西青区中北镇碧水家园E区");
  assert.equal(recovered.weeklyFrequency, "每周4次，周中2次、周末2次");
  assert.equal(recovered.hoursPerSession, 1.5);
  assert.equal(recovered.sessionsPerWeek, 4);
  assert.match(recovered.requirements, /同时辅导语文/);
  assert.equal(recovered.studentInfo, "");
  assert.equal(raw.address[0], "】", "不得修改原始云端对象");
});

test("普通旧单能从学生信息推断学生性别，不能从女老师要求误推断", () => {
  assert.equal(normalizeOrder({ studentInfo: "高一男生" }).studentGender, "男生");
  assert.equal(normalizeOrder({ studentInfo: "女老师优先" }).studentGender, "待补充");
});
