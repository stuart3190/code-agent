import test from 'node:test';import assert from 'node:assert/strict';
import {assemblyNeeds} from '../../shell/server/lib/builderV2/interactionContract.mjs';
import {preferredAssemblyBrief} from '../../shell/server/lib/builderV2/capabilityRegistry.mjs';
test('CRUD mutation/lookup does not advertise an unsupported state hook',()=>{
 const needs=assemblyNeeds({flows:[{kind:'mutation'},{kind:'lookup'}]},[{name:'crud'}]);assert.equal(needs.capabilityState,false);assert.equal(needs.entities,true);
 const brief=preferredAssemblyBrief(needs);assert.match(brief,/Await list\(\)/);assert.match(brief,/refresh after create\/update\/remove/);assert.match(brief,/fields under values/);assert.doesNotMatch(brief,/const state = useCapabilityState/);
});
test('real stateful wizard retains reactive-state guidance',()=>{
 assert.equal(assemblyNeeds({flows:[{kind:'mutation'}]},[{name:'wizard'}]).capabilityState,true);
});
