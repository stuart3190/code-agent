import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseBackend } from '../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js';
const make = fetchImpl => createSupabaseBackend({ url: 'https://session-deadline.supabase.co', anonKey: 'fixture-public-key', appId: 'fixture', authUrl: 'https://session-deadline.supabase.co/functions/v1/app-auth', fetchImpl });
for (const stage of ['headers', 'body']) test(`existing session lookup bounds stalled ${stage}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal, settled = false, reached = false;
  const api = make(async (_url, init) => {
    reached = true; signal = init.signal;
    const pending = () => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return stage === 'headers' ? pending() : { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: pending, arrayBuffer: pending };
  });
  const result = api._client.auth.getUser('fixture-jwt').finally(() => { settled = true; });
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.ok(reached); assert.ok(signal, 'session user request must have an abort deadline');
  t.mock.timers.tick(29999); await Promise.resolve(); assert.equal(settled, false);
  t.mock.timers.tick(1); const response = await result;
  assert.equal(signal.aborted, true); assert.equal(response.data.user, null);
  assert.match(response.error.message, /timed out/i);
});
test('successful session lookup preserves user and clears deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let signal;
  const api = make(async (_url, init) => { signal = init.signal; return new Response(JSON.stringify({ id: 'existing-user', email: 'own@example.test' }), { headers: { 'Content-Type': 'application/json' } }); });
  const result = await api._client.auth.getUser('fixture-jwt');
  assert.equal(result.error, null); assert.equal(result.data.user.id, 'existing-user');
  assert.ok(signal); t.mock.timers.tick(60000); assert.equal(signal.aborted, false);
});
test('upstream cancellation is forwarded and clears the local timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let signal;
  const upstream = new AbortController(), reason = new Error('caller stopped');
  const api = make(async (_url, init) => { signal = init.signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); });
  const result = api._client.auth.fetch('https://session-deadline.supabase.co/auth/v1/user', { signal: upstream.signal }).catch(e => e);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.ok(signal); upstream.abort(reason); assert.equal(await result, reason);
  t.mock.timers.tick(60000); assert.equal(signal.reason, reason);
});
test('session deadline does not alter mutation transports', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let observed;
  const upstream = new AbortController();
  const api = make(async (_url, init) => { observed = init; return new Response('{}'); });
  await api._client.auth.fetch('https://session-deadline.supabase.co/auth/v1/user', { method: 'PUT', signal: upstream.signal });
  assert.equal(observed.signal, upstream.signal); t.mock.timers.tick(60000); assert.equal(upstream.signal.aborted, false);
});
for (const [status, code] of [[401, 'session_not_found'], [503, 'upstream_unavailable']]) test(`session transport preserves ${status} error classification`, async () => {
  const api = make(async () => new Response(JSON.stringify({ code, message: 'Controlled auth response' }), { status, headers: { 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01' } }));
  const result = await api._client.auth.getUser('fixture-jwt');
  assert.equal(result.data.user, null);
  // The installed Auth SDK maps session_not_found to AuthSessionMissingError (status 400).
  if (status === 401) assert.equal(result.error.name, 'AuthSessionMissingError');
  else assert.equal(result.error.status, status);
});
for (const stage of ['headers', 'body']) test(`refresh ${stage} timeout retains session and does not issue a second refresh`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let signal, attempts = 0;
  const api = make(async (url, init) => {
    if (String(url).includes('/user')) return new Response(JSON.stringify({ id: 'existing-user' }));
    attempts++; signal = init.signal;
    const pending = () => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return stage === 'headers' ? pending() : { ok: true, status: 200, statusText: 'OK', headers: new Headers(), json: pending, arrayBuffer: pending };
  });
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const access = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: 'existing-user', exp: Math.floor(Date.now()/1000)+3600 })}.c2ln`;
  const seeded = await api._client.auth.setSession({ access_token: access, refresh_token: 'retained-refresh-fixture' });
  assert.equal(seeded.error, null);
  const pending = api._client.auth.refreshSession();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(attempts, 1); assert.ok(signal);
  t.mock.timers.tick(30000);
  const failed = await pending;
  assert.match(failed.error.message, /session refresh timed out/i); assert.equal(signal.aborted, true);
  const stored = await api._client.auth.getSession();
  assert.equal(stored.data.session.refresh_token, 'retained-refresh-fixture');
  assert.equal(stored.data.session.access_token, access); assert.equal(attempts, 1);
});
