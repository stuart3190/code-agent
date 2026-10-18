import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {subscribe} from '../../shell/server/lib/buildJobs.mjs';
const row={id:'job',owner:'owner',project_id:'project',status:'complete',phase:'complete',work_job_id:'work',created_at:new Date().toISOString()};
const job=()=>({id:'job',owner:{id:'owner'},projectId:'project',status:'running',phase:'running',workJobId:'work',subscribers:new Set()});
function client(read){return {from(){return {select(){return this},eq(){return this},maybeSingle:read}}}}
test('slow status reads never overlap',async t=>{
 let calls=0,resolve;const pending=new Promise(r=>resolve=r);const events=[];
 const stop=subscribe(job(),(...args)=>events.push(args),{client:client(()=>{calls++;return pending}),pollMs:5});t.after(stop);
 await delay(35);assert.equal(calls,1);resolve({data:row,error:null});await delay(10);assert.equal(events.filter(e=>e[0]==='end').length,1);
});
test('closing a stream prevents late reads from mutating or emitting',async()=>{
 let resolve;const pending=new Promise(r=>resolve=r),observed=job(),events=[];
 const stop=subscribe(observed,(...args)=>events.push(args),{client:client(()=>pending),pollMs:5});stop();resolve({data:row,error:null});await delay(10);
 assert.deepEqual(events,[]);assert.equal(observed.status,'running');
});
test('transport errors retry without unhandled rejection or fake terminal state',async t=>{
 let reads=0;const events=[];const stop=subscribe(job(),(...args)=>events.push(args),{client:client(async()=>{reads++;if(reads===1)throw Error('temporary transport failure');if(reads===2)return {data:null,error:{message:'temporary database outage'}};return {data:row,error:null}}),pollMs:5});t.after(stop);
 await delay(45);assert.equal(reads,3);assert.equal(events.filter(e=>e[0]==='end').length,1);
});
test('throwing consumers stop polling without an unhandled rejection',async()=>{
 let reads=0;subscribe(job(),()=>{throw Error('closed writer')},{client:client(async()=>{reads++;return {data:row,error:null}}),pollMs:5});
 await delay(25);assert.equal(reads,1);
});
test('consumer disconnecting on phase receives no later terminal event',async()=>{
 const events=[];const stop=subscribe(job(),name=>{events.push(name);stop()},{client:client(async()=>({data:row,error:null})),pollMs:5});
 await delay(15);assert.deepEqual(events,['phase']);
});
