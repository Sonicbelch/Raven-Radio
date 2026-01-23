import http from 'node:http';
import { URL } from 'node:url';

const port = Number(process.env.METADATA_PROXY_PORT ?? 4173);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept'
};

const sendJson = (res, status, payload) => {
  res.writeHead(status, {
    ...corsHeaders,
    'Content-Type': 'application/json; charset=utf-8'
  });
  res.end(JSON.stringify(payload));
};

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (req.method !== 'GET' || requestUrl.pathname !== '/api/metadata') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const target = requestUrl.searchParams.get('url');
  if (!target) {
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
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Metadata proxy listening on http://127.0.0.1:${port}`);
});
