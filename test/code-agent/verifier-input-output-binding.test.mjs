import test from 'node:test';
import assert from 'node:assert/strict';
import {computedOutputFacts,structuredStepVerdict} from '../../shell/server/lib/appBuild/journeyVerifier.mjs';
const verdict=(surface,expected,inputSurface,extra={})=>structuredStepVerdict({structured:{...computedOutputFacts(surface,expected,{inputSurface}),observationOnly:true,...extra},drove:true,actionProven:true});
test('input-only evidence is a contract gap rather than a computed result',()=>{
 const result=verdict('No result',{quantity:450},'450');
 assert.equal(result.classification,'CONTRACT_INCOMPLETE');
});
test('an independent incorrect result still fails alongside input-only ambiguity',()=>{
 assert.equal(verdict('Total 11',{quantity:450,total:12},'450').classification,'APP_FUNCTIONAL_FAILURE');
});
test('a visible result is valid even when the same number is an input',()=>{
 assert.equal(verdict('450 g',{quantity:450},'450').classification,'PASS');
});
test('unbound input-only output does not invent an unchanged-action defect',()=>{
 const result=verdict('No result',{quantity:450},'450',{observationOnly:false,actionDeclared:true,observedStateChanged:false});
 assert.equal(result.classification,'CONTRACT_INCOMPLETE');
});
