import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runQaBrowser} from '../../shell/server/lib/qaRunner.mjs';
async function audit(html){
 const server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Fixture</title>'+html);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const root=await mkdtemp(join(tmpdir(),'thrallo-qa-labels-'));
 try{return await runQaBrowser({previewUrl:`http://127.0.0.1:${server.address().port}`,runId:'labels',artifactRoot:root});}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
}
test('QA accepts native labels, referenced labels, and named input buttons',async()=>{
 const report=await audit(`<label for="name">Name</label><input id="name"><label>Email<input type="email"></label>
 <span id="amount-label">Amount</span><input aria-labelledby="amount-label">
 <span id="hidden-label" hidden>Details</span><textarea aria-labelledby="hidden-label"></textarea>
 <label for="category">Category</label><select id="category"><option value="">Choose</option></select>
 <input type="button" value="Apply"><input type="submit"><input type="reset">
 <button hidden></button><div style="display:none"><button></button></div>`);
 assert.equal(report.issues.filter(x=>x.type==='accessibility').length,0);
});
test('QA still detects visible empty buttons and missing referenced labels',async()=>{
 const report=await audit('<button></button><input aria-labelledby="nonexistent"><select><option>Pick one</option></select><textarea>default content</textarea>');
 const issues=report.issues.filter(x=>x.type==='accessibility');assert.equal(issues.length,2);assert.ok(issues.every(x=>x.message.startsWith('4 interactive')));
});
