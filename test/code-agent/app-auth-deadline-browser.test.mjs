import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import path from 'node:path';import {createRequire}from'node:module';import{fileURLToPath}from'node:url';import{chromium}from'playwright';
const deps=fileURLToPath(new URL('../../harness/.deps/',import.meta.url)),{build}=createRequire(path.join(deps,'package.json'))('esbuild');
test('browser aborts a stalled auth request and a user retry succeeds',{timeout:30000},async()=>{
 const source=fileURLToPath(new URL('../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js',import.meta.url));
 const bundle=await build({stdin:{contents:`import{createSupabaseBackend}from${JSON.stringify(source)};const api=createSupabaseBackend({url:'https://fixture.supabase.co',anonKey:'public-fixture',appId:'fixture',authUrl:location.origin+'/auth'});window.run=async()=>{window.outcome='pending';try{await api.auth.resetPassword({email:'audit@example.test'});window.outcome='success'}catch(e){window.outcome=e.code}};`,resolveDir:deps},bundle:true,write:false,format:'iife'});
 let requests=0,aborted=false;const server=http.createServer((req,res)=>{if(req.url==='/auth'){requests++;req.resume();if(requests===1){res.on('close',()=>{aborted=true});return}res.setHeader('content-type','application/json');res.end('{"ok":true}');return}res.setHeader('content-type',req.url==='/app.js'?'text/javascript':'text/html');res.end(req.url==='/app.js'?bundle.outputFiles[0].text:'<script src="/app.js"></script>')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();await page.clock.install();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.evaluate(()=>{void window.run()});await page.waitForFunction(()=>window.outcome==='pending');
 for(let n=0;n<100&&requests===0;n++)await new Promise(r=>setTimeout(r,10));assert.equal(requests,1);
 await page.clock.fastForward(30000);await page.waitForFunction(()=>window.outcome==='app_auth_timeout');for(let n=0;n<100&&!aborted;n++)await new Promise(r=>setTimeout(r,10));assert.equal(aborted,true);
 await page.evaluate(()=>window.run());assert.equal(await page.evaluate(()=>window.outcome),'success');assert.equal(requests,2);
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
});
