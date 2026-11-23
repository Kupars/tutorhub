import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesMultiFilters, normalizeMultiSelection, countSelectedFilters } from "../js/multi-filter.js";

const orders=[
  {id:"A",grade:"高一",subject:"数学、化学",mode:"上门",studentGender:"女生",district:"南开区",
    requirements:"男老师优先",weeklyFrequency:"每周1次，周日"},
  {id:"B",grade:"高二",subject:"物理",mode:"线上",studentGender:"男生",district:"津南区",
    requirements:"女老师优先",weeklyFrequency:"每周2次，周中"},
  {id:"C",grade:"初二",subject:"英语",mode:"上门",studentGender:"待补充",district:"和平区",
    requirements:"无特殊要求",weeklyFrequency:"每周1次，周六"}
];
test("同一类多选是 OR，不同类多选是 AND",()=>{
  const filters={qSubject:["数学","物理"],qDistrict:["南开区","津南区"]};
  assert.deepEqual(orders.filter(x=>matchesMultiFilters(x,filters)).map(x=>x.id),["A","B"]);
  filters.qDistrict=["津南区"];
  assert.deepEqual(orders.filter(x=>matchesMultiFilters(x,filters)).map(x=>x.id),["B"]);
  filters.qGrade=["高一"];
  assert.deepEqual(orders.filter(x=>matchesMultiFilters(x,filters)).map(x=>x.id),[]);
});
test("支持多选老师性别要求、学生性别和周中/周末",()=>{
  const filters={qTeacherGender:["男生","女生"],qStudentGender:["男生","女生"],qTime:["weekend","weekday"]};
  assert.deepEqual(orders.filter(x=>matchesMultiFilters(x,filters)).map(x=>x.id),["A","B"]);
  filters.qTime=["weekday"];
  assert.deepEqual(orders.filter(x=>matchesMultiFilters(x,filters)).map(x=>x.id),["B"]);
});
test("兼容旧版单一选项字符串且去重、统计实际勾选数量",()=>{
  assert.deepEqual(normalizeMultiSelection("数学"),["数学"]);
  assert.deepEqual(normalizeMultiSelection(["数学","数学","物理",""]),["数学","物理"]);
  assert.equal(countSelectedFilters({qSubject:["数学","物理"],qGrade:["高一"],qTime:[]},true,true),5);
});
test("科目筛选支持组合科目与小学年级",()=>{
  assert(matchesMultiFilters(orders[0],{qSubject:["化学"]}));
  assert(!matchesMultiFilters(orders[1],{qSubject:["数学"]}));
  assert(matchesMultiFilters({grade:"五年级",subject:"语文"}, {qGrade:["小学"]}));
});
test("前台多选控件存在全选、清空和可移除筛选标签",()=>{
  const html=readFileSync(new URL("../index.html",import.meta.url),"utf8");
  const js=readFileSync(new URL("../js/app.js",import.meta.url),"utf8");
  for(const id of ["qSubject","qGrade","qDistrict","qMode","qStudentGender","qTeacherGender","qTime"]){
    assert.match(html,new RegExp('class="multi-filter" id="'+id+'"'));
    assert.match(html,new RegExp('data-multi-options="'+id+'"'));
  }
  assert.match(html,/id="selectedFilterChips"/);
  assert.match(js,/renderSelectedFilterChips/);
  assert.match(html,/data-multi-action="all"/);
  assert.match(js,/normalizeMultiSelection\(saved\[id\]\)/);
});
test("后台主页只显示工作台，进入一个功能模块后可以返回和切换",()=>{
  const js=readFileSync(new URL("../js/app.js",import.meta.url),"utf8");
  for(const page of ["home","orders","manual","aiOrders","teachers","aiSite","parttime"]){
    assert.match(js,new RegExp('data-admin-page="'+page+'"'));
  }
  assert.match(js,/data-admin-go/);
  assert.match(js,/btnAdminHome/);
  assert.match(js,/adminPageSwitcher/);
  assert.match(js,/state\.adminPage = "manual"/);
  assert.match(js,/state\.adminPage = "aiOrders"/);
  assert.match(js,/if \(state\.adminPage !== "teachers"\) return/);
});
