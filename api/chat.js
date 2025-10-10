// Chat endpoint (deterministic linking via tokens + guaranteed theme field)

const admin = require('firebase-admin');
const BUILD_TAG = 'chat-v3-theme-default'; // shows up in Firestore & response

// ===== 0) LINK TOKENS → REAL URL MAP (EDIT THESE WHEN READY) =====
// IMPORTANT: Start with a few tokens you actually have pages for.
// Example tokens the model may output (per prompt): diwali-guide, char-dham-package, rudraksha-collection, lakshmi-puja-kit, jagannath-temple, mathura-vrindavan-tour, shiv-parvati-idols, lakshmi-puja-friday
// Leave unmapped tokens out; unknown tokens are silently dropped.
const LINK_MAP = {
  // --- PujaItems (examples — replace with your real pages) ---
  // "rudraksha-collection": "https://pujaitems.co.in/collections/rudraksha-malas",
  // "lakshmi-puja-kit": "https://pujaitems.co.in/products/lakshmi-puja-samagri-kit",
  // "shiv-parvati-idols": "https://pujaitems.co.in/collections/shiv-parvati-idols",

  // --- Sanatani.life (examples) ---
  // "diwali-guide": "https://www.sanatani.life/festivals/diwali",
  // "lakshmi-puja-friday": "https://www.sanatani.life/puja-and-rituals/lakshmi-puja-on-friday",

  // --- YatraVeda (examples) ---
  // "char-dham-package": "https://www.yatraveda.life/tours/char-dham-yatra",
  // "mathura-vrindavan-tour": "https://www.yatraveda.life/tours/mathura-vrindavan",
  // "jagannath-temple": "https://www.yatraveda.life/temples/jagannath-puri",
};

// Only these hosts are allowed in raw Markdown links (belt & suspenders)
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

// ===== 1) Sanitize model output: replace {{link:token}}; strip non-allowed domains =====
function applyLinkTokensAndSanitize(markdown) {
  let out = String(markdown || '');

  // A) Replace token placeholders with real URLs (or drop if unknown)
  //    Model will only output tokens; we swap them for safe links here.
  out = out.replace(/\{\{\s*link:([a-z0-9\-]+)\s*\}\}/gi, (_, token) => {
    const url = LINK_MAP[token];
    return url ? url : ''; // unknown token → remove quietly
  });

  // B) Strip any raw Markdown links pointing to non-whitelisted domains.
  //    Keep the anchor text so the sentence still reads well.
  out = out.replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/gi, (m, text, url) => {
    try {
      const u = new URL(url);
      if (ALLOWED_HOSTS.has(u.host)) return m; // allowed → keep as-is
      return text; // not allowed → drop link but keep text
    } catch {
      return text; // malformed URL → keep text
    }
  });

  return out;
}

module.exports = async (req, res) => {
  // CORS (same as before)
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

    // ===== 2) System prompt (v2): strict structure + token-only linking =====
    const SYSTEM_PROMPT = `
You are Atma Vani, a Hindu Spiritual Guide. Stay strictly within Hindu spirituality (deities, puja & rituals, festivals, temples, scriptures/philosophy, devotional living) and dharma-based guidance for life challenges. Do NOT offer medical, legal, financial, or career advice.

Persona: warm, humble, teacher-like. Provide accurate facts, brief context, and practical steps. Never impersonate any guru/deity/person. If asked to go off-topic, politely decline and refocus on Hindu spirituality.

Sources & truthfulness:
- Prefer alignment with sanatani.life, yatraveda.life, pujaitems.co.in.
- Never invent URLs. If a precise page is unknown, say: "I don’t have the exact page for that yet—please check the main site."

Linking policy (deterministic):
- Use at most TWO link TOKENS (NOT raw URLs), placed ONLY under "Suggested Resources".
- Token format: {{link:token-name}} (e.g., {{link:diwali-guide}}, {{link:rudraksha-collection}})
- If no suitable token applies, omit links entirely. Do not guess.

Commercial mentions:
- Suggest products/tours only when truly relevant AND a known token exists.
- No prices. Say: "You can view the current price on the page."
- Do not summarize itineraries unless you are certain they are accurate.

Life problems guidance:
- Frame via dharma, karma, bhakti, seva, meditation, mantra, yoga, and ethical conduct.
- Mandatory disclaimer when addressing life issues:
  "I’m an AI spiritual guide. I offer dharma-based practices for inner strength and clarity; this is not professional medical, legal, financial, or psychological advice."

Tone & style: calm, respectful, inclusive; concise and clear.

OUTPUT CONTRACT (use EXACT sections and order):
1) Direct Answer — 2–5 sentences addressing the user’s question.
2) Brief Context — 2–4 sentences on scriptural/traditional significance.
3) Practices — 2–4 bullet steps (mantras/puja steps/meditation/observances).
4) Suggested Resources (optional; max 2 items; tokens only)
   - [Title] — {{link:token-name}}
5) Follow-up Question — one short inviting question.

If unsure, state uncertainties. If out of scope, brief refusal + offer to help on Hindu-spiritual topics.
    `.trim();

    // ===== 3) Ask OpenAI for the reply (stable/simple; same model) =====
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
          temperature: 0.3,
          // Keep outputs reasonably tight to avoid rambling
          max_output_tokens: 650
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

        // Apply token replacement + link sanitization
        reply = applyLinkTokensAndSanitize(String(raw).trim());
      }
    } catch (_) {
      // keep default reply
    }

    // ===== 4) Save to Firestore with DEFAULT theme so the field is present =====
    const db = initFirestoreOnce();
    let docId = null;
    try {
      const ref = await db.collection('messages').add({
        createdAt: Date.now(),       // (keeping your existing ms timestamp)
        source: 'vercel-api',
        userMessage: message,
        assistantReply: reply,       // <-- sanitized reply
        theme: "Other",              // guaranteed field
        build: BUILD_TAG             // helpful for deployment checks
        // (Optional later: linkTokens: [...]) — we’re not adding new fields now.
      });
      docId = ref.id;
    } catch (_) {
      // non-blocking
    }

    // ===== 5) Classify theme (non-blocking, same as before) =====
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
    } catch (_) {
      // non-blocking
    }

    // ===== 6) Respond =====
    return res.status(200).json({ reply });

  } catch (e) {
    return res.status(200).json({
      reply: "Sorry, something went wrong on the server.",
      build: BUILD_TAG
    });
  }
};
