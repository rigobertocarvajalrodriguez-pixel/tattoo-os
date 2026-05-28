// Proxy: browser → Netlify Function → Groq Whisper STT API
// Recibe JSON { audio: "<base64>", mimeType: "audio/webm", filename: "audio.webm" }
// y reenvía como multipart/form-data a Groq.
// Node 18+ tiene fetch y FormData global — no necesita npm.
exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  }

  const key = process.env.GROQ_KEY;
  if (!key) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GROQ_KEY env var not set' }) };
  }

  try {
    const { audio, mimeType, filename } = JSON.parse(event.body);
    const buf = Buffer.from(audio, 'base64');

    const formData = new FormData();
    const blob = new Blob([buf], { type: mimeType || 'audio/webm' });
    formData.append('file', blob, filename || 'audio.webm');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', 'es');
    formData.append('response_format', 'json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}` },
      body: formData
    });

    const data = await res.json();
    return {
      statusCode: res.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: err.message })
    };
  }
};
