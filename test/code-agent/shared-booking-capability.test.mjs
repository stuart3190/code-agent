import test from 'node:test';import assert from 'node:assert/strict';
import {makeBookingSystem} from '../../src/scaffolds/reactVite/lib/capabilities/booking.js';
import {createSupabaseBackend} from '../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js';
const slots=[{id:'09:00',capacity:1}];
test('shared admission delegates atomically and never does client check/create/rank',async()=>{
 const calls=[];const row={id:'row',data:{date:'2099-01-01',slotId:'09:00',reference:'BK-123456789ABC',status:'Active'}};
 const db={entity:()=>{throw Error('client CRUD must not admit shared bookings');},booking:entity=>({reserve:async request=>{calls.push({entity,request});return {result:'ok',record:row};},remaining:async()=>0,cancel:async()=>({ok:true,record:{...row,data:{...row.data,status:'Cancelled'}}})})};
 const system=makeBookingSystem({entity:'consultation',slots,shared:true,deps:{db,ensureSession:async()=>{}}});
 const result=await system.createBooking({date:'2099-01-01',slotId:'09:00',name:' Test ',email:'TEST@Example.com'});
 assert.equal(result.booking.reference,row.data.reference);assert.equal(calls[0].entity,'consultation');assert.equal(calls[0].request.values.email,'test@example.com');assert.match(calls[0].request.requestId,/^[0-9a-f-]{36}$/);assert.equal(await system.remaining('2099-01-01','09:00'),0);assert.equal((await system.cancelBooking(result.reference,'test@example.com')).booking.status,'Cancelled');
});
test('shared mode refuses unsupported capacities and does not silently fall back on missing transport',async()=>{
 assert.throws(()=>makeBookingSystem({shared:true}),/capacity-one/);assert.throws(()=>makeBookingSystem({shared:true,slots:[{id:'group',capacity:2}]}),/capacity-one/);
 const system=makeBookingSystem({shared:true,slots,deps:{db:{},ensureSession:async()=>{}}});
 assert.equal((await system.createBooking({date:'2099-01-01',slotId:'missing',name:'A',email:'a@example.com'})).result,'invalid');
 assert.equal((await system.createBooking({date:'2099-01-01',slotId:'09:00',name:'A',email:'a@example.com',partySize:2})).result,'invalid');
 await assert.rejects(system.createBooking({date:'2099-01-01',slotId:'09:00',name:'A',email:'a@example.com'}),/does not support shared/);
});
test('shared rejection stays invalid/over_capacity without a fabricated confirmation record',async()=>{
 const system=makeBookingSystem({shared:true,slots,deps:{ensureSession:async()=>{},db:{booking:()=>({reserve:async()=>({result:'over_capacity',record:null})})}}});const result=await system.createBooking({date:'2099-01-01',slotId:'09:00',name:'A',email:'a@example.com'});assert.equal(result.result,'over_capacity');assert.equal(result.booking,null);assert.equal(result.reference,undefined);
});
test('SDK binds all reservation RPCs to the configured app and entity',async()=>{
 const requests=[];const appId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const backend=createSupabaseBackend({url:'https://test.example',anonKey:'test-public-key',appId,fetchImpl:async(url,options)=>{requests.push({url:String(url),body:JSON.parse(options.body)});return new Response(JSON.stringify(String(url).endsWith('app_booking_remaining')?0:{result:'ok',record:null}),{status:200,headers:{'content-type':'application/json'}});}});
 const booking=backend.db.booking('consultation');await booking.reserve({date:'2099-01-01',slotId:'09:00',requestId:'10000000-0000-4000-8000-000000000001',values:{name:'A',email:'a@example.com'}});assert.equal(await booking.remaining('2099-01-01','09:00'),0);await booking.cancel('BK-123456789ABC','a@example.com');assert.deepEqual(requests.map(r=>r.url.split('/').at(-1)),['app_booking_reserve','app_booking_remaining','app_booking_cancel']);assert.ok(requests.every(r=>r.body.p_app_id===appId&&r.body.p_entity_type==='consultation'));assert.equal(requests[0].body.p_request_id,'10000000-0000-4000-8000-000000000001');
});

test('SDK retries a transient reservation failure with the identical idempotency key',async()=>{
 const requests=[];const backend=createSupabaseBackend({url:'https://test.example',anonKey:'test-public-key',appId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',fetchImpl:async(url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify(requests.length===1?{message:'temporarily unavailable'}:{result:'ok',record:{id:'same-row'}}),{status:requests.length===1?503:200,headers:{'content-type':'application/json'}});}});
 const result=await backend.db.booking('booking').reserve({date:'2099-01-01',slotId:'09:00',requestId:'10000000-0000-4000-8000-000000000001',values:{name:'A',email:'a@example.com'}});
 assert.equal(result.result,'ok');assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
});
test('SDK does not retry authorization failures',async()=>{
 let calls=0;const backend=createSupabaseBackend({url:'https://test.example',anonKey:'test-public-key',appId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',fetchImpl:async()=>{calls++;return new Response(JSON.stringify({message:'denied'}),{status:403,headers:{'content-type':'application/json'}});}});
 await assert.rejects(backend.db.booking('booking').remaining('2099-01-01','09:00'),error=>error.message==='denied');assert.equal(calls,1);
});
test('SDK recognizes cancellation committed before a lost response',async()=>{
 let calls=0;const backend=createSupabaseBackend({url:'https://test.example',anonKey:'test-public-key',appId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',fetchImpl:async()=>{calls++;return new Response(JSON.stringify(calls===1?{message:'lost response'}:{ok:false,reason:'already_cancelled',record:{id:'own-row'}}),{status:calls===1?502:200,headers:{'content-type':'application/json'}});}});
 const result=await backend.db.booking('booking').cancel('BK-123456789ABC','a@example.com');assert.equal(result.ok,true);assert.equal(result.record.id,'own-row');assert.equal(calls,2);
});
