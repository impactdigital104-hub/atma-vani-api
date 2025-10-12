// File: api/tts.js
// Purpose: Text-to-Speech (Google only) with pre-normalization and FIXED Indian MALE voices.
// Returns MP3 audio.
//
// Male voices (per your project's available list):
//   EN → en-IN-Neural2-B (male)
//   HI → hi-IN-Neural2-B (male)
//
// Required env:
//   - GCP_TTS_API_KEY
//
// Optional env (override if you ever want a different male voice):
//   - GCP_TTS_VOICE_EN_MALE  (default en-IN-Neural2-B)
//   - GCP_TTS_VOICE_HI_MALE  (default hi-IN-Neural2-B)
//   - USE_TTS_SSML           ("1" to enable SSML input)
//   - TTS_SPEAKING_RATE      (e.g., "0.90"; defaults to 0.90)
//   - TTS_PITCH              (e.g., "-2.0"; defaults to 0.0)
//
// CORS open for MVP.

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
    // We intentionally ignore any per-request "voice" to keep it male and consistent
    if (!rawText) {
      res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing "text" in JSON body' }));
    }

    // Detect language (for normalization choices only)
    const normLang = isDevanagari(rawText) ? 'hi' : 'en';

    // Normalize text to avoid awkward speech
    const text = normalizeForTTS(rawText, normLang);

    // Google TTS (fixed male voices)
    const { audioBuffer, ttsMs, voiceUsed, langUsed, rateUsed } = await ttsGoogle(text, normLang);

    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-TTS-Provider': 'google',
      'X-TTS-MS': String(ttsMs || 0),
      'X-TTS-Voice': voiceUsed,
      'X-TTS-Lang': langUsed,
      'X-TTS-Rate': String(rateUsed),
    });
    return res.end(audioBuffer);

  } catch (e) {
    console.error('TTS route error:', e);
    res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'TTS failed', details: e.message || String(e) }));
  }
};

// ---------- Google Cloud Text-to-Speech (male voices, fixed) ----------
async function ttsGoogle(text, normLang) {
  const apiKey = process.env.GCP_TTS_API_KEY;
  mustHave(apiKey, 'Missing GCP_TTS_API_KEY');

  // Use the MALE voices your project actually has (seen in /api/tts-voices)
  const EN_MALE = process.env.GCP_TTS_VOICE_EN_MALE || 'en-IN-Neural2-B';
  const HI_MALE = process.env.GCP_TTS_VOICE_HI_MALE || 'hi-IN-Neural2-B';

  // Choose by normalization-language (only for picking voice; synthesis language is derived from the voice name)
  const voiceName = normLang === 'hi' ? HI_MALE : EN_MALE;

  // Derive languageCode strictly from the voiceName to avoid mismatches/fallbacks
  const langFromVoice = guessGoogleLangFromVoice(voiceName) || (normLang === 'hi' ? 'hi-IN' : 'en-IN');

  // Speaking rate & pitch (tunable)
  const rate = clamp(parseFloat(process.env.TTS_SPEAKING_RATE || '0.90'), 0.5, 1.3);
  const pitch = clamp(parseFloat(process.env.TTS_PITCH || '0.0'), -10, 10);

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
        voice: { languageCode: langFromVoice, name: voiceName, ssmlGender: 'MALE' },
        audioConfig: {
          audioEncoding: 'MP3',
          speakingRate: rate,
          pitch: pitch
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
  return {
    audioBuffer: buf,
    ttsMs: Date.now() - t0,
    voiceUsed: voiceName,
    langUsed: langFromVoice,
    rateUsed: rate
  };
}

function guessGoogleLangFromVoice(name) {
  const m = String(name || '').match(/^([a-z]{2}-[A-Z]{2})-/);
  return m ? m[1] : '';
}
function buildGoogleSSML(text) {
  const safe = escapeXml(text);
  return `<speak>${safe}</speak>`;
}

// ---------- Normalization layer (unchanged) ----------
function normalizeForTTS(input, lang = 'en') {
  if (!input) return '';
  let s = String(input);

  // 0) Remove URLs
  s = s.replace(/\bhttps?:\/\/\S+/gi, '');

  // 1) Strip Markdown-like artifacts and code fences
  s = s
    .replace(/[*_`#>]+/g, ' ')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/(^|\s)[-•]\s+/g, '$1');

  // 2) Tokenize abbreviations first
  s = s
    .replace(/\b(e\.?\s*g\.?)(?=[\s,;:.)]|$)/gi, '__EG__')
    .replace(/\b(i\.?\s*e\.?)(?=[\s,;:.)]|$)/gi, '__IE__')
    .replace(/\b(etc\.?)(?=[\s,;:.)]|$)/gi, '__ETC__')
    .replace(/\b(vs\.?)(?=[\s,;:.)]|$)/gi, '__VS__')
    .replace(/\b(viz\.?)(?=[\s,;:.)]|$)/gi, '__VIZ__')
    .replace(/\b(cf\.?)(?=[\s,;:.)]|$)/gi, '__CF__')
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
    s = s.replace(/[\u{1F64F}]/gu, hasNamasteHi ? '' : ' नमस्ते ');
  } else {
    s = s.replace(/[\u{1F64F}]/gu, hasNamasteEn ? '' : ' Namaste ');
  }
  // Remove other emojis
  s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu, '');

  // 5) Expand tokens exactly once
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

  // 6) Collapse duplicate greetings only
  s = s
    .replace(/\b(Namaste)(?:[,\s]+)\1\b/gi, 'Namaste')
    .replace(/(नमस्ते)(?:[,\s]+)\1/g, 'नमस्ते');

  // 7) Normalize punctuation spacing
  s = s
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:]){2,}/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,;:\s]+/, '')
    .replace(/[\s,;:]+$/, '')
    .trim();

  // 8) Safety
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
function clamp(x, lo, hi) {
  if (!isFinite(x)) return lo;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
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
