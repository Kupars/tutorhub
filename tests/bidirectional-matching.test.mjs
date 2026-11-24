import test from "node:test";
import assert from "node:assert/strict";
import {recommendOrdersForTeacher,recommendTeacherProfiles} from "../js/teacher-profile-utils.js";
import {sanitizeTeacherResumeResult} from "../shared/teacher-resume-skill.js";
const teacher={id:"t",name:"王老师",canTeach:"数学",gradeLevels:"高中",availableTimes:"周末",availability:"可接单"};
const order={id:"#3063",grade:"高一",subject:"数学",weeklyFrequency:"周六",status:"招募中"};
test("双向匹配排除明确年级、日期冲突及已关闭订单",()=>{
  const pool=[order,{...order,id:"a",grade:"初二"},{...order,id:"b",weeklyFrequency:"周一"},{...order,id:"c",status:"已匹配"}];
  assert.deepEqual(recommendOrdersForTeacher(teacher,pool).map(x=>x.order.id),["#3063"]);
  assert.equal(recommendTeacherProfiles(order,[teacher,{...teacher,id:"x",availability:"已接满"}]).length,1);
});
test("简历提取补充匹配字段，不回传联系方式",()=>{
  const p=sanitizeTeacherResumeResult({gradeLevels:"高中",availableTimes:"周末",preferredDistricts:"河西区",phone:"13800000000"});
  assert.equal(p.gradeLevels,"高中");assert.equal(p.availableTimes,"周末");
  assert(!JSON.stringify(p).includes("13800000000"));
});
