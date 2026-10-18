import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {createOrchestrator,memoryBuildStore} from '../../shell/server/lib/builderV2/orchestrator.mjs';
import {createSnapshotStore} from '../../shell/server/lib/builderV2/snapshotStore.mjs';
import {REACT_VITE} from '../../src/scaffolds/reactVite.mjs';
import {deriveBuildSpec} from '../../shell/server/lib/builderV2/buildSpec.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/reliability-20261016/expense-unmounted-controller.json',import.meta.url)));
for(const mode of ['runEdit','runVerifyFromCheckpoint','runRepairFromCheckpoint'])test(`${mode} retains the exact derived contract before any generation or verification`,async()=>{
 const builds=memoryBuildStore(),snapshots=createSnapshotStore(),retained=[];let calls=0;
 const orchestrator=createOrchestrator({buildStore:builds,snapshotStore:snapshots,baseTree:()=>({...REACT_VITE}),baseline:REACT_VITE,
  contractFn:async()=>fixture.contract,patchesFn:async({step})=>{calls++;return step==='edit'?[{file:'src/screens/scaffold/SummaryScreen.jsx',ops:[{op:'append',content:'\n// verified edit\n'}]}]:fixture.patches},
  assetService:{resolveIntents:async()=>({resolved:[],providerCalls:0}),assetManifestFor:async()=>[]},
  compile:async()=>({ok:true}),journeysFn:async({journeys})=>({journeys:journeys.map(j=>({...j,status:'pass'}))}),
  events:{contract:async event=>{const id=`contract-${retained.length+1}`;retained.push({...event,id});return {id}}},
 });
 const initial=await orchestrator.runBuild({owner:'o',projectId:mode,request:'Expense ledger'});assert.equal(initial.state,'green',JSON.stringify(initial));
 const next=await orchestrator[mode]({owner:'o',projectId:mode,sourceBuildId:initial.buildId,request:'Check the retained ledger',contract:fixture.contract});
 assert.equal(retained.length,2,JSON.stringify({mode,next,calls}));
 assert.deepEqual(retained[1].intents,deriveBuildSpec(retained[1].contract).imageIntents, 'retained event must carry the actual derived asset intents');
 assert.equal(retained[1].buildId,next.buildId);assert.equal(retained[1].retained,true);
 assert.equal((await builds.get(next.buildId)).contract_id,'contract-2');
 assert.deepEqual(retained[1].contract.journeys.map(j=>j.id),fixture.contract.journeys.map(j=>j.id));
});
for(const mode of ['runEdit','runVerifyFromCheckpoint','runRepairFromCheckpoint'])test(`${mode} cannot spend or promote when contract retention fails`,async()=>{
 const builds=memoryBuildStore(),snapshots=createSnapshotStore();let retained=0,calls=0;
 const orchestrator=createOrchestrator({buildStore:builds,snapshotStore:snapshots,baseTree:()=>({...REACT_VITE}),baseline:REACT_VITE,
  contractFn:async()=>fixture.contract,patchesFn:async()=>{calls++;return fixture.patches},
  assetService:{resolveIntents:async()=>({resolved:[],providerCalls:0}),assetManifestFor:async()=>[]},compile:async()=>({ok:true}),
  journeysFn:async({journeys})=>({journeys:journeys.map(j=>({...j,status:'pass'}))}),
  events:{contract:async()=>{if(retained++)throw Error('contract storage offline');return {id:'initial-contract'}}},
 });
 const initial=await orchestrator.runBuild({owner:'o',projectId:mode,request:'Expense ledger'});assert.equal(initial.state,'green');
 const pointer=await snapshots.pointer('o',mode,'green'),before=calls;
 const result=await orchestrator[mode]({owner:'o',projectId:mode,sourceBuildId:initial.buildId,request:'Retain',contract:fixture.contract});
 assert.equal(result.state,'failed');assert.equal(result.failureClassification,'platform_contract_persistence_failed');
 assert.match(result.error,/contract storage offline/);assert.equal(calls,before);assert.equal(await snapshots.pointer('o',mode,'green'),pointer);
});
test('fresh build refuses generation when durable contract row cannot be linked',async()=>{
 const builds=memoryBuildStore(),update=builds.update.bind(builds);builds.update=async(id,patch)=>{if(patch.contract_id)throw Error('link write offline');return update(id,patch)};
 const snapshots=createSnapshotStore();let calls=0;
 const orchestrator=createOrchestrator({buildStore:builds,snapshotStore:snapshots,baseTree:()=>({...REACT_VITE}),baseline:REACT_VITE,
  contractFn:async()=>fixture.contract,patchesFn:async()=>{calls++;return fixture.patches},
  assetService:{resolveIntents:async()=>({resolved:[],providerCalls:0}),assetManifestFor:async()=>[]},
  events:{contract:async()=>({id:'persisted-contract'})},
 });
 const result=await orchestrator.runBuild({owner:'o',projectId:'failed-link',request:'Expense ledger'});
 assert.equal(result.state,'failed');assert.equal(result.failureClassification,'platform_contract_persistence_failed');assert.equal(calls,0);
 assert.equal(await snapshots.pointer('o','failed-link','green'),null);
});
test('an edit cannot pair a captured contract with a concurrently changed green source',async()=>{
 const snapshots=createSnapshotStore(),builds=memoryBuildStore();const snapshot=await snapshots.createSnapshot('o','changed-source',{'src/App.jsx':'export default function App(){return null}'});
 await snapshots.promote('o','changed-source','green',snapshot.id);let called=false;
 const orchestrator=createOrchestrator({snapshotStore:snapshots,buildStore:builds,contractFn:async()=>fixture.contract,baseTree:()=>({...REACT_VITE}),assetService:{resolveIntents:async()=>({resolved:[],providerCalls:0}),assetManifestFor:async()=>[]},patchesFn:async()=>{called=true;return []},events:{contract:async()=>{called=true;return {id:'incorrect'}}}});
 const result=await orchestrator.runEdit({owner:'o',projectId:'changed-source',request:'Edit',contract:fixture.contract,sourceSnapshotId:'earlier-snapshot'});
 assert.equal(result.state,'blocked');assert.equal(result.failureClassification,'platform_source_changed');assert.equal(called,false);assert.equal(await snapshots.pointer('o','changed-source','green'),snapshot.id);
});
