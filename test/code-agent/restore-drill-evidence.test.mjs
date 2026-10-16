import test from 'node:test';import assert from 'node:assert/strict';
import {completedRestoreDrillAt,validateExternalRestoreProbes} from '../../ops/lib/restoreDrillEvidence.mjs';
import {evaluateDrSignals} from '../../ops/dr-health.mjs';
const now=Date.now(),start=new Date(now-120000).toISOString(),end=new Date(now).toISOString();
const line=x=>JSON.stringify(x);const begun=line({startedAt:start});const passed=line({completedAt:end,result:'pass'});
test('only a completed successful drill supplies freshness',()=>{
 assert.equal(completedRestoreDrillAt(begun+'\n'+passed,now),end);
 for(const text of ['',begun,passed,begun+'\n'+line({completedAt:end,result:'fail'}),begun+'\n'+passed+'\n'+begun,begun+'\n'+passed+'\n{'])assert.equal(completedRestoreDrillAt(text,now),null);
 assert.equal(completedRestoreDrillAt(line({startedAt:'invalid'})+'\n'+passed,now),null);
 assert.equal(completedRestoreDrillAt(begun+'\n'+line({completedAt:new Date(now+86400000).toISOString(),result:'pass'}),now),null);
});
const options={host:'restore.example',startedAt:start,completedAt:end};
const rows=Array.from({length:8},(_,i)=>Array.from({length:3},(_,j)=>({host:options.host,port:55320+i,connected:false,checkedAt:new Date(now-120000+j*60000).toISOString()}))).flat();
const encode=rows=>rows.map(line).join('\n');
test('continuous external closed-port samples cover all eight ports',()=>assert.deepEqual(validateExternalRestoreProbes(encode(rows),options),{ok:true,ports:8,samples:24}));
test('empty malformed reachable incomplete and stale external evidence fails closed',()=>{
 for(const text of ['', '{}','not json',encode(rows.slice(3)),encode(rows.map((r,i)=>i===0?{...r,connected:true}:r)),encode(rows.map(r=>({...r,host:'other'}))),encode(rows.filter(r=>r.checkedAt===start)),encode(rows.map(r=>({...r,checkedAt:'bad'})))])assert.throws(()=>validateExternalRestoreProbes(text,options));
});
test('invalid dates and failed database queries cannot give healthy DR status',()=>{
 const healthy={backupCompletedAt:end,restoreDrillAt:end,queueAgeMinutes:0,workerHeartbeatMinutes:0,reconciliationBacklog:0,recentBuildFailures:0,recentVerificationFailures:0,postgrestHealthy:true,deploymentIdentityMatches:true,storageGrowthPercent:0};
 assert.deepEqual(evaluateDrSignals(healthy),[]);
 for(const key of ['backupCompletedAt','restoreDrillAt'])for(const value of ['invalid',new Date(now+86400000).toISOString()])assert.ok(evaluateDrSignals({...healthy,[key]:value}).length);
 assert.deepEqual(evaluateDrSignals({...healthy,failedProbes:['queued']}),['DR database probe failed: queued']);
});
