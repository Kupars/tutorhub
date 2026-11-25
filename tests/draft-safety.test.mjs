import test from "node:test";
import assert from "node:assert/strict";
import {applyDraftPatches,prepareAIDrafts,explicitDraftRenumber} from "../js/ai-engine.js";
import {normalizeOrder,splitOrderBySubject,mergeOrders} from "../js/order-format.js";
const order=normalizeOrder({id:"#3070",grade:"高一",subject:"物理、化学",studentGender:"女生",address:"天津市和平区岳阳道",trialTime:"周日14:00",salaryText:"120元/小时",tags:["历史"],genderPref:"女老师",weeklyFrequency:"每周2次"});
test("AI字段补丁保留其他信息和草稿",()=>{
 const other={...order,id:"#3071",orderNumber:"#3071"};
 const next=applyDraftPatches("时薪150",{orders:[{id:"#3070",changes:{salaryText:"150元/小时"}}]},[order,other]);
 assert.equal(next[0].hourlyRate,150);assert.equal(next[0].trialTime,order.trialTime);assert.deepEqual(next[0].tags,order.tags);assert.equal(next[1],other);
 assert.throws(()=>applyDraftPatches("时薪150",{orders:[{id:"#3070",salaryText:"150元/小时"}]},[order]),/字段/);
});
test("否定改号不应更改，初次无井号编号可识别",()=>{
 assert.equal(explicitDraftRenumber("编号不是3080",[order]),null);
 assert.equal(prepareAIDrafts("高一物理，编号3080",{orders:[{grade:"高一",subject:"物理"}]})[0].orderNumber,"#3080");
});
test("拆分同步两个编号且不合并冲突薪资",()=>{
 const children=splitOrderBySubject({...order,id:"fs-0001"});
 assert.deepEqual(children.map(o=>o.orderNumber),["#3070-1","#3070-2"]);
 assert.throws(()=>mergeOrders([children[0],{...children[1],salaryText:"200元/小时"}]),/授课条件/);
});
