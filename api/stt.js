// File: api/stt.js
// Purpose: Accepts multipart/form-data with a field named "file" (your audio),
//          sends it to OpenAI STT, returns { text, sttMs }.
// Notes: Uses fetch + FormData (no OpenAI SDK confusion). CORS open for MVP.

const Busboy = require('busboy');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async (req, res) => {
  // 1) CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS);
    return res.end();
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Use POST' }));
  }

  // 2) Parse the incoming multipart/form-data and get the audio buffer
  let fileBuffer, filename, mimeType;
  try {
    const file = await readMultipartFile(req, 'file'); // <- field name must be "file"
    fileBuffer = file.buffer;
    filename = file.filename || 'audio.webm';
    mimeType = file.mimeType || 'audio/webm';
  } catch (e) {
    console.error('Multipart parse error:', e);
    res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Could not read uploaded file' }));
  }

  if (!fileBuffer) {
    res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'No file received (field name must be "file")' }));
  }

  // 3) Build a FormData to send to OpenAI Audio Transcriptions API
  try {
    // Node 18+ has FormData, Blob, File via undici (global)
    const blob = new Blob([fileBuffer], { type: mimeType });
    const file = new File([blob], filename, { type: mimeType });

    const model = process.env.STT_MODEL || 'gpt-4o-mini-transcribe'; // or 'whisper-1'
    const form = new FormData();
    form.append('model', model);
    form.append('file', file);

    const t0 = Date.now();
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: form,
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.error('OpenAI STT HTTP error:', r.status, errText);
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'OpenAI STT failed', status: r.status, details: errText }));
    }

    const data = await r.json();
    const sttMs = Date.now() - t0;

    // API returns { text: "..." }
    const text = data?.text || '';
    if (!text) {
      res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Transcription returned empty text' }));
    }

    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text, sttMs }));
  } catch (e) {
    console.error('STT error:', e);
    res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Transcription failed', details: e.message || String(e) }));
  }
};

// Helper: read a single file from multipart form using Busboy
function readMultipartFile(req, fieldName) {
  return new Promise((resolve, reject) => {
    try {
      const bb = Busboy({ headers: req.headers });
      let fileBuffer = Buffer.alloc(0);
      let filename = '';
      let mimeType = '';
      let found = false;

      bb.on('file', (name, file, info) => {
        if (name === fieldName) {
          found = true;
          filename = info.filename || 'audio.webm';
          mimeType = info.mimeType || 'application/octet-stream';
          file.on('data', (d) => (fileBuffer = Buffer.concat([fileBuffer, d])));
        } else {
          file.resume(); // ignore other fields/files
        }
      });

      bb.on('field', () => { /* ignore fields for now */ });

      bb.on('close', () => {
        if (!found) return resolve({ buffer: null, filename: '', mimeType: '' });
        resolve({ buffer: fileBuffer, filename, mimeType });
      });

      bb.on('error', reject);
      req.pipe(bb);
    } catch (e) {
      reject(e);
    }
  });
}
