import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { onRequest } from "../functions/api/store.js";
import { teacherGenderRequirement } from "../js/board-utils.js";
import { getPublicMapLocation, groupPublicMapOrders } from "../js/map-board.js";
import { normalizeOrder } from "../js/order-format.js";

test("220条公开家教单均有独立内部ID，原始重复编号不被篡改", async () => {
  const items = JSON.parse(await readFile(new URL("../data/imported-orders.json", import.meta.url), "utf8"));
  assert.equal(items.length, 220);
  assert.equal(new Set(items.map((o) => o.id)).size, 220);
  assert.equal(new Set(items.map((o) => o.orderNumber)).size, 215);
  assert(items.every((o) => o.status === "待确认"));
  assert(items.every((o) => o.publicAddress === o.address));
  assert(items.every((o) => !Object.hasOwn(o, "privateAddress") && !Object.hasOwn(o, "lat")));
});

test("老师性别只依据老师要求，不从学生性别推断", () => {
  assert.equal(teacherGenderRequirement({ studentGender: "女生", requirements: "有耐心" }), "不限");
  assert.equal(teacherGenderRequirement({ studentGender: "男生", requirements: "最好是女老师" }), "女生");
  assert.equal(teacherGenderRequirement({ studentGender: "女生", requirements: "只要男老师" }), "男生");
});

test("按天或包次薪资不能按小时计算或错误参与时薪排序", () => {
  for (const salaryText of ["500/天", "5小时400元", "2.5小时一共120元"]) {
    const order = normalizeOrder({ id: "#3000", grade: "高三", subject: "数学", salaryText });
    assert.equal(order.hourlyRate, 0, salaryText);
    assert(order.salaryText.includes(salaryText), salaryText);
  }
});

test("地图仅使用公开地址，忽略后台精确经纬度和私人住址", () => {
  const order = { id: "fs-0001", orderNumber: "#2583", mode: "上门", district: "南开区",
    publicAddress: "天津市南开区天津大学附近", address: "天津市南开区天津大学附近",
    privateAddress: "私人门牌", lat: 1, lng: 2 };
  const loc = getPublicMapLocation(order);
  assert(loc && loc.lat > 30 && loc.lng > 110);
  assert.equal(groupPublicMapOrders([order]).length, 1);
});

test("公开接口屏蔽后台地址坐标且支持兼职发布", async () => {
  const kv = new Map();
  const env = { TUTOR_KV: {
    get: async (key) => kv.get(key) || null,
    put: async (key, value) => { kv.set(key, value); }
  }, AUTH_SECRET: "unit-test-secret" };
  kv.set("orders", JSON.stringify([{ id: "#3001", title: "测试", district: "河西区", address: "私人位置",
    publicAddress: "天津市河西区公开小区", privateAddress: "私密楼栋", lat: 39.01, lng: 117.1 }]));
  const publicRes = await onRequest({ request: new Request("https://example.com/api/store"), env });
  const body = await publicRes.json();
  assert.equal(body.orders[0].address, "天津市河西区公开小区");
  assert.equal(JSON.stringify(body).includes("私密楼栋"), false);
  assert.equal(JSON.stringify(body).includes("私人位置"), false);
  assert.equal(Object.hasOwn(body.orders[0], "lat"), false);
});

test("旧云端单在公开接口脱敏后仍保留完整九字段", async () => {
  const oldText = "#2992/初二数学家教\n【年级性别】初二，女孩\n【补习科目】数学\n【需要几个老师】1位\n【现阶段成绩】60分\n【补课地址】天津市河西区公开小区\n【一周几次】每周1次\n【每次几小时】2小时\n【对老师要求】认真负责\n【薪资】80～100元/小时";
  const raw = [{ id: "#2992", title: "初二数学家教", studentInfo: oldText, address: "】乱字段",
    requirements: "要求】认真负责【薪资】80～100元/小时", privateAddress: "私人门牌" }];
  const env = { TUTOR_KV: { get: async (key) => key === "orders" ? JSON.stringify(raw) : null,
    put: async () => {} } };
  const r = await onRequest({ request: new Request("https://example.com/api/store"), env });
  const body = await r.json();
  const order = body.orders[0];
  assert.equal(order.address, "天津市河西区公开小区");
  assert.equal(order.currentScores, "60分");
  assert.equal(order.requirements, "认真负责");
  assert.equal(order.salaryText, "80～100元/小时");
  assert.equal(JSON.stringify(order).includes("私人门牌"), false);
});
