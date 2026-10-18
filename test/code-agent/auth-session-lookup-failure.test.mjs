import test from'node:test';import assert from'node:assert/strict';import{createSupabaseBackend,ensureAppVisitorSession}from'../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js';
for(const scoped of [true,false]){
 const make=()=>createSupabaseBackend({url:'https://fixture.supabase.co',anonKey:'public-fixture',...(scoped?{appId:'fixture',authUrl:'https://fixture.supabase.co/functions/v1/app-auth'}:{}),fetchImpl:async()=>{throw Error('unexpected network')}});
 test(`session lookup transport error is preserved (${scoped?'app':'direct'})`,async()=>{const api=make(),failure=Object.assign(new Error('temporary network failure'),{status:503});api._client.auth.getUser=async()=>({data:{user:null},error:failure});await assert.rejects(api.auth.currentUser(),e=>e===failure)});
 test(`genuinely absent session remains null (${scoped?'app':'direct'})`,async()=>{const api=make();for(const error of [{name:'AuthSessionMissingError'},{code:'session_not_found'},{code:'session_expired'}]){api._client.auth.getUser=async()=>({data:{user:null},error});assert.equal(await api.auth.currentUser(),null)}});
}
test('visitor initialization never creates credentials or an account after uncertain session lookup',async()=>{
 let signups=0,writes=0;const failure=new Error('session lookup network failure');
 await assert.rejects(ensureAppVisitorSession({appId:'fixture',auth:{currentUser:async()=>{throw failure},signIn:async()=>{},signUp:async()=>{signups++;return{id:'new'}}},storage:{getItem:()=>null,setItem:()=>{writes++}},randomUUID:()=> 'new'}),e=>e===failure);assert.equal(signups,0);assert.equal(writes,0);
});

test('a transient lookup failure preserves the existing member through retry',async()=>{
 const {createIdentityController}=await import('../../src/scaffolds/reactVite/lib/modules/identity.js');let unavailable=true,visitors=0;
 const api=createSupabaseBackend({url:'https://fixture.supabase.co',anonKey:'public-fixture',appId:'fixture',authUrl:'https://fixture.supabase.co/functions/v1/app-auth',fetchImpl:async()=>{throw Error('unexpected network')}});
 api._client.auth.getUser=async()=>unavailable?{data:{user:null},error:Object.assign(new Error('network unavailable'),{status:503})}:{data:{user:{id:'existing-member',email:'synthetic@example.test',user_metadata:{app_email:'member@example.test'}}},error:null};
 const controller=createIdentityController({auth:api.auth,mode:'visitor',ensureVisitorSession:async()=>{visitors++;return{id:'wrong-visitor'}}});
 assert.equal((await controller.ensure()).status,'error');assert.equal(visitors,0);unavailable=false;const recovered=await controller.ensure();assert.equal(recovered.status,'signed_in');assert.equal(recovered.principal.id,'existing-member');assert.equal(recovered.principal.email,'member@example.test');assert.equal(visitors,0);
});
