import test from "node:test";
import assert from "node:assert/strict";
import {prepareAIDrafts} from "../js/ai-engine.js";
const sample={grade:"高一",studentGender:"男生",address:"天津市河西区津沽东里",publicAddress:"天津市河西区津沽东里"};
test("同一学生明确分单共用主编号且下一单顺延",()=>{
  const existing=[{orderNumber:"#3062"}];
  const orders=prepareAIDrafts("数学物理分成两单",{orders:[{...sample,subject:"数学"},{...sample,subject:"物理"}]},existing);
  assert.deepEqual(orders.map(o=>o.id),["#3063-1","#3063-2"]);
  assert.equal(prepareAIDrafts("高一生物",{orders:[{...sample,subject:"生物"}]},[...existing,...orders])[0].id,"#3064");
});
test("明确分单不将不同学生编入同一主号",()=>{
  const orders=prepareAIDrafts("两个学生分成两单",{orders:[{...sample,subject:"数学"},{...sample,subject:"物理"}]},[{orderNumber:"#3062"}]);
  assert.deepEqual(orders.map(o=>o.id),["#3063","#3064"]);
});
test("修改草稿保留原编号",()=>{
  const old={...sample,id:"#3063",orderNumber:"#3063",subject:"数学"};
  assert.equal(prepareAIDrafts("改到周日",{orders:[{...sample,subject:"数学",weeklyFrequency:"周日"}]},[{orderNumber:"#3062"}],[old])[0].id,"#3063");
});

test("明确指定已有主号用于新学生，不自动覆盖原单",()=>{
  const old={...sample,id:"#3062",orderNumber:"#3062",subject:"数学"};
  const result=prepareAIDrafts("新增#3062新单",{orders:[{...sample,id:"#3062",subject:"生物"}]},[old])[0];
  assert.equal(result.orderNumber,"#3062");assert.equal(result.explicitNumberReuse,true);
  assert.equal(result.existingOrderId,undefined);
});
test("历史主单拆分保留主编号并关联原单",()=>{
  const old={...sample,id:"#2770",orderNumber:"#2770",subject:"数学、物理",existingOrderId:"old-1"};
  const result=prepareAIDrafts("把#2770拆分成两单",{orders:[{...sample,subject:"数学"},{...sample,subject:"物理"}]},[old,{orderNumber:"#3062"}],[old]);
  assert.deepEqual(result.map(o=>o.orderNumber),["#2770-1","#2770-2"]);
  assert(result.every(o=>o.splitFromId==="old-1"));
});
