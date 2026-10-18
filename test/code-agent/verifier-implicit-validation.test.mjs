import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {readFileSync} from 'node:fs';
import {deriveBuildSpec} from '../../shell/server/lib/builderV2/buildSpec.mjs';
import {verifyJourneys} from '../../shell/server/lib/appBuild/journeyVerifier.mjs';
const retained=JSON.parse(readFileSync(new URL('./fixtures/reliability-20261016/recipe-shared-seed-contract.json',import.meta.url)));
for (const mode of ['implicit','explicit','computed','durable']) test(`negative validation operation preserves ${mode} authority`, {timeout:120000}, async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<main><label>Original servings<input name="originalServings" aria-label="Original servings" data-thrallo-control="ctl_27002987" type="number" min="1" value="4" oninput="document.querySelector('p').textContent='Use positive serving values'"></label><label>Desired servings<input name="desiredServings" aria-label="Desired servings" data-thrallo-control="ctl_0e4b822c" type="number" min="1" value="4" oninput="document.querySelector('p').textContent='Use positive serving values'"></label><p></p></main>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const contract=deriveBuildSpec(retained).contract;
  contract.journeys=contract.journeys.filter(j=>j.id==='validate-serving-counts');
  const targetIndex = mode === 'durable' ? 1 : 2;
  if(mode==='explicit') contract.journeys[0].steps[2].action += ' and click Validate';
  if(mode==='computed') contract.journeys[0].steps[2].expectedOutputs={hasValidScale:false};
  if(mode==='durable') {
    const flow=contract.interactionContract.flows.find(f=>f.journeyId==='validate-serving-counts'&&f.stepIndex===1&&f.kind==='action');
    flow.persistenceHandoff={entity:'recipe'};
  }
  const result=await verifyJourneys({previewUrl:`http://127.0.0.1:${server.address().port}`,contract,timeoutMs:90000,verifierPolicy:'minimal_contract_v1'});
  const steps=result.journeys[0].steps;
  assert.equal(steps[1].controlEvidence.fields[0].status,'filled');
  assert.equal(steps[targetIndex].controlEvidence.fields[0].status,'filled');
  assert.equal(steps[targetIndex].classification,mode==='implicit'?'CONTRACT_INCOMPLETE':'APP_FUNCTIONAL_FAILURE',JSON.stringify(steps[targetIndex],null,2));
  assert.notEqual(result.pass,true);
  if(mode==='implicit') assert.equal(steps[2].controlEvidence.implicitOperationEvidence.consumesFilledInput,true);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
