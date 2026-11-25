import test from "node:test";
import assert from "node:assert/strict";
import {normalizeOrder,formatOrderText} from "../js/order-format.js";
import {workspaceSnapshot,saveWorkspace,loadWorkspace,applyManualDraftText} from "../js/draft-workspace.js";
test("刷新恢复草稿和撤销历史，手动编辑保留隐藏字段",()=>{
 const o=normalizeOrder({id:"#3070",grade:"高一",subject:"物理",genderPref:"女老师",tags:["备注"],trialTime:"周日",salaryText:"120元/小时"});
 const next=applyManualDraftText(o,formatOrderText(o).replace("#3070/","#3080/"));
 assert.equal(next.orderNumber,"#3080");assert.equal(next.genderPref,o.genderPref);assert.deepEqual(next.tags,o.tags);assert.equal(next.trialTime,o.trialTime);
 const m=new Map(),storage={setItem:(k,v)=>m.set(k,v),getItem:k=>m.get(k)};
 assert(saveWorkspace(storage,workspaceSnapshot({parsedDraftOrders:[next],aiRawText:"改周末"}),[{label:"改号"}]));
 assert.equal(loadWorkspace(storage).current.parsedDraftOrders[0].id,"#3080");
 assert.equal(loadWorkspace(storage).history[0].label,"改号");
});
