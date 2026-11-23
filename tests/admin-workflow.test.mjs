import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { extractRawOrderDrafts, missingDraftFields } from "../js/structured-order-extractor.js";
import { ageOfOpenOrder, recommendPastTeachers } from "../js/assignment-utils.js";
import { guardSiteActions } from "../js/ai-command-guard.js";
import { onRequest } from "../functions/api/store.js";

const envFixture = () => {
  const data = new Map();
  return { TUTOR_KV: { get: async (key) => data.get(key) ?? null, put: async (key, value) => { data.set(key, value); } },
    AUTH_SECRET: "unique-test-secret-for-assignments", ADMIN_PASSWORD: "secure-test-password" };
};
const tokenFor = (secret) => {
  const base = Buffer.from(JSON.stringify({ id:"admin", role:"admin", exp:Date.now()+3600_000 })).toString("base64");
  return base + "." + createHash("sha256").update(base+"."+secret).digest("hex");
};
const call = async (env, action, body={}, authenticated=true) => {
  const response = await onRequest({ env, request: new Request("https://test.pages.dev/api/store", {
    method:"POST", headers:{ "Content-Type":"application/json",
      ...(authenticated?{Authorization:"Bearer "+tokenFor(env.AUTH_SECRET)}:{}) },
    body:JSON.stringify({ action, ...body })
  }) });
  return {status:response.status, data:await response.json()};
};

test("兜底提取保留年级科目真实地点、周日和时薪，不把上课时刻当价格", () => {
  const [a] = extractRawOrderDrafts("天津市津南区富力桃园，高一生物，周日9:00-11:00，120元一小时，女生");
  assert.equal(a.grade, "高一");
  assert.equal(a.subject, "生物");
  assert.match(a.address, /津南区富力桃园/);
  assert.match(a.weeklyFrequency, /周日/);
  assert.equal(a.hourlyRate, 120);
  assert.equal(a.studentGender, "女生");
});
test("不杜撰未知年级、成绩、学生性别和具体小区", () => {
  const [order] = extractRawOrderDrafts("想找个老师，时间另商量，天津市南开区，老师有耐心即可");
  assert.equal(order.grade, "年级待补充");
  assert.equal(order.currentScores, "成绩待补充");
  assert.equal(order.studentGender, "待补充");
  assert(missingDraftFields(order).includes("年级"));
  assert.equal(order.address, "天津市南开区");
});
test("历史批量导入不误判超时；真实新单可按发布时间提示", () => {
  const now = Date.parse("2026-12-10T12:00:00Z");
  assert.equal(ageOfOpenOrder({source:"feishu-public-orders",createdAt:"2026-11-22T00:00:00Z",status:"待确认"},now).kind,"unknown");
  assert.equal(ageOfOpenOrder({createdAt:"2026-11-20T00:00:00Z",status:"招募中"},now).kind,"overdue");
  assert.equal(ageOfOpenOrder({createdAt:"2026-11-20T00:00:00Z",status:"已匹配"},now),null);
});
test("推荐只来自既有历史接单，优先同地点同科，不推断教师实时位置", () => {
  const orders = [{id:"#2981",district:"津南区",subject:"数学",publicAddress:"天津市津南区富力桃园"}];
  const history = [{id:"as-1",orderId:"#2981",teacherName:"王老师",district:"津南区",subject:"数学",publicAddress:"天津市津南区富力桃园",assignedAt:"2026-11-01"}];
  const rank = recommendPastTeachers({id:"#2992",district:"津南区",subject:"数学",publicAddress:"天津市津南区富力桃园"},history,orders);
  assert.equal(rank.length,1);
  assert.equal(rank[0].teacherName,"王老师");
  assert.match(rank[0].reason,/同一公开地点/);
  assert.match(rank[0].warning,/不能推断/);
});
test("AI 网站命令只能操作原指令明确提及的单号和字段", () => {
  const orders = [{id:"fs-0003",orderNumber:"#2517"}];
  const proposal={actions:[
    {type:"update_order",id:"#2517",patch:{hourlyRate:150,status:"已匹配",privateAddress:"secret"}},
    {type:"delete_order",id:"#2517"},
    {type:"update_order",id:"#9999",patch:{hourlyRate:300}}
  ]};
  const guarded=guardSiteActions(proposal,"把#2517时薪改成150元并标记已匹配",orders);
  assert.equal(guarded.actions.length,1);
  assert.equal(guarded.actions[0].id,"fs-0003");
  assert.equal(guarded.actions[0].patch.salaryText,"150元/小时（可报价）");
  assert.equal(guarded.actions[0].patch.privateAddress,undefined);
});
test("老师记录只有管理员可读取，公开 GET 不会泄露老师联系方式", async () => {
  const env=envFixture();
  let answer=await call(env,"admin_add_orders",{ orders:[{id:"#2992",orderNumber:"#2992",grade:"高一",subject:"物理",
    district:"津南区",publicAddress:"天津市津南区富力桃园",status:"招募中"}] });
  assert.equal(answer.status,200);
  assert.equal(answer.data.orderSequence,2992);
  answer=await call(env,"admin_save_assignment",{orderId:"#2992",teacherName:"王老师",
    teacherContact:"wx-private-test",markMatched:true});
  assert.equal(answer.status,200);
  assert.equal(answer.data.assignments.length,1);
  const publicResponse=await onRequest({env,request:new Request("https://test.pages.dev/api/store")});
  const publicData=await publicResponse.json();
  assert.equal(publicData.orders.length,0);
  assert(!JSON.stringify(publicData).includes("wx-private-test"));
  const privateData=await call(env,"admin_data");
  assert.equal(privateData.data.assignments[0].teacherContact,"wx-private-test");
  const forbidden=await call(env,"admin_data",{},false);
  assert.equal(forbidden.status,401);
});
