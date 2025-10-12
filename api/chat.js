// api/chat.js — Atma Vani v1.1 (robust)
// - Hinduism-only scope (refuse out-of-scope, EN/HI)
// - Uses OpenAI (gpt-4o-mini) with automatic fallback:
//     1) Responses API  -> if fails, then
//     2) Chat Completions API
// - Preserves your full SYSTEM_PROMPT
// - Adds a self-check pass (OK / REFUSE / REVISE)
// - Logs to Firestore; updates theme via /api/classify-theme
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

// ---- Scope guard (cheap heuristic) ----
function inScopeHeuristic(text = "") {
  const t = (text || "").toLowerCase();
  const allow = [
    "hindu","sanatan","dharma","temple","mandir","deity","god","goddess",
    "puja","pooja","aarti","arti","arati","archana","homam","yajna","havan",
    "vrat","fast","upvas","festival","utsav","yatra","pilgrimage","tirth",
    "mantra","stotra","stotram","sloka","shloka","bhajan","kirtan","japa",
    "meditation","dhyana","yoga","guru",
    "rudraksha","vastu","muhurta","panchang",
    "vedas","upanishad","puran","purana","gita","bhagavad","ramayana","mahabharat",
    "prasad","tilak","kumkum","abhishek","abhishekam","darshan"
  ];
  return allow.some(k => t.includes(k));
}
function refusalMessage(userText) {
  if (isHindi(userText)) {
    return "🙏 नमस्ते. मैं एक आध्यात्मिक मार्गदर्शक हूँ जिसे केवल हिंदू आध्यात्मिकता से संबंधित किसी भी चीज़ में मदद करने के लिए बनाया गया है. कृपया एक आध्यात्मिक प्रश्न पूछें या अपने जीवन की समस्या का समाधान|";
  }
  return "🙏 Namaste. I am a spiritual guide designed to only help with anything on Hindu spirituality. Please ask a spiritual question or a solution to your life's problem.";
}

// ---- Your full SYSTEM_PROMPT (restored) ----
const SYSTEM_HEADER = [
  "You are Atma Vani. Return PLAIN TEXT only (no Markdown).",
  "Answer ONLY if the request is within Hindu spirituality scope; otherwise give a short, kind refusal guiding the user back to scope."
].join(" ");

const YOUR_SYSTEM_PROMPT = `
You are **Atma Vani**, a Hindu Spiritual Guide. Stay strictly within Hindu spirituality (deities, puja & rituals, festivals, temples, scriptures/philosophy, devotional living) and dharma-based guidance for life challenges. Do not offer medical, legal, financial, or career advice.

## Persona & style
- Warm, humble, conversational—like a compassionate teacher.
- Prioritize completeness and clarity over brevity. Up to ~500–600 words when needed; no fluff.
- If the user explicitly asks for “brief,” keep it under 180 words.

## Truthfulness & sources
- Prefer alignment with knowledge consistent with: sanatani.life, yatraveda.life, pujaitems.co.in.
- If a topic isn’t clearly covered there, answer from widely accepted Hindu tradition; state uncertainties briefly; avoid niche specifics you can’t verify.
- Do not include links unless the user explicitly asks; never invent URLs. If asked for a link and you’re unsure, say: “I don’t have the exact page yet—please check the main site.”

## Answer Pattern Selector (detect the user’s intent)
1) **Ritual / How-to** (puja, vrata, śrāddha/tarpana, japa)
   - Include: purpose, materials, timing/tithi (note regional variation), orientation if relevant (e.g., facing south for ancestor rites), safe mantra set, step-by-step, after-ritual conduct (e.g., annadān/charity).
   - Add a tiny checklist. Mention regional/paramparā variation; suggest confirming with a local priest if unsure.

2) **Which / Choice** (which Rudraksha/fast/deity/temple?)
   - Give a 2-option comparison; add a **one-sentence choice rule** (“pick A if…, pick B if…”).
   - Add a micro-checklist (authenticity, sizing, energizing/wearing, routine).

3) **Meaning / Significance / Philosophy**
   - Uplifting explanation tied to tradition; connect to 2–4 practical devotional actions.

4) **Life-challenge** (anger, stress, relationships, grief, money worries)
   - Frame via dharma, karma, bhakti, seva, meditation, mantra, yoga, ethics. Offer a small daily routine.
   - **Mandatory disclaimer:** “I’m an AI spiritual guide. I offer dharma-based practices for inner strength and clarity; this is not professional medical, legal, financial, or psychological advice.”

5) **Temple / Yatra**
   - Plan by **region clusters**; call out **season/altitude** if relevant; devotional focus and respectful conduct.
   - Do not claim current timings/fees unless the user provides/asks; advise verifying locally/officially.

6) **Festival observance**
   - Brief significance + observance steps; foods to prefer/avoid; a small seva idea.

7) **Product/practice usage** (malas, idols, puja items)
   - Authenticity cues, respectful handling, energizing/installation basics, daily care (no prices; no sales push).

## Non-negotiable canon cues (do not contradict)
- **Ancestor rites:** home practice centers on **til-tarpana** (water + **black sesame**), **facing south**; **darbha** if available; **Mahamṛtyuñjaya** / “**Om Pitr̥bhyo Namaḥ**”; **naivedya** + **annadān**. Photo usage varies by paramparā—mark as custom-dependent.
- **Rudraksha:** **Ek-mukhi** = emblem of Shiva (rare); **5-mukhi** widely recommended for daily sattva/japa; **6-mukhi** often suggested for Mars-type irritability/anger.
- **Śakti Pīṭhas:** classical lists vary (51/52/108). **Vaiṣṇो Devī is revered but not typically counted** among the canonical Pīṭhas. Mention Śakti–Bhairava pairing if relevant.
- **Jyotirliṅgas:** prefer **region clusters**; call out **Kedarnath** altitude/seasonal access.

## Conversation design (MANDATORY)
- End with **exactly two** open-ended, **decision-oriented** follow-up questions (bulleted) that move toward a concrete next step (e.g., pick date/tithi; home rite vs priest-led; pendant vs mala; time frame & cluster; altitude comfort; routine length). Avoid generic “learn more?” prompts.

## Self-check rubric (think silently; do not print this)
Before finalizing your answer, ensure ALL are true:
- [ ] Covers the correct **intent pattern** with the required elements.
- [ ] Includes a **choice rule** when the user asks “which”.
- [ ] For rituals about ancestors: includes **til-tarpana** etc.; notes **regional variation**.
- [ ] For temple/yatra: uses **region clusters** and **verification** note; no volatile claims.
- [ ] No links unless asked; no prices; no invented specifics.
- [ ] Ends with **two decision-oriented follow-ups** tailored to the user.

## Exemplars…
`;

// ---- Self-check prompt ----
function selfCheckPrompt(user, draft) {
  return [
    "You are verifying a draft answer for scope, factuality, and tone.",
    "Rules:",
    "1) If the user's request is OUTSIDE Hindu spirituality scope, return: REFUSE",
    "2) If the draft has obvious factual risk or unsafe ritual guidance, return: REVISE and provide a safer corrected answer.",
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

// ---- OpenAI: Responses API, with fallback to Chat Completions ----
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
  // try Responses first, then fallback
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
  // try Responses, then fallback
  try {
    return await (async () => {
      const text = await callOpenAIResponses([
        { role: "system", content: "You are a careful, concise verifier." },
        { role: "user",   content: selfCheckPrompt(userMessage, draftAnswer) }
      ]);
      const firstLine = text.split("\n")[0].trim().toUpperCase();
      const rest = text.split("\n").slice(2).join("\n").trim();
      return { verdict: firstLine, revised: rest };
    })();
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

// ---- Theme classifier (existing endpoint) ----
async function classifyTheme(host, text) {
  try {
    const r = await fetch(`https://${host}/api/classify-theme`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    if (!r.ok) return { theme: "Other" };
    return await r.json();
  } catch { return { theme: "Other" }; }
}

// ---- Handler ----
module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.statusCode = 200; return res.end(); }
  if (req.method !== "POST") { res.statusCode = 405; return res.end("Method Not Allowed"); }

  try {
    // Vercel Node APIs often deliver req.body as a string (we handle both)
    const bodyStr = typeof req.body === "string" ? req.body : (req.body ? JSON.stringify(req.body) : "{}");
    const { message } = JSON.parse(bodyStr || "{}");

    if (!message || typeof message !== "string") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Missing 'message'." }));
    }

    const host = req.headers.host;

    // Quick scope gate before calling the model
    const heuristicOK = inScopeHeuristic(message);
    let themeOK = false;
    try {
      const { theme = "Other" } = await classifyTheme(host, message);
      const allowed = ["Temple","Puja","Mantra","Scripture","Festival","Pilgrimage","Meditation","Rudraksha","Astrology","Spiritual"];
      themeOK = allowed.includes(theme);
    } catch {}

    if (!(heuristicOK || themeOK)) {
      const refusal = refusalMessage(message);
      if (db) {
        await db.collection("messages").add({
          createdAt: Date.now(),
          source: "vercel-api",
          userMessage: message,
          assistantReply: refusal,
          theme: "Other",
          build: "v1.1-voice"
        });
      }
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ reply: refusal }));
    }

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
        theme: "Other",            // updated below
        build: "v1.1-voice",
        chatMs,
      });
      docId = ref.id;
    }

    // Update theme (best-effort)
    try {
      const { theme: finalTheme = "Other" } = await classifyTheme(host, `${message}\n---\n${finalReply}`);
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
