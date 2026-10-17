import {test} from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';import os from 'node:os';import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {previewTreeEntries,writePreviewTree} from '../../provisiond/previewTree.mjs';
for(const name of ['../outside','src/../../outside','/tmp/outside','C:/outside','src\\..\\outside','src/./x','src//x','src/','\0bad',''])test(`reject preview path ${JSON.stringify(name)}`,()=>assert.throws(()=>previewTreeEntries({[name]:'bad'}),e=>e.code==='bad_preview_tree'&&e.status===400));
for(const tree of [null,[],{'a':{},'b':'ok'},{a:'file','a/b':'child'}])test(`reject malformed tree ${JSON.stringify(tree)}`,()=>assert.throws(()=>previewTreeEntries(tree),{code:'bad_preview_tree'}));
test('whole-tree rejection leaves host sentinel and staging directory untouched',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'preview-path-proof-')),root=path.join(dir,'staging');try{await mkdir(root);await writeFile(path.join(dir,'outside'),'preserve');
 await assert.rejects(writePreviewTree(root,{'src/valid.js':'valid','../outside':'overwrite'}),{code:'bad_preview_tree'});
 assert.equal(await readFile(path.join(dir,'outside'),'utf8'),'preserve');assert.deepEqual(await readdir(root),[]);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('normal nested and dot files materialize while authoritative vite config is omitted',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'preview-path-valid-'));try{await writePreviewTree(dir,{'src/My Screen.jsx':'screen','.env':'public runtime','vite.config.js':'not authoritative'});
 assert.equal(await readFile(path.join(dir,'src/My Screen.jsx'),'utf8'),'screen');assert.equal(await readFile(path.join(dir,'.env'),'utf8'),'public runtime');await assert.rejects(readFile(path.join(dir,'vite.config.js')),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true})}
});
