// Shared semantic-identity vocabulary for interactive controls.
//
// Two subsystems used to answer "is this the control the contract meant?" with two separate
// implementations: interactionContract.fieldAliases/nameMatches (static, AST over JSX) and
// journeyVerifier.controlAliases/candidatesFor (live, Playwright locators). They could — and
// did — disagree, so a candidate could be rejected statically for a control the browser would
// have found perfectly well.
//
// This module owns the vocabulary both use. The browser remains the authority on whether a
// control can actually be driven; static analysis may only warn.

const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const words = (value) => String(value || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
const unique = (values) => [...new Set(values.filter(Boolean))];

/**
 * The ARIA roles Thrallo's journey verifier will actually try when it looks for something to
 * ACT on. Any scaffold primitive advertised to the model must resolve to one of these, or the
 * generated control is correct and undriveable at the same time — which is exactly what a live
 * qualification proved when useSemanticSelection emitted role="radio" onto a <button>.
 *
 * journeyVerifier locates with these; a drift test asserts the scaffold primitives conform.
 */
export const DRIVEABLE_ACTION_ROLES = Object.freeze(["button", "link", "tab"]);

/** Attributes the platform accepts as observable selected state on an actionable control. */
export const SELECTED_STATE_ATTRIBUTES = Object.freeze(["aria-pressed", "aria-selected", "aria-checked", "checked"]);

/** Words that identify no control on their own. */
export const IDENTITY_STOP_WORDS = Object.freeze(new Set([
  "select", "choose", "pick", "enter", "provide", "complete", "click", "press", "submit",
  // "choose to cancel the booking" derives a selection whose field is the bare verb `cancel`.
  // It sits with confirm and submit for the same reason: it names an action, never a field.
  "confirm", "cancel", "review", "show", "display", "open", "page", "form", "details", "available",
  "guest", "visitor", "the", "and", "then", "with", "from", "into",
]));

/**
 * WHAT A FIELD MEANS — one definition, shared by control identity, alias generation and value
 * generation. Nothing else may re-decide it.
 *
 * A paid qualification died here. `semanticAliases("guestName")` returned
 * ["guest Name","name","party size","guests","people"], because `/guest/` sat in the party-size
 * branch alongside `party` and `quantity`. On a screen whose party size was an `<input
 * type="number">`, the guest's NAME, EMAIL and PHONE all resolved to that one spinbutton;
 * `valueFor` — which re-guessed meaning with its own `/guests?/` regex — generated "2" for
 * guestName; and the contact step was reported undriveable against an application that was never
 * given the chance to show its contact fields.
 *
 * The rule that prevents the whole family of that bug: a concept comes from a field's TOKENS, read
 * right to left, never from a substring of the whole name. `guestName` ends in `name`; `guestCount`
 * ends in `count`. "guest" QUALIFIES a concept — whose name, whose count — it never is one.
 */
const CONCEPT_BY_TOKEN = new Map([
  ["email", "email"], ["mail", "email"],
  ["phone", "phone"], ["telephone", "phone"], ["mobile", "phone"], ["tel", "phone"],
  ["name", "name"], ["firstname", "name"], ["lastname", "name"], ["fullname", "name"], ["surname", "name"],
  ["date", "date"], ["day", "date"],
  ["slot", "slot"], ["time", "slot"],
  ["password", "password"], ["passcode", "password"],
  ["postcode", "postcode"], ["postalcode", "postcode"], ["zip", "postcode"],
  // Quantities. A count is a count whether it counts people or items; who it counts is decided
  // separately, below, because only a count OF PEOPLE answers to "party size".
  ["count", "count"], ["quantity", "count"], ["qty", "count"], ["size", "count"],
  ["number", "count"], ["total", "count"], ["seats", "count"], ["pax", "count"],
  ["guests", "count"], ["people", "count"], ["adults", "count"], ["children", "count"],
  ["attendees", "count"], ["persons", "count"],
]);

// Tokens that say WHO, not WHAT. They may qualify a concept; they can never supply one.
const PERSON_TOKENS = new Set(["guest", "guests", "customer", "customers", "visitor", "visitors",
  "attendee", "attendees", "person", "persons", "people", "party", "adult", "adults", "child",
  "children", "diner", "diners", "passenger", "passengers", "patient", "patients", "member", "members"]);

// A trailing identifier suffix names the same concept as the field it hangs off: `slotId` is a slot.
const IDENTIFIER_TOKENS = new Set(["id", "ids", "uuid", "key"]);

const fieldTokens = (field) => String(field || "")
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z]+/g) || [];

/**
 * The concept this field denotes, or null when it denotes nothing this platform knows about.
 * Read right to left so the HEAD noun decides: `numberOfGuests` is a count, `guestName` is a name.
 */
export function semanticConcept(field) {
  const tokens = fieldTokens(field);
  while (tokens.length > 1 && IDENTIFIER_TOKENS.has(tokens.at(-1))) tokens.pop();
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const concept = CONCEPT_BY_TOKEN.get(tokens[index]);
    if (concept) return concept;
  }
  return null;
}

/** Does this field count PEOPLE? Only such a count answers to "party size" and its synonyms. */
export function countsPeople(field) {
  if (semanticConcept(field) !== "count") return false;
  return fieldTokens(field).some((token) => PERSON_TOKENS.has(token));
}

const CONCEPT_ALIASES = new Map([
  ["email", ["email"]],
  ["phone", ["phone", "telephone"]],
  ["name", ["name"]],
  ["date", ["date", "day"]],
  ["slot", ["slot", "time"]],
]);

/**
 * Human-equivalent names for one logical field. Deliberately generous: a contract saying
 * `guestEmail` must match a control labelled "Email", and vice versa. Generous about SYNONYMS of
 * the field's concept, never about a different concept that happens to share a word with it.
 */
export function semanticAliases(field) {
  const raw = String(field || "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (!raw) return [];
  const concept = semanticConcept(field);
  const aliases = [raw, ...(CONCEPT_ALIASES.get(concept) || [])];
  if (countsPeople(field)) aliases.push("party size", "guests", "people");
  return unique(aliases.map((value) => value.trim()));
}

/** Collapse a field name to the concept it denotes, so two spellings do not become two controls. */
export function semanticKey(name) {
  if (countsPeople(name)) return "partySize";
  const concept = semanticConcept(name);
  // A count of things rather than people keeps its own identity: an item count and a party size
  // are both counts and are emphatically not the same control.
  if (concept && concept !== "count") return concept;
  return normalized(name);
}

/**
 * How a selectable GROUP announces which contracted field it drives, in preference order.
 *
 * A live qualification graded a booking flow by driving the DATE options three times: once for
 * the date, then again for the slot and again for the party size. Nothing was wrong with the
 * app — the driver picked its group by comparing the step's prose to the group's rendered text,
 * and the date options happened to echo the words "selected … visually highlighted", so they
 * out-matched the real slot and party groups. Both wrong steps then "passed", because moving
 * selection WITHIN the wrong group is still a selection transition.
 *
 * Identity therefore may not come from rendered prose, and may not come from DOM position
 * (a group's ordinal changes the moment a step reveals or hides a sibling). These are the
 * observable, position-independent identities a group can carry, all of them standard HTML/ARIA
 * that `useSemanticSelection` already emits.
 */
export const SELECTION_GROUP_IDENTITY_SOURCES = Object.freeze([
  "option name attribute", "group aria-label", "group aria-labelledby", "fieldset legend",
  "option id prefix",
]);

/**
 * Vocabulary for a control that ADVANCES a multi-step flow. Deliberately generic: a checkout,
 * an onboarding sequence, a CRM creation wizard and a booking flow all use these words, and no
 * domain noun appears here. A driver may activate such a control only to reach a contracted
 * control it cannot yet see, and only when the activation demonstrably advances the flow.
 */
export const ADVANCE_ACTION_PATTERN = /^\s*(next|continue|proceed|go on|forward|next step|continue to [\w\s]+|proceed to [\w\s]+)\s*(→|>|»)?\s*$/i;

/**
 * Does any of a control's observable identities correspond to any wanted name?
 * Shared by the static lint and the browser driver so both agree on what "named for" means.
 */
export function identityMatches(identities, wanted) {
  const wantedWords = (Array.isArray(wanted) ? wanted : [wanted])
    .flatMap((name) => words(String(name || "").replace(/([a-z])([A-Z])/g, "$1 $2")))
    .filter((word) => !IDENTITY_STOP_WORDS.has(word));
  if (!wantedWords.length) return true;
  const actual = (Array.isArray(identities) ? identities : [identities]).map(normalized);
  return wantedWords.some((word) => actual.some((name) => name.includes(normalized(word))));
}
