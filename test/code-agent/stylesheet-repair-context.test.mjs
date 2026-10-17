import test from 'node:test';import assert from 'node:assert/strict';import {renderPrecompileRepairContext} from '../../shell/server/lib/builderV2/modelLanes.mjs';
test('stylesheet correction sees actual consumer markup without widening writes',()=>{
 const tree={'src/index.css':'@tailwind base;','src/components/Recipe.jsx':'export default function Recipe(){return <section className="actual-card"><button className="actual-action">Scale</button></section>}', 'src/lib/platform.jsx':'PRIVATE_PLATFORM_SENTINEL'};
 const scope={kind:'stylesheet_patch_correction',files:['src/index.css'],allowedFiles:['src/index.css'],readOnlyFiles:['src/components/Recipe.jsx','src/lib/platform.jsx']};let trace;
 const text=renderPrecompileRepairContext(tree,{repairScope:scope,onRetrieval:t=>trace=t});assert.match(text,/actual-card/);assert.match(text,/READ ONLY retained markup/);assert.doesNotMatch(text,/PRIVATE_PLATFORM_SENTINEL/);assert.deepEqual(scope.allowedFiles,['src/index.css']);assert.equal(trace.included.find(x=>x.path==='src/components/Recipe.jsx').reason,'read-only CSS consumers');
});
test('consumer context is bounded and unavailable to unrelated repair scopes',()=>{
 const tree={'src/index.css':'@tailwind base;'};for(let i=0;i<10;i++)tree[`src/components/C${i}.jsx`]='x'.repeat(15000);
 const scope={kind:'stylesheet_patch_correction',files:['src/index.css'],readOnlyFiles:Object.keys(tree)};let trace;renderPrecompileRepairContext(tree,{repairScope:scope,onRetrieval:t=>trace=t});assert.ok(trace.tokens<=7510);assert.equal(trace.included.filter(x=>x.reason==='read-only CSS consumers').length,3);
 assert.doesNotMatch(renderPrecompileRepairContext(tree,{repairScope:{...scope,kind:'imports'}}),/READ-ONLY CSS CONSUMERS/);
});
