import test from 'node:test';import assert from 'node:assert/strict';
import {SupabaseCodeAgentStore} from '../../shell/server/lib/codeAgentStore.mjs';
for(const outcome of ['matched','replaced','unavailable'])test(`subscription conditional write: ${outcome}`,async()=>{
 const calls=[];const row={owner:'owner',plan:'free'};
 const client={from(table){calls.push(['from',table]);return{update(patch){calls.push(['update',patch]);return this;},eq(key,value){calls.push(['eq',key,value]);return this;},select(fields){calls.push(['select',fields]);return this;},async maybeSingle(){return{data:outcome==='matched'?row:null,error:outcome==='unavailable'?{message:'retryable database failure'}:null};}};}};
 const store=new SupabaseCodeAgentStore(client);
 const run=()=>store.updateSubscriptionIfCurrent('owner','customer','subscription',{plan:'free'});
 if(outcome==='unavailable')await assert.rejects(run,/retryable database failure/);else assert.deepEqual(await run(),outcome==='matched'?row:null);
 assert.deepEqual(calls.filter(c=>c[0]==='eq'),[['eq','owner','owner'],['eq','stripe_customer_id','customer'],['eq','stripe_subscription_id','subscription']]);
 assert.equal(calls[0][1],'ca_subscriptions');assert.equal(calls.find(c=>c[0]==='update')[1].plan,'free');
});
for(const outcome of ['matched','replaced','unavailable'])test(`subscription snapshot comparison protects every overwritten field: ${outcome}`,async()=>{
 const calls=[];const client={from(){return{update(){return this;},eq(k,v){calls.push(['eq',k,v]);return this;},is(k,v){calls.push(['is',k,v]);return this;},select(){return this;},async maybeSingle(){return{data:outcome==='matched'?{plan:'starter'}:null,error:outcome==='unavailable'?{message:'retryable database failure'}:null};}};}};
 const store=new SupabaseCodeAgentStore(client);const run=()=>store.updateSubscriptionFromSnapshot('owner',{plan:'pro',status:'active',stripe_customer_id:'customer',stripe_subscription_id:'subscription',updated_at:'stamp',pending_plan:null},{plan:'starter',status:'active',pending_plan:null});
 if(outcome==='unavailable')await assert.rejects(run,/retryable database failure/);else assert.deepEqual(await run(),outcome==='matched'?{plan:'starter'}:null);
 assert.deepEqual(calls,[['eq','owner','owner'],['eq','plan','pro'],['eq','status','active'],['is','pending_plan',null],['eq','stripe_customer_id','customer'],['eq','stripe_subscription_id','subscription'],['eq','updated_at','stamp']]);
});
