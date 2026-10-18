import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
const { build } = createRequire(fileURLToPath(new URL('../../harness/.deps/package.json', import.meta.url)))('esbuild');
const source = fileURLToPath(new URL('../../supabase/functions/app-accounts/index.ts', import.meta.url));
const bundle = await build({ stdin: { contents: await readFile(source, 'utf8'), loader: 'ts', resolveDir: path.dirname(source) }, bundle: true, format: 'iife', write: false,
  plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /^npm:@supabase\/supabase-js@/ }, () => ({ path: 'client', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const createClient=()=>globalThis.__client', loader: 'js' }));
  } }] });
async function request({ failTable, reject = false, command = 'me', missingMapping = false, suspended = false } = {}) {
  let handler, writes = 0;
  const client = { auth: { getUser: async () => ({ data: { user: { id: 'own-user' } }, error: null }) }, from(table) {
    const result = () => {
      if (table === failTable) {
        if (reject) throw new Error('private upstream credentials detail');
        return { data: null, error: { message: 'private database detail', code: 'XX000' } };
      }
      const data = table === 'app_users' ? (missingMapping ? null : { email: 'own@example.test', status: 'active', auth_user_id: 'own-user' })
        : table === 'app_memberships' ? (suspended ? { email: 'own@example.test', auth_user_id: 'own-user', role: 'member', status: 'suspended' } : null)
        : table === 'app_profiles' ? { data: { displayName: 'Existing profile' } } : null;
      return { data, error: null };
    };
    const chain = { select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; },
      upsert() { writes++; return this; }, insert() { writes++; return this; },
      maybeSingle: async () => result(), single: async () => result(), then: (resolve, reject) => Promise.resolve().then(result).then(resolve, reject) };
    return chain;
  } };
  vm.runInNewContext(bundle.outputFiles[0].text, { Request, Response, URL, TextEncoder, console, __client: client,
    Deno: { env: { get: () => 'fixture' }, serve: fn => { handler = fn; } } });
  const response = await handler(new Request('https://fixture.example/app-accounts', { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, appId: '11111111-1111-4111-8111-111111111111', values: { displayName: 'Changed' } }) }));
  return { status: response.status, body: await response.json(), writes };
}
for (const failTable of ['app_account_policies', 'app_users', 'app_memberships', 'app_profiles']) {
  for (const reject of [false, true]) test(`${failTable} ${reject ? 'transport rejection' : 'query error'} fails closed`, async () => {
    const r = await request({ failTable, reject });
    assert.equal(r.status, 503); assert.equal(r.body.code, 'storage_unavailable'); assert.equal(r.writes, 0);
    assert.doesNotMatch(JSON.stringify(r.body), /private/);
  });
}
test('profile read failure cannot overwrite an existing profile', async () => {
  const r = await request({ failTable: 'app_profiles', command: 'updateMe' });
  assert.equal(r.status, 503); assert.equal(r.writes, 0);
});
test('confirmed absent membership retains documented default-member behavior', async () => {
  const r = await request(); assert.equal(r.status, 200); assert.equal(r.body.profile.displayName, 'Existing profile');
});
test('cross-app identity without mapping remains unauthenticated', async () => { assert.equal((await request({ missingMapping: true })).status, 401); });
test('suspended membership remains forbidden', async () => { assert.equal((await request({ suspended: true })).status, 403); });
