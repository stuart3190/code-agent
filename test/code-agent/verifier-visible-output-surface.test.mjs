import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {verifyJourneys} from '../../shell/server/lib/appBuild/journeyVerifier.mjs';
for (const [name,markup,expected] of [
 ['hidden input','<input type="hidden" value="450">','APP_FUNCTIONAL_FAILURE'],
 ['CSS hidden input','<input style="display:none" value="450">','APP_FUNCTIONAL_FAILURE'],
 ['invisible parent','<div style="visibility:hidden"><textarea>450</textarea></div>','APP_FUNCTIONAL_FAILURE'],
 ['transparent parent','<div style="opacity:0"><input value="450"></div>','APP_FUNCTIONAL_FAILURE'],
 ['visible readonly result','<label>Result<input readonly value="450"></label>','PASS'],
 ['restored child visibility','<div style="visibility:hidden"><input style="visibility:visible" readonly value="450"></div>','PASS'],
 ['visible text result','<output>450 g</output>','PASS'],
]) test(`computed output visibility: ${name}`,{timeout:60000},async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<main><h1>Calculator</h1>${markup}</main>`);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const result=await verifyJourneys({previewUrl:`http://127.0.0.1:${server.address().port}`,timeoutMs:35000,verifierPolicy:'minimal_contract_v1',contract:{journeys:[{id:'result',priority:'primary',steps:[{action:'read the result',expectedOutputs:{quantity:450},expect:'the result is visible'}]}],interactionContract:{flows:[]}}});
  assert.equal(result.journeys[0].steps[0].classification,expected,JSON.stringify(result.journeys[0].steps[0]));
 } finally { await new Promise(resolve=>server.close(resolve)); }
});
