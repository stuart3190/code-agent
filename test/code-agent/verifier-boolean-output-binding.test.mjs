import test from 'node:test';import assert from 'node:assert/strict';
import {computedOutputFacts,structuredStepVerdict} from '../../shell/server/lib/appBuild/journeyVerifier.mjs';
import {isAppRepairableVerificationClass} from '../../shell/server/lib/appBuild/verifierPolicy.mjs';
const verdict=(surface,expected)=>structuredStepVerdict({structured:{...computedOutputFacts(surface,expected),observationOnly:true},drove:true,actionProven:true});
for(const [surface,expected] of [['9 downlights',{resultVisible:true}],['No results',{resultVisible:false}],['true appears in unrelated help',{resultVisible:true}]])test(`boolean state without an observable binding is incomplete: ${JSON.stringify(expected)} / ${surface}`,()=>{
 const result=verdict(surface,expected);assert.equal(result.classification,'CONTRACT_INCOMPLETE');assert.equal(isAppRepairableVerificationClass(result.classification),false);assert.notEqual(result.status,'pass');
});
test('an independently wrong numeric result remains an app failure despite an unbound boolean',()=>assert.equal(verdict('8 downlights',{count:9,resultVisible:true}).classification,'APP_FUNCTIONAL_FAILURE'));
test('a correct number does not make an unbound internal flag observable',()=>assert.equal(verdict('9 downlights',{count:9,resultVisible:true}).classification,'CONTRACT_INCOMPLETE'));
test('a declared literal text output remains directly verifiable',()=>assert.equal(verdict('true',{answer:'true'}).classification,'PASS'));
test('unbound state does not invent a failed transition when the numeric outcome is already correct',()=>{
 const result=structuredStepVerdict({structured:{...computedOutputFacts('9 downlights',{count:9,resultVisible:true}),actionDeclared:true,observedStateChanged:false},drove:true,actionProven:true});
 assert.equal(result.classification,'CONTRACT_INCOMPLETE');assert.equal(result.checks.find(c=>c.kind==='action').ok,true);
});

test('unbound boolean defects cannot consume generated-app repair allowance', async () => {
 const {verificationDefects,actionableDefects}=await import('../../shell/server/lib/builderV2/verificationDefects.mjs');
 const step={action:'show the result',produces:['resultVisible'],expectedOutputs:{resultVisible:true}};
 const result=verdict('9 downlights',step.expectedOutputs);
 const contract={journeys:[{id:'calculate',steps:[step]}]};
 const defects=verificationDefects({contract,journeyResults:{verifierPolicy:'minimal_contract_v1',journeys:[{id:'calculate',status:result.status,steps:[{...step,...result}]}]}});
 assert.equal(defects.length,1);assert.equal(defects[0].defectClass,'contract');
 assert.equal(defects[0].owner,'platform');assert.equal(defects[0].tier,'none');
 assert.deepEqual(actionableDefects(defects),[]);
});

test('an unchanged action with only an unbound flag is inconclusive, never an invented app defect',()=>{
 const result=structuredStepVerdict({structured:{...computedOutputFacts('No results',{resultVisible:false}),actionDeclared:true,observedStateChanged:false},drove:true,actionProven:true});
 assert.equal(result.classification,'CONTRACT_INCOMPLETE');
});
test('a declared numeric failure still blocks an unchanged action with an unbound flag',()=>{
 const result=structuredStepVerdict({structured:{...computedOutputFacts('8 downlights',{count:9,resultVisible:true}),actionDeclared:true,observedStateChanged:false},drove:true,actionProven:true});
 assert.equal(result.classification,'APP_FUNCTIONAL_FAILURE');
});
