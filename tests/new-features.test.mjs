import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { onRequest } from "../functions/api/store.js";
import { teacherGenderRequirement } from "../js/board-utils.js";
import { clusterNearbyMapGroups, getPublicMapLocation, groupPublicMapOrders, markerStyleForGroup, popupTitleForGroup } from "../js/map-board.js";
import { canonicalDistrict, normalizeOrder } from "../js/order-format.js";
import { SAMPLE_ORDERS } from "../js/data.js";
import { normalizePublicAddress, safeOptimizedPublicAddress } from "../js/address-normalizer.js";
import { isPlausiblePublicGeocode, verifiedPublicLandmarkCoords } from "../js/commute.js";
import { getSeasonForDate, termDay } from "../js/season-theme.js";

test("四季主题按北京时间节气日切换，跨年仍自动识别冬季", () => {
  assert.deepEqual(["spring", "summer", "autumn", "winter"].map((season) => termDay(2026, season)), [4, 5, 7, 7]);
  assert.deepEqual(["spring", "summer", "autumn", "winter"].map((season) => termDay(2027, season)), [4, 6, 8, 7]);
  assert.equal(getSeasonForDate(new Date("2026-02-03T15:00:00Z")), "winter");
  assert.equal(getSeasonForDate(new Date("2026-02-03T16:00:00Z")), "spring");
  assert.equal(getSeasonForDate(new Date("2026-05-04T16:00:00Z")), "summer");
  assert.equal(getSeasonForDate(new Date("2026-08-06T16:00:00Z")), "autumn");
  assert.equal(getSeasonForDate(new Date("2026-11-06T16:00:00Z")), "winter");
  assert.equal(getSeasonForDate(new Date("2026-11-22T10:00:00Z")), "winter");
  assert.equal(getSeasonForDate(new Date("2027-05-05T15:00:00Z")), "spring");
  assert.equal(getSeasonForDate(new Date("2027-05-05T16:00:00Z")), "summer");
});

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

test("原单不完整的可报价括号不会污染售价文案", () => {
  const order = normalizeOrder({ id: "#3000", grade: "高三", subject: "英语", salaryText: "130～150元/小时（可报价" });
  assert.equal(order.salaryText, "130～150元/小时（可报价）");
});

test("地图仅使用公开地址，忽略后台精确经纬度和私人住址", () => {
  const order = { id: "fs-0001", orderNumber: "#2583", mode: "上门", district: "南开区",
    publicAddress: "天津市南开区天津大学附近", address: "天津市南开区天津大学附近",
    privateAddress: "私人门牌", lat: 1, lng: 2 };
  const loc = getPublicMapLocation(order);
  assert(loc && loc.lat > 30 && loc.lng > 110);
  assert.equal(groupPublicMapOrders([order]).length, 1);
});

test("2684与2621的公开地址规范为准确地标，拒绝异区误定位", () => {
  assert.equal(normalizePublicAddress("天津市和平区诚基经贸中心", "和平区"), "天津市和平区诚基中心");
  assert.equal(normalizePublicAddress("天津市河东区45中附近", "河东区"), "天津市河东区第四十五中学附近");
  const a = normalizeOrder({ id: "fs-0136", district: "和平区", publicAddress: "天津市和平区诚基经贸中心",
    address: "天津市和平区诚基经贸中心" });
  assert.equal(a.publicAddress, "天津市和平区诚基中心");
  assert.equal(a.address, "天津市和平区诚基中心");
  assert.deepEqual(getPublicMapLocation(a), { ...verifiedPublicLandmarkCoords(a.publicAddress),
    district: "和平区", geocoded: true, landmark: true });
  const b = normalizeOrder({ id: "fs-0198", district: "河东区", address: "天津市河东区45中附近" });
  assert.deepEqual(getPublicMapLocation(b), { ...verifiedPublicLandmarkCoords(b.publicAddress),
    district: "河东区", geocoded: true, landmark: true });
  assert.equal(isPlausiblePublicGeocode(a, { lat: 39.1171, lng: 117.2146, district: "和平区", province: "天津市" }), true);
  assert.equal(isPlausiblePublicGeocode(a, { lat: 39.20, lng: 116.90, district: "和平区", province: "天津市" }), false);
  assert.equal(isPlausiblePublicGeocode(a, { lat: 39.1171, lng: 117.2146, district: "河东区", province: "天津市" }), false);
});

test("AI 地址润色不能编造新地点、门牌或抹掉‘附近’", () => {
  assert.equal(safeOptimizedPublicAddress("河东区45中附近", "天津市河东区第四十五中学附近", "河东区"),
    "天津市河东区第四十五中学附近");
  assert.equal(safeOptimizedPublicAddress("天津市河东区第四十五中学附近", "天津市河东区广宁路15号", "河东区"),
    "天津市河东区第四十五中学附近");
  assert.equal(safeOptimizedPublicAddress("天津市和平区诚基中心", "天津市河西区某公寓", "和平区"),
    "天津市和平区诚基中心");
});

test("地图仅将包含已勾选单的标记变绿，详情标题不误报区域总数", () => {
  const group = { district: "津南区", orders: [{ id: "#100" }, { id: "#101" }] };
  assert.equal(markerStyleForGroup(group, () => false).fillColor, "#818cf8");
  assert.equal(markerStyleForGroup(group, (id) => id === "#101").fillColor, "#4ade80");
  assert.equal(popupTitleForGroup(group), "这个标记对应 2 条家教单");
  assert(!popupTitleForGroup(group).includes("津南区"));
});

test("地图像素距离接近的家教点合并；放大后拆分，并保留每单与勾选状态", () => {
  const groups = [
    { lat: 39.1, lng: 117.1, district: "南开区", orders: [{ id: "a" }, { id: "b" }] },
    { lat: 39.1, lng: 117.101, district: "南开区", orders: [{ id: "c" }] },
    { lat: 39.1, lng: 117.1008, district: "南开区", orders: [{ id: "d" }] },
    { lat: 39.2, lng: 117.3, district: "河西区", orders: [{ id: "e" }] }
  ];
  const close = clusterNearbyMapGroups(groups, (lat, lng) => ({ x: lng * 40000, y: lat * 40000 }));
  assert.equal(close.length, 2);
  assert.equal(close[0].locationsCount, 3);
  assert.deepEqual(close[0].orders.map((o) => o.id), ["a", "b", "c", "d"]);
  assert.equal(markerStyleForGroup(close[0], (id) => id === "c").fillColor, "#4ade80");
  assert.equal(popupTitleForGroup(close[0]), "这个标记对应 4 条家教单");
  const zoomed = clusterNearbyMapGroups(groups, (lat, lng) => ({ x: lng * 500000, y: lat * 500000 }));
  assert.equal(zoomed.length, 4);
  assert.equal(zoomed[0].orders.length, 2);
  // 彼此邻近不代表应无限传递，避免整片城区“串珠式”聚成一个巨型标记。
  const chain = Array.from({ length: 12 }, (_, index) => ({
    lat: 39.1, lng: 117.1 + index * .001,
    district: "南开区", orders: [{ id: `chain-${index}` }]
  }));
  const bounded = clusterNearbyMapGroups(chain, (lat, lng) => ({ x: lng * 40000, y: lat * 40000 }));
  assert(bounded.length >= 4, "链式靠近的点必须拆成多个可点开的标记");
  assert(bounded.every((group) => group.orders.length <= 3), "单个合并标记不得跨越整条点链");
});

test("津南区在筛选和地图里不应分成‘天津市津南区’与‘津南区’", () => {
  assert.equal(canonicalDistrict("天津市津南区"), "津南区");
  assert.equal(canonicalDistrict("津南区"), "津南区");
  const order = normalizeOrder({ id: "#3901", district: "天津市津南区", address: "天津市津南区某小区" });
  assert.equal(order.district, "津南区");
  assert.equal(order.address, "天津市津南区某小区");
});

test("五条旧JJ演示单不再作为默认家教单，地图详情只含公开字段", () => {
  assert.deepEqual(SAMPLE_ORDERS, []);
  const [group] = groupPublicMapOrders([{ id: "#3902", orderNumber: "#3902", district: "河西区", mode: "上门",
    grade: "高二", subject: "数学", salaryText: "120元/小时", weeklyFrequency: "周末",
    publicAddress: "天津市河西区梅江", privateAddress: "不应显示的门牌", privateNotes: "隐私备注" }]);
  assert.equal(group.orders[0].salaryText, "120元/小时");
  assert.equal(group.orders[0].address, "天津市河西区梅江");
  assert(!JSON.stringify(group).includes("不应显示的门牌"));
  assert(!JSON.stringify(group).includes("隐私备注"));
});

test("旧JJ测试单仅清理指定八个ID，真实云端单保留", async () => {
  const entries = new Map([["orders", JSON.stringify([
    { id: "JJ-2026-101", title: "虚构演示" }, { id: "JJ-2026-4737", title: "云端残留测试" },
    { id: "JJ-2026-4738", title: "云端残留测试" }, { id: "JJ-2026-888", title: "云端残留测试" },
    { id: "#3903", title: "真实单" }
  ])]]);
  const env = { TUTOR_KV: { get: async (key) => entries.get(key), put: async (key, value) => entries.set(key, value) } };
  const response = await onRequest({ request: new Request("https://example.com/api/store"), env });
  const body = await response.json();
  assert.deepEqual(body.orders.map((o) => o.id), ["#3903"]);
  assert.deepEqual(JSON.parse(entries.get("orders")).map((o) => o.id), ["#3903"]);
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
