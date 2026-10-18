import test from 'node:test';
import assert from 'node:assert/strict';
import { cursorFilter, dumpTable } from '../../ops/lib/backupPagination.mjs';

function client(pages) {
  const calls = [];
  return { calls, from(table) {
    const call = { table, order: [], equals: [] }; calls.push(call);
    const q = { select: () => q, order: key => { call.order.push(key); return q; },
      or: filter => { call.filter = filter; return q; },
      eq: (column,value) => { call.equals.push([column,value]); return q; },
      limit: size => { call.size = size; return Promise.resolve(pages.shift()); } };
    return q;
  } };
}
test('backup uses ordered keysets instead of offsets after concurrent earlier-row deletion', async () => {
  const c = client([{data:[{id:1},{id:2}]},{data:[{id:3}]}]);
  assert.deepEqual(await dumpTable(c,'projects',{pageSize:2,pause:async()=>{}}),[{id:1},{id:2},{id:3}]);
  assert.deepEqual(c.calls[0].order,['id']); assert.equal(c.calls[1].filter,'id.gt.2');
});
test('composite cursor quotes punctuation and advances lexicographically', () => {
  assert.equal(cursorFilter(['app_id','event_id'],{app_id:'a',event_id:'x,).eq."q'}),
    'app_id.gt."a",and(app_id.eq."a",event_id.gt."x,).eq.\\"q")');
  assert.throws(()=>cursorFilter(['id'],{}),/missing/);
});
test('backup retries only timeout, shrinks before continuing, and rejects duplicates', async () => {
  const c=client([{error:{message:'statement timeout'}},{data:[{id:1}]}]);
  await dumpTable(c,'projects',{pageSize:100,pause:async()=>{},log:()=>{}});
  assert.deepEqual(c.calls.map(c=>c.size),[100,25]);
  await assert.rejects(dumpTable(client([{data:[{id:1}]},{data:[{id:1}]}]),'projects',
    {pageSize:1,pause:async()=>{}}),/duplicate primary key/);
  await assert.rejects(dumpTable(client([{error:{message:'permission denied'}}]),'projects'),/permission denied/);
  await assert.rejects(dumpTable(client([]),'unknown_table'),/not configured/);
});


test('transport retries are bounded and preserve the exact page cursor', async () => {
  const c=client([{data:[{id:1}]},{error:{message:'unavailable'},status:503},{data:[{id:2}]},{data:[]}]);
  assert.equal((await dumpTable(c,'projects',{pageSize:1,pause:async()=>{},retryPause:async()=>{},log:()=>{}})).length,2);
  assert.equal(c.calls[1].filter,c.calls[2].filter);
  const down=client(Array.from({length:4},()=>({error:{message:'unavailable'},status:503})));
  await assert.rejects(dumpTable(down,'projects',{retryPause:async()=>{},log:()=>{}}),/unavailable/);
  assert.equal(down.calls.length,4);
});

test('parent reconciliation keeps owner filters on every page and transport retry', async () => {
  const c=client([{data:[{id:1}]},{error:{message:'unavailable'},status:503},{data:[{id:2}]},{data:[]}]);
  const filters=[['owner','audit-owner'],['project_id','audit-project']];
  await dumpTable(c,'bv2_symbols',{filters,pageSize:1,pause:async()=>{},retryPause:async()=>{},log:()=>{}});
  assert.ok(c.calls.length>2);for(const call of c.calls)assert.deepEqual(call.equals,filters);
});
