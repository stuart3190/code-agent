// Execute the store's exact conditional-update filters against disposable PostgreSQL.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {SupabaseCodeAgentStore} from '../shell/server/lib/codeAgentStore.mjs';
if(process.env.BILLING_TRANSACTION_PROOF!=='1')throw Error('BILLING_TRANSACTION_PROOF=1 required');
const container=process.env.BILLING_TRANSACTION_CONTAINER||'thrallo-dispatch-full-schema-proof-v2-20261017';
if(!/^thrallo-dispatch-[a-z0-9-]*proof[a-z0-9-]*$/.test(container))throw Error('Disposable proof container required');
const config=JSON.parse(execFileSync('docker',['inspect','--format','{{json .HostConfig}}',container],{encoding:'utf8'}));
assert.equal(config.NetworkMode,'none');assert.equal(Object.keys(config.PortBindings||{}).length,0);
const args=['exec','-i',container,'psql','-U','postgres','-v','ON_ERROR_STOP=1','-qAt'];
const sql=s=>execFileSync('docker',args,{input:s,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
const asyncSql=s=>new Promise((resolve,reject)=>{const p=spawn('docker',args,{stdio:['pipe','pipe','pipe']});let out='',error='';p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>error+=v);p.on('error',reject);p.on('close',code=>code?reject(Error(error)):resolve(out.trim()));p.stdin.end(s);});
const quote=v=>v==null?'null':typeof v==='boolean'?String(v):`'${String(v).replaceAll("'","''")}'`;
const ident=v=>{assert.match(v,/^[a-z_]+$/);return `"${v}"`;};
const client={from(table){assert.equal(table,'ca_subscriptions');let patch,filters=[];return{
 update(value){patch=value;return this;},eq(key,value){filters.push(`${ident(key)}=${quote(value)}`);return this;},is(key,value){assert.equal(value,null);filters.push(`${ident(key)} is null`);return this;},select(fields){assert.equal(fields,'*');return this;},
 async maybeSingle(){try{const out=await asyncSql(`set role service_role;with changed as (update public.ca_subscriptions set ${Object.entries(patch).map(([k,v])=>`${ident(k)}=${quote(v)}`).join(',')} where ${filters.join(' and ')} returning *)select row_to_json(changed) from changed;`);return{data:out?JSON.parse(out):null,error:null};}catch(error){return{data:null,error};}}
 };}};
const store=new SupabaseCodeAgentStore(client),checks=[];
const check=(name,fn)=>{fn();checks.push(name);};
function fixture(){const owner=randomUUID(),customer='cus_'+randomUUID(),subscription='sub_'+randomUUID();sql(`insert into auth.users(id)values(${quote(owner)});insert into ca_subscriptions(owner,plan,status,stripe_customer_id,stripe_subscription_id)values(${quote(owner)},'starter','active',${quote(customer)},${quote(subscription)});`);return{owner,customer,subscription};}
const read=f=>JSON.parse(sql(`select row_to_json(s) from ca_subscriptions s where owner=${quote(f.owner)}`));
const first=fixture(),initial=read(first);
const saved=await store.updateSubscriptionFromSnapshot(first.owner,initial,{plan:'pro',pending_plan:null,cancel_at_period_end:false});
check('snapshot update handles nullable fields and PostgreSQL timestamps',()=>assert.equal(saved.plan,'pro'));
const race=fixture(),expected=read(race);
const results=await Promise.all(['pro','free'].map(plan=>store.updateSubscriptionFromSnapshot(race.owner,expected,{plan,pending_plan:null})));
check('competing snapshots permit exactly one write',()=>assert.equal(results.filter(Boolean).length,1));
check('stored plan equals the winning response',()=>assert.equal(read(race).plan,results.find(Boolean).plan));
const collision=fixture(),before=read(collision);
sql(`update ca_subscriptions set plan='pro',updated_at=${quote(before.updated_at)} where owner=${quote(collision.owner)}`);
const stale=await store.updateSubscriptionFromSnapshot(collision.owner,before,{plan:'free'});
check('equal timestamp cannot conceal a changed entitlement',()=>{assert.equal(stale,null);assert.equal(read(collision).plan,'pro');});
const replacement=fixture(),old=read(replacement);
sql(`update ca_subscriptions set stripe_subscription_id='sub_replacement' where owner=${quote(replacement.owner)}`);
const cancelled=await store.updateSubscriptionIfCurrent(replacement.owner,replacement.customer,replacement.subscription,{plan:'free',stripe_subscription_id:null});
check('cancellation returns no match for old subscription identity',()=>{assert.equal(cancelled,null);assert.equal(read(replacement).stripe_subscription_id,'sub_replacement');assert.equal(read(replacement).plan,'starter');});
const mismatched=await store.updateSubscriptionFromSnapshot(randomUUID(),old,{plan:'free'});
check('snapshot cannot update another owner',()=>assert.equal(mismatched,null));
for(const role of ['anon','authenticated'])check(`${role} cannot mutate entitlements directly`,()=>{
 try{assert.equal(sql(`set role ${role};with changed as (update ca_subscriptions set plan='free' where owner=${quote(first.owner)} returning owner)select count(*) from changed`),'0');}catch(error){assert.match(error.message,/permission denied/);}
 assert.equal(read(first).plan,'pro');
});
console.log(JSON.stringify({passed:checks.length,checks,environment:'isolated PostgreSQL; synthetic identities; network none; no ports',productionMutation:false},null,2));
