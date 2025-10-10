// Hybrid classifier: fast keyword rules first (deterministic), then model fallback.
// Returns { theme } for GET ?text=... or POST { text }.

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

// --- simple keyword buckets (add/change anytime) ---
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

// normalize and match
function ruleClassify(text) {
  const t = (text || "").toLowerCase();
  for (const { theme, kws } of RULES) {
    for (const kw of kws) {
      if (t.includes(kw)) return theme;
    }
  }
  return null;
}

async function modelFallback(text) {
  // Very small prompt, forced JSON. Used only when rules fail.
  const prompt = `
Return ONLY {"theme":"..."} choosing ONE from:
${THEMES.join(", ")}.
User text: """${text.trim()}"""
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
        max_output_tokens: 20,
        text: { format: "json" }
      })
    });

    if (!r.ok) return "Other";
    const j = await r.json();
    const raw = j.output_text || "";
    try {
      const obj = JSON.parse(raw);
      const t = obj && typeof obj.theme === "string" ? obj.theme : "Other";
      return THEMES.includes(t) ? t : "Other";
    } catch {
      return "Other";
    }
  } catch {
    return "Other";
  }
}

module.exports = async (req, res) => {
  // CORS
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

    // 1) Try rules
    const rule = ruleClassify(text);
    if (rule) return res.status(200).json({ theme: rule });

    // 2) Fallback to model
    const theme = await modelFallback(text);
    return res.status(200).json({ theme });
  } catch {
    return res.status(200).json({ theme: "Other" });
  }
};
