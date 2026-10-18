import {test} from 'node:test';import assert from 'node:assert/strict';
import {sourceBuildRunId} from '../../shell/server/lib/appBuild/appPublishService.mjs';
function client(snapshot,jobs){const calls=[];return {calls,from(table){const filters=[];calls.push({table,filters});const result=table==='bv2_snapshots'?snapshot:jobs;return {select(){return this},eq(k,v){filters.push([k,v]);return this},maybeSingle:async()=>result,limit:async n=>{assert.equal(n,2);return result}}}};}
test('published log follows captured snapshot build, never a newer unrelated attempt',async()=>{
 const db=client({data:{build_id:'source-build'}},{data:[{diag_run_id:'source-log'}]});
 assert.equal(await sourceBuildRunId('owner','project','captured-snapshot',db),'source-log');
 assert.deepEqual(db.calls,[{table:'bv2_snapshots',filters:[['owner','owner'],['project_id','project'],['id','captured-snapshot']]},{table:'build_jobs',filters:[['owner','owner'],['project_id','project'],['bv2_build_id','source-build']]}]);
});
for(const [name,snapshot,jobs] of [
 ['missing snapshot',{data:null},{data:[]}],['legacy snapshot without build',{data:{build_id:null}},{data:[]}],
 ['missing public job',{data:{build_id:'source-build'}},{data:[]}],
 ['missing diagnostic',{data:{build_id:'source-build'}},{data:[{diag_run_id:null}]}],
 ['ambiguous public jobs',{data:{build_id:'source-build'}},{data:[{diag_run_id:'a'},{diag_run_id:'b'}]}],
])test(`publish lineage never guesses for ${name}`,async()=>{assert.equal(await sourceBuildRunId('owner','project','snapshot',client(snapshot,jobs)),null)});
test('a lineage lookup error remains an error instead of selecting a different build',async()=>{
 await assert.rejects(sourceBuildRunId('owner','project','snapshot',client({error:{message:'offline'}},{})),/published source lineage: offline/);
 await assert.rejects(sourceBuildRunId('owner','project','snapshot',client({data:{build_id:'b'}},{error:{message:'offline'}})),/published source build lineage: offline/);
});
