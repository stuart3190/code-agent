import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';
const source=await readFile(new URL('../../shell/web/src/lib/codeAgentApi.js',import.meta.url),'utf8');
const mocked=source.replace('import { accessToken, apiBase } from "./backend.js";','const accessToken=async()=>"synthetic-token";const apiBase=()=>globalThis.__desktopApiBase;');
assert.notEqual(mocked,source);const api=await import('data:text/javascript;base64,'+Buffer.from(mocked).toString('base64'));
for(const base of ['', 'https://app.thrallo.com'])test(`API resources use configured authority ${base||'web same-origin'}`,async()=>{
 const oldFetch=globalThis.fetch;globalThis.__desktopApiBase=base;const requests=[];
 globalThis.fetch=async(url,options={})=>{requests.push({url,options});return new Response(url.endsWith('/content')?'artifact contents':'{}',{headers:{'content-type':'application/json'}})};
 try{await api.capabilities();assert.equal(await api.artifactContent('run','artifact'),'artifact contents');assert.deepEqual(requests.map(r=>r.url),[`${base}/api/v1/capabilities`,`${base}/api/v1/runs/run/artifacts/artifact/content`]);assert.equal(requests[1].options.headers.Authorization,'Bearer synthetic-token');}
 finally{globalThis.fetch=oldFetch;delete globalThis.__desktopApiBase}
});
