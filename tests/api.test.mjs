import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { onRequest as storeHandler } from "../functions/api/store.js";
import { onRequestPost as aiHandler } from "../functions/api/ai.js";

function makeEnv() {
  const data = new Map();
  const kv = {
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => { data.set(key, value); }
  };
  return { TUTOR_KV: kv, ADMIN_PASSWORD: "test-only-password", AUTH_SECRET: "test-only-signing-secret" };
}

function token(role = "admin") {
  const claims = { id: role, role, jti: randomUUID(), email: "test@example.com", exp: Date.now() + 300000 };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(claims))));
  const signature = createHmac("sha256", "test-only-signing-secret").update(content).digest("hex");
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
  assert.equal(response.status, 401);
});

test("老师注册、简历和投递接口已停用，管理员发布仍可用", async () => {
  const env = makeEnv();
  for (const action of ["register", "save_resume", "apply", "update_my_app"]) {
    const response = await storeHandler({ request: request({ action }, ""), env });
    assert.equal(response.status, 410, `${action} 应不再开放`);
  }
  const deniedTeacher = await storeHandler({ request: request({ action: "admin_data" }, token("teacher")), env });
  assert.equal(deniedTeacher.status, 401);
  const admin = await storeHandler({ request: request({ action: "admin_data" }), env });
  assert.equal((await admin.json()).ok, true);
});

test("飞书导入单可在后台编辑删除并隐藏，刷新也不复活", async () => {
  const env = makeEnv();
  const edited = await storeHandler({ request: request({ action: "admin_update_order", id: "fs-0003", patch: {
    title: "已编辑家教单", orderNumber: "#2583", address: "河西区对外地址", publicAddress: "河西区对外地址"
  } }), env });
  assert.equal(edited.status, 200);
  const visible = await storeHandler({ request: new Request("https://example.pages.dev/api/store"), env });
  assert.equal((await visible.json()).orders[0].orderNumber, "#2583");
  const removed = await storeHandler({ request: request({ action: "admin_delete_order", id: "fs-0003" }), env });
  assert.deepEqual((await removed.json()).hiddenImported, ["fs-0003"]);
  const refreshed = await storeHandler({ request: new Request("https://example.pages.dev/api/store"), env });
  const result = await refreshed.json();
  assert.deepEqual(result.orders, []);
  assert.deepEqual(result.hiddenImported, ["fs-0003"]);
});

test("关闭的家教单不再通过公共接口返回，管理员仍可重新上架", async () => {
  const env = makeEnv();
  const closed = { id: "fs-0088", orderNumber: "#2517", title: "高二物理家教", status: "已匹配" };
  const open = { id: "#3001", title: "初一数学家教", status: "招募中" };
  await storeHandler({ request: request({ action: "admin_add_orders", orders: [closed, open] }), env });
  const publicResponse = await storeHandler({ request: new Request("https://example.pages.dev/api/store"), env });
  const publicData = await publicResponse.json();
  assert.deepEqual(publicData.orders.map((o) => o.id), ["#3001"]);
  assert(publicData.hiddenImported.includes("fs-0088"));
  const admin = await storeHandler({ request: request({ action: "admin_data" }), env });
  assert.equal((await admin.json()).orders.length, 2);
  await storeHandler({ request: request({ action: "admin_update_order", id: "fs-0088", patch: { status: "招募中" } }), env });
  const reopenned = await storeHandler({ request: new Request("https://example.pages.dev/api/store"), env });
  assert.equal((await reopenned.json()).orders.length, 2);
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
