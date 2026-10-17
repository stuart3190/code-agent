import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const sourceUrl = new URL('../../harness/workspace.mjs', import.meta.url);
async function fixture(t, existing) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'thrallo-deps-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = path.join(root, 'harness'), bin = path.join(root, 'bin'), deps = path.join(harness, '.deps');
  await mkdir(deps, { recursive: true }); await mkdir(bin);
  // Relocate only the module's workspace root; imports execute the real production modules.
  let source = await readFile(sourceUrl, 'utf8');
  for (const rel of ['../src/scaffolds/reactVite.mjs', '../src/engine/fileTree.mjs', '../build-worker/processTree.mjs']) {
    source = source.replace(JSON.stringify(rel), JSON.stringify(new URL(rel, sourceUrl).href));
  }
  await writeFile(path.join(harness, 'workspace.mjs'), source);
  await writeFile(path.join(bin, 'npm'), '#!/bin/sh\nset -eu\nprintf x >> install-attempts\nmkdir -p node_modules\nif [ ! -f permit-install ]; then exit 42; fi\n');
  await chmod(path.join(bin, 'npm'), 0o755);
  if (existing) {
    await mkdir(path.join(deps, 'node_modules'));
    await writeFile(path.join(deps, 'package.json'), '{"name":"old-scaffold"}');
  }
  const { ensureDeps } = await import(pathToFileURL(path.join(harness, 'workspace.mjs')).href);
  const run = (options = {}) => ensureDeps(() => {}, { ...options, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { deps, run, bin, moduleUrl: pathToFileURL(path.join(harness, 'workspace.mjs')).href, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}
for (const existing of [false, true]) test(`failed ${existing ? 'refresh' : 'initial'} install cannot mark dependency cache ready`, { skip: process.platform === 'win32' }, async t => {
  const { deps, run } = await fixture(t, existing);
  await assert.rejects(run(), /npm install failed/);
  assert.equal(await readFile(path.join(deps, 'install-attempts'), 'utf8'), 'x');
  await writeFile(path.join(deps, 'permit-install'), '');
  await run();
  assert.equal(await readFile(path.join(deps, 'install-attempts'), 'utf8'), 'xx', 'retry must actually repair the incomplete installation');
  await run();
  assert.equal(await readFile(path.join(deps, 'install-attempts'), 'utf8'), 'xx', 'verified successful installation may be reused');
});

test('separate build processes wait for one complete installation', { skip: process.platform !== 'linux', timeout: 15000 }, async t => {
  const f = await fixture(t, false);
  await writeFile(path.join(f.bin, 'npm'), '#!/bin/sh\nset -eu\nmkdir install-active 2>/dev/null || exit 43\ntrap "rmdir install-active" EXIT\nprintf x >> install-attempts\nsleep 0.3\nmkdir -p node_modules\n');
  const source = `import {existsSync} from 'node:fs';import {ensureDeps} from ${JSON.stringify(f.moduleUrl)};await ensureDeps(()=>{});console.log(JSON.stringify({installationStillActive:existsSync(${JSON.stringify(path.join(f.deps,'install-active'))})}));`;
  const start = () => exec(process.execPath, ['--input-type=module', '-e', source], { env: f.env });
  const first = start();
  const started = Date.now();
  while (true) {
    try { await readFile(path.join(f.deps, 'install-attempts')); break; } catch {}
    if (Date.now()-started > 5000) throw new Error('fixture installer did not start');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const outcomes = await Promise.allSettled([first, start()]);
  assert.ok(outcomes.every(r => r.status === 'fulfilled'), 'both build callers must see a completed installation');
  for (const r of outcomes) assert.equal(JSON.parse(r.value.stdout.trim()).installationStillActive, false);
  assert.equal(await readFile(path.join(f.deps, 'install-attempts'), 'utf8'), 'x');
});

test('timed-out locked install stops npm and leaves a repairable cache', { skip: process.platform !== 'linux', timeout: 20000 }, async t => {
  const f = await fixture(t, false);
  await writeFile(path.join(f.bin, 'npm'), '#!/bin/sh\nset -eu\nprintf x >> install-attempts\necho $$ > installer-pid\nmkdir -p node_modules\nif [ ! -f permit-install ]; then sleep 10; exit 42; fi\n');
  await assert.rejects(f.run({ wallMs: 2000 }), error => error.classification === 'timeout');
  const pid = Number((await readFile(path.join(f.deps, 'installer-pid'), 'utf8')).trim());
  const started = Date.now();
  while (true) {
    let stat;
    try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); } catch (e) { if(e.code === 'ENOENT') break; throw e; }
    if (stat.slice(stat.lastIndexOf(')')+2).startsWith('Z')) break;
    if (Date.now()-started > 2000) throw new Error('owned installer survived cancellation');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await writeFile(path.join(f.deps, 'permit-install'), '');
  await f.run({ wallMs: 3000 });
  assert.equal(await readFile(path.join(f.deps, 'install-attempts'), 'utf8'), 'xx');
});
