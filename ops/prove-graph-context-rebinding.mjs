import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { indexTree, INDEXER_VERSION } from '../shell/server/lib/builderV2/indexer.mjs';
import { persistIndex, loadIndex, supabaseGraph } from '../shell/server/lib/builderV2/supabaseTwins.mjs';
import { fileGraphPayload, fileGraphHash, manifestOf, compareGraphIndexes } from '../shell/server/lib/builderV2/graphParity.mjs';
const name = `thrallo-graph-context-proof-${process.pid}`;
const sql = q => execFileSync('docker', ['exec','-i',name,'psql','-h','127.0.0.1','-U','postgres','-qAt','-v','ON_ERROR_STOP=1'], {input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const literal = value => value == null ? 'null' : `'${(typeof value==='object'?JSON.stringify(value):String(value)).replaceAll("'","''")}'`;
const owner='81000000-0000-4000-8000-000000000001', project='82000000-0000-4000-8000-000000000001';
const client={async rpc(name,args){try{return {data:JSON.parse(sql(`set role service_role;select public.${name}(${Object.entries(args).map(([k,v])=>`${k}=>${literal(v)}`).join(',')});`)),error:null};}catch(e){return {data:null,error:{message:e.message}};}}};
const checks=[], check=async(label,fn)=>{await fn();checks.push(label);};
const tree={'src/router.js':'import { target } from "./target.js"; export function route(currentPath) { return currentPath(); }'};
const first=indexTree(tree), next=indexTree({...tree,'src/nav.js':'export function currentPath() { return "/"; }','src/target.js':'export function target() { return 1; }'});
const payload=fileGraphPayload(next,'src/router.js');
const args={p_owner:owner,p_project_id:project,p_file:payload.file,p_symbols:payload.symbols,p_refs:payload.refs,p_edges:payload.edges,p_graph_hash:fileGraphHash(next,'src/router.js'),p_indexer_version:INDEXER_VERSION};
let started=false;
try{
 execFileSync('docker',['run','--rm','-d','--name',name,'--network','none','--memory','256m','--cpus','1','--pids-limit','128','-e','POSTGRES_PASSWORD=isolated-proof','postgres:17-alpine','-c','shared_buffers=16MB'],{stdio:'pipe'});started=true;
 let ready=false;for(let i=0;i<120;i++){try{sql('select 1');ready=true;break;}catch{await new Promise(r=>setTimeout(r,250));}}if(!ready)throw Error('isolated PostgreSQL unavailable');
 sql('create role anon;create role authenticated;create role service_role;');
 for(const file of ['graph-schema-before96.sql','graph-functions-before96.sql'])sql(await readFile(new URL(`../test/code-agent/fixtures/reliability-20261016/${file}`,import.meta.url),'utf8'));
 sql(`revoke execute on all functions in schema public from public,anon,authenticated;grant execute on all functions in schema public to service_role;grant all on all tables in schema public to service_role;insert into projects(id,owner) values('${project}','${owner}');`);
 await persistIndex(owner,project,first,{client});
 await check('old function reproduces context-only immutable conflict',()=>assert.rejects(persistIndex(owner,project,next,{client}),/conflicting graph/));
 const original=sql(`select row_to_json(r) from bv2_file_revisions r where path='src/router.js'`);
 const originalRows=sql(`select public.bv2_load_graph('${owner}','${project}',${literal(manifestOf(first))})`);
 sql(await readFile(new URL('../supabase/migrations/20261017021631_graph_context_rebinding.sql',import.meta.url),'utf8'));
 await check('new context reuses immutable revision and writes only new files',async()=>assert.deepEqual((await persistIndex(owner,project,next,{client})).written,['src/nav.js','src/target.js']));
 await check('original revision and children are byte-for-byte unchanged',()=>{
 assert.equal(sql(`select row_to_json(r) from bv2_file_revisions r where path='src/router.js'`),original);
 assert.equal(sql(`select public.bv2_load_graph('${owner}','${project}',${literal(manifestOf(first))})`),originalRows);
 });
 for(const [label,index] of [['old',first],['new',next],['ambiguous',indexTree({...tree,'src/nav.js':'export function currentPath() { return "/"; }','src/other.js':'export function currentPath() { return "/other"; }'})]]){
  await persistIndex(owner,project,index,{client});
  await check(`${label} manifest round-trip derives correct call and import targets`,async()=>{const loaded=await loadIndex(owner,project,manifestOf(index),{client});const proof=compareGraphIndexes(index,loaded,{owner,projectId:project});assert.equal(proof.clean,true,JSON.stringify(proof.mismatches));});
 }
 for(const [label,change] of [
 ['symbols',{p_symbols:payload.symbols.map(s=>({...s,name:'forged'}))}],
 ['references',{p_refs:payload.refs.map(r=>({...r,ref_name:'forged'}))}],
 ['imports',{p_edges:payload.edges.map(e=>({...e,specifier:'./forged.js'}))}],
 ['version',{p_indexer_version:'forged-v9'}],
 ['metadata',{p_file:{...payload.file,tokens:999}}],
 ['null hash',{p_graph_hash:null}],['null symbols',{p_symbols:null}],
 ['owner',{p_owner:'81000000-0000-4000-8000-000000000002'}]
 ])await check(`rejects changed ${label}`,async()=>assert.ok((await client.rpc('bv2_persist_file_revision',{...args,...change})).error));
 for(const role of ['anon','authenticated'])await check(`${role} cannot persist or read graphs`,()=>{
  for(const query of [`select public.bv2_persist_file_revision(${Object.values(args).map(literal).join(',')})`,`select public.bv2_load_graph('${owner}','${project}',${literal(manifestOf(first))})`])assert.throws(()=>sql(`set role ${role};${query}`),/permission denied/);
 });
 await check('cross-owner load rejected',()=>assert.rejects(loadIndex('81000000-0000-4000-8000-000000000002',project,manifestOf(first),{client}),/does not belong/));
 sql("update bv2_symbol_refs set resolved_path='tampered' where revision_id=(select id from bv2_file_revisions where path='src/router.js')");
 await check('stored target corruption is caught before rebind',()=>assert.rejects(supabaseGraph(owner,project,manifestOf(next),{client}),/stale/));
 sql("update bv2_symbol_refs set resolved_path=null where revision_id=(select id from bv2_file_revisions where path='src/router.js')");
 sql("delete from bv2_dependency_edges where from_path='src/router.js'");
 await check('different context cannot conceal missing children',()=>assert.rejects(persistIndex(owner,project,next,{client}),/conflicting graph/));
 await check('original context can atomically repair missing children',async()=>assert.deepEqual((await persistIndex(owner,project,first,{client})).repaired,['src/router.js']));
 await check('repaired original still loads with new context',async()=>assert.equal(compareGraphIndexes(next,await loadIndex(owner,project,manifestOf(next),{client}),{owner,projectId:project}).clean,true));
 console.log(JSON.stringify({passed:checks.length,checks,scope:'isolated PostgreSQL, production functions and internal constraints; actual JS persistence/load/parity; no production rows'},null,2));
}finally{if(started)execFileSync('docker',['rm','-f',name],{stdio:'pipe'});}
