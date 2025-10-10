// Returns { theme } for a given text (via GET ?text=... or POST { text }).
// Uses gpt-4o-mini and forces JSON output for stability.

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

    const prompt = `
Return ONLY a JSON object like {"theme":"..."}.
Pick exactly one "theme" from: ${THEMES.join(", ")}.
User text: """${text.trim()}"""
`.trim();

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
        text: { format: "json" } // force valid JSON in Responses API
      })
    });

    if (!r.ok) {
      const body = await r.text();
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
