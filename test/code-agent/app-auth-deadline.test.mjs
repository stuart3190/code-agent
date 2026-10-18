import test from 'node:test';import assert from 'node:assert/strict';
import{createSupabaseBackend,ensureAppVisitorSession}from'../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js';
function backend(fetchImpl){return createSupabaseBackend({url:'https://example.supabase.co',anonKey:'public-fixture-key',appId:'fixture',authUrl:'https://example.supabase.co/functions/v1/app-auth',fetchImpl});}
for(const stage of ['headers','body'])test(`stalled app auth ${stage} aborts with a retryable timeout`,async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let signal,settled=false;
 const api=backend(async(_url,init)=>{signal=init.signal;assert.ok(signal,'auth transport must have a deadline');const pending=()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return stage==='headers'?pending():{ok:true,json:pending};});
 const outcome=api.auth.resetPassword({email:'audit@example.test'}).then(()=>({ok:true}),error=>({error})).finally(()=>{settled=true});
 await Promise.resolve();t.mock.timers.tick(29999);await Promise.resolve();assert.equal(settled,false);
 t.mock.timers.tick(1);const result=await outcome;assert.equal(signal?.aborted,true);assert.equal(result.error?.code,'app_auth_timeout');assert.equal(result.error?.retryable,true);
});
test('successful auth response clears its deadline and preserves action payload',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let signal,payload;
 const api=backend(async(_url,init)=>{signal=init.signal;payload=JSON.parse(init.body);assert.ok(signal);return{ok:true,json:async()=>({ok:true})}});
 await api.auth.resetPassword({email:'audit@example.test'});t.mock.timers.tick(60000);assert.equal(signal.aborted,false);assert.equal(payload.action,'reset');assert.equal(payload.appId,'fixture');
});

test('visitor retry after timeout reuses the persisted identity instead of creating new credentials',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const payloads=[],saved=new Map();let attempt=0;
 const api=backend(async(_url,init)=>{payloads.push(JSON.parse(init.body));attempt++;if(attempt===1)return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));return{ok:true,json:async()=>({user:{id:'visitor'},session:{access_token:'fixture-access',refresh_token:'fixture-refresh'}})}});
 api._client.auth.getUser=async()=>({data:{user:null},error:null});api._client.auth.setSession=async()=>({data:{},error:null});
 const storage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},options={auth:api.auth,appId:'fixture',storage,randomUUID:()=>{assert.equal(saved.size,0);return'fixed-visitor'}};
 const failed=ensureAppVisitorSession(options).catch(e=>e);for(let i=0;i<10;i++)await Promise.resolve();assert.equal(payloads.length,1);t.mock.timers.tick(30000);assert.equal((await failed).code,'app_auth_timeout');
 const user=await ensureAppVisitorSession(options);assert.equal(user.id,'visitor');assert.deepEqual(payloads[1],payloads[0]);
});
