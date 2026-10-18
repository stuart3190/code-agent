import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createJob,activeBuildsFor,getJob,activeBuildFor} from '../../shell/server/lib/buildJobs.mjs';
function fixture(t) {
 const prior=process.env.THRALLO_BUILD_WORKER_ENABLED;process.env.THRALLO_BUILD_WORKER_ENABLED='1';
 t.after(()=>{if(prior===undefined)delete process.env.THRALLO_BUILD_WORKER_ENABLED;else process.env.THRALLO_BUILD_WORKER_ENABLED=prior});
 const owner=randomUUID(),project=randomUUID(),rows=[];
 const client={from(){const filters=[];const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},order(){return q},limit(){return q},async maybeSingle(){return {data:rows.filter(r=>filters.every(f=>f(r))).at(-1)||null,error:null}},then(resolve,reject){return Promise.resolve({data:rows.filter(r=>filters.every(f=>f(r))).reverse(),error:null}).then(resolve,reject)}};return q},async rpc(name,p){const row={id:p.p_build_id,owner,project_id:project,mode:p.p_mode,status:'queued',phase:'queued',work_job_id:randomUUID(),created_at:new Date().toISOString()};rows.push(row);return {data:{job:row,work:{id:row.work_job_id,owner,project_id:project,build_id:row.id},existing:false},error:null}}};
 return {owner,project,rows,client,input:{owner:{id:owner},projectId:project,mode:'build',prompt:'Synthetic',pipelineVersion:'v2',client}};
}
test('completed detached build does not block the next dispatch in the same shell process',async t=>{
 const f=fixture(t),first=await createJob(f.input);f.rows[0].status='complete';
 const next=await createJob(f.input);assert.equal(next.existing,false);assert.notEqual(next.job.id,first.job.id);assert.equal(f.rows.length,2);
});
test('dashboard drops completed detached jobs and reads current durable phase',async t=>{
 const f=fixture(t);await createJob(f.input);f.rows[0].status='running';f.rows[0].phase='verify';
 let summary=await activeBuildsFor(f.owner,[f.project],{client:f.client});assert.equal(summary.get(f.project).state,'checking');
 f.rows[0].status='complete';summary=await activeBuildsFor(f.owner,[f.project],{client:f.client});assert.equal(summary.size,0);
});
test('reattachment reads durable completion and keeps owner isolation',async t=>{
 const f=fixture(t),first=await createJob(f.input);f.rows[0].status='complete';
 assert.equal((await getJob(f.owner,first.job.id,{client:f.client})).status,'complete');
 assert.equal((await activeBuildFor(f.owner,f.project,{client:f.client})).status,'complete');
 assert.equal(await getJob(randomUUID(),first.job.id,{client:f.client}),null);
});

test('still-running detached build reconnects without a second dispatch',async t=>{
 const f=fixture(t),first=await createJob(f.input);f.rows[0].status='running';
 const retry=await createJob(f.input);assert.equal(retry.existing,true);assert.equal(retry.job.id,first.job.id);assert.equal(retry.job.status,'running');assert.equal(f.rows.length,1);
});
