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
  "confirm", "review", "show", "display", "open", "page", "form", "details", "available",
  "guest", "visitor", "the", "and", "then", "with", "from", "into",
]));

/**
 * Human-equivalent names for one logical field. Deliberately generous: a contract saying
 * `guestEmail` must match a control labelled "Email", and vice versa.
 */
export function semanticAliases(field) {
  const raw = String(field || "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (!raw) return [];
  const aliases = [raw];
  const lower = raw.toLowerCase();
  if (/name/.test(lower)) aliases.push("name");
  if (/email/.test(lower)) aliases.push("email");
  if (/phone|telephone|mobile/.test(lower)) aliases.push("phone", "telephone");
  if (/slot|time/.test(lower)) aliases.push("slot", "time");
  if (/date|day/.test(lower)) aliases.push("date", "day");
  if (/party|quantity|guest|people|adult|child/.test(lower)) aliases.push("party size", "guests", "people");
  return unique(aliases.map((value) => value.trim()));
}

/** Collapse a field name to the concept it denotes, so two spellings do not become two controls. */
export function semanticKey(name) {
  const value = normalized(name);
  if (/date|day/.test(value)) return "date";
  if (/slot|time/.test(value)) return "slot";
  if (/party|quantity|people|guestcount|adult|child/.test(value)) return "partySize";
  if (/email/.test(value)) return "email";
  if (/phone|telephone|mobile/.test(value)) return "phone";
  if (/name/.test(value)) return "name";
  return value;
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
