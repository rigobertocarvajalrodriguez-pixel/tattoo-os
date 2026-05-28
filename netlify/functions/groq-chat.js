// Proxy: browser → Netlify Function → Groq Chat API
// La API key se guarda en Netlify env vars, nunca en el código fuente.
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
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: event.body   // reenvía el JSON tal cual lo manda el cliente
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
