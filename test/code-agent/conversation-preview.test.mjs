import test from 'node:test';import assert from 'node:assert/strict';
import {handleConversationPreview} from '../../shell/server/routes/conversations.mjs';
const id='11111111-1111-4111-8111-111111111111';
const response=()=>({writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}});
test('preview recovery authenticates conversation ownership before any provisioner call',async()=>{
 let called=false;await assert.rejects(handleConversationPreview(null,response(),{owner:{id:'other'},conversationId:'thread',store:{getConversation:async()=>null},preview:async()=>{called=true;}}),e=>e.status===404);assert.equal(called,false);
});
test('preview recovery delegates exact project with no owner-latest fallback and persists events',async()=>{
 const events=[];const conversation={id:'thread',owner:'owner',product_id:'product'};const res=response();
 await handleConversationPreview(null,res,{owner:{id:'owner'},conversationId:'thread',body:{projectId:id},store:{getConversation:async(owner,thread)=>{assert.equal(owner,'owner');assert.equal(thread,'thread');return conversation;},appendEvent:async(c,type,payload)=>events.push({c,type,payload})},preview:async(ctx,options)=>{assert.equal(ctx.owner,'owner');assert.equal(ctx.conversation,conversation);assert.deepEqual(options,{projectId:id,allowOwnerFallback:false});await ctx.emit('preview_ready',{url:'https://preview.example/',projectId:id});return{url:'https://preview.example/',projectId:id};}});
 assert.equal(res.status,200);assert.equal(res.body.projectId,id);assert.equal(events[0].c,conversation);
});
test('invalid project and provisioner failures cannot announce success',async()=>{
 const store={getConversation:async()=>({id:'thread',owner:'owner'})};
 await assert.rejects(handleConversationPreview(null,response(),{owner:{id:'owner'},conversationId:'thread',body:{projectId:'bad'},store,preview:()=>assert.fail('must not invoke')}),e=>e.code==='invalid_project');
 const res=response();await assert.rejects(handleConversationPreview(null,res,{owner:{id:'owner'},conversationId:'thread',store,preview:async()=>{throw Error('unavailable');}}),/unavailable/);assert.equal(res.status,undefined);
});
test('known recovery outcomes survive the HTTP boundary without leaking upstream detail',async()=>{
 for(const [code,status,retryable] of [['nothing_to_preview',404,false],['preview_build_active',409,true],['project_lookup_unavailable',503,true],['preview_verification_unavailable',503,true],['preview_projection_failed',503,true],['preview_unreachable',503,true]]){
  const res=response();await handleConversationPreview(null,res,{owner:{id:'owner'},conversationId:'thread',store:{getConversation:async()=>({id:'thread'})},preview:async()=>{throw Object.assign(Error('secret upstream detail'),{code});}});
  assert.equal(res.status,status);assert.equal(res.body.code,code);assert.equal(res.body.retryable,retryable);assert.doesNotMatch(res.body.error,/secret upstream/);assert.equal(res.body.url,undefined);
 }
});
