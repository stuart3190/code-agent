import {test} from 'node:test';import assert from 'node:assert/strict';
import {makeEntityStore} from '../../src/scaffolds/reactVite/lib/capabilities/crud.js';
import {makeBookingSystem} from '../../src/scaffolds/reactVite/lib/capabilities/booking.js';
import {makeContactForm,makeNewsletter} from '../../src/scaffolds/reactVite/lib/capabilities/forms.js';
import {makeWizardPersistence} from '../../src/scaffolds/reactVite/lib/capabilities/wizard.js';
function backend({existing=true}={}) {
 const row={id:'canonical-row',created_at:'2026-10-17T00:00:00Z',data:{id:'different-row',name:'Ledger',reference:'BK-ABC',email:'owner@example.test',status:'Active',state:{step:2}}};const calls=[];
 const db={entity:()=>({list:async()=>existing?[row]:[],get:async id=>{calls.push(['get',id]);return row},create:async data=>({...row,data:{...data,id:'different-row'}}),update:async(id,data)=>{calls.push(['update',id]);return {...row,data}},delete:async id=>calls.push(['delete',id])})};
 return {db,row,calls,ensureSession:async()=>{}};
}
test('CRUD results preserve backend row identity across every returned record',async()=>{
 const deps=backend(),store=makeEntityStore('expense',deps);
 for(const record of [await store.create({id:'different-row'}),...(await store.list()),await store.get('canonical-row'),await store.update('canonical-row',{name:'Updated'})])assert.equal(record.id,'canonical-row');
 assert.equal(deps.row.data.id,'different-row','payload is not mutated');
});
test('booking cancellation targets the canonical backend row, not payload id',async()=>{
 const deps=backend(),store=makeBookingSystem({deps});const result=await store.cancelBooking('BK-ABC','owner@example.test');
 assert.equal(result.id,'canonical-row');assert.deepEqual(deps.calls,[['update','canonical-row']]);
});
test('wizard cleanup and save target the canonical persisted row',async()=>{
 const deps=backend(),store=makeWizardPersistence({key:'own-wizard',deps});await store.save({step:3});await store.clear();
 assert.deepEqual(deps.calls,[['update','canonical-row'],['delete','canonical-row']]);
});
test('contact and newsletter returned records preserve backend identity',async()=>{
 const deps=backend({existing:false});
 assert.equal((await makeContactForm({deps}).submitContact({name:'A',email:'a@example.test',message:'Hello'})).message.id,'canonical-row');
 assert.equal((await makeNewsletter({deps}).subscribe('a@example.test')).signup.id,'canonical-row');
});
