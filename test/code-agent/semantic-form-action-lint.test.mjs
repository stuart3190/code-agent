import test from 'node:test';
import assert from 'node:assert/strict';
import {lintSemanticFormActions as lint} from '../../shell/server/lib/builderV2/platformModules/semanticActionLint.mjs';
import {isBlocking} from '../../shell/server/lib/builderV2/validationSeverity.mjs';
import {lintPlatformAbi} from '../../shell/server/lib/builderV2/platformModules/abiLint.mjs';
const file='src/screens/Booking.jsx';
const source=(button='',handler='()=>{}',wrapper='form onSubmit={save}')=>`import {useSemanticAction} from '../lib/capabilities';
function Screen(){const submit=useSemanticAction({name:'save',onActivate:${handler}});return <${wrapper}><button {...submit.buttonProps} ${button}>Book</button></${wrapper.split(' ')[0]}>;}`;
test('observed empty semantic form action is diagnosed with exact owner and fix',()=>{
 const findings=lint(source('disabled={busy}'),file);assert.equal(findings.length,1);assert.equal(isBlocking(findings[0]),true);assert.equal(findings[0].module,file);assert.match(findings[0].message,/AFTER/);
 assert.equal(lintPlatformAbi({[file]:source()}).findings[0].code,'semantic_form_action_noop');
});
for(const [name,code] of [
 ['explicit submit override',source('type="submit"')],['real callback',source('','()=>save()')],
 ['explicit click override',source('onClick={save}')],['permanently disabled',source('disabled')],
 ['outside a form',source('','()=>{}','section')],['delegated parent action',source('','()=>{}','form onSubmit={save} onClick={delegate}')],
 ['unknown later spread',source('{...otherProps}')],['different hook source',source().replace('../lib/capabilities','external')],
 ['shadowed imported hook',source().replace('function Screen()','function Screen(useSemanticAction)')],
 ['shadowed action',source()+'function Other(submit){return submit;}'],
 ['nonempty callback',source('','()=>{ save(); }')],['syntax failure', 'broken {']
])test(name+' remains accepted',()=>assert.deepEqual(lint(code,file),[]));
test('comments do not disguise an empty callback',()=>assert.equal(lint(source('','()=>{/* TODO */}'),file).length,1));

test('direct DOM delegation or action mutation remains inconclusive',()=>{
 assert.deepEqual(lint(source()+'document.addEventListener("click",save);',file),[]);
 assert.deepEqual(lint(source().replace('return <form','submit.buttonProps.onClick=save;return <form'),file),[]);
});
