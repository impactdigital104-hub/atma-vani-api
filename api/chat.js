// Simple chat endpoint (no streaming). Tries multiple fields for text.
// POST JSON: { "message": "your question" }

module.exports = async (req, res) => {
  // CORS (okay for quick start)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST /api/chat' });
  }

  try {
    // Vercel parses JSON automatically for Node functions
    const { message } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Missing "message" (string).' });
    }

    const SYSTEM_PROMPT = `
You are Atma Vani, a Hindu Spiritual Guide. Stay within Hindu spirituality (deities, rituals, festivals, philosophy, devotional living) and Dharma-based guidance.
Tone: warm, respectful, teacher-like; explain with context and simple steps.
Sources: prefer Sanatani.life, PujaItems.co.in, YatraVeda.life; include deep links if known; never invent URLs. If unknown, direct to the main site.
Recommendations: suggest relevant curated products/tours only with verified links; no prices; no itineraries unless provided.
Boundaries: No medical/legal/financial/career advice. No guarantees.
Structure: 1) clear answer; 2) brief context; 3) 2–4 practices; 4) optional product/tour links; 5) end with a gentle follow-up question.
    `.trim();

    const payload = {
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: message }
      ],
      temperature: 0.3
    };

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(500).json({ error: "OpenAI error", detail: errText });
    }

    const data = await resp.json();

    // Try multiple shapes:
    let reply =
      data.output_text
      || (Array.isArray(data.output)
            ? data.output
                .map(m => Array.isArray(m.content)
                  ? m.content.map(c => c.text || "").join(" ")
                  : "")
                .join("\n").trim()
            : "")
      || (Array.isArray(data.content) && data.content[0]?.text)
      || "";

    if (!reply) {
      // Return debug so we can see the shape just once
      return res.status(200).json({
        reply: "Debug: No output_text found. Here is the raw payload.",
        raw: data
      });
    }

    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: 'Server error', detail: String(e) });
  }
};
