import {test} from 'node:test';import assert from 'node:assert/strict';
import {loadSourceContract} from '../../shell/server/lib/builderV2/sourceContract.mjs';
function setup(){
 const tables={bv2_builds:[{id:'original',contract_id:'correct'},{id:'edited',contract_id:null}],bv2_contracts:[{id:'correct',build_id:'original',contract:{summary:'source'}},{id:'newer',build_id:'failed-new-plan',contract:{summary:'unrelated newest'}}]};
 for(const rows of Object.values(tables))for(const r of rows)Object.assign(r,{owner:'o',project_id:'p'});
 const snapshots={current:{id:'current',owner:'o',project_id:'p',build_id:'edited',parent_snapshot:'parent'},parent:{id:'parent',owner:'o',project_id:'p',build_id:'original',parent_snapshot:null}};
 const queries=[];const client={from(table){const filters=[];queries.push({table,filters});let max=Infinity;const run=()=>({data:structuredClone((tables[table]||[]).filter(r=>filters.every(([k,v])=>r[k]===v)).slice(0,max))});return {select(){return this},eq(k,v){filters.push([k,v]);return this},limit(n){max=n;return this},maybeSingle:async()=>({data:run().data[0]||null}),then(resolve,reject){return Promise.resolve(run()).then(resolve,reject)}}}};
 const snapshotStore={pointer:async()=> 'current',getSnapshot:async id=>snapshots[id],latestForBuild:async()=>snapshots.current};
 return {tables,snapshots,queries,client,snapshotStore,owner:'o',projectId:'p'};
}
test('edit and legacy resume follow immutable parents instead of the newest unrelated contract',async()=>{for(const sourceBuildId of [null,'edited']){const x=setup(),r=await loadSourceContract({...x,sourceBuildId});assert.equal(r.id,'correct');assert.equal(r.contractSnapshotId,'parent');for(const q of x.queries){assert.ok(q.filters.some(([k,v])=>k==='owner'&&v==='o'));assert.ok(q.filters.some(([k,v])=>k==='project_id'&&v==='p'));}}});
test('a source build contract link is authoritative without reading a newer snapshot',async()=>{const x=setup();x.snapshotStore.latestForBuild=async()=>{throw Error('must not consult snapshot')};assert.equal((await loadSourceContract({...x,sourceBuildId:'original'})).id,'correct')});
test('an unlinked build can recover its own uniquely persisted contract row',async()=>{const x=setup();x.tables.bv2_builds[0].contract_id=null;assert.equal((await loadSourceContract({...x,sourceBuildId:'original'})).via,'source_build_contract_row')});
test('a uniquely stored legacy project contract is a bounded fallback',async()=>{const x=setup();x.tables.bv2_builds[0].contract_id=null;x.tables.bv2_contracts=[{id:'legacy',owner:'o',project_id:'p',contract:{summary:'legacy'}}];assert.equal((await loadSourceContract(x)).via,'unique_legacy_contract')});
for(const [name,mutate] of [
 ['foreign snapshot owner',x=>x.snapshots.current.owner='other'],
 ['foreign snapshot project',x=>x.snapshots.current.project_id='other'],
 ['missing parent',x=>delete x.snapshots.parent],
 ['cyclic parents',x=>x.snapshots.current.parent_snapshot='current'],
 ['dangling explicit contract link',x=>x.tables.bv2_builds[1].contract_id='missing'],
 ['foreign source build',x=>x.tables.bv2_builds[1].owner='other'],
 ['ambiguous legacy contracts',x=>{x.tables.bv2_builds[0].contract_id=null;for(const row of x.tables.bv2_contracts)row.build_id=null}],
 ['ambiguous build contracts',x=>{x.tables.bv2_builds[1].contract_id=null;for(const row of x.tables.bv2_contracts)row.build_id='edited'}],
 ['missing green pointer',x=>x.snapshotStore.pointer=async()=>null],
])test(`contract lineage fails closed on ${name}`,async()=>{const x=setup();mutate(x);await assert.rejects(loadSourceContract(x),e=>e.code==='platform_contract_lineage_missing')});
for(const length of [64,65])test(`snapshot lineage enforces the ${length}-node boundary`,async()=>{
 const x=setup();x.snapshotStore.pointer=async()=> 's0';
 for(let i=0;i<length;i++)x.snapshots[`s${i}`]={id:`s${i}`,owner:'o',project_id:'p',build_id:i===length-1?'original':'edited',parent_snapshot:i===length-1?null:`s${i+1}`};
 if(length===64)assert.equal((await loadSourceContract(x)).id,'correct');
 else await assert.rejects(loadSourceContract(x),/safe bound/);
});
test('lineage database errors cannot become a fallback contract',async()=>{const x=setup(),from=x.client.from.bind(x.client);x.client.from=table=>{const q=from(table);q.maybeSingle=async()=>({error:{message:'database unavailable'}});return q};await assert.rejects(loadSourceContract(x),/source build: database unavailable/);assert.equal(x.queries.length,1)});
