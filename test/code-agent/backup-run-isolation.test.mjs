import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, stat, rm, symlink, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrivateBackupDirectory } from '../../ops/backup-thrallo.mjs';

test('concurrent exports reserve different ownership of the same run: exactly one wins', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backup-isolation-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const dir = path.join(root, 'run');
  const results = await Promise.allSettled([createPrivateBackupDirectory(dir), createPrivateBackupDirectory(dir)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'EEXIST');
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(dir, 'storage'))).mode & 0o777, 0o700);
});

test('an existing symlink cannot redirect an export into another directory', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'backup-symlink-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const target = path.join(root, 'other');
  await mkdir(target);
  const dir = path.join(root, 'run');
  await symlink(target, dir);
  await assert.rejects(createPrivateBackupDirectory(dir), { code:'EEXIST' });
  assert.deepEqual(await readdir(target), []);
});
