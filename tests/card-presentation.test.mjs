import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { cardCopyableAddress, cardDisplayTitle, cardSchedule, cardStudentGenderTag, cardTeacherGenderTag, cardTitleSegments } from "../js/card-presentation.js";

test("卡片标题去掉重复的家教二字，但不改紧急标识", () => {
  assert.equal(cardDisplayTitle("高二地理家教"), "高二地理");
  assert.equal(cardDisplayTitle("高二化学家教‼️急急"), "高二化学‼️急急");
  assert.equal(cardDisplayTitle("初二全科陪读家教"), "初二全科陪读");
});

test("科目在标题原位置着色，不重复显示且保留多科、急招和陪读文字", () => {
  assert.deepEqual(cardTitleSegments("高二英语家教", "英语"), { before: "高二", subject: "英语", after: "" });
  assert.deepEqual(cardTitleSegments("高一化学、生物家教‼️急急", "化学、生物"),
    { before: "高一", subject: "化学、生物", after: "‼️急急" });
  assert.deepEqual(cardTitleSegments("高二、初二晚辅陪读家教", "晚辅陪读"),
    { before: "高二、初二", subject: "晚辅陪读", after: "" });
  assert.deepEqual(cardTitleSegments("初二全科陪读家教", "英语"),
    { before: "初二全科陪读", subject: "", after: "" });
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
  assert.equal(cardTeacherGenderTag({ requirements: "天津大学、南开大学女老师" }), "女老师");
  assert.equal(cardTeacherGenderTag({ requirements: "女老师优先" }), "女老师优先");
  assert.equal(cardTeacherGenderTag({ requirements: "女老师，天津本地考生优先" }), "女老师");
  assert.equal(cardTeacherGenderTag({ requirements: "最好男老师，有耐心" }), "男老师优先");
  assert.equal(cardTeacherGenderTag({ studentGender: "女生", requirements: "认真负责" }), "");
  assert.equal(cardTeacherGenderTag({ requirements: "男女老师均可" }), "");
});

test("学生性别标签明确标识学生，未提供性别时不编造", () => {
  assert.equal(cardStudentGenderTag({ studentGender: "男生", requirements: "女老师优先" }), "男学生");
  assert.equal(cardStudentGenderTag({ studentGender: "女孩" }), "女学生");
  assert.equal(cardStudentGenderTag({ studentGender: "性别待补充" }), "");
  assert.equal(cardStudentGenderTag({ requirements: "男老师优先" }), "");
});

test("启动完成不再等待地图，地图样式和卡片采用分阶段加载", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(app, /renderAll\(\);\s*completeStartupLoading\(\);\s*startupFinished = true;\s*scheduleMapOpen\(\)/);
  assert.match(app, /const CARD_BATCH_SIZE = 24/);
  assert.match(app, /items\.slice\(0, shownCardCount\)/);
  assert(!html.includes('<link rel="stylesheet" href="https://unpkg.com/leaflet'), "地图外链 CSS 不应阻塞首屏");
  assert(html.includes('id="mapLoadingNote"'), "地图需要独立加载提示");
});

test("常用筛选置顶并支持展开，公开卡片的选单和标题不再有多余符号", async () => {
  const app = await readFile(new URL("../js/app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../css/styles.css", import.meta.url), "utf8");
  assert(html.includes('id="btnToggleFilters"') && html.includes('id="advancedFilters" aria-label="更多筛选条件" hidden'));
  assert(html.includes('id="btnFloatingWechat"'));
  assert(!html.includes('id="onlyOpen"'));
  assert(css.includes('position:sticky; top:64px; z-index:65'));
  assert(!app.includes('class="card-title-separator"'));
  assert(!app.includes('＋ 加入选单'));
  assert(app.includes('isPubliclyOpenOrder(o)'));
});

test("复制地址只能采用公开地址，线上单不复制私人地址", () => {
  const order = { mode: "上门", address: "后台私人地址", publicAddress: "天津市河西区海景文苑",
    privateAddress: "楼号与房间号", lat: 39.1, lng: 117.2 };
  assert.equal(cardCopyableAddress(order), "天津市河西区海景文苑");
  assert.equal(cardCopyableAddress({ ...order, mode: "线上" }), "");
  assert.equal(cardCopyableAddress({ mode: "线上", publicAddress: "线上网课；线下天津市河西区金海湾花园" }),
    "天津市河西区金海湾花园");
  assert.equal(cardCopyableAddress({ mode: "均可", publicAddress: "线上网课；线下天津市河西区金海湾花园" }),
    "天津市河西区金海湾花园");
  assert.equal(cardCopyableAddress({ mode: "上门", publicAddress: "地址待补充" }), "");
});
