import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {normalizeScaffoldPatchForms} from '../../shell/server/lib/builderV2/scaffoldPatchForms.mjs';
import {REACT_VITE} from '../../src/scaffolds/reactVite.mjs';
import {validateModulePatchScope} from '../../shell/server/lib/builderV2/moduleContracts.mjs';
import {applyPatches} from '../../shell/server/lib/builderV2/patchEngine.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/reliability-20261016/expense-unmounted-controller.json',import.meta.url)));
const screen='src/screens/scaffold/SummaryScreen.jsx';
const options={...fixture,baseline:REACT_VITE};
const originalTree={...REACT_VITE,...fixture.sources};
const run=(patches=fixture.patches,tree=originalTree,opts=options)=>normalizeScaffoldPatchForms(patches,tree,opts);
test('retained full screen modules and CSS are recovered without inventing or mutating their bytes',()=>{
 const before=structuredClone(fixture),result=run();
 assert.deepEqual(result.conversions.map(x=>x.file),['src/screens/scaffold/PocketLedgerScreen.jsx',screen,'src/index.css']);
 for(const conversion of result.conversions){const old=fixture.patches.find(p=>(p.file||p.newFile)===conversion.file),next=result.patches.find(p=>p.replaceFile===conversion.file);assert.equal(next.content,old.content??old.ops[0].content);}
 assert.deepEqual(fixture,before);
 const restored=applyPatches(originalTree,result.patches,{contract:fixture.contract});
 for(const conversion of result.conversions)assert.equal(restored.tree[conversion.file],result.patches.find(p=>p.replaceFile===conversion.file).content);
 assert.match(restored.tree[screen],/Category totals/);assert.match(restored.tree['src/index.css'],/ledger/);
});
for(const [name,mutate] of [
 ['authored screen',(p,t,o)=>t[screen]+='\n// authored'],
 ['missing screen',(p,t,o)=>delete t[screen]],
 ['missing graph',(p,t,o)=>o.scaffoldGraph=null],
 ['missing ownership',(p,t,o)=>o.modulePlan=o.modulePlan.filter(r=>r.path!==screen)],
 ['ambiguous ownership',(p,t,o)=>o.modulePlan.push({...o.modulePlan.find(r=>r.path===screen)})],
 ['duplicate patch target',(p,t,o)=>p.push(structuredClone(p.find(r=>r.file===screen)))],
 ['invalid module syntax',(p,t,o)=>p.find(r=>r.file===screen).ops[0].content='export default function {'],
 ['noncomponent export',(p,t,o)=>p.find(r=>r.file===screen).ops[0].content='export default 42;'],
 ['async default export',(p,t,o)=>p.find(r=>r.file===screen).ops[0].content='export default async function Page(){}'],
 ['extra operation',(p,t,o)=>p.find(r=>r.file===screen).ops.push({op:'append',content:'// more'})],
])test(`screen patch recovery abstains on ${name}`,()=>{const p=structuredClone(fixture.patches),t={...originalTree},o=structuredClone(options);mutate(p,t,o);assert.equal(run(p,t,o).conversions.some(r=>r.file===screen),false);});
for(const [name,mutate] of [
 ['authored CSS',(p,t,o)=>t['src/index.css']+='\n/* authored */'],
 ['missing baseline',(p,t,o)=>o.baseline=null],
 ['missing content',(p,t,o)=>p.find(r=>r.newFile==='src/index.css').content=null],
 ['duplicate CSS target',(p,t,o)=>p.push({replaceFile:'src/index.css',content:'body{}'})],
])test(`stylesheet recovery abstains on ${name}`,()=>{const p=structuredClone(fixture.patches),t={...originalTree},o=structuredClone(options);mutate(p,t,o);assert.equal(run(p,t,o).conversions.some(r=>r.file==='src/index.css'),false);});
test('internal dispatch scope survives normalization without being widened',()=>{const p=structuredClone(fixture.patches);p.dispatchScope={kind:'headroom_continuation',files:['src/index.css']};assert.equal(run(p).patches.dispatchScope,p.dispatchScope);});

test('recovered forms still fail the existing write scope when their files are not authorized',()=>{
 const normalized=run().patches;
 const scope={kind:'headroom_continuation',allowedFiles:['src/index.css']};
 assert.equal(validateModulePatchScope(normalized,scope).ok,false);
 assert.equal(validateModulePatchScope(normalized.filter(p=>p.replaceFile==='src/index.css'),scope).ok,true);
});
