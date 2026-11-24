import test from "node:test";
import assert from "node:assert/strict";
import {cleanTeachingPairs,cleanCompanionOptions,filterTeacherProfile,schoolTag} from "../shared/teacher-capabilities.js";
import {recommendTeacherProfiles} from "../js/teacher-profile-utils.js";
import {sanitizeTeacherResumeResult} from "../shared/teacher-resume-skill.js";
const profile={id:"a",name:"王老师",teacherType:"在校生",currentSchool:"天津大学",availability:"可接单",canTeach:"数学、物理",teachingPairs:[{subject:"数学",stage:"初中"},{subject:"物理",stage:"高中"}],companionOptions:[{stage:"初中",time:"每天晚上"}],starred:true,tianjinGaokao:"是"};
test("科目学段筛选保持对应关系",()=>{
 assert(filterTeacherProfile(profile,{subject:"数学",stage:"初中"}));
 assert(!filterTeacherProfile(profile,{subject:"数学",stage:"高中"}));
 assert(filterTeacherProfile(profile,{subject:"物理",stage:"高中",starred:true,school:"天大",local:"是"}));
 assert.equal(schoolTag({...profile,teacherType:"专职老师"}),"");
 assert.equal(cleanTeachingPairs([...profile.teachingPairs,...profile.teachingPairs]).length,2);
});
test("推荐禁止交叉组合，星标不能绕过可教科目及空闲限制",()=>{
 const match=(grade,subject,profiles=[profile])=>recommendTeacherProfiles({grade,subject,status:"招募中"},profiles);
 assert.equal(match("高一","数学").length,0);
 assert.equal(match("高一","物理").length,1);
 assert.equal(match("初二","陪读").length,1);
 assert.equal(match("高二","陪读").length,0);
 assert.equal(match("高一","物理",[{...profile,availability:"已接满"}]).length,0);
 assert.equal(match("高一","物理",[{...profile,id:"b",starred:false},profile])[0].teacherId,"a");
});
test("简历结构化提取保留明确字段，不由AI生成星标",()=>{
 const r=sanitizeTeacherResumeResult({teacherName:"王老师",teacherType:"机构老师",age:25,tianjinGaokao:"是",teachingPairs:profile.teachingPairs,companionOptions:profile.companionOptions,starred:true,phone:"13800000000"});
 assert.equal(r.teacherType,"机构老师");assert.equal(r.age,25);assert.equal(r.tianjinGaokao,"是");
 assert.equal(r.teachingPairs.length,2);assert.equal(r.companionOptions.length,1);assert.equal(r.starred,undefined);
 assert(!JSON.stringify(r).includes("13800000000"));
});
