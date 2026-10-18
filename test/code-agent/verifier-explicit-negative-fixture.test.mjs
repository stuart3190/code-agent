import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inputValidity } from '../../shell/server/lib/builderV2/interactionContract.mjs';
import { deriveBuildSpec } from '../../shell/server/lib/builderV2/buildSpec.mjs';
import { verifyJourneys } from '../../shell/server/lib/appBuild/journeyVerifier.mjs';

const negative = value => ({ action: value === '' ? 'clear the quantity' : `enter ${value} as the quantity`,
  target: 'quantity', operates: ['quantity'], primitive: 'textbox', verificationValues: { quantity: value },
  expect: 'inline invalid-quantity feedback is visible', visibleText: ['Enter a quantity greater than zero'] });
test('negative validity requires a fixture and affirmative feedback; valid actions and absent feedback abstain', () => {
  for (const value of [0, -2, '']) assert.equal(inputValidity(negative(value)), 'invalid');
  for (const expect of ['no validation feedback is visible', 'without an error message', 'the quantity is visible']) {
    assert.equal(inputValidity({ ...negative(0), expect }), 'unspecified');
  }
  assert.equal(inputValidity({ ...negative(0), verificationValues: undefined }), 'unspecified');
  assert.equal(inputValidity({ ...negative(2), action: 'enter a valid quantity' }), 'valid');
});
test('browser accepts deliberate out-of-range and blank inputs without accepting uneditable controls', {timeout:120000}, async () => {
  let editable = true;
  const server = http.createServer((req,res) => {
    res.setHeader('Content-Type','text/html');
    res.end(`<main><h1>Quantity calculator</h1><label>quantity<input name="quantity" type="number" min="1" required ${editable ? '' : 'readonly'} value="4" oninput="document.querySelector('p').textContent=(this.value===''||Number(this.value)<=0)?'Enter a quantity greater than zero':''"></label><p></p></main>`);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
    const contract = deriveBuildSpec({ version:1, summary:'Quantity calculator', projectType:'web app',
      auth:{required:false}, routes:[{path:'/',name:'Quantity calculator'}],
      entities:[{name:'calculator',storage:'transient',fields:[{name:'quantity',type:'number'}]}], operations:[],
      journeys:[{id:'validation',title:'Validate quantity',priority:'primary',steps:[
        {action:'open the calculator',target:'/',expect:'Quantity calculator is visible'},
        negative(0),negative(-2),negative(''),
      ]}], states:[],acceptance:[],deferred:[],integrations:[],imageIntents:[],
    }).contract;
    const result = await verifyJourneys({previewUrl:`http://127.0.0.1:${server.address().port}`,contract,
      timeoutMs:90000,verifierPolicy:'minimal_contract_v1'});
    const journey = result.journeys[0];
    assert.equal(journey.status,'pass',JSON.stringify(journey,null,2));
    for(const step of journey.steps.slice(1)) {
      const fields=step.controlEvidence?.fields;
      assert.ok(fields?.length,JSON.stringify(step));
      assert.equal(fields[0].status,'filled');
    }
    editable = false;
    const broken = await verifyJourneys({previewUrl:`http://127.0.0.1:${server.address().port}`,contract,
      timeoutMs:90000,verifierPolicy:'minimal_contract_v1'});
    assert.notEqual(broken.journeys[0].status,'pass','a negative fixture must not make an uneditable control pass');
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
