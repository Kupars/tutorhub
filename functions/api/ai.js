// Cloudflare Pages Function: /api/ai
// 支持完全免费的 AI 模型接口（Key 仅保存在 Cloudflare 环境变量，绝不暴露到前端）：
// 1) 智谱 BigModel 免费模型 glm-4-flash 或 硅基流动 / DeepSeek 等 OpenAI 兼容接口（OPENAI_API_KEY + OPENAI_BASE_URL + OPENAI_MODEL）
// 2) Google AI Studio 免费层 Gemini API（GEMINI_API_KEY）

export async function onRequestPost(context) {
  const { request, env } = context;
  try {
    const { action, payload } = await request.json();
    const prompt = buildPrompt(action, payload);
    if (!prompt) {
      return jsonResp({ ok: false, error: "Unsupported action" }, 400);
    }

    let rawText = "";
    let provider = "";

    if (env.OPENAI_API_KEY) {
      const baseUrl = (env.OPENAI_BASE_URL || "https://open.bigmodel.cn/api/paas/v4").replace(/\/$/, "");
      const model = env.OPENAI_MODEL || "glm-4-flash";
      provider = `OpenAI 兼容模型 (${model})`;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: "system", content: "你是专业的家教教务与网站运营助手。请严格只返回合法的 JSON，不要包含 Markdown 代码块标记。" },
            { role: "user", content: prompt }
          ]
        })
      });
      const data = await res.json();
      rawText = data?.choices?.[0]?.message?.content || "";
    } else if (env.GEMINI_API_KEY) {
      const model = env.GEMINI_MODEL || "gemini-2.5-flash";
      provider = `Google Gemini (${model})`;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `请严格只返回合法的 JSON，不要输出多余文字。\n\n${prompt}` }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
        })
      });
      const data = await res.json();
      rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } else {
      return jsonResp({ ok: false, error: "未配置免费 AI API Key，已自动回退本地引擎" }, 200);
    }

    const cleaned = rawText.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const parsed = JSON.parse(cleaned);
    return jsonResp({ ok: true, result: { ...parsed, provider } }, 200);
  } catch (err) {
    return jsonResp({ ok: false, error: String(err?.message || err) }, 500);
  }
}

function buildPrompt(action, payload) {
  if (action === "parse_orders") {
    return `将以下零散家教招募文本整理为 JSON 对象 {"orders":[...]}。每条包含字段：id(如JJ-2026-888), title, subject, grade, mode(上门/线上/均可), district, address, hourlyRate(数字), hoursPerSession(数字), sessionsPerWeek(数字), schedule, genderPref, studentInfo, requirements, tags(字符串数组), status("招募中"), urgent(布尔), createdAt(ISO时间)。\n\n原始文本：\n${payload.text}`;
  }
  if (action === "optimize_resume") {
    return `请根据老师简历与目标家教单（如有），优化简历并返回 JSON：{"highlights":"优化后的成绩与核心亮点","experience":"优化后的教学经历与方法","pitch":"针对该家教单发给家长的120字以内高转化自荐语"}。\n\n简历：${JSON.stringify(payload.resume)}\n目标单：${JSON.stringify(payload.targetOrder || null)}`;
  }
  if (action === "site_command") {
    return `管理员发出了自然语言改站指令，请解析为 JSON：{"reply":"简短执行反馈","actions":[{"type":"update_site","patch":{"siteName?":"","announcement?":"","theme?":"indigo|emerald|amber|rose"}},{"type":"update_order","id":"单号","patch":{"hourlyRate?":160,"status?":"招募中|已匹配|已结束"}}]}。只输出需要执行的 action。\n\n指令：${payload.command}\n当前配置：${JSON.stringify(payload.siteConfig)}\n现有单号列表：${JSON.stringify(payload.orders)}`;
  }
  return "";
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
