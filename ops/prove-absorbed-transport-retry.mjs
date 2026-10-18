import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const name = `thrallo-transport-proof-${process.pid}`;
const sql = q => execFileSync('docker', ['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: q, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const owner = '81000000-0000-4000-8000-000000000001', project = '82000000-0000-4000-8000-000000000001';
const build = n => `83000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const call = (n, key, amount=1.9955, pool='thrallo_recovery', responsibility='thrallo_repair', who=owner) => `select public.reserve_bv2_model_call_v4('${who}','${project}','${build(n)}','${key}','contract','codex','gpt-5.5','connected_allowance','${responsibility}','${pool}',${amount},3.2911);`;
const reserve = (...args) => JSON.parse(sql(`set role service_role;${call(...args)}`));
const checks = [], check = (label, fn) => { fn(); checks.push(label); };
let started = false;
try {
  execFileSync('docker', ['run','--rm','-d','--name',name,'--network','none','--memory','256m','--cpus','1','--pids-limit','128','-e','POSTGRES_PASSWORD=isolated-proof','postgres:17-alpine','-c','shared_buffers=16MB'],{stdio:'pipe'}); started=true;
  let ready=false; for(let i=0;i<120;i++){try{sql('select 1');ready=true;break;}catch{await new Promise(r=>setTimeout(r,250));}} if(!ready)throw Error('isolated PostgreSQL unavailable');
  sql('create role anon;create role authenticated;create role service_role;');
  sql(await readFile(new URL('../test/code-agent/fixtures/reliability-20261016/reservation-schema.sql',import.meta.url),'utf8'));
  sql(await readFile(new URL('../test/code-agent/fixtures/reliability-20261016/reservation-functions-before94.sql',import.meta.url),'utf8'));
  sql(`revoke execute on all functions in schema public from public,anon,authenticated;grant execute on all functions in schema public to service_role;grant all on all tables in schema public to service_role;
  insert into bv2_feature_flags(key,value) values('recovery.funding_policy.owner_connected_v1',jsonb_build_object('state','active','policyVersion','owner_connected_recovery_v1','executionTransport','platform_connected_codex','fundingSource','thrallo','deploymentCommit',repeat('a',40),'deploymentManifestSha256',repeat('b',64)));
  insert into bv2_builds(id,owner,project_id,profile,request) select ('83000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'${owner}','${project}','proof','isolated proof' from generate_series(1,5) n;`);
  const original=reserve(1,'original-call').reservation;
  sql(`update bv2_model_reservations set reconciliation_state='pending',provider_request_ids='["transport-original"]' where id='${original.id}';`);
  check('pending unresolved call still blocks extra reserve',()=>assert.throws(()=>reserve(1,'retry-call'),/funding-pool ceiling exceeded/));
  sql(`set role service_role;select public.absorb_ambiguous_bv2_model_call('${owner}','${original.id}','bounded transport retry');`);
  check('reproduces old absorbed-hold retry failure',()=>assert.throws(()=>reserve(1,'retry-call'),/funding-pool ceiling exceeded/));
  sql(await readFile(new URL('../supabase/migrations/20261017014446_absorbed_transport_retry_headroom.sql',import.meta.url),'utf8'));
  let retry;
  check('absorbed hold no longer blocks retry reservation',()=>{retry=reserve(1,'retry-call').reservation;assert.notEqual(retry.id,original.id);});
  check('ordinary new hold still consumes ceiling',()=>assert.throws(()=>reserve(1,'third-call'),/funding-pool ceiling exceeded/));
  check('retry identity is durable and idempotent',()=>assert.equal(reserve(1,'retry-call').acquired,false));
  check('cross-owner reservation rejected',()=>assert.throws(()=>reserve(1,'wrong-owner',1.9955,'thrallo_recovery','thrallo_repair','81000000-0000-4000-8000-000000000002'),/not owned/));
  check('invalid recovery funding responsibility rejected',()=>assert.throws(()=>reserve(1,'wrong-payer',1,'thrallo_recovery','customer_request'),/invalid Builder/));
  sql(`set role service_role;select public.release_held_bv2_model_calls('${owner}','${build(1)}');`);
  check('release preserves absorbed transport provenance',()=>assert.equal(sql(`select state||':'||reconciliation_state||':'||(provider_request_ids->>0) from bv2_model_reservations where id='${original.id}'`),'released:platform_assumed:transport-original'));
  check('unambiguous unused retry releases as rejected',()=>assert.equal(sql(`select reconciliation_state from bv2_model_reservations where id='${retry.id}'`),'provider_rejected'));
  const terminal=reserve(2,'terminal-original').reservation;
  sql(`update bv2_model_reservations set reconciliation_state='pending' where id='${terminal.id}';set role service_role;select public.absorb_ambiguous_bv2_model_call('${owner}','${terminal.id}','transport');select public.settle_bv2_build_terminal('${owner}','${build(2)}','failed','platform',false,true);`);
  check('terminal settlement preserves absorbed provenance',()=>assert.equal(sql(`select state||':'||reconciliation_state from bv2_model_reservations where id='${terminal.id}'`),'released:platform_assumed'));
  check('unknown usage creates no invented charges or refunds',()=>assert.equal(sql('select count(*) from credit_ledger'),'0'));
  const settled=reserve(3,'settled-original').reservation;
  sql(`update bv2_model_reservations set state='settled',settled_at=now(),actual_credits=2,included_actual_credits=0,purchased_actual_credits=0,platform_actual_credits=0,reconciliation_state='provider_settled' where id='${settled.id}'`);
  check('reported usage still consumes pool ceiling',()=>assert.throws(()=>reserve(3,'settled-next'),/funding-pool ceiling exceeded/));
  for(const role of ['anon','authenticated'])check(`${role} cannot reserve`,()=>assert.throws(()=>sql(`set role ${role};${call(4,'browser-call')}`),/permission denied/));
  // This known separate defect is deliberately reproduced, not hidden by weakening pool checks.
  sql(`insert into bv2_model_reservations(owner,project_id,build_id,call_key,step,provider,model,billing_lane,reserved_credits,included_reserved_credits,reconciliation_state,recovery_policy_version) values('${owner}','${project}','${build(5)}','managed-pending','contract','openai','gpt-5.5','managed',1,1,'pending','owner_connected_recovery_v1');`);
  check('separate managed absorption policy conflict reproduced',()=>assert.throws(()=>sql(`select public.absorb_ambiguous_bv2_model_call('${owner}',(select id from bv2_model_reservations where call_key='managed-pending'),'transport')`),/pool_responsibility_check/));
  if (process.argv.includes("--reconcile-customer-liability")) {
    sql(await readFile(new URL('../supabase/migrations/20261017015857_customer_transport_liability_reconciliation.sql',import.meta.url),'utf8'));
    sql(`create schema extensions;create extension pgcrypto with schema extensions;
      create table ca_model_call_identities(provider_request_fingerprint text primary key,provider text,reservation_kind text,reservation_id uuid,owner uuid);
      grant all on ca_model_call_identities to service_role;grant usage on schema extensions to service_role;`);
    sql(await readFile(new URL('../test/code-agent/fixtures/reliability-20261016/settle-model-call-v2.sql',import.meta.url),'utf8'));
    // Grant mirrors service-only production authority after loading this fixture function.
    sql('revoke execute on all functions in schema public from public,anon,authenticated;grant execute on all functions in schema public to service_role;');
    let n=10;
    for(const lane of ['managed','connected_allowance','byok_api']) {
      for(const cleanup of ['release','release-pending','terminal','actual-usage']) {
        n++;
        sql(`insert into bv2_builds(id,owner,project_id,profile,request) values('${build(n)}','${owner}','${project}','proof','liability reconciliation');`);
        const provider=lane==='connected_allowance'?'codex':'openai';
        const r=JSON.parse(sql(`set role service_role;select public.reserve_bv2_model_call_v4('${owner}','${project}','${build(n)}','customer-original','contract','${provider}','gpt-5.5','${lane}','customer_request','customer_generation',1,3.2911,2,'2000-01-01',0);`)).reservation;
        sql(`update bv2_model_reservations set reconciliation_state='pending',provider_request_ids='["original-${n}"]' where id='${r.id}';`);
        if(!['terminal','release-pending'].includes(cleanup))sql(`set role service_role;select public.absorb_ambiguous_bv2_model_call('${owner}','${r.id}','transport interrupted');`);
        if(['release','release-pending'].includes(cleanup))sql(`set role service_role;select public.release_held_bv2_model_calls('${owner}','${build(n)}');`);
        if(cleanup==='terminal')sql(`set role service_role;select public.settle_bv2_build_terminal('${owner}','${build(n)}','failed','platform',false,true);`);
        if(cleanup==='actual-usage')sql(`set role service_role;select public.settle_bv2_model_call_v2('${owner}','${r.id}',0.75,'{"input":10,"output":10}','["original-${n}"]');`);
        const row=JSON.parse(sql(`select row_to_json(r) from bv2_model_reservations r where id='${r.id}'`));
        check(`${lane} ${cleanup} preserves transport and assigns liability without customer charge`,()=>{
          assert.equal(row.billing_lane,lane);assert.equal(row.provider,provider);assert.equal(row.funding_pool,'customer_generation');
          assert.equal(row.usage_responsibility,'platform_failure');
          assert.equal(row.included_reserved_credits,0);assert.equal(row.purchased_reserved_credits,0);
          assert.equal(row.included_actual_credits||0,0);assert.equal(row.purchased_actual_credits||0,0);
          assert.equal(row.reconciliation_state,cleanup==='actual-usage'?'provider_settled':'platform_assumed');
          assert.equal(row.platform_actual_credits||0,cleanup==='actual-usage'&&lane==='managed'?0.75:0);
        });
      }
    }
    check('late authoritative usage produces no customer usage or debit',()=>{assert.equal(sql('select count(*) from ca_usage_records'),'0');assert.equal(sql('select count(*) from credit_ledger'),'0');});
    check('reconciliation exception does not admit platform-failure customer dispatch',()=>assert.throws(()=>reserve(4,'forged-failure',1,'customer_generation','platform_failure'),/invalid Builder/));
    check('managed recovery dispatch remains prohibited',()=>assert.throws(()=>sql(`set role service_role;select public.reserve_bv2_model_call_v4('${owner}','${project}','${build(4)}','managed-recovery','contract','openai','gpt-5.5','managed','thrallo_repair','thrallo_recovery',1,3);`),/invalid Builder/));
    for(const role of ['anon','authenticated'])check(`${role} cannot absorb liabilities`,()=>assert.throws(()=>sql(`set role ${role};select public.absorb_ambiguous_bv2_model_call('${owner}','${original.id}','forged');`),/permission denied/));
  }
  console.log(JSON.stringify({passed:checks.length,checks,scope:'isolated production-shaped tables and constraints; no production rows; external foreign keys omitted'},null,2));
} finally { if(started)execFileSync('docker',['rm','-f',name],{stdio:'pipe'}); }
