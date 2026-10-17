import test from 'node:test';import assert from 'node:assert/strict';
import {computedOutputFacts} from '../../shell/server/lib/appBuild/journeyVerifier.mjs';
for(const [surface,expected] of [['Result: 1e3',1000],['Result: 1e-3',0.001],['Result: 1.25E+3 W',1250],['Result: -2.5e2 kg',-250],['Result: 1000','1e3']])test(`scientific numeric output compares its complete value: ${surface}/${expected}`,()=>{
 const facts=computedOutputFacts(surface,{result:expected});assert.equal(facts.missingComputedOutputs.length,0);assert.equal(facts.precisionAmbiguousComputedOutputs.length,0);
});
for(const [surface,expected] of [['Result: 1e3',1],['Result: 1e-3',1],['Result: 1e-3',-3],['Result: 1.25E+3 W',1.25],['Result: 1e309',1]])test(`scientific exponent cannot be ignored to certify ${expected}: ${surface}`,()=>{
 const facts=computedOutputFacts(surface,{result:expected});assert.equal(facts.missingComputedOutputs.length,1);
});
for(const [surface,expected] of [['Total: 1000001',1000000],['Total: 1000000000000001',1000000000000000],['Result: 0.0000009',0],['Result: 1.0000002',1.0000001]])test(`numeric tolerance cannot hide a different result: ${surface}/${expected}`,()=>{
 const facts=computedOutputFacts(surface,{result:expected});assert.equal(facts.missingComputedOutputs.length,1);assert.equal(facts.precisionAmbiguousComputedOutputs.length,0);
});
test('binary floating-point addition noise remains equivalent',()=>{assert.equal(computedOutputFacts('Result: 0.3',{result:0.1+0.2}).missingComputedOutputs.length,0);});
test('scientific presentation uncertainty respects exponent precision',()=>{
 const plausible=computedOutputFacts('Result: 1.23e-3',{result:0.001234});assert.equal(plausible.precisionAmbiguousComputedOutputs.length,1);
 const wrong=computedOutputFacts('Result: 1.23e-3',{result:0.00124});assert.equal(wrong.missingComputedOutputs.length,1);assert.equal(wrong.precisionAmbiguousComputedOutputs.length,0);
});
test('an underflowed nonzero scientific token cannot certify zero',()=>{
 assert.equal(computedOutputFacts('Result: 1e-400',{result:0}).missingComputedOutputs.length,1);
 assert.equal(computedOutputFacts('Result: 0e-400',{result:0}).missingComputedOutputs.length,0);
});
for(const surface of ['Paint cost £216.00\nTotal estimate','Paint cost £216.00\r\nTotal estimate','Paint cost £216.00\tTotal estimate'])test(`numeric value before whitespace and a label remains observable: ${JSON.stringify(surface)}`,()=>{
 assert.equal(computedOutputFacts(surface,{paintCost:216}).missingComputedOutputs.length,0);
});
test('whitespace normalization does not concatenate separate numeric lines',()=>{assert.equal(computedOutputFacts('12\n345',{total:12345}).missingComputedOutputs.length,1);});
