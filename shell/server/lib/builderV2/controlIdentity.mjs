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
