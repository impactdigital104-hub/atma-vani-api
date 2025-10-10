// Chat endpoint (with build tag + guaranteed theme field)

const admin = require('firebase-admin');
const BUILD_TAG = 'chat-v3-theme-default'; // <- shows up in Firestore & response

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

    const SYSTEM_PROMPT = `
You are Atma Vani, a Hindu Spiritual Guide. Stay within Hindu spirituality (deities, rituals, festivals, philosophy, devotional living) and Dharma-based guidance.
Tone: warm, respectful, teacher-like; explain with context and simple steps.
Sources: prefer Sanatani.life, PujaItems.co.in, YatraVeda.life; include deep links if known; never invent URLs. If unknown, direct to the main site.
Recommendations: suggest relevant curated products/tours only with verified links; no prices; no itineraries unless provided.
Boundaries: No medical/legal/financial/career advice. No guarantees.
Structure: 1) clear answer; 2) brief context; 3) 2–4 practices; 4) optional product/tour links; 5) end with a gentle follow-up question.
    `.trim();

    // 1) Ask OpenAI for the reply (stable/simple)
    let reply = "Sorry, I couldn't generate a reply.";
    try {
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
      if (r.ok) {
        const data = await r.json();
        reply =
          data.output_text
          || (Array.isArray(data.output)
                ? data.output.map(m =>
                    Array.isArray(m.content)
                      ? m.content.map(c => c.text || "").join(" ")
                      : ""
                  ).join("\n").trim()
                : "")
          || (Array.isArray(data.content) && data.content[0]?.text)
          || reply;
      }
    } catch (_) {}

    // 2) Save to Firestore with DEFAULT theme so the field is present
    const db = initFirestoreOnce();
    let docId = null;
    try {
      const ref = await db.collection('messages').add({
        createdAt: Date.now(),
        source: 'vercel-api',
        userMessage: message,
        assistantReply: reply,
        theme: "Other",           // <= guaranteed field
        build: BUILD_TAG          // <= for us to confirm deployment
      });
      docId = ref.id;
    } catch (_) {}

    // 3) Try to classify and update (non-blocking)
    let classifiedTheme = null;
    try {
      if (docId) {
        const host = (req.headers && req.headers.host) || process.env.VERCEL_URL || "";
        const origin = `https://${String(host).replace(/^https?:\/\//, '')}`;
        const classifyRes = await fetch(`${origin}/api/classify-theme`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message })
        });
        if (classifyRes.ok) {
          const { theme } = await classifyRes.json();
          if (theme && typeof theme === 'string') {
            classifiedTheme = theme;
            await db.collection('messages').doc(docId).update({ theme });
          }
        }
      }
    } catch (_) {}

    // 4) Respond with a tiny debug payload
   return res.status(200).json({ reply });

  } catch (e) {
    return res.status(200).json({ reply: "Sorry, something went wrong on the server.", build: BUILD_TAG });
  }
};
