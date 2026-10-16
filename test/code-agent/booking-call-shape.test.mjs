import test from 'node:test';import assert from 'node:assert/strict';import {lintCapabilitySafety} from '../../shell/server/lib/builderV2/capabilityLint.mjs';import {capabilityBrief} from '../../shell/server/lib/builderV2/capabilityRegistry.mjs';
const lint=code=>lintCapabilitySafety({'src/booking.js':`import { makeBookingSystem } from './lib/capabilities/booking.js';const store=makeBookingSystem({entity:'appointment'});${code}`}).findings.filter(f=>f.code==='capability_call_shape');
test('entity-shaped booking calls name the exact incompatible API inputs',()=>{
 const rows=lint('store.createBooking({appointmentDate:date,appointmentTime:time,guestName:name,guestEmail:email}); store.getBooking({reference,email});store.cancelBooking({reference,status});');
 assert.equal(rows.length,3);assert.match(rows[0].message,/lacks date, slotId/);assert.match(rows[1].message,/positional/);assert.equal(rows[0].line,1);
});
test('valid canonical/legacy calls, unknown input objects, spreads and references abstain',()=>{
 for(const code of ['store.createBooking({date,slotId,name,email});','store.createBooking({bookingDate,slotId,guestName,guestEmail});','store.createBooking(values);','store.createBooking({...values,appointmentDate:date});','store.getBooking(reference,email);','store.cancelBooking(reference,email);','consume(store.createBooking);'])assert.equal(lint(code).length,0,code);
});
test('booking prompt describes outcomes and visitor-scope limits honestly',()=>{const brief=capabilityBrief(['booking']);assert.match(brief,/getBooking\(reference, email\)/);assert.match(brief,/only confirm result===/);assert.match(brief,/atomically across visitors/);assert.match(brief,/private to each visitor/);});
