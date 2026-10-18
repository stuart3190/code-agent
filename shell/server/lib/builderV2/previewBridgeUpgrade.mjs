import { createHash } from 'node:crypto';

const PATH = 'src/lib/devReporter.js';
// Exact platform baseline before origin scoping and form-value redaction. Never use a
// text-pattern rewrite: authored preview integration belongs to the application's owner.
const LEGACY_SHA256 = 'c6d9af9f5a8ff30098490a1e24c2af80908b04fc97a0486692316a053158df06';
export function refreshUnmodifiedPreviewBridge(tree, baseline) {
  const previous = tree?.[PATH], current = baseline?.[PATH];
  if (typeof previous !== 'string' || typeof current !== 'string' || previous === current
      || createHash('sha256').update(previous).digest('hex') !== LEGACY_SHA256) return tree;
  return { ...tree, [PATH]: current };
}
