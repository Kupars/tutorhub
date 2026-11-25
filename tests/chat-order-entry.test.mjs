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

test("子单排序跟随原文科目顺序而不是模型输出顺序",()=>{
  const r=prepareAIDrafts("数学物理分成两单",{orders:[{...sample,subject:"物理"},{...sample,subject:"数学"}]},[{orderNumber:"#3062"}]);
  assert.deepEqual(r.map(x=>[x.orderNumber,x.subject]),[["#3063-1","数学"],["#3063-2","物理"]]);
});


test("口语编号更正覆盖模型返回的旧号，正文编号字段一致",()=>{
  const old={...sample,id:"#3070",orderNumber:"#3070",subject:"物理、化学"};
  const input="嗯，我希望物化是一个老师，我们是女孩儿，现在是高一，在和平区岳阳道附近，我们住。\n是 3080";
  const result=prepareAIDrafts(input,{orders:[{...old,studentGender:"女生",address:"天津市和平区岳阳道附近",publicAddress:"天津市和平区岳阳道附近"}]},[],[old])[0];
  assert.equal(result.id,"#3080");assert.equal(result.orderNumber,"#3080");assert.equal(result.studentGender,"女生");
});
test("明确改号与其他业务数字区分，并且防止编号碰撞",()=>{
  const old={...sample,id:"#3070",orderNumber:"#3070",subject:"数学"};
  for(const text of ["编号改成3080","是 #3080","3080","把#3070改成#3080"])
    assert.equal(prepareAIDrafts(text,{orders:[old]},[],[old])[0].orderNumber,"#3080");
  assert.equal(prepareAIDrafts("薪资是3080元",{orders:[old]},[],[old])[0].orderNumber,"#3070");
  assert.throws(()=>prepareAIDrafts("编号改成3080",{orders:[old]},[{id:"other",orderNumber:"#3080"}],[old]),/已存在/);
});
test("多草稿改号必须指定原编号，并允许明确指定一条",()=>{
  const a={...sample,id:"#3070",orderNumber:"#3070",subject:"数学"};
  const b={...sample,id:"#3071",orderNumber:"#3071",subject:"物理"};
  assert.throws(()=>prepareAIDrafts("编号改成3080",{orders:[a,b]},[],[a,b]),/请指定/);
  assert.deepEqual(prepareAIDrafts("把#3070改成#3080",{orders:[b,a]},[],[a,b]).map(o=>o.orderNumber),["#3071","#3080"]);
});
