// Chat endpoint (conversational depth + strong follow-ups; links optional)

const admin = require('firebase-admin');
const BUILD_TAG = 'chat-v3-theme-default'; // shows up in Firestore & response

// ===== LINK TOKENS → REAL URL MAP (leave empty for now) =====
// When you’re ready, add tokens here. If empty, the model will omit the
// "You might like:" line (per prompt + sanitizer below).
const LINK_MAP = {
  // e.g. "rudraksha-collection": "https://pujaitems.co.in/collections/rudraksha-malas",
};

// Allowed hosts (belt & suspenders if any raw links appear)
const ALLOWED_HOSTS = new Set([
  'pujaitems.co.in',
  'www.sanatani.life', 'sanatani.life',
  'www.yatraveda.life', 'yatraveda.life',
]);

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

// Replace {{link:token}}; keep only whitelisted domains; tidy blanks
function applyLinkTokensAndSanitize(markdown) {
  let out = String(markdown || '');

  // A) Replace token placeholders with real URLs (or drop if unknown)
  out = out.replace(/\{\{\s*link:([a-z0-9\-]+)\s*\}\}/gi, (_, token) => {
    const url = LINK_MAP[token];
    return url ? url : ''; // unknown token → remove quietly
  });

  // B) Strip any raw Markdown links pointing to non-whitelisted domains.
  out = out.replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/gi, (m, text, url) => {
    try {
      const u = new URL(url);
      if (ALLOWED_HOSTS.has(u.host)) return m; // allowed
      return text; // not allowed → keep anchor text only
    } catch {
      return text; // malformed URL → keep text
    }
  });

  // C) If a link ended up with empty URL "[]()", replace with just the text.
  out = out.replace(/\[([^\]]+)\]\(\s*\)/g, '$1');

  // D) Remove dangling “—” at line end (caused by dropped tokens)
  out = out.replace(/—\s*$/gm, '');

  // E) If a "You might like:" line has no [text](url), drop that line
  out = out.split('\n').filter(line => {
    if (/^\s*You might like:/i.test(line) && !/\[.+?\]\(/.test(line)) return false;
    return true;
  }).join('\n');

  return out;
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

    // ===== Conversation-first system prompt (deeper guidance + 2 goal-oriented follow-ups) =====
    const SYSTEM_PROMPT = `
You are Atma Vani, a Hindu Spiritual Guide. Stay strictly within Hindu spirituality (deities, puja & rituals, festivals, temples, scriptures/philosophy, devotional living) and dharma-based guidance for life challenges. Do NOT offer medical, legal, financial, or career advice.

Style & depth:
- Speak as a warm, compassionate teacher in natural conversation.
- Aim for about 220–320 words unless the user asks for brief.
- Give helpful nuance: when users ask “which/what/should I choose?”, compare common options (e.g., symbolism vs. practicality, sacred ideals vs. daily wear) and offer a tiny checklist (authenticity, sizing, usage).
- Offer 2–4 practical suggestions woven into the prose or as short bullets.

Truthfulness & sources:
- Prefer alignment with sanatani.life, yatraveda.life, pujaitems.co.in.
- Never invent URLs. If an exact page is unknown, say: “I don’t have the exact page for that yet—please check the main site.”

Links (optional, only if certain):
- Include at most ONE soft line at the very end starting with “You might like:” followed by up to TWO Markdown links.
- Use TOKENS as link URLs (e.g., [Rudraksha Collection]({{link:rudraksha-collection}})). If no suitable token exists, OMIT the line entirely.
- Do not show raw URLs or domains in the body.

Life issues:
- Frame via dharma, karma, bhakti, seva, meditation, mantra, yoga, and ethical conduct.
- If addressing a life problem, include this line: “I’m an AI spiritual guide… not professional medical, legal, financial, or psychological advice.”

Conversation design (MANDATORY):
- Always end with exactly two open-ended, goal-oriented follow-up questions (bulleted), tailored to the user’s aim (e.g., wear vs japa; budget/rarity comfort; preferred deity practice; travel intent).
- Avoid yes/no prompts; start with verbs (“Would you like to explore…”, “Which option fits your practice…”, “Shall we plan…”).

If out of scope, briefly decline and refocus on Hindu-spiritual topics. If uncertain, state the uncertainty. Keep answers kind, clear, and human.
    `.trim();

    // ===== OpenAI call =====
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
          temperature: 0.35,
          max_output_tokens: 1000 // allow fuller, natural replies
        })
      });
      if (r.ok) {
        const data = await r.json();
        const raw =
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

        reply = applyLinkTokensAndSanitize(String(raw).trim());
      }
    } catch (_) {
      // keep default reply
    }

    // ===== Firestore logging (theme default "Other") =====
    const db = initFirestoreOnce();
    let docId = null;
    try {
      const ref = await db.collection('messages').add({
        createdAt: Date.now(),
        source: 'vercel-api',
        userMessage: message,
        assistantReply: reply,
        theme: "Other",
        build: BUILD_TAG
      });
      docId = ref.id;
    } catch (_) {}

    // ===== Theme classification (non-blocking) =====
    try {
      if (docId) {
        const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || process.env.VERCEL_URL || "";
        const proto = (req.headers && req.headers['x-forwarded-proto']) || 'https';
        const origin = `${proto}://${String(host).replace(/^https?:\/\//, '')}`;
        const classifyRes = await fetch(`${origin}/api/classify-theme`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message })
        });
        if (classifyRes.ok) {
          const { theme } = await classifyRes.json();
          if (theme && typeof theme === 'string') {
            await db.collection('messages').doc(docId).update({ theme });
          }
        }
      }
    } catch (_) {}

    // ===== Response =====
    return res.status(200).json({ reply });

  } catch (e) {
    return res.status(200).json({
      reply: "Sorry, something went wrong on the server.",
      build: BUILD_TAG
    });
  }
};
