// File: api/tts.js
// Purpose: Accepts JSON { text, voice? } and returns MP3 audio (audio/mpeg)
// Default provider: OpenAI TTS (model: tts-1)
// CORS is open for MVP tests. Keep OPENAI_API_KEY in Vercel env.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async (req, res) => {
  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS);
    return res.end();
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Use POST' }));
  }

  try {
    const body = await readJson(req);
    const text = (body && body.text) ? String(body.text) : '';
    const voice = (body && body.voice) ? String(body.voice) : (process.env.DEFAULT_TTS_VOICE || 'alloy');
    const model = process.env.TTS_MODEL || 'tts-1';
    const format = 'mp3'; // mp3 for broad browser support

    if (!text.trim()) {
      res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing "text" in JSON body' }));
    }

    const t0 = Date.now();
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,           // e.g., 'alloy', 'verse', 'aria' (availability varies)
        input: text,
        format,          // 'mp3' -> response is an audio/mpeg stream
      }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('OpenAI TTS error:', r.status, errText);
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'OpenAI TTS failed', status: r.status, details: errText }));
    }

    const buf = Buffer.from(await r.arrayBuffer());
    const ttsMs = Date.now() - t0;

    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-TTS-MS': String(ttsMs),
    });
    res.end(buf);
  } catch (e) {
    console.error('TTS route error:', e);
    res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'TTS failed', details: e.message || String(e) }));
  }
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
