import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {verifyJourneys} from '../../shell/server/lib/appBuild/journeyVerifier.mjs';
import {deriveBuildSpec} from '../../shell/server/lib/builderV2/buildSpec.mjs';
import {isExplicitRouteLinkStep} from '../../shell/server/lib/builderV2/interactionSemantics.mjs';
const step={action:'use the About navigation link',target:'/about',expect:'the About page is open'};
for(const mode of ['working','missing','dead','wrong-destination'])test(`route link ${mode}`,{timeout:60000},async()=>{
 const requests=[];const server=http.createServer((req,res)=>{requests.push(req.url);res.setHeader('content-type','text/html');res.end(req.url==='/about'?'<main><h1>About</h1></main>':`<main><h1>Calculator</h1>${mode==='missing'?'':`<a href="/about" ${mode==='dead'?'onclick="event.preventDefault()"':mode==='wrong-destination'?'onclick="event.preventDefault();location.href=\'/wrong\'"':''}>About</a>`}</main>`)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{
 const contract=deriveBuildSpec({summary:'Calculator with About',auth:{required:false},entities:[],operations:[],routes:[{path:'/',name:'Calculator'},{path:'/about',name:'About'}],journeys:[{id:'navigate',priority:'primary',steps:[{action:'open Calculator',target:'/'},step]}]}).contract;
 const result=await verifyJourneys({previewUrl:`http://127.0.0.1:${server.address().port}`,contract,verifierPolicy:'minimal_contract_v1',timeoutMs:45000});
 const outcome=result.journeys[0].steps[1];assert.equal(outcome.classification,mode==='working'?'PASS':'APP_FUNCTIONAL_FAILURE',JSON.stringify(outcome));
 if(mode==='missing'||mode==='dead')assert.equal(requests.includes('/about'),false,'must not bypass the link with page.goto');
 }finally{await new Promise(resolve=>server.close(resolve))}
});
for(const extra of [{operates:['save']},{produces:['record']},{action:'click About link then save'},{target:'//external.test/about'}])test(`link interpretation abstains ${JSON.stringify(extra)}`,()=>assert.equal(isExplicitRouteLinkStep({...step,...extra}),false));
