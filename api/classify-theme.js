// File: api/classify-theme.js
// Purpose: Classify a user message into Hinduism vs Other with a confidence score,
// while preserving the existing theme output.
//
// Backward compatible output (always):
//   { theme: "<one of THEMES>", label: "Hinduism" | "Other", confidence: 0..1 }
//
// Notes:
// - Your existing keyword RULES are preserved.
// - If a keyword rule hits, we return theme=<matched theme>, label="Hinduism", confidence=0.90.
// - If no rule hits, we ask the model for JSON: {label, confidence, theme}.
//   * If the model only returns {theme}, we map: theme==="Other" -> {label:"Other",0},
//     else -> {label:"Hinduism",0.85}.
// - CORS and GET/POST behavior unchanged.
// - Temperature is 0 for determinism; low max_output_tokens; no links, no extra text.

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

// --- simple keyword buckets (unchanged) ---
const RULES = [
  // Temples
  { theme: "Temples", kws: [
    "temple", "mandir", "mandira", "devalaya",
    "tirupati", "kedarnath", "badrinath", "dwarkadhish", "somnath",
    "jagannath", "puri", "shirdi", "vaishno devi", "kamakhya", "meenakshi",
    "char dham", "jyotirlinga", "darshan", "aarti timings", "opening time", "closing time"
  ]},

  // Festivals
  { theme: "Festivals", kws: [
    "festival", "utsav", "tithi", "date of", "when is", "celebrated",
    "diwali", "deepavali", "navratri", "ganesh chaturthi", "mahashivratri",
    "janmashtami", "ram navami", "makar sankranti", "holi", "raksha bandhan", "karwa chauth"
  ]},

  // Puja & Rituals
  { theme: "Puja & Rituals", kws: [
    "puja", "pooja", "vrat", "vrata", "upvas", "fasting", "how to do", "steps for",
    "materials for", "samagri", "mantra", "japa", "havan", "yajna", "archana", "abhishek"
  ]},

  // Deities
  { theme: "Deities", kws: [
    "shiva", "vishnu", "krishna", "rama", "ganesha", "ganesh", "durga", "lakshmi", "saraswati",
    "hanuman", "skanda", "murugan", "parvati", "mahadev", "narayana", "devi", "avatar", "incarnation"
  ]},

  // Scripture & Philosophy
  { theme: "Scripture & Philosophy", kws: [
    "bhagavad gita", "upanishad", "upanishads", "vedanta", "purana", "puranas", "smriti", "sruti",
    "shloka", "sloka", "verse", "chapter", "adhyaya", "commentary", "philosophy", "dharma", "karma", "moksha"
  ]},

  // Astrology
  { theme: "Astrology", kws: [
    "kundli", "kundali", "janam kundli", "horoscope", "zodiac", "nakshatra", "graha", "planet",
    "manglik", "mangal dosh", "dosha", "dasha", "gochar", "astrology", "jyotish", "remedies", "upay", "gemstone", "ratna"
  ]},

  // Products/Isvara
  { theme: "Products/Isvara", kws: [
    "rudraksha", "rudraksh", "yantra", "mala", "incense", "agarbatti", "camphor", "kapoor",
    "puja kit", "oil lamp", "diya", "kumkum", "chandan", "vibhuti"
  ]},

  // Yatra Veda (pilgrimage/tours)
  { theme: "Yatra Veda", kws: [
    "yatra", "pilgrimage", "tour", "travel", "itinerary", "package", "darshan booking"
  ]},

  // Life-challenges
  { theme: "Life-challenges", kws: [
    "job", "career", "money", "finance", "relationship", "family", "marriage",
    "stress", "anxiety", "peace of mind", "guidance", "advice", "help me"
  ]},
];

// normalize and match (unchanged logic, new return shape)
function ruleClassify(text) {
  const t = (text || "").toLowerCase();
  for (const { theme, kws } of RULES) {
    for (const kw of kws) {
      if (t.includes(kw)) {
        // Rule hit: treat as Hinduism with high confidence (0.90)
        return { theme, label: mapThemeToLabel(theme), confidence: 0.90 };
      }
    }
  }
  return null;
}

// Model fallback: now asks for {label, confidence, theme}, but still tolerates old-style {theme}
async function modelFallback(text) {
  // Keep this compact and deterministic
  const prompt = `
Return ONLY compact JSON (no commentary) describing the user's message domain.

Keys:
- "label": "Hinduism" or "Other"
- "confidence": a number 0..1 for your certainty
- "theme": pick exactly one from: ${THEMES.join(", ")}

Rules:
- If the message is within Hindu spirituality (deities, puja/rituals/vrat, festivals, temples, scriptures/philosophy, jyotish/astrology, pilgrimages/yatra, devotional practices, rudraksha, life-challenges answered via dharma), set label to "Hinduism".
- Otherwise set label to "Other".
- Be conservative: use 0.70–0.95 for typical cases; 0.50 if uncertain; 0.98+ only if it is crystal-clear.

User text:
"""${String(text || "").trim()}"""
`.trim();

  try {
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
        max_output_tokens: 60,
        text: { format: "json" }
      })
    });

    if (!r.ok) {
      return { theme: "Other", label: "Other", confidence: 0.0 };
    }
    const j = await r.json();
    const raw = j.output_text || "";
    // Try strict JSON first
    try {
      const obj = JSON.parse(raw);
      const theme = coerceTheme(obj.theme);
      const label = obj.label === "Hinduism" ? "Hinduism" : "Other";
      const confidence = clamp01(Number(obj.confidence));
      return { theme, label, confidence };
    } catch {
      // Backward tolerance: if only {theme} came back
      try {
        const obj2 = JSON.parse(raw);
        const theme = coerceTheme(obj2.theme);
        const label = mapThemeToLabel(theme);
        const confidence = theme === "Other" ? 0.0 : 0.85;
        return { theme, label, confidence };
      } catch {
        return { theme: "Other", label: "Other", confidence: 0.0 };
      }
    }
  } catch {
    return { theme: "Other", label: "Other", confidence: 0.0 };
  }
}

function mapThemeToLabel(theme) {
  // Everything except literal "Other" is still Hindu domain for our purposes
  return theme === "Other" ? "Other" : "Hinduism";
}

function coerceTheme(t) {
  const s = String(t || "");
  return THEMES.includes(s) ? s : "Other";
}

module.exports = async (req, res) => {
  // CORS (unchanged)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let text = "";
    if (req.method === 'GET') {
      text = (req.query && req.query.text) || "";
    } else if (req.method === 'POST') {
      text = (req.body && req.body.text) || "";
    } else {
      return res.status(405).json({ error: 'Use GET or POST' });
    }

    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: 'Missing "text" (string).' });
    }

    // 1) Try rules (fast path, unchanged keywords)
    const rule = ruleClassify(text);
    if (rule) {
      return res.status(200).json({
        theme: rule.theme,
        label: rule.label,
        confidence: round2(rule.confidence)
      });
    }

    // 2) Fallback to model (now returns label+confidence; still backward-compatible)
    const out = await modelFallback(text);
    return res.status(200).json({
      theme: out.theme,
      label: out.label,
      confidence: round2(out.confidence)
    });

  } catch {
    return res.status(200).json({ theme: "Other", label: "Other", confidence: 0.0 });
  }
};

// -------------- utils --------------
function clamp01(x) {
  if (!isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
function round2(x) {
  return Math.round(x * 100) / 100;
}
