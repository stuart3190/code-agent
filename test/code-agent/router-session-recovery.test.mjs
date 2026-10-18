import test from 'node:test';import assert from 'node:assert/strict';
import {compileRoutes,evaluateGuard} from '../../src/scaffolds/reactVite/lib/modules/routing.js';
import {createRouter} from '../../src/scaffolds/reactVite/lib/modules/router.js';
const table=compileRoutes([{id:'home',path:'/'},{id:'private',path:'/private',guard:'visitor'}]);
test('session backend error is an error, never a sign-in denial',()=>{
 const result=evaluateGuard(table.byId.private,{status:'error',error:{code:'backend_unavailable'}},{signInRoute:'/signin'});
 assert.equal(result.state,'error');assert.equal(result.reason,'backend_unavailable');assert.equal(result.redirectTo,null);
});
test('rejected session establishment settles routing and retry can recover',async()=>{
 let fails=true;const identity={ensure:async()=>{if(fails)throw Object.assign(new Error('private backend detail'),{code:'backend_unavailable'})},getState:()=>({status:'visitor'})};
 const history=[];const router=createRouter({table,identity,history:{pushState:()=>history.push('push'),replaceState:()=>history.push('replace')},currentPath:()=>'/private'});
 await router.resolve('/private');assert.equal(router.getState().state,'error');assert.equal(router.getState().reason,'backend_unavailable');assert.doesNotMatch(JSON.stringify(router.getState().error),/private backend detail/);
 fails=false;await router.navigate('/private');assert.equal(router.getState().state,'ready');assert.deepEqual(history,[]);
});
test('resolved identity error remains recoverable and does not admit the protected screen',async()=>{
 let failed=true;const identity={ensure:async()=>{},getState:()=>failed?{status:'error',error:{code:'backend_unavailable'}}:{status:'visitor'}};
 const router=createRouter({table,identity,history:null,currentPath:()=>'/private'});await router.resolve('/private');assert.equal(router.getState().state,'error');
 failed=false;await router.reload();assert.equal(router.getState().state,'ready');
});
test('a superseded session rejection cannot overwrite a newer public route',async()=>{
 let reject;const router=createRouter({table,identity:{ensure:()=>new Promise((_,r)=>{reject=r}),getState:()=>({status:'visitor'})},history:null,currentPath:()=>'/private'});
 const pending=router.resolve('/private');await router.resolve('/');reject(new Error('network failure'));await pending;assert.equal(router.getState().state,'ready');assert.equal(router.getState().path,'/');
});
test('an established visitor still cannot enter a member route',async()=>{
 const member=compileRoutes([{id:'member',path:'/member',guard:'member'}]);const router=createRouter({table:member,identity:{ensure:async()=>{},getState:()=>({status:'visitor'})},history:null,currentPath:()=>'/member'});
 await router.resolve('/member');assert.equal(router.getState().state,'forbidden');
});
