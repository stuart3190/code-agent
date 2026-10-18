import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {createCandidateFindingsRecorder} from '../../shell/server/lib/builderV2/candidateFindings.mjs';
test('candidate blockers and advisories persist with build and source context',async()=>{
 const stored=[],emitted=[];const record=createCandidateFindingsRecorder({telemetry:async x=>(stored.push(x),{id:'evidence'}),emit:(...x)=>emitted.push(x)});
 const result=await record({owner:'owner',buildId:'build',step:'core',attempt:2,snapshotId:'candidate',blocking:[{code:'missing_export',file:'src/Screen.jsx',line:8,message:'Missing export',source:'not recorded'}],advisory:[{code:'typed_record_field_access',file:'src/Screen.jsx',message:'Read record.values.title'}]});
 assert.equal(result.id,'evidence');assert.equal(stored[0].kind,'candidate_findings');assert.equal(stored[0].owner,'owner');assert.equal(stored[0].buildId,'build');assert.equal(stored[0].details.snapshotId,'candidate');assert.equal(stored[0].details.blocking[0].line,8);assert.equal(stored[0].details.advisoryCount,1);assert.equal(stored[0].details.blocking[0].source,undefined);assert.equal(emitted[0][1].blockingCount,1);
});
test('diagnostic outage remains explicit but does not abort an otherwise runnable candidate',async()=>{
 let event;await createCandidateFindingsRecorder({telemetry:async()=>{throw Error('private backend details');},emit:(_,x)=>event=x})({owner:'o',buildId:'b',blocking:[{code:'x',message:'diagnostic'}]});
 assert.equal(event.persistenceUnavailable,true);assert.equal(JSON.stringify(event).includes('private backend'),false);
});
test('empty findings do not write; unbounded findings are clipped without losing counts',async()=>{
 const saved=[];const record=createCandidateFindingsRecorder({telemetry:async x=>saved.push(x),emit:()=>{}});await record({});assert.equal(saved.length,0);
 await record({advisory:Array.from({length:100},()=>({message:'x'.repeat(5000)}))});assert.equal(saved[0].details.advisoryCount,100);assert.equal(saved[0].details.advisory.length,20);assert.equal(saved[0].details.advisory[0].message.length,1000);
});
test('production composition wires the orchestrator event to telemetry',async()=>{
 const source=await readFile(new URL('../../shell/server/lib/builderV2/runtimeComposition.mjs',import.meta.url),'utf8');assert.match(source,/events\.candidateFindings = createCandidateFindingsRecorder\(\{ telemetry: events\.telemetry, emit \}\)/);
});
test('credential-shaped strings are redacted before database and progress emission',async()=>{
 let stored,event;const token='sk-notarealcredential1234567890';await createCandidateFindingsRecorder({telemetry:async x=>{stored=x;},emit:(_,x)=>{event=x;}})({blocking:[{message:`authorization: Bearer ${token}`} ]});
 assert.equal(JSON.stringify(stored).includes(token),false);assert.equal(JSON.stringify(event).includes(token),false);assert.match(stored.details.blocking[0].message,/REDACTED/);
});
