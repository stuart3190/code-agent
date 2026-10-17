import { createHash } from 'node:crypto';
import { treeHashFromPairs } from '../../shell/server/lib/builderV2/snapshotStore.mjs';
import { prepareRowsForBackup, validateRuntimeBackupLinks } from './runtimeBackupSchema.mjs';

const containerChildren = [
  ['bv2_file_revisions','bv2_symbols','revision_id','symbol_count'],
  ['bv2_file_revisions','bv2_symbol_refs','revision_id','ref_count'],
  ['bv2_file_revisions','bv2_dependency_edges','revision_id','edge_count'],
  ['bv2_snapshots','bv2_snapshot_files','snapshot_id','file_count'],
];
const key = values => JSON.stringify(values);
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])) : value;
const valueOf = (table, row, column) => {
  // These generated columns are deliberately excluded from restore INSERT payloads.
  if (column === 'project_id_text' && ['bv2_builds','diag_runs'].includes(table)) return row.project_id == null ? null : String(row.project_id);
  if (!Object.hasOwn(row, column)) throw Error(`backup relation column missing: ${table}.${column}`);
  return row[column];
};
const valuesOf = (table,row,columns) => columns.map(column=>valueOf(table,row,column));
export const relationCatalogHash = catalog => createHash('sha256').update(JSON.stringify(catalog)).digest('hex');

export function inspectBackupRelations(tables, catalog) {
  if (catalog?.version !== 1 || !Array.isArray(catalog.foreignKeys) || !Array.isArray(catalog.primaryKeys)) throw Error('invalid backup relation catalog');
  const primaryKeys = new Map(catalog.primaryKeys.map(row=>[row.table,row.columns]));
  primaryKeys.set('auth_users',['id']);
  for(const [table,rows] of tables){
    const columns=primaryKeys.get(table);
    if(!columns?.length)throw Error(`backup primary key absent from catalog: ${table}`);
    const seen=new Set();for(const row of rows){const values=valuesOf(table,row,columns);if(values.some(v=>v==null))throw Error(`backup primary key missing: ${table}`);const id=key(values);if(seen.has(id))throw Error(`duplicate backup primary key: ${table}`);seen.add(id);}
  }
  const indexes=new Map(), missing=new Map(), containers=[], blobs=new Map();
  const indexed=(table,columns)=>{
    if(!tables.has(table))throw Error(`backup relation parent table missing: ${table}`);
    const id=key([table,columns]);if(!indexes.has(id))indexes.set(id,new Set(tables.get(table).map(row=>key(valuesOf(table,row,columns)))));return indexes.get(id);
  };
  for(const fk of catalog.foreignKeys){
    if(!tables.has(fk.table))continue;
    if(!['s','f'].includes(fk.match) || !fk.columns?.length || fk.columns.length!==fk.parentColumns?.length)throw Error(`unsupported backup relation: ${fk.name}`);
    const parent=fk.parentSchema==='public'?fk.parentTable:fk.parentSchema==='auth'&&fk.parentTable==='users'?'auth_users':null;
    if(!parent)throw Error(`unsupported backup parent schema: ${fk.name}`);
    const parentRows=indexed(parent,fk.parentColumns);
    for(const row of tables.get(fk.table)){
      const values=valuesOf(fk.table,row,fk.columns),nulls=values.filter(v=>v===null).length;
      if(nulls){if(fk.match==='f'&&nulls!==values.length)throw Error(`partial null in MATCH FULL relation: ${fk.name}`);continue;}
      if(!parentRows.has(key(values)))missing.set(key([parent,fk.parentColumns,values]),{table:parent,columns:fk.parentColumns,values,constraint:fk.name});
    }
  }
  for(const [parent,child,column,count] of containerChildren){
    if(!tables.has(parent))continue;
    if(!tables.has(child))throw Error(`backup immutable child table missing: ${child}`);
    const counts=new Map();for(const row of tables.get(child))counts.set(row[column],(counts.get(row[column])||0)+1);
    for(const row of tables.get(parent)){
      if(parent !== 'bv2_snapshots' && row.state!=='ready')continue;
      const actual=counts.get(row.id)||0,expected=row[count];
      if(!Number.isInteger(expected)||expected<0)throw Error(`invalid immutable child count: ${parent}`);
      if(actual>expected)throw Error(`backup immutable container has extra children: ${parent}/${child}`);
      if(actual<expected)containers.push({table:child,columns:[column],values:[row.id],expected,actual});
    }
  }
  if(tables.has('bv2_snapshot_files')){
    const snapshots=new Map((tables.get('bv2_snapshots')||[]).map(row=>[row.id,row]));
    const existing=indexed('bv2_blobs',['owner','content_hash']);
    for(const row of tables.get('bv2_snapshot_files')){
      const snapshot=snapshots.get(row.snapshot_id);if(!snapshot)continue; // FK closure fetches it first.
      const values=[snapshot.owner,row.content_hash];if(!existing.has(key(values)))blobs.set(key(values),{table:'bv2_blobs',columns:['owner','content_hash'],values,constraint:'snapshot_blob_content'});
    }
  }
  return {missing:[...missing.values(),...blobs.values()],containers,primaryKeys};
}

/** Bounded additive closure only: never discard rows or replace a captured identity. */
export async function reconcileBackupRelations(tables,catalog,{fetchRows,maxRounds=12,maxAddedRows=20000}={}){
  if(typeof fetchRows!=='function')throw Error('backup relation fetcher required');
  const changed=new Set();let addedRows=0;
  for(let round=0;round<=maxRounds;round++){
    const inspection=inspectBackupRelations(tables,catalog);
    if(!inspection.missing.length&&!inspection.containers.length){
      validateImmutableBackupContent(tables);
      return {rounds:round,addedRows,changedTables:[...changed].sort(),catalogSha256:relationCatalogHash(catalog)};
    }
    if(round===maxRounds)throw Error('backup relation reconciliation exhausted');
    let addedThisRound=0;
    const requests=new Map([...inspection.missing,...inspection.containers].map(r=>[key([r.table,r.columns,r.values]),r]));
    for(const request of requests.values()){
      const fetched=await fetchRows(request);
      if(!Array.isArray(fetched)||!fetched.length)throw Error(`backup referenced rows unavailable: ${request.table} (${request.constraint||'immutable children'})`);
      const rows=tables.get(request.table);if(!rows)throw Error(`backup relation destination absent: ${request.table}`);
      const columns=inspection.primaryKeys.get(request.table);
      const byId=new Map(rows.map(row=>[key(valuesOf(request.table,row,columns)),row]));
      for(const row of prepareRowsForBackup(request.table,fetched)){
        if(key(valuesOf(request.table,row,request.columns))!==key(request.values))throw Error(`backup relation fetch returned unrelated row: ${request.table}`);
        const id=key(valuesOf(request.table,row,columns));
        if(byId.has(id)){
          // Container hydration may include earlier captured immutable children. They must agree.
          const existing=byId.get(id);
          if(Object.keys(row).some(k=>JSON.stringify(stable(row[k]))!==JSON.stringify(stable(existing[k]))))throw Error(`backup relation identity changed during export: ${request.table}`);
          continue;
        }
        if(++addedRows>maxAddedRows)throw Error('backup relation row bound exceeded');
        rows.push(row);byId.set(id,row);changed.add(request.table);addedThisRound++;
      }
    }
    if(!addedThisRound)throw Error('backup relation reconciliation made no progress');
  }
}

export function validateImmutableBackupContent(tables){
  const runtimeProblems=validateRuntimeBackupLinks(Object.fromEntries(tables));
  if(runtimeProblems.length)throw Error(`backup runtime links invalid: ${runtimeProblems.length} problems`);
  const snapshots=new Map((tables.get('bv2_snapshots')||[]).map(row=>[row.id,row]));
  for(const pointer of tables.get('bv2_project_pointers')||[]) {
    if(['green','preview','published'].includes(pointer.label) && snapshots.get(pointer.snapshot_id)?.state !== 'ready') throw Error('backup promoted snapshot is not ready');
  }
  for(const project of tables.get('projects')||[]) {
    if(project.bv2_green_snapshot_id && snapshots.get(project.bv2_green_snapshot_id)?.state !== 'ready') throw Error('backup project green snapshot is not ready');
  }
  const hash=text=>createHash('sha256').update(text).digest('hex');
  if(tables.has('bv2_snapshots')){
    const filesBySnapshot=new Map();
    for(const file of tables.get('bv2_snapshot_files')||[]){if(!filesBySnapshot.has(file.snapshot_id))filesBySnapshot.set(file.snapshot_id,[]);filesBySnapshot.get(file.snapshot_id).push(file);}
    for(const snapshot of tables.get('bv2_snapshots')){
      const files=filesBySnapshot.get(snapshot.id)||[];
      if(files.length!==snapshot.file_count||treeHashFromPairs(files.map(f=>[f.path,f.content_hash]))!==snapshot.tree_hash)throw Error('backup snapshot tree hash or child count mismatch');
    }
  }
  for(const blob of tables.get('bv2_blobs')||[]){
    if(blob.content==null)continue; // Storage payloads are independently checksummed and restored.
    if(Buffer.byteLength(String(blob.content))!==blob.size_bytes||hash(String(blob.content))!==blob.content_hash)throw Error('backup inline blob integrity mismatch');
  }
}
