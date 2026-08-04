// The terminal states a build can actually be in.
//
// Before this, `preview_ready` was emitted the moment the compiler passed — BEFORE verification
// ran at all. A production run then ended "preview delivered, customer needed: no" with five of six
// contract journeys failing and seven honesty findings outstanding. The customer was handed a
// finished-looking app that did not work, and the run was recorded as a success.
//
// Detection without enforcement is not completion. These states are the enforcement: `preview_ready`
// is now something a build EARNS by passing verification, not something it gets for compiling.
//
// Shared between server and web so the status a customer sees and the status the pipeline records
// are the same word.

export const BUILD_STATES = Object.freeze({
  // Compiled and running, checks not finished. NOT shippable, NOT a failure.
  verificationPending: "verification_pending",
  // A check found a real functional problem. The customer sees that it is being fixed.
  verificationFailed: "verification_failed",
  // A repair is in flight for a verification or honesty failure.
  repairInProgress: "repair_in_progress",
  // Repair is exhausted. The last green checkpoint stands; the customer decides what happens next.
  blocked: "blocked",
  // Everything required passed. The ONLY state in which a preview may be shown as complete.
  previewReady: "preview_ready",
});

const SHIPPABLE = new Set([BUILD_STATES.previewReady]);

/** May the customer be shown this build as a finished preview? */
export function isShippable(state) {
  return SHIPPABLE.has(state);
}

/**
 * Decide the state from what the checks actually found.
 *
 * The order matters and encodes the priority: an app that does not do what was agreed is not
 * "ready with warnings", it is not ready. Honesty findings sit alongside journey failures because
 * "the button does nothing" and "the journey fails" are the same defect seen from two directions.
 */
export function resolveBuildState({
  compileOk = null,
  previewUrl = null,
  journeys = null,        // the PR6 verdict, or null when not run
  honesty = null,         // the PR7 verdict, or null when not run
  acceptanceFailures = [],
  repairing = false,
  exhausted = false,
} = {}) {
  if (exhausted) return BUILD_STATES.blocked;
  if (repairing) return BUILD_STATES.repairInProgress;
  if (compileOk === false) return BUILD_STATES.verificationFailed;

  const journeyFailed = journeys?.pass === false;
  const honestyFailed = honesty && honesty.ok === false;
  if (journeyFailed || honestyFailed || acceptanceFailures.length) return BUILD_STATES.verificationFailed;

  // Nothing has failed — but nothing has passed either. A build whose journeys were never run has
  // not earned `preview_ready`; it has merely not been caught. That distinction is the whole point.
  const journeysProven = journeys?.pass === true;
  const honestyProven = honesty ? honesty.ok === true : true;
  if (!previewUrl) return BUILD_STATES.verificationPending;
  if (journeys && !journeysProven) return BUILD_STATES.verificationPending;
  if (!honestyProven) return BUILD_STATES.verificationPending;

  return BUILD_STATES.previewReady;
}

/**
 * What the customer is told, per state.
 *
 * A functional failure is normal, expected, and being handled — the wording says that rather than
 * alarming someone about a problem they are not being asked to solve.
 */
export function customerMessageFor(state, { detail = "" } = {}) {
  switch (state) {
    case BUILD_STATES.previewReady:
      return "Your app is built and the preview is live in this conversation.";
    case BUILD_STATES.verificationPending:
      return "Your app is built. I'm checking that it actually works before I show it to you.";
    case BUILD_STATES.verificationFailed:
    case BUILD_STATES.repairInProgress:
      return "Thrallo found a functional issue and is fixing it automatically.";
    case BUILD_STATES.blocked:
      return `I couldn't get this working automatically${detail ? `: ${detail}` : ""}. `
        + "Your last working version is saved — tell me how you'd like to proceed.";
    default:
      return "Your app is being prepared.";
  }
}

/** States in which publish and deployment must refuse to act. */
export function blocksPublishing(state) {
  return !isShippable(state);
}
