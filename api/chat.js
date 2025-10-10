// Minimal chat endpoint (no themes). Returns { reply } and logs to Firestore.

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

module.exports = async (req, res) => {
  // CORS (simple)
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

    // --- System prompt (same as when it worked) ---
    const SYSTEM_PROMPT = `
You are Atma Vani, a Hindu Spiritual Guide. Stay within Hindu spirituality (deities, rituals, festivals, philosophy, devotional living) and Dharma-based guidance.
Tone: warm, respectful, teacher-like; explain with context and simple steps.
Sources: prefer Sanatani.life, PujaItems.co.in, YatraVeda.life; include deep links if known; never invent URLs. If unknown, direct to the main site.
Recommendations: suggest relevant curated products/tours only with verified links; no prices; no itineraries unless provided.
Boundaries: No medical/legal/financial/career advice. No guarantees.
Structure: 1) clear answer; 2) brief context; 3) 2–4 practices; 4) optional product/tour links; 5) end with a gentle follow-up question.
    `.trim();

    // --- Call OpenAI Responses API (simple) ---
    const r = await fetch("https://api.openai.com/v1/responses", {
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

    if (!r.ok) {
      const errText = await r.text(); // keep for debugging if needed
      return res.status(200).json({ reply: "Sorry, I couldn't generate a reply right now." });
    }

    const data = await r.json();

    // --- Robust text extraction ---
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

    // --- Log to Firestore (best-effort; ignore errors) ---
    try {
      const db = initFirestoreOnce();
      await db.collection('messages').add({
        createdAt: Date.now(),
        source: 'vercel-api',
        userMessage: message,
        assistantReply: reply
      });
    } catch (_){}

    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(200).json({ reply: "Sorry, something went wrong on the server." });
  }
};
