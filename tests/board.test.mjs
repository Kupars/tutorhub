import test from "node:test";
import assert from "node:assert/strict";
import { buildWechatSelectionText, isPubliclyOpenOrder, sortBoardOrders } from "../js/board-utils.js";

const orders = [
  { id: "#2993", title: "高二英语家教", grade: "高二", subject: "英语", hourlyRate: 150, commute: { bestMin: 90 }, createdAt: "2026-11-20" },
  { id: "#2992", title: "初二数学家教", grade: "初二", subject: "数学", hourlyRate: 120, commute: { bestMin: 20 }, createdAt: "2026-11-19" },
  { id: "#2994", title: "高一物理网课", grade: "高一", subject: "物理", hourlyRate: 90, commute: { isOnline: true, bestMin: 0 }, createdAt: "2026-11-21" }
];

test("综合排序权衡时薪和通勤，支持分别按距离、时薪和日期排序", () => {
  assert.deepEqual(sortBoardOrders(orders).map((o) => o.id), ["#2992", "#2994", "#2993"]);
  assert.deepEqual(sortBoardOrders(orders, "commute").map((o) => o.id), ["#2994", "#2992", "#2993"]);
  assert.deepEqual(sortBoardOrders(orders, "rate").map((o) => o.id), ["#2993", "#2992", "#2994"]);
  assert.deepEqual(sortBoardOrders(orders, "latest").map((o) => o.id), ["#2994", "#2993", "#2992"]);
  assert.deepEqual(orders.map((o) => o.id), ["#2993", "#2992", "#2994"], "不能修改源数组");
});

test("无路线的订单按距离排序排在后面", () => {
  const extra = { id: "#2995", hourlyRate: 200, commute: null };
  assert.equal(sortBoardOrders([extra, ...orders], "commute").at(-1).id, "#2995");
});

test("选单复制内容包含完整标准家教单和微信联系提示", () => {
  const text = buildWechatSelectionText(orders.slice(0, 2));
  assert.match(text, /小木同学你好/);
  assert.match(text, /以下 2 条家教需求/);
  assert.match(text, /#2993\/高二英语家教/);
  assert.match(text, /#2992\/初二数学家教/);
  assert.match(text, /【补习科目】/);
  assert.match(text, /【对老师要求】/);
  assert.equal(buildWechatSelectionText([]), "");
});

test("后台关闭的家教单从公开看板消失，旧导入待确认单仍正常展示", () => {
  for (const status of ["招募中", "待确认", ""]) assert.equal(isPubliclyOpenOrder({ status }), true, status);
  for (const status of ["已匹配", "已关闭", "已招满", "已下架", "暂停招募"]) {
    assert.equal(isPubliclyOpenOrder({ status }), false, status);
  }
});
