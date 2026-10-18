import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {chromium} from 'playwright';
for(const [origin,trusted,dev=true] of [['https://app.thrallo.com',true],['https://buildr101.com',true],['https://untrusted.example',false],['https://app.thrallo.com.untrusted.example',false],['https://app.thrallo.com',true,false]])test(`preview bridge parent authority: ${origin} dev=${dev}`,{timeout:20000},async()=>{
 const source=(await readFile(new URL('../../src/scaffolds/reactVite/lib/devReporter.js',import.meta.url),'utf8')).replaceAll('import.meta.env.DEV',String(dev));
 const browser=await chromium.launch({headless:true});try{const context=await browser.newContext();await context.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.origin===origin)return route.fulfill({contentType:'text/html',body:`<iframe src="https://preview.example/"></iframe><script>window.messages=[];addEventListener('message',e=>messages.push(e.data));</script>`});
  if(url.origin==='https://preview.example')return route.fulfill({contentType:'text/html',body:`<main><button onclick="window.clicked=true">Example card<input type="password" value="private-password-fixture"><textarea>private-textarea-fixture</textarea></button></main><script>${source}</script><script>setTimeout(()=>{throw Error('preview test error')},30)</script>`});
  return route.abort();
 });const page=await context.newPage();await page.goto(origin);const frame=page.frames().find(f=>f.url().startsWith('https://preview.example'));assert.ok(frame);await page.waitForTimeout(150);
 await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({__buildr:'select-mode',on:true},'*'));await page.waitForTimeout(100);await frame.getByRole('button').click();await page.waitForTimeout(100);
 const messages=await page.evaluate(()=>messages);
 if(!trusted || !dev){assert.deepEqual(messages,[],'untrusted framing must receive neither runtime errors nor selected DOM');assert.equal(await frame.evaluate(()=>window.clicked),true,'untrusted parent cannot intercept interaction');}
 else {assert.ok(messages.some(m=>m.__buildr==='runtime-error'));assert.ok(messages.some(m=>m.__buildr==='select-mode-ack'));const selected=messages.find(m=>m.__buildr==='element-selected');assert.ok(selected);assert.doesNotMatch(JSON.stringify(selected),/private-password-fixture|private-textarea-fixture/);
 await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({__buildr:'select-mode',on:true},'*'));await page.waitForTimeout(100);await frame.getByRole('button').click({position:{x:5,y:5}});await page.waitForTimeout(100);
 const parentSelection=await page.evaluate(()=>messages.filter(m=>m.__buildr==='element-selected').at(-1));assert.equal(parentSelection.tag,'button');assert.doesNotMatch(JSON.stringify(parentSelection),/private-password-fixture|private-textarea-fixture/);
 assert.equal(await frame.locator('input').inputValue(),'private-password-fixture');assert.equal(await frame.locator('textarea').inputValue(),'private-textarea-fixture');}
 }finally{await browser.close()}
});
