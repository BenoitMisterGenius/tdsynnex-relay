import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Aucune URL fournie par un visiteur n'est utilisee comme destination.
const BASE = 'https://api.tdsynnex.com/eu';
const ROUTES = new Map([
  ['/auth/token', 'application/x-www-form-urlencoded'],
  ['/resellers/v2/products/catalogue', 'application/json'],
  ['/resellers/v1/products/latest-stock-price', 'application/json'],
]);
const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest();

function send(res, status, body, extra = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('too_large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readResponse(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) {
        await reader.cancel();
        throw new Error('response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

export function createRelayServer({ key, fetchImpl = fetch } = {}) {
  if (typeof key !== 'string' || key.length < 32 || key.trim() !== key) {
    throw new Error('RELAY_KEY doit contenir au moins 32 caracteres, sans espace aux extremites.');
  }
  const expectedKey = digest(key);
  let active = 0;
  let windowStart = Date.now();
  let calls = 0;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      return send(res, 200, { ok: true, service: 'tdsynnex-relay', version: '1.0.0' });
    }
    const providedKey = req.headers['x-td-relay-key'];
    if (typeof providedKey !== 'string' || !timingSafeEqual(digest(providedKey), expectedKey)) {
      req.resume();
      return send(res, 401, { error: 'relay_unauthorized' });
    }
    const contentType = ROUTES.get(req.url);
    if (!contentType) {
      req.resume();
      return send(res, 404, { error: 'route_not_allowed' });
    }
    if (req.method !== 'POST') {
      req.resume();
      return send(res, 405, { error: 'post_required' }, { Allow: 'POST' });
    }
    if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== contentType) {
      req.resume();
      return send(res, 415, { error: 'invalid_content_type' });
    }
    if (Number(req.headers['content-length'] || 0) > MAX_BODY) {
      req.resume();
      return send(res, 413, { error: 'request_too_large' });
    }
    const isToken = req.url === '/auth/token';
    const authorization = req.headers.authorization;
    if (!isToken && (typeof authorization !== 'string' || !/^Bearer \S+$/i.test(authorization))) {
      req.resume();
      return send(res, 400, { error: 'bearer_required' });
    }
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      calls = 0;
    }
    if (calls >= 60 || active >= 8) {
      req.resume();
      return send(res, 429, { error: 'relay_rate_limit' }, { 'Retry-After': '60' });
    }
    calls++;
    active++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      const body = await readBody(req);
      if (isToken) {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') !== 'client_credentials' || !form.get('client_id') || !form.get('client_secret')) {
          return send(res, 400, { error: 'client_credentials_required' });
        }
      } else {
        let parsed;
        try { parsed = JSON.parse(body); } catch { return send(res, 400, { error: 'invalid_json' }); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return send(res, 400, { error: 'json_object_required' });
        }
      }
      const headers = {
        'Content-Type': contentType,
        Accept: 'application/json',
        'User-Agent': 'MisterGenius-TDSYNNEX-Relay/1.0',
      };
      if (!isToken) headers.Authorization = authorization;
      const trace = req.headers.traceid;
      if (typeof trace === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(trace)) headers.TraceId = trace;
      const upstream = await fetchImpl(BASE + req.url, {
        method: 'POST', headers, body, redirect: 'manual', signal: controller.signal,
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        return send(res, 502, { error: 'upstream_redirect_refused' });
      }
      const output = await readResponse(upstream);
      const extra = {
        'Content-Type': (upstream.headers.get('content-type') || '').includes('application/json')
          ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
        'X-TD-Relay': '1',
      };
      for (const header of ['retry-after', 'traceid', 'x-correlation-id']) {
        const value = upstream.headers.get(header);
        if (value && /^[\x20-\x7e]{1,200}$/.test(value)) extra[header] = value;
      }
      send(res, upstream.status, output, extra);
    } catch (error) {
      const status = error.status === 413 ? 413 : controller.signal.aborted ? 504 : 502;
      send(res, status, { error: status === 413 ? 'request_too_large' : status === 504 ? 'upstream_timeout' : 'upstream_unavailable' });
      // Ne jamais journaliser les en-tetes, corps, jetons ou objets d'erreur.
    } finally {
      clearTimeout(timeout);
      res.off('close', onClose);
      active--;
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.timeout = 30_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = createRelayServer({ key: process.env.RELAY_KEY });
    server.listen(Number(process.env.PORT || 10000), '0.0.0.0', () => console.log('Relais TD SYNNEX pret.'));
    process.on('SIGTERM', () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 30_000).unref();
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
