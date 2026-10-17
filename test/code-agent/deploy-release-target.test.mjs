import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const script=new URL('../../ops/deploy-production-release.sh',import.meta.url).pathname;
for(const requested of ['HEAD','main','refs/heads/main','--help',''])test(`release rejects mutable/non-SHA target ${JSON.stringify(requested)} before staging`,()=>{
 const result=spawnSync('/bin/bash',[script,requested,'previous','image'],{encoding:'utf8',env:{PATH:'/nonexistent'}});
 assert.equal(result.status,2);assert.match(result.stdout,/explicit immutable commit SHA/);assert.equal(result.stderr,'');
});

test('an overlapping release is rejected before Git or live-state reads',async()=>{
 const {mkdtemp,readFile,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const path=await import('node:path');
 const root=await mkdtemp(path.join(tmpdir(),'thrallo-release-lock-'));
 try{const lock=path.join(root,'release.lock'),copy=path.join(root,'deploy.sh');await writeFile(copy,(await readFile(script,'utf8')).replace('/run/lock/thrallo-release.lock',lock));
  const result=spawnSync('flock',['--exclusive',lock,'/bin/bash',copy,'a'.repeat(40),'previous','image'],{encoding:'utf8'});
  assert.equal(result.status,2,result.stderr);assert.match(result.stdout,/another Thrallo release is active/);assert.equal(result.stderr,'');
 }finally{await rm(root,{recursive:true,force:true})}
});
