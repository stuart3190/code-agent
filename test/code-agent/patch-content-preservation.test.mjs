import test from 'node:test';import assert from 'node:assert/strict';
import {applyPatches,REJECTION} from '../../shell/server/lib/builderV2/patchEngine.mjs';
test('missing/null/non-string replacement bodies never erase retained files',()=>{
 for(const content of [undefined,null,false,0,{},[]]){
  const tree={'src/index.css':'.app { color: teal; }'};
  const result=applyPatches(tree,[{replaceFile:'src/index.css',content}]);
  assert.equal(result.tree['src/index.css'],tree['src/index.css']);assert.equal(result.applied.length,0);
  assert.equal(result.rejected[0].code,REJECTION.INVALID_PATCH_OPERATION);
  assert.match(result.rejected[0].reason,/complete string content/);
 }
});
test('missing creation body does not create a phantom empty module',()=>{
 const result=applyPatches({},[{newFile:'src/Screen.jsx',content:null}]);
 assert.equal(Object.hasOwn(result.tree,'src/Screen.jsx'),false);assert.equal(result.rejected.length,1);
});
test('explicit empty string remains a deliberate supported edit; sibling valid edits survive',()=>{
 const result=applyPatches({'src/index.css':'.app{}','src/theme.css':'.theme{}'},[
  {replaceFile:'src/index.css',content:null},{replaceFile:'src/theme.css',content:''},{newFile:'src/empty.css',content:''}
 ]);
 assert.equal(result.tree['src/index.css'],'.app{}');assert.equal(result.tree['src/theme.css'],'');assert.equal(result.tree['src/empty.css'],'');
 assert.equal(result.applied.length,2);assert.equal(result.rejected.length,1);
});
test('mixed targets cannot silently drop one edit or erase another file',()=>{
 const tree={'src/index.css':'.app{}','src/Main.jsx':'export function Main(){return null;}'};
 const result=applyPatches(tree,[{file:'src/Main.jsx',ops:[{op:'append',content:'// kept?'}],replaceFile:'src/index.css',content:null}]);
 assert.deepEqual(result.tree,tree);assert.equal(result.applied.length,0);assert.match(result.rejected[0].reason,/exactly one operation target/);
 for(const patch of [{newFile:'src/New.js',deleteFile:'src/Main.jsx',content:'export const x=1;'}, {replaceFile:'src/index.css',content:'.next{}',ops:[{op:'append',content:'x'}]}]) {
  const verdict=applyPatches(tree,[patch]);assert.deepEqual(verdict.tree,tree);assert.equal(verdict.rejected.length,1);
 }
});
