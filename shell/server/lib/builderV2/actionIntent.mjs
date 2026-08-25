// Canonical action-intent normalisation for contracted journey steps.
//
// WHY THIS EXISTS
//
// Interaction semantics used to be decided by raw word-boundary tests scattered through the
// derivation, and every one of them was inflection-sensitive in a way that cost a real journey:
//
//   /\bbook\b/     did not match "booking"      → "start the booking flow" derived no flow entry
//   /\bcancel\b/   did not match "cancellation" → "confirm cancellation" derived a bare mutation
//   /\brecover\b/  did not match "recovery"     → a recovery step was judged as ordinary prose
//   /\bconfirm\b/  did not match "confirmation" → a commit step derived nothing to drive
//   /\badvance\b/  did not match "advancing"    → a transition step fell through to keyword clicks
//
// Widening those tests fails in the opposite direction just as reliably: "the cancellation policy
// is displayed", "a valid confirmed booking reference" and "review the booking" are prose about a
// record, and a looser match turns each of them into a contracted interaction that no control
// exists to satisfy.
//
// So the surface forms are normalised ONCE, here, onto a small canonical intent vocabulary, and
// position decides whether a word is being used as an action at all:
//
//   • VERB POSITION      — first word of the phrase, or after and/then/to/or  → it is an action
//   • COMMIT OBJECT      — what a commit verb commits ("confirm cancellation") → it refines it
//   • anywhere else      — a noun or adjective naming a record or its state  → NOT an action
//
// SCOPE — this module answers exactly one question: what KIND OF INTERACTION is this step? It
// never decides durable ownership. Whether a journey produces or consumes a durable record is a
// lifecycle question answered from the contract's declared operations (lifecycleOperations.mjs).
// Those two questions answered for each other is precisely how a journey that UPDATES an existing
// record came to be classified as the record's producer.

/** The canonical interaction vocabulary. Nothing outside this file invents an intent name. */
export const ACTION_INTENT = Object.freeze({
  START: "start",         // enters a multi-step flow
  ADVANCE: "advance",     // moves an established flow on, writing nothing itself
  SELECTION: "selection", // chooses among offered options
  INPUT: "input",         // supplies a typed value
  REVIEW: "review",       // observes gathered values before a commit
  CONFIRM: "confirm",     // commits a durable record (create/update/delete alike)
  CANCEL: "cancel",       // cancels an existing durable record
  RECOVER: "recover",     // returns to a durable record after a reload or a new session
  LOOKUP: "lookup",       // locates an existing durable record
  NAVIGATE: "navigate",   // moves between surfaces
  ACTIVATE: "activate",   // presses a control whose semantics the prose does not name
});

// Inflection, generically. A stem covers its own inflected forms rather than being listed twice:
// cancel/cancelled/cancelling/cancellation, confirm/confirmed/confirmation, recover/recovery,
// advance/advancing/advancement, book/booked/booking, select/selected/selection.
const INFLECTION = "(?:s|es|ed|d|ing|ion|ions|ation|ations|ment|ments|al|y)?";

function inflected(stem) {
  const base = stem.length >= 6 && stem.endsWith("e")
    // advance → advancing, create → creation, archive → archival
    ? `${stem.slice(0, -1)}e?`
    // cancel → cancellation, submit → submitted
    : /[bdglmnprt]$/.test(stem) ? `${stem}${stem.slice(-1)}?` : stem;
  return `${base}${INFLECTION}`;
}

// FINITE VERB FORMS — the inflections that can only be a verb. "cancelled" is something someone
// did; "cancellation" is a thing that can be named, described or displayed.
const FINITE = "(?:s|es|ed|d)?";
const finite = (stem) => `${/[bdglmnprt]$/.test(stem) ? `${stem}${stem.slice(-1)}?` : stem}${FINITE}`;

// A stem whose own -ing/-ion form NAMES THE RECORD rather than the act: a booking, a reservation,
// a placement. Position cannot separate those — "booking wizard" and "lookup form" are both nouns
// heading a target phrase and only one of them is an interaction — so for these stems the finite
// verb forms alone express the intent, and the nominal forms are what they are: a record's name.
const familyPattern = (stems, recordStems, inflect) => new RegExp(
  `^(?:${[...stems.map(inflect), ...recordStems.map(finite)].join("|")})$`, "i",
);
const phrasePattern = (phrases) => (phrases.length
  ? new RegExp(`^(?:${phrases.join("|")})$`, "i") : null);

/** The families, in the order their intents are reported. */
const FAMILIES = [
  { intent: ACTION_INTENT.SELECTION, stems: ["select", "choose", "chose", "pick"] },
  { intent: ACTION_INTENT.INPUT, stems: ["enter", "type", "fill", "provide", "complete", "supply", "edit"] },
  { intent: ACTION_INTENT.REVIEW, stems: ["review", "summary", "summarise", "summarize"] },
  {
    intent: ACTION_INTENT.CONFIRM,
    // "submission" is an irregular nominal no suffix rule reaches, so it is named.
    stems: ["confirm", "submit", "submission", "save", "update", "archive", "delete"],
    // "booking", "reservation", "placement", "creation" and "removal" name records and results,
    // never the act of committing one.
    recordStems: ["book", "reserve", "place", "create", "remove"],
  },
  { intent: ACTION_INTENT.CANCEL, stems: ["cancel"] },
  {
    intent: ACTION_INTENT.RECOVER,
    stems: ["reload", "refresh", "recover", "restore"],
  },
  {
    intent: ACTION_INTENT.LOOKUP,
    stems: ["lookup", "find", "search", "retrieve"],
    phrases: ["look(?:s|ed|ing)?\\s?up"],
    // A lookup NAMES THE ACT even as a noun: a "booking reference lookup" is the control you look a
    // record up with, where a "confirmation panel" is a surface that displays the result of one. So
    // this family's nominal forms identify a control inside a target, and the others' do not.
    actNoun: true,
  },
  { intent: ACTION_INTENT.ADVANCE, stems: ["advance", "proceed", "continue"], phrases: ["moves? on", "goes? on", "go on"] },
  { intent: ACTION_INTENT.START, stems: ["start", "begin", "open", "launch", "create", "initiate", "commence", "enter"] },
  { intent: ACTION_INTENT.NAVIGATE, stems: ["open", "navigate", "visit"], phrases: ["go to"] },
  { intent: ACTION_INTENT.ACTIVATE, stems: ["click", "press", "tap", "use", "next", "back", "continue"] },
].map((family) => ({
  ...family,
  // A clause may name its act with a nominal ("confirmation of the order"); a control's name may
  // not ("the confirmation panel" is a surface).
  token: familyPattern(family.stems, family.recordStems || [], inflected),
  finiteToken: family.actNoun
    ? familyPattern(family.stems, family.recordStems || [], inflected)
    : familyPattern(family.stems, family.recordStems || [], finite),
  phrase: phrasePattern(family.phrases || []),
}));

// A word after one of these is being used as a verb: "and submit", "choose to cancel".
const VERB_PRECEDERS = new Set(["and", "then", "to", "or", "also", "please", "now", "finally", "afterwards"]);
// Transparent between a commit verb and what it commits: "confirm the cancellation".
const DETERMINERS = new Set(["a", "an", "the", "this", "that", "these", "those", "my", "your", "its",
  "their", "our", "any"]);

const tokensOf = (phrase) => String(phrase || "").toLowerCase().match(/[a-z][a-z'-]*/g) || [];

function matchesAt(tokens, index, mode) {
  const token = tokens[index];
  const bigram = index + 1 < tokens.length ? `${token} ${tokens[index + 1]}` : null;
  return FAMILIES.filter((family) => (mode === "clause" ? family.token : family.finiteToken).test(token)
    || (family.phrase && (family.phrase.test(token) || (bigram && family.phrase.test(bigram)))));
}

/**
 * The canonical intents one phrase performs, with their positions.
 *
 * Two kinds of phrase, read differently because they are different grammar:
 *
 *   CLAUSE (a step's action) — "confirm cancellation", "reload the page". Verb-first, and its act
 *   may be named by a nominal ("cancellation of the order").
 *
 *   NOUN PHRASE (a step's target) — "lookup form", "confirm booking control", "confirmation
 *   panel", "booking reference lookup". It names a control, so only a FINITE VERB form expresses
 *   an interaction — except for the families whose nominal IS the act (a lookup), which name a
 *   control from any position in the phrase. That is the whole difference between the booking
 *   reference lookup (a control you look a record up with) and the confirmation panel (a surface
 *   that displays the result of a commit).
 */
export function phraseIntentMatches(phrase, mode = "clause") {
  const tokens = tokensOf(phrase);
  const counted = new Array(tokens.length).fill(null);
  const results = [];
  for (let index = 0; index < tokens.length; index += 1) {
    let families = matchesAt(tokens, index, mode);
    if (!families.length) continue;
    const previous = tokens[index - 1];
    let position = null;
    if (index === 0) position = "verb";
    else if (VERB_PRECEDERS.has(previous)) position = "verb";
    else {
      // What a commit verb commits refines that commit: "confirm cancellation" is a cancellation.
      // Determiners are transparent; anything else (an adjective, another noun) is not, which is
      // what keeps "a valid confirmed booking reference" from reading as a commit.
      let back = index - 1;
      while (back >= 0 && DETERMINERS.has(tokens[back])) back -= 1;
      if (back >= 0 && (counted[back] || []).includes(ACTION_INTENT.CONFIRM)) position = "commit_object";
    }
    if (!position && mode === "noun_phrase" && families.some((family) => family.actNoun)) {
      // The head of a control's name may be the act itself: "booking reference lookup".
      families = families.filter((family) => family.actNoun);
      position = "control_name";
    }
    if (!position) continue;
    const intents = families.map((family) => family.intent);
    counted[index] = intents;
    results.push({ token: tokens[index], index, position, intents });
  }
  // "choose to cancel the booking", "choose to archive the lead" — an infinitive after a chooser
  // is choosing an ACTION, not a value. Reading it as a value selection makes the derivation
  // invent a field out of the verb, and the driver then hunts for an option group called
  // "archive" that no correct application has. The step's real intent is the verb that follows.
  const followedByAnInfinitiveAction = (match) => tokens[match.index + 1] === "to"
    && results.some((other) => other.index === match.index + 2
      && other.intents.some((intent) => intent !== ACTION_INTENT.SELECTION));
  return results
    .map((match) => (match.intents.includes(ACTION_INTENT.SELECTION) && followedByAnInfinitiveAction(match)
      ? { ...match, intents: match.intents.filter((intent) => intent !== ACTION_INTENT.SELECTION) }
      : match))
    .filter((match) => match.intents.length);
}

// A step's action is a clause; its target names a control — unless the target is a ROUTE, which is
// an address rather than anything a visitor does. A live contract targeted "/book" and the commit
// test matched the path segment, so opening the booking flow derived a booking commit.
const isRoute = (phrase) => /^\s*\//.test(String(phrase || ""));
const PHRASES = (step) => [
  [step?.action, "clause"],
  ...(isRoute(step?.target) ? [] : [[step?.target, "noun_phrase"]]),
];

/** Canonical interaction intents for one contracted step. Ownership is decided elsewhere. */
export function actionIntents(step) {
  const found = new Set();
  for (const [phrase, mode] of PHRASES(step)) {
    for (const match of phraseIntentMatches(phrase, mode)) {
      for (const intent of match.intents) found.add(intent);
    }
  }
  // "make a date, slot, and party-size selection" is a composite selection clause. `selection`
  // is correctly a noun there, but `make` makes that noun the act; without this canonical form a
  // step whose structured `operates` named three chooser fields was reduced to navigation only.
  if (/\bmake\b[\s\S]*\bselections?\b/i.test(String(step?.action || ""))) {
    found.add(ACTION_INTENT.SELECTION);
  }
  // Authentication is not durable-record recovery by itself. Only an explicit return to an
  // existing session ("sign in again" / "sign back in") carries recovery intent; treating every
  // first sign-in as recovery invented a durable read before the journey's first record existed.
  if (/\b(?:sign|log)(?:s|ed|ing)?(?:\s*-\s*|\s+)in\s+again\b|\b(?:sign|log)(?:s|ed|ing)?\s+back\s+in\b/i
    .test(String(step?.action || ""))) {
    found.add(ACTION_INTENT.RECOVER);
  }
  return found;
}

/** Does this step express `intent` at all? */
export function hasActionIntent(step, intent) {
  return actionIntents(step).has(intent);
}

/**
 * Does the prose COMMENCE something — a commencement verb taking an object?
 *
 * Necessary but never sufficient for flow entry: the caller adds the structural conditions (the
 * step writes no contracted value of its own, and the journey goes on to drive contracted
 * controls). "the created order is displayed" names no object of a commencement verb in verb
 * position and never reaches those conditions in the first place.
 */
export function commencesSomething(step) {
  return PHRASES(step).some(([phrase, mode]) => {
    const tokens = tokensOf(phrase);
    return phraseIntentMatches(phrase, mode).some((match) => match.position === "verb"
      && match.intents.includes(ACTION_INTENT.START)
      && tokens.slice(match.index + 1).some((token) => !DETERMINERS.has(token)));
  });
}

/** Does the prose PROGRESS an established flow ("advance to…", "continue to payment")? */
export function progressesSomething(step) {
  return PHRASES(step).some(([phrase, mode]) => phraseIntentMatches(phrase, mode)
    .some((match) => match.position === "verb" && match.intents.includes(ACTION_INTENT.ADVANCE)));
}
