// File: api/tts.js
// Purpose: Text-to-Speech (Google only) with pre-normalization and FIXED Indian male voices.
// Returns MP3 audio.
//
// What’s enforced here:
//   • Google Cloud Text-to-Speech only
//   • Male voice fixed per language: EN → en-IN-Neural2-D, HI → hi-IN-Neural2-D
//   • We IGNORE any "voice" passed from the client to keep it consistent
//   • Auto language detect (Devanagari => Hindi; else English)
//   • Normalizes text to avoid awkward speech (🙏/e.g./i.e./etc/&/Markdown/URLs)
//   • Optional SSML: set USE_TTS_SSML=1 if you want SSML input (kept OFF by default)
//
// Required env:
//   - GCP_TTS_API_KEY
//
// Optional env (advanced):
//   - GCP_TTS_VOICE_EN_MALE  (default en-IN-Neural2-D)
//   - GCP_TTS_VOICE_HI_MALE  (default hi-IN-Neural2-D)
//   - GCP_TTS_LANG           (e.g., en-IN or hi-IN) – usually leave unset
//   - USE_TTS_SSML           ("1" to enable)
//
// CORS is open for MVP.

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
    // Intentionally ignore any per-request voice to keep it male and consistent
    if (!rawText) {
      res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing "text" in JSON body' }));
    }

    // Detect language from content (Devanagari -> hi, else en)
    const lang = isDevanagari(rawText) ? 'hi' : 'en';

    // Pre-normalize text so TTS doesn’t read symbols literally
    const text = normalizeForTTS(rawText, lang);

    // Google TTS
    const { audioBuffer, ttsMs } = await ttsGoogle(text, lang);

    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-TTS-Provider': 'google',
      'X-TTS-MS': String(ttsMs || 0),
      'X-TTS-Lang': lang,
    });
    return res.end(audioBuffer);

  } catch (e) {
    console.error('TTS route error:', e);
    res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'TTS failed', details: e.message || String(e) }));
  }
};

// ---------- Provider: Google Cloud Text-to-Speech (male voices, fixed) ----------
async function ttsGoogle(text, lang) {
  const apiKey = process.env.GCP_TTS_API_KEY;
  mustHave(apiKey, 'Missing GCP_TTS_API_KEY');

  // Fixed Indian male voices (can be overridden via env if needed)
  const EN_MALE = process.env.GCP_TTS_VOICE_EN_MALE || 'en-IN-Neural2-D';
  const HI_MALE = process.env.GCP_TTS_VOICE_HI_MALE || 'hi-IN-Neural2-D';

  const voiceName = lang === 'hi' ? HI_MALE : EN_MALE;

  // Prefer deriving language from the selected voice, unless user forcibly sets GCP_TTS_LANG
  const languageCode =
    process.env.GCP_TTS_LANG ||
    guessGoogleLangFromVoice(voiceName) ||
    (lang === 'hi' ? 'hi-IN' : 'en-IN');

  const useSSML = String(process.env.USE_TTS_SSML || '0') === '1';
  const payloadInput = useSSML ? { ssml: buildGoogleSSML(text) } : { text };

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
    .replace(/(^|\s)[-•]\s+/g, '$1'); // bullets

  // 2) Tokenize abbreviations first to prevent double-expansion later
  s = s
    .replace(/\b(e\.?\s*g\.?)(?=[\s,;:.)]|$)/gi, '__EG__')   // e.g., e g
    .replace(/\b(i\.?\s*e\.?)(?=[\s,;:.)]|$)/gi, '__IE__')   // i.e., i e
    .replace(/\b(etc\.?)(?=[\s,;:.)]|$)/gi, '__ETC__')       // etc / etc.
    .replace(/\b(vs\.?)(?=[\s,;:.)]|$)/gi, '__VS__')         // vs / vs.
    .replace(/\b(viz\.?)(?=[\s,;:.)]|$)/gi, '__VIZ__')       // viz
    .replace(/\b(cf\.?)(?=[\s,;:.)]|$)/gi, '__CF__')         // cf
    .replace(/\baka\b/gi, '__AKA__');

  // 3) Replace common symbols
  if (lang === 'hi') {
    s = s.replace(/&/g, ' और ').replace(/%/g, ' प्रतिशत ');
  } else {
    s = s.replace(/&/g, ' and ').replace(/%/g, ' percent ');
  }

  // 4) Emoji handling: avoid duplicate greetings
  const hasNamasteEn = /\bnamaste\b/i.test(s);
  const hasNamasteHi = /नमस्ते/.test(s);
  if (lang === 'hi') {
    s = s.replace(/[\u{1F64F}]/gu, hasNamasteHi ? '' : ' नमस्ते '); // 🙏
  } else {
    s = s.replace(/[\u{1F64F}]/gu, hasNamasteEn ? '' : ' Namaste '); // 🙏
  }
  // Remove other emojis
  s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu, '');

  // 5) Expand tokens exactly once (language-specific)
  if (lang === 'hi') {
    s = s
      .replace(/__EG__/g, 'उदाहरण के लिए')
      .replace(/__IE__/g, 'अर्थात')
      .replace(/__ETC__/g, 'आदि')
      .replace(/__VS__/g, 'बनाम')
      .replace(/__VIZ__/g, 'अर्थात')
      .replace(/__CF__/g, 'तुलना करें')
      .replace(/__AKA__/g, 'जिसे भी कहा जाता है');
  } else {
    s = s
      .replace(/__EG__/g, 'for example')
      .replace(/__IE__/g, 'that is')
      .replace(/__ETC__/g, 'etcetera')
      .replace(/__VS__/g, 'versus')
      .replace(/__VIZ__/g, 'namely')
      .replace(/__CF__/g, 'compare')
      .replace(/__AKA__/g, 'also known as');
  }

  // 6) Collapse duplicate greetings only (to avoid harming mantra recitations)
  //   Examples handled: "Namaste, Namaste", "Namaste Namaste", "नमस्ते, नमस्ते"
  s = s
    .replace(/\b(Namaste)(?:[,\s]+)\1\b/gi, 'Namaste')
    .replace(/(नमस्ते)(?:[,\s]+)\1/g, 'नमस्ते');

  // 7) Normalize punctuation spacing and trim extra commas
  s = s
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:]){2,}/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,;:\s]+/, '')
    .replace(/[\s,;:]+$/, '')
    .trim();

  // 8) Safety: if string becomes empty, return a polite fallback
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
