// Which checks does this change actually invalidate?
//
// After every repair the pipeline re-ran everything: the journey driver, the generic auth probe,
// the runtime probe, the honesty scan. A CSS fix paid for a persistence test. On the 62-credit
// booking site the auth probe failed three times and drove every repair round on an app whose
// contract never mentioned accounts.
//
// Verification is dependency-aware here: a check declares what it depends on, the changed files
// are mapped to the same vocabulary, and a check whose dependencies did not move keeps its previous
// verdict. This is a cache, so it can only ever SKIP work that already passed — a failing check is
// never cached, because the thing it was complaining about might be exactly what just changed.

// What a file is about. Ordered: the first match wins, so `src/lib/backend/` is infrastructure
// before it is "a source file".
const CONCERNS = [
  [/^src\/lib\/backend\//, "backend"],
  [/\.(css|scss|sass)$/, "style"],
  [/tailwind\.config|postcss\.config/, "style"],
  [/\b(auth|login|signup|session|account)\b/i, "auth"],
  [/\b(data|store|repository|entity|entities|db|api|service)\b/i, "data"],
  [/\b(route|router|routes|nav|navigation)\b/i, "routing"],
  [/^package\.json$|^vite\.config|^index\.html$/, "config"],
  [/\.(jsx?|tsx?)$/, "ui"],
];

/** The concerns one path touches. A file is usually about one thing; some are about two. */
export function concernsOf(path) {
  const found = new Set();
  for (const [pattern, concern] of CONCERNS) {
    if (pattern.test(path)) { found.add(concern); break; }
  }
  // A component named BookingForm is UI *and* data-adjacent; naming it only "ui" would let a
  // persistence bug slip past the cache. Matched WITHOUT word boundaries because these names are
  // camelCase — there is no boundary before the "Form" in "BookingForm", and an earlier version
  // therefore classified it as pure UI and would have skipped its persistence check.
  if (/(form|booking|checkout|order|payment|profile)/i.test(path)) found.add("data");
  if (/(auth|login|signup|session|account)/i.test(path)) found.add("auth");
  if (!found.size) found.add("ui");
  return [...found];
}

/** Everything the changed files touch. */
export function changedConcerns(changedFiles = []) {
  const all = new Set();
  for (const path of changedFiles) for (const concern of concernsOf(path)) all.add(concern);
  return all;
}

// What each check cares about. A check re-runs when ANY of its concerns changed.
export const CHECK_DEPENDENCIES = Object.freeze({
  compile: ["backend", "style", "auth", "data", "routing", "config", "ui"], // everything
  imports: ["backend", "auth", "data", "routing", "config", "ui"],
  honesty: ["backend", "auth", "data", "ui"],
  persistence: ["backend", "data"],
  authJourney: ["backend", "auth"],
  journeys: ["backend", "auth", "data", "routing", "ui"],
  visual: ["style", "ui"],
  console: ["backend", "auth", "data", "routing", "ui"],
});

/**
 * A per-build record of what has passed and on what tree.
 *
 * Keyed on the check, not the file, because the question being answered is "must I run this
 * again?" rather than "what happened to this file?".
 */
export function createVerificationCache() {
  const passed = new Map(); // check -> { at, concerns }

  return {
    /**
     * Should this check run?
     *
     * Runs when: it has never passed, or something it depends on has changed since it did. Note
     * the asymmetry — only PASSES are recorded, so a check that failed always runs again.
     */
    needsRun(check, changed) {
      const previous = passed.get(check);
      if (!previous) return { run: true, reason: "not verified yet" };
      const deps = CHECK_DEPENDENCIES[check] || [];
      const touched = deps.filter((concern) => changed.has(concern));
      if (touched.length) return { run: true, reason: `${touched.join(", ")} changed` };
      return { run: false, reason: `nothing affecting ${check} changed` };
    },

    recordPass(check) { passed.set(check, { at: Date.now() }); },

    // A failure invalidates the record: whatever it found is still there until proven otherwise.
    recordFail(check) { passed.delete(check); },

    /** Everything that would be skipped for this change, for the profile record. */
    plan(changed) {
      const decisions = {};
      for (const check of Object.keys(CHECK_DEPENDENCIES)) decisions[check] = this.needsRun(check, changed);
      return decisions;
    },

    size() { return passed.size; },
  };
}

/**
 * The journeys worth re-running for a given change.
 *
 * A booking-form fix re-runs the booking journey, not the newsletter one. Matched on the journey's
 * own words against the changed paths — crude, and deliberately biased towards running: an
 * unmatched journey runs rather than being skipped, because a missed regression costs far more
 * than a redundant journey.
 */
export function journeysToRerun(contract, changedFiles = [], { previouslyFailed = [] } = {}) {
  const journeys = contract?.journeys || [];
  if (!journeys.length) return [];
  if (!changedFiles.length) return journeys;

  const paths = changedFiles.join(" ").toLowerCase();
  const changed = changedConcerns(changedFiles);

  // A style-only change cannot break a journey's LOGIC — but a journey that was already failing
  // has not been fixed by anything, so skipping it would cache a failure as though it had passed.
  const styleOnly = [...changed].every((c) => c === "style");
  if (styleOnly) return journeys.filter((j) => previouslyFailed.includes(j.id));

  return journeys.filter((journey) => {
    // Always re-run what was already failing, and always re-run the primary journey: it is the
    // one the preview gate depends on, so a stale pass on it is the most expensive kind.
    if (previouslyFailed.includes(journey.id)) return true;
    if (journey.priority === "primary") return true;

    const words = `${journey.id} ${journey.title}`.toLowerCase().match(/[a-z]{4,}/g) || [];
    return words.some((word) => paths.includes(word));
  });
}
