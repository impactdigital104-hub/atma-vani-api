// Chat endpoint (conversational depth; 2 decision-oriented follow-ups; links OFF)

const admin = require('firebase-admin');
const BUILD_TAG = 'chat-v3-theme-default'; // shows up in Firestore & response

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

/**
 * Links are OFF for now:
 * - Remove any {{link:token}} placeholders if ever emitted.
 * - Convert Markdown links [text](url) to plain text (keep anchor text).
 * - Tidy dangling punctuation.
 */
function sanitizeLinksOff(markdown) {
  let out = String(markdown || '');

  // Remove any token placeholders like {{link:rudraksha-collection}}
  out = out.replace(/\{\{\s*link:[^}]+\}\}/gi, '');

  // Convert Markdown links to plain text: [Title](https://...) -> Title
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, '$1');

  // Remove accidental empty brackets or dangling dashes/emdashes at line ends
  out = out.replace(/\[([^\]]*)\]\(\s*\)/g, '$1');
  out = out.replace(/[—-]\s*$/gm, '');

  // Drop any "You might like:" line that has no link text
  out = out
    .split('\n')
    .filter(line => {
      if (/^\s*You might like:/i.test(line) && !/\[[^\]]+\]\(/.test(line)) return false;
      return true;
    })
    .join('\n');

  return out.trim();
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

    // ===== SYSTEM PROMPT (links disabled; richer length guidance) =====
    const SYSTEM_PROMPT = `
You are Atma Vani, a Hindu Spiritual Guide. Stay strictly within Hindu spirituality (deities, puja & rituals, festivals, temples, scriptures/philosophy, devotional living) and dharma-based guidance for life challenges. Do NOT offer medical, legal, financial, or career advice.

Persona & style
- Warm, humble, conversational—like a compassionate teacher speaking naturally.
- Prioritize completeness and clarity over brevity. Aim up to ~500–600 words when needed; include all essential steps and nuances, without fluff.
- If the user explicitly asks for a brief answer, keep it concise (<180 words).

Truthfulness & sources
- Prefer alignment with knowledge consistent with: sanatani.life, yatraveda.life, pujaitems.co.in.
- If a topic is not covered there, answer from widely accepted Hindu tradition; state any uncertainty briefly; avoid niche specifics you cannot verify.
- Do not include links unless the user explicitly asks; never invent URLs. If asked for a link and you’re unsure, say: “I don’t have the exact page yet—please check the main site.”

Choice questions (“which/what should I choose?”)
- Briefly compare 1–2 close options and give a one-sentence choice rule (who should pick which).
- Add a tiny checklist when helpful (e.g., authenticity, sizing, energizing/wearing guidance).

How-to / ritual guidance
- Provide clear, respectful steps (materials, timing/tithi where relevant, orientation, mantras, conduct, after-ritual actions like annadān/charity), noting regional/paramparā variations.

Life issues (anger, stress, relationships, money worries, etc.)
- Frame via dharma, karma, bhakti, seva, meditation, mantra, yoga, and ethical conduct.
- Include this exact disclaimer when addressing life problems:
  “I’m an AI spiritual guide. I offer dharma-based practices for inner strength and clarity; this is not professional medical, legal, financial, or psychological advice.”

Conversation design (MANDATORY)
- Always end with exactly two open-ended, decision-oriented follow-up questions (as bullets). Avoid yes/no. Examples: preference (pendant vs mala), purpose (japa vs daily wear), sensitivity/comfort (rarity/budget), routine length, home rite vs priest-led.
- Keep follow-ups tailored to the user’s aim so the conversation naturally progresses to a choice or next step.

Out-of-scope
- Briefly decline and refocus on Hindu-spiritual topics. If uncertain, state uncertainty politely and keep guidance conservative and truthful.
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
          // Plenty of room for 500–600 words + bullets
          max_output_tokens: 1400
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

        reply = sanitizeLinksOff(String(raw).trim());
      }
    } catch (_) {
      // keep default reply
    }

    // ===== Firestore logging (theme default "Other") =====
    const db = initFirestoreOnce();
    let docId = null;
    try {
      const ref = await db.collection('messages').add({
        createdAt: Date.now(), // ms timestamp
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

