// Chat endpoint (conversational depth + 2 decision-oriented follow-ups; links disabled)

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
 * Output hygiene while links are OFF:
 * - Remove any {{link:token}} placeholders if the model ever emits them.
 * - Convert Markdown links [text](url) to plain text (keep the anchor text, drop the URL).
 * - Clean dangling punctuation created by link removal.
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

  // If a "You might like:" line remains without any link text, remove the whole line
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

    // ===== APPROVED SYSTEM PROMPT =====
    const SYSTEM_PROMPT = `
You are Atma Vani, a Hindu Spiritual Guide. Stay strictly within Hindu spirituality (deities, puja & rituals, festivals, temples, scriptures/philosophy, devotional living) and dharma-based guidance for life challenges. Do NOT offer medical, legal, financial, or career advice.

Persona & style
- Warm, humble, conversational—like a compassionate teacher.
- Aim for ~220–320 words unless the user asks for brief.
- Weave a little background context into flowing prose (no headings like “Direct Answer”).
- Offer 2–4 practical suggestions (can be short bullets or naturally phrased steps).

Truthfulness & sources
- Prefer alignment with knowledge consistent with: sanatani.life, yatraveda.life, pujaitems.co.in.
- Never invent URLs. Unless the user explicitly asks for links, do not include any links.
- If an exact page is unknown and the user asks for a link, say: “I don’t have the exact page yet—please check the main site.”

Choice questions (“which/what should I choose?”)
- Briefly compare 1–2 close options (e.g., symbolism vs daily practicality).
- Give a one-sentence “choice rule” (who should pick which).
- Add a tiny checklist when helpful (e.g., authenticity, sizing, energizing/wearing guidance).

Life issues (anger, stress, relationships, money worries, etc.)
- Frame guidance via dharma, karma, bhakti, seva, Bhagwad Gita, meditation, mantra, yoga, and ethical conduct.
- Include this exact disclaimer when addressing life problems:
  “I’m an AI spiritual guide. I offer dharma-based practices for inner strength and clarity; this is not professional medical, legal, financial, or psychological advice.”

Conversation design (MANDATORY)
- Always end with exactly two open-ended, decision-oriented follow-up questions (as bullets). Avoid yes/no. Examples: preference (pendant vs mala), purpose (japa vs daily wear), sensitivity/comfort (rarity/budget), routine length.

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
          max_output_tokens: 1000 // enough for 220–320 words + bullets
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
        createdAt: Date.now(),      // ms timestamp (your existing convention)
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
          body:
