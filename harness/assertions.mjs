// Harness assertions — the automated form of the checks iterate.mjs ran by hand.
// Coarse on purpose (presence of named markers + a real build), matching the proven
// Phase 1 bar so the baseline measures the same thing later phases must not regress.

import { concatSource } from "../src/engine/fileTree.mjs";

// Which of `markers` appear anywhere in the tree's source. Case-insensitive so a
// marker like "high-priority" matches regardless of casing in the generated code.
export function markersPresent(tree, markers) {
  const src = concatSource(tree).toLowerCase();
  const present = [];
  const missing = [];
  for (const m of markers) {
    (src.includes(m.toLowerCase()) ? present : missing).push(m);
  }
  return { present, missing };
}
