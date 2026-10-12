const GEMINI_MODEL = "gemini-3.8-flash";
const MAX_HISTORY = 12;

function makeResponse(text, history = [], endSession = false) {
  return {
    version: "1.0",
    response: {
      text: String(text).slice(0, 1024),
      end_session: endSession
    },
    session_state: { history }
  };
}

function getHistory(body) {
  const state = body.state?.session || body.session_state || {};
  return Array.isArray(state.history)
    ? state.history.slice(-MAX_HISTORY)
    : [];
}

function getUserText(body) {
  return String(
    body.request?.original_utterance ||
    body.request?.command ||
    ""
  ).trim();
}

function wantsSearch(text) {
  return /сегодня|сейчас|последн|новост|погода|курс валют|цена сейчас|актуальн|кто сейчас|найди в интернете|поищи в интернете/i.test(text);
}

async function searchWeb(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return "";

  const r = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      q: query,
      gl: "ru",
      hl: "ru",
      num: 5
    }),
    signal: AbortSignal.timeout(7000)
  });

  if (!r.ok) {
    throw new Error(`Serper returned ${r.status}`);
  }

  const data = await r.json();

  return (data.organic || [])
    .slice(0, 5)
    .map((item, i) =>
      `${i + 1}. ${item.title}: ${item.snippet || ""} (${item.link || ""})`
    )
    .join("\n");
}

async function askGemini(text, history, searchContext) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const contents = history.map((message) => ({
    role: message.role === "model" ? "model" : "user",
    parts: [{ text: String(message.text || "") }]
  }));

  const prompt = [
   "Ты — Джарвис, интеллектуальный помощник в духе ИИ из фильма «Железный человек». Говори на русском языке спокойно, уверенно, интеллигентно и лаконично. Используй точные формулировки, лёгкую сухую иронию и профессиональный тон. Сначала сообщай главное, затем краткое пояснение. Не изображай эмоции чрезмерно, не используй эмодзи и длинные вступления. Обращайся к пользователю уважительно. Не утверждай, что управляешь системами или устройствами, если такой функции действительно нет.",
    searchContext
      ? "Используй следующие результаты поиска как справочную информацию. Они могут быть неточными:\n" + searchContext
      : "",
    "Запрос пользователя: " + text
  ].filter(Boolean).join("\n\n");

  contents.push({
    role: "user",
    parts: [{ text: prompt }]
  });

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 350
      }
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!r.ok) {
    const details = await r.text();
    console.error("Gemini error:", r.status, details.slice(0, 500));
    throw new Error(`Gemini returned ${r.status}`);
  }

  const data = await r.json();

  const answer = (data.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();

  return answer || "Не удалось подготовить ответ. Попробуй спросить иначе.";
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // Проверка доступности webhook
  if (req.method === "GET") {
    return res.status(200).json({
      status: "ok",
      service: "alice-gemini-serper",
      webhook: "/api"
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const body = req.body || {};
  const text = getUserText(body);
  const history = getHistory(body);

  if (!text) {
    return res.status(200).json(
      makeResponse("Привет! Что хочешь узнать?", history)
    );
  }

  try {
    let searchContext = "";

    if (wantsSearch(text) && process.env.SERPER_API_KEY) {
      try {
        searchContext = await searchWeb(text);
      } catch (error) {
        console.error("Search failed:", error.message);
        // Если поиск недоступен, всё равно попробуем ответить через Gemini.
      }
    }

    const answer = await askGemini(text, history, searchContext);

    const nextHistory = [
      ...history,
      { role: "user", text },
      { role: "model", text: answer }
    ].slice(-MAX_HISTORY);

    return res.status(200).json(
      makeResponse(answer, nextHistory)
    );
  } catch (error) {
    console.error("Webhook failed:", error.message);

    return res.status(200).json(
      makeResponse(
        "Извини, сейчас не получается получить ответ. Попробуй немного позже.",
        history
      )
    );
  }
};
