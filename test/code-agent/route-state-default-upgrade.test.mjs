import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import{composeScaffoldFoundation,renderScaffoldFoundation,ROUTE_STATES_PATH}from'../../shell/server/lib/builderV2/scaffoldComposer.mjs';
const legacy=readFileSync(new URL('./fixtures/reliability-20261016/legacy-route-states.jsx',import.meta.url),'utf8');
const graph={screens:[{screenId:'home',module:'src/screens/Home.jsx',routePath:'/'}]},routePlan={routes:[{id:'home',path:'/',screen:'src/screens/Home.jsx'}]};
test('unmodified historical route-state default receives working retry on recomposition',()=>{
 const tree={[ROUTE_STATES_PATH]:legacy,'src/screens/Home.jsx':'authored screen'};const r=composeScaffoldFoundation(tree,graph,{routePlan});
 assert.equal(r.tree[ROUTE_STATES_PATH],renderScaffoldFoundation(graph,{routePlan}).screenFiles[ROUTE_STATES_PATH]);assert.match(r.tree[ROUTE_STATES_PATH],/onClick=\{onRetry\}/);assert.equal(r.tree['src/screens/Home.jsx'],'authored screen');assert.equal(tree[ROUTE_STATES_PATH],legacy);
 assert.deepEqual(r.defaultSlotsUpgraded,[ROUTE_STATES_PATH]);assert.deepEqual(composeScaffoldFoundation(r.tree,graph,{routePlan}).defaultSlotsUpgraded,[]);
});
for(const authored of [legacy+'\n// custom presentation',legacy.replace('Loading…','Opening your ledger…'),'export default function RouteStates(){return null}'])test('authored route presentation remains byte exact: '+authored.length,()=>{
 const r=composeScaffoldFoundation({[ROUTE_STATES_PATH]:authored},graph,{routePlan});assert.equal(r.tree[ROUTE_STATES_PATH],authored);
});
test('non-routed composition does not migrate an unused route slot',()=>{
 const r=composeScaffoldFoundation({[ROUTE_STATES_PATH]:legacy},graph,{routePlan:null});assert.equal(r.tree[ROUTE_STATES_PATH],legacy);
});
