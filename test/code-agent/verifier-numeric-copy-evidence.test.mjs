import test from 'node:test';import assert from 'node:assert/strict';
import {computedOutputFacts,structuredStepVerdict} from '../../shell/server/lib/appBuild/journeyVerifier.mjs';
const check=facts=>structuredStepVerdict({structured:{observationOnly:true,...facts},drove:true,actionProven:true});
test('missing declared numeric results cannot pass merely because inputs hold their fixtures',()=>{
 const result=check({explicitVisibleText:['rice 450 g','water 900 ml','salt 3 tsp'],explicitVisibleTextMissing:['rice 450 g','water 900 ml','salt 3 tsp'],inputDeclared:true,inputsAccepted:true});
 assert.equal(result.classification,'CONTRACT_INCOMPLETE');assert.notEqual(result.status,'pass');
});
test('numeric presentation changes need structured evidence rather than an invented calculation failure',()=>{
 assert.equal(check({explicitVisibleText:['Total $12.50'],explicitVisibleTextMissing:['Total $12.50'],...computedOutputFacts('USD 12.5',{total:12.5})}).classification,'CONTRACT_INCOMPLETE');
});
test('a missing advisory phrase cannot turn an unbound boolean into an application defect',()=>{
 assert.equal(check({explicitVisibleText:['Result panel'],explicitVisibleTextMissing:['Result panel'],...computedOutputFacts('9 lights',{count:9,resultVisible:true})}).classification,'CONTRACT_INCOMPLETE');
});
test('an actual wrong number still fails alongside missing numeric copy',()=>{
 assert.equal(check({explicitVisibleText:['Total 9'],explicitVisibleTextMissing:['Total 9'],...computedOutputFacts('8',{total:9})}).classification,'APP_FUNCTIONAL_FAILURE');
});
test('observed numeric copy passes and ordinary wording changes remain advisory',()=>{
 assert.equal(check({explicitVisibleText:['rice 450 g'],explicitVisibleTextMissing:[]}).classification,'PASS');
 assert.equal(check({explicitVisibleText:['Ingredient list'],explicitVisibleTextMissing:['Ingredient list']}).classification,'PASS');
});
