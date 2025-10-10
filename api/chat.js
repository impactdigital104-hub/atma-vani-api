// Chat endpoint + Firestore logging + Theme tagging (no streaming)
// POST JSON: { "message": "your question" }

const admin = require('firebase-admin');

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

async function classifyTheme(text) {
  const THEMES = [
    "Deities",
    "Puja & Rituals",
    "Festivals",
    "Scripture & Philosophy",
    "Life-challenges",
    "Products/Isvara",
    "Yatra Veda",
    "Other"
  ];
  const prompt = `Classify the user's question into ONE of these themes: ${THEMES.join(", ")}.
Return only the label. Question: """${text}"""`;

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: [{ role: "user", content: prompt }],
      temperature: 0,
      max_output_tokens: 10
    })
  });

  if (!r.ok) return "Other";
  const j = await r.json();
  const label = (j.output_text || "").trim();
  return THEMES.includes(label) ? label : "Other";
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST /api/chat' });
  }

  try {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Missing "message" (string).' });
    }

    const SYSTEM_PROMPT = `
You are Atma Vani, a Hindu Spiritual Guide. Stay within Hindu spirituality (deities, rituals, festivals, philosophy, devotional living) and Dharma-based guidance.
Tone: warm, respectful, teacher-like; explain with context and simple steps.
Sources: prefer Sanatani.life, PujaItems.co.in, YatraVeda.life; include deep links if known; never invent URLs. If unknown, direct to the main site.
Recommendations: suggest relevant curated products/tours only with verified links; no prices; no itineraries unless provided.
Boundaries: No medical/legal/financial/career advice. No guarantees.
Structure: 1) clear answer; 2) brief context; 3) 2–4 practices; 4) optional product/tour links; 5) end with a gentle follow-up question.
    `.trim();

    // Call OpenAI for the answer
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: message }
        ],
        temperature: 0.3
      })
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(500).json({ error: "OpenAI error", detail: errText });
    }

    const data = await resp.json();
    let reply =
      data.output_text
      || (Array.isArray(data.output)
            ? data.output.map(m =>
                Array.isArray(m.content)
                  ? m.content.map(c => c.text || "").join(" ")
                  : ""
              ).join("\n").trim()
            : "")
      || (Array.isArray(data.content) && data.content[0]?.text)
      || "Sorry, I couldn't generate a reply.";

    // Theme (non-blocking)
    let theme = "Other";
    try { theme = await classifyTheme(message); } catch (_) {}

    // Log to Firestore and report success/failure
    let logged = false, logError = null;
    try {
      const db = initFirestoreOnce();
      await db.collection('messages').add({
        createdAt: Date.now(),
        source: 'vercel-api',
        userMessage: message,
        assistantReply: reply,
        theme
      });
      logged = true;
    } catch (e) {
      logError = String(e);
    }

    return res.status(200).json({ reply, theme, logged, logError });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e) });
  }
};
