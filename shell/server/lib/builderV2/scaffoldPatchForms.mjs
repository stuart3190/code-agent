// Recover complete model payloads expressed in the wrong patch form only while their target
// remains byte-identical to an explicitly owned scaffold placeholder. Scope and normal patch
// validation still run afterward. Never reinterpret edits to authored source or ambiguous batches.
import {parse} from '@babel/parser';
import {renderScaffoldFoundation} from './scaffoldComposer.mjs';

export function normalizeScaffoldPatchForms(patches, tree, {modulePlan=[],scaffoldGraph=null,baseline=null}={}) {
  const screens=scaffoldGraph?renderScaffoldFoundation(scaffoldGraph).screenFiles:{};
  const target=p=>p?.file||p?.newFile||p?.replaceFile||p?.deleteFile;
  const counts=new Map();for(const patch of patches)counts.set(target(patch),(counts.get(target(patch))||0)+1);
  const next=Object.assign([...patches],patches),conversions=[];
  for(let index=0;index<patches.length;index++) {
    const patch=patches[index],file=target(patch);
    if(!file||counts.get(file)!==1||typeof tree?.[file]!=='string')continue;
    let content,reason;
    if(file==='src/index.css'&&patch.newFile===file&&!patch.file&&!patch.replaceFile&&!patch.deleteFile&&(patch.ops==null||(Array.isArray(patch.ops)&&patch.ops.length===0))
      &&typeof patch.content==='string'&&typeof baseline?.[file]==='string'&&tree[file]===baseline[file]) {
      content=patch.content;reason='untouched_scaffold_stylesheet';
    } else if(patch.file===file&&!patch.newFile&&!patch.replaceFile&&!patch.deleteFile
      &&patch.ops?.length===1&&patch.ops[0].op==='replace_symbol'&&patch.ops[0].symbol==='default'
      &&typeof patch.ops[0].content==='string'&&Object.hasOwn(screens,file)&&tree[file]===screens[file]
      &&modulePlan.filter(row=>row.path===file&&row.providedBy==='scaffold_screen_slot').length===1
      &&modulePlan.filter(row=>row.path===file).length===1) {
      try {
        const ast=parse(patch.ops[0].content,{sourceType:'module',plugins:['jsx','typescript']});
        const declaration=ast.program.body.find(node=>node.type==='ExportDefaultDeclaration')?.declaration;
        if(!declaration||!['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ClassDeclaration','ClassExpression'].includes(declaration.type)||declaration.async)continue;
      }catch{continue;}
      content=patch.ops[0].content;reason='untouched_scaffold_screen_full_module';
    } else continue;
    next[index]={...patch,file:null,ops:null,newFile:null,deleteFile:null,replaceFile:file,content};
    conversions.push({file,reason});
  }
  return {patches:conversions.length?next:patches,conversions};
}
