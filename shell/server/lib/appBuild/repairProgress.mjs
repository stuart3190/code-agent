// No-progress detection for the repair loop.
//
// Fingerprinting already stops an IDENTICAL failure and an IDENTICAL repair brief. Neither
// catches the expensive middle case: a repair that changes the wording of the failure, or
// edits a file, while leaving the underlying problem exactly where it was. Those rounds
// pass both fingerprint checks and spend a full job to learn nothing.
//
// This module compares the measurable state of one round against the previous one and
// decides whether the loop earned another attempt. It is pure: the relay measures, this
// judges, and the reason it returns is recorded in Diagnostics either way.

// A round's measurable state. Everything is optional — a round that never got as far as
// compiling simply reports what it knows.
export function roundSignals({
  compileOk = null,
  compilerErrorCount = null,
  failures = [],
  failureFingerprint = null,
  briefFingerprint = null,
  runtimeOk = null,
  previewOk = null,
  verificationPassed = null,
  verificationChecksPassed = null,
  verificationChecksTotal = null,
  filesChanged = 0,
  changedPaths = [],
  diffChars = 0,
} = {}) {
  const list = [].concat(failures || []).map((f) => String(f));
  return {
    compileOk,
    compilerErrorCount,
    failures: list,
    failureCount: list.length,
    failureFingerprint,
    briefFingerprint,
    runtimeOk,
    previewOk,
    verificationPassed,
    verificationChecksPassed,
    verificationChecksTotal,
    filesChanged: Number(filesChanged) || 0,
    // The paths, not just the count — the next repair brief names what the last patch touched, so
    // an agent can see it edited a file the error never mentioned.
    changedPaths: [].concat(changedPaths || []).map(String),
    diffChars: Number(diffChars) || 0,
  };
}

// A repair that touches nothing, or nudges a handful of characters, has not attempted
// anything — treat it as no change rather than as a small change.
const MEANINGFUL_DIFF_CHARS = 20;

export function madeMeaningfulChange(current) {
  return (current?.filesChanged || 0) > 0 && (current?.diffChars || 0) >= MEANINGFUL_DIFF_CHARS;
}

// Normalised failure identities, so "Signup: no email field" and "Signup: missing email
// field" are recognised as the same underlying check rather than as different failures.
function failureKeys(signals) {
  return new Set((signals?.failures || []).map((f) =>
    String(f).toLowerCase().split(":")[0].replace(/\d+/g, "#").replace(/\s+/g, " ").trim()));
}

function isSubset(a, b) {
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

// Compare two rounds. Returns { improved, reason, signals } — `reason` is user-neutral
// English recorded in Diagnostics whether we continue or stop.
export function evaluateProgress(previous, current) {
  if (!previous) {
    return { improved: true, reason: "First repair attempt — no previous round to compare against.", metrics: {} };
  }

  const metrics = {
    previousFailures: previous.failureCount,
    currentFailures: current.failureCount,
    filesChanged: current.filesChanged,
    diffChars: current.diffChars,
  };

  // A repeated strategy is not progress even if the failure text moved around.
  if (current.briefFingerprint && current.briefFingerprint === previous.briefFingerprint) {
    return { improved: false, reason: "The repair repeated the previous strategy.", metrics };
  }

  // Hard evidence of improvement, cheapest checks first.
  if (previous.compileOk === false && current.compileOk === true) {
    return { improved: true, reason: "The build now compiles where it previously did not.", metrics };
  }
  if (previous.previewOk === false && current.previewOk === true) {
    return { improved: true, reason: "The preview now loads where it previously did not.", metrics };
  }
  if (previous.runtimeOk === false && current.runtimeOk === true) {
    return { improved: true, reason: "The runtime checks now pass where they previously did not.", metrics };
  }
  if (current.verificationPassed === true && previous.verificationPassed !== true) {
    return { improved: true, reason: "Verification now passes.", metrics };
  }
  if (
    Number.isFinite(current.verificationChecksPassed)
    && Number.isFinite(previous.verificationChecksPassed)
    && current.verificationChecksPassed > previous.verificationChecksPassed
  ) {
    return { improved: true, reason: "More verification checks pass than in the previous round.", metrics };
  }
  if (current.failureCount < previous.failureCount) {
    return { improved: true, reason: "Fewer checks are failing than in the previous round.", metrics };
  }
  if (
    Number.isFinite(current.compilerErrorCount)
    && Number.isFinite(previous.compilerErrorCount)
    && current.compilerErrorCount < previous.compilerErrorCount
  ) {
    return { improved: true, reason: "Fewer compiler errors than in the previous round.", metrics };
  }

  // A broad failure becoming a narrower one is progress even at the same count: the current
  // failures are a strict subset of what failed before.
  const previousKeys = failureKeys(previous);
  const currentKeys = failureKeys(current);
  if (currentKeys.size && previousKeys.size && currentKeys.size < previousKeys.size && isSubset(currentKeys, previousKeys)) {
    return { improved: true, reason: "The failure narrowed to a smaller part of the app.", metrics };
  }

  // Regressions and stalls.
  if (current.failureCount > previous.failureCount) {
    return { improved: false, reason: "The repair increased the number of failing checks.", metrics };
  }
  if (previous.compileOk === true && current.compileOk === false) {
    return { improved: false, reason: "The repair broke a build that previously compiled.", metrics };
  }
  if (!madeMeaningfulChange(current)) {
    return { improved: false, reason: "The repair produced no meaningful code change.", metrics };
  }
  if (current.failureFingerprint && current.failureFingerprint === previous.failureFingerprint) {
    return { improved: false, reason: "The same underlying problem remains unchanged.", metrics };
  }

  return { improved: false, reason: "The repair changed code but no check improved.", metrics };
}

// Did this round leave the project in a worse state than the previous one? Used to decide
// whether to restore the last better checkpoint before stopping (§8).
export function regressed(previous, current) {
  if (!previous || !current) return false;
  if (previous.compileOk === true && current.compileOk === false) return true;
  if (previous.verificationPassed === true && current.verificationPassed === false) return true;
  if (previous.previewOk === true && current.previewOk === false) return true;
  return Number.isFinite(previous.failureCount) && current.failureCount > previous.failureCount;
}
