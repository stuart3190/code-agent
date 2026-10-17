import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {refreshUnmodifiedPreviewBridge} from '../../shell/server/lib/builderV2/previewBridgeUpgrade.mjs';
import {REACT_VITE} from '../../src/scaffolds/reactVite.mjs';
const key='src/lib/devReporter.js';const old=readFileSync(new URL('./fixtures/reliability-20261016/legacy-preview-reporter.js',import.meta.url),'utf8');
test('exact old platform bridge upgrades without changing generated source or input tree',()=>{
 const tree={[key]:old,'src/App.jsx':'authored UI'};const result=refreshUnmodifiedPreviewBridge(tree,REACT_VITE);
 assert.equal(result[key],REACT_VITE[key]);assert.equal(result['src/App.jsx'],tree['src/App.jsx']);assert.equal(tree[key],old);assert.equal(refreshUnmodifiedPreviewBridge(result,REACT_VITE),result);
});
for(const [name,tree,baseline] of [['authored',{[key]:old+'\n// authored integration'},REACT_VITE],['missing',{},REACT_VITE],['missing baseline',{[key]:old},{}]])test(`bridge refresh preserves ${name}`,()=>assert.equal(refreshUnmodifiedPreviewBridge(tree,baseline),tree));
