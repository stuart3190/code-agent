// Contract authority follows immutable source lineage, never the newest unrelated project plan.
// Old edit/verify builds may lack a contract link; walk their parent snapshots, then accept only
// a single unambiguous legacy project contract. All reads remain owner/project scoped.
export async function loadSourceContract({client,snapshotStore,owner,projectId,sourceBuildId=null}) {
  const fail=(message,code='platform_contract_lineage_missing')=>Object.assign(new Error(message),{code});
  const read=async(query,label)=>{const result=await query;if(result.error)throw fail(`${label}: ${result.error.message}`);return result.data};
  const contractRow=async(id)=>{
    const row=await read(client.from('bv2_contracts').select('id,contract').eq('owner',owner).eq('project_id',projectId).eq('id',id).maybeSingle(),'source contract');
    if(!row?.contract)throw fail('The source build references a missing implementation contract');
    return row;
  };
  const seenBuilds=new Set();
  const fromBuild=async(id)=>{
    if(!id||seenBuilds.has(id))return null;seenBuilds.add(id);
    const build=await read(client.from('bv2_builds').select('id,contract_id').eq('owner',owner).eq('project_id',projectId).eq('id',id).maybeSingle(),'source build');
    if(!build)throw fail('The source build is unavailable in this project');
    if(build.contract_id)return {...await contractRow(build.contract_id),via:'source_build',buildId:id};
    const rows=await read(client.from('bv2_contracts').select('id,contract').eq('owner',owner).eq('project_id',projectId).eq('build_id',id).limit(2),'source build contract');
    if(rows?.length>1)throw fail('The source build has ambiguous implementation contracts');
    return rows?.[0]?.contract?{...rows[0],via:'source_build_contract_row',buildId:id}:null;
  };
  if(sourceBuildId){const direct=await fromBuild(sourceBuildId);if(direct)return direct;}
  const pointer=sourceBuildId?null:await snapshotStore.pointer(owner,projectId,'green');
  const first=sourceBuildId
    ?await snapshotStore.latestForBuild(owner,projectId,sourceBuildId,{reasonPrefixes:['working:','candidate:']})
    :pointer?await snapshotStore.getSnapshot(pointer):null;
  if(!first)throw fail('No retained source snapshot is available');
  let snapshot=first;const seen=new Set();
  while(snapshot){
    if(snapshot.owner!==owner||snapshot.project_id!==projectId)throw fail('Source snapshot ownership does not match the project');
    if(seen.has(snapshot.id)||seen.size>=64)throw fail('Source snapshot lineage is cyclic or exceeds its safe bound');
    seen.add(snapshot.id);
    const found=await fromBuild(snapshot.build_id);
    if(found)return {...found,sourceSnapshotId:first.id,contractSnapshotId:snapshot.id};
    if(!snapshot.parent_snapshot)break;
    snapshot=await snapshotStore.getSnapshot(snapshot.parent_snapshot);
    if(!snapshot)throw fail('A source snapshot parent is missing');
  }
  const rows=await read(client.from('bv2_contracts').select('id,contract').eq('owner',owner).eq('project_id',projectId).limit(2),'legacy source contract');
  if(rows?.length===1&&rows[0].contract)return {...rows[0],via:'unique_legacy_contract',sourceSnapshotId:first.id};
  throw fail('The retained source has no unambiguous implementation contract');
}
