import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const name=`thrallo-credit-totals-proof-${process.pid}`;
const sql=q=>execFileSync('docker',['exec','-i',name,'psql','-U','postgres','-qAt','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const checks=[];const check=(name,fn)=>{fn();checks.push(name);};let started=false;
try {
 execFileSync('docker',['run','--rm','-d','--name',name,'--network','none','--memory','256m','--cpus','1','--pids-limit','128','-e','POSTGRES_PASSWORD=isolated-proof','postgres:17-alpine','-c','shared_buffers=16MB','-c','max_connections=20'],{stdio:'pipe'});started=true;
 let ready=false;for(let n=0;n<120;n++){try{sql('select 1');ready=true;break;}catch{await new Promise(r=>setTimeout(r,250));}}if(!ready)throw Error('Isolated PostgreSQL unavailable');
 sql(`create role anon;create role authenticated;create role service_role;create table public.credit_ledger(owner uuid,delta numeric(14,4),bucket text,kind text);insert into credit_ledger select '${A}',0.1250,'topup','topup' from generate_series(1,1500);insert into credit_ledger values('${A}',-20,'topup','debit'),('${A}',2.1234,'bundle','service_credit'),('${A}',0.25,'bundle','refund'),('${A}',999,'bundle','grant'),('${A}',-800,'bundle','debit'),('${B}',9000,'topup','topup'),('${B}',100,'bundle','service_credit');`);
 sql(await readFile(new URL('../supabase/migrations/20261017000100_credit_balance_totals.sql',import.meta.url),'utf8'));
 const totals=owner=>JSON.parse(sql(`set role service_role;select row_to_json(t) from public.credit_balance_totals('${owner}') t;`));
 check('all 1501 purchased ledger rows counted exactly',()=>assert.equal(totals(A).topup,167.5));
 check('refunds/service credits counted, unrelated bundle kinds excluded',()=>assert.equal(totals(A).protected_credits,2.3734));
 check('owner isolation',()=>assert.deepEqual(totals(B),{topup:9000,protected_credits:100}));
 check('empty owner receives zero totals',()=>assert.deepEqual(totals('33333333-3333-4333-8333-333333333333'),{topup:0,protected_credits:0}));
 for(const role of ['anon','authenticated'])check(`${role} cannot request any owner balance`,()=>assert.throws(()=>sql(`set role ${role};select * from public.credit_balance_totals('${A}');`),/permission denied/));
 check('service needs no raw ledger read grant',()=>assert.throws(()=>sql('set role service_role;select * from credit_ledger;'),/permission denied/));
 check('negative purchased total clamps to zero',()=>{sql(`insert into credit_ledger values('${A}',-1000,'topup','debit');`);assert.equal(totals(A).topup,0);});
 check('aggregate never mutates ledger',()=>assert.equal(sql('select count(*) from credit_ledger;'),'1508'));
 console.log(JSON.stringify({passed:checks.length,checks}));
}finally{if(started)execFileSync('docker',['rm','-f',name],{stdio:'pipe'});}
