import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { onRequest as storeHandler } from "../functions/api/store.js";
import { onRequestPost as aiHandler } from "../functions/api/ai.js";

function makeEnv() {
  const data = new Map();
  const kv = {
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => { data.set(key, value); }
  };
  return { TUTOR_KV: kv, AUTH_SECRET: "test-only-signing-secret" };
}

function token(role = "admin") {
  const claims = { id: role, role, email: "test@example.com", exp: Date.now() + 300000 };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(claims))));
  const signature = createHash("sha256").update(`${content}.test-only-signing-secret`).digest("hex");
  return `${content}.${signature}`;
}

const request = (body, bearer = token()) => new Request("https://example.pages.dev/api/store", {
  method: "POST", headers: {
    "Content-Type": "application/json",
    ...(bearer ? { Authorization: `Bearer ${bearer}` } : {})
  },
  body: JSON.stringify(body)
});

test("云端空订单不会恢复样例；发布和删除后返回真实空数组", async () => {
  const env = makeEnv();
  const start = await storeHandler({ request: new Request("https://example.pages.dev/api/store"), env });
  const empty = await start.json();
  assert.deepEqual(empty.orders, []);
  assert.equal(empty.cloud, true);

  const order = { id: "#2992", grade: "高一", subject: "数学", title: "高一数学家教" };
  const added = await storeHandler({ request: request({ action: "admin_add_orders", orders: [order] }), env });
  assert.equal((await added.json()).orders.length, 1);

  const duplicate = await storeHandler({ request: request({ action: "admin_add_orders", orders: [order] }), env });
  assert.equal(duplicate.status, 409);

  const deleted = await storeHandler({ request: request({ action: "admin_delete_order", id: "#2992" }), env });
  assert.deepEqual((await deleted.json()).orders, []);

  const refresh = await storeHandler({ request: new Request("https://example.pages.dev/api/store"), env });
  assert.deepEqual((await refresh.json()).orders, []);
});

test("非管理员不能创建订单", async () => {
  const env = makeEnv();
  const response = await storeHandler({
    request: request({ action: "admin_add_orders", orders: [{ id: "#2992" }] }, token("teacher")), env
  });
  assert.equal(response.status, 403);
});

test("云端 AI 需要认证并能返回上游具体错误而非泛化 JSON 错误", async () => {
  const env = { ...makeEnv(), OPENAI_API_KEY: "fake-test-key", OPENAI_MODEL: "glm-4.7-flash" };
  const payload = { action: "parse_orders", payload: { text: "高一数学，每周一次" } };
  const denied = await aiHandler({ request: request(payload, ""), env });
  assert.equal(denied.status, 401);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "模型名称无效" } }), { status: 400 });
  try {
    const response = await aiHandler({ request: request(payload), env });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.match(body.error, /HTTP 400.*模型名称无效/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
