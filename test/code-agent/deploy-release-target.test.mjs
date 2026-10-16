import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const script=new URL('../../ops/deploy-production-release.sh',import.meta.url).pathname;
for(const requested of ['HEAD','main','refs/heads/main','--help',''])test(`release rejects mutable/non-SHA target ${JSON.stringify(requested)} before staging`,()=>{
 const result=spawnSync('/bin/bash',[script,requested,'previous','image'],{encoding:'utf8',env:{PATH:'/nonexistent'}});
 assert.equal(result.status,2);assert.match(result.stdout,/explicit immutable commit SHA/);assert.equal(result.stderr,'');
});
