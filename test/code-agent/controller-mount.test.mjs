import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {mountDeclaredControllers} from '../../shell/server/lib/builderV2/controllerMount.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/reliability-20261016/expense-unmounted-controller.json',import.meta.url)));
const screen='src/screens/scaffold/PocketLedgerScreen.jsx',summary='src/screens/scaffold/SummaryScreen.jsx';
const controller=fixture.modulePlan.find(row=>row.path===screen).journeyController;
function run(tree=fixture.sources,options=fixture){return mountDeclaredControllers(tree,options);}
test('retained expense controller is mounted once without inventing its summary route',()=>{
 const result=run();assert.deepEqual(result.changes,[{file:screen,controller,rewrite:'mount_declared_controller'}]);
 assert.match(result.tree[screen],/import JourneyController from "..\/..\/components\/create-monthly-expenses\/CreateMonthlyExpensesFlow.jsx"/);
 assert.equal((result.tree[screen].match(/<JourneyController/g)||[]).length,1);
 assert.equal(result.tree[controller],fixture.sources[controller]);assert.equal(result.tree[summary],fixture.sources[summary]);
 assert.deepEqual(run(result.tree).changes,[]);assert.notEqual(result.tree,fixture.sources);
 assert.match(fixture.sources[screen],/Application screen ready/);
});
for(const [name,mutate] of [
 ['customized screen',tree=>tree[screen]+='\n// user customization'],
 ['missing screen',tree=>delete tree[screen]],
 ['missing controller',tree=>delete tree[controller]],
 ['invalid controller syntax',tree=>tree[controller]='export default function {'],
 ['comment-only default export',tree=>tree[controller]='// export default function Fake(){}\nexport const value=1;'],
 ['named-export-only controller',tree=>tree[controller]='export function Flow(){return null}'],
 ['non-component default export',tree=>tree[controller]='export default 42;'],
 ['asynchronous controller',tree=>tree[controller]='export default async function Flow(){return null}'],
])test(`controller mount abstains on ${name}`,()=>{const tree={...fixture.sources};mutate(tree);assert.deepEqual(run(tree).changes,[]);});
for(const [name,mutate] of [
 ['missing graph',options=>options.scaffoldGraph=null],
 ['duplicate screen identity',options=>options.modulePlan.push({...options.modulePlan.find(x=>x.path===screen)})],
 ['missing controller ownership',options=>options.modulePlan=options.modulePlan.filter(x=>x.path!==controller)],
 ['conflicting controller ownership',options=>options.modulePlan.find(x=>x.path===controller).sharedControllerFor='other-screen'],
])test(`controller mount abstains on ${name}`,()=>{const options=structuredClone(fixture);mutate(options);assert.deepEqual(run(fixture.sources,options).changes,[]);});
