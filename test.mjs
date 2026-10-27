import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayServer } from './server.mjs';

const key = 'local-test-only-'.repeat(4);
const route = '/resellers/v2/products/catalogue';

async function setup(t, mock = async () => Response.json({ data: [] })) {
  const server = createRelayServer({ key, fetchImpl: mock });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path = route, options = {}) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-td-relay-key': key, authorization: 'Bearer fake-test-token' },
    body: '{"manufacturer":"Lenovo","page":1,"pageSize":1}',
    ...options,
  });
}

test('health accessible, missing/incorrect relay key never reaches supplier', async t => {
  let calls = 0;
  const request = await setup(t, async () => { calls++; return Response.json({}); });
  assert.equal((await request('/health', { method: 'GET', headers: {}, body: undefined })).status, 200);
  for (const headers of [{}, { 'x-td-relay-key': 'wrong' }]) {
    assert.equal((await request(route, { headers })).status, 401);
  }
  assert.equal(calls, 0);
});

test('forwards exact catalogue body and bearer only to fixed endpoint; strips relay key and cookies', async t => {
  const request = await setup(t, async (url, options) => {
    assert.equal(url, 'https://api.tdsynnex.com/eu' + route);
    assert.equal(options.headers.Authorization, 'Bearer fake-test-token');
    assert.equal(options.headers['x-td-relay-key'], undefined);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.body, '{"manufacturer":"Lenovo","page":1,"pageSize":1}');
    assert.equal(options.redirect, 'manual');
    return Response.json({ data: [{ tdsynnexPartNumber: '10179925' }] });
  });
  assert.equal((await (await request()).json()).data[0].tdsynnexPartNumber, '10179925');
});

test('OAuth form is forwarded without relay key or inbound bearer', async t => {
  const request = await setup(t, async (url, options) => {
    assert.equal(url, 'https://api.tdsynnex.com/eu/auth/token');
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(new URLSearchParams(options.body).get('client_secret'), 'fake-secret');
    return Response.json({ access_token: 'fake-response-token' });
  });
  const response = await request('/auth/token', {
    headers: { 'x-td-relay-key': key, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&client_id=fake-id&client_secret=fake-secret',
  });
  assert.equal((await response.json()).access_token, 'fake-response-token');
});

test('rejects other destinations, malformed JSON, absent bearer and oversized body', async t => {
  let calls = 0;
  const request = await setup(t, async () => { calls++; return Response.json({}); });
  for (const path of ['/proxy?url=https://example.com', '/auth/token?url=x', '/resellers/v2/orders']) {
    assert.equal((await request(path)).status, 404);
  }
  assert.equal((await request(route, { body: '{' })).status, 400);
  assert.equal((await request(route, { body: '[]' })).status, 400);
  assert.equal((await request(route, { headers: { 'x-td-relay-key': key, 'content-type': 'application/json' } })).status, 400);
  assert.equal((await request(route, { body: 'a'.repeat(65 * 1024) })).status, 413);
  assert.equal(calls, 0);
});

test('preserves supplier denial and throttling without forwarding cookies', async t => {
  for (const status of [403, 429]) {
    const request = await setup(t, async () => Response.json({ error: 'supplier-test' }, {
      status, headers: { 'retry-after': '60', 'set-cookie': 'secret=not-forwarded' },
    }));
    const response = await request();
    assert.equal(response.status, status);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { error: 'supplier-test' });
  }
});

test('refuses supplier redirect instead of leaking credentials', async t => {
  const request = await setup(t, async () => new Response(null, { status: 302, headers: { location: 'https://example.com' } }));
  const response = await request();
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('location'), null);
});

test('fails closed without valid relay key', () => {
  assert.throws(() => createRelayServer({ key: '' }));
});
