const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept'
};

const sendJson = (res, status, payload) => {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
  res.send(JSON.stringify(payload));
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(corsHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const target = req.query?.url;
  if (typeof target !== 'string' || !target) {
    sendJson(res, 400, { error: 'Missing url parameter' });
    return;
  }

  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    sendJson(res, 400, { error: 'Invalid url parameter' });
    return;
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    sendJson(res, 400, { error: 'Only http/https URLs are supported' });
    return;
  }

  try {
    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        Accept: 'application/json'
      }
    });

    if (!upstream.ok) {
      sendJson(res, 502, { error: `Upstream error: ${upstream.status}` });
      return;
    }

    const text = await upstream.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      sendJson(res, 502, { error: 'Upstream did not return JSON' });
      return;
    }

    sendJson(res, 200, payload);
  } catch {
    sendJson(res, 502, { error: 'Failed to fetch metadata' });
  }
}
