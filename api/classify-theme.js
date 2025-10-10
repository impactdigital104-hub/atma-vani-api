// Returns { theme } for a given text (via GET ?text=... or POST { text }).
// Uses gpt-4o-mini with examples and forces JSON output.

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

function buildPrompt(text) {
  return `
Classify the user's text into EXACTLY ONE of these themes:
${THEMES.join(", ")}

Return ONLY a JSON object like: {"theme":"Temples"}

Guidelines:
- "Temples": temple names/locations/histories/darshan timings (e.g., Jagannath Mandir, Kedarnath, Tirupati).
- "Festivals": festival dates/rituals/meaning (e.g., Diwali, Navratri, Ganesh Chaturthi).
- "Puja & Rituals": how-to steps, materials, mantras for home/temple worship (e.g., Lakshmi puja at home).
- "Deities": forms, attributes, stories, iconography of gods/goddesses (e.g., Shiva, Vishnu, Durga).
- "Scripture & Philosophy": Bhagavad Gita, Upanishads, Puranas, Vedanta ideas, shlokas.
- "Life-challenges": dharma/bhakti-based guidance for work, family, finances, relationships, health (no medical/legal/financial advice).
- "Products/Isvara": rudraksha, yantra, incense, puja kits, malas, etc.
- "Yatra Veda": pilgrimages, yatras, temple tours, travel planning for holy places.
- "Astrology": kundli, doshas, nakshatras, remedies like mantras/fasts/gems (no predictions).
- Otherwise: "Other".

Examples (input → theme):
- "Tell me about Jagannath Mandir" → "Temples"
- "Where is Kedarnath temple located?" → "Temples"
- "When is Diwali celebrated?" → "Festivals"
- "How to do Lakshmi puja at home?" → "Puja & Rituals"
- "Explain Bhagavad Gita Chapter 2" → "Scripture & Philosophy"
- "I feel stuck at work; what should I pray?" → "Life-challenges"
- "Which rudraksha helps for focus?" → "Products/Isvara"
- "What is Manglik dosha?" → "Astrology"
- "Plan a Char Dham yatra" → "Yatra Veda"

User text: """${text.trim()}"""
`.trim();
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // accept GET ?text=... or POST { text }
    let text = "";
    if (req.method === 'GET') {
      text = (req.query && req.query.text) || "";
    } else if (req.method === 'POST') {
      text = (req.body && req.body.text) || "";
    } else {
      return res.status(405).json({ error: 'Use GET or POST' });
    }

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Missing "text" (string).' });
    }

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [{ role: "user", content: buildPrompt(text) }],
        temperature: 0,
        max_output_tokens: 40,
        text: { format: "json" } // force valid JSON
      })
    });

    if (!r.ok) {
      // keep it robust—fallback to Other if upstream is unhappy
      return res.status(200).json({ theme: "Other" });
    }

    const j = await r.json();
    const raw = (j && j.output_text) || "";
    let theme = "Other";
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.theme === "string" && THEMES.includes(obj.theme)) {
        theme = obj.theme;
      }
    } catch (_) {}

    return res.status(200).json({ theme });
  } catch (e) {
    return res.status(200).json({ theme: "Other" });
  }
};
