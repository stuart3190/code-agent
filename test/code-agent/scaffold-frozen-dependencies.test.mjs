import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {REACT_VITE} from '../../src/scaffolds/reactVite.mjs';
import {previewBaseImage} from '../../provisiond/docker.mjs';
import {PROTECTED_PATHS} from '../../shell/server/lib/builderV2/patchEngine.mjs';
import {SANDBOX_IDENTITY_FILES} from '../../shell/server/lib/builderV2/sandboxProvenance.mjs';
test('generated, compiler and preview package declarations use one exact locked dependency set',async()=>{
 const manifest=JSON.parse(REACT_VITE['package.json']),lock=JSON.parse(REACT_VITE['package-lock.json']);
 for(const section of ['dependencies','devDependencies']){
  assert.deepEqual(lock.packages[''][section],manifest[section]);
  for(const [name,version] of Object.entries(manifest[section])){
   assert.match(version,/^\d+\.\d+\.\d+$/);assert.equal(lock.packages[`node_modules/${name}`].version,version);
  }
 }
 assert.deepEqual(JSON.parse(await readFile(new URL('../../provisiond/base/package.json',import.meta.url),'utf8')),manifest);
 assert.equal(await readFile(new URL('../../provisiond/base/package-lock.json',import.meta.url),'utf8'),REACT_VITE['package-lock.json']);
 assert.ok(SANDBOX_IDENTITY_FILES.includes('src/scaffolds/reactVite/package-lock.json'));
 assert.ok(PROTECTED_PATHS.some(re=>re.test('package-lock.json')));
});
test('explicit preview image pin must be immutable',()=>{
 assert.equal(previewBaseImage({}),'buildr-preview-base:latest');
 const image='sha256:'+'a'.repeat(64);assert.equal(previewBaseImage({THRALLO_PREVIEW_IMAGE:image}),image);
 assert.throws(()=>previewBaseImage({THRALLO_PREVIEW_IMAGE:'custom:latest'}),/immutable/);
});
