// 轻量兜底提取器：从微信零散文本提取能确证的信息，不能猜测未提供的成绩、学生特征或地址。
import { getGenderFromText, normalizeOrder } from "./order-format.js";

const DISTRICTS = ["和平区","河西区","南开区","河东区","河北区","红桥区","津南区","西青区","东丽区","北辰区","武清区","滨海新区","宝坻区","静海区","宁河区","蓟州区"];
const GRADES = ["高三","高二","高一","初三","初二","初一","六年级","五年级","四年级","三年级","二年级","一年级","小学"];
const SUBJECTS = ["数学","语文","英语","物理","化学","生物","地理","历史","政治","道法","编程","全科","陪读","作业辅导"];
const trim = (x) => String(x || "").trim();
const capture = (s, regex) => trim(s.match(regex)?.[1]);
const cnDigit = { 一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9 };
const freqNumber = (str) => cnDigit[str] || Number(str) || 0;
const D = DISTRICTS.join("|");

function groupOrderBlocks(source) {
  const text = trim(source).replace(/\r\n?/g,"\n");
  if (!text) return [];
  const numbered = text.split(/(?=^#\d{3,7}(?:-\d+)?\s*[/／])/gm).map(trim).filter(Boolean);
  if (numbered.length > 1 && numbered.every(s=>s.length > 5)) return numbered;
  const withBlank = text.split(/\n\s*\n+/).map(trim).filter(Boolean);
  return withBlank.length > 1 ? withBlank : [text];
}

function parseAddress(block, district) {
  const stated = capture(block, /(?:【补课地址】|(?:补课地址|地址|地点|上课地点|授课地点)\s*[：:])\s*([^\n；;]{2,130})/);
  if (stated) return stated.replace(/[，,](?:每周|每次|工资|薪资|老师|要求|时间)[\s\S]*$/,"").trim();
  const match = block.match(new RegExp(`(?:天津市)?(?:${D})[^\\n，,。；;]{0,40}`));
  return match ? match[0].trim() : (district && district !== "区域待补充" ? `天津市${district}` : "地址待补充");
}

function parseWeekly(block) {
  const explicit = capture(block, /(?:【一周几次】|(?:一周几次|上课时间|授课时间|上课频率)\s*[：:])\s*([^\n；;]+)/);
  if (explicit) return explicit;
  const freq = block.match(/(?:每周|一周|两周|每两周|隔周)\s*[1-7一二两三四五六七]\s*(?:[～~—-]\s*[1-7一二两三四五六七])?\s*次/);
  const days = block.match(/(?:周中|周末|周[一二三四五六日天])(?:上午|下午|晚上|中午|早上|全天|[0-9:\s～~—-]{2,18})?/g) || [];
  const dayText = [...new Set(days.map(trim).filter(Boolean))].join("、");
  if (freq) return [freq[0],dayText].filter(Boolean).join("，");
  // 按原 skill：只给星期几、没有次数时可视为每周1次；不推测小时数。
  return dayText ? `每周1次，${dayText}` : "待协商";
}

function parseScores(block) {
  const explicit = capture(block, /(?:【现阶段成绩】|(?:现阶段成绩|目前成绩|孩子成绩|成绩)\s*[：:])\s*([^\n；;]+)/);
  if (explicit) return explicit;
  const known = [...block.matchAll(/(数学|语文|英语|物理|化学|生物|地理|历史|政治)\s*(\d{1,3}(?:\.\d+)?)\s*分/g)]
    .map((m)=>`${m[1]}${m[2]}分`);
  return known.join("，") || "成绩待补充";
}

function parseSalary(block) {
  const labeled = capture(block, /(?:【薪资】|(?:薪资|课时费|时薪|工资|报价)\s*[：:])\s*([^\n；;]+)/);
  if (labeled) return labeled;
  const rate = block.match(/\d{2,3}\s*(?:～|~|—|-|至|到)\s*\d{2,3}\s*(?:元|块)\s*(?:\/小时|\/时|每小时|一小时)?|\d{2,3}\s*(?:元|块)?\s*(?:\/小时|元\/小时|每小时|一小时|元一小时)/);
  return trim(rate?.[0]); // 无法确认时交给年级默认薪资，不误把成绩当时薪
}

function parseRequirements(block) {
  const labeled = capture(block, /(?:【对老师要求】|(?:对老师要求|老师要求|师资要求)\s*[：:])\s*([^\n；;]+)/);
  if (labeled) return labeled;
  const plain = capture(block, /(?:要求|希望老师|想找|最好)([^。\n；;]{2,95})/);
  return plain ? plain.replace(/^[，,:：\s]+/,"") : "无特殊要求";
}

export function extractRawOrderDrafts(source) {
  return groupOrderBlocks(source).map((block)=>{
    const grade = GRADES.find((g)=>block.includes(g)) || "年级待补充";
    const subject = SUBJECTS.filter((s)=>block.includes(s));
    const district = DISTRICTS.find((d)=>block.includes(d)) || "区域待补充";
    const mode = /线上|网课|远程|腾讯会议/.test(block)
      ? (/上门|线下/.test(block) ? "均可" : "线上") : "上门";
    const hours = Number(block.match(/(?:每次|一次|单次)\s*(\d+(?:\.\d+)?)\s*(?:个)?小时|(\d+(?:\.\d+)?)\s*小时\s*(?:\/次|一次)/)?.[1] ||
      block.match(/(?:每次|一次|单次)\s*(\d+(?:\.\d+)?)\s*(?:个)?小时|(\d+(?:\.\d+)?)\s*小时\s*(?:\/次|一次)/)?.[2]) || 2;
    const weeklyFrequency = parseWeekly(block);
    const freq = weeklyFrequency.match(/(?:每周|一周)\s*([1-7一二两三四五六七])\s*次/);
    const explicitTeachers = capture(block, /(?:【需要几个老师】|需要几个老师[：:]?|需要老师[：:]?)\s*(\d+)\s*位/);
    const requirements = parseRequirements(block);
    const orderId = trim(block.match(/#\d{3,7}(?:-\d+)?/)?.[0]);
    const trialTime = capture(block, /(?:【试课时间】|试课时间[：:])\s*([^\n；;]+)/);
    const salaryText = parseSalary(block);
    // 家长单独说“女生/男生”时可识别；若仅出现“女老师/男老师”不能推成学生性别。
    let studentGender = getGenderFromText(block);
    if (studentGender === "待补充") {
      if (/(?:^|[，,；;\s])女生(?:[，,。；;\s]|$)/.test(block) && !/女老师|女教师/.test(block)) studentGender = "女生";
      else if (/(?:^|[，,；;\s])男生(?:[，,。；;\s]|$)/.test(block) && !/男老师|男教师/.test(block)) studentGender = "男生";
    }
    return normalizeOrder({
      id: orderId, grade, subject: subject.join("、") || "科目待补充",
      title: `${grade}${subject.join("、") || "科目待补充"}家教`,
      studentGender, teacherCount: Number(explicitTeachers) || 1,
      currentScores: parseScores(block), district, address: mode === "线上" ? "线上授课" : parseAddress(block,district),
      mode, weeklyFrequency, sessionsPerWeek: freq ? freqNumber(freq[1]) : 0,
      hoursPerSession: hours, requirements, salaryText,
      onlineAllowed: /可网课|也可线上|线上线下均可/.test(block), trialTime,
      urgent: /急招|‼️急急|急急/.test(block), status:"招募中"
    });
  });
}

// 只负责提醒管理员补充缺项，不能擅自修改或虚构字段。
export function missingDraftFields(order) {
  const out=[];
  if (!order?.grade || /待补充/.test(order.grade)) out.push("年级");
  if (!order?.subject || /待补充/.test(order.subject)) out.push("科目");
  if (!order?.studentGender || order.studentGender === "待补充") out.push("学生性别");
  if (!order?.address || /待补充/.test(order.address)) out.push("补课地址");
  if (!order?.weeklyFrequency || order.weeklyFrequency === "待协商") out.push("上课频率");
  if (!order?.currentScores || /待补充/.test(order.currentScores)) out.push("成绩");
  return out;
}
