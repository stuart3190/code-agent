import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createIdentityController } from '../../src/scaffolds/reactVite/lib/modules/identity.js';
import { createRouter } from '../../src/scaffolds/reactVite/lib/modules/router.js';
import { compileRoutes } from '../../src/scaffolds/reactVite/lib/modules/routing.js';
import { composeScaffoldFoundation, renderScaffoldFoundation, ROUTE_STATES_PATH } from '../../shell/server/lib/builderV2/scaffoldComposer.mjs';
const require = createRequire(new URL('../../harness/.deps/package.json', import.meta.url));
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), { transformSync } = require('esbuild');
const graph = { screens: [{ screenId:'home', module:'src/screens/Home.jsx', routePath:'/' }] };
const routePlan = { routes: [{ id:'home', path:'/', screen:'src/screens/Home.jsx' }] };
const prior = readFileSync(new URL('./fixtures/reliability-20261016/retry-route-states.jsx', import.meta.url), 'utf8');
function render(reason) {
  const source = renderScaffoldFoundation(graph, { routePlan }).screenFiles[ROUTE_STATES_PATH];
  const module = { exports: {} };
  vm.runInNewContext(transformSync(source, { loader:'jsx', format:'cjs' }).code, { module, exports:module.exports, React });
  return renderToStaticMarkup(React.createElement(module.exports.default, { state:'error', reason, error:{ message:'PRIVATE backend diagnostic' }, onRetry(){} }));
}
test('known refresh timeout remains a typed recoverable route error', async () => {
  let failed = true;
  const identity = createIdentityController({ auth: { currentUser: async () => { if(failed) throw new Error('The session refresh timed out. Please try again in a minute.'); return {id:'same-member'}; } } });
  const router = createRouter({ table:compileRoutes([{id:'home',path:'/',guard:'member'}]), identity, history:null, currentPath:()=> '/' });
  await router.resolve('/'); assert.equal(router.getState().state, 'error'); assert.equal(router.getState().reason, 'session_refresh_timeout');
  failed = false; await router.reload(); assert.equal(router.getState().state, 'ready'); assert.equal(identity.getState().principal.id, 'same-member');
});
test('default route UI gives safe cooldown guidance without backend diagnostics', () => {
  const html = render('session_refresh_timeout'); assert.match(html, /try again in a minute/i); assert.doesNotMatch(html, /PRIVATE/); assert.match(html, /<button/);
  const unknown = render('unknown_private_error'); assert.doesNotMatch(unknown, /PRIVATE|in a minute/); assert.match(unknown, /could not load this page/);
});
test('only exact historical retry default receives cooldown guidance', () => {
  const result = composeScaffoldFoundation({[ROUTE_STATES_PATH]:prior}, graph, {routePlan});
  assert.match(result.tree[ROUTE_STATES_PATH], /session_refresh_timeout/); assert.deepEqual(result.defaultSlotsUpgraded, [ROUTE_STATES_PATH]);
  assert.deepEqual(composeScaffoldFoundation(result.tree, graph, {routePlan}).defaultSlotsUpgraded, []);
  for(const authored of [prior+'\n// authored presentation', prior.replace('Loading…','Preparing your workspace…')]) {
    assert.equal(composeScaffoldFoundation({[ROUTE_STATES_PATH]:authored}, graph, {routePlan}).tree[ROUTE_STATES_PATH], authored);
  }
});
