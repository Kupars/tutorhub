import { APP_CONFIG } from "./app-env.js";
import { SUBJECTS, GRADES } from "./data.js";
import { inferCoordsFromText } from "./commute.js";
import { getGenderFromText, nextOrderId, normalizeOrder, parseFormattedOrder } from "./order-format.js";
import { normalizePublicAddress, safeOptimizedPublicAddress } from "./address-normalizer.js";
import { extractRawOrderDrafts } from "./structured-order-extractor.js";

let lastAIError = "";

async function callServerlessAI(action, payload) {
  try {
    const token = localStorage.getItem("tutorhub_token_v3");
    const res = await fetch(`${APP_CONFIG.apiBase}/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ action, payload }),
      ...(action === "optimize_addresses" ? { signal: AbortSignal.timeout(15000) } : {})
    });
    const data = await res.json();
    if (!res.ok || !data?.ok) {
      lastAIError = data?.error || `接口错误 HTTP ${res.status}`;
      return null;
    }
    if (data && data.ok) return data.result;
    return null;
  } catch (err) {
    lastAIError = err.message || "网络请求失败";
    return null;
  }
}

// 老师端仅上传筛选后的公开摘要和估算通勤，不传设备定位坐标、微信、后台地址等隐私信息。
export async function recommendOrdersWithAI(orders, preference = "balanced") {
  const candidates = (orders || []).slice(0, 30).map((order) => ({
    id: String(order.id).slice(0, 60),
    grade: String(order.grade || "").slice(0, 25),
    subject: String(order.subject || "").slice(0, 50),
    district: String(order.district || "").slice(0, 32),
    rate: Number(order.hourlyRate) || 0,
    frequency: String(order.weeklyFrequency || "").slice(0, 90),
    travelMinutes: order.commute && !order.commute.isOnline && !order.commute.approximate
      ? Number(order.commute.transitMin) || null : null
  }));
  const result = await callServerlessAI("recommend_orders", { candidates, preference });
  if (!Array.isArray(result?.picks)) return null;
  const allowed = new Set(candidates.map((item) => item.id));
  const ids = new Set();
  const picks = result.picks.filter((pick) => {
    if (!pick || !allowed.has(pick.id) || ids.has(pick.id)) return false;
    ids.add(pick.id);
    return true;
  }).slice(0, 5).map((pick) => ({ id: pick.id, reason: String(pick.reason || "").slice(0, 40) }));
  return picks.length ? { picks, provider: result.provider || "GLM" } : null;
}

function prepareDrafts(rawText, orders, existingOrders = []) {
  const reserved = [...existingOrders];
  const splitting = orders.length > 1 && /拆单|拆分|分成.*单|分别招/.test(rawText);
  const splitParent = splitting
    ? (rawText.match(/#\d{3,7}(?![\d-])/)?.[0] || nextOrderId(reserved)) : "";
  return orders.map((raw, index) => {
    const candidate = normalizeOrder(raw);
    const code = candidate.id.startsWith("#") ? candidate.id : `#${candidate.id}`;
    // 只有用户明确提供编号时才信任 AI 给出的编号，避免模型自造编号。
    const explicit = /^#\d+(?:-\d+)?$/.test(code) &&
      (rawText.includes(code) || (/^#\d+-\d+$/.test(code) && rawText.includes(code.split("-")[0])));
    candidate.id = explicit ? code : splitting ? `${splitParent}-${index + 1}` : nextOrderId(reserved);
    candidate.orderNumber = candidate.id;
    reserved.push(candidate);
    candidate.title = `${candidate.grade}${candidate.subject}家教`;
    return candidate;
  });
}

// 发布时批量向当前 GLM 等已配置模型请求地址润色；不可用时保留本地安全规范化结果。
// 每条模型建议都会做二次校验，不允许捏造新的地标、门牌、楼栋或消除“附近”。
export async function optimizeOrderAddressesWithAI(orders) {
  const result = orders.map((order) => {
    const publicAddress = normalizePublicAddress(order.publicAddress || order.address, order.district);
    return { ...order, address: publicAddress, publicAddress };
  });
  const indexes = result.map((order, index) => ({ order, index }))
    .filter(({ order }) => order.mode !== "线上" && !/^(?:地址待补充|线上|网课)/.test(order.publicAddress));
  for (let start = 0; start < indexes.length; start += 25) {
    const batch = indexes.slice(start, start + 25);
    const remote = await callServerlessAI("optimize_addresses", { addresses: batch.map(({ order }) => ({
      address: order.publicAddress, district: order.district
    })) });
    if (!Array.isArray(remote?.addresses) || remote.addresses.length !== batch.length) break;
    batch.forEach(({ order, index }, i) => {
      const updated = safeOptimizedPublicAddress(order.publicAddress, remote.addresses[i], order.district);
      result[index] = { ...order, address: updated, publicAddress: updated };
    });
  }
  return result;
}

// 1. 零散微信/群聊文本自动整理成标准家教单（优先调云端免费大模型，未配置时自动启用内置规则引擎）
export async function parseMessyOrders(rawText, existingOrders = []) {
  const standardBlocks = rawText.trim().split(/\n\s*\n(?=#(?:可网课|\d+))/);
  const standardOrders = standardBlocks.map(parseFormattedOrder);
  if (standardOrders.length && standardOrders.every(Boolean)) {
    return { source: "标准家教单识别", orders: prepareDrafts(rawText, standardOrders, existingOrders) };
  }
  lastAIError = "";
  const remote = await callServerlessAI("parse_orders", { text: rawText });
  if (remote && Array.isArray(remote.orders) && remote.orders.length > 0) {
    const localDrafts = extractRawOrderDrafts(rawText);
    const safeDrafts = remote.orders.map((candidate, index) => {
      const source = localDrafts[index];
      if (!source || typeof candidate !== "object" || candidate == null) return source || {};
      const reviewed = { ...candidate };
      // 格式化助手不能把原文缺失的信息“补出来”。
      if (source.grade !== "年级待补充") reviewed.grade = source.grade;
      else reviewed.grade = "年级待补充";
      if (source.subject !== "科目待补充") reviewed.subject = source.subject;
      if (source.studentGender !== "待补充") reviewed.studentGender = source.studentGender;
      else reviewed.studentGender = "待补充";
      if (source.district !== "区域待补充") reviewed.district = source.district;
      reviewed.address = safeOptimizedPublicAddress(source.address, reviewed.address, source.district);
      reviewed.publicAddress = reviewed.address;
      if (source.currentScores !== "成绩待补充") reviewed.currentScores = source.currentScores;
      else if (!/成绩|分数|考试|基础|分\b|中等|较差|较好/.test(rawText)) reviewed.currentScores = "成绩待补充";
      if (source.weeklyFrequency !== "待协商") reviewed.weeklyFrequency = source.weeklyFrequency;
      else if (!/每周|一周|周[一二三四五六日天]|次数/.test(rawText)) reviewed.weeklyFrequency = "待协商";
      if (!/每次|一次|单次|小时/.test(rawText)) reviewed.hoursPerSession = 2;
      if (!/元|块|报价|薪资|时薪|课时费/.test(rawText)) reviewed.salaryText = source.salaryText;
      if (!/要求|老师|教师|需要|耐心|经验|天大|南开|严格/.test(rawText)) reviewed.requirements = "无特殊要求";
      if (!/试课|试讲/.test(rawText)) reviewed.trialTime = "";
      reviewed.mode = source.mode;
      reviewed.onlineAllowed = source.onlineAllowed;
      // 单号仅由用户原文或本地递增器决定，模型不能自由生成。
      reviewed.id = source.id || "";
      return reviewed;
    });
    return { source: `${remote.provider || "AI 模型"}（字段已校验）`, orders: prepareDrafts(rawText, safeDrafts, existingOrders) };
  }

  // 自建保守提取兜底：只提取原文有依据的信息，不再推测年级、成绩或每周上课次数。
  // 可随时切换 Cloudflare 的 AI API；无论模型是否可用，最后都需要管理员核对草稿。
  return {
    source: lastAIError ? `规则提取（模型未成功：${lastAIError.slice(0, 80)}）` : "规则提取（未启用模型）",
    orders: prepareDrafts(rawText, extractRawOrderDrafts(rawText), existingOrders)
  };
}

// 2. AI 简历优化与针对性自荐信生成
export async function optimizeResumeWithAI(resume, targetOrder = null) {
  const remote = await callServerlessAI("optimize_resume", { resume, targetOrder });
  if (remote) return { source: remote.provider || "AI 模型", ...remote };

  const subjectsText = (resume.subjects || []).join("、") || "数理化/英语";
  const schoolText = [resume.school, resume.major, resume.gradeLevel].filter(Boolean).join(" · ") || "重点高校在读";

  const optimizedHighlights = resume.highlights
    ? `【核心优势】${schoolText}，擅长${subjectsText}。${resume.highlights.replace(/^[，,。\s]+/, "")}，能够快速定位学生薄弱环节并制定阶梯式提分计划。`
    : `【核心优势】${schoolText}，主攻${subjectsText}方向，逻辑清晰、善于拆解高频考点与压轴题模型。`;

  const optimizedExperience = resume.experience
    ? `【教学成果与方法】${resume.experience.trim()}。授课坚持“课前诊断—课中讲练—课后错题闭环”，每节课后向家长同步学习进度与作业反馈。`
    : "【教学方法】注重夯实基础概念与思维引导，结合校内进度整理专属错题本与期中期末专项突破讲义。";

  const pitch = targetOrder
    ? `家长您好！我是${resume.name || "应聘老师"}（${schoolText}），看到【${targetOrder.title}】非常匹配我的教学方向。我擅长${subjectsText}，${resume.highlights ? resume.highlights.slice(0, 50) : "教学耐心细致、注重方法总结"}。授课时间可配合「${targetOrder.schedule}」，期待先安排一次试讲，帮孩子梳理薄弱板块！`
    : `您好，我是${resume.name || "家教老师"}（${schoolText}），擅长${subjectsText}辅导，责任心强、善于因材施教，欢迎联系沟通试讲！`;

  return {
    source: "内置简历优化模板（配置免费 AI Key 后启用大模型深度润色）",
    highlights: optimizedHighlights,
    experience: optimizedExperience,
    pitch
  };
}

// 3. AI 实时修改/更新网站配置与家教单（自然语言指令）
export async function interpretSiteCommand(commandText, currentSiteConfig, orders) {
  const remote = await callServerlessAI("site_command", {
    command: commandText,
    siteConfig: currentSiteConfig,
    orders: orders.map((o) => ({ id: o.id, title: o.title, hourlyRate: o.hourlyRate, status: o.status }))
  });
  if (remote && remote.actions) return { source: remote.provider || "AI 站点管家", ...remote };

  const actions = [];
  const summary = [];

  // 修改公告
  const noticeMatch = commandText.match(/(?:公告|通知)(?:改为|改成|换成|设为|更新为)[：:\s"“]?([^"”\n]+)/);
  if (noticeMatch) {
    actions.push({ type: "update_site", patch: { announcement: noticeMatch[1].trim() } });
    summary.push(`已将首页公告更新为：「${noticeMatch[1].trim()}」`);
  }

  // 修改站点名称
  const titleMatch = commandText.match(/(?:网站名|站点名|标题)(?:改为|改成|换成|设为)[：:\s"“]?([^"”\n]+)/);
  if (titleMatch) {
    actions.push({ type: "update_site", patch: { siteName: titleMatch[1].trim() } });
    summary.push(`已将站点标题修改为：「${titleMatch[1].trim()}」`);
  }

  // 切换主题色
  if (/绿色|翠绿|护眼|青色/.test(commandText)) {
    actions.push({ type: "update_site", patch: { theme: "emerald" } });
    summary.push("已切换为「清雅翠绿」主题");
  } else if (/橙色|暖色|温暖|活力/.test(commandText)) {
    actions.push({ type: "update_site", patch: { theme: "amber" } });
    summary.push("已切换为「温暖活力橙」主题");
  } else if (/红色|玫红|喜庆|粉/.test(commandText)) {
    actions.push({ type: "update_site", patch: { theme: "rose" } });
    summary.push("已切换为「玫红主题」");
  } else if (/蓝色|默认|靛蓝|学术/.test(commandText)) {
    actions.push({ type: "update_site", patch: { theme: "indigo" } });
    summary.push("已切换为「学术靛蓝」主题");
  }

  // 修改单号课时费或状态
  const idMatch = commandText.match(/(JJ-\d{4}-\d+|#?\d{3,4})/i);
  if (idMatch) {
    const rawId = idMatch[1].replace("#", "");
    const target = orders.find((o) => o.id.toLowerCase().includes(rawId.toLowerCase()));
    if (target) {
      const rateMatch = commandText.match(/(\d{2,3})\s*(?:元|块|\/小时)?/);
      const patch = {};
      if (/课时费|价格|薪资|改成\d+/.test(commandText) && rateMatch) {
        patch.hourlyRate = Number(rateMatch[1]);
        summary.push(`已将 ${target.id} 的课时费调整为 ¥${patch.hourlyRate}/小时`);
      }
      if (/下架|已结束|关闭/.test(commandText)) {
        patch.status = "已结束";
        summary.push(`已将 ${target.id} 状态改为「已结束」`);
      } else if (/已匹配|已满|招满/.test(commandText)) {
        patch.status = "已匹配";
        summary.push(`已将 ${target.id} 状态改为「已匹配」`);
      } else if (/重新上架|招募中|开启/.test(commandText)) {
        patch.status = "招募中";
        summary.push(`已将 ${target.id} 状态恢复为「招募中」`);
      }
      if (Object.keys(patch).length > 0) {
        actions.push({ type: "update_order", id: target.id, patch });
      }
    }
  }

  if (actions.length === 0) {
    return {
      source: "内置指令解析器",
      actions: [],
      reply: "暂未识别到具体修改指令。你可以这样说：「把公告改成寒假家教集中招募中」、「切换成温暖橙主题」、或「把 JJ-2026-101 课时费改成 180 元」。"
    };
  }

  return {
    source: "内置指令解析器（接入免费 AI Key 后支持更复杂自然语言改站）",
    actions,
    reply: summary.join("；") + "。"
  };
}
