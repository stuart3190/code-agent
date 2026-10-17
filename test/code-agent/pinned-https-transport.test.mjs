import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {pinnedHttpsTransport} from '../../shell/server/lib/pinnedHttpsTransport.mjs';
import {safeRuntimeFetch} from '../../shell/server/lib/capabilityRuntime.mjs';
let dir,server,cert,base;const addresses=[{address:'93.184.216.34',family:4}];const requests=[];const lookups=[];
before(async()=>{
 dir=await mkdtemp(join(tmpdir(),'thrallo-pinned-https-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=runtime.example.test','-addext','subjectAltName=DNS:runtime.example.test'],{stdio:'ignore'});
 cert=await readFile(join(dir,'cert.pem'));
 server=https.createServer({key:await readFile(join(dir,'key.pem')),cert},async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  requests.push({path:req.url,host:req.headers.host,body:Buffer.concat(chunks).toString()});
  if(req.url==='/stall'){res.writeHead(200);res.flushHeaders();return;}
  if(req.url==='/gzip'){res.writeHead(200,{'content-encoding':'gzip'});res.end(gzipSync('x'.repeat(200)));return;}
  if(req.url==='/empty'){res.writeHead(204);res.end();return;}
  res.end('response body');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`https://runtime.example.test:${server.address().port}`;
});
after(async()=>{server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));if(dir)await rm(dir,{recursive:true,force:true});});
// Only this test adapter reroutes the validated address to the private TLS fixture.
// Production uses https.request unchanged. TLS verification remains enabled here.
function requestImpl(url,options,callback){
 assert.equal(options.agent,false);assert.equal(options.rejectUnauthorized,undefined);
 return https.request(url,{...options,ca:cert,lookup(host,lookupOptions,cb){
  options.lookup(host,lookupOptions,(error,result,family)=>{
   if(error)return cb(error);lookups.push(result);
   if(lookupOptions.all){assert.deepEqual(result,addresses);cb(null,[{address:'127.0.0.1',family:4}]);}
   else{assert.equal(result,addresses[0].address);cb(null,'127.0.0.1',4);}
  });
 }},callback);
}
const transport=(url,init,options)=>pinnedHttpsTransport(url,init,{...options,requestImpl});
test('actual HTTPS retains hostname verification, sends body, uses pinned lookup',async()=>{
 const response=await transport(`${base}/post`,{method:'POST',body:'fixture payload',signal:AbortSignal.timeout(3000)},{addresses});
 assert.equal(await response.text(),'response body');assert.equal(response.url,`${base}/post`);assert.equal(requests.at(-1).body,'fixture payload');assert.equal(requests.at(-1).host,new URL(base).host);assert.ok(lookups.length);
});
test('actual HTTPS rejects certificate for a different hostname',async()=>{
 await assert.rejects(transport(base.replace('runtime.example.test','wrong.example.test'),{signal:AbortSignal.timeout(3000)},{addresses}),e=>e.code==='ERR_TLS_CERT_ALTNAME_INVALID');
});
test('compressed stream is decoded and capped by actual output bytes',async()=>{
 const response=await safeRuntimeFetch(`${base}/gzip`,{}, {maxBytes:50,dnsLookup:async()=>addresses,fetchImpl:transport});await assert.rejects(response.text(),/too large/);
});
test('empty response preserves 204 semantics',async()=>{const response=await transport(`${base}/empty`,{}, {addresses});assert.equal(response.status,204);assert.equal(await response.text(),'');});
test('abort deadline terminates a stalled response body',async()=>{
 const response=await transport(`${base}/stall`,{signal:AbortSignal.timeout(100)},{addresses});await assert.rejects(response.text());
});
test('DNS snapshot is passed unchanged to connection, with no second resolution',async()=>{
 let resolutions=0;const response=await safeRuntimeFetch(`${base}/pin`,{}, {dnsLookup:async()=>{resolutions++;return resolutions===1?addresses:[{address:'127.0.0.1',family:4}];},fetchImpl:transport});assert.equal(await response.text(),'response body');assert.equal(resolutions,1);
});
test('missing address snapshot refuses transport',()=>assert.throws(()=>pinnedHttpsTransport(base),/DNS/));

test('authored Host header cannot change URL authority or TLS identity',async()=>{const response=await transport(`${base}/authority`,{headers:{Host:'wrong.example.test'}},{addresses});await response.text();assert.equal(requests.at(-1).host,new URL(base).host);});
