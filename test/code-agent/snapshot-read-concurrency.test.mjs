import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotStore, memorySnapshotStorage } from '../../shell/server/lib/builderV2/snapshotStore.mjs';

async function fixture() {
  const storage = memorySnapshotStorage();
  const store = createSnapshotStore(storage);
  const tree = Object.fromEntries(Array.from({length:11}, (_, i) => [`src/${i}.js`, `export default ${i};`]));
  const snapshot = await store.createSnapshot('owner', 'project', tree);
  return { storage, store, tree, snapshot };
}

test('snapshot materialization reads at most four blobs concurrently and preserves the complete tree', async () => {
  const {storage, store, tree, snapshot} = await fixture();
  const read = storage.getBlob.bind(storage);
  let active = 0, peak = 0;
  storage.getBlob = async (owner, hash) => {
    assert.equal(owner, 'owner');
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    try { return await read(owner, hash); } finally { active--; }
  };
  assert.deepEqual(await store.materialize('owner', snapshot.id), tree);
  assert.equal(peak, 4); assert.equal(active, 0);
  await assert.rejects(store.materialize('other-owner', snapshot.id), /not found for this owner/);
});

test('transport failure settles the batch, schedules no later reads and does not mark sound bytes corrupt', async () => {
  const {storage, store, snapshot} = await fixture();
  const read = storage.getBlob.bind(storage);
  let active = 0, calls = 0;
  storage.getBlob = async (owner, hash) => {
    const call = ++calls; active++;
    try {
      if (call === 2) throw new Error('temporary read outage');
      await new Promise(resolve => setTimeout(resolve, 5));
      return await read(owner, hash);
    } finally { active--; }
  };
  await assert.rejects(store.materialize('owner', snapshot.id), /temporary read outage/);
  assert.equal(calls, 4); assert.equal(active, 0);
  assert.equal((await store.getSnapshot(snapshot.id)).state, 'ready');
});

test('a corrupt parallel blob still prevents promotion and marks the snapshot corrupt', async () => {
  const {storage, store, snapshot} = await fixture();
  const read = storage.getBlob.bind(storage);
  let calls = 0;
  storage.getBlob = async (owner, hash) => ++calls === 3 ? 'corrupt' : read(owner, hash);
  await assert.rejects(store.promote('owner', 'project', 'green', snapshot.id), /blob bytes do not match/);
  assert.equal((await store.getSnapshot(snapshot.id)).state, 'corrupt');
  assert.equal(await store.pointer('owner', 'project', 'green'), null);
});
