import{isDeepStrictEqual}from'node:util';import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';
import{deriveBuildSpec}from'../../shell/server/lib/builderV2/buildSpec.mjs';
import{persistContract}from'../../shell/server/lib/builderV2/contractTiering.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/reliability-20261016/expense-unmounted-controller.json',import.meta.url)));
for(const inheritedIntents of [undefined,[],[{slot:'old',intent:'obsolete'}]])test(`derived contract, diagnostic input and stored record remain identical with ${JSON.stringify(inheritedIntents)} inherited intents`,async()=>{
 const raw={...fixture.contract,...(inheritedIntents===undefined?{}:{imageIntents:inheritedIntents})};const before=JSON.stringify(raw);const spec=deriveBuildSpec(raw);let stored;
 const client={from(table){assert.equal(table,'bv2_contracts');const q={select(){return q},eq(){return q},order(){return q},limit(){return q},async maybeSingle(){return{data:{version:4},error:null}},insert(row){stored=row;return q},async single(){return{data:{id:'contract',version:5},error:null}}};return q}};
 await persistContract('owner','project',{buildId:'build',contract:spec.contract,tiers:spec.tiers,bindings:spec.bindings,intents:spec.imageIntents},{client});
 assert.equal(JSON.stringify(raw),before,'derivation must not mutate source contract');
 assert.ok(spec.imageIntents.length>0);
 assert.ok(isDeepStrictEqual(stored.contract,spec.contract),'persisted contract must equal the execution/diagnostic contract');
 assert.deepEqual(spec.contract.imageIntents,spec.imageIntents);
 assert.deepEqual(spec.contract.tiers,spec.tiers);
});
