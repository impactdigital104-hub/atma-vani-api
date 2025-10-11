// File: api/tts.js
// Purpose: Text-to-Speech with multiple providers, returns MP3 audio.
// Providers (choose via env TTS_PROVIDER): openai | elevenlabs | azure | google | sarvam
// Defaults to OpenAI. Keep secrets ONLY in Vercel env vars.
//
// Frontend usage (unchanged):
//   POST /api/tts  { "text": "Hello", "voice": "optional" }  -> audio/mpeg
//
// Optional request override (kept simple for testing):
//   You may pass { engine: "azure" } or a query param ?engine=azure to override env.
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
    const text = ((body && body.text) || '').trim();
    const requestedVoice = (body && body.voice) ? String(body.voice) : '';
    const reqEngine = (body && body.engine) ? String(body.engine) : (getQueryEngine(req.url) || '');
    if (!text) {
      res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing "text" in JSON body' }));
    }

    // provider selection: request override -> env -> default
    const provider = (reqEngine || process.env.TTS_PROVIDER || 'openai').toLowerCase();

    let audioBuffer, ttsMs, providerName = provider;

    if (provider === 'openai') {
      ({ audioBuffer, ttsMs } = await ttsOpenAI(text, requestedVoice));
    } else if (provider === 'elevenlabs') {
      ({ audioBuffer, ttsMs } = await ttsElevenLabs(text, requestedVoice));
    } else if (provider === 'azure') {
      ({ audioBuffer, ttsMs } = await ttsAzure(text, requestedVoice));
    } else if (provider === 'google') {
      ({ audioBuffer, ttsMs } = await ttsGoogle(text, requestedVoice));
    } else if (provider === 'sarvam') {
      ({ audioBuffer, ttsMs } = await ttsSarvam(text, requestedVoice));
    } else {
      providerName = 'openai';
      ({ audioBuffer, ttsMs } = await ttsOpenAI(text, requestedVoice));
    }

    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store',
      'X-TTS-Provider': providerName,
      'X-TTS-MS': String(ttsMs || 0),
    });
    return res.end(audioBuffer);

  } catch (e) {
    console.error('TTS route error:', e);
    res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'TTS failed', details: e.message || String(e) }));
  }
};

// ---------- Provider: OpenAI ----------
async function ttsOpenAI(text, voiceInput) {
  const model = process.env.TTS_MODEL || 'tts-1';
  const voice = voiceInput || process.env.DEFAULT_TTS_VOICE || 'alloy';
  const format = 'mp3';

  mustHave(process.env.OPENAI_API_KEY, 'Missing OPENAI_API_KEY');

  const t0 = Date.now();
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, voice, input: text, format }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`OpenAI TTS error ${r.status}: ${errText}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return { audioBuffer: buf, ttsMs: Date.now() - t0 };
}

// ---------- Provider: ElevenLabs ----------
async function ttsElevenLabs(text, voiceInput) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  mustHave(apiKey, 'Missing ELEVENLABS_API_KEY');

  const defaultVoiceId = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel (public demo)
  const voiceId = parseElevenVoice(voiceInput) || defaultVoiceId;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;

  const t0 = Date.now();
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true }
    }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`ElevenLabs TTS error ${r.status}: ${errText}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return { audioBuffer: buf, ttsMs: Date.now() - t0 };
}
function parseElevenVoice(v) {
  if (!v) return '';
  // if client passes "eleven:<VOICE_ID>"
  if (v.startsWith('eleven:')) return v.split(':', 2)[1];
  // otherwise assume already a voice id
  return v;
}

// ---------- Provider: Azure Cognitive Services (Neural TTS) ----------
async function ttsAzure(text, voiceInput) {
  const region = process.env.AZURE_TTS_REGION;
  const key = process.env.AZURE_TTS_KEY;
  mustHave(region, 'Missing AZURE_TTS_REGION');
  mustHave(key, 'Missing AZURE_TTS_KEY');

  const voice = voiceInput || process.env.AZURE_TTS_VOICE || 'en-IN-NeerjaNeural';
  // Common MP3 format; you can change to higher bitrates if you like
  const outputFmt = process.env.AZURE_TTS_OUTPUT || 'audio-24khz-48kbitrate-mono-mp3';

  const ssml = buildAzureSSML(voice, text);

  const t0 = Date.now();
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': outputFmt,
      'User-Agent': 'AtmaVani/tts',
    },
    body: ssml,
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Azure TTS error ${r.status}: ${errText}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return { audioBuffer: buf, ttsMs: Date.now() - t0 };
}
function buildAzureSSML(voiceName, text) {
  const escaped = escapeXml(text);
  return `<?xml version="1.0" encoding="utf-8"?>
<speak version="1.0" xml:lang="en-IN">
  <voice name="${voiceName}">
    <prosody rate="0%">${escaped}</prosody>
  </voice>
</speak>`;
}

// ---------- Provider: Google Cloud Text-to-Speech ----------
async function ttsGoogle(text, voiceInput) {
  // Simpler auth path: API key (enable Text-to-Speech API in your project)
  const apiKey = process.env.GCP_TTS_API_KEY;
  mustHave(apiKey, 'Missing GCP_TTS_API_KEY');

  const voiceName = voiceInput || process.env.GCP_TTS_VOICE || 'en-IN-Neural2-A';
  // If you set a specific voice name, set languageCode from it if possible:
  const languageCode = (process.env.GCP_TTS_LANG || guessGoogleLangFromVoice(voiceName) || 'en-IN');

  const t0 = Date.now();
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text }, // you can switch to { ssml: "<speak>...</speak>" } if you add SSML later
      voice: { languageCode, name: voiceName }, // ex: en-IN-Neural2-A, hi-IN-Neural2-A
      audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0 }
    }),
  });
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

// ---------- Provider: Sarvam (Indic-focused) ----------
async function ttsSarvam(text, voiceInput) {
  const apiKey = process.env.SARVAM_API_KEY;
  mustHave(apiKey, 'Missing SARVAM_API_KEY');

  // Configs (depend on their catalog; set in env for your project)
  const lang = process.env.SARVAM_TTS_LANG || 'hi-IN';      // e.g., 'en-IN', 'hi-IN', 'ta-IN', etc.
  const speaker = voiceInput || process.env.SARVAM_TTS_VOICE || 'Abhilash'; // pick an available voice
  const apiUrl = process.env.SARVAM_API_URL || 'https://api.sarvam.ai/text-to-speech'; // update if their base changes

  // NOTE: Many providers limit per-request text length. Keep concise summaries under ~1200-1400 chars.
  const t0 = Date.now();
  const r = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      target_language_code: lang,  // adjust to their exact field name if needed
      speaker,                     // voice name
      format: 'mp3'
    }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    throw new Error(`Sarvam TTS error ${r.status}: ${errText}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return { audioBuffer: buf, ttsMs: Date.now() - t0 };
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
function getQueryEngine(url) {
  try {
    const u = new URL(url, 'http://localhost');
    return u.searchParams.get('engine');
  } catch { return ''; }
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
