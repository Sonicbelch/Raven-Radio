const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept'
};

const jsonResponse = (statusCode, payload) => ({
  statusCode,
  headers: {
    ...corsHeaders,
    'Content-Type': 'application/json; charset=utf-8'
  },
  body: JSON.stringify(payload)
});

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ''
    };
  }

  if (event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const target = event.queryStringParameters?.url;
  if (!target) {
    return jsonResponse(400, { error: 'Missing url parameter' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return jsonResponse(400, { error: 'Invalid url parameter' });
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return jsonResponse(400, { error: 'Only http/https URLs are supported' });
  }

  try {
    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        Accept: 'application/json'
      }
    });

    if (!upstream.ok) {
      return jsonResponse(502, { error: `Upstream error: ${upstream.status}` });
    }

    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return jsonResponse(502, { error: 'Upstream did not return JSON' });
    }

    return jsonResponse(200, payload);
  } catch {
    return jsonResponse(502, { error: 'Failed to fetch metadata' });
  }
};
