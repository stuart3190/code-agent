import test from 'node:test';import assert from 'node:assert/strict';
import {assertPrebuiltIdentity,verifyPrebuiltReleaseImage} from '../../ops/verify-prebuilt-release-image.mjs';
const fixture=()=>{const target='a'.repeat(40),expected={identity:'runtime-hash',covered:2,files:{'runtime.js':'hash-a','helper.js':'hash-b'}};return {target,expected,baked:{...structuredClone(expected),commit:target},actual:{...structuredClone(expected),commit:target}}};
test('identical target, baked manifest and actual runtime bytes pass',()=>assert.doesNotThrow(()=>assertPrebuiltIdentity(fixture())));
for(const key of ['baked','actual']){
 test(`${key} wrong commit is rejected`,()=>{const f=fixture();f[key].commit='b'.repeat(40);assert.throws(()=>assertPrebuiltIdentity(f),/commit differs/)});
 test(`${key} changed file is rejected even with a matching reported aggregate hash`,()=>{const f=fixture();f[key].files['helper.js']='changed';assert.throws(()=>assertPrebuiltIdentity(f),/manifest differs/)});
 test(`${key} aggregate mismatch is rejected`,()=>{const f=fixture();f[key].identity='changed';assert.throws(()=>assertPrebuiltIdentity(f),/identity|bytes/)});
}
test('missing target runtime file is rejected',()=>{const f=fixture();f.expected.files['runtime.js']='absent';assert.throws(()=>assertPrebuiltIdentity(f),/missing runtime/)});
test('mutable image tags are rejected before Docker or Git is invoked',async()=>{await assert.rejects(verifyPrebuiltReleaseImage({repo:'/does-not-exist',target:'a'.repeat(40),image:'image:latest'}),/immutable image digest/)});
