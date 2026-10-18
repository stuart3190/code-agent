import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkReleaseSandbox } from '../../ops/check-release-sandbox.mjs';

test('release gate executes immutable target policy even when the checkout policy allows reuse', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'release-gate-test-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    mkdirSync(path.join(repo, 'ops'));
    const policy = path.join(repo, 'ops/require-sandbox-image-rebuild.mjs');
    writeFileSync(policy, 'console.log(JSON.stringify({rebuild:false}));');
    git('add', '.'); git('commit', '-qm', 'old policy');
    const from = git('rev-parse', 'HEAD');
    writeFileSync(policy, 'console.log(JSON.stringify({rebuild:true})); process.exitCode=2;');
    git('add', '.'); git('commit', '-qm', 'target policy');
    const to = git('rev-parse', 'HEAD');
    git('checkout', '-q', from);
    assert.throws(() => checkReleaseSandbox({ repo, from, to }), error => error.status === 2);
    assert.equal(checkReleaseSandbox({ repo, from, to, mode: 'image' }).rebuild, true);
    assert.equal(checkReleaseSandbox({ repo, from, to: from }).rebuild, false);
    assert.throws(() => checkReleaseSandbox({ repo, from, to, mode: 'typo' }), /Unknown image mode/);
    assert.throws(() => checkReleaseSandbox({ repo, from, to: 'missing-revision' }));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
