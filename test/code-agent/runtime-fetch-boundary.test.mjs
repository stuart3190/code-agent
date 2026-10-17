import test from 'node:test';
import assert from 'node:assert/strict';
import {safeRuntimeFetch} from '../../shell/server/lib/capabilityRuntime.mjs';
const dnsLookup=async()=>[{address:'93.184.216.34',family:4}];
test('cross-origin redirect never forwards custom credentials or request body',async()=>{
 const calls=[];
 await assert.rejects(safeRuntimeFetch('https://api.example.test/start',{method:'POST',headers:{'X-Private-Token':'fixture-only'},body:'private request'},{dnsLookup,fetchImpl:async(url,init)=>{calls.push({url:String(url),init});return new Response(null,{status:307,headers:{location:'https://other.example.test/collect'}});}}),/cross-origin/i);
 assert.equal(calls.length,1);
});
test('public downloads can follow cross-origin redirects without credentials',async()=>{
 const calls=[];const result=await safeRuntimeFetch('https://asset.example.test/start',{}, {dnsLookup,fetchImpl:async url=>{calls.push(String(url));return calls.length===1?new Response(null,{status:302,headers:{location:'https://cdn.example.test/file'}}):new Response('image bytes');}});
 assert.equal(await result.text(),'image bytes');assert.equal(calls.length,2);
});
test('same-origin redirects retain request headers',async()=>{
 const calls=[];await safeRuntimeFetch('https://api.example.test/start',{headers:{'X-Private-Token':'fixture-only'}},{dnsLookup,fetchImpl:async(url,init)=>{calls.push(init);return calls.length===1?new Response(null,{status:307,headers:{location:'/next'}}):new Response('done');}});
 assert.equal(calls.length,2);assert.equal(calls[1].headers['X-Private-Token'],'fixture-only');
});
for(const address of ['::ffff:127.0.0.1','::','fe90::1','100.64.0.1','224.0.0.1'])test(`non-public DNS result never reaches transport: ${address}`,async()=>{
 let calls=0;await assert.rejects(safeRuntimeFetch('https://api.example.test',{}, {dnsLookup:async()=>[{address}],fetchImpl:async()=>{calls++;return new Response('secret');}}),/public HTTPS/);assert.equal(calls,0);
});
for(const headers of [{},{'content-length':'1'}])test(`stream byte limit is enforced with headers ${JSON.stringify(headers)}`,async()=>{
 let cancelled=false;let chunks=0;
 const response=new Response(new ReadableStream({pull(c){if(chunks++<3)c.enqueue(new Uint8Array(8));else c.close();},cancel(){cancelled=true;}}),{headers});
 await assert.rejects(async()=>{const result=await safeRuntimeFetch('https://api.example.test',{}, {dnsLookup,maxBytes:10,fetchImpl:async()=>response});await result.arrayBuffer();},/too large/i);assert.equal(cancelled,true);
});
test('declared oversize response is cancelled before rejection',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':'999'}});
 await assert.rejects(safeRuntimeFetch('https://api.example.test',{}, {dnsLookup,maxBytes:10,fetchImpl:async()=>response}),/too large/);assert.equal(cancelled,true);
});

for(const init of [{headers:{'X-Custom-Key':'fixture-only'}},{headers:new Headers({Authorization:'Bearer fixture-only'})},{body:'private payload',method:'POST'}])test('cross-origin redirect blocks each secret carrier independently',async()=>{
 let calls=0;await assert.rejects(safeRuntimeFetch('https://api.example.test',init,{dnsLookup,fetchImpl:async()=>{calls++;return new Response(null,{status:307,headers:{location:'https://other.example.test'}});}}),/cross-origin/);assert.equal(calls,1);
});
test('redirect bodies are released before following',async()=>{
 let cancelled=false;let calls=0;const result=await safeRuntimeFetch('https://api.example.test',{}, {dnsLookup,fetchImpl:async()=>++calls===1?new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:302,headers:{location:'/next'}}):new Response('ok')});assert.equal(await result.text(),'ok');assert.equal(cancelled,true);
});
