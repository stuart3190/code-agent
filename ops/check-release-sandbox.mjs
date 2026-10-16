#!/usr/bin/env node
// Run the target release's compatibility policy, not the operator's possibly stale checkout.
// No production files, services, images or environment are changed by this gate.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkReleaseSandbox({ repo, from, to, mode = 'noimage' }) {
  if (!['image', 'noimage'].includes(mode)) throw new Error(`Unknown image mode: ${mode}`);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
  const previous = git('rev-parse', '--verify', `${from}^{commit}`);
  const target = git('rev-parse', '--verify', `${to}^{commit}`);
  if (mode === 'image') return { ok: true, rebuild: true, previous, target };
  const changed = git('diff', '--name-only', '-z', previous, target).split('\0').filter(Boolean);
  if (!changed.length) return { ok: true, rebuild: false, previous, target };
  const dir = mkdtempSync(path.join(tmpdir(), 'thrallo-release-gate-'));
  try {
    const archive = execFileSync('git', ['-C', repo, 'archive', target], { maxBuffer: 128 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', dir], { input: archive });
    const output = execFileSync(process.execPath, [path.join(dir, 'ops/require-sandbox-image-rebuild.mjs'), '--paths', ...changed], {
      cwd: dir, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    return { ...JSON.parse(output), ok: true, previous, target };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, from, to, mode] = process.argv.slice(2);
  try {
    if (!repo || !from || !to) throw new Error('Usage: check-release-sandbox.mjs <repo> <previous> <target> [image|noimage]');
    console.log(JSON.stringify(checkReleaseSandbox({ repo, from, to, mode }), null, 2));
  } catch (error) {
    console.error('Release blocked before activation: sandbox compatibility gate failed.');
    console.error(error.stdout?.toString() || error.message);
    process.exitCode = error.status === 2 ? 2 : 1;
  }
}
