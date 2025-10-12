// File: api/tts.js
// Purpose: Text-to-Speech (Google only) with pre-normalization to avoid awkward speech.
// Returns MP3 audio.
//
// Frontend usage (unchanged):
//   POST /api/tts  { "text": "Hello", "voice": "optional" }  -> audio/mpeg
//
// Env required:
//   GCP_TTS_API_KEY
// Optional env:
//   GCP_TTS_VOICE (default en-IN-Neural2-A / hi-IN-Neural2-A auto-chosen)
//   GCP_TTS_LANG  (e.g., en-IN or hi-IN). If unset, we infer from voice name.
//   USE_TTS_SSML=1 to send SSML instead of plain text
//
// CORS is open for MVP. Tighten in prod.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ---------- HTTP entry ----------
module.exports = async (req, res) => {
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
    const rawText = ((body && body.text) || '').trim();
    const requestedVoice = (body && body.voice) ? String(body.voice) : '';
    // Engine overrides ignored by design (Google-only)
    if (!rawText) {
      res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing "text" in JSON body' }));
    }

    // Detect language from content (Devanagari -> hi, else en)
    const lang = isDevanagari(rawText) ? 'hi' : 'en';

    // Pre-normalize text so TTS doesn’t read symbols literally
    const text = normalizeForTTS(rawText, lang);

    // Google TTS
    const { audioBuffer, ttsMs } = await ttsGoogle(text, requestedVoice, lang);

    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-TTS-Provider': 'google',
      'X-TTS-MS': String(ttsMs || 0),
    });
    return res.end(audioBuffer);

  } catch (e) {
    console.error('TTS route error:', e);
    res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'TTS failed', details: e.message || String(e) }));
  }
};

// ---------- Provider: Google Cloud Text-to-Speech ----------
async function ttsGoogle(text, voiceInput, lang) {
  const apiKey = process.env.GCP_TTS_API_KEY;
  mustHave(apiKey, 'Missing GCP_TTS_API_KEY');

  // Choose default voices per language
  const defaultVoice = lang === 'hi' ? 'hi-IN-Neural2-A' : 'en-IN-Neural2-A';
  const voiceName = voiceInput || process.env.GCP_TTS_VOICE || defaultVoice;

  // If you set a specific voice name, set languageCode from it if possible:
  const languageCode =
    process.env.GCP_TTS_LANG ||
    guessGoogleLangFromVoice(voiceName) ||
    (lang === 'hi' ? 'hi-IN' : 'en-IN');

  const useSSML = String(process.env.USE_TTS_SSML || '0') === '1';
  const payloadInput = useSSML
    ? { ssml: buildGoogleSSML(text) }
    : { text }; // safe because we normalize first

  const t0 = Date.now();
  const r = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: payloadInput,
        voice: { languageCode, name: voiceName },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: 1.0
        }
      }),
    }
  );
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Google TTS error ${r.status}: ${errText}`);
  }
  const data = await r.json();
  if (!data || !data.audioContent) throw new Error('Google TTS returned no audioContent');
  const buf = Buffer.from(data.audioContent, 'base64');
  return { audioBuffer: buf, ttsMs: Date.now() - t0 };
}

function guessGoogleLangFromVoice(name) {
  // naive parse: "hi-IN-..." -> "hi-IN"
  const m = String(name || '').match(/^([a-z]{2}-[A-Z]{2})-/);
  return m ? m[1] : '';
}
function buildGoogleSSML(text) {
  // Very light SSML wrapper; text is already normalized.
  const safe = escapeXml(text);
  return `<speak>${safe}</speak>`;
}

// ---------- Normalization layer ----------
function normalizeForTTS(input, lang = 'en') {
  if (!input) return '';

  let s = String(input);

  // 0) Remove URLs (avoid reading them character-by-character)
  s = s.replace(/\bhttps?:\/\/\S+/gi, '');

  // 1) Strip Markdown-like artifacts and code fences
  s = s
    .replace(/[*_`#>]+/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1') // [text](link) -> text
    .replace(/[-•]\s+/g, ' '); // bullets

  // 2) Replace common symbols
  if (lang === 'hi') {
    s = s.replace(/&/g, ' और ');
    s = s.replace(/%/g, ' प्रतिशत ');
  } else {
    s = s.replace(/&/g, ' and ');
    s = s.replace(/%/g, ' percent ');
  }

  // 3) Normalize punctuation spacing
  s = s.replace(/\s+([,.!?;:])/g, '$1');

  // 4) Expand common abbreviations (case-insensitive)
  const mapEn = [
    [/(\b)e\.g\./gi, '$1for example'],
    [/(\b)i\.e\./gi, '$1that is'],
    [/(\b)etc\./gi, '$1etcetera'],
    [/(\b)vs\./gi, '$1versus'],
    [/(\b)viz\./gi, '$1namely'],
    [/(\b)cf\./gi, '$1compare'],
    [/(\b)aka\b/gi, 'also known as'],
  ];
  const mapHi = [
    [/(\b)e\.g\./gi, '$1उदाहरण के लिए'],
    [/(\b)i\.e\./gi, '$1अर्थात'],
    [/(\b)etc\./gi, '$1आदि'],
    [/(\b)vs\./gi, '$1बनाम'],
    [/(\b)viz\./gi, '$1अर्थात'],
    [/(\b)cf\./gi, '$1तुलना करें'],
    [/(\b)aka\b/gi, 'जिसे भी कहा जाता है'],
  ];
  for (const [re, rep] of (lang === 'hi' ? mapHi : mapEn)) s = s.replace(re, rep);

  // Also catch variants missing the last dot (e.g or etc)
  const tail = lang === 'hi'
    ? [['e.g', 'उदाहरण के लिए'], ['i.e', 'अर्थात'], ['etc', 'आदि']]
    : [['e.g', 'for example'], ['i.e', 'that is'], ['etc', 'etcetera']];
  for (const [k, v] of tail) {
    const re = new RegExp(`\\b${escapeRegExp(k)}\\b`, 'gi');
    s = s.replace(re, v);
  }

  // 5) Emoji and special characters cleanup (keep a few explicit cases)
  const emojiReplacements = lang === 'hi'
    ? { '🙏': 'नमस्ते', '🙂': '', '😊': '', '❤️': '', '🤝': 'धन्यवाद' }
    : { '🙏': 'Namaste', '🙂': '', '😊': '', '❤️': '', '🤝': 'thank you' };
  s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu, (m) => emojiReplacements[m] ?? '');

  // 6) Collapse spaces, trim
  s = s.replace(/\s{2,}/g, ' ').trim();

  // 7) Safety: if string becomes empty, return a polite fallback
  if (!s) {
    s = lang === 'hi'
      ? 'क्षमा कीजिए, इस संदेश में बोलने योग्य सामग्री नहीं मिली।'
      : 'Sorry, there was nothing to speak in this message.';
  }

  return s;
}

function isDevanagari(str) {
  return /[\u0900-\u097F]/.test(str || '');
}
function escapeRegExp(x) {
  return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- Helpers ----------
function mustHave(value, messageIfMissing) {
  if (!value) throw new Error(messageIfMissing);
}
function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
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
