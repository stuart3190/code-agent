// Requires the independent Python jsonschema validator; no provider calls or file mutation.
import {execFileSync} from 'node:child_process';import {readFile} from 'node:fs/promises';
import {EMIT_PATCHES_SCHEMA} from '../shell/server/lib/builderV2/patchEngine.mjs';
const blank={file:null,ops:null,newFile:null,content:null,deleteFile:null,replaceFile:null};
const patch=(fields)=>({patches:[{...blank,...fields}]});
const cases=[
 ['complete CSS replacement',true,patch({replaceFile:'src/index.css',content:'main { padding: 1rem; }'})],
 ['complete new source',true,patch({newFile:'src/new.js',content:'export const ready = true;'})],
 ['delete file',true,patch({deleteFile:'src/old.js'})],
 ['indexed operations',true,patch({file:'src/state.js',ops:[{op:'append',symbol:null,content:'export const ready = true;'}]})],
 ['null replacement content',false,patch({replaceFile:'src/index.css'})],
 ['null new file content',false,patch({newFile:'src/new.js'})],
 ['multiple targets',false,patch({newFile:'src/a.js',replaceFile:'src/b.js',content:'hello'})],
 ['orphan content',false,patch({content:'hello'})],
 ['missing selected target',false,patch({ops:[]})],
 ['ops on whole file',false,patch({replaceFile:'src/index.css',content:'main{}',ops:[]})],
 ['non-string file content',false,patch({replaceFile:'src/index.css',content:{css:'main{}'}})],
 ['unknown patch keys',false,patch({replaceFile:'src/index.css',content:'main{}',surprise:true})],
 ['path/content split across patches',false,{patches:[{...blank,replaceFile:'src/index.css'},{...blank,content:'main{}'}]}],
];
if(process.argv[2]){const result=JSON.parse(await readFile(process.argv[2],'utf8'));cases.push(['actual connected-provider response',true,result.arguments]);}
const code=`import json,sys\nfrom jsonschema import Draft202012Validator\nx=json.load(sys.stdin)\nDraft202012Validator.check_schema(x['schema'])\nv=Draft202012Validator(x['schema'])\nfor name,want,data in x['cases']:\n actual=v.is_valid(data)\n if actual != want: raise AssertionError(name + ': validation mismatch')\nprint(json.dumps({'passed':len(x['cases']),'checks':[r[0] for r in x['cases']]}))\n`;
console.log(execFileSync('python3',['-c',code],{input:JSON.stringify({schema:EMIT_PATCHES_SCHEMA.parameters,cases}),encoding:'utf8'}).trim());
