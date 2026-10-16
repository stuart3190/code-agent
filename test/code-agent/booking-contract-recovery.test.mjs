import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {deriveBuildSpec} from '../../shell/server/lib/builderV2/buildSpec.mjs';
import {validateInteractionContract} from '../../shell/server/lib/builderV2/interactionContract.mjs';
import {validateContract} from '../../shell/shared/implementationContract.mjs';
const fixture=()=>JSON.parse(readFileSync(new URL('../fixtures/reliability/booking-contract-20261017.json',import.meta.url),'utf8'));
test('retained live cancellation keeps its distinct deterministic persistence owner',()=>{
 const s=deriveBuildSpec(fixture());const flow=s.interactionContract.flows.find(f=>f.kind==='cancellation');assert.equal(flow.capability,null);assert.equal(flow.durableCapability,'makeEntityStore');assert.equal(flow.durableOperation,'update');
 const verdict=validateInteractionContract(s.interactionContract,{capabilityGraph:s.capabilityGraph});assert.equal(verdict.problems.some(p=>p.includes('cancellation has no durable operation owner')),false);
 flow.durableCapability=null;assert.ok(validateInteractionContract(s.interactionContract,{capabilityGraph:s.capabilityGraph}).problems.some(p=>p.includes('cancellation has no durable operation owner')));
});
test('a prior asserted generated status is available without inventing an editable status input',()=>{
 const c=fixture();const v=validateContract(c);assert.equal(v.ok,true,JSON.stringify(v.problems));
 const cancel=c.journeys[0].steps.find(s=>s.operates?.includes('cancel-booking'));assert.equal(cancel.verificationValues,undefined);
 delete c.journeys[0].steps[4].expectedOutputs.status;
 assert.ok(validateContract(c).problems.some(p=>p.includes('requires verificationValues.status')),'current expected cancelled status cannot satisfy its own required input');
});
