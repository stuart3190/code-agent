import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {verifyJourneys} from '../../shell/server/lib/appBuild/journeyVerifier.mjs';
for (const [name,markup,expected,expectedOutputs={quantity:450}] of [
 ['hidden input','<input type="hidden" value="450">','APP_FUNCTIONAL_FAILURE'],
 ['CSS hidden input','<input style="display:none" value="450">','APP_FUNCTIONAL_FAILURE'],
 ['zero-size readonly result','<input readonly style="width:0;height:0;padding:0;border:0" value="450">','APP_FUNCTIONAL_FAILURE'],
 ['invisible parent','<div style="visibility:hidden"><textarea>450</textarea></div>','APP_FUNCTIONAL_FAILURE'],
 ['transparent parent','<div style="opacity:0"><input value="450"></div>','APP_FUNCTIONAL_FAILURE'],
 ['transparent text result','<div style="opacity:0"><output>450 g</output></div>','APP_FUNCTIONAL_FAILURE'],
 ['editable value alone','<label>Quantity<input value="450"></label>','CONTRACT_INCOMPLETE'],
 ['editable value beside wrong result','<label>Quantity<input value="450"></label><output>900 g</output>','CONTRACT_INCOMPLETE'],
 ['visible disabled result','<label>Result<input disabled value="450"></label>','PASS'],
 ['display contents text','<div style="display:contents">450 g</div>','PASS'],
 ['inline number fragments','<output>4<span>50</span> g</output>','PASS'],
 ['separate numbers are not concatenated','<div>4</div><div>50</div>','APP_FUNCTIONAL_FAILURE'],
 ['visible readonly result','<label>Result<input readonly value="450"></label>','PASS'],
 ['restored child visibility','<div style="visibility:hidden"><input style="visibility:visible" readonly value="450"></div>','PASS'],
 ['visible text result','<output>450 g</output>','PASS'],
 ['rounded result needs display precision','<output>37.16 m²</output>','CONTRACT_INCOMPLETE',{wallArea:37.161216}],
 ['incorrect rounded result','<output>37.17 m²</output>','APP_FUNCTIONAL_FAILURE',{wallArea:37.161216}],
]) test(`computed output visibility: ${name}`,{timeout:60000},async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<main><h1>Calculator</h1>${markup}</main>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const result=await verifyJourneys({previewUrl:`http://127.0.0.1:${server.address().port}`,timeoutMs:35000,verifierPolicy:'minimal_contract_v1',contract:{journeys:[{id:'result',priority:'primary',steps:[{action:'read the result',expectedOutputs,expect:'the result is visible'}]}],interactionContract:{flows:[]}}});
  assert.equal(result.journeys[0].steps[0].classification,expected,JSON.stringify(result.journeys[0].steps[0]));
 } finally { await new Promise(resolve=>server.close(resolve)); }
});
