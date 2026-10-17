import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transientSeedState, contractBrief} from '../../shell/shared/implementationContract.mjs';
import {buildInteractionContract} from '../../shell/server/lib/builderV2/interactionContract.mjs';
const fixture=JSON.parse(await readFile(new URL('./fixtures/reliability-20261016/recipe-transient-seed-contract.json',import.meta.url)));
const clone=()=>structuredClone(fixture);
test('generation brief preserves the requested seed quantities, units and visible outcomes',()=>{
 const brief=contractBrief(clone());
 assert.match(brief,/"quantity":300,"unit":"g"/);
 assert.match(brief,/"quantity":600,"unit":"ml"/);
 assert.match(brief,/"quantity":2,"unit":"tsp"/);
 assert.match(brief,/visible outcomes:/);
 assert.match(brief,/transient state:/);
 assert.doesNotMatch(brief,/PERSISTED DATA — these must go through/);
});
test('retained recipe contract uses its explicit initial seed without inventing additional input steps',()=>{
 const c=clone(),plan=buildInteractionContract(c);assert.equal(plan.valid,true,plan.problems.join('; '));
 assert.equal(plan.scenarios['scale-initial-recipe'].initialState.originalServings,4);
 assert.deepEqual(plan.scenarios['scale-initial-recipe'].initialState.ingredients,c.sampleData[0].values.ingredients);
 delete c.sampleData;assert.ok(buildInteractionContract(c).problems.some(p=>/reads state before it is produced/.test(p)));
});
test('canonical entity-keyed seed rows carry the same authority as an explicit entity declaration',()=>{
 const c=clone();c.sampleData={calculatorState:[c.sampleData[0].values]};assert.equal(buildInteractionContract(c).valid,true);
});
for(const [name,change] of [
 ['persistent entity',c=>c.entities[0].storage='persistent'],
 ['conflicting declaration storage',c=>c.sampleData[0].storage='persistent'],
 ['ambiguous declarations',c=>c.sampleData.push(structuredClone(c.sampleData[0]))],
 ['ambiguous entity field',c=>c.entities.push({name:'other',storage:'transient',fields:[{name:'originalServings',type:'number'}]})],
 ['wrong numeric type',c=>c.sampleData[0].values.originalServings='4'],
 ['conflicting explicit default',c=>c.entities[0].fields[0].default=2],
])test(`seed authority excludes ${name}`,()=>{const c=clone();change(c);assert.equal(Object.hasOwn(transientSeedState(c,c.entities[0]),'originalServings'),false);});
test('a non-entry journey cannot borrow transient sample rows as prior state',()=>{
 const c=clone();for(const j of c.journeys)j.steps[0].target='existing workspace';
 assert.ok(buildInteractionContract(c).problems.some(p=>/reads state before it is produced/.test(p)));
});
