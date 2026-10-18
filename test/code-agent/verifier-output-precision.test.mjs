import test from 'node:test';import assert from 'node:assert/strict';
import {computedOutputFacts,structuredStepVerdict} from '../../shell/server/lib/appBuild/journeyVerifier.mjs';
const verdict=(surface,expected,extra={})=>structuredStepVerdict({structured:{...computedOutputFacts(surface,expected),observationOnly:true,...extra},drove:true,actionProven:true});
test('legacy unrounded quote area requires a presentation contract rather than an app repair',()=>{
 assert.equal(verdict('Wall area 37.16 m²',{wallArea:37.161216}).classification,'CONTRACT_INCOMPLETE');
});
test('a one-decimal presentation of a higher precision value cannot be certified',()=>{
 assert.equal(verdict('Area 37.2 m²',{wallArea:37.161216}).classification,'CONTRACT_INCOMPLETE');
});
test('an independently wrong numeric output remains a real failure',()=>{
 assert.equal(verdict('Area 37.16 m² Total 11',{wallArea:37.161216,total:12}).classification,'APP_FUNCTIONAL_FAILURE');
});
test('incorrect decimals and integer mismatches are not inferred to be rounding',()=>{
 for(const surface of ['Area 37.17 m²','Area 38 m²','Area 37 m²'])assert.equal(verdict(surface,{wallArea:37.161216}).classification,'APP_FUNCTIONAL_FAILURE',surface);
});
test('explicitly rounded expected output still requires the correct number',()=>{
 assert.equal(verdict('Area 37.16 m²',{wallArea:37.16}).classification,'PASS');
 assert.equal(verdict('Area 37.17 m²',{wallArea:37.16}).classification,'APP_FUNCTIONAL_FAILURE');
});
test('precision ambiguity does not invent an unchanged-action defect',()=>{
 assert.equal(verdict('Area 37.16 m²',{wallArea:37.161216},{observationOnly:false,actionDeclared:true,observedStateChanged:false}).classification,'CONTRACT_INCOMPLETE');
});
