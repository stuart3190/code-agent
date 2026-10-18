import test from 'node:test';import assert from 'node:assert/strict';
import {causalRepairBoundary} from '../../shell/server/lib/builderV2/repairGovernance.mjs';
import {headroomDispatchScope} from '../../shell/server/lib/builderV2/modelLanes.mjs';
test('causal repair reads platform dependencies without scheduling impossible writes',()=>{
 const owner='src/screens/scaffold/Recipe.jsx',custom='src/extensions/custom/scale.js';
 const protectedFiles=['src/lib/app/index.js','src/lib/capabilities/composed/interaction-primitives.js','src/lib/scaffolds/composed/ScaffoldApp.jsx','src/App.jsx'];
 const tree=Object.fromEntries([...protectedFiles,owner,custom,'src/lib/scaffolds/composed/manifest.js'].map(p=>[p,'export const x=1;']));
 const boundary=causalRepairBoundary({owners:[owner],tree,contract:{scaffoldGraph:{}},graph:{neighbors:()=>[custom,...protectedFiles]}});
 assert.deepEqual(new Set(boundary.allowedFiles),new Set([owner,custom]));
 assert.deepEqual(new Set(boundary.contextFiles),new Set(protectedFiles));
 const split=headroomDispatchScope({tree,repairScope:boundary,logicalStep:'repair'});
 assert.deepEqual(new Set([...split.allowedFiles,...split.remainingFiles]),new Set([owner,custom]));
 assert.ok(![...split.allowedFiles,...split.remainingFiles].some(p=>protectedFiles.includes(p)));
});
test('protected neighbors do not consume the bounded writable-file allowance',()=>{
 const owner='src/screens/Recipe.jsx',tree={[owner]:'export default 1;'};
 const dependencies=Array.from({length:30},(_,n)=>`src/lib/app/protected-${n}.js`);
 for(const p of dependencies)tree[p]='export default 1;';
 const boundary=causalRepairBoundary({owners:[owner],tree,maxFiles:1,graph:{neighbors:()=>dependencies}});
 assert.deepEqual(boundary.allowedFiles,[owner]);assert.equal(boundary.contextFiles.length,30);
});
