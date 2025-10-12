// File: api/chat.js
// Contract (v1.1):
// - Single-rule gate: use /api/classify-theme; answer ONLY if label/theme = "Hinduism" with confidence ≥ 0.80
//   Otherwise refuse kindly in user's language.
// - Backward compatible: if classifier has no confidence field, allow ONLY when theme/label is exactly "Hinduism".
// - Model: OpenAI gpt-4o-mini (Responses API with Chat Completions fallback)
// - System prompt: restored Atma Vani v1.1 (PLAIN TEXT, scope, persona, two follow-ups)
// - Self-check: OK | REFUSE | REVISE (apply REVISE text if present)
// - Firestore logging + theme update preserved
// - CORS: * (MVP)

const admin = require("firebase-admin");

const {
  OPENAI_API_KEY,
  FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY,
} = process.env;

// ---- Firestore init ----
if (!admin.apps.length) {
  const creds = {
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  };
  if (creds.projectId && creds.clientEmail && creds.privateKey) {
    admin.initializeApp({ credential: admin.credential.cert(creds) });
  } else {
    console.warn("[chat] Firebase credentials missing; logging will be skipped.");
  }
}
const db = admin.apps.length ? admin.firestore() : null;

// ---- HTTP helpers ----
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function isHindi(text = "") { return /[\u0900-\u097F]/.test(String(text || "")); }

function refusalMessage(userText) {
  if (isHindi(userText)) {
    return "🙏 नमस्ते. मैं एक आध्यात्मिक मार्गदर्शक हूँ जिसे केवल हिंदू आध्यात्मिकता से संबंधित विषयों में मदद करने के लिए बनाया गया है। कृपया मंदिर, देवता, पूजा-व्रत, मंत्र-स्तोत्र, शास्त्र, त्योहार या तीर्थयात्रा से जुड़ा प्रश्न पूछें।";
  }
  return "🙏 Namaste. I’m a spiritual guide for Hindu spirituality only. Please ask about temples/deities, puja/vrat, mantras/stotras, scriptures, festivals, pilgrimages, or devotional practice.";
}

// ---- SYSTEM PROMPT (v1.1 restored) ----
const SYSTEM_HEADER = [
  "Return PLAIN TEXT only. Answer only within scope; otherwise refuse kindly."
].join(" ");

const YOUR_SYSTEM_PROMPT = `
You are **Atma Vani**, a Hindu Spiritual Guide. Stay within Hindu spirituality (deities, puja & rituals, festivals, temples, scriptures/philosophy, devotional living) and dharma-based guidance for life challenges. Do not offer medical, legal, financial, or career advice.

## Persona & style
- Warm, humble, conversational—like a compassionate teacher.
- Prioritize completeness and clarity over brevity. Up to ~500–600 words when needed; no fluff.
- If the user explicitly asks for “brief,” keep it under 180 words.

## Truthfulness & sources
- Prefer alignment with knowledge consistent with: sanatani.life, yatraveda.life, pujaitems.co.in.
- If a topic isn’t clearly covered there, answer from widely accepted Hindu tradition; state uncertainties briefly; avoid niche specifics you can’t verify.
- Do not include links unless the user explicitly asks; never invent URLs. If asked for a link and you’re unsure, say: “I don’t have the exact page yet—please check the main site.”

## Answer Pattern Selector
1) Ritual / How-to
2) Which / Choice
3) Meaning / Significance / Philosophy
4) Life-challenge (dharma-based practices; brief disclaimer)
5) Temple / Yatra
6) Festival observance
7) Product/practice usage

## Non-negotiable canon cues
- Ancestor rites: til-tarpana with black sesame, facing south, darbha if available; Mahamrityunjaya / “Om Pitr̥bhyo Namah”; naivedya + annadan; regional variation note.
- Rudraksha: one-mukhi rare; five-mukhi daily sattva/japa; six-mukhi often for Mars-type irritability.
- Shakti Peethas: lists vary; Vaishno Devi revered but not typically counted among canonical Peethas; Shakti–Bhairava pairing note.
- Jyotirlings: prefer region clusters; Kedarnath altitude/season note.

## Conversation design
- End with exactly two short, decision-oriented follow-up questions that help the user take a next devotional step.

## Self-check rubric (silent)
- Correct intent pattern; safe guidance; no links unless asked; two decision-oriented follow-ups; scope adherence.
`;

// ---- Self-check prompt ----
function selfCheckPrompt(user, draft) {
  return [
    "You are verifying a draft answer for scope, factuality, and tone.",
    "Rules:",
    "1) If the user's request is OUTSIDE Hindu spirituality scope, return: REFUSE",
    "2) If the draft has factual/safety issues, return: REVISE and provide a safer corrected answer.",
    "3) Else return: OK",
    "Return format (PLAIN TEXT, no Markdown):",
    "First line: one of OK | REFUSE | REVISE",
    "If REVISE: after a blank line, provide the corrected plain-text answer in the same language as the user.",
    "",
    "User message:",
    user,
    "",
    "Draft answer:",
    draft
  ].join("\n");
}

// ---- OpenAI calls ----
async function callOpenAIResponses(inputArray) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", input: inputArray }),
  });
  if (!r.ok) throw new Error(`Responses ${r.status}: ${await r.text().catch(()=> "")}`);
  const data = await r.json();
  const out = data?.output_text || data?.output?.[0]?.content?.[0]?.text || "";
  if (!out.trim()) throw new Error("Responses returned empty output.");
  return out;
}
async function callOpenAIChatCompletions(messages) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages }),
  });
  if (!r.ok) throw new Error(`ChatCompletions ${r.status}: ${await r.text().catch(()=> "")}`);
  const data = await r.json();
  const out = data?.choices?.[0]?.message?.content || "";
  if (!out.trim()) throw new Error("ChatCompletions returned empty output.");
  return out;
}
async function askModel(userMessage) {
  try {
    return await callOpenAIResponses([
      { role: "system", content: `${SYSTEM_HEADER}\n\n${YOUR_SYSTEM_PROMPT}` },
      { role: "user",   content: userMessage }
    ]);
  } catch (e1) {
    console.warn("[chat] Responses API failed, falling back:", e1.message);
    return await callOpenAIChatCompletions([
      { role: "system", content: `${SYSTEM_HEADER}\n\n${YOUR_SYSTEM_PROMPT}` },
      { role: "user",   content: userMessage }
    ]);
  }
}
async function selfCheck(userMessage, draftAnswer) {
  try {
    const text = await callOpenAIResponses([
      { role: "system", content: "You are a careful, concise verifier." },
      { role: "user",   content: selfCheckPrompt(userMessage, draftAnswer) }
    ]);
    const firstLine = text.split("\n")[0].trim().toUpperCase();
    const rest = text.split("\n").slice(2).join("\n").trim();
    return { verdict: firstLine, revised: rest };
  } catch (e1) {
    console.warn("[chat] Verifier Responses failed, falling back:", e1.message);
    const text = await callOpenAIChatCompletions([
      { role: "system", content: "You are a careful, concise verifier." },
      { role: "user",   content: selfCheckPrompt(userMessage, draftAnswer) }
    ]);
    const firstLine = text.split("\n")[0].trim().toUpperCase();
    const rest = text.split("\n").slice(2).join("\n").trim();
    return { verdict: firstLine, revised: rest };
  }
}

// ---- Classifier call (expects label + confidence if available) ----
async function classifyTheme(host, text) {
  try {
    const r = await fetch(`https://${host}/api/classify-theme`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!r.ok) return { theme: "Other" };
    return await r.json();
  } catch {
    return { theme: "Other" };
  }
}

// ---- Handler ----
module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.statusCode = 200; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; return res.end("Method Not Allowed"); }

  try {
    // Vercel can pass body as string or object
    let bodyObj = {};
    try {
      if (typeof req.body === "string") bodyObj = JSON.parse(req.body || "{}");
      else if (req.body && typeof req.body === "object") bodyObj = req.body;
      else bodyObj = {};
    } catch { bodyObj = {}; }

    const { message } = bodyObj;

    if (!message || typeof message !== "string") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Missing 'message'." }));
    }

    const host = req.headers.host;

    // ===== Single-rule gate =====
    // We rely solely on classifier result.
    // Allow only if label/theme is Hinduism with confidence >= 0.80.
    let allow = false;
    let cls = await classifyTheme(host, message);
    // Normalize fields for backward-compat
    const label = (cls.label || cls.theme || "").toString();
    const conf  = typeof cls.confidence === "number" ? cls.confidence : (label === "Hinduism" ? 1.0 : 0.0);

    if (label === "Hinduism" && conf >= 0.80) {
      allow = true;
    }

    if (!allow) {
      const refusal = refusalMessage(message);
      if (db) {
        await db.collection("messages").add({
          createdAt: Date.now(),
          source: "vercel-api",
          userMessage: message,
          assistantReply: refusal,
          theme: "Other",
          build: "v1.1",
        });
      }
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ reply: refusal, gate: { label, confidence: conf } }));
    }
    // ============================

    // Main answer + self-check
    const t0 = Date.now();
    const draft = await askModel(message);
    const chatMs = Date.now() - t0;

    let finalReply = draft;
    try {
      const check = await selfCheck(message, draft);
      if (check.verdict === "REFUSE") {
        finalReply = refusalMessage(message);
      } else if (check.verdict === "REVISE" && check.revised) {
        finalReply = check.revised;
      }
    } catch (e) {
      console.warn("[chat] self-check failed, using draft:", e.message);
    }

    // Log to Firestore
    let docId = null;
    if (db) {
      const ref = await db.collection("messages").add({
        createdAt: Date.now(),
        source: "vercel-api",
        userMessage: message,
        assistantReply: finalReply,
        theme: "Other", // updated below
        build: "v1.1",
        chatMs,
      });
      docId = ref.id;
    }

    // Update theme (best-effort)
    try {
      const post = await classifyTheme(host, `${message}\n---\n${finalReply}`);
      const finalTheme = post.theme || post.label || "Other";
      if (db && docId) await db.collection("messages").doc(docId).update({ theme: finalTheme });
    } catch {}

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ reply: finalReply }));
  } catch (e) {
    console.error("[chat] error:", e);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "Chat failed", details: String(e.message || e) }));
  }
};
