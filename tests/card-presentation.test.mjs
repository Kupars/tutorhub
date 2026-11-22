import test from "node:test";
import assert from "node:assert/strict";
import { cardCopyableAddress, cardDisplayTitle, cardSchedule, cardTeacherGenderTag } from "../js/card-presentation.js";

test("卡片标题去掉重复的家教二字，但不改紧急标识", () => {
  assert.equal(cardDisplayTitle("高二地理家教"), "高二地理");
  assert.equal(cardDisplayTitle("高二化学家教‼️急急"), "高二化学‼️急急");
  assert.equal(cardDisplayTitle("初二全科陪读家教"), "初二全科陪读");
});

test("上课频率、单次时长高亮，星期和具体时段只在小标签展示", () => {
  assert.deepEqual(cardSchedule({ weeklyFrequency: "每周1次，周日下午", hoursPerSession: 2 }), {
    frequency: "每周1次", duration: "2小时", dayLabel: "周日下午", original: "每周1次，周日下午"
  });
  const combined = cardSchedule({ weeklyFrequency: "每周2次，周中1次、周末1次", hoursPerSession: 1.5 });
  assert.equal(combined.frequency, "每周2次");
  assert.equal(combined.duration, "1.5小时");
  assert.equal(combined.dayLabel, "周中1次、周末1次");
  const alternating = cardSchedule({ weeklyFrequency: "每两周1次，最近可试课", hoursPerSession: 2 });
  assert.equal(alternating.frequency, "每两周1次");
  assert.equal(alternating.dayLabel, "");
  assert.equal(cardSchedule({ weeklyFrequency: "待协商", hoursPerSession: 2 }).frequency, "次数待协商");
});

test("老师性别小标签准确区分要求、优先和不限", () => {
  assert.equal(cardTeacherGenderTag({ requirements: "天津大学、南开大学女老师" }), "♀ 女老师");
  assert.equal(cardTeacherGenderTag({ requirements: "女老师优先" }), "♀ 女老师优先");
  assert.equal(cardTeacherGenderTag({ requirements: "最好男老师，有耐心" }), "♂ 男老师优先");
  assert.equal(cardTeacherGenderTag({ studentGender: "女生", requirements: "认真负责" }), "");
  assert.equal(cardTeacherGenderTag({ requirements: "男女老师均可" }), "");
});

test("复制地址只能采用公开地址，线上单不复制私人地址", () => {
  const order = { mode: "上门", address: "后台私人地址", publicAddress: "天津市河西区海景文苑",
    privateAddress: "楼号与房间号", lat: 39.1, lng: 117.2 };
  assert.equal(cardCopyableAddress(order), "天津市河西区海景文苑");
  assert.equal(cardCopyableAddress({ ...order, mode: "线上" }), "");
  assert.equal(cardCopyableAddress({ mode: "均可", publicAddress: "线上网课；线下天津市河西区金海湾花园" }),
    "天津市河西区金海湾花园");
  assert.equal(cardCopyableAddress({ mode: "上门", publicAddress: "地址待补充" }), "");
});
