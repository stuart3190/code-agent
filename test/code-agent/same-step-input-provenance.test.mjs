import {test} from 'node:test';import assert from 'node:assert/strict';
import {normalizeInteractionStateDependencies} from '../../shell/server/lib/builderV2/interactionContract.mjs';
const plan=()=>({flows:[
 {id:'field',journeyId:'j',stepIndex:2,kind:'input',writes:['j.draft.quantity'],control:{logicalField:'quantity',statePath:'j.draft.quantity'}},
 {id:'compute',journeyId:'j',stepIndex:2,kind:'action',operationId:'calculate',reads:['j.input.quantity'],dependsOn:['j.input.quantity'],writes:['j.custom.total']},
]});
test('same-step explicit control becomes the transient invocation input without mutating the source plan',()=>{
 const source=plan();const r=normalizeInteractionStateDependencies(source);
 assert.deepEqual(r.plan.flows[1].reads,['j.draft.quantity']);assert.deepEqual(r.plan.flows[1].dependsOn,['j.draft.quantity']);
 assert.equal(r.rebindings[0].reason,'same_step_control_input');assert.deepEqual(source.flows[1].reads,['j.input.quantity']);
});
for(const [name,mutate] of [
 ['other step',p=>p.flows[0].stepIndex=1],['other journey',p=>p.flows[0].journeyId='other'],
 ['different field',p=>p.flows[0].control.logicalField='price'],['no control',p=>delete p.flows[0].control],
 ['durable operation',p=>p.flows[1].durableLifecycle=true],['persistence handoff',p=>p.flows[1].persistenceHandoff={entity:'item'}],
 ['persistence responsibility',p=>p.flows[1].semanticResponsibilityTypes=['persistence']],
 ['durable state write',p=>p.flows[1].writes=['j.durable.items']],
 ['non-operation flow',p=>delete p.flows[1].operationId],
])test(`input provenance does not guess across ${name}`,()=>{const p=plan();mutate(p);assert.deepEqual(normalizeInteractionStateDependencies(p).plan.flows[1].reads,['j.input.quantity']);});
