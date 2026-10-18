import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectBackupRelations,reconcileBackupRelations} from '../../ops/lib/backupRelations.mjs';
const fk=(table,columns,parentTable,parentColumns,extra={})=>({name:`${table}_parent`,table,columns,parentSchema:'public',parentTable,parentColumns,match:'s',...extra});
const catalog=(keys,foreignKeys=[])=>({version:1,primaryKeys:Object.entries(keys).map(([table,columns])=>({table,columns})),foreignKeys});
const base=catalog({jobs:['id'],events:['id']},[fk('events',['job_id'],'jobs',['id'])]);
const race=()=>new Map([['jobs',[{id:'old'}]],['events',[{id:1,job_id:'new'}]]]);
test('live export race is detected and missing parent is fetched without dropping captured children',async()=>{
 const tables=race();assert.equal(inspectBackupRelations(tables,base).missing.length,1);
 const result=await reconcileBackupRelations(tables,base,{fetchRows:async request=>{assert.deepEqual(request.values,['new']);return [{id:'new'}];}});
 assert.equal(result.addedRows,1);assert.equal(tables.get('events').length,1);assert.deepEqual(result.changedTables,['jobs']);
});
test('closure recursively follows a new job to its project and auth user',async()=>{
 const tables=new Map([['events',[{id:1,job_id:'j'}]],['jobs',[]],['projects',[]],['auth_users',[]]]);
 const c=catalog({events:['id'],jobs:['id'],projects:['id']},[fk('events',['job_id'],'jobs',['id']),fk('jobs',['project'],'projects',['id']),fk('projects',['owner'],'users',['id'],{parentSchema:'auth'})]);
 const found={jobs:[{id:'j',project:'p'}],projects:[{id:'p',owner:'u'}],auth_users:[{id:'u'}]};
 const result=await reconcileBackupRelations(tables,c,{fetchRows:async r=>found[r.table]});assert.equal(result.rounds,3);assert.equal(result.addedRows,3);
});
test('composite ownership tuple is checked rather than accepting matching ID alone',()=>{
 const tables=new Map([['jobs',[{id:'j',owner:'other'}]],['events',[{id:1,job_id:'j',owner:'mine'}]]]);
 assert.equal(inspectBackupRelations(tables,catalog({jobs:['id'],events:['id']},[fk('events',['job_id','owner'],'jobs',['id','owner'])])).missing.length,1);
});
test('nullable MATCH SIMPLE and MATCH FULL semantics remain explicit',()=>{
 const tables=new Map([['jobs',[]],['events',[{id:1,job_id:null,owner:'mine'}]]]);
 const c=catalog({jobs:['id'],events:['id']},[fk('events',['job_id','owner'],'jobs',['id','owner'])]);assert.equal(inspectBackupRelations(tables,c).missing.length,0);
 c.foreignKeys[0].match='f';assert.throws(()=>inspectBackupRelations(tables,c),/partial null/);
});
for(const [label,fetchRows,options,pattern] of [
 ['missing/deleted parent',async()=>[],{},/unavailable/],
 ['wrong parent returned',async()=>[{id:'wrong'}],{},/unrelated/],
 ['row limit',async()=>[{id:'new'}],{maxAddedRows:0},/row bound/],
 ['round limit',async()=>[{id:'new'}],{maxRounds:0},/exhausted/],
])test(`fails closed on ${label}`,async()=>{const tables=race();await assert.rejects(reconcileBackupRelations(tables,base,{fetchRows,...options}),pattern);assert.equal(tables.get('events').length,1);});
test('unknown columns, unsupported schemas and duplicate identities fail closed',()=>{
 const tables=race();delete tables.get('events')[0].job_id;assert.throws(()=>inspectBackupRelations(tables,base),/column missing/);
 const c=structuredClone(base);c.foreignKeys[0].parentSchema='external';assert.throws(()=>inspectBackupRelations(race(),c),/unsupported backup parent/);
 const duplicate=race();duplicate.get('jobs').push({id:'old'});assert.throws(()=>inspectBackupRelations(duplicate,base),/duplicate/);
});
test('immutable snapshot hydration includes missing files and content-addressed blobs',async()=>{
 const hash=s=>createHash('sha256').update(s).digest('hex'),content='hello',content_hash=hash(content);
 const tables=new Map([['bv2_snapshots',[{id:'s',owner:'u',state:'ready',file_count:1,tree_hash:hash(`src/a.js ${content_hash}`)}]],['bv2_snapshot_files',[]],['bv2_blobs',[]]]);
 const c=catalog({bv2_snapshots:['id'],bv2_snapshot_files:['snapshot_id','path'],bv2_blobs:['owner','content_hash']},[fk('bv2_snapshot_files',['snapshot_id'],'bv2_snapshots',['id'])]);
 const result=await reconcileBackupRelations(tables,c,{fetchRows:async r=>r.table==='bv2_snapshot_files'?[{snapshot_id:'s',path:'src/a.js',content_hash}]:[{owner:'u',content_hash,content,size_bytes:5}]});
 assert.equal(result.rounds,2);assert.equal(result.addedRows,2);
 tables.get('bv2_snapshots')[0].tree_hash='bad';await assert.rejects(reconcileBackupRelations(tables,c,{fetchRows:async()=>[]}),/tree hash/);
});
test('immutable hydration refuses conflicts with already captured children',async()=>{
 const tables=new Map([['bv2_snapshots',[{id:'s',state:'ready',file_count:2}]],['bv2_snapshot_files',[{snapshot_id:'s',path:'a',content_hash:'old'}]],['bv2_blobs',[]]]);
 // No snapshot owner/blob resolution is needed: test conflict before closure can complete.
 tables.get('bv2_snapshots')[0].owner='u';
 const c=catalog({bv2_snapshots:['id'],bv2_snapshot_files:['snapshot_id','path'],bv2_blobs:['owner','content_hash']});
 await assert.rejects(reconcileBackupRelations(tables,c,{fetchRows:async r=>r.table==='bv2_blobs'?[{owner:'u',content_hash:'old',content:null}]:[{snapshot_id:'s',path:'a',content_hash:'changed'},{snapshot_id:'s',path:'b',content_hash:'new'}]}),/identity changed/);
});
test('generated project identity can be validated without inserting generated columns on restore',()=>{
 const tables=new Map([['bv2_builds',[{id:'b',project_id:'p'}]],['events',[{id:1,build:'b',project:'p'}]]]);
 const c=catalog({bv2_builds:['id'],events:['id']},[fk('events',['build','project'],'bv2_builds',['id','project_id_text'])]);assert.equal(inspectBackupRelations(tables,c).missing.length,0);
});

test('checksum-valid backup cannot pass completion with a missing parent',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');const {gzipSync}=await import('node:zlib');
 const {validateBackupDirectory}=await import('../../scripts/lib/backupValidation.mjs');const {relationCatalogHash}=await import('../../ops/lib/backupRelations.mjs');
 const dir=await mkdtemp(path.join(tmpdir(),'backup-closure-'));const names=['events','jobs'];
 const manifest={formatVersion:3,tables:{},files:{},catalogCoverage:{names,tables:2,excluded:[],sha256:createHash('sha256').update(names.join('\n')).digest('hex')},relations:{file:'backup_relations.json.gz',catalogSha256:relationCatalogHash(base)}};
 const put=async(name,value,table=false)=>{const bytes=gzipSync(JSON.stringify(value));await writeFile(path.join(dir,name),bytes);manifest.files[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};if(table)manifest.tables[name.replace('.json.gz','')]=value.length;};
 const save=()=>writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));
 try{
  await put('jobs.json.gz',[{id:'old'}],true);await put('events.json.gz',[{id:1,job_id:'new'}],true);await put('storage_objects.json.gz',[],true);await put('backup_relations.json.gz',base);await save();
  await assert.rejects(validateBackupDirectory(dir),/referential closure failed/);
  await put('jobs.json.gz',[{id:'old'},{id:'new'}],true);await save();assert.equal((await validateBackupDirectory(dir)).ok,true);
  delete manifest.relations;await save();await assert.rejects(validateBackupDirectory(dir),/relation evidence missing/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('captured promoted snapshot cannot retain an unfinished parent state',async()=>{
 const {validateImmutableBackupContent}=await import('../../ops/lib/backupRelations.mjs');
 const tables=new Map([['bv2_snapshots',[{id:'s',state:'building'}]],['bv2_project_pointers',[{label:'green',snapshot_id:'s'}]]]);
 assert.throws(()=>validateImmutableBackupContent(tables),/promoted snapshot is not ready/);
 tables.delete('bv2_project_pointers');tables.set('projects',[{id:'p',owner:'u',bv2_green_snapshot_id:'s'}]);
 tables.get('bv2_snapshots')[0].owner='u';tables.get('bv2_snapshots')[0].project_id='p';
 assert.throws(()=>validateImmutableBackupContent(tables),/green snapshot is not ready/);
});
