import {test} from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {verifyJourneys, explicitActionRepetition} from '../../shell/server/lib/appBuild/journeyVerifier.mjs';
for(const broken of [false,true])test(`explicit twice activation ${broken?'still rejects a dead second click':'drives both clicks'}`,{timeout:60000},async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<main><h1>Counter</h1><output>0</output><button data-thrallo-action="decrement" onclick="const output=document.querySelector('output');if(${broken?'Number(output.textContent)===0':'true'})output.textContent=Number(output.textContent)-1">Decrease</button></main>`)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));try{
  const result=await verifyJourneys({previewUrl:`http://127.0.0.1:${server.address().port}`,timeoutMs:45000,verifierPolicy:'minimal_contract_v1',contract:{journeys:[{id:'counter',priority:'primary',steps:[{action:'decrease the counter twice',operates:['decrement'],expectedOutputs:{count:-2},expect:'the counter is minus two'}]}],interactionContract:{flows:[{id:'decrement',journeyId:'counter',stepIndex:0,kind:'action',operationId:'decrement',stateOwner:'src/App.jsx',reads:['counter.custom.count'],writes:['counter.custom.count'],control:{machineId:'decrement',logicalField:'decrement',accessibleName:'Decrease',accessibleNames:['Decrease'],roles:['button']}}]}}});
  const step=result.journeys[0].steps[0];assert.equal(step.classification,broken?'APP_FUNCTIONAL_FAILURE':'PASS',JSON.stringify(step));
 }finally{await new Promise(resolve=>server.close(resolve))}
});

const transientFlow = {kind:'action',control:{machineId:'decrement'},writes:['counter.custom.count']};
for (const [action,count] of [['decrease twice',2],['press Decrease three times',3],['tap ten times',10],['increase 2 times',2],['click once',1]]) {
 test(`explicit repetition parses ${action}`,()=>assert.deepEqual(explicitActionRepetition(action,[transientFlow]),{count}));
}
for (const [name,action,flows] of [
 ['compound instruction','click twice then reset',[transientFlow]],
 ['unbounded','click 11 times',[transientFlow]],
 ['zero','click 0 times',[transientFlow]],
 ['multiple requests','click twice then click thrice',[transientFlow]],
 ['no activation verb','display twice the count',[transientFlow]],
 ['no contract','click twice',[]],
 ['multiple controls','click twice',[transientFlow,transientFlow]],
 ['durable kind','click twice',[{...transientFlow,kind:'mutation'}]],
 ['durable handoff','click twice',[{...transientFlow,persistenceHandoff:{}}]],
 ['durable lifecycle','click twice',[{...transientFlow,durableLifecycle:{}}]],
 ['durable responsibility','click twice',[{...transientFlow,semanticResponsibilityTypes:['persistence']}]],
 ['durable write','click twice',[{...transientFlow,writes:['counter.durable.count']}]],
 ['unknown writes','click twice',[{...transientFlow,writes:[]}]],
]) test(`repetition abstains for ${name}`,()=>assert.ok(explicitActionRepetition(action,flows).reason));
