// Did the patch do anything, and did it do the RIGHT thing?
//
// PR3 of docs/PIPELINE-REDESIGN.md. The detection here already existed and was already correct —
// the failure fingerprint `ac60a9b42a79f171` was identical across all four production builds, and
// the system noticed. What it did next was surrender:
//
//   appBuildService.mjs:231
//   if (attempt >= maxAttempts || previousFingerprints.includes(fingerprint)) → blocked
//
// It blocked at attempt 2 of 3 — before exhausting its own budget — because an unchanged
// fingerprint was treated as terminal. But an unchanged fingerprint is the strongest signal
// available that the CURRENT STRATEGY is wrong, and the right response to that is a different
// strategy, not the end of the run.
//
// Two rules follow, and they only work together:
//
//   1. an unchanged fingerprint ESCALATES to a materially different strategy
//   2. a patch that changed nothing relevant does not COST an attempt
//
// Without (2), escalation just burns the budget faster. Without (1), (2) loops forever.

import { stripAnsi } from "./repairContext.mjs";

// The ladder, in the order a competent engineer would climb it. Each rung is a materially different
// approach to the same failure, not a retry of the previous one with more emphasis.
export const STRATEGIES = [
  {
    id: "targeted_fix",
    label: "a targeted fix to the failing line",
    instruction: "Fix the exact line the error names. Change nothing else.",
  },
  {
    id: "dependency_inspection",
    label: "inspecting the dependency's real exports",
    instruction: [
      "The targeted fix did not work. Stop trusting the import and CHECK it: read package.json for",
      "the installed version, and establish what that package actually exports at that version.",
      "If the symbol does not exist, use one that does, or remove the dependency on it entirely.",
    ].join(" "),
  },
  {
    id: "regenerate_module",
    label: "regenerating the broken module",
    instruction: [
      "Two targeted attempts have failed. Rewrite the single file the error names, from scratch,",
      "preserving its exports and its visual output but not its internals. Do not touch any other file.",
    ].join(" "),
  },
  {
    id: "revert_and_rebuild",
    label: "reverting to the last working checkpoint and rebuilding the feature",
    instruction: [
      "Repair has failed repeatedly. The project has been restored to its last green checkpoint.",
      "Rebuild the feature that was being added, in a different way from the one that kept failing.",
    ].join(" "),
  },
];

export const FIRST_STRATEGY = STRATEGIES[0].id;

export function strategy(id) {
  return STRATEGIES.find((s) => s.id === id) || STRATEGIES[0];
}

/** The next rung, or null at the top of the ladder. */
export function escalate(fromId) {
  const at = STRATEGIES.findIndex((s) => s.id === fromId);
  return at >= 0 && at < STRATEGIES.length - 1 ? STRATEGIES[at + 1].id : null;
}

/**
 * Verify a FUNCTIONAL repair against the findings that triggered it.
 *
 * `verifyPatch` below answers "did the compiler error move?", which is the wrong question entirely
 * for an honesty or journey failure. In production it answered "effective" twice while the honesty
 * findings went 4 → 4 → 7, because the project compiled throughout. Compile success is irrelevant
 * to this verdict.
 *
 * The rule: a repair is effective only when the original blocking findings are GONE and nothing
 * equivalent or worse has appeared. Identity, not count — `localStorage` becoming `sessionStorage`
 * is the same finding wearing a different name, and it must not read as progress.
 */
export function verifyFunctionalRepair({ before, after, keyOf }) {
  const beforeKeys = new Set((before || []).map(keyOf));
  const afterKeys = new Set((after || []).map(keyOf));

  const resolved = [...beforeKeys].filter((key) => !afterKeys.has(key));
  const remaining = [...beforeKeys].filter((key) => afterKeys.has(key));
  const introduced = [...afterKeys].filter((key) => !beforeKeys.has(key));

  // Same class of defect, different location or spelling. This is the substitution that actually
  // happened, and counting keys alone would have called it progress.
  const classOf = (key) => String(key).split(":")[0];
  const beforeClasses = new Set([...beforeKeys].map(classOf));
  const equivalent = introduced.filter((key) => beforeClasses.has(classOf(key)));

  let verdict;
  if (!after?.length) verdict = "effective";
  else if (introduced.length && (after.length > (before || []).length || equivalent.length)) verdict = "worse";
  else if (remaining.length) verdict = "ineffective";
  else verdict = "effective";

  return {
    verdict,
    effective: verdict === "effective",
    resolved: resolved.length,
    remaining: remaining.length,
    introduced: introduced.length,
    equivalent: equivalent.length,
    beforeCount: (before || []).length,
    afterCount: (after || []).length,
    summary: verdict === "effective"
      ? `all ${(before || []).length} finding(s) resolved`
      : verdict === "worse"
        ? `the repair made it worse: ${(before || []).length} finding(s) became ${(after || []).length}`
          + `${equivalent.length ? `, including ${equivalent.length} of the same kind in a new place` : ""}`
        : `${remaining.length} of ${(before || []).length} finding(s) are unchanged`,
  };
}


/**
 * The file and symbol the failure actually names.
 *
 * Extracted so a patch can be checked against the error rather than against a vague notion of
 * relevance. Both production repairs would have failed this check: one edited unused imports in the
 * right file (symbol wrong), the other edited a cancellation handler (symbol AND intent wrong).
 */
export function failureTarget(output) {
  // Colourised compiler output otherwise yields paths like "[31msrc/App.jsx".
  const text = stripAnsi(output);
  const target = { file: null, line: null, symbol: null };

  // "src/App.jsx (7:129):" or "src/App.jsx:7:129"
  const located = text.match(/([\w./-]+\.(?:jsx?|tsx?|mjs|css))[\s:(]+(\d+)[:,]/);
  if (located) { [, target.file, target.line] = located; target.line = Number(target.line); }
  else {
    const named = text.match(/([\w./-]+\.(?:jsx?|tsx?|mjs|css))/);
    if (named) target.file = named[1];
  }

  // '"Instagram" is not exported by' / "Cannot find name 'foo'" / "'x' is not defined"
  const symbol = text.match(/"([A-Za-z_$][\w$]*)" is not exported/)
    || text.match(/Cannot find name '([A-Za-z_$][\w$]*)'/)
    || text.match(/'([A-Za-z_$][\w$]*)' is not defined/)
    || text.match(/([A-Za-z_$][\w$]*) is not defined/);
  if (symbol) [, target.symbol] = symbol;

  return target;
}

// Tree paths are project-relative; compiler paths are often absolute. Compare by suffix.
function sameFile(treePath, failurePath) {
  if (!treePath || !failurePath) return false;
  const a = treePath.replace(/\\/g, "/");
  const b = failurePath.replace(/\\/g, "/");
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * Verify one repair round.
 *
 * `before`/`after` are file trees; `output` is the compiler output that prompted the repair;
 * `fingerprint`/`previousFingerprint` are the failure signatures either side of it.
 *
 * Returns a verdict the planner can act on:
 *   effective  — the signature moved or the failure is gone. Progress.
 *   no_op      — nothing meaningful changed. Must not cost an attempt.
 *   irrelevant — real edits, but not to what the error named. Must not cost an attempt.
 *   ineffective— relevant edits that did not move the signature. Costs an attempt; escalates.
 */
export function verifyPatch({
  before = {}, after = {}, output = "", fingerprint = null, previousFingerprint = null, resolved = false,
} = {}) {
  const changedFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path]);
  const diffChars = changedFiles.reduce(
    (total, path) => total + Math.abs(String(after[path] || "").length - String(before[path] || "").length), 0,
  );

  const target = failureTarget(output);
  const touchedTargetFile = target.file ? changedFiles.some((path) => sameFile(path, target.file)) : null;

  // Did the patch touch the SYMBOL the error named, in the file the error named? The precise
  // question the production repairs would both have answered "no" to.
  let touchedFailingSymbol = null;
  if (target.symbol && target.file) {
    const path = changedFiles.find((p) => sameFile(p, target.file));
    // Compare the LINES that mention the symbol, not how many times it appears. Counting
    // occurrences misses the most likely correct fix: `Camera as Instagram` leaves the number of
    // "Instagram" mentions exactly as it was while changing the only thing that mattered.
    touchedFailingSymbol = path
      ? symbolSignature(before[path], target.symbol) !== symbolSignature(after[path], target.symbol)
      : false;
  }

  const signatureMoved = resolved || (!!fingerprint && !!previousFingerprint && fingerprint !== previousFingerprint);

  // Whether anything of substance changed. NOT `diffChars`, which is a length delta and so reads
  // zero for a same-length rewrite — `Instagram` → `Instagram2 as Instagram` differs by 7
  // characters and is unmistakably an attempt. Whitespace-insensitive equality is the honest test:
  // reformatting is not a repair, and everything else is.
  const substantive = changedFiles.some(
    (path) => String(before[path] || "").replace(/\s+/g, "") !== String(after[path] || "").replace(/\s+/g, ""),
  );

  let verdict;
  if (resolved || signatureMoved) verdict = "effective";
  else if (!changedFiles.length || !substantive) verdict = "no_op";
  else if (touchedTargetFile === false || touchedFailingSymbol === false) verdict = "irrelevant";
  else verdict = "ineffective";

  return {
    verdict,
    // `countsAsAttempt` is the rule that makes escalation affordable: a patch that never engaged
    // with the problem is not one of the attempts the customer is paying for.
    countsAsAttempt: verdict === "ineffective" || verdict === "effective",
    changedFiles, diffChars, target,
    touchedTargetFile, touchedFailingSymbol, signatureMoved,
    // One line, written to go straight into the next repair brief.
    summary: summarise(verdict, target, changedFiles),
  };
}

/**
 * A signature of everything this file says ABOUT this symbol, and nothing about anything else.
 *
 * Comma-segment granularity, not line granularity, because both wrong answers live at the line
 * level. Counting occurrences misses `Camera as Instagram` — the most likely correct fix — because
 * the number of mentions is unchanged. Comparing whole lines wrongly credits deleting `Clock,
 * Users, Phone` from the same import statement, which is exactly what production repair 1 did.
 *
 * So the import CLAUSE ELEMENT that binds the symbol is isolated exactly, and everything around it
 * — sibling imports, the module path, the brace positions — is discarded:
 *   before: "Instagram"   after (repair 1, deletes siblings): "Instagram"           → untouched ✓
 *   before: "Instagram"   after (the real fix):               "Camera as Instagram" → touched   ✓
 *
 * Uses outside imports are included verbatim, so a change to how the symbol is USED counts too.
 */
function symbolSignature(source, symbol) {
  if (!source) return "";
  const text = String(source);
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`\\b${escaped}\\b`);
  const parts = [];

  // The binding: the one element of an import clause whose LOCAL name is this symbol.
  for (const match of text.matchAll(/import\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g)) {
    for (const element of match[1].split(",")) {
      const local = element.trim().split(/\s+as\s+/).pop()?.trim();
      if (local === symbol) parts.push(`bind:${element.trim().replace(/\s+/g, " ")}`);
    }
  }

  // Every non-import line that names it.
  for (const line of text.split("\n")) {
    if (word.test(line) && !/^\s*import\b/.test(line)) parts.push(`use:${line.trim()}`);
  }
  return parts.join("|");
}

function summarise(verdict, target, changedFiles) {
  const where = changedFiles.length ? changedFiles.join(", ") : "nothing";
  switch (verdict) {
    case "effective":
      return `the last patch changed ${where} and the failure signature moved`;
    case "no_op":
      return "the last patch changed nothing — it did not attempt a fix";
    case "irrelevant":
      return `the last patch edited ${where}, which is not what the error names`
        + `${target.symbol ? ` — the error is about "${target.symbol}"` : ""}`
        + `${target.file ? ` in ${target.file}` : ""}`;
    default:
      return `the last patch edited ${where} and the failure signature did not change`;
  }
}
