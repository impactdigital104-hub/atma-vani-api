// File: api/tts-voices.js
// Purpose: Show which Google TTS voices are actually available to YOUR GCP project
// for Indian languages (en-IN and hi-IN). Open in a browser: /api/tts-voices
//
// Output: JSON listing voices with name + ssmlGender so we can pick a male voice that exists.
//
// Requires: GCP_TTS_API_KEY in Vercel env.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS);
    return res.end();
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Use GET' }));
  }

  try {
    const apiKey = process.env.GCP_TTS_API_KEY;
    if (!apiKey) {
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing GCP_TTS_API_KEY' }));
    }

    async function fetchVoices(langCode) {
      const url = `https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(apiKey)}&languageCode=${encodeURIComponent(langCode)}`;
      const r = await fetch(url);
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        return { error: `voices:list ${langCode} ${r.status}`, detail: txt };
      }
      const j = await r.json();
      const all = Array.isArray(j.voices) ? j.voices : [];
      // Simplify output
      const trimmed = all.map(v => ({
        name: v.name,
        languageCodes: v.languageCodes,
        ssmlGender: v.ssmlGender,
        naturalSampleRateHertz: v.naturalSampleRateHertz
      }));
      // Keep only voices that explicitly include our language code
      const filtered = trimmed.filter(v => (v.languageCodes || []).includes(langCode));
      // Sort by name for readability
      filtered.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return filtered;
    }

    const [enIN, hiIN] = await Promise.all([
      fetchVoices('en-IN'),
      fetchVoices('hi-IN'),
    ]);

    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      note: 'These are the voices your GCP project can actually synthesize with. Pick a male voice from each list.',
      enIN,
      hiIN
    }, null, 2));

  } catch (e) {
    console.error('tts-voices error:', e);
    res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'voices failed', details: e.message || String(e) }));
  }
};
