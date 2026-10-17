import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticAppEmail } from '../../supabase/functions/_shared/appIdentity.mjs';

const appId = '11111111-1111-4111-8111-111111111111';
test('existing app-auth address protocol stays byte compatible', async () => {
  assert.equal(await syntheticAppEmail(appId, 'Audit@Example.Test'),
    'u.d163cf1167cdf3f037f0a1711cc9823c@apps.thrallo.com');
});
test('account namespaces isolate the same email between apps', async () => {
  assert.notEqual(await syntheticAppEmail(appId, 'audit@example.test'),
    await syntheticAppEmail('22222222-2222-4222-8222-222222222222', 'audit@example.test'));
});
