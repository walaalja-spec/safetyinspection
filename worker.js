// ---------------------------------------------------------------------
// src/worker.js
// Cloudflare Workers entry point. Since this project is a "Workers with
// static assets" project (not classic Pages), everything routes through
// this one script: static files (index.html, app.js, etc.) are served
// via the ASSETS binding, and POST /analyze is handled here directly.
//
// Required setup (once, in the Cloudflare dashboard):
//   Your project → Settings → Variables and Secrets → Add
//     Name:  OPENAI_API_KEY
//     Value: <your OpenAI key>
//     Type:  Secret
// ---------------------------------------------------------------------

const SYSTEM_PROMPT = `أنت مساعد يحلل ملاحظات تفتيش الصحة والسلامة المهنية في المدارس.

مهمتك: تحويل نص مسموع (وصورة اختيارية) إلى ملاحظة منظمة، دون تغيير المعنى الأصلي الذي ذكره المستخدم.

التصنيفات المتاحة (اختر الأنسب):
كهرباء، حريق، مخارج طوارئ، سلامة المبنى، الأرضيات، الأبواب والنوافذ، النظافة، المواد الكيميائية، معدات السلامة، الإسعافات الأولية، التمديدات، المخاطر العامة، أخرى

مستوى الخطورة (اختر واحد فقط): منخفضة، متوسطة، عالية، حرجة
الأولوية (اختر واحدة فقط): عادية، متوسطة، عالية، عاجلة

قواعد صارمة:
1. لا تخترع تفاصيل غير مذكورة في النص أو غير ظاهرة بوضوح في الصورة.
2. إذا وُجد تعارض بين كلام المستخدم والصورة، أو كانت الصورة لا تؤكد ما قاله المستخدم بوضوح، استخدم صياغة حذرة مثل "ذكر المستخدم ... بينما لا يمكن التحقق من ذلك بوضوح من الصورة" بدل الجزم.
3. مستوى الخطورة والأولوية هما اقتراح أولي فقط، والمستخدم سيراجعهما ويستطيع تعديلهما.
4. أعد الإجابة بصيغة JSON فقط، بدون أي نص إضافي قبله أو بعده، وبالضبط بهذا الشكل:
{
  "category": "",
  "description": "",
  "riskLevel": "",
  "recommendedAction": "",
  "priority": "",
  "visualObservation": "",
  "confidence": 0
}

"visualObservation" يصف فقط ما تراه في الصورة (فراغ "" إذا لا توجد صورة).
"confidence" رقم من 0 إلى 1 يعكس مدى وضوح الملاحظة ودعم الأدلة لها.`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/analyze" && request.method === "POST") {
      return handleAnalyze(request, env);
    }

    // Everything else (index.html, app.js, style.css, ...) is served
    // straight from the static assets bound to this Worker.
    return env.ASSETS.fetch(request);
  }
};

async function handleAnalyze(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "bad_request" }, 400);
  }

  const text = (body.text || "").trim();
  const imageBase64 = body.imageBase64 || null;

  if (!text && !imageBase64) {
    return jsonResponse({ error: "no_input" }, 400);
  }

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "missing_key" }, 500);
  }

  const userContent = [];
  userContent.push({
    type: "text",
    text: text
      ? `نص الملاحظة كما ذكره المستخدم صوتيًا:\n"${text}"`
      : "لا يوجد نص صوتي، اعتمد فقط على الصورة المرفقة."
  });
  if (imageBase64) {
    userContent.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
    });
  }

  let aiResponse;
  try {
    aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent }
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 700
      })
    });
  } catch (e) {
    return jsonResponse({ error: "network_error" }, 502);
  }

  if (!aiResponse.ok) {
    const errText = await aiResponse.text().catch(() => "");
    console.error("OpenAI API error:", aiResponse.status, errText);
    let detail = "";
    try {
      const errJson = JSON.parse(errText);
      detail = (errJson.error && errJson.error.message) || "";
    } catch (e) {
      detail = errText.slice(0, 200);
    }
    return jsonResponse({ error: "ai_failed", status: aiResponse.status, detail }, 502);
  }

  let data;
  try {
    data = await aiResponse.json();
  } catch (e) {
    return jsonResponse({ error: "ai_failed" }, 502);
  }

  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) {
    return jsonResponse({ error: "ai_failed" }, 502);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return jsonResponse({ error: "invalid_json" }, 502);
  }

  const requiredFields = ["category", "description", "riskLevel", "recommendedAction", "priority"];
  for (const field of requiredFields) {
    if (typeof parsed[field] !== "string" || !parsed[field]) {
      return jsonResponse({ error: "invalid_schema" }, 502);
    }
  }

  return jsonResponse({
    category: parsed.category,
    description: parsed.description,
    riskLevel: parsed.riskLevel,
    recommendedAction: parsed.recommendedAction,
    priority: parsed.priority,
    visualObservation: parsed.visualObservation || "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null
  });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
