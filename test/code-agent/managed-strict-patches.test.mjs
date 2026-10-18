import test from 'node:test';import assert from 'node:assert/strict';
import {createOpenAIEngineProvider} from '../../shell/server/lib/appBuild/openaiEngineProvider.mjs';
import {EMIT_PATCHES_SCHEMA} from '../../shell/server/lib/builderV2/patchEngine.mjs';
async function capture(options){let body;const provider=createOpenAIEngineProvider({apiKey:'test-key',model:'gpt-5.6-sol',fetchImpl:async(_url,request)=>{body=JSON.parse(request.body);return {ok:true,json:async()=>({id:'resp-proof',output:[],usage:{}})};}});await provider.runTurn({systemPrompt:'test',messages:[],...options});return body;}
test('managed patch generation preserves strict schema and forced tool choice',async()=>{
 const choice={type:'function',name:'emit_patches'},body=await capture({tools:[EMIT_PATCHES_SCHEMA],toolChoice:choice});assert.equal(body.tools[0].strict,true);assert.deepEqual(body.tools[0].parameters,EMIT_PATCHES_SCHEMA.parameters);assert.deepEqual(body.tool_choice,choice);assert.equal(body.parallel_tool_calls,false);
});
test('legacy non-strict tools retain automatic parallel behavior',async()=>{
 const body=await capture({tools:[{name:'legacy',description:'legacy',parameters:{type:'object',properties:{}}}]});assert.equal(body.tools[0].strict,false);assert.equal(body.tool_choice,'auto');assert.equal(body.parallel_tool_calls,true);
});
test('tool-free requests do not invent tool settings',async()=>{const body=await capture({tools:[]});assert.equal(body.tools,undefined);assert.equal(body.tool_choice,undefined);});
