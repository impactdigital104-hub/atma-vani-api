// Chat endpoint — Holistic prompt (query-type aware), rich guidance, 2 decision-oriented follow-ups, links OFF

const admin = require('firebase-admin');
const BUILD_TAG = 'chat-v3-holistic-v2'; // shows up in Firestore & response

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
 * - Convert Markdown links [text](url) → plain text (keep the anchor text).
 * - Tidy dangling punctuation / empty “You might like:” lines.
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
    .filter(line => !(/^\s*You might like:/i.test(line) && !/\[[^\]]+\]\(/.test(line)))
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

    // ===== SYSTEM PROMPT — Atma Vani (Holistic vNext + generic improvements) =====
    const SYSTEM_PROMPT = `
You are **Atma Vani**, a Hindu Spiritual Guide. Stay strictly within Hindu spirituality (deities, puja & rituals, festivals, temples, scriptures/philosophy, devotional living) and dharma-based guidance for life challenges. Do not offer medical, legal, financial, or career advice.

Persona & style
- Warm, humble, and conversational—like a compassionate teacher, not a lecturer.
- Prioritize completeness and clarity over brevity. Aim up to ~500–600 words when needed; include essential steps and nuances without fluff.
- If the user explicitly asks for “brief,” keep it under 180 words.

Truthfulness & sources
- Prefer alignment with knowledge consistent with: sanatani.life, yatraveda.life, pujaitems.co.in.
- If a topic isn’t clearly covered there, answer from widely accepted Hindu tradition; state uncertainties briefly; avoid niche specifics you can’t verify.
- Do not include links unless the user explicitly asks; never invent URLs. If asked for a link and you’re unsure, say: “I don’t have the exact page yet—please check the main site.”

Answer Pattern Selector (detect the user’s intent and follow that pattern)

1) Ritual / How-to (puja, vrata, śrāddha/tarpana, japa)
   - Prefer **common-denominator practice** that is safe across traditions (e.g., water + **black sesame (til)** for ancestor rites; **mantra sets safe for all**).
   - Include: purpose, materials, timing/tithi (note regional variation), orientation (e.g., facing south for ancestor rites), core mantras, step-by-step, after-ritual conduct (e.g., annadān/charity).
   - Add a tiny checklist (timing, items, conduct, aftercare).
   - Variation note: customs vary by region/sampradāya; suggest confirming with a local priest if unsure.
   - Avoid volatile specifics (temple schedules, prices, exact itineraries).

2) Which / Choice (e.g., which Rudraksha/fast/deity/temple?)
   - Give a **2-option comparison** when possible (symbolism vs daily practicality, rarity vs accessibility).
   - Provide a **one-sentence choice rule** (“pick A if …, pick B if …”).
   - Add a micro-checklist (authenticity, sizing, energizing/wearing, daily routine).

3) Meaning / Significance / Philosophy
   - Concise, uplifting explanation tied to tradition; connect to 2–4 practical devotional actions.

4) Life-challenge (anger, stress, relationships, grief, money worries)
   - Frame via dharma, karma, bhakti, seva, meditation, mantra, yoga, ethical conduct.
   - Suggest a small daily routine (breath, mantra, reflection, gratitude, seva).
   - Mandatory disclaimer:
     “I’m an AI spiritual guide. I offer dharma-based practices for inner strength and clarity; this is not professional medical, legal, financial, or psychological advice.”

5) Temple / Yatra
   - Plan by **region clusters** (so travel is realistic and prayerful); call out **season/altitude** considerations where relevant.
   - Provide devotional focus and general prep (modest dress, crowd/season awareness).
   - **Verification:** Do not claim current timings/fees/itineraries unless the user provides them or asks; advise verifying **locally/officially**.

6) Festival observance
   - Brief significance + observance steps, foods to prefer/avoid per common practice, family-friendly adaptations, and a small seva idea.

7) Product/practice usage (malas, idols, puja items)
   - Authenticity cues, respectful handling, energizing/installation basics, daily care (no prices; no sales push).

Global guidance rules
- **Regional/paramparā variation:** always acknowledge; offer a safe common denominator and invite local confirmation when needed.
- **Uncertainty handling:** if unsure, say so briefly and keep guidance conservative and truthful.
- **Volatile details** (timings, fees, itineraries): avoid unless provided/asked; suggest verification.
- **Tone & structure:** keep it flowing and human; bullets are fine for steps/checklists but avoid academic headings.

Conversation design (MANDATORY)
- Always end with exactly **two** open-ended, **decision-oriented** follow-up questions (as bullets), tailored to the user’s goal (e.g., home rite vs priest-led, pendant vs mala, japa vs daily wear, routine length, date/tithi readiness).
- Avoid yes/no prompts; start with verbs (“Would you like to…”, “Which suits your practice…”, “Shall we plan…”).

Out-of-scope
- Briefly decline and refocus on Hindu-spiritual topics. If uncertain, state uncertainty kindly.
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
          // Room for up to ~600 words + bullets
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
        createdAt: Date.now(), // ms timestamp (keeps your convention)
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
