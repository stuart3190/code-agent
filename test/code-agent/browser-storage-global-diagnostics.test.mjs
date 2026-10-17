import {test} from 'node:test';import assert from 'node:assert/strict';
import {lintUndefinedIdentifiers} from '../../shell/server/lib/builderV2/staticApplicationGate.mjs';
import {lintDurablePersistence} from '../../shell/server/lib/builderV2/persistenceLint.mjs';
const contract={entities:[{name:'booking'}],operations:[{id:'create-booking',entity:'booking',action:'create'}],journeys:[{id:'book',steps:[{action:'confirm booking',expect:'Booking confirmed'},{action:'reload',expect:'Booking restored'}]}]};
for (const [api,expression] of [['sessionStorage',"sessionStorage.getItem('month')"],['localStorage',"localStorage.getItem('theme')"],['indexedDB',"indexedDB.open('cache')"]]) {
 test(`${api} has accurate lexical diagnostics while durable ownership remains enforced`,()=>{
  const tree={'src/view.js':`export const read = () => ${expression};`};
  assert.deepEqual(lintUndefinedIdentifiers(tree),[]);
  assert.equal(lintDurablePersistence(tree,{contract}).findings.some(f=>f.code==='forbidden_persistence'&&f.api===api),true);
 });
}
test('misspelled browser APIs and an unbound local reference still fail',()=>{
 const findings=lintUndefinedIdentifiers({'src/view.js':'export const read = () => sessionstorage.getItem(missingKey);'});
 assert.deepEqual(new Set(findings.map(f=>f.identifier)),new Set(['sessionstorage','missingKey']));
});
