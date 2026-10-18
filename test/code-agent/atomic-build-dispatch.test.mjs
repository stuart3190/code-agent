import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createJob} from '../../shell/server/lib/buildJobs.mjs';
import {dispatchBuildPipeline} from '../../shell/server/lib/buildWorkQueue.mjs';
function fixture(t){
 const before=process.env.THRALLO_BUILD_WORKER_ENABLED;process.env.THRALLO_BUILD_WORKER_ENABLED='1';
 t.after(()=>{if(before===undefined)delete process.env.THRALLO_BUILD_WORKER_ENABLED;else process.env.THRALLO_BUILD_WORKER_ENABLED=before});
 const owner=randomUUID(),project=randomUUID();let stored=null;const calls=[];
 const query={select(){return this},eq(){return this},in(){return this},order(){return this},limit(){return this},async maybeSingle(){return {data:stored,error:null}}};
 const client={from(table){assert.equal(table,'build_jobs');return query},async rpc(name,p){calls.push({name,p});const existing=Boolean(stored);stored ||= {id:p.p_build_id,owner,project_id:project,mode:p.p_mode,status:'queued',phase:'queued',pipeline_version:'v2',work_job_id:randomUUID(),created_at:new Date().toISOString()};return {data:{job:stored,work:{id:stored.work_job_id,owner,project_id:project,build_id:stored.id},existing},error:null}}};
 const input={owner:{id:owner},projectId:project,mode:'resume_verify',prompt:'Synthetic request',pipelineVersion:'v2',v2Input:{sourceBuildId:'retained-source'},providerSelection:{provider:'codex',billingLane:'connected_allowance'},client};
 return {owner,project,client,input,calls,getStored:()=>stored};
}
test('createJob makes one atomic dispatch and preserves retained/provider authority',async t=>{
 const f=fixture(t),r=await createJob(f.input);assert.equal(r.existing,false);assert.ok(r.job.workJobId);assert.equal(f.calls.length,1);const {name,p}=f.calls[0];assert.equal(name,'build_pipeline_dispatch');assert.equal(p.p_payload.input.sourceBuildId,'retained-source');assert.deepEqual(p.p_payload.providerSelection,f.input.providerSelection);assert.equal(p.p_resource_limits.memoryMb,3072);assert.equal(f.getStored().id,r.job.id);
});
test('failed atomic transaction creates no local queued job or follow-up update',async t=>{
 const f=fixture(t);f.client.rpc=async()=>({data:null,error:{code:'23514',message:'queue constraint failed'}});
 await assert.rejects(createJob(f.input),e=>e.code==='build_job_create_failed');
});
test('lost response reconnects to committed work without another dispatch',async t=>{
 const f=fixture(t),rpc=f.client.rpc;f.client.rpc=async(...args)=>{await rpc(...args);throw Error('connection reset after commit')};
 await assert.rejects(createJob(f.input),/connection reset/);
 const retry=await createJob(f.input);assert.equal(retry.existing,true);assert.equal(retry.job.id,f.getStored().id);assert.equal(retry.job.workJobId,f.getStored().work_job_id);assert.equal(f.calls.length,1);
});
test('concurrent callers reconnect to a single atomic winner',async t=>{
 const f=fixture(t);const [a,b]=await Promise.all([createJob(f.input),createJob(f.input)]);assert.equal(a.job.id,b.job.id);assert.equal([a,b].filter(r=>!r.existing).length,1);
});
test('inconsistent RPC authority is rejected',async()=>{
 await assert.rejects(dispatchBuildPipeline({owner:'owner',projectId:'project',buildId:'build',mode:'build',payload:{},client:{rpc:async()=>({data:{existing:false,job:{id:'build',owner:'foreign',project_id:'project'},work:{id:'work'}},error:null})}}),e=>e.code==='build_dispatch_identity_mismatch');
});
