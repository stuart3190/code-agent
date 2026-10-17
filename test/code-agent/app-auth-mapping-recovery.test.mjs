import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import path from 'node:path';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
const {build}=createRequire(fileURLToPath(new URL('../../harness/.deps/package.json',import.meta.url)))('esbuild');
const source=process.env.APP_AUTH_TEST_SOURCE||fileURLToPath(new URL('../../supabase/functions/app-auth/index.ts',import.meta.url));
const bundle=await build({stdin:{contents:await readFile(source,'utf8'),loader:'ts',resolveDir:path.dirname(source)},bundle:true,format:'iife',write:false,plugins:[{name:'fixture',setup(b){b.onResolve({filter:/^npm:@supabase\/supabase-js@/},()=>({path:'client',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const createClient=globalThis.__createClient',loader:'js'}));}}]});
const appId='11111111-1111-4111-8111-111111111111',origin='https://p11111111111141118111111111111111.preview.buildr101.com',password='Fixture-password-123';
function fixture({fault=null,orphan=false,raceStatus=null,raceIdentity=null,lookupFailure=false,appCountError=false,appCountMissing=false,eventCountError=false,resetCountError=false,appCount=0,ipCount=0,resetCount=0,platform=true}={}){
 let handler;const state={auth:orphan?{id:'fixture-user',password}:null,mapping:null,deletions:0,signins:0,inserts:0,faultUsed:false};
 const svc={auth:{admin:{async createUser(){if(state.auth)return{data:{user:null},error:{message:'User already registered'}};state.auth={id:'fixture-user',password};if(raceStatus||raceIdentity)state.mapping={id:'mapping',auth_user_id:raceIdentity||'fixture-user',status:raceStatus||'active'};return{data:{user:{id:state.auth.id}},error:null}},async deleteUser(){state.deletions++;state.auth=null;return{error:null}}}},from(table){let operation='read',row,head=false;const result=()=>{
  if(table==='projects')return{data:{id:appId,preview_ref:origin},error:null};
  if(table==='app_users'){
   if(head)return{count:appCountMissing?null:appCount,error:appCountError?{message:'private count detail'}:null};
   if(operation==='insert'){
    state.inserts++;
    if(state.mapping)return{data:null,error:{code:'23505',message:'duplicate'}};
    if(fault&&!state.faultUsed){state.faultUsed=true;if(fault==='commit-lost'||fault==='commit-reject')state.mapping={id:'mapping',auth_user_id:row.auth_user_id,status:'active'};if(fault==='commit-reject')throw Error('private transport rejection');return{data:null,error:{message:'private transport detail'}};}
    state.mapping={id:'mapping',auth_user_id:row.auth_user_id,status:'active'};return{data:state.mapping,error:null};
   }
   if(lookupFailure)return{data:null,error:{message:'private database detail'}};
   return{data:state.mapping,error:null};
  }
  if(table==='app_password_resets')return{data:null,count:resetCount,error:resetCountError?{message:'private reset count detail'}:null};
  return{data:null,count:table==='app_auth_events'?ipCount:0,error:table==='app_auth_events'&&eventCountError?{message:'private event count detail'}:null};
 };return{select(_fields,options){head=options?.head===true;return this},eq(){return this},gte(){return this},lt(){return this},delete(){return this},insert(value){operation='insert';row=value;return this},update(){return this},maybeSingle:async()=>result(),then:(resolve,reject)=>Promise.resolve().then(result).then(resolve,reject)};}};
 const anon={auth:{async signInWithPassword(input){state.signins++;if(!state.auth||input.password!==state.auth.password)return{data:{user:null,session:null},error:{message:'invalid credentials'}};return{data:{user:{id:state.auth.id},session:{access_token:'fixture-access',refresh_token:'fixture-refresh'}},error:null}}}};
 vm.runInNewContext(bundle.outputFiles[0].text,{Request,Response,URL,TextEncoder,crypto:webcrypto,console,setTimeout,Deno:{env:{get:key=>({SUPABASE_URL:'https://fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'service',SUPABASE_ANON_KEY:'anon',RESEND_API_KEY:'fixture',APP_AUTH_RESET_PEPPER:'fixture-pepper'})[key]||''},serve:fn=>handler=fn},__createClient:(_url,key)=>key==='service'?svc:anon});
 return{state,async signup(suppliedPassword=password){const r=await handler(new Request('https://fixture.supabase.co/functions/v1/app-auth',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','x-forwarded-for':platform?'51.195.136.189':'192.0.2.123'},body:JSON.stringify({action:'signup',appId,email:'fixture@example.test',password:suppliedPassword})}));return{status:r.status,body:await r.json()};},async reset(){const r=await handler(new Request('https://fixture.supabase.co/functions/v1/app-auth',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','x-forwarded-for':'192.0.2.123'},body:JSON.stringify({action:'reset',appId,email:'fixture@example.test'})}));return{status:r.status,body:await r.json()};}};
}
test('lost mapping acknowledgement never deletes the confirmed auth user',async()=>{
 const f=fixture({fault:'commit-lost'}),r=await f.signup();assert.equal(f.state.deletions,0);assert.equal(r.status,200);assert.equal(r.body.user.id,f.state.mapping.auth_user_id);assert.equal(f.state.signins,1);
});
test('uncommitted mapping failure preserves identity and retry repairs it',async()=>{
 const f=fixture({fault:'no-commit'}),first=await f.signup();assert.equal(first.status,503);assert.equal(first.body.session,undefined);assert.doesNotMatch(JSON.stringify(first.body),/private/);assert.equal(f.state.deletions,0);assert.ok(f.state.auth);
 const second=await f.signup();assert.equal(second.status,200);assert.equal(second.body.user.id,'fixture-user');assert.equal(f.state.mapping.auth_user_id,'fixture-user');assert.equal(f.state.deletions,0);
});
test('authenticated retry recovers an orphan without creating a different identity',async()=>{
 const f=fixture({orphan:true}),r=await f.signup();assert.equal(r.status,200);assert.equal(f.state.mapping?.auth_user_id,'fixture-user');assert.equal(f.state.signins,1);
});
test('wrong password cannot recover or claim an orphan',async()=>{const f=fixture({orphan:true}),r=await f.signup('Wrong-password-456');assert.equal(r.status,401);assert.equal(f.state.mapping,null);assert.equal(f.state.inserts,0);});
for(const raceStatus of ['disabled','suspended'])test(`signup race cannot bypass ${raceStatus} mapping`,async()=>{const f=fixture({raceStatus}),r=await f.signup();assert.equal(r.status,403);assert.equal(r.body.session,undefined);assert.equal(f.state.deletions,0);});
test('signup never returns a session bound to a different mapped identity',async()=>{const f=fixture({raceIdentity:'other-user'}),r=await f.signup();assert.notEqual(r.status,200);assert.equal(r.body.session,undefined);assert.equal(f.state.mapping.auth_user_id,'other-user');});
test('initial mapping uncertainty is sanitized and cannot trigger account creation',async()=>{const f=fixture({lookupFailure:true}),r=await f.signup();assert.equal(r.status,503);assert.doesNotMatch(JSON.stringify(r.body),/private/);assert.equal(f.state.auth,null);assert.equal(f.state.signins,0);});

test('rejected write response preserves committed identity and retry reconnects',async()=>{
 const f=fixture({fault:'commit-reject'}),first=await f.signup();
 assert.equal(first.status,503);assert.equal(first.body.session,undefined);assert.equal(f.state.deletions,0);assert.ok(f.state.auth);assert.ok(f.state.mapping);assert.doesNotMatch(JSON.stringify(first.body),/private/);
 const second=await f.signup();assert.equal(second.status,200);assert.equal(second.body.user.id,f.state.mapping.auth_user_id);assert.equal(f.state.deletions,0);
});

for(const options of [{appCountError:true},{appCountMissing:true},{eventCountError:true,platform:false}])test(`uncertain signup rate counter fails closed (${JSON.stringify(options)})`,async()=>{
 const f=fixture(options),r=await f.signup();assert.equal(r.status,503);assert.equal(f.state.auth,null);assert.equal(f.state.signins,0);assert.equal(r.body.session,undefined);assert.doesNotMatch(JSON.stringify(r.body),/private/);
});

for(const options of [{eventCountError:true},{resetCountError:true}])test(`uncertain reset rate counter fails closed (${JSON.stringify(options)})`,async()=>{
 const f=fixture(options),r=await f.reset();assert.equal(r.status,503);assert.doesNotMatch(JSON.stringify(r.body),/private/);assert.equal(f.state.auth,null);
});
for(const options of [{appCount:30},{ipCount:30,platform:false}])test(`signup limit remains enforced (${JSON.stringify(options)})`,async()=>{
 const f=fixture(options),r=await f.signup();assert.equal(r.status,429);assert.equal(f.state.auth,null);
});
for(const options of [{ipCount:20},{resetCount:5}])test(`reset limit remains enforced (${JSON.stringify(options)})`,async()=>{
 const f=fixture(options),r=await f.reset();assert.equal(r.status,429);assert.equal(f.state.auth,null);
});
test('platform egress exemption remains limited to signup IP count',async()=>{
 const f=fixture({ipCount:30,platform:true}),r=await f.signup();assert.equal(r.status,200);
});
test('eligible unknown reset remains non-enumerating with confirmed counters',async()=>{
 const f=fixture(),r=await f.reset();assert.equal(r.status,200);assert.equal(r.body.ok,true);assert.equal(f.state.auth,null);
});
