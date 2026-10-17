#!/usr/bin/env node
// Read-only gate for deploying an already qualified immutable sandbox image.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
export function assertPrebuiltIdentity({target,expected,baked,actual}) {
 assert.equal(baked?.commit,target,'baked source commit differs from release');
 assert.equal(actual?.commit,target,'running image source commit differs from release');
 assert.ok(expected?.identity && expected?.covered>0,'target identity unavailable');
 assert.ok(!Object.values(expected.files||{}).includes('absent'),'target has missing runtime files');
 assert.equal(baked.identity,expected.identity,'baked runtime identity differs from release');
 assert.equal(actual.identity,expected.identity,'actual runtime bytes differ from release');
 assert.deepEqual(baked.files,expected.files,'baked file manifest differs from release');
 assert.deepEqual(actual.files,expected.files,'actual file manifest differs from release');
}
export async function verifyPrebuiltReleaseImage({repo,target,image}) {
 if(!/^[0-9a-f]{40}$/.test(target||''))throw Error('full immutable source commit required');
 if(!/^sha256:[0-9a-f]{64}$/.test(image||''))throw Error('immutable image digest required');
 const run=(cmd,args,options={})=>execFileSync(cmd,args,{encoding:'utf8',maxBuffer:128*1024*1024,...options});
 assert.equal(run('git',['-C',repo,'rev-parse','--verify',`${target}^{commit}`]).trim(),target);
 assert.equal(run('docker',['image','inspect',image,'--format','{{.Id}}']).trim(),image);
 const root=mkdtempSync(path.join(tmpdir(),'thrallo-prebuilt-gate-'));
 try {
  const archive=run('git',['-C',repo,'archive',target],{encoding:null});run('tar',['-xf','-','-C',root],{input:archive});
  const {computeSandboxIdentity}=await import(pathToFileURL(path.join(root,'shell/server/lib/builderV2/sandboxProvenance.mjs')));
  const expected=await computeSandboxIdentity({root,commit:target});
  const probe=`import {computeSandboxIdentity,readBakedProvenance} from '/app/shell/server/lib/builderV2/sandboxProvenance.mjs';console.log(JSON.stringify({baked:await readBakedProvenance('/app'),actual:await computeSandboxIdentity({root:'/app',commit:process.env.SOURCE_COMMIT})}));`;
  const {baked,actual}=JSON.parse(run('docker',['run','--rm','--network','none','--memory','256m','--pids-limit','64','--entrypoint','node',image,'--input-type=module','-e',probe]));
  assertPrebuiltIdentity({target,expected,baked,actual});
  return {ok:true,target,image,identity:expected.identity,covered:expected.covered};
 }finally{rmSync(root,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [repo,target,image]=process.argv.slice(2);
 try{console.log(JSON.stringify(await verifyPrebuiltReleaseImage({repo,target,image})));}
 catch(error){console.error(`Prebuilt release image rejected: ${error.message}`);process.exitCode=1;}
}
