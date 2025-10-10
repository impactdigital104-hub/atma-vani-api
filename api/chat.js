// Chat endpoint: single OpenAI call returns { reply, theme }.
// Logs every Q/A to Firestore with the theme. API response to the browser is { reply } only.

const admin = require('firebase-admin');

// ---- Firestore init (once) ----
function initFirestoreOnce() {
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return admin.firestore();
}

// ---- Theme taxonomy ----
const THEMES = [
  "Deities",
  "Puja & Rituals",
  "Festivals",
  "Scripture & Philosophy",
  "Life-challenges",
  "Products/Isvara",
  "Yatra Veda",
  "Astrology",
  "Temples",
  "Other"
];

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST /api/chat' });

  try {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Missing "message" (string).' });
    }

    const system = `
You are Atma Vani, a Hindu Spiritual Guide. Stay within Hindu spirituality (deities, rituals, festivals, philosophy, devotional living) and Dharma-based guidance.
Tone: warm, respectful, teacher-like; explain with context and simple steps.
Sources: prefer Sanatani.life, PujaItems.co.in, YatraVeda.life; include deep links if known; never invent URLs. If unknown, direct to the main site.
Recommendations: suggest relevant curated products/tours only with verified links; no prices; no itineraries unless provided.
Boundaries: No medical/legal/financial/career advice. No guarantees.
Structure: 1) clear answer; 2) brief context; 3) 2–4 practices; 4) optional product/tour links; 5) end with a gentle follow-up question.
`.trim();

    const toolPrompt = `
Return ONLY a JSON object with exactly these keys: "reply" and "theme".
- "reply": your best answer text to the user's question.
- "theme": EXACTLY ONE label from this list: ${THEMES.join(", ")}.
No code fences or extra text.
User question: """${message}"""
`.trim();

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: system },
          { role: "user", content: toolPrompt }
        ],
        temperature: 0.3,
        max_output_tokens: 600,
        // Correct way to force JSON in the Responses API
        text: { format: "json" }
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(200).json({ reply: `Sorry, I couldn't generate a reply. (Upstream error)` });
    }

    const j = await r.json();

    // ---- Robustly extract the raw text the Responses API produced ----
    let raw =
      j.output_text ||
      (Array.isArray(j.output)
        ? j.output
            .map(m =>
              Array.isArray(m.content)
                ? m.content.map(c => c.text || "").join(" ")
                : ""
            )
            .join("\n")
            .trim()
        : "") ||
      (Array.isArray(j.content) && j.content[0]?.text) ||
      "";

    // ---- Parse { reply, theme } with safe fallback ----
    let reply = "Sorry, I couldn't generate a reply.";
    let theme = "Other";
    try {
      if (raw && typeof raw === "string") {
        const obj = JSON.parse(raw);
        if (obj && typeof obj.reply === "string") reply = obj.reply;
        if (obj && typeof obj.theme === "string" && THEMES.includes(obj.theme)) {
          theme = obj.theme;
        }
      }
    } catch {
      // If model didn't return valid JSON despite the hint, fall back to raw text
      if (raw) reply = raw;
    }

    // ---- Log to Firestore (best-effort) ----
    try {
      const db = initFirestoreOnce();
      await db.collection('messages').add({
        createdAt: Date.now(),
        source: 'vercel-api',
        userMessage: message,
        assistantReply: reply,
        theme
      });
    } catch {
      // swallow logging errors
    }

    return res.status(200).json({ reply });
  } catch (e) {
    // Always return JSON so the browser never tries to parse HTML
    return res.status(200).json({ reply: "Sorry, something went wrong on the server." });
  }
};
