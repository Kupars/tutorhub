import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { findPotentialDuplicates, orderFreshness } from "../js/order-extras.js";
import { onRequest as storeHandler } from "../functions/api/store.js";
import { onRequestPost as aiHandler } from "../functions/api/ai.js";

const fixture = () => {
  const db = new Map();
  return {
    TUTOR_KV: { get: async (key) => db.get(key) || null,
      put: async (key, value) => db.set(key, value) },
    AUTH_SECRET: "upgrade-test-secret-0123456789-aaa", ADMIN_PASSWORD: "secure-test-password"
  };
};
const auth = () => {
  const raw = btoa(JSON.stringify({ id: "admin", role: "admin", jti: "test-session-upgrade-12345", exp: Date.now() + 100000 }));
  return `${raw}.${createHmac("sha256", "upgrade-test-secret-0123456789-aaa").update(raw).digest("hex")}`;
};
const callStore = async (env, body, bearer = auth()) => {
  const response = await storeHandler({ env, request: new Request("https://test.pages.dev/api/store", {
    method: "POST", headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body)
  }) });
  return { response, data: await response.json() };
};

test("后台批量上下架只需一次云端更新，静态导入单保留完整公开字段", async () => {
  const env = fixture();
  const incoming = [
    { id: "fs-0012", orderNumber: "#2583", title: "高二英语", publicAddress: "天津市南开区八里台", status: "待确认" },
    { id: "#3000", orderNumber: "#3000", title: "初二数学", status: "招募中" }
  ];
  let result = await callStore(env, { action: "admin_add_orders", orders: incoming });
  assert.equal(result.response.status, 200);
  result = await callStore(env, { action: "admin_batch_status", ids: ["fs-0012", "#3000"], status: "已匹配" });
  assert(result.data.orders.every((o) => o.status === "已匹配"));
  const publicClosed = await storeHandler({ env, request: new Request("https://test.pages.dev/api/store") });
  assert.equal((await publicClosed.json()).orders.length, 0);
  result = await callStore(env, { action: "admin_batch_status", ids: ["fs-0012", "#3000"], status: "招募中" });
  assert.equal(result.data.orders.find((o) => o.id === "fs-0012").publicAddress, "天津市南开区八里台");
  const publicOpen = await storeHandler({ env, request: new Request("https://test.pages.dev/api/store") });
  assert.equal((await publicOpen.json()).orders.length, 2);
  result = await callStore(env, { action: "admin_batch_status", ids: ["#3000"], status: "已匹配" }, "");
  assert.equal(result.response.status, 401);
});

test("首次批量下架静态导入单时保留原编号、内容，不造新单", async () => {
  const env = fixture();
  const imported = { id: "fs-0022", orderNumber: "#2621", title: "高二数学家教", subject: "数学",
    address: "天津市南开区大学城附近", publicAddress: "天津市南开区大学城附近", status: "待确认" };
  const closed = await callStore(env, { action: "admin_batch_status", ids: ["fs-0022"], status: "已匹配", importedOverrides: [imported] });
  assert.equal(closed.data.orders[0].orderNumber, "#2621");
  assert.equal(closed.data.orders[0].subject, "数学");
  const reopened = await callStore(env, { action: "admin_batch_status", ids: ["fs-0022"], status: "招募中" });
  assert.equal(reopened.data.orders[0].publicAddress, imported.publicAddress);
});

test("GLM 老师端推荐只接受同源并校验 ID，连续请求受到限流", async () => {
  const env = { ...fixture(), OPENAI_API_KEY: "test-key" };
  const payload = { action: "recommend_orders", payload: { preference: "commute", candidates: [
    { id: "fs-0003", grade: "高一", subject: "数学", rate: 120, travelMinutes: 20 },
    { id: "fs-0004", grade: "初二", subject: "英语", rate: 85, travelMinutes: 10 }
  ] } };
  const req = (origin) => new Request("https://test.pages.dev/api/ai", { method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(payload) });
  const denied = await aiHandler({ env, request: req("https://attack.example") });
  assert.equal(denied.status, 403);
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ picks: [
    { id: "malicious", reason: "不在候选中" },
    { id: "fs-0004", reason: "上课时间适合" }
  ] }) } }] }), { status: 200 });
  try {
    const first = await aiHandler({ env, request: req("https://test.pages.dev") });
    assert.equal(first.status, 200);
    assert.deepEqual((await first.json()).result.picks, [{ id: "fs-0004", reason: "上课时间适合" }]);
    const next = await aiHandler({ env, request: req("https://test.pages.dev") });
    assert.equal(next.status, 429);
  } finally { globalThis.fetch = fetchBefore; }
});

test("新发布或确实更新的单才显示新鲜度，批量导入日期不可冒充发布时间", () => {
  const now = Date.parse("2026-11-22T12:00:00Z");
  assert.equal(orderFreshness({ source: "feishu-public-orders", createdAt: "2026-11-22T00:00:00Z" }, now), "");
  assert.equal(orderFreshness({ createdAt: "2026-11-22T08:00:00Z" }, now), "今天发布");
  assert.equal(orderFreshness({ source: "feishu-public-orders", updatedAt: "2026-11-21T00:00:00Z" }, now), "昨天更新");
  assert.equal(orderFreshness({ createdAt: "2026-10-01T00:00:00Z" }, now), "");
});

test("可能重复单提醒但不武断删除历史重号与同小区不同学生", () => {
  const old = { id: "fs-0099", orderNumber: "#2888", grade: "初二", subject: "物理", address: "天津市南开区华苑小区" };
  const near = { id: "#2998", grade: "初二", subject: "物理", publicAddress: "南开区华苑小区" };
  assert.equal(findPotentialDuplicates([near], [old]).length, 1);
  assert.equal(findPotentialDuplicates([{ ...near, grade: "高三" }], [old]).length, 0);
});

test("界面使用emoji选单、紧凑手机地图、可展开地图并记忆筛选", () => {
  const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../css/styles.css", import.meta.url), "utf8");
  assert.match(app, /order-check-emoji.*✅.*🛒/);
  assert.match(app, /FILTERS_KEY.*tutorhub_filters_v1/);
  assert.match(html, /id="btnExpandMap"/);
  assert.match(html, /⛶ 展开地图/);
  assert.match(app, /expanded \? "↙ 收起地图" : "⛶ 展开地图"/);
  assert.match(html, /id="aiPreference"/);
  assert.match(css, /#tutorMap \{ height:240px;/);
  assert.match(app, /btnAdminBatchClose/);
});
