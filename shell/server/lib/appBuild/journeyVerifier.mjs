// Drive the contract's journeys against the real preview.
//
// PR6 of docs/PIPELINE-REDESIGN.md. The existing verifier proves the app LOADS — console clean,
// network clean, a generic signup flow. It cannot prove the app DOES what was agreed, because
// until PR4 nothing had written down what was agreed. Now something has.
//
// This drives each journey step in a real browser against the real preview and the real backend.
// The distinction from the generic verifier matters: "the page rendered" and "a booking made in
// this browser is still there after a reload" are different claims, and only the second one is
// what the customer asked for.
//
// An undriveable step remains diagnostically distinct from a behavioural failure, but it cannot
// qualify contracted quality. Generated controls must expose semantic HTML/ARIA that the same
// driver can identify before browser verification begins.

import { createRequire } from "node:module";
import {
  appAuthRateLimitDefect,
  seedVerificationVisitorStorage,
  verificationToken,
} from "./verificationIdentity.mjs";

import {
  ADVANCE_ACTION_PATTERN, DRIVEABLE_ACTION_ROLES, IDENTITY_STOP_WORDS, semanticAliases,
  semanticConcept, semanticKey,
} from "../builderV2/controlIdentity.mjs";
import {
  ADVANCE_ACTION_ID, browserPlan, controlIdFor, deriveVerificationManifest,
} from "../builderV2/verificationManifest.mjs";
import {
  LEGACY_RICH_VERIFIER_POLICY,
  MINIMAL_CONTRACT_VERIFIER_POLICY,
  VERIFICATION_RESULT_CLASS,
  isMinimalContractVerifier,
  verificationVerdict,
} from "./verifierPolicy.mjs";
import { isKeyboardFocusOnlyStep } from "../builderV2/interactionSemantics.mjs";

const requireCjs = createRequire(import.meta.url);

const STEP_TIMEOUT_MS = 15_000;

// How many times ONE step may advance a step-gated flow to reach its contracted control. A
// contracted step is one step: needing more than a couple of transitions to reach its own
// control means the contract and the application disagree, which is a finding, not something to
// grind through.
const MAX_FLOW_ADVANCES = 2;

// ── finding things a human would find ─────────────────────────────────────────────────────────
//
// The contract describes intent in English ("select a service and an available slot"), not
// selectors. These turn that into the handful of things a person would actually try.

function wordsOf(text) {
  return String(text || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
}

const NOISE = new Set(["the", "and", "for", "with", "that", "then", "from", "into", "this", "their",
  "click", "clicks", "select", "selects", "enter", "enters", "type", "types", "open", "opens",
  "page", "button", "field", "form", "user", "visitor", "shown", "show", "shows", "displayed",
  "display", "visible", "appears", "appear", "should", "must", "step", "value", "input",
  "area", "message", "when", "have", "has", "had", "been", "being", "empty-state",
  "main", "heading", "naming", "labelled", "labeled", "empty", "state", "says", "reads",
  "hero", "above", "again"]);

// QUALITATIVE design language is guidance for the builder, not an assertion for this driver.
// "a polished confirmation state" failed a live build because the page did not contain the word
// "polished" — an adjective no reasonable app renders. Observable requirements become literal
// assertions; adjectives never do.
export const QUALITATIVE = new Set(["polished", "premium", "modern", "professional", "beautiful",
  "elegant", "stylish", "seamless", "delightful", "clean", "sleek", "attractive", "lovely",
  "gorgeous", "immersive", "impressive", "refined", "sophisticated", "crisp", "tasteful",
  "distinctive"]);

function keywords(text, limit = 6) {
  return [...new Set(wordsOf(text))].filter((w) => !NOISE.has(w) && !QUALITATIVE.has(w)).slice(0, limit);
}

/**
 * The EXACT words this verifier will look for on the page after a step runs — exported so the
 * builder can be told them BEFORE generation. The booking build failed steps like "choose an
 * available date" because the page never showed "selected"/"highlighted": the builder had read
 * the same expectation prose but nothing told it the check is literal visible text. One source
 * of truth for both sides ends that split.
 */
export function expectationKeywords(expect) {
  return keywords(expect, 5);
}

// Reset/clear outcomes are expressed through control state, not positive page copy. Requiring
// the words from "the search box is blank" to remain visible after the action inverts the
// contract: a correct clear operation removes the value and often removes the empty-state copy.
// Keep this deliberately structural and narrow. Ordinary actions still need their contracted
// visible outcome; only explicit reset language may be answered by a real non-default -> default
// transition in a native form control.
export function expectationRequestsControlReset(expect) {
  return /\b(?:is|becomes?|remains?)\s+blank\b|\bclear(?:s|ed|ing)?\b|\breset(?:s|ted|ting)?\b|\breturn(?:s|ed|ing)?\s+to\b/i
    .test(String(expect || ""));
}

export function controlResetTransition(before = [], after = []) {
  const afterByKey = new Map((after || []).map((row) => [row.key, row]));
  const changes = [];
  for (const prior of before || []) {
    const next = afterByKey.get(prior.key);
    if (!next) continue;
    if (["text", "search", "email", "url", "tel", "number", "textarea"].includes(prior.type)
      && String(prior.value || "").length > 0 && String(next.value || "").length === 0) {
      changes.push({ key: prior.key, transition: "value_cleared" });
    } else if (prior.type === "select" && Number(prior.selectedIndex) > 0
      && Number(next.selectedIndex) === 0) {
      changes.push({ key: prior.key, transition: "selection_reset" });
    } else if (["checkbox", "radio"].includes(prior.type) && prior.checked === true && next.checked === false) {
      changes.push({ key: prior.key, transition: "selection_cleared" });
    }
  }
  return { checked: (before || []).length > 0, ok: changes.length > 0, changes };
}

async function visibleControlState(page) {
  return page.evaluate(() => {
    const ordinals = new Map();
    return [...document.querySelectorAll("input, textarea, select")]
      .filter((element) => element.offsetParent !== null && !element.disabled)
      .map((element, index) => {
      const label = element.labels?.[0]?.innerText || "";
      const identity = element.getAttribute("data-thrallo-control") || element.id
        || element.getAttribute("name") || element.getAttribute("aria-label") || label || `control-${index}`;
      const tag = element.tagName.toLowerCase();
      const baseKey = `${tag}:${identity}`;
      const ordinal = ordinals.get(baseKey) || 0;
      ordinals.set(baseKey, ordinal + 1);
      const nativeType = tag === "select" ? "select" : tag === "textarea" ? "textarea"
        : String(element.getAttribute("type") || "text").toLowerCase();
      return {
        key: `${baseKey}:${ordinal}`,
        type: nativeType,
        value: "value" in element ? String(element.value || "") : "",
        checked: "checked" in element ? Boolean(element.checked) : false,
        selectedIndex: tag === "select" ? element.selectedIndex : -1,
      };
      });
  }).catch(() => []);
}

/**
 * Every locator worth trying for one described control — REAL CONTROLS for every word
 * before prose for any word. The old per-word ordering let getByText("number") (the
 * "Phone number" label) shadow the real "Increase adults" button on a live booking run:
 * clicking static text drove nothing and the step failed a working counter.
 */
function candidatesFor(page, description) {
  const words = keywords(description, 4);
  const roles = [];
  const labels = [];
  const prose = [];
  for (const word of words) {
    const pattern = new RegExp(word, "i");
    // One shared contract with the scaffold primitives (builderV2/controlIdentity.mjs): what
    // this driver will try to act on is what those primitives must resolve to.
    for (const role of DRIVEABLE_ACTION_ROLES) roles.push(page.getByRole(role, { name: pattern }));
    labels.push(page.getByLabel(pattern));
    labels.push(page.getByPlaceholder(pattern));
    prose.push(page.getByText(pattern));
  }
  return [...roles, ...labels, ...prose];
}

async function firstVisible(locators, deadline) {
  for (const locator of locators) {
    if (Date.now() > deadline) return null;
    try {
      const count = await locator.count();
      for (let i = 0; i < Math.min(count, 3); i += 1) {
        const nth = locator.nth(i);
        if (await nth.isVisible().catch(() => false)) return nth;
      }
    } catch { /* a malformed locator is not a defect in the app */ }
  }
  return null;
}

async function waitForFirstVisible(locators, deadline) {
  do {
    const visible = await firstVisible(locators, deadline);
    if (visible) return visible;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() <= deadline);
  return null;
}

// Plausible values for a field, chosen from its own label so validation is satisfied rather than
// tripped — the point is to complete the journey, not to fuzz it.
/**
 * A value that VIOLATES the rule the field's own type states, or null when the contract gives no
 * rule to violate.
 *
 * Only rules the platform can actually derive: an email must contain a local part, an @ and a
 * domain; a number field must hold a number; a required field must be non-empty. Anything else —
 * a phone format, a card rule, a domain-specific constraint — is NOT invented here. Returning
 * null makes the step report an unsupported validation intent instead of typing rubbish and
 * calling whatever happens next a verdict.
 */
export function invalidValueFor(label, inputTypes = []) {
  const types = (inputTypes || []).map((type) => String(type).toLowerCase());
  const concept = semanticConcept(label);
  const words = String(label || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  if (types.includes("email") || concept === "email") return "not-an-email";
  if (/^(size|scale|dimensions?)$/.test(words.trim())) return "0, 0, 0";
  if (types.includes("number") || types.includes("spinbutton") || concept === "count") return "not-a-number";
  return null;
}

// When several real controls share one verb (for example "Duplicate asset" in a history panel
// and "Duplicate selected object" in an editor), DOM order is not intent. Rank visible action
// controls by how much of the step's target + action their accessible name actually identifies.
// This stays generic: the contract supplies the vocabulary and the page supplies the names.
async function bestVisibleAction(page, description, deadline) {
  const wanted = keywords(description, 8);
  if (!wanted.length || Date.now() > deadline) return null;
  const controls = page.locator([
    "button:visible", "a[href]:visible", "input[type=button]:visible", "input[type=submit]:visible",
    '[role="button"]:visible', '[role="link"]:visible', '[role="menuitem"]:visible', '[role="tab"]:visible',
  ].join(","));
  const count = Math.min(await controls.count().catch(() => 0), 80);
  let best = null;
  for (let index = 0; index < count; index += 1) {
    if (Date.now() > deadline) break;
    const locator = controls.nth(index);
    if (await locator.isDisabled().catch(() => true)) continue;
    const name = await locator.evaluate((el) => el.getAttribute("aria-label")
      || el.getAttribute("title") || el.value || el.innerText || "").catch(() => "");
    const normalized = String(name).toLowerCase();
    const matched = wanted.filter((word) => normalized.includes(word));
    if (!matched.length) continue;
    const score = matched.length * 10 + (matched.length === wanted.length ? 5 : 0)
      - Math.max(0, wordsOf(normalized).length - matched.length);
    if (!best || score > best.score) best = { locator, score };
  }
  return best?.locator || null;
}

/**
 * The value to type into a contracted field.
 *
 * Meaning comes from the SAME authority that decides which control the field is
 * (controlIdentity.semanticConcept). It used to be re-derived here with a second, looser set of
 * regexes, and the two disagreed in production: `/guests?/` matched `guestName`, so a guest's name
 * was typed as the number "2". Two definitions of what a field means is one too many.
 */
function valueFor(label, marker) {
  const words = String(label || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  if (/^(size|scale|dimensions?)$/.test(words.trim())) return "2, 2, 2";
  if (/\bposition\b/.test(words)) return "1, 2, 3";
  if (/\brotation\b/.test(words)) return "0, 15, 0";
  if (/\btransparency\b/.test(words)) return "0.2";
  if (/\bcolou?r\b/.test(words)) return "#38bdf8";
  if (/\banchored\b|\bcollide\b/.test(words)) return "true";
  switch (semanticConcept(label)) {
    case "email": return `journey+${marker}@thrallo.dev`;
    case "phone": return "07700900123";
    case "password": return `Jv-${marker}!9a`;
    case "date": return new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    case "slot": return "10:00";
    case "count": return "2";
    case "postcode": return "SW1A 1AA";
    default:
      return `Journey ${marker}`;
  }
}

/**
 * Build a browser fixture from the contract and the control's own declared constraints.
 *
 * A generic marker is useful only when it is VALID. A live concept-generator contract said
 * "enter the default ... idea" and rendered that default as its placeholder, while the verifier
 * ignored both and typed a shorter marker that deliberately left Generate disabled. Prefer the
 * visible default/example the contract names; otherwise satisfy native length constraints without
 * inventing domain behaviour. Native validity is checked again after filling below.
 */
function numericFixtureFor(facts, currentValue) {
  const current = Number(currentValue);
  const minimum = facts?.min === null || facts?.min === undefined || facts?.min === ""
    ? Number.NEGATIVE_INFINITY : Number(facts.min);
  const maximum = facts?.max === null || facts?.max === undefined || facts?.max === ""
    ? Number.POSITIVE_INFINITY : Number(facts.max);
  const declaredStep = facts?.step === "any" || facts?.step === null || facts?.step === undefined
    || facts?.step === "" ? 1 : Number(facts.step);
  const step = Number.isFinite(declaredStep) && declaredStep > 0 ? declaredStep : 1;
  const base = Number.isFinite(current) ? current : (Number.isFinite(minimum) ? minimum : 1);
  let candidate = base + step <= maximum ? base + step : base - step;
  if (candidate < minimum || candidate > maximum || !Number.isFinite(candidate)) candidate = base;
  // Avoid binary floating-point tails such as 0.6000000000000001 becoming an invalid browser
  // fixture. Adding one valid declared step to an already-valid value keeps the same step lattice.
  return String(Number(candidate.toFixed(10)));
}

export function verificationFixtureFor(flow, marker) {
  if (flow?.control?.verificationValue === undefined || flow?.control?.verificationValue === null) return null;
  return String(flow.control.verificationValue)
    .replaceAll("{{runMarker}}", String(marker))
    .replaceAll("{{testEmail}}", `journey+${marker}@thrallo.dev`);
}

function fixtureValueFor(flow, facts, marker, currentValue = "") {
  const contracted = verificationFixtureFor(flow, marker);
  if (contracted !== null) return contracted;
  const logicalField = flow.control.logicalField || flow.valueWritten || flow.control.accessibleName;
  const declaredType = String(flow.control.valueType || "").toLowerCase();
  const browserType = String(facts?.type || "text").toLowerCase();
  if (["number", "integer"].includes(declaredType) || browserType === "number") {
    return numericFixtureFor(facts, currentValue);
  }
  let value = valueFor(logicalField, marker);
  const instruction = `${flow.action || ""} ${flow.semanticPurpose || ""} ${flow.observable || ""}`;
  const placeholder = String(facts?.placeholder || "").trim();
  const type = String(facts?.type || "text").toLowerCase();
  const textual = facts?.tag === "textarea" || ["text", "search", "url"].includes(type);
  const placeholderWords = new Set(wordsOf(placeholder));
  const instructionOverlap = keywords(instruction, 12).filter((word) => placeholderWords.has(word));
  if (textual && placeholder && (/(?:^|\b)(default|example|sample|preset|template)(?:\b|$)/i.test(instruction)
      || instructionOverlap.length >= 2)) {
    value = placeholder;
  }

  const minLength = Number.isInteger(facts?.minLength) && facts.minLength >= 0 ? facts.minLength : 0;
  const maxLength = Number.isInteger(facts?.maxLength) && facts.maxLength >= 0 ? facts.maxLength : null;
  if (minLength && value.length < minLength) {
    const suffix = ` ${String(logicalField || "input").replace(/([a-z])([A-Z])/g, "$1 $2")} ${marker}`;
    while (value.length < minLength) value += suffix;
  }
  if (maxLength !== null && value.length > maxLength) value = value.slice(0, maxLength);
  return value;
}

function replaceLastDigit(value, direction = 1) {
  const match = String(value || "").match(/\d(?!.*\d)/);
  if (!match) return null;
  const next = (Number(match[0]) + direction + 10) % 10;
  return `${value.slice(0, match.index)}${next}${value.slice(match.index + 1)}`;
}

/**
 * Candidate values for proving that a pre-populated control can make a real, valid transition.
 *
 * Marker-derived fixtures cover names, email addresses, passwords and normal text. Some semantic
 * fixtures are intentionally stable, though (phone/date/time/postcode and 3D properties), so an
 * edit journey would otherwise restore the original value and make its following Save a no-op.
 * These small alternatives remain inside the same declared browser type; native validity below
 * is the final authority, so a pattern/min/max-constrained field cannot accept a guessed value.
 */
function distinctFixtureCandidates(flow, facts, marker, currentValue) {
  const logicalField = flow.control.logicalField || flow.valueWritten || flow.control.accessibleName;
  const browserType = String(facts?.type || "text").toLowerCase();
  const concept = semanticConcept(logicalField);
  const candidates = [1, 2, 3].map((suffix) => fixtureValueFor(
    flow, facts, `${marker}${suffix}`, currentValue,
  ));
  const addDigitAlternates = () => {
    candidates.push(replaceLastDigit(currentValue, 1), replaceLastDigit(currentValue, -1));
  };
  if (concept === "phone" || concept === "postcode" || concept === "count"
      || ["tel", "date", "time", "datetime-local", "month", "week", "color"].includes(browserType)) {
    addDigitAlternates();
  }
  const words = String(logicalField || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  if (/^(size|scale|dimensions?)$/.test(words.trim()) || /\b(position|rotation|transparency|colou?r)\b/.test(words)) {
    addDigitAlternates();
  }
  if (/\banchored\b|\bcollide\b/.test(words)) {
    candidates.push(String(currentValue).toLowerCase() === "true" ? "false" : "true");
  }
  return unique(candidates).filter((candidate) => candidate !== currentValue);
}

const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const unique = (values) => [...new Set(values.filter(Boolean))];

/** A control "name" made only of words that identify no control — a verb, not a field. */
function identifiesNothing(name) {
  const words = String(name || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z][a-z0-9-]{1,}/g) || [];
  return words.length > 0 && words.every((word) => IDENTITY_STOP_WORDS.has(word));
}

function controlAliases(control) {
  // Same vocabulary the static interaction lint uses (builderV2/controlIdentity.mjs), so the
  // two never disagree about which control a contracted field refers to.
  return unique([
    ...(control?.accessibleNames || []),
    control?.accessibleName,
    control?.logicalField,
    ...semanticAliases(control?.logicalField || control?.accessibleName),
  ]);
}

export function interactionFlowsFor(contract, journeyId, stepIndex, kind = null) {
  let flows = (contract?.interactionContract?.flows || []).filter((flow) => flow.journeyId === journeyId
    && flow.stepIndex === stepIndex && (!kind || flow.kind === kind));
  const step = contract?.journeys?.find((journey) => journey.id === journeyId)?.steps?.[stepIndex] || null;
  const selections = flows.filter((flow) => flow.kind === "selection" && flow.control);
  // Some historical contracts expanded every field READ by one object-selection step into a
  // separate selectable group (modelSpec, objectGraph, objectId, parentObjectId). Those are not
  // four user choices: the step declares one selection and then observes several fields on the
  // selected object. Keep the one selection the step explicitly reads when it is unambiguous; if
  // the stale controls omit that one structured identity, reconstruct only that identity.
  if (selections.length > 1 && (step?.reads || []).length > 0 && !(step?.operates || []).length) {
    const reads = new Set((step?.reads || []).map(semanticKey));
    const declared = selections.filter((flow) => reads.has(semanticKey(
      flow.control.logicalField || flow.control.accessibleName,
    )));
    if (declared.length <= 1) {
      let keep = declared[0] || null;
      // A second historical shape derived the wrong candidate fields altogether. The step still
      // carries one exact structured read (for example objectId), which is the selected identity,
      // while its stale flows name assetName/partCount. Reconstruct that ONE opaque control rather
      // than falling back to prose and clicking an unrelated button group.
      if (!keep && step.reads.length === 1) {
        const logicalField = String(step.reads[0]).split(".").pop();
        const template = selections[0];
        keep = {
          ...template,
          valueWritten: logicalField,
          control: {
            ...template.control,
            purpose: logicalField,
            logicalField,
            machineId: controlIdFor(logicalField),
            accessibleName: semanticAliases(logicalField)[0],
            accessibleNames: semanticAliases(logicalField),
          },
        };
      }
      flows = [...flows.filter((flow) => flow.kind !== "selection"), ...(keep ? [keep] : [])];
    }
  }
  const canonical = (flow) => `${flow.kind}:${semanticKey(
    flow.control?.logicalField || flow.control?.accessibleName || flow.valueWritten || flow.kind,
  )}`;
  const seen = new Set();
  return flows.filter((flow) => {
    const key = canonical(flow);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A contract may ask the browser to observe a surface that is already present: view a list,
// inspect a summary, compare a result. These steps have no control or state transition to drive;
// their whole assertion is whether the named evidence is visible. Treating them as actions makes
// a correct static surface `identity_absent`, then sends app repair after a control the contract
// never declared. The structural guards keep this narrow: any route, write, control, or declared
// interaction remains an action and retains the normal freshness/driveability rules.
const OBSERVATION_ACTION_PATTERN = /^\s*(?:view|inspect|observe|see|read|review|compare|check|verify|wait\s+for)\b/i;
const ACTION_FLOW_KINDS = new Set([
  "flow_start", "flow_advance", "selection", "input", "mutation", "cancellation", "lookup",
  "action", "navigation", "recovery",
]);

export function isObservationOnlyStep(step = {}, interactionFlows = [], {
  verifierPolicy = LEGACY_RICH_VERIFIER_POLICY,
} = {}) {
  const action = String(step.action || "");
  if (!OBSERVATION_ACTION_PATTERN.test(action)) return false;
  if (/^\s*\//.test(String(step.target || ""))) return false;
  if ((step.operates || []).length > 0) return false;
  if (/\b(?:click|type|enter|select|choose|submit|save|create|update|delete|navigate|drag|move|press|tap)\b/i
    .test(action)) return false;
  if (isMinimalContractVerifier(verifierPolicy)) return true;
  return !(interactionFlows || []).some((flow) => flow.control
    || (flow.writes || []).length > 0
    || ACTION_FLOW_KINDS.has(flow.kind));
}

// A collection member action legitimately renders the same exact contracted control once per
// item. It is safe to choose the first stable DOM match only when the step explicitly asks for one
// member and the required outcome proves that another member remains. Ordinary repeated commits
// stay ambiguity-strict.
export function requestsSingleCollectionMemberAction(step = {}) {
  const action = String(step?.action || "");
  const expect = String(step?.expect || "");
  return /\b(?:remove|delete|archive|dismiss|detach)\s+(?:one|a|an)\b/i.test(action)
    && /\b(?:remain(?:s|ed|ing)?|remaining|other|rest)\b/i.test(expect);
}

const REMOVAL_ACTION_PATTERN = /\b(?:remove|delete|archive|dismiss|detach)\b/i;
const REMOVAL_RESULT_PATTERN = /\s+(?:is|was|has\s+been|gets?)\s+(?:removed|deleted|archived|dismissed|detached)\b/i;
const POSITIVE_POSTCONDITION_PATTERN = /\b(?:and|while|but|however|yet)\b/i;
const POSTCONDITION_COLLECTION_PATTERN = /^(?:the\s+)?(.{1,80}?\b(?:list|collection|grid|table|area|section|panel))\s+(?:shows?|displays?|contains?|includes?)\b/i;
const POSTCONDITION_EMPTY_COLLECTION_PATTERN = /^(?:the\s+)?(.{1,80}?)\s+empty(?:-|\s+)(?:[\w-]+\s+){0,2}(?:state|message)\b/i;
const ACTION_COLLECTION_REMOVAL_PATTERN = /\b(?:remove|delete|archive|dismiss|detach)\s+(?:the\s+)?(.{1,80}?)\s+from\s+(?:the\s+)?(.{1,80}?\b(?:list|collection|grid|table|area|section|panel))\b/i;

// A successful removal is observable as absence, so the removed entity's name cannot also be
// required as positive page copy. Keep this structural and deliberately narrow: the action must
// be removal-shaped, the expectation must name the entity before the removal result, and a
// separate positive postcondition must remain authoritative after the connector.
export function removalExpectationSpec({ action = "", expect = "" } = {}) {
  if (!REMOVAL_ACTION_PATTERN.test(String(action))) return null;
  const text = String(expect || "").trim();
  const result = REMOVAL_RESULT_PATTERN.exec(text);
  if (!result || result.index < 1) {
    const actionRemoval = ACTION_COLLECTION_REMOVAL_PATTERN.exec(String(action));
    const emptyStateRequired = /\bempty\b.{0,40}\b(?:state|message|text)\b/i.test(text);
    if (!actionRemoval || !emptyStateRequired) return null;
    const rawTarget = actionRemoval[1].trim();
    const collection = actionRemoval[2].trim();
    if (!rawTarget || rawTarget.split(/\s+/).length > 8 || !keywords(rawTarget, 5).length
      || !keywords(collection, 5).length || !keywords(text, 5).length) return null;
    return { target: rawTarget, collection, postcondition: text,
      emptyStateRequired: true, remainingMemberRequired: false };
  }
  const rawTarget = text.slice(0, result.index).replace(/^(?:then\s+)?(?:the\s+)?/i, "").trim();
  if (!rawTarget || rawTarget.split(/\s+/).length > 8) return null;
  const suffix = text.slice(result.index + result[0].length);
  const connector = POSITIVE_POSTCONDITION_PATTERN.exec(suffix);
  if (!connector) return null;
  const explicitCollection = suffix.slice(0, connector.index)
    .replace(/^\s*(?:from|in|out\s+of)\s+(?:the\s+)?/i, "").trim();
  const postcondition = suffix.slice(connector.index + connector[0].length).trim();
  const collection = explicitCollection
    || POSTCONDITION_COLLECTION_PATTERN.exec(postcondition)?.[1]?.trim()
    || POSTCONDITION_EMPTY_COLLECTION_PATTERN.exec(postcondition)?.[1]?.trim()
    || "";
  if (!collection || !postcondition || !keywords(rawTarget, 5).length
    || !keywords(collection, 5).length || !keywords(postcondition, 5).length) return null;
  return { target: rawTarget, collection, postcondition,
    emptyStateRequired: /\bempty\b.{0,40}\b(?:state|message)\b/i.test(postcondition),
    remainingMemberRequired: /\b(?:remain(?:s|ed|ing)?|remaining|other|rest)\b/i.test(postcondition) };
}

export function selectedRemovalExpectationSpec(spec, selections = []) {
  if (!spec || !/^(?:the\s+)?(?:(?:same|selected|favourited|saved)\s+)?(?:software|item|product|entry|record|favourite|favorite)$/i
    .test(String(spec.target || "").trim())) return spec;
  const selectedText = String(selections.at(-1) || "");
  const target = selectedText.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || "";
  if (!target || target.split(/\s+/).length > 8 || !keywords(target, 5).length) return spec;
  return { ...spec, target };
}

const COLLECTION_MEMBERSHIP_PATTERN = /\b(.{1,80}?\b(?:list|collection|grid|table))\s+(?:contains?|includes?|shows?|displays?)\s+(.+)$/i;
const COLLECTION_STRUCTURE_WORDS = new Set(["list", "collection", "grid", "table", "area", "section"]);
const COLLECTION_MEMBER_CLAUSE_PATTERN = /\b(?:only|all|any|matching|matches?|filtered|filter(?:s|ed|ing)?|selected|search|query|not|without|excludes?)\b/i;
const COLLECTION_POSTCONDITION_CLAUSE_PATTERN = /\b(?:count|total|message|state|status)\b|\b(?:is|are|was|were|remains?|becomes?|equals?)\b/i;

// A named collection containing several named members is stronger than global page copy. The
// same subjects may legitimately remain visible in catalogue cards or a detail panel, so page-
// wide keyword presence cannot prove that the collection retained every member.
export function collectionMembershipExpectationSpec(expect = "") {
  const match = COLLECTION_MEMBERSHIP_PATTERN.exec(String(expect || "").trim());
  if (!match) return null;
  const collection = match[1].replace(/^(?:then\s+)?(?:the\s+)?/i, "").trim();
  const clauses = match[2].split(/\s*(?:,|\band\b)\s*/i)
    .map((member, index) => {
      const normalized = member.replace(/[.;:]$/, "").trim();
      return index === 0 ? normalized.replace(/^both\s+/i, "") : normalized;
    }).filter(Boolean);
  const postconditionIndex = clauses.findIndex((clause, index) => index >= 1
    && COLLECTION_POSTCONDITION_CLAUSE_PATTERN.test(clause));
  const members = postconditionIndex < 0 ? clauses : clauses.slice(0, postconditionIndex);
  if (!keywords(collection, 5).length || members.length < 2 || members.length > 5
    || members.some((member) => member.split(/\s+/).length > 6 || !keywords(member, 5).length
      || COLLECTION_MEMBER_CLAUSE_PATTERN.test(member))) return null;
  return { collection, members };
}

const SELECTED_COLLECTION_MEMBER_PATTERN = /\b(.{1,80}?\b(?:list|collection|grid|table))\s+(?:contains?|includes?|shows?|displays?)\b/i;

export function selectedCollectionExpectationSpec(expect = "", selections = []) {
  const text = String(expect || "").trim();
  if (!/\bselected\b.{0,48}\b(?:name|item|software|product)\b/i.test(text)) return null;
  const match = SELECTED_COLLECTION_MEMBER_PATTERN.exec(text);
  if (!match) return null;
  const selectedText = String(selections.at(-1) || "");
  const member = selectedText.split(/\r?\n/).map((value) => value.trim()).find(Boolean) || "";
  if (!member || member.split(/\s+/).length > 8 || !keywords(member, 5).length) return null;
  const collection = match[1].replace(/^(?:then\s+)?(?:the\s+)?/i, "").trim();
  if (!keywords(collection, 5).length) return null;
  return { collection, members: [member] };
}

async function collectionMembershipState(page, spec) {
  const topics = keywords(spec.collection, 5).filter((word) => !COLLECTION_STRUCTURE_WORDS.has(word));
  return page.evaluate(({ wantedMembers, collectionTopics }) => {
    const normalized = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
    const members = wantedMembers.map(normalized);
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
        && rect.width > 0 && rect.height > 0;
    };
    const regions = [...document.querySelectorAll(
      "section, aside, [role='region'], [role='list'], ul, ol, table",
    )].filter(visible).map((element) => {
      const text = normalized(element.innerText);
      const heading = element.querySelector("h1, h2, h3, h4, legend")?.innerText || "";
      const identity = normalized(`${element.getAttribute("aria-label") || ""} ${heading}`);
      const present = members.filter((member) => text.includes(member));
      return {
        element, textLength: text.length, present,
        identityTopicMatches: collectionTopics.filter((topic) => identity.includes(topic)).length,
        textTopicMatches: collectionTopics.filter((topic) => text.includes(topic)).length,
      };
    }).filter((row) => collectionTopics.length === 0 || row.textTopicMatches > 0)
      .sort((left, right) => right.identityTopicMatches - left.identityTopicMatches
        || left.textLength - right.textLength || right.textTopicMatches - left.textTopicMatches);
    const region = regions[0] || null;
    const present = region?.present || [];
    return {
      checked: true,
      ok: Boolean(region) && present.length === members.length,
      regionFound: Boolean(region),
      present: wantedMembers.filter((_member, index) => present.includes(members[index])),
      missing: wantedMembers.filter((_member, index) => !present.includes(members[index])),
    };
  }, { wantedMembers: spec.members, collectionTopics: topics })
    .catch(() => ({ checked: false, ok: false, regionFound: false, present: [], missing: spec.members }));
}

async function collectionActionMemberState(page, spec, control, { mark = false, marker = null } = {}) {
  const markerValue = mark ? `removal-${Date.now()}-${Math.random().toString(16).slice(2)}` : marker;
  return page.evaluate(({ wantedTarget, collectionTopics, machineId, accessibleNames, markerValue, requireTarget }) => {
    const normalized = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
    const targetText = normalized(wantedTarget);
    const names = new Set((accessibleNames || []).map(normalized).filter(Boolean));
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
        && rect.width > 0 && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll(
      "[data-thrallo-action], button, a, input[type='button'], input[type='submit'], [role='button'], [role='link']",
    )].filter((element) => {
      if (!visible(element)) return false;
      if (machineId && element.getAttribute("data-thrallo-action") === machineId) return true;
      const identity = normalized(element.getAttribute("aria-label") || element.getAttribute("title")
        || element.getAttribute("name") || element.innerText || element.value);
      return names.has(identity);
    });
    const markedRegion = markerValue
      ? document.querySelector(`[data-thrallo-verifier-removal-region="${markerValue}"]`) : null;
    const memberRows = [];
    for (const candidate of candidates) {
      let member = candidate.parentElement;
      for (let depth = 0; member && depth < 7 && ![document.body, document.documentElement].includes(member);
        depth += 1, member = member.parentElement) {
        if (!normalized(member.innerText).includes(targetText)) continue;
        const identity = normalized(candidate.getAttribute("aria-label") || candidate.getAttribute("title")
          || candidate.getAttribute("name") || candidate.innerText || candidate.value);
        memberRows.push({ member,
          controlTopicMatches: collectionTopics.filter((topic) => identity.includes(topic)).length });
        break;
      }
    }
    const uniqueMembers = [...new Set(memberRows.map((row) => row.member))];
    // Collection terms can be distributed across an unrelated broad wrapper (for example one
    // word in introductory copy and another in a contextual control). Scope the measurement to
    // the smallest semantic region containing the target member whose own contracted control
    // best names the collection. Otherwise the wrapper continues to contain the target in a
    // detail panel after a correct list removal and produces a false functional failure.
    const regions = [...document.querySelectorAll(
      "section, aside, [role='region'], [role='list'], ul, ol, table",
    )].filter(visible).map((element) => {
      const text = normalized(element.innerText);
      const heading = element.querySelector("h1, h2, h3, h4, legend")?.innerText || "";
      const identity = normalized(`${element.getAttribute("aria-label") || ""} ${heading}`);
      const relatedMembers = memberRows.filter((row) => element.contains(row.member));
      return { element, text, targetPresent: text.includes(targetText),
        topicMatches: collectionTopics.filter((topic) => text.includes(topic)).length,
        identityTopicMatches: collectionTopics.filter((topic) => identity.includes(topic)).length,
        controlTopicMatches: relatedMembers.length
          ? Math.max(...relatedMembers.map((row) => row.controlTopicMatches)) : -1 };
    }).filter((row) => row.topicMatches > 0 && (!requireTarget || row.targetPresent))
      .sort((left, right) => right.controlTopicMatches - left.controlTopicMatches
        || right.identityTopicMatches - left.identityTopicMatches
        || left.text.length - right.text.length || right.topicMatches - left.topicMatches);
    const collectionRegion = markedRegion || regions[0]?.element || null;
    let regionMarked = false;
    if (markerValue && (collectionRegion || uniqueMembers[0])) {
      const scopedMember = memberRows.filter((row) => !collectionRegion || collectionRegion.contains(row.member))
        .sort((left, right) => right.controlTopicMatches - left.controlTopicMatches
          || normalized(left.member.innerText).length - normalized(right.member.innerText).length)[0]?.member
        || [...uniqueMembers].sort((left, right) => normalized(left.innerText).length
          - normalized(right.innerText).length)[0];
      scopedMember?.setAttribute("data-thrallo-verifier-removal-member", markerValue);
      const region = collectionRegion || scopedMember.closest("section, aside, [role='region']")
        || scopedMember.parentElement?.parentElement || scopedMember.parentElement;
      if (region && ![document.body, document.documentElement].includes(region)) {
        region.setAttribute("data-thrallo-verifier-removal-region", markerValue);
        regionMarked = true;
      }
    }
    return {
      checked: true,
      matchedControlCount: candidates.length,
      targetMemberCount: collectionRegion
        ? Number(normalized(collectionRegion.innerText).includes(targetText)) : uniqueMembers.length,
      targetPresent: collectionRegion
        ? normalized(collectionRegion.innerText).includes(targetText) : uniqueMembers.length > 0,
      marker: markerValue,
      regionMarked,
    };
  }, {
    wantedTarget: spec.target,
    collectionTopics: keywords(spec.collection, 5),
    machineId: control?.machineId || null,
    accessibleNames: unique([control?.accessibleName, ...(control?.accessibleNames || [])]),
    markerValue,
    requireTarget: mark,
  }).catch(() => ({ checked: false, matchedControlCount: 0, targetMemberCount: 0,
    targetPresent: false, marker: markerValue, regionMarked: false }));
}

async function removalPositiveState(page, spec, baseline, current) {
  const wanted = keywords(spec.postcondition, 5);
  const found = [];
  for (const word of wanted) {
    if (await anyVisibleTextMatch(page, word)) found.push(word);
  }
  const keywordEvidence = wanted.length > 0 && found.length / wanted.length >= 0.5;
  const remainingMemberEvidence = spec.remainingMemberRequired
    && current.matchedControlCount > 0
    && current.matchedControlCount < baseline.matchedControlCount;
  let emptyStateEvidence = null;
  if (spec.emptyStateRequired) {
    emptyStateEvidence = await page.evaluate(({ marker, topics }) => {
      const normalized = (value) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0
          && rect.width > 0 && rect.height > 0;
      };
      const markedRegion = marker
        ? document.querySelector(`[data-thrallo-verifier-removal-region="${marker}"]`) : null;
      const root = markedRegion || document.body;
      const candidates = [...root.querySelectorAll(
        "[data-empty-state], [data-state='empty'], [class*='empty' i], [id*='empty' i], [role='status'], p",
      )].filter(visible);
      for (const candidate of candidates) {
        const text = normalized(candidate.innerText || candidate.textContent);
        if (!text) continue;
        const structural = candidate.hasAttribute("data-empty-state")
          || candidate.getAttribute("data-state") === "empty"
          || /empty/i.test(`${candidate.id} ${candidate.className}`);
        const semantic = /\b(?:no|none|nothing)\b.{0,80}\b(?:yet|saved|items?|entries|results?|records?|available|selected)\b/i.test(text);
        const topicMatch = (topics || []).some((topic) => text.includes(topic));
        if ((structural || semantic) && (Boolean(markedRegion) || topicMatch)) {
          return { visible: true, text: text.slice(0, 160), inMarkedRegion: Boolean(markedRegion) };
        }
      }
      return { visible: false, text: null, inMarkedRegion: Boolean(markedRegion) };
    }, { marker: baseline.marker, topics: wanted }).catch(() => ({ visible: false, text: null }));
  }
  return {
    ok: keywordEvidence || remainingMemberEvidence || emptyStateEvidence?.visible === true,
    wanted, found, keywordEvidence, remainingMemberEvidence,
    emptyStateEvidence: emptyStateEvidence || { visible: false, text: null },
  };
}

/** Resolve an explicitly contracted responsive viewport without depending on one exact verb. */
export function viewportForAction(action) {
  const value = String(action || "");
  if (!/\bviewport\b/i.test(value)) return null;
  if (/\btablet\b/i.test(value)) return { width: 820, height: 900, kind: "tablet" };
  if (/\b(?:mobile|narrow)\b/i.test(value)) return { width: 390, height: 844, kind: "mobile" };
  if (/\b(?:desktop|wide)\b/i.test(value)) return { width: 1280, height: 900, kind: "desktop" };
  return null;
}

async function renderedFormControls(page) {
  return page.locator("input, textarea, select").evaluateAll((elements) => elements.map((el) => {
    const labels = el.labels ? [...el.labels].map((label) => (label.innerText || "").trim()).filter(Boolean) : [];
    const labelledBy = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.innerText?.trim()).filter(Boolean);
    return {
      tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || el.tagName.toLowerCase(),
      name: el.getAttribute("name"), id: el.id || null, placeholder: el.getAttribute("placeholder"),
      ariaLabel: el.getAttribute("aria-label"), accessibleName: el.getAttribute("aria-label")
        || labelledBy.join(" ") || labels.join(" ") || null,
      role: el.getAttribute("role"), visible: el.offsetParent !== null,
      disabled: Boolean(el.disabled), readOnly: Boolean(el.readOnly), value: String(el.value || ""),
    };
  })).catch(() => []);
}

function contractedLocators(page, control) {
  const aliases = controlAliases(control);
  const rows = [];
  const loose = [];
  // MACHINE IDENTITY FIRST. An opaque id the generated app computed from the control's own name
  // says "this is the control the contract meant" without the browser layer knowing, or being
  // able to know, what the control MEANS. Everything below it is fallback for controls that carry
  // no identity — legacy trees, V1, and anything the model hand-wrote.
  if (control?.machineId) {
    rows.push({ description: `machine=${control.machineId}`, machine: true,
      locator: page.locator(`[data-thrallo-control="${control.machineId}"]`) });
  }
  for (const alias of aliases) {
    const pattern = new RegExp(`^\\s*${escapeRegex(alias)}\\s*$`, "i");
    for (const role of control?.roles || ["textbox"]) {
      rows.push({ description: `role=${role} name=${alias}`, locator: page.getByRole(role, { name: pattern }) });
    }
    rows.push({ description: `label=${alias}`, locator: page.getByLabel(pattern) });
    rows.push({ description: `name=${alias}`, locator: page.locator(`[name="${String(alias).replace(/["\\]/g, "\\$&")}"]`) });
    rows.push({ description: `id=${alias}`, locator: page.locator(`[id="${String(alias).replace(/["\\]/g, "\\$&")}"]`) });
    rows.push({ description: `placeholder=${alias}`, locator: page.getByPlaceholder(pattern) });
    // Exact-match only rejected a field a person would call correctly named: a contract field
    // `reference` against a form labelled "Booking reference" was reported missing, and the whole
    // lookup journey went undriveable. A WHOLE-WORD containment match is tried only after every
    // exact match has failed, so a precisely named control still wins.
    const worded = new RegExp(`(^|\\W)${escapeRegex(alias)}(\\W|$)`, "i");
    for (const role of control?.roles || ["textbox"]) {
      loose.push({ description: `role=${role} name~${alias}`, locator: page.getByRole(role, { name: worded }) });
    }
    loose.push({ description: `label~${alias}`, locator: page.getByLabel(worded) });
    loose.push({ description: `placeholder~${alias}`, locator: page.getByPlaceholder(worded) });
  }
  return [...rows, ...loose];
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])", "input:not([disabled]):not([type=hidden])", "select:not([disabled])",
  "textarea:not([disabled])", "a[href]", "[contenteditable=true]", "[tabindex]:not([tabindex='-1'])",
  "[role=button]", "[role=radio]", "[role=option]", "[role=combobox]",
].join(",");

async function firstFocusableContractedControl(page, control) {
  for (const attempt of contractedLocators(page, control)) {
    const count = Math.min(await attempt.locator.count().catch(() => 0), 24);
    for (let index = 0; index < count; index += 1) {
      const matched = attempt.locator.nth(index);
      if (!(await matched.isVisible().catch(() => false))) continue;
      const direct = await matched.evaluate((element) => {
        const native = element.matches("button,input,select,textarea,a[href],[contenteditable=true]");
        const semantic = element.matches("[role=button],[role=radio],[role=option],[role=combobox]");
        return (native || semantic || element.tabIndex >= 0) && !element.disabled
          && element.getAttribute("aria-disabled") !== "true";
      }).catch(() => false);
      if (direct) return { locator: matched, matchedBy: attempt.description };
      const descendants = matched.locator(FOCUSABLE_SELECTOR);
      const descendantsCount = Math.min(await descendants.count().catch(() => 0), 24);
      for (let childIndex = 0; childIndex < descendantsCount; childIndex += 1) {
        const candidate = descendants.nth(childIndex);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const usable = await candidate.evaluate((element) => !element.disabled
          && element.getAttribute("aria-disabled") !== "true" && element.tabIndex >= 0).catch(() => false);
        if (usable) return { locator: candidate, matchedBy: `${attempt.description}:descendant` };
      }
    }
  }
  return null;
}

async function keyboardFocusState(locator) {
  return locator.evaluate((element) => {
    const labelledBy = (element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.innerText || "").filter(Boolean);
    const labels = element.labels ? [...element.labels].map((label) => label.innerText || "").filter(Boolean) : [];
    const group = element.closest("[role=group],[role=radiogroup],[role=listbox],fieldset");
    const groupLabelledBy = (group?.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.innerText || "").filter(Boolean);
    const accessibleName = element.getAttribute("aria-label") || labelledBy.join(" ") || labels.join(" ")
      || element.getAttribute("alt") || element.getAttribute("title") || element.innerText || "";
    const groupName = group?.getAttribute("aria-label") || groupLabelledBy.join(" ")
      || (group?.tagName === "FIELDSET" ? group.querySelector("legend")?.innerText : "") || "";
    const style = getComputedStyle(element);
    const outlineVisible = !["none", "hidden"].includes(style.outlineStyle)
      && Number.parseFloat(style.outlineWidth || "0") > 0
      && style.outlineColor !== "rgba(0, 0, 0, 0)";
    const shadowVisible = Boolean(style.boxShadow && style.boxShadow !== "none");
    return {
      active: document.activeElement === element,
      focusVisible: element.matches(":focus-visible"),
      accessibleName: String(accessibleName).trim(),
      groupName: String(groupName).trim(),
      outlineVisible,
      shadowVisible,
      focusStyle: {
        outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor, boxShadow: style.boxShadow,
        borderColor: style.borderColor, backgroundColor: style.backgroundColor,
      },
      valueState: {
        value: "value" in element ? String(element.value ?? "") : null,
        checked: "checked" in element ? Boolean(element.checked) : null,
        ariaPressed: element.getAttribute("aria-pressed"),
        ariaSelected: element.getAttribute("aria-selected"),
        dataState: element.getAttribute("data-state"),
      },
    };
  }).catch(() => null);
}

async function driveKeyboardFocus(page, flow, step) {
  const target = await firstFocusableContractedControl(page, flow?.control);
  if (!target) return {
    drove: false, status: "undriveable",
    detail: `no focusable control matched contracted field ${flow?.control?.logicalField || "unknown"}`,
    controlEvidence: { contractedField: flow?.control?.logicalField || null,
      requiredControl: { kind: "focus", reason: "not_reliably_located" } },
  };
  const before = await keyboardFocusState(target.locator);
  try {
    await target.locator.focus({ timeout: 5_000 });
    // Return to the exact identity through keyboard traversal. The final input modality is a real
    // Tab key, so :focus-visible and the rendered keyboard indicator are both testable.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    await page.waitForTimeout(50);
  } catch {
    return { drove: false, status: "undriveable", detail: "the contracted control could not receive keyboard focus",
      controlEvidence: { contractedField: flow?.control?.logicalField || null, matchedBy: target.matchedBy } };
  }
  const after = await keyboardFocusState(target.locator);
  const aliases = new Set(controlAliases(flow?.control).flatMap((alias) => wordsOf(alias)));
  const specificNameTokens = wordsOf(after?.accessibleName || "")
    .filter((word) => !aliases.has(word) && !IDENTITY_STOP_WORDS.has(word));
  const specificityRequired = /\baccessible name\b.*\bidentif(?:y|ies)\b/i.test(String(step?.expect || ""));
  const stateChanged = JSON.stringify(before?.valueState) !== JSON.stringify(after?.valueState);
  const styleChanged = JSON.stringify(before?.focusStyle) !== JSON.stringify(after?.focusStyle);
  const visibleIndicator = Boolean(after?.focusVisible
    && (after.outlineVisible || after.shadowVisible || styleChanged));
  const evidence = {
    contractedField: flow?.control?.logicalField || null,
    matchedBy: target.matchedBy,
    active: Boolean(after?.active),
    focusVisible: Boolean(after?.focusVisible),
    visibleIndicator,
    accessibleName: after?.accessibleName || null,
    groupName: after?.groupName || null,
    nameSpecificity: !specificityRequired || specificNameTokens.length > 0,
    mutationObserved: stateChanged,
    valueStateBefore: before?.valueState || null,
    valueStateAfter: after?.valueState || null,
  };
  if (!after?.active) return { drove: true, status: "fail",
    detail: "keyboard traversal did not leave focus on the contracted control", controlEvidence: evidence };
  if (!after.accessibleName) return { drove: true, status: "fail",
    detail: "the focused contracted control has no accessible name", controlEvidence: evidence };
  if (specificityRequired && !specificNameTokens.length) return { drove: true, status: "fail",
    detail: "the focused control's accessible name does not identify its item", controlEvidence: evidence };
  if (!visibleIndicator) return { drove: true, status: "fail",
    detail: "the focused contracted control has no visible keyboard focus indicator", controlEvidence: evidence };
  if (stateChanged) return { drove: true, status: "fail",
    detail: "moving keyboard focus changed the contracted control value", controlEvidence: evidence };
  return { drove: true, status: "pass", detail: "keyboard focus, visible focus indication, and accessible naming are proven",
    controlEvidence: evidence };
}

/** Drive only the fields the machine-readable contract assigns to this step. */
async function fillContractedFields(page, flows, marker, {
  verifierPolicy = LEGACY_RICH_VERIFIER_POLICY,
} = {}) {
  const minimal = isMinimalContractVerifier(verifierPolicy);
  const evidence = { attemptedLocators: [], renderedControls: await renderedFormControls(page), fields: [] };
  const filled = [];
  for (const flow of flows) {
    const logicalField = flow.control.logicalField || flow.valueWritten || flow.control.accessibleName;
    const attempts = contractedLocators(page, flow.control);
    evidence.attemptedLocators.push(...attempts.map((row) => `${logicalField}:${row.description}`));
    let field = null;
    let matchedBy = null;
    let ambiguous = null;
    for (const attempt of attempts) {
      const count = Math.min(await attempt.locator.count().catch(() => 0), 3);
      const visible = [];
      for (let index = 0; index < count; index += 1) {
        const candidate = attempt.locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
      }
      if (!visible.length) continue;
      // AN IDENTITY THAT MATCHES TWICE IS NOT AN IDENTITY. Taking the first visible match would be
      // the positional guessing this architecture exists to remove — and it would be silent. Two
      // controls that must both be driveable need distinct names (the scaffold accepts a `scope`,
      // so `intake.notes` and `review.notes` are distinct); until then, this is reported.
      if ((minimal || attempt.machine) && visible.length > 1) {
        ambiguous = { description: attempt.description, matches: visible.length };
        if (!minimal) break;
        continue;
      }
      [field] = visible;
      matchedBy = attempt.description;
      break;
    }
    const contractedFixture = verificationFixtureFor(flow, marker);
    const fieldEvidence = { field: logicalField, expectedStateOwner: flow.stateOwner, matchedBy,
      fixtureAuthority: contractedFixture === null ? "native_or_generated" : "contract",
      accessibleNames: flow.control.accessibleNames || [flow.control.accessibleName],
      ...(ambiguous && field ? { identityAdvisory: {
        code: "ambiguous_identity", matchedBy: ambiguous.description, matches: ambiguous.matches,
      } } : {}) };
    if (ambiguous && !field) {
      evidence.fields.push({ ...fieldEvidence, status: "ambiguous_identity", matchedBy: ambiguous.description,
        detail: `${ambiguous.matches} visible controls share the machine identity ${flow.control.machineId} — `
          + "give each one a distinct scoped name so the contract can address them separately" });
      continue;
    }
    if (!field) {
      evidence.fields.push({ ...fieldEvidence, status: "missing" });
      continue;
    }
    if (minimal && flow.control.requiresVerificationFixture && contractedFixture === null) {
      evidence.fields.push({ ...fieldEvidence, status: "fixture_unavailable",
        detail: "the contract requires an explicit domain-valid verification fixture" });
      continue;
    }
    const disabled = await field.isDisabled().catch(() => true);
    const editable = await field.isEditable().catch(() => false);
    const facts = await field.evaluate((el) => ({
      tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "text", name: el.getAttribute("name"),
      id: el.id || null, placeholder: el.getAttribute("placeholder"), ariaLabel: el.getAttribute("aria-label"),
      labels: el.labels ? [...el.labels].map((label) => (label.innerText || "").trim()).filter(Boolean) : [],
      disabled: Boolean(el.disabled), readOnly: Boolean(el.readOnly), required: Boolean(el.required),
      minLength: Number.isInteger(el.minLength) && el.minLength >= 0 ? el.minLength : null,
      maxLength: Number.isInteger(el.maxLength) && el.maxLength >= 0 ? el.maxLength : null,
      pattern: el.getAttribute("pattern"),
      min: el.getAttribute("min"), max: el.getAttribute("max"), step: el.getAttribute("step"),
    })).catch(() => null);
    if (disabled || !editable) {
      evidence.fields.push({ ...fieldEvidence, status: "not_editable", facts });
      continue;
    }
    // A contracted negative-validation step must enter something the application should REJECT.
    // When no rule can be derived from the contract, the field is left alone and the step reports
    // an unsupported intent rather than guessing at a rule the contract never stated.
    const currentValue = await field.inputValue().catch(() => "");
    if (facts?.tag === "select") {
      const options = await field.locator("option").evaluateAll((elements) => elements.map((option, index) => ({
        index, value: String(option.value), label: String(option.textContent || "").trim(),
        disabled: Boolean(option.disabled),
      }))).catch(() => []);
      const available = options.filter((option) => !option.disabled);
      const target = contractedFixture === null
        ? available.find((option) => option.value !== currentValue && option.value !== "")
          || available.find((option) => option.value !== currentValue)
        : available.find((option) => option.value === contractedFixture || option.label === contractedFixture);
      if (!target) {
        evidence.fields.push({ ...fieldEvidence,
          status: contractedFixture === null ? "value_not_accepted" : "fixture_invalid",
          expectedValue: contractedFixture, observedValue: currentValue, previousValue: currentValue,
          facts, availableOptions: available.map((option) => ({ value: option.value, label: option.label })),
          detail: contractedFixture === null
            ? "the native select offers no enabled option that can prove a value transition"
            : "the contracted verification fixture does not match an enabled native option" });
        continue;
      }
      if (minimal && target.value === currentValue) {
        const validity = await field.evaluate((el) => ({ valid: el.checkValidity(),
          message: el.validationMessage || null })).catch(() => ({ valid: true, message: null }));
        const status = validity.valid ? "filled" : "fixture_invalid";
        evidence.fields.push({ ...fieldEvidence, status, expectedValue: target.value,
          selectedLabel: target.label, observedValue: currentValue, previousValue: currentValue,
          alreadyAccepted: true, facts, validityMessage: validity.message });
        if (status === "filled") filled.push(logicalField);
        continue;
      }
      let probeValue = null;
      let probeChanged = false;
      if (target.value === currentValue) {
        const alternate = available.find((option) => option.value !== currentValue);
        if (alternate) {
          await field.selectOption({ value: alternate.value }, { timeout: 3_000 }).catch(() => {});
          probeValue = await field.inputValue().catch(() => currentValue);
          probeChanged = probeValue === alternate.value;
        }
      }
      await field.selectOption({ value: target.value }, { timeout: 3_000 }).catch(() => {});
      const observedValue = await field.inputValue().catch(() => currentValue);
      const validity = await field.evaluate((el) => ({ valid: el.checkValidity(),
        message: el.validationMessage || null })).catch(() => ({ valid: true, message: null }));
      const changed = probeChanged || observedValue !== currentValue;
      const status = observedValue === target.value && changed && validity.valid
        ? "filled" : "value_not_accepted";
      evidence.fields.push({ ...fieldEvidence, status, expectedValue: target.value,
        selectedLabel: target.label, observedValue, previousValue: currentValue,
        ...(probeValue === null ? {} : { probeValue }), facts,
        validityMessage: validity.message });
      if (status === "filled") filled.push(logicalField);
      continue;
    }
    const booleanControl = flow.control.valueType === "boolean" || facts?.type === "checkbox";
    if (booleanControl && flow.control.validity !== "invalid") {
      const before = await field.isChecked().catch(() => false);
      const expected = facts?.required ? true : !before;
      let changed = false;
      if (facts?.required && before) {
        await field.uncheck({ timeout: 3_000 }).then(() => { changed = true; }).catch(() => {});
      }
      await (expected ? field.check({ timeout: 3_000 }) : field.uncheck({ timeout: 3_000 }))
        .then(() => { changed ||= before !== expected; }).catch(() => {});
      const observed = await field.isChecked().catch(() => before);
      const validity = await field.evaluate((el) => ({ valid: el.checkValidity(),
        message: el.validationMessage || null })).catch(() => ({ valid: true, message: null }));
      const status = observed === expected && changed && validity.valid ? "filled" : "value_not_accepted";
      evidence.fields.push({ ...fieldEvidence, status, expectedValue: String(expected),
        observedValue: String(observed), previousValue: String(before), facts,
        validityMessage: validity.message });
      if (status === "filled") filled.push(logicalField);
      continue;
    }
    let value = fixtureValueFor(flow, facts, marker, currentValue);
    if (flow.control.validity === "invalid" && contractedFixture === null) {
      value = invalidValueFor(logicalField, flow.control.inputTypes);
      if (value === null) {
        evidence.fields.push({ ...fieldEvidence, status: "validation_intent_unsupported",
          detail: `the contract asks for an invalid ${logicalField} but states no rule to violate` });
        continue;
      }
    }
    // TYPING WHAT IS ALREADY THERE PROVES NOTHING — AND MUST NOT BE READ AS A DEAD CONTROL.
    //
    // The verdict below requires the value to CHANGE, which is the right protection: a control
    // that ignores input while coincidentally displaying the expected text would otherwise pass.
    // But an EDIT journey re-opens a saved record, so its fields arrive pre-populated, and the
    // fixture value derived from the run marker can equal what the field already holds. The fill
    // is then a no-op, `changed` is false, and a working control is reported `value_not_accepted`
    // — with expectedValue, observedValue and previousValue all three identical in the evidence.
    //
    // So when the field already holds the target, ask a DIFFERENT question. Prefer a distinct,
    // natively valid final fixture so an edit journey makes a real mutation before its Save step.
    // If the field's constraints admit no alternate, clear and restore it as a final driveability
    // probe. A dead controlled input that ignores both writes still fails the unchanged verdict.
    if (minimal && flow.control.validity !== "invalid" && value === currentValue && currentValue !== "") {
      const validity = await field.evaluate((el) => ({ valid: el.checkValidity(),
        message: el.validationMessage || null })).catch(() => ({ valid: true, message: null }));
      const status = validity.valid ? "filled" : "fixture_invalid";
      evidence.fields.push({ ...fieldEvidence, status, expectedValue: value, observedValue: currentValue,
        previousValue: currentValue, alreadyAccepted: true, facts, validityMessage: validity.message });
      if (status === "filled") filled.push(logicalField);
      continue;
    }
    let probeValue = null;
    let probeChanged = false;
    if (flow.control.validity !== "invalid" && value === currentValue && currentValue !== "") {
      for (const candidate of distinctFixtureCandidates(flow, facts, marker, currentValue)) {
        await field.fill(candidate, { timeout: 3_000 }).catch(() => {});
        const observedCandidate = await field.inputValue().catch(() => currentValue);
        const candidateValidity = await field.evaluate((el) => el.checkValidity()).catch(() => false);
        if (observedCandidate === candidate && candidateValidity) {
          value = candidate;
          probeValue = observedCandidate;
          probeChanged = true;
          break;
        }
      }
      if (!probeChanged) {
        await field.fill("", { timeout: 3_000 }).catch(() => {});
        probeValue = await field.inputValue().catch(() => currentValue);
        probeChanged = probeValue !== currentValue;
      }
    }
    await field.fill(value, { timeout: 3_000 }).catch(() => {});
    const observedValue = await field.inputValue().catch(() => "");
    const validity = await field.evaluate((el) => ({ valid: el.checkValidity(),
      message: el.validationMessage || null })).catch(() => ({ valid: true, message: null }));
    const expectsInvalid = flow.control.validity === "invalid";
    const changed = probeChanged || observedValue !== currentValue;
    const status = observedValue !== value || (!minimal && !expectsInvalid && !changed)
      ? "value_not_accepted"
      : (expectsInvalid || validity.valid ? "filled" : "fixture_invalid");
    evidence.fields.push({ ...fieldEvidence, status, expectedValue: value, observedValue,
      previousValue: currentValue, ...(probeValue === null ? {} : { probeValue }), facts,
      validityMessage: validity.message });
    if (status === "filled") filled.push(logicalField);
  }
  evidence.attemptedLocators = unique(evidence.attemptedLocators);
  return { filled, evidence, complete: filled.length === flows.length };
}

/** Fill every visible empty input on the page, so a "enter your details" step can be completed. */
async function fillVisibleForm(page, marker) {
  const filled = [];
  const inputs = page.locator("input:visible, textarea:visible, select:visible");
  const count = Math.min(await inputs.count().catch(() => 0), 25);
  for (let i = 0; i < count; i += 1) {
    const field = inputs.nth(i);
    try {
      const tag = await field.evaluate((el) => el.tagName.toLowerCase());
      const type = (await field.getAttribute("type")) || "text";
      if (["hidden", "submit", "button", "search"].includes(type)) continue;

      if (tag === "select") {
        const options = field.locator("option");
        const optionCount = await options.count();
        // Skip the placeholder option; pick something real.
        if (optionCount > 1) await field.selectOption({ index: 1 }).catch(() => {});
        filled.push("select");
        continue;
      }
      if (type === "checkbox" || type === "radio") {
        if (!(await field.isChecked().catch(() => true))) await field.check({ force: true }).catch(() => {});
        filled.push(type);
        continue;
      }
      if (await field.inputValue().catch(() => "")) continue; // already has a value

      const label = (await field.getAttribute("aria-label"))
        || (await field.getAttribute("placeholder"))
        || (await field.getAttribute("name"))
        || type;
      await field.fill(valueFor(label, marker), { timeout: 3_000 }).catch(() => {});
      filled.push(label);
    } catch { /* one awkward field must not end the journey */ }
  }
  return filled;
}

// ── selection semantics ───────────────────────────────────────────────────────────────────────
//
// Default-selected dates and slots are valid product behaviour: the live modular build
// pre-selected the first date, so the word "selected" existed before the click and the text
// freshness rule refused a perfectly working selector. Selection steps are therefore judged on
// the SEMANTIC transition — the click must MOVE selection to the clicked option and off the
// previous one — read from aria-selected / aria-pressed / checked / data-state / an
// active-selected class, never from static copy.

/**
 * Pure verdict over a selection interaction. `before`/`after` are the option group's states in
 * stable order; `clickedIndex` is the option the driver clicked.
 */
export function selectionTransition({ before = [], after = [], clickedIndex = -1, autoAdvance = null } = {}) {
  const beforeSelected = before.findIndex((o) => o.selected);
  // BRANCH B — the control legitimately unmounted because the selection advanced the flow.
  //
  // A live qualification failed a working app here: clicking a date advanced the wizard, the date
  // buttons unmounted, and that date's slots appeared — exactly what the contract asked for — but
  // this function demanded the clicked option still be on screen. Requiring persistence is an
  // assumption about wizard implementation that no contract states.
  //
  // The branch is deliberately not "the DOM changed, therefore pass". It asks for semantic
  // causality: the control the CONTRACT names next must now be observable, and this step's own
  // contracted outcome must have become visible because of the click. An unrelated screen, or the
  // wrong contracted control, satisfies neither.
  if (clickedIndex >= 0 && before[clickedIndex] && !after.length && autoAdvance) {
    const activated = before[clickedIndex];
    const chosen = activated.label || activated.text || String(activated.value ?? "");
    if (!autoAdvance.nextControl) {
      return { ok: false, reason: "the selection removed its own controls and the contract names no following control, so nothing proves the flow advanced" };
    }
    if (!autoAdvance.nextControlVisible) {
      return { ok: false, reason: `the selection removed its own controls without reaching the contracted next state (${autoAdvance.nextControl})` };
    }
    if (!autoAdvance.expectationMet) {
      return { ok: false, reason: `the flow advanced to ${autoAdvance.nextControl} but the contracted outcome of this step never became visible` };
    }
    return {
      ok: true,
      advanced: true,
      detail: `selection "${String(chosen).slice(0, 40)}" advanced the flow to ${autoAdvance.nextControl}`,
      // The pre-click identity IS the evidence of which option was activated — the element it
      // came from no longer exists. Downstream review/confirmation checks verify this value, which
      // is what catches a flow that advances carrying the wrong choice.
      selectedText: activated.text || chosen,
    };
  }
  if (clickedIndex < 0 || !after[clickedIndex]) {
    return { ok: false, reason: "no clickable option was identified" };
  }
  if (clickedIndex === beforeSelected) {
    return { ok: false, reason: "clicked the already-selected option — no transition to observe" };
  }
  const gained = after[clickedIndex].selected === true;
  const previousCleared = beforeSelected === -1 || after[beforeSelected]?.selected === false;
  if (gained && previousCleared) {
    return {
      ok: true,
      detail: beforeSelected === -1
        ? `selection created on "${(after[clickedIndex].text || "").slice(0, 40)}"`
        : `selection moved from "${(before[beforeSelected].text || "").slice(0, 40)}" to "${(after[clickedIndex].text || "").slice(0, 40)}"`,
      selectedText: after[clickedIndex].text || "",
    };
  }
  if (gained) return { ok: false, reason: "selection did not MOVE — the previous option still shows a selected state" };
  return { ok: false, reason: "the clicked option never gained a selected state (aria/data-state/class all unchanged)" };
}

/**
 * Pure check that a confirmation actually reflects what was selected. Formatting varies, but the
 * NUMBERS in a chosen date or slot ("Sat 21 Jun", "10:30–12:00") survive any rendering; if the
 * selections carried no numbers there is nothing checkable and the check abstains.
 */
export function confirmationReflectsSelections(confirmationText, selections = []) {
  const numbers = [...new Set(selections.flatMap((s) => String(s || "").match(/\d[\d:.]*/g) || []))];
  if (!numbers.length) return { checked: false, ok: true };
  const text = String(confirmationText || "");
  const matched = numbers.find((n) => text.includes(n));
  return matched
    ? { checked: true, ok: true, matched }
    : { checked: true, ok: false, detail: `the confirmation shows none of the selected values (${numbers.slice(0, 5).join(", ")})` };
}

// Group the page's selectable options by parent, tagging each element for later clicks.
async function selectionGroups(page) {
  return page.evaluate(() => {
    const isSelected = (el) => {
      const state = (el.getAttribute("data-state") || "").toLowerCase();
      const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
      return el.getAttribute("aria-selected") === "true"
        || el.getAttribute("aria-pressed") === "true"
        || el.checked === true
        || ["on", "active", "selected", "checked"].includes(state)
        || /(^|[\s_-])(is[-_])?(selected|active)([\s_-]|$)/.test(cls);
    };
    const groups = [];
    let id = 0;
    const isUserPerceivable = (el) => {
      if (!el || el.offsetParent === null) return false;
      const ownRect = el.getBoundingClientRect();
      if (ownRect.width <= 1 || ownRect.height <= 1) return false;
      for (let current = el; current && current !== document.documentElement; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || ["hidden", "collapse"].includes(style.visibility)
          || Number(style.opacity || 1) <= 0.01 || style.contentVisibility === "hidden") return false;
        const clip = String(style.clip || "auto").toLowerCase();
        if (clip !== "auto") {
          const edges = clip.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
          if (edges.length >= 4 && (edges[1] - edges[3] <= 1 || edges[2] - edges[0] <= 1)) return false;
        }
        const clipPath = String(style.clipPath || "none").replace(/\s+/g, "").toLowerCase();
        if (clipPath === "inset(50%)" || clipPath === "inset(100%)") return false;
        if (/hidden|clip/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) {
          const rect = current.getBoundingClientRect();
          if (rect.width <= 1 || rect.height <= 1) return false;
        }
      }
      return true;
    };

    // Native selects are first-class selection controls. The former option collector only knew
    // about button/ARIA option groups, so an identity-bound <select> passed mechanics as "skipped"
    // and then became undriveable in the real journey. Enumerate its enabled native options and
    // preserve the same before/after selected-state proof used for custom option groups.
    for (const select of document.querySelectorAll("select")) {
      if (!isUserPerceivable(select) || select.disabled) continue;
      const options = [...select.options]
        .map((option, domIndex) => ({ option, domIndex }))
        .filter(({ option }) => !option.disabled);
      if (!options.length) continue;
      select.setAttribute("data-thrallo-native-select", String(id));
      const labelledBy = (select.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
        .map((labelId) => document.getElementById(labelId)?.innerText || "");
      const labels = select.labels ? [...select.labels].map((label) => label.innerText || "") : [];
      groups.push({
        groupId: id,
        nativeSelect: true,
        machineId: select.getAttribute("data-thrallo-control") || null,
        identities: [...new Set([
          select.getAttribute("name") || "", select.getAttribute("aria-label") || "",
          select.id || "", ...labelledBy, ...labels,
        ].map((value) => String(value).trim()).filter(Boolean))],
        contextText: `${select.closest("section,fieldset,[role=group]")?.querySelector("h1,h2,h3,h4,legend,[role=heading]")?.innerText || ""} ${select.closest("label")?.innerText || ""}`.slice(0, 400).toLowerCase(),
        options: options.map(({ option, domIndex }, index) => ({
          index, domIndex, text: (option.textContent || option.value || "").trim().slice(0, 80),
          label: option.label || null, value: option.value, selected: option.selected === true,
        })),
      });
      id += 1;
    }

    const candidates = [...document.querySelectorAll(
      '[role="option"],[role="tab"],[role="radio"],[aria-selected],[aria-pressed],[data-state],input[type="radio"],button',
    )].filter((el) => isUserPerceivable(el) && !el.disabled);
    const byParent = new Map();
    for (const el of candidates) {
      if (!el.parentElement) continue;
      // A semantic option group commonly renders cards around each option. Grouping strictly by
      // immediate parent turns four valid options into four one-option "groups", all of which are
      // discarded below. The nearest declared group is the option-set authority; only legacy
      // markup without one falls back to the immediate parent.
      // A repeated card list can be a valid selection surface when the list names the contracted
      // field and its buttons expose selected state (for example aria-pressed). The retained
      // Budget Competitions candidate used exactly that accessible shape. Treat only LABELLED
      // lists as a declared group: an ordinary navigation/list remains ineligible, and the
      // transition proof below still requires the clicked option to gain selected state.
      const parent = el.closest("[role=group],fieldset,[role=radiogroup],[role=listbox],[role=tablist],[role=list][aria-label],[role=list][aria-labelledby]")
        || el.parentElement;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(el);
    }
    // Position-independent identities the group announces about ITSELF. Read from standard
    // HTML/ARIA only, never from prose or ordinal, so revealing a step cannot renumber a group
    // into another group's identity.
    const identitiesOf = (parent, els) => {
      const container = parent.closest("[role=group],fieldset,[role=radiogroup],[role=listbox],[role=tablist],[role=list][aria-label],[role=list][aria-labelledby]") || parent;
      const labelledBy = (container.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.innerText || "");
      const idPrefixes = els.map((el) => (el.id || "").split("-")[0]).filter(Boolean);
      return [
        ...els.map((el) => el.getAttribute("name") || ""),
        container.getAttribute("aria-label") || "",
        ...labelledBy,
        container.tagName === "FIELDSET" ? (container.querySelector("legend")?.innerText || "") : "",
        ...idPrefixes,
      ].map((value) => String(value).trim()).filter(Boolean);
    };
    for (const [parent, els] of byParent) {
      const machineId = els.map((el) => el.getAttribute("data-thrallo-control")).find(Boolean) || null;
      // Filtering can legitimately leave one selectable result. A single ordinary button is not
      // enough evidence of a choice, but one carrying the contract's opaque identity is exact
      // authority. It still has to prove a real false-to-true selected-state transition below.
      if (els.length < 2 && !machineId) continue;
      groups.push({
        groupId: id,
        // The group's OPAQUE identity, if its options carry one. Position-independent and
        // label-independent by construction: renaming every option, translating the page or
        // reordering the DOM cannot change it.
        machineId,
        identities: [...new Set(identitiesOf(parent, els))],
        contextText: `${parent.closest("section,fieldset,[role=group]")?.querySelector("h1,h2,h3,h4,legend,[role=heading]")?.innerText || ""} ${parent.innerText || ""}`.slice(0, 400).toLowerCase(),
        options: els.map((el, i) => {
          el.setAttribute("data-thrallo-opt", `${id}:${i}`);
          // label/value are captured BEFORE any click: when a selection advances the flow its
          // control unmounts, and this is then the only surviving evidence of what was activated.
          return { index: i, text: (el.innerText || el.value || "").trim().slice(0, 80),
            label: el.getAttribute("aria-label") || null, value: el.getAttribute("value") || null,
            selected: isSelected(el) };
        }),
      });
      id += 1;
    }
    return groups;
  }).catch(() => []);
}

async function groupState(page, group) {
  return page.evaluate((descriptor) => {
    if (descriptor.nativeSelect) {
      const select = document.querySelector(`[data-thrallo-native-select="${descriptor.groupId}"]`);
      if (!select) return [];
      return [...select.options].filter((option) => !option.disabled).map((option, index) => ({
        index,
        text: (option.textContent || option.value || "").trim().slice(0, 80),
        selected: option.selected === true,
      }));
    }
    const isSelected = (el) => {
      const state = (el.getAttribute("data-state") || "").toLowerCase();
      const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
      return el.getAttribute("aria-selected") === "true"
        || el.getAttribute("aria-pressed") === "true"
        || el.checked === true
        || ["on", "active", "selected", "checked"].includes(state)
        || /(^|[\s_-])(is[-_])?(selected|active)([\s_-]|$)/.test(cls);
    };
    return [...document.querySelectorAll(`[data-thrallo-opt^="${descriptor.groupId}:"]`)]
      .map((el) => ({
        index: Number(el.getAttribute("data-thrallo-opt").split(":")[1]),
        text: (el.innerText || el.value || "").trim().slice(0, 80),
        selected: isSelected(el),
      }))
      .sort((a, b) => a.index - b.index);
  }, { groupId: group.groupId, nativeSelect: Boolean(group.nativeSelect) }).catch(() => []);
}

/**
 * A selection group's identity, stable across re-renders and step transitions.
 *
 * The ordinal `groupId` is a CLICK HANDLE for one pass of the DOM and nothing more: revealing a
 * step renumbers every group after it, so remembering "group 0 was the date" across steps is
 * exactly how date, slot and party can swap identities. Anything that must survive a transition
 * — which group a step already consumed, which group a contracted field means — uses this.
 */
export function groupKey(group) {
  const declared = (group?.identities || []).map((identity) => semanticKey(identity)).filter(Boolean);
  // A group with no declared identity is keyed by its option VALUES, which are stable while the
  // group exists and cannot collide with a differently-populated group.
  return declared.length
    ? `id:${[...new Set(declared)].sort().join("|")}`
    : `opts:${(group?.options || []).map((option) => option.text).join("|").slice(0, 120)}`;
}

/**
 * Advance a multi-step flow by ONE step, and only when that is demonstrably what happened.
 *
 * A step-gated flow renders one step at a time, so a contracted control for a later step is not
 * on the page yet. Guessing a button here would be worse than failing: "click something and hope"
 * is how a driver marks a broken app green. So this is deliberately narrow — the control must
 * name itself with the generic advance vocabulary (controlIdentity.ADVANCE_ACTION_PATTERN), it
 * must be enabled, and the page must actually change. Anything else leaves the flow where it was
 * and reports that it could not advance.
 */
/**
 * Is a control the interaction contract names observable right now?
 *
 * Identity only — the same declared names `selectionGroups` reads, plus form-control identities —
 * so "the contracted next state arrived" can never be satisfied by prose that happens to match.
 */
async function semanticControlVisible(page, control) {
  if (!control) return false;
  if (control.machineId) {
    const machine = page.locator(
      `[data-thrallo-control="${control.machineId}"]:visible, [data-thrallo-action="${control.machineId}"]:visible`,
    ).first();
    if (await machine.count().catch(() => 0)) return true;
  }
  const target = semanticKey(control.logicalField || control.accessibleName);
  if (!target) return false;
  const identities = await page.evaluate(() => {
    const visible = (el) => el.offsetParent !== null;
    const rows = [];
    for (const el of document.querySelectorAll("[name],[aria-label],[id],legend")) {
      if (!visible(el)) continue;
      rows.push(el.getAttribute("name") || "", el.getAttribute("aria-label") || "", el.id || "",
        el.tagName === "LEGEND" ? (el.innerText || "") : "");
    }
    return rows.filter(Boolean);
  }).catch(() => []);
  return identities.some((identity) => semanticKey(identity) === target);
}

/**
 * Is the contract's value control already usable on the fresh surface?
 *
 * Secondary journeys can share a page with the primary without sharing its UI progression. When
 * their first input/selection is already enabled, replaying every earlier primary control can
 * actively move the page away from the secondary's valid start state (for example by applying an
 * unrelated filter). Step-gated flows still replay prerequisites because their later control is
 * absent or disabled until the earlier steps run.
 */
async function semanticValueControlReady(page, control) {
  if (!control?.machineId) return false;
  const candidates = page.locator(
    `[data-thrallo-control="${control.machineId}"]:visible, [data-thrallo-action="${control.machineId}"]:visible`,
  );
  const count = Math.min(await candidates.count().catch(() => 0), 24);
  for (let index = 0; index < count; index += 1) {
    const ready = await candidates.nth(index).evaluate((element) => {
      const interactive = "button,input,select,textarea,[role=button],[role=radio],[role=option],[role=combobox]";
      const usable = (candidate) => !candidate.disabled && !candidate.readOnly
        && candidate.getAttribute("aria-disabled") !== "true";
      if (element.matches(interactive) && usable(element)) return true;
      return [...element.querySelectorAll(interactive)].some(usable);
    }).catch(() => false);
    if (ready) return true;
  }
  return false;
}

/** Which control the contract expects AFTER this one, by contracted order. */
function nextContractedControl(journeyFlows, flow) {
  if (!flow) return null;
  // A transition step carries no control of its own, so "next" is simply the first contracted
  // control after it.
  if (!flow.control) {
    return (journeyFlows || []).filter((row) => row.control && row.stepIndex > flow.stepIndex)
      .sort((a, b) => a.stepIndex - b.stepIndex)[0]?.control || null;
  }
  return (journeyFlows || [])
    .filter((row) => row.control && row.stepIndex >= flow.stepIndex)
    .find((row) => semanticKey(row.control.logicalField || row.control.accessibleName)
      !== semanticKey(flow.control.logicalField || flow.control.accessibleName))?.control || null;
}

/** Did this step's own contracted outcome become visible, and become visible NOW? */
async function expectationBecameVisible(page, expect, textBefore) {
  const wanted = keywords(expect, 5);
  if (!wanted.length) return { met: false, found: [], fresh: [] };
  const before = String(textBefore || "").toLowerCase();
  const found = [];
  const fresh = [];
  for (const word of wanted) {
    if (!(await anyVisibleTextMatch(page, word))) continue;
    found.push(word);
    if (!before.includes(word)) fresh.push(word);
  }
  return { met: found.length / wanted.length >= 0.5 && fresh.length > 0, found, fresh, wanted };
}

async function expectationIsVisible(page, expect) {
  const wanted = keywords(expect, 5);
  if (!wanted.length) return { met: false, found: [], wanted };
  const found = [];
  for (const word of wanted) {
    if (await anyVisibleTextMatch(page, word)) found.push(word);
  }
  return { met: found.length / wanted.length >= 0.5, found, wanted };
}

/**
 * A selection can unmount synchronously while the state it selected is resolved asynchronously.
 * Wait at that real asynchronous boundary for BOTH pieces of contracted evidence: the next
 * semantic control and this step's observable outcome. A single sample made correct customer
 * apps depend on render/network timing; the bounded wait still fails unrelated or wrong states.
 */
async function waitForAutoAdvanceEvidence(page, nextControl, expect, textBefore, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let nextControlVisible = false;
  let expectationEvidence = await expectationBecameVisible(page, expect, textBefore);
  if (!nextControl) return { nextControlVisible, expectationEvidence };
  for (;;) {
    nextControlVisible = await semanticControlVisible(page, nextControl);
    if (nextControlVisible && expectationEvidence.met) break;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(200);
    expectationEvidence = await expectationBecameVisible(page, expect, textBefore);
  }
  return { nextControlVisible, expectationEvidence };
}

/**
 * Activate a control the contract names, by its own declared identity.
 *
 * Contracts describe controls ("start checkout control", "Confirm order control") while the button
 * is labelled "Start checkout" — so the generic control nouns are stripped as a second attempt.
 * Shared by flow entry and prerequisite setup so both resolve a description the same way, and
 * neither ever falls back to prose.
 */
async function activateContractedControl(page, control, {
  verifierPolicy = LEGACY_RICH_VERIFIER_POLICY,
  evidence = null,
  allowEquivalentCandidates = false,
  preferredMemberMarker = null,
} = {}) {
  const minimal = isMinimalContractVerifier(verifierPolicy);
  const reliableVisible = async (locator) => {
    const count = Math.min(await locator.count().catch(() => 0), 4);
    const visible = [];
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
    }
    if (visible.length === 1) return visible[0];
    if (allowEquivalentCandidates && visible.length > 1) {
      if (evidence) evidence.equivalentCandidates = visible.length;
      return visible[0];
    }
    return null;
  };
  // The contract's own opaque identity, when the app emitted one: no prose, no aliasing, and
  // immune to the label being renamed, translated or replaced by an icon.
  if (control?.machineId) {
    let identityLocator = page.locator(`[data-thrallo-action="${control.machineId}"]`);
    if (preferredMemberMarker) {
      const equivalentCandidates = await identityLocator.count().catch(() => 0);
      if (evidence && equivalentCandidates > 1) evidence.equivalentCandidates = equivalentCandidates;
      const scopedIdentity = page.locator(
        `[data-thrallo-verifier-removal-member="${preferredMemberMarker}"] `
          + `[data-thrallo-action="${control.machineId}"]`,
      );
      if (await scopedIdentity.count().catch(() => 0)) {
        identityLocator = scopedIdentity;
        if (evidence) evidence.scope = "contracted_collection_member";
      }
    }
    const byIdentity = minimal ? await reliableVisible(identityLocator) : identityLocator.first();
    if (byIdentity && await byIdentity.count().catch(() => 0) && await byIdentity.isVisible().catch(() => false)) {
      if (await byIdentity.isDisabled().catch(() => true)) {
        if (evidence) evidence.reason = "disabled";
        return false;
      }
      try {
        await byIdentity.click({ timeout: 5_000 });
        if (evidence) evidence.matchedBy = "machine_identity";
        return true;
      } catch {
        if (evidence) evidence.reason = "click_failed";
        return false;
      }
    }
  }
  const aliases = unique(controlAliases(control).flatMap((alias) => {
    const plain = String(alias).replace(/\b(control|button|link|action|form)\b/gi, "")
      .replace(/\s+/g, " ").trim();
    // Contracts may use the compound verb while accessible labels use its ordinary spaced form.
    // This is spelling normalization, not a domain alias: lookup/look up and signup/sign up name
    // the same action without allowing any unrelated control vocabulary.
    const spaced = plain.replace(/\blookup\b/gi, "look up").replace(/\bsignup\b/gi, "sign up");
    return [alias, plain, spaced];
  }));
  for (const alias of aliases) {
    for (const role of DRIVEABLE_ACTION_ROLES) {
      const locator = page.getByRole(role, { name: new RegExp(`(^|\\W)${escapeRegex(alias)}(\\W|$)`, "i") });
      const candidate = minimal ? await reliableVisible(locator) : locator.first();
      if (!candidate) continue;
      if (!(await candidate.count().catch(() => 0))) continue;
      if (!(await candidate.isVisible().catch(() => false))) continue;
      if (await candidate.isDisabled().catch(() => true)) {
        if (evidence) evidence.reason = "disabled";
        return false;
      }
      try {
        await candidate.click({ timeout: 5_000 });
        if (evidence) evidence.matchedBy = `role:${role}`;
        return true;
      } catch {
        if (evidence) evidence.reason = "click_failed";
        return false;
      }
    }
  }
  if (evidence) evidence.reason = "not_reliably_located";
  return false;
}

/**
 * Move a multi-step flow on by one step.
 *
 * Every control on a later step is unreachable until this succeeds, which is why the identity
 * matters more here than anywhere else. A paid run reached a screen whose forward button read
 * "Next to party size", found nothing in `ADVANCE_ACTION_PATTERN`'s word list that matched, and
 * declared the journey undriveable one control short of the end.
 *
 * So the machine identity is the authority and the word list is only what remains for V1 builds
 * that carry no identity at all. Where an identity is present the label is never consulted: it may
 * be any phrase, any language, an icon or empty.
 */
async function advanceCandidates(page) {
  const declared = page.locator(`[data-thrallo-action="${ADVANCE_ACTION_ID}"]`).first();
  if (await declared.count().catch(() => 0) && await declared.isVisible().catch(() => false)) {
    // Declared identity present: the search STOPS here. Whatever else the page calls "Next" is
    // not the contracted forward control, and clicking it would be a guess.
    return [{ locator: declared, via: "declared advance control", declared: true }];
  }
  const candidates = [];
  for (const role of DRIVEABLE_ACTION_ROLES) {
    const control = page.getByRole(role, { name: ADVANCE_ACTION_PATTERN }).first();
    if (!(await control.count().catch(() => 0))) continue;
    if (!(await control.isVisible().catch(() => false))) continue;
    const via = ((await control.textContent().catch(() => "")) || role).trim().slice(0, 30);
    candidates.push({ locator: control, via, declared: false });
  }
  return candidates;
}

async function advanceFlow(page) {
  const before = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const moved = async (locator, via) => {
    if (await locator.isDisabled().catch(() => true)) return null;
    await locator.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    // No observable change means the flow did NOT advance — for example a Continue that is
    // correctly refusing to move past an incomplete step. Report that, never assume it.
    if (after === before) return { advanced: false, detail: `"${via}" did not advance the flow` };
    return { advanced: true, via };
  };

  for (const candidate of await advanceCandidates(page)) {
    const outcome = await moved(candidate.locator, candidate.via);
    if (outcome) return outcome;
    // Disabled. For a declared control that is a definite answer, not a reason to keep looking.
    if (candidate.declared) return { advanced: false, detail: "the declared advance control is disabled" };
  }
  return { advanced: false, detail: "no flow-advance control was offered" };
}

// Drive a selection step semantically. Returns a full step outcome, or null when no selectable
// group matches — the caller falls back to the generic text path.
async function driveSelection(page, step, flow = null, excludedKeys = new Set(), journeyFlows = [], {
  allowAlreadySelected = false,
} = {}) {
  const contractedNames = controlAliases(flow?.control);
  const wanted = contractedNames.length
    ? unique(contractedNames.flatMap((name) => keywords(name, 5)))
    : keywords(`${step.target || ""} ${step.action} ${step.expect}`, 8);
  const groups = await selectionGroups(page);
  if (!groups.length) return null;

  // A group of "+"/"−" buttons is a STEPPER, not a selection — clicking one never yields a
  // selected state, and judging it here misfired on "choose numbers of adults and children". It
  // is a guess about an UNIDENTIFIED group, so it does not get to overrule the contract: a group
  // carrying the contracted identity has already been declared a selection by the application,
  // and short option labels are ordinary there ("2", "4", "6" — a party size, a rating, a size).
  const identified = flow?.control?.machineId || null;
  const eligible = groups
    .filter((g) => (identified && g.machineId === identified)
      || g.options.some((o) => (o.text || "").length >= 3))
    .map((g) => ({ ...g, key: groupKey(g) }))
    .filter((g) => !excludedKeys.has(g.key));

  let group = null;
  if (flow?.control) {
    // A CONTRACTED selection is matched on the group's own declared identity, never on prose and
    // never on position. Live proof: scoring by rendered text drove the date options for the
    // slot step AND for the party step, and both "passed" because selection did move — within
    // the wrong group. There is deliberately NO prose fallback here: if the contracted group is
    // not on screen the step is undriveable, which is the truth, rather than a false pass.
    // MACHINE IDENTITY FIRST: an exact, opaque match needs no vocabulary at all. The semantic-key
    // comparison below it is the fallback for groups that carry no identity.
    group = flow.control.machineId
      ? eligible.find((g) => g.machineId === flow.control.machineId) || null
      : null;
    if (!group) {
      const target = semanticKey(flow.control.logicalField || flow.control.accessibleName);
      group = eligible.find((g) => g.identities.some((identity) => semanticKey(identity) === target)) || null;
    }
    if (!group) return null;
  } else {
    const scored = eligible
      .map((g) => ({ ...g, score: wanted.filter((w) => g.contextText.includes(w)).length }))
      .sort((a, b) => b.score - a.score);
    group = scored[0];
    if (!group || group.score === 0) return null;
  }

  const before = group.options;
  const beforeSelected = before.findIndex((o) => o.selected);
  const contractedFixture = verificationFixtureFor(flow, "selection");
  const fixtureMatch = (option) => contractedFixture !== null && [option.value, option.label, option.text]
    .filter((value) => value !== null && value !== undefined)
    .some((value) => String(value).trim().toLowerCase() === contractedFixture.trim().toLowerCase());
  // A declared domain fixture outranks option order. Without one, click a DIFFERENT available
  // option than the current selection (or the first, if none) to prove a real transition.
  const clickIndex = contractedFixture === null
    ? before.findIndex((o, i) => i !== beforeSelected)
    : before.findIndex(fixtureMatch);
  if (contractedFixture !== null && clickIndex === -1) {
    return {
      drove: false,
      groupKey: group.key,
      status: "undriveable",
      detail: `the contracted verification value ${JSON.stringify(contractedFixture)} is not an available option`,
      selectedText: null,
      groupId: group.groupId,
      controlEvidence: { contractedField: flow?.control?.logicalField || null, aliases: wanted,
        fixtureAuthority: "contract", verificationValue: contractedFixture,
        selectedGroupContext: group.contextText, selectedOptions: before, autoAdvance: null },
    };
  }
  if (contractedFixture === null && clickIndex === -1 && before.length === 1 && beforeSelected === 0) {
    const expectationEvidence = await expectationIsVisible(page, step.expect);
    if (expectationEvidence.met) {
      const selected = before[0];
      return {
        drove: false,
        groupKey: group.key,
        status: "pass",
        detail: `the sole available selection "${String(selected?.text || selected?.label || selected?.value || "").slice(0, 40)}" and its expected outcome were already established`,
        selectedText: selected?.text || selected?.label || String(selected?.value || ""),
        groupId: group.groupId,
        controlEvidence: { contractedField: flow?.control?.logicalField || null, aliases: wanted,
          fixtureAuthority: "single_available_option", selectedGroupContext: group.contextText,
          selectedOptions: before, precondition: "already_selected", expectationEvidence },
      };
    }
  }
  if (clickIndex === -1) return null;
  // A mixed selection-plus-action step may target an item that the journey already selected, then
  // activate a separate contracted operation on that item. Re-clicking the already-selected
  // option proves no transition and used to return before the operation could run. An exact
  // contract fixture is enough to establish the action target, but only when the caller confirms
  // that a separate machine-identified action follows on this same step.
  if (allowAlreadySelected && contractedFixture !== null && clickIndex === beforeSelected) {
    const selected = before[beforeSelected];
    return {
      drove: false,
      groupKey: group.key,
      status: "pass",
      detail: `contracted selection "${String(selected?.text || selected?.label || contractedFixture).slice(0, 40)}" was already established for the companion action`,
      selectedText: selected?.text || selected?.label || contractedFixture,
      groupId: group.groupId,
      controlEvidence: { contractedField: flow?.control?.logicalField || null, aliases: wanted,
        fixtureAuthority: "contract", verificationValue: contractedFixture,
        selectedGroupContext: group.contextText, selectedOptions: before, precondition: "already_selected" },
    };
  }
  if (contractedFixture !== null && clickIndex === beforeSelected) {
    const expectationEvidence = await expectationIsVisible(page, step.expect);
    if (expectationEvidence.met) {
      const selected = before[beforeSelected];
      return {
        drove: false,
        groupKey: group.key,
        status: "pass",
        detail: `contracted selection "${String(selected?.text || selected?.label || contractedFixture).slice(0, 40)}" and its expected outcome were already established`,
        selectedText: selected?.text || selected?.label || contractedFixture,
        groupId: group.groupId,
        controlEvidence: { contractedField: flow?.control?.logicalField || null, aliases: wanted,
          fixtureAuthority: "contract", verificationValue: contractedFixture,
          selectedGroupContext: group.contextText, selectedOptions: before,
          precondition: "already_selected", expectationEvidence },
      };
    }
  }

  const textBefore = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  if (group.nativeSelect) {
    const domIndex = group.options[clickIndex]?.domIndex;
    await page.locator(`[data-thrallo-native-select="${group.groupId}"]`)
      .selectOption({ index: domIndex }, { timeout: 5_000 }).catch(() => {});
  } else {
    await page.locator(`[data-thrallo-opt="${group.groupId}:${clickIndex}"]`).click({ timeout: 5_000 }).catch(() => {});
  }
  await page.waitForTimeout(600);
  const after = await groupState(page, group);

  // Only when the group has gone entirely: gather what it would take to prove the disappearance
  // was the contracted advance rather than an unrelated transition.
  let autoAdvance = null;
  if (!after.length) {
    const nextControl = nextContractedControl(journeyFlows, flow);
    const observed = await waitForAutoAdvanceEvidence(page, nextControl, step.expect, textBefore);
    autoAdvance = {
      nextControl: nextControl ? (nextControl.logicalField || nextControl.accessibleName) : null,
      nextControlVisible: observed.nextControlVisible,
      expectationMet: observed.expectationEvidence.met,
      expectationEvidence: observed.expectationEvidence,
    };
  }

  const verdict = selectionTransition({ before, after, clickedIndex: clickIndex, autoAdvance });
  return {
    drove: true,
    groupKey: group.key,
    status: verdict.ok ? "pass" : "fail",
    detail: verdict.ok ? verdict.detail : verdict.reason,
    selectedText: verdict.selectedText || null,
    groupId: group.groupId,
    controlEvidence: { contractedField: flow?.control?.logicalField || null, aliases: wanted,
      fixtureAuthority: contractedFixture === null ? "option_transition" : "contract",
      ...(contractedFixture === null ? {} : { verificationValue: contractedFixture }),
      selectedGroupContext: group.contextText, selectedOptions: after, autoAdvance },
  };
}

async function driveSelectionAfterNavigation(page, step, flow, excludedKeys, journeyFlows, options = {}) {
  const deadline = Date.now() + 5_000;
  let outcome = await driveSelection(page, step, flow, excludedKeys, journeyFlows, options);
  while (!outcome && Date.now() < deadline) {
    await page.waitForTimeout(200);
    outcome = await driveSelection(page, step, flow, excludedKeys, journeyFlows, options);
  }
  return outcome;
}

// ── durable evidence: what recovery actually has to prove ─────────────────────────────────────
//
// A recovery step used to be judged on words — "recovered", "remains", "same" — so a correct app
// failed for not narrating itself, and any page containing that vocabulary could have passed. The
// requirement was never the copy. It is that the SAME durable state survived the reload.
//
// So the values are captured at the moment the mutation succeeds, and recovery is judged against
// them. Nothing here is booking-specific: references are whatever reference-shaped tokens the app
// itself printed, values are the exact ones this journey entered and selected.

/**
 * Which durable record a flow is about, from the canonical build spec — the capability that owns
 * the operation and the entity it writes. Never prose. Two journeys share evidence only when the
 * contract says they act on the same durable thing, so a lead's record can never satisfy an
 * order's recovery.
 */
export function durableRecordKey(flow) {
  if (!flow) return null;
  // The contract stamps ONE lifecycle identity on every flow that touches a durable record, so a
  // confirmation owned by the booking system and the reload that recovers it — owned by the
  // wizard — resolve to the same record instead of to their own step owners.
  if (flow.durableLifecycle) return flow.durableLifecycle;
  const entity = [...(flow.writes || []), ...(flow.reads || [])]
    .map((path) => String(path).match(/\.durable\.(\w+)/)?.[1]).find(Boolean) || "record";
  return `${flow.capability || "unknown"}:${entity}`;
}

const REFERENCE_TOKEN = /\b[A-Z0-9]{2,}-[A-Z0-9][A-Z0-9-]{1,}\b/g;

// Operation-transition copy such as "duplicated object disappears" proves the immediate action,
// but requiring those verbs after reload would reject correctly persisted state merely because a
// toast/status message is intentionally transient. Everything else remains load-bearing: this
// deliberately retains states such as Confirmed/Archived and record facts such as edited values,
// so a stale or contradictory recovery still fails the adversarial matrix.
const TRANSIENT_OPERATION_WORDS = new Set([
  "appears", "change", "changed", "changes", "decreases", "disappears", "duplicate", "duplicated",
  "increases", "reapplies", "redo", "restores", "undo",
]);

export function durableStatusWords(expect, text) {
  return keywords(expect, 5).filter((word) => !TRANSIENT_OPERATION_WORDS.has(word.toLowerCase())
    && new RegExp(word, "i").test(String(text || "")));
}

/**
 * The contracted transition whose rendered record becomes the baseline for a later recovery.
 * Cancellation is a durable mutation in its own right: a reload after cancellation must be
 * compared with the Cancelled record, never with stale evidence captured when it was Confirmed.
 */
export function durableTransitionFlow(flows = []) {
  return (flows || []).find((flow) => ["mutation", "cancellation"].includes(flow?.kind)) || null;
}

/**
 * Exact input values are a review requirement only when this STEP says it reads those fields.
 * A results/analytics review can legitimately render calculated outputs without repeating every
 * setup input verbatim. Legacy contracts that explicitly promise an "exact" review keep the old
 * all-values rule; ordinary review prose is judged on its own observable expectation.
 */
export function reviewValuesForStep(step, enteredValues = []) {
  const values = Array.isArray(enteredValues) ? enteredValues : [];
  const reads = new Set((step?.reads || []).map((read) => semanticKey(String(read).split(".").pop())));
  if (reads.size) return values.filter((row) => reads.has(semanticKey(row?.field)));
  return /\bexact(?:ly)?\b/i.test(`${step?.action || ""} ${step?.expect || ""}`) ? values : [];
}

export function durableCommitIdentity({ enteredValues = [], textBefore = "", textAfter = "" } = {}) {
  const before = new Set(String(textBefore).match(REFERENCE_TOKEN) || []);
  return {
    value: enteredValues.find((value) => value && String(textAfter).includes(value)) || null,
    reference: (String(textAfter).match(REFERENCE_TOKEN) || [])
      .find((reference) => !before.has(reference)) || null,
  };
}

/**
 * Did a durable mutation render the exact values it declared as inputs, against the same record?
 *
 * Update screens commonly show the expectation's nouns before Save ("saved lead details",
 * "edited contact"), so word freshness alone rejects a real update. Exact values are stronger
 * evidence: every value read by this mutation must be rendered after the action, at least one of
 * them must not have been page text before it, and a durable-reference write must preserve or
 * create a reference. This proves the immediate transition only; the following recovery step
 * still has to prove that the values survived reload.
 */
export function mutationCommitEvidence({ flow, enteredValues = [], textBefore = "", textAfter = "" } = {}) {
  const reads = new Set((flow?.reads || []).map((read) => semanticKey(String(read).split(".").pop())));
  const values = unique((enteredValues || [])
    .filter((row) => row?.value && reads.has(semanticKey(row.field)))
    .map((row) => row.value));
  if (!values.length) return { checked: false, ok: false, values: [], visibleValues: [], freshValues: [] };

  const beforeText = String(textBefore || "");
  const afterText = String(textAfter || "");
  const visibleValues = values.filter((value) => afterText.includes(value));
  const freshValues = visibleValues.filter((value) => !beforeText.includes(value));
  const beforeReferences = new Set(beforeText.match(REFERENCE_TOKEN) || []);
  const afterReferences = new Set(afterText.match(REFERENCE_TOKEN) || []);
  const stableReferences = [...beforeReferences].filter((reference) => afterReferences.has(reference));
  const newReferences = [...afterReferences].filter((reference) => !beforeReferences.has(reference));
  const requiresReference = (flow?.writes || []).some((write) => /\.durable\.reference$/.test(String(write)));
  const referenceOk = !requiresReference || (beforeReferences.size > 0
    ? stableReferences.length > 0
    : newReferences.length > 0);

  return {
    checked: true,
    ok: visibleValues.length === values.length && freshValues.length > 0 && referenceOk,
    values,
    visibleValues,
    freshValues,
    stableReferences,
    newReferences,
    requiresReference,
  };
}

async function captureDurableEvidence(page, { enteredValues, selections, expect }) {
  const text = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const candidates = unique([...enteredValues.map((row) => row.value), ...selections]);
  return {
    captured: true,
    // Only what is actually ON the confirmation: a value the app never showed cannot be evidence
    // that it survived.
    values: candidates.filter((value) => value && text.includes(value)),
    references: [...new Set(text.match(REFERENCE_TOKEN) || [])].slice(0, 4),
    statusWords: durableStatusWords(expect, text),
  };
}

/** Pure: did the durable state survive? Exported so the rule can be proven without a browser. */
export function recoveryEvidenceVerdict(durable, textAfter) {
  const text = String(textAfter || "");
  if (!durable?.captured) return { checked: false };
  const missingValues = (durable.values || []).filter((value) => !text.includes(value));
  // Status vocabulary belongs to the screen that created the record, not to the record. A manage
  // view legitimately says "Status Confirmed" without saying "confirmation screen" or "durable",
  // so those words are only held against a recovery of the SAME screen.
  //
  // RETAINED DELIBERATELY in the 2026-08-12 prose audit, and it is the one prose-fed rule that
  // survived. It does not invent a requirement: the words come from the expectation of the step
  // that created the record, which the app HAD to satisfy to get here, and this only asks that
  // reloading the same screen does not contradict it. Nothing structured replaces it — the
  // contract types a `durable.status` path but never its value — and the adversarial matrix
  // proves it is load-bearing: without it, a confirmed record that reloads as Cancelled, and a
  // cancelled record answering for a confirmed one, both pass.
  const missingStatus = durable.sameSurface === false ? []
    : (durable.statusWords || []).filter((word) => !new RegExp(word, "i").test(text));
  const references = durable.references || [];
  const survivingReference = references.find((reference) => text.includes(reference)) || null;
  if (references.length && !survivingReference) {
    return { checked: true, ok: false,
      detail: `the durable reference did not survive (expected ${references.slice(0, 2).join(" or ")})` };
  }
  if (missingValues.length) {
    return { checked: true, ok: false,
      detail: `recovered state lost contracted values: ${missingValues.slice(0, 4).join(", ")}` };
  }
  if (missingStatus.length) {
    return { checked: true, ok: false,
      detail: `recovered state no longer shows: ${missingStatus.join(", ")}` };
  }
  return { checked: true, ok: true,
    detail: `same durable state after recovery${survivingReference ? ` (reference ${survivingReference})` : ""}`
      + `${durable.values?.length ? ` · ${durable.values.length} contracted value(s) intact` : ""}` };
}

// ── running one step ──────────────────────────────────────────────────────────────────────────

function isAuthenticationFlow(entry, step) {
  const text = [entry?.control?.purpose, entry?.control?.accessibleName,
    step?.action, step?.target].filter(Boolean).join(" ");
  return /\b(account form|auth(?:entication)?|sign[ -]?in|sign[ -]?up|create account|register)\b/i.test(text);
}

async function anyVisibleTextMatch(page, word) {
  const matches = page.getByText(new RegExp(word, "i"));
  const count = Math.min(await matches.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    if (await matches.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

export function shouldSubmitContractedForm(action = "") {
  return /\b(generate|rename|apply|save|submit|send|create|change|edit|update)\b|\biterat(?:e|ion|ive|ing)\b/i
    .test(String(action));
}

/** Drive a real visible account form; never inject or fabricate a session. */
async function driveAuthenticationForm(page, marker, { mode = "create", credentials = null } = {}) {
  const deadline = Date.now() + 20_000;
  // Authentication surfaces are client-rendered after the contracted landing action. A single
  // immediate scan races that navigation; wait only at this asynchronous boundary, without
  // making ordinary missing controls consume their whole journey timeout.
  const email = await waitForFirstVisible([
    page.getByLabel(/e-?mail/i), page.getByPlaceholder(/e-?mail/i), page.locator('input[type="email"]'),
  ], deadline);
  const password = await waitForFirstVisible([
    page.getByLabel(/password/i), page.getByPlaceholder(/password/i), page.locator('input[type="password"]'),
  ], deadline);
  if (!email || !password) return { attempted: false, reason: "the account form did not expose email and password controls" };

  const modeNames = mode === "signin"
    ? /use (?:an )?existing account|sign ?in/i
    : /use (?:a )?new account|create account|sign ?up|register/i;
  const modeControls = page.getByRole("button", { name: modeNames });
  for (let index = 0; index < await modeControls.count(); index += 1) {
    const candidate = modeControls.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const isSubmit = await candidate.evaluate((element) => element.type === "submit").catch(() => false);
    if (!isSubmit) { await candidate.click({ timeout: 5_000 }); break; }
  }

  const submittedEmail = credentials?.email
    || `journey+${marker}@thrallo.dev`;
  const submittedPassword = credentials?.password || `Jv-${marker}!9a`;
  await email.fill(submittedEmail);
  await password.fill(submittedPassword);
  const before = page.url();
  const formSubmit = page.locator('form button[type="submit"], form input[type="submit"]').first();
  const namedSubmit = page.getByRole("button", { name: /create account|sign ?up|register|continue|open .*workspace/i }).first();
  const submit = await formSubmit.isVisible().catch(() => false) ? formSubmit : namedSubmit;
  if (!await submit.isVisible().catch(() => false)) {
    return { attempted: true, submitted: false, email: submittedEmail, reason: "the account form exposed no submit control" };
  }
  await submit.click({ timeout: 5_000 });
  await Promise.race([
    page.waitForURL((url) => url.href !== before, { timeout: 20_000 }),
    password.waitFor({ state: "hidden", timeout: 20_000 }),
  ]).catch(() => {});
  const formStillVisible = await password.isVisible().catch(() => false);
  const errorText = formStillVisible
    ? await page.locator('[role="status"]').first().textContent().catch(() => null) : null;
  const authenticated = page.url() !== before || !formStillVisible;
  if (authenticated) {
    // Client-side auth changes the URL before the protected React surface has necessarily
    // committed. Reading the expectation or the next prerequisite in that gap made a successful
    // account creation look like an empty editor, and made its first editor field "not fillable".
    // Wait for the browser's own network/paint work; no product copy or route is assumed here.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
  return {
    attempted: true, submitted: true, authenticated, email: submittedEmail,
    urlChanged: page.url() !== before,
    reason: authenticated ? null : String(errorText || "the account form remained visible after submission").slice(0, 160),
    credentials: { email: submittedEmail, password: submittedPassword },
  };
}

async function openAuthenticationEntry(page, previewUrl, mode) {
  await page.goto(previewUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  const names = mode === "signin" ? /sign ?in account form|sign ?in/i : /create account account form|create account|sign ?up/i;
  const entry = await firstVisible([
    page.getByRole("link", { name: names }), page.getByRole("button", { name: names }),
  ], Date.now() + 8_000);
  if (!entry) return false;
  await entry.click({ timeout: 5_000 });
  await page.waitForTimeout(500);
  return true;
}

async function driveExplicitAuthenticationAction(page, action, { marker, previewUrl, authState }) {
  if (/sign out/i.test(action) && !/sign back in|sign in as the first/i.test(action)) {
    const signOut = await firstVisible([
      page.getByRole("button", { name: /sign out/i }), page.getByRole("link", { name: /sign out/i }),
    ], Date.now() + 5_000);
    if (!signOut) return { handled: true, status: "undriveable", detail: "no visible Sign out control was offered" };
    await signOut.click({ timeout: 5_000 });
    await page.waitForTimeout(700);
    authState.active = null;
    const publicEntry = await firstVisible([
      page.getByRole("link", { name: /sign ?in|create account|sign ?up/i }),
      page.getByRole("button", { name: /sign ?in|create account|sign ?up/i }),
      page.locator('input[type="email"]'),
    ], Date.now() + 5_000);
    const privateEntryStillVisible = await signOut.isVisible().catch(() => false);
    return publicEntry && !privateEntryStillVisible
      ? { handled: true, drove: true, status: "pass",
        detail: "the authenticated surface closed and a public authentication entry is visible" }
      : { handled: true, drove: true, status: "fail",
        detail: "sign out did not replace the authenticated surface with a public authentication entry" };
  }

  let mode = null;
  let credentials = null;
  if (/different account/i.test(action)) mode = "create";
  else if (/sign back in|sign in as the first/i.test(action)) {
    mode = "signin";
    credentials = authState.accounts[0] || null;
    if (!credentials) return { handled: true, status: "undriveable", detail: "the first account credentials were not retained in this journey" };
  } else if (/create (?:a )?new account|create account|sign ?up/i.test(action)) mode = "create";
  if (!mode) return { handled: false };

  if (authState.active) {
    const signOut = await firstVisible([page.getByRole("button", { name: /sign out/i })], Date.now() + 3_000);
    if (signOut) { await signOut.click({ timeout: 5_000 }); await page.waitForTimeout(600); }
    authState.active = null;
  }
  if (!(await openAuthenticationEntry(page, previewUrl, mode))) {
    return { handled: true, status: "undriveable", detail: `the ${mode} account entry was not offered` };
  }
  const authentication = await driveAuthenticationForm(page, `${marker}-${authState.accounts.length + 1}`, { mode, credentials });
  if (!authentication.authenticated) {
    return { handled: true, status: "undriveable", detail: authentication.reason || "authentication did not complete", authentication };
  }
  const account = authentication.credentials;
  if (mode === "create" && !authState.accounts.some((row) => row.email === account.email)) authState.accounts.push(account);
  authState.active = account;
  return { handled: true, drove: true, authentication };
}

async function runStep(page, step, {
  marker, authMarker = marker, previewUrl, selections = [], enteredValues = [], interactionFlows = [], journeyFlows = [],
  writtenPaths = new Set(), durable = { captured: false }, runEvidence = new Map(),
  authState = { accounts: [], active: null }, allowEstablishedState = false,
  verifierPolicy = LEGACY_RICH_VERIFIER_POLICY,
}) {
  const minimal = isMinimalContractVerifier(verifierPolicy);
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  // NEVER JUDGE A SCREEN THAT IS STILL LOADING.
  //
  // This waited for the active surface after NAVIGATION only, so a surface that resolves its own
  // state asynchronously — an auth form that checks the session before rendering its fields — was
  // driven mid-load. Across one 24-round production build the same first step failed three times
  // with "Authentication screen state: loading", "Authentication screen state: error" and "the
  // account form did not expose email and password controls", while other rounds drove it fine.
  // A third of the build's repair allowance was spent chasing a race, and because the defect
  // signature changed each time the progress check read it as movement and kept going.
  //
  // Bounded and conditional: it only waits while a loading indicator is actually visible, and it
  // gets a fraction of the step's own budget so a permanently-stuck spinner cannot eat the step.
  await waitForActiveSurface(page, 5_000);
  const action = String(step.action || "");
  const expect = String(step.expect || "");
  const observationOnly = isObservationOnlyStep(step, interactionFlows, { verifierPolicy });
  let drove = false;
  // Set when a CONTRACTED action kind has already driven this step, so the generic keyword click
  // path never adds a second action on top of it.
  let contractDriven = false;
  // Did THIS step put a value into a field? The form-state rule below is about a fill and may not
  // answer for a step that performed none.
  let filledSomething = false;
  let filledContractedInputs = [];

  // What was already on screen BEFORE this step. A word that was visible beforehand is no evidence
  // that the step did anything: "a booking reference is shown" was passing on a page whose only
  // match was the word "booking" in the button the step had just clicked.
  const textBefore = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const resetExpected = expectationRequestsControlReset(`${action} ${expect}`);
  const controlsBefore = resetExpected ? await visibleControlState(page) : [];
  const removalSpec = selectedRemovalExpectationSpec(removalExpectationSpec({ action, expect }), selections);
  const collectionMembershipSpec = collectionMembershipExpectationSpec(expect)
    || selectedCollectionExpectationSpec(expect, selections);
  const removalFlow = removalSpec ? interactionFlows.find((flow) => flow.control
    && ["mutation", "cancellation", "action"].includes(flow.kind)) : null;
  const removalBaseline = removalFlow
    ? await collectionActionMemberState(page, removalSpec, removalFlow.control, { mark: true })
    : { checked: false, targetPresent: false, targetMemberCount: 0, matchedControlCount: 0 };
  const urlBefore = page.url();
  let controlEvidence = null;

  const explicitAuth = interactionFlows.some((flow) => flow.kind === "flow_start")
    ? { handled: false }
    : await driveExplicitAuthenticationAction(page, action, { marker: authMarker, previewUrl, authState });
  if (explicitAuth.handled) {
    if (explicitAuth.status) return explicitAuth;
    drove = explicitAuth.drove;
    controlEvidence = explicitAuth.authentication ? { authentication: explicitAuth.authentication } : null;
    if (/different account/i.test(action) && explicitAuth.authentication) {
      const privateEvidence = unique([...(durable.values || []), ...(durable.references || [])]);
      if (!privateEvidence.length) {
        return { drove: true, status: "undriveable",
          detail: "the first account produced no durable evidence to test against the second account" };
      }
      const visible = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      const leaked = privateEvidence.filter((value) => visible.includes(value));
      return leaked.length
        ? { drove: true, status: "fail",
          detail: `the different account can see private durable evidence: ${leaked.slice(0, 3).join(", ")}` }
        : { drove: true, status: "pass",
          detail: "the different account opened successfully and cannot see the first account's durable record" };
    }
  }

  let viewportChanged = false;
  const contractedViewport = viewportForAction(action);
  if (contractedViewport) {
    await page.setViewportSize({ width: contractedViewport.width, height: contractedViewport.height });
    drove = true;
    viewportChanged = true;
  }

  // Navigation, when the step names a route.
  const route = (step.target || "").match(/^\/[\w/-]*/) || action.match(/\s(\/[\w/-]+)/);
  if (route && /open|go to|navigate|visit/i.test(action)) {
    await page.goto(new URL(route[0] ?? route[1], previewUrl).href, { waitUntil: "domcontentloaded" }).catch(() => {});
    drove = true;
  }

  // A RECOVERY step means "this survives coming back to it", so the reload is the step, whatever
  // words the contract used for it. Prose still answers for contracts that typed nothing.
  // A planner may attach recovery metadata to the same step that first opens an account or
  // workflow surface. The explicit flow entry is the action; reloading before it makes the entry
  // unreachable and proves neither authentication nor recovery.
  const hasFlowStart = interactionFlows.some((flow) => flow.kind === "flow_start" && flow.control);
  const isRecoveryStep = !hasFlowStart && interactionFlows.some((flow) => flow.kind === "recovery");
  if (isRecoveryStep || /reload|refresh/i.test(action)) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    drove = true;
  }

  // Only if the step was not itself a navigation. "open the booking page" matches /book/, and an
  // earlier version therefore navigated AND clicked — submitting the form on step one, so that by
  // step three the confirmation was already on screen and the real submit proved nothing.
  // CAPTURED BEFORE THE FILL: a fill is not a navigation. Treating it as one meant every
  // combined "enter … then submit" step filled the form and NEVER CLICKED — three live bv2
  // runs (and untold v1 submit steps) failed working apps on exactly this line.
  const navigated = drove;

  // Focus-only accessibility steps name a value-holding primitive so the exact target remains
  // machine-addressable, but they do not ask the verifier to edit that value. Editing a search
  // field here can remove the later controls the same journey is meant to inspect. Drive the
  // declared controls through keyboard traversal and prove focus visibility plus accessible
  // naming directly; no application prose is accepted as a substitute.
  const focusFlows = interactionFlows.filter((flow) => ["input", "selection"].includes(flow.kind)
    && flow.control);
  const focusOnly = interactionFlows.some((flow) => flow.interactionMode === "keyboard_focus")
    || (focusFlows.length > 0 && isKeyboardFocusOnlyStep(step));
  if (focusOnly) {
    if (!focusFlows.length) return { drove, status: "undriveable",
      detail: "the focus-only step names no contracted focusable control" };
    const outcomes = [];
    for (const flow of focusFlows) {
      const outcome = await driveKeyboardFocus(page, flow, step);
      outcomes.push(outcome);
      if (outcome.status !== "pass") return outcome;
    }
    return {
      drove: true, status: "pass",
      detail: outcomes.map((outcome) => outcome.detail).join("; "),
      controlEvidence: { focus: outcomes.map((outcome) => outcome.controlEvidence) },
    };
  }

  // A field an EARLIER contracted step already wrote is not this step's to type into. The live
  // contract derives party size as both a selection (its own step) and an input on the contact
  // step; demanding a text box for it would fail a correct application for holding the value it
  // was already given.
  const contractedInputs = interactionFlows.filter((flow) => flow.kind === "input" && flow.control
    && !writtenPaths.has(flow.control.statePath));
  // A historical contract can retain `validity: invalid` on the correction step that immediately
  // follows a negative test. The action is authoritative about the transition: correction must
  // enter a valid value, otherwise the verifier repeats the invalid input and can never observe
  // recovery. This is generic validation sequencing, not domain knowledge.
  const effectiveContractedInputs = /\b(correct|fix|make valid|valid value)\b/i.test(action)
    ? contractedInputs.map((flow) => ({ ...flow, control: { ...flow.control, validity: "unspecified" } }))
    : contractedInputs;
  // A step that WRITES contracted values is driven from the contract, not from whether its prose
  // happens to contain a fill verb. "edit the contact name, email and notes" writes exactly the
  // three fields "enter …" would, and a hardcoded verb list left every CRM edit step undriveable
  // while the contract already named the controls. The blind form-filling fallback below stays
  // prose-gated — that one IS a guess, and only prose can justify it.
  if (contractedInputs.length || /enter|type|fill|complete|provide/i.test(action)) {
    // "select an account type" contains the word "type", so the contract derives BOTH a selection
    // and an input for the same field. Demanding a text box for it fails a correct chooser. When
    // every contracted input on this step is a field the same step also contracts as a SELECTION,
    // the selection is the specific claim and the input is the artefact of an ambiguous verb —
    // a step with a genuinely separate field to fill is untouched.
    const selectionKeys = new Set(interactionFlows.filter((flow) => flow.kind === "selection" && flow.control)
      .map((flow) => semanticKey(flow.control.logicalField || flow.control.accessibleName)));
    const inputsAreSelections = effectiveContractedInputs.length > 0 && effectiveContractedInputs.every((flow) =>
      selectionKeys.has(semanticKey(flow.control.logicalField || flow.control.accessibleName)));
    if (effectiveContractedInputs.length && !inputsAreSelections) {
      let result = await fillContractedFields(page, effectiveContractedInputs, marker, { verifierPolicy });
      // The contracted fields may belong to a step the flow has not reached. Advance and retry,
      // bounded, and only while advancing actually changes the page.
      const advances = [];
      for (let attempt = 0; !result.complete && attempt < MAX_FLOW_ADVANCES; attempt += 1) {
        const advance = await advanceFlow(page);
        advances.push(advance);
        if (!advance.advanced) break;
        result = await fillContractedFields(page, effectiveContractedInputs, marker, { verifierPolicy });
      }
      if (advances.length) result.evidence.flowAdvances = advances;
      controlEvidence = result.evidence;

      // A contracted INVALID step must prove REJECTION, not merely complaint. An application that
      // shows a validation message and then accepts the value anyway is broken, and passing it on
      // the message alone would be exactly the kind of false green this verifier exists to stop.
      // Generic: either the advance control refuses to act, or acting leaves the flow on the same
      // contracted control. No specific HTML validation implementation is required.
      const invalidFlow = effectiveContractedInputs.find((flow) => flow.control.validity === "invalid");
      if (result.complete && invalidFlow) {
        const stillHere = async () => semanticControlVisible(page, invalidFlow.control);
        let blocked = null;
        const machineId = invalidFlow.control.machineId;
        const owningSubmit = machineId
          ? page.locator(`form:has([data-thrallo-control="${machineId}"]) button[type="submit"]:visible`).first()
          : null;
        const candidates = owningSubmit && await owningSubmit.count().catch(() => 0)
          ? [{ locator: owningSubmit, via: "the invalid field's owning form" }]
          : (await advanceCandidates(page)).filter((candidate) => candidate.declared);
        for (const { locator: control } of candidates) {
          if (await control.isDisabled().catch(() => false)) { blocked = "the advance control is disabled"; break; }
          await control.click({ timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(700);
          blocked = (await stillHere())
            ? "the flow stayed on this step when advance was attempted"
            : null;
          break;
        }
        // No advance control at all: the flow cannot progress from here, which is itself blocking.
        if (blocked === null && !(await stillHere())) {
          return { drove: true, status: "fail", controlEvidence,
            detail: `the application accepted an invalid ${invalidFlow.control.logicalField} and advanced anyway` };
        }
        controlEvidence = { ...result.evidence, blockedProgression: blocked || "no advance control was offered" };
      }
      enteredValues.push(...result.evidence.fields.filter((field) => field.status === "filled")
        .map((field) => ({ field: field.field, value: field.expectedValue })));
      filledContractedInputs = result.complete ? effectiveContractedInputs : [];
      drove = drove || result.filled.length > 0;
      filledSomething = filledSomething || result.filled.length > 0;
      if (!result.complete) {
        const missing = result.evidence.fields.filter((field) => field.status !== "filled")
          .map((field) => `${field.field}:${field.status}`).join(", ");
        const invalidFixture = result.evidence.fields.find((field) => field.status === "fixture_invalid");
        return { drove, status: "undriveable", detail: `contracted control(s) could not be driven: ${missing}`,
          controlEvidence,
          ...(invalidFixture ? { verifierDefect: {
            code: "verifier_fixture_invalid",
            field: invalidFixture.field,
            detail: invalidFixture.validityMessage || "the verifier fixture violates the control's native constraints",
          } } : {}),
        };
      }
    } else if (!inputsAreSelections) {
      const filled = await fillVisibleForm(page, marker);
      drove = drove || filled.length > 0;
      filledSomething = filledSomething || filled.length > 0;
    }
    // inputsAreSelections: type nothing, and let the selection branch below drive the chooser.
  }

  // If a contracted input describes a mutating action but the historical contract omitted the
  // companion mutation edge, submit only the form that owns that exact identity. This covers
  // ordinary rename/generate/apply interactions without guessing among unrelated page buttons.
  if (filledContractedInputs.length
    && !interactionFlows.some((flow) => ["mutation", "action", "cancellation"].includes(flow.kind))
    && shouldSubmitContractedForm(action)) {
    for (const flow of filledContractedInputs) {
      const id = flow.control?.machineId;
      if (!id) continue;
      const submit = page.locator(`form:has([data-thrallo-control="${id}"]) button[type="submit"]:visible`).first();
      if (!(await submit.count().catch(() => 0))) continue;
      if (await submit.isDisabled().catch(() => true)) continue;
      await submit.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(700);
      drove = true;
      contractDriven = true;
      break;
    }
  }

  // A contracted FLOW ENTRY step. The contract names the control that opens the flow, so it is
  // activated by that identity — never by hoping the action prose contains a click verb. It only
  // worked for "start the booking flow" because "booking" happens to contain "book"; "begin
  // checkout" contains no verb the generic path recognises and the step was undriveable.
  if (!navigated && !observationOnly
    && interactionFlows.some((flow) => flow.kind === "flow_start" && flow.control)) {
    const entry = interactionFlows.find((flow) => flow.kind === "flow_start" && flow.control);
    const activation = {};
    // A flow-entry control can legitimately be repeated for a collection: product cards, search
    // results, projects, catalogue items, and similar choices all offer the same contracted
    // action more than once. In that case every exact match is an equivalent way to begin the
    // journey, so drive the first visible match in stable DOM order and let the contracted result
    // decide whether it worked. Keep ordinary commit/destructive actions uniqueness-strict.
    const activated = await activateContractedControl(page, entry.control, {
      verifierPolicy, evidence: activation, allowEquivalentCandidates: true,
    });
    activation.requiredAtFlowEntry = true;
    drove = drove || activated;
    controlEvidence = { ...(controlEvidence || {}), activation };
    if (!activated) {
      return { drove, status: "undriveable",
        detail: `the contracted flow-entry control was not offered (${entry.control.accessibleName})`,
        controlEvidence: { ...controlEvidence, contractedField: entry.control.accessibleName } };
    }
    await page.waitForTimeout(700);
    if (isAuthenticationFlow(entry, step)) {
      const authentication = await driveAuthenticationForm(page, authMarker);
      controlEvidence = { ...(controlEvidence || {}), authentication };
      drove = drove || authentication.authenticated === true;
      if (!authentication.authenticated) {
        return { drove, status: "undriveable", detail: authentication.reason || "authentication did not complete",
          controlEvidence };
      }
      if (!authState.accounts.some((row) => row.email === authentication.credentials.email)) {
        authState.accounts.push(authentication.credentials);
      }
      authState.active = authentication.credentials;
    }
    // The contract named the control for this step, so the search for one is OVER. Falling through
    // let the generic click path fire a SECOND action on the same step: "start the booking flow"
    // matches the loose /book/ verb test, whose candidates include a link named "Look up booking",
    // and the driver navigated out of the flow it had just opened. One contracted action kind
    // drives at most one semantic action — only bounded multi-stage kinds like flow_advance may
    // act more than once. The expectation below still decides the verdict; activation alone
    // never passes a step.
    contractDriven = true;
  }

  // A contracted TRANSITION step. It writes nothing, so there is no value to prove — the whole
  // claim is that the flow moved from one contracted state to the next. It may therefore activate
  // only a control that names itself with the generic advance vocabulary, and it passes only if
  // the control the CONTRACT names next becomes observable. Clicking Continue and landing
  // anywhere else is a failure, not a pass, and no DOM change on its own counts.
  if (!navigated && !observationOnly && interactionFlows.some((flow) => flow.kind === "flow_advance")) {
    const advanceFlowSpec = interactionFlows.find((flow) => flow.kind === "flow_advance");
    const target = nextContractedControl(journeyFlows, advanceFlowSpec);
    const advances = [];
    for (let attempt = 0; attempt < MAX_FLOW_ADVANCES; attempt += 1) {
      if (target && await semanticControlVisible(page, target)) break;
      const advance = await advanceFlow(page);
      advances.push(advance);
      if (!advance.advanced) break;
      drove = true;
    }
    const label = target ? (target.logicalField || target.accessibleName) : null;
    const arrived = target ? await semanticControlVisible(page, target) : false;
    if (!target) {
      return { drove, status: "undriveable", controlEvidence: { flowAdvances: advances },
        detail: "the contract names no control after this transition, so nothing proves the flow advanced" };
    }
    return {
      drove, status: arrived ? "pass" : "fail",
      detail: arrived
        ? `the flow advanced to the contracted next state (${label})`
        : `the flow did not reach the contracted next state (${label})`,
      controlEvidence: { flowAdvances: advances, contractedNext: label },
    };
  }

  // Selection steps: judged on the SEMANTIC transition (selection must move to the clicked
  // option and off the previous one), never on text freshness — a default-selected date is
  // valid product behaviour and static copy proves nothing in either direction. Triggered on
  // the ACTION verb, not the expectation's wording: "select an available date → timed slots
  // become visible" is still a selection, even though its expect describes the consequence —
  // gating on the word "selected" sent exactly that step back to the text path, which refused
  // the default-selected date all over again. When no selectable group matches, the generic
  // path below still applies.
  const declaredSelections = interactionFlows.filter((flow) => flow.kind === "selection"
    && flow.control && !identifiesNothing(flow.control.logicalField || flow.control.accessibleName));
  if ((!navigated || declaredSelections.length)
    && (declaredSelections.length || /\b(choose|select|pick)\b/i.test(action))
    // A validated interaction contract outranks prose heuristics. Quantity-like wording is
    // excluded only when the verifier is inferring a selector from text, because it may describe
    // a counter/stepper. When the contract declares a selection and the app exposes that exact
    // machine identity, bypassing the semantic driver makes a proven scaffold control
    // undriveable and sends a correct app into repair.
    && (declaredSelections.length || !/\bnumbers? of\b|amount|quantity/i.test(action))) {
    // "choose to cancel the booking" derives a SELECTION whose field is the bare verb `cancel`,
    // because the step says "choose". There is no option group called cancel — it is a button —
    // and demanding one made a working cancellation undriveable. controlIdentity already names
    // these words as identifying no control on their own; a selection over one of them is an
    // artefact of the verb, and the step's real action kind is handled below.
    const cancels = interactionFlows.some((flow) => flow.kind === "cancellation");
    const selectionFlows = cancels ? [] : declaredSelections;
    if (selectionFlows.length) {
      const companionAction = interactionFlows.find((flow) =>
        ["mutation", "cancellation", "lookup", "action"].includes(flow.kind));
      // One contracted step can set several independent filters. A fixture may deliberately keep
      // one at its current sentinel while another filter makes the real transition. Treat the
      // exact current value as that field's established precondition, but only for a compound
      // selection and only when at least one sibling selection actually moves.
      const compoundSelection = selectionFlows.length > 1;
      const selectionOptions = { allowAlreadySelected: Boolean(companionAction) || compoundSelection };
      const outcomes = [];
      const used = new Set();
      const advances = [];
      for (const flow of selectionFlows) {
        // A route navigation waits only for DOMContentLoaded. Generated apps commonly fetch
        // availability before rendering their first semantic option group, so an immediate query
        // observes the loading shell and falsely declares the contracted control absent. Poll only
        // after this step actually navigated; ordinary selection failures keep their fast path.
        let outcome = navigated
          ? await driveSelectionAfterNavigation(page, step, flow, used, journeyFlows, selectionOptions)
          : await driveSelection(page, step, flow, used, journeyFlows, selectionOptions);
        // The contracted group may belong to a step the flow has not reached. Advance and retry,
        // bounded, and only while advancing actually changes the page. The retry re-locates the
        // group by IDENTITY, so advancing can never hand this step a different group's controls.
        for (let attempt = 0; !outcome && attempt < MAX_FLOW_ADVANCES; attempt += 1) {
          const advance = await advanceFlow(page);
          advances.push(advance);
          if (!advance.advanced) break;
          outcome = await driveSelection(page, step, flow, used, journeyFlows, selectionOptions);
        }
        if (!outcome) return { drove: outcomes.length > 0, status: "undriveable",
          detail: `no selectable control group matched contracted field ${flow.control.logicalField}`,
          controlEvidence: { contractedField: flow.control.logicalField,
            requiredControl: { kind: "selection", reason: "not_reliably_located" },
            flowAdvances: advances,
            aliases: flow.control.accessibleNames || [flow.control.accessibleName] } };
        used.add(outcome.groupKey);
        outcomes.push(outcome);
        if (outcome.status !== "pass") return outcome;
        if (flow.control.statePath) writtenPaths.add(flow.control.statePath);
        if (outcome.selectedText) selections.push(outcome.selectedText);
      }
      const selectionResult = { drove: outcomes.some((row) => row.drove), status: "pass",
        detail: outcomes.map((row) => row.detail).join("; "),
        selectedTexts: outcomes.map((row) => row.selectedText).filter(Boolean),
        controlEvidence: { selections: outcomes.map((row) => row.controlEvidence), flowAdvances: advances } };
      if (compoundSelection && !selectionResult.drove && !companionAction) {
        return { ...selectionResult, status: "fail",
          detail: "every contracted selection value was already selected, so no transition was observed" };
      }
      if (!companionAction) return selectionResult;
      drove = drove || selectionResult.drove;
      controlEvidence = { ...(controlEvidence || {}), ...selectionResult.controlEvidence };
      // A selection-owned operation runs through the option's onSelect handler. It still has to
      // prove the operation's contracted outcome below, but the driver must not click a second
      // prose-matched control after the semantic option already triggered it.
      if (!companionAction.control) contractDriven = true;
    } else {
      const outcome = await driveSelection(page, step);
      if (outcome) return outcome;
    }
  }

  // Counter/stepper steps ("select number of adults and children"): drive the increment
  // control for each noun the step names — these are +/− buttons or spinbuttons, which no
  // keyword locator reliably finds (a live booking run clicked the "Phone number" label
  // instead). Falls through to expectation sampling; the generic click path is skipped.
  let droveStepper = false;
  if (!navigated && /\bnumbers? of\b|\bhow many\b|party size|adults|children|guests/i.test(`${action} ${step.target || ""}`)) {
    const scope = `${action} ${step.target || ""}`;
    const nouns = ["adults", "children", "guests", "people"].filter((n) => new RegExp(n, "i").test(scope));
    for (const noun of nouns.length ? nouns : ["guest"]) {
      const inc = page.getByRole("button", { name: new RegExp(`(increase|add|more)\\s+${noun}|${noun}\\s*\\+`, "i") }).first();
      if (await inc.count().catch(() => 0)) {
        await inc.click({ timeout: 3_000 }).catch(() => {});
        drove = true;
        droveStepper = true;
      }
    }
    if (!droveStepper) {
      const spin = page.getByRole("spinbutton").first();
      if (await spin.count().catch(() => 0)) {
        await spin.fill("2").catch(() => {});
        drove = true;
        droveStepper = true;
      }
    }
  }

  // Plural actions must exercise every named control. Clicking a single Download button or only
  // Undo would not prove the contracted operation and previously left working multi-action steps
  // dependent on whichever keyword candidate happened to sort first.
  if (!navigated && !contractDriven && /download all working export formats/i.test(action)) {
    const controls = [
      page.getByRole("button", { name: /^Download RBXM$/i }),
      page.getByRole("button", { name: /^Download Roblox Lua$/i }),
      page.getByRole("button", { name: /^Download JSON$/i }),
    ];
    let completed = 0;
    for (const locator of controls) {
      const button = locator.first();
      if (!(await button.isVisible().catch(() => false)) || await button.isDisabled().catch(() => true)) continue;
      await button.click({ timeout: 5_000 }).catch(() => {});
      completed += 1;
    }
    if (completed !== controls.length) {
      return { drove: completed > 0, status: "undriveable",
        detail: `only ${completed} of ${controls.length} required working export controls could be exercised` };
    }
    drove = true;
    contractDriven = true;
  }
  if (!navigated && !contractDriven && /\bundo and redo\b/i.test(action)) {
    const undoControl = await firstVisible([page.getByRole("button", { name: /\bundo\b/i })], deadline);
    const redoControl = await firstVisible([page.getByRole("button", { name: /\bredo\b/i })], deadline);
    if (!undoControl || !redoControl) {
      return { drove: false, status: "undriveable", detail: "both Undo and Redo controls were not visible" };
    }
    await undoControl.click({ timeout: 5_000 });
    await page.waitForTimeout(500);
    await redoControl.click({ timeout: 5_000 });
    await page.waitForTimeout(500);
    drove = true;
    contractDriven = true;
  }
  if (!navigated && !contractDriven && /open (?:the )?version history/i.test(action)) {
    const summary = await firstVisible([page.getByText(/open version history/i)], deadline);
    if (!summary) return { drove: false, status: "undriveable", detail: "no version-history control was visible" };
    await summary.click({ timeout: 5_000 });
    await page.waitForTimeout(400);
    drove = true;
    contractDriven = true;
  }
  if (!navigated && !contractDriven && /open (?:the )?duplicate/i.test(action)) {
    const duplicate = await firstVisible([page.getByRole("button", { name: /\bcopy\b|\bduplicate\b/i })], deadline);
    if (!duplicate) return { drove: false, status: "undriveable", detail: "no duplicated history item was visible" };
    await duplicate.click({ timeout: 5_000 });
    await page.waitForTimeout(500);
    drove = true;
    contractDriven = true;
  }

  // A fill is not a commit. When one contracted step types values AND owns a durable action,
  // activate that exact action even though `drove` is already true from typing.
  if (!navigated && !contractDriven && !observationOnly) {
    const contractedAction = interactionFlows.find((flow) => flow.control
      && ["mutation", "cancellation", "lookup", "action"].includes(flow.kind));
    if (contractedAction) {
      const activation = {};
      activation.requiredAtContractedStep = true;
      let activated = await activateContractedControl(page, contractedAction.control, {
        verifierPolicy, evidence: activation,
        // The same operation may be placed in both a primary panel and its contextual empty/list
        // state. It is safe to choose one stable exact match only when the outcome is independently
        // proved by a native reset or a named collection-member removal transition.
        allowEquivalentCandidates: requestsSingleCollectionMemberAction(step)
          || Boolean(removalSpec) || resetExpected,
        preferredMemberMarker: removalBaseline.targetPresent ? removalBaseline.marker : null,
      });
      // Hand-wired generated forms may carry the contracted FIELD identity without carrying the
      // companion action identity. The only safe fallback is that field's own form submit; never
      // another form and never a keyword-selected page button.
      if (!activated && filledContractedInputs.length) {
        for (const input of filledContractedInputs) {
          const id = input.control?.machineId;
          if (!id) continue;
          const submit = page.locator(`form:has([data-thrallo-control="${id}"]) button[type="submit"]:visible`).first();
          if (!(await submit.count().catch(() => 0)) || await submit.isDisabled().catch(() => true)) continue;
          await submit.click({ timeout: 5_000 }).catch(() => {});
          activated = true;
          activation.matchedBy = "contracted_field_form_submit";
          delete activation.reason;
          break;
        }
      }
      // A transient operation can be owned by the field that triggers it. Search-as-you-type and
      // live filters are the canonical shape: the contract records both the input write and the
      // derived result operation, but the customer did not ask for a second Apply button. Accept
      // that coalescing only when the operation consumes this step's exact input state, the step
      // names no explicit activation, and the contracted result became freshly visible. Durable
      // mutations and explicit click/apply/reset steps still require their own control identity.
      if (!activated && contractedAction.kind === "action" && filledContractedInputs.length
        && !/\b(click|press|tap|submit|apply|activate|run|trigger|confirm|save|delete|remove|clear|reset)\b/i.test(action)) {
        const inputWrites = new Set(filledContractedInputs.flatMap((flow) => flow.writes || []));
        const consumesFilledInput = (contractedAction.reads || []).some((path) => inputWrites.has(path));
        if (consumesFilledInput) {
          const transitionDeadline = Date.now() + 3_000;
          let expectationEvidence = await expectationBecameVisible(page, expect, textBefore);
          let autoAppliedStateChanged = await page.evaluate(() => document.body?.innerText || "")
            .then((text) => text !== textBefore).catch(() => false);
          while (!expectationEvidence.met && !autoAppliedStateChanged && Date.now() < transitionDeadline) {
            await page.waitForTimeout(200);
            expectationEvidence = await expectationBecameVisible(page, expect, textBefore);
            autoAppliedStateChanged = await page.evaluate(() => document.body?.innerText || "")
              .then((text) => text !== textBefore).catch(() => false);
          }
          if (expectationEvidence.met || autoAppliedStateChanged) {
            activated = true;
            activation.matchedBy = "contracted_input_auto_applied_action";
            activation.expectationEvidence = expectationEvidence;
            activation.stateChanged = autoAppliedStateChanged || undefined;
            delete activation.reason;
          }
        }
      }
      if (!activated) {
        return { drove, status: "undriveable",
          detail: `the contracted ${contractedAction.kind} control was not offered (${contractedAction.control.accessibleName})`,
          controlEvidence: { ...(controlEvidence || {}), activation } };
      }
      controlEvidence = { ...(controlEvidence || {}), activation };
      drove = true;
      contractDriven = true;
    }
  }

  // "use" joined the verb list after a live run: "use the page navigation (Contact
  // navigation link)" drove nothing and the whole journey went undriveable-then-fail.
  if (!navigated && !droveStepper && !contractDriven && !observationOnly
      && /click|select|choose|submit|press|tap|continue|advance|proceed|confirm|cancel|sign|book|use|duplicate|download|delete|rename|apply/i.test(action)) {
    // A submit-shaped step acts on the form the journey just filled: that form's OWN submit
    // control outranks every keyword candidate. Live proof (bv2 run 5): keyword matching sent
    // "fill in … and submit (contact form)" to a nav button named "Contact navigation link"
    // while the real type=submit button sat below it, and a working app failed verification.
    let target = null;
    // A REVIEW step observes; it does not act. Keyword matching sent "review the booking" to a
    // link named "Look up booking" — /book/ matched — and the driver navigated out of the wizard,
    // after which the review could never be found. An observation step may click only a control
    // that names itself a review, and otherwise reaches its screen by advancing the flow below.
    const isReviewObservation = interactionFlows.some((flow) => flow.kind === "review");
    if (isReviewObservation) {
      for (const role of DRIVEABLE_ACTION_ROLES) {
        const candidate = page.getByRole(role, { name: /^\s*review\b/i }).first();
        if (!(await candidate.count().catch(() => 0))) continue;
        if (!(await candidate.isVisible().catch(() => false))) continue;
        target = candidate;
        break;
      }
      if (target) {
        await target.click({ timeout: 5_000 }).catch(() => {});
        drove = true;
      }
      target = null; // never fall through to keyword or last-button guessing
    } else if (/submit|send/i.test(action)) {
      const formSubmit = page
        .locator("form:has(input:visible) button[type=submit]:visible, form:has(textarea:visible) button[type=submit]:visible")
        .last();
      if (await formSubmit.count().catch(() => 0)) target = formSubmit;
    }
    if (!target && !isReviewObservation) {
      const description = `${step.target || ""} ${action}`;
      target = await bestVisibleAction(page, description, deadline)
        || await firstVisible(candidatesFor(page, description), deadline);
    }
    if (target) {
      await target.click({ timeout: 5_000 }).catch(() => {});
      drove = true;
    } else if (!isReviewObservation && !minimal) {
      // A submit control the description did not name: the last enabled submit-ish button.
      const submit = page.locator("button[type=submit]:visible, button:visible").last();
      if (await submit.count().catch(() => 0)) {
        await submit.click({ timeout: 5_000 }).catch(() => {});
        drove = true;
      }
    }
  }

  // A contracted REVIEW step writes nothing, so nothing above drives it, and in a step-gated flow
  // its screen is one transition away. Advancing is allowed here for the same bounded reason as
  // above — and it cannot manufacture a pass, because a review is judged on whether it shows the
  // exact values that were actually entered, which no amount of navigation can fabricate.
  // Gated on the OUTCOME, not on whether something was clicked. "review the booking" matches the
  // generic click path's /book/, which then found the words "Booking wizard" in a heading and
  // clicked the paragraph — inert, but enough to set `drove`, so an earlier version of this branch
  // never ran and a working review step failed. What matters is whether the review is on screen.
  if (!navigated && interactionFlows.some((flow) => flow.kind === "review")
    && !(await expectationBecameVisible(page, expect, textBefore)).met) {
    const advances = [];
    for (let attempt = 0; attempt < MAX_FLOW_ADVANCES; attempt += 1) {
      const advance = await advanceFlow(page);
      advances.push(advance);
      if (!advance.advanced) break;
      drove = true;
      if ((await expectationBecameVisible(page, expect, textBefore)).met) break;
    }
    controlEvidence = { ...(controlEvidence || {}), flowAdvances: advances };
  }

  await page.waitForTimeout(900);

  // The expectation. Text the contract named, present and visible on the page.
  const wanted = keywords(expect, 5);
  if (!wanted.length) return { drove, status: "undriveable", detail: "the expectation named nothing findable" };

  const before = textBefore.toLowerCase();
  // A first anonymous write legitimately takes seconds (visitor-session establishment plus
  // the insert; longer on an edge-function cold start) — a fixed 900ms sample failed a
  // WORKING app live. A driven step therefore polls until its outcome appears or 10s
  // passes; undriven/static checks still resolve on the first sample.
  let found = [];
  let fresh = [];
  let observedStateChanged = false;
  let resetEvidence = { checked: false, ok: false, changes: [] };
  // Submit-shaped outcomes ride a real backend round-trip — visitor-session establishment
  // through the app-auth edge function measured ~12s on a cold start, past the 10s window.
  const mutationFlow = durableTransitionFlow(interactionFlows);
  const commits = interactionFlows.length
    ? interactionFlows.some((flow) => ["mutation", "cancellation"].includes(flow.kind))
    : /submit|send|confirm|book|reserve|pay/i.test(action);
  const requiresExplicitOutcome = commits || interactionFlows.some((flow) => (
    ["action", "mutation", "cancellation", "lookup", "recovery", "flow_start"].includes(flow.kind)
  ));
  const isReviewStep = interactionFlows.some((flow) => flow.kind === "review");
  const reviewValues = isReviewStep ? reviewValuesForStep(step, enteredValues) : [];
  const hasNoStepWrites = !(step.operates || []).length
    && !interactionFlows.some((flow) => flow.control
      || (flow.writes || []).length > 0
      || ["navigation", "recovery", "mutation", "cancellation", "lookup", "action"].includes(flow.kind));
  const readOnlyAssertion = (minimal && observationOnly) || (hasNoStepWrites && (
    observationOnly
      || (Array.isArray(step.reads) && step.reads.length > 0)
      || (isReviewStep && reviewValues.length === 0)
  ));
  const pollBudget = !drove ? 0 : commits ? 20_000 : 10_000;
  const pollDeadline = Date.now() + pollBudget;
  let mutationEvidence = { checked: false, ok: false };
  let removalEvidence = { checked: false, ok: false };
  let collectionMembershipEvidence = { checked: false, ok: false, present: [], missing: [] };
  for (;;) {
    found = [];
    fresh = [];
    for (const word of wanted) {
      const hit = await anyVisibleTextMatch(page, word);
      if (!hit) continue;
      found.push(word);
      // New since the step ran, which is the only kind of evidence that the step DID something.
      if (!before.includes(word)) fresh.push(word);
    }
    const currentText = await page.evaluate(() => document.body?.innerText || "").catch(() => textBefore);
    observedStateChanged = currentText !== textBefore || page.url() !== urlBefore;
    if (resetExpected) resetEvidence = controlResetTransition(controlsBefore, await visibleControlState(page));
    if (removalFlow && removalBaseline.targetPresent) {
      const current = await collectionActionMemberState(page, removalSpec, removalFlow.control,
        { marker: removalBaseline.marker });
      const postcondition = await removalPositiveState(page, removalSpec, removalBaseline, current);
      removalEvidence = {
        checked: true,
        ok: current.targetMemberCount < removalBaseline.targetMemberCount && postcondition.ok,
        target: removalSpec.target,
        beforeCount: removalBaseline.targetMemberCount,
        afterCount: current.targetMemberCount,
        postcondition,
      };
    }
    if (collectionMembershipSpec) {
      collectionMembershipEvidence = await collectionMembershipState(page, collectionMembershipSpec);
    }
    if (mutationFlow && found.length / wanted.length >= 0.5 && fresh.length === 0) {
      const textAfter = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      mutationEvidence = mutationCommitEvidence({
        flow: mutationFlow, enteredValues, textBefore, textAfter,
      });
    }
    if (Date.now() >= pollDeadline) break;
    const early = expectationOutcome({ wanted, found, fresh, drove, action,
      urlChanged: page.url() !== urlBefore, readOnlyAssertion,
      mutationWithValues: mutationEvidence.ok, verifierPolicy,
      stateChanged: (observedStateChanged && !requiresExplicitOutcome) || resetEvidence.ok || removalEvidence.ok,
      requiredStateTransition: removalBaseline.targetPresent,
      collectionStateRequired: Boolean(collectionMembershipSpec),
      collectionStateSatisfied: collectionMembershipEvidence.ok,
      actionProven: contractDriven || navigated || filledSomething || droveStepper });
    if (early.status === "pass") break;
    await page.waitForTimeout(500);
  }

  if (viewportChanged && minimal) {
    const layout = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body?.scrollWidth || 0,
    })).catch(() => null);
    controlEvidence = { ...(controlEvidence || {}), advisories: [
      ...((controlEvidence || {}).advisories || []),
      { code: "responsive_layout_advisory", layout },
    ] };
  } else if (viewportChanged) {
    const layout = await page.evaluate(() => ({
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body?.scrollWidth || 0,
    })).catch(() => null);
    if (!layout) return { drove: true, status: "undriveable", detail: "responsive layout could not be measured" };
    const overflow = Math.max(layout.scrollWidth, layout.bodyScrollWidth) > layout.width + 2;
    if (overflow) {
      return { drove: true, status: "fail",
        detail: `the ${layout.width}px viewport has horizontal overflow (${Math.max(layout.scrollWidth, layout.bodyScrollWidth)}px)` };
    }
    if (found.length / wanted.length >= 0.5) {
      return { drove: true, status: "pass",
        detail: `the viewport reflowed to ${layout.width}px without horizontal overflow; visible: ${found.join(", ")}` };
    }
    return { drove: true, status: "fail",
      detail: `the viewport reflowed without overflow, but expected responsive controls were not visible (found ${found.join(", ") || "none"})` };
  }

  // A stepper-driven step is judged on the OBSERVABLE transition: the counter's page text
  // changed (2 → 3 is a real state change) while the expectation words are usually meta-
  // prose ("summary updates with counts") that exists statically. Live evidence: a working
  // guest counter failed as "nothing changed" because every keyword was already on screen.
  if (droveStepper && found.length / wanted.length >= 0.5) {
    const textAfter = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (textAfter !== textBefore) {
      // Carry the control facts the contracted fill already gathered. Returning without them threw
      // away the only record of WHICH control a counter step drove — the exact evidence that
      // identified the party-size collision after a paid run.
      return { drove, status: "pass", controlEvidence,
        detail: `counter changed the page (${found.join(", ")} present)` };
    }
  }

  // Some expectations are about FORM STATE, not visible text — "the fields accept the details",
  // "continue becomes enabled". Searching the page for the word "fields" will never satisfy those,
  // and reporting them as failures would blame the app for the driver's literalism. So when the
  // step filled something, ask the page the question the step was really asking. Applies BOTH
  // when the words are missing AND when they are all static (nothing fresh) — a live fill step
  // failed as "nothing changed" purely because its meta-words pre-existed on the page.
  //
  // ONLY when this step actually filled something. The rule is about a fill, and it returns early,
  // so an unfilled step reaching it takes a pass on inputs it never touched — and skips the
  // durable-record judgement below, which is the stronger claim and the right one. A CRM whose
  // manage screen carries an edit form passed "reload the page ⇒ the updated lead is recovered"
  // on "3/4 fields hold values", proving only that a form was populated.
  //
  // And NEVER for a step that claims a durable record. "enter a reference ⇒ the saved lead details
  // are displayed" filled its one field and passed as "1/1 fields hold values" against an app that
  // displayed nothing at all, because the expectation happens to contain the word "details". A step
  // that looks a record up or recovers one is answerable only by that record.
  //
  // WHICH steps this applies to is a structured question, not a lexical one. It used to be armed
  // by finding one of field/detail/input/form/accept/valid/enabled/complete in the expectation,
  // so whether a correct application passed depended on the adjective the contract happened to
  // use. The contract already says, structurally, that this step operates input controls.
  const claimsDurableRecord = interactionFlows.some((flow) => ["recovery", "lookup"].includes(flow.kind));
  const fillsContractedFields = contractedInputs.length > 0
    // V1 and any contract that typed nothing for this step: prose is all there is, so it still
    // answers here. It no longer answers for anything the contract DID type.
    || (!interactionFlows.length && /field|detail|input|form|accept|valid|enabled|complete/i.test(expect));
  if (filledSomething && !claimsDurableRecord && fillsContractedFields
    && (found.length / wanted.length < 0.5 || fresh.length === 0)) {
    const state = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input, textarea, select")]
        .filter((el) => el.offsetParent !== null && !["hidden", "submit", "button"].includes(el.type));
      const filled = inputs.filter((el) => (el.type === "checkbox" || el.type === "radio" ? el.checked : String(el.value || "").trim().length > 0));
      const enabled = [...document.querySelectorAll("button")].filter((b) => b.offsetParent !== null && !b.disabled);
      return { inputs: inputs.length, filled: filled.length, enabledButtons: enabled.length };
    }).catch(() => null);

    if (state && state.inputs > 0 && state.filled >= Math.ceil(state.inputs / 2)) {
      return { drove, status: "pass", detail: `${state.filled}/${state.inputs} fields hold values`, controlEvidence };
    }
    // "Progression becomes possible" has a machine meaning now: the declared forward control is
    // on screen and no longer refuses. Reading the word "enabled" out of the expectation proved
    // the same thing for one phrasing and nothing for any other.
    if (state && state.enabledButtons > 0) {
      const forward = page.locator(`[data-thrallo-action="${ADVANCE_ACTION_ID}"]`).first();
      const ready = await forward.count().catch(() => 0)
        && await forward.isVisible().catch(() => false)
        && !(await forward.isDisabled().catch(() => true));
      if (ready) return { drove, status: "pass", detail: "the declared advance control is enabled" };
      if (!interactionFlows.length && /enabled/i.test(expect)) {
        return { drove, status: "pass", detail: `${state.enabledButtons} control(s) enabled` };
      }
    }
  }

  // A click that changed the URL is a navigation whatever verb the contract used: the CTA step
  // failed live because the words it expected existed on the HOME page too — but the whole page
  // was new, which is exactly the navigational exemption.
  const urlChanged = page.url() !== urlBefore;
  // The exact-value review exemption is armed ONLY when this step declares values to check, so
  // the stronger verification below always runs in its place. A calculated-results review with
  // no exact input reads is the structured read-only assertion computed above.
  const outcome = expectationOutcome({
    wanted, found, fresh, drove, action, urlChanged,
    reviewWithValues: isReviewStep && reviewValues.length > 0,
    mutationWithValues: mutationEvidence.ok,
    readOnlyAssertion,
    // A whole page arrives at once for a navigation or a reload, so nothing in it can be "new".
    // Typed by the contract where the contract typed the step.
    navigational: interactionFlows.length
      ? interactionFlows.some((flow) => ["navigation", "recovery"].includes(flow.kind))
      : null,
    // Isolated verification has just reconstructed this secondary journey's durable prerequisite.
    // Its first step often asserts that starting state. The contracted evidence must still be
    // present, but it cannot also be newly added after the setup that made it present.
    establishedState: allowEstablishedState,
    verifierPolicy,
    stateChanged: (observedStateChanged && !requiresExplicitOutcome) || resetEvidence.ok || removalEvidence.ok,
    requiredStateTransition: removalBaseline.targetPresent,
    collectionStateRequired: Boolean(collectionMembershipSpec),
    collectionStateSatisfied: collectionMembershipEvidence.ok,
    actionProven: contractDriven || navigated || filledSomething || droveStepper || Boolean(route),
  });
  if (resetEvidence.checked) {
    controlEvidence = { ...(controlEvidence || {}), resetTransition: resetEvidence };
  }
  if (removalEvidence.checked) {
    controlEvidence = { ...(controlEvidence || {}), removalTransition: removalEvidence };
  }
  if (collectionMembershipEvidence.checked) {
    controlEvidence = { ...(controlEvidence || {}), collectionMembership: collectionMembershipEvidence };
  }

  if (outcome.status === "pass" && isReviewStep && reviewValues.length) {
    const reviewText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const missingValues = reviewValues.filter(({ value }) => !reviewText.includes(value));
    if (missingValues.length) return { ...outcome, status: "fail",
      ...(minimal ? { classification: VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE } : {}),
      detail: `review omitted exact contracted values: ${missingValues.map((row) => row.field).join(", ")}`,
      controlEvidence: { enteredValues: reviewValues, missingValues } };
    outcome.detail += ` · review contains ${reviewValues.length} exact entered value(s)`;
  }
  if (outcome.status === "pass" && mutationEvidence.ok) {
    outcome.detail += ` · mutation rendered ${mutationEvidence.visibleValues.length} exact value(s)`;
    if (mutationEvidence.stableReferences?.length) {
      outcome.detail += ` against ${mutationEvidence.stableReferences[0]}`;
    } else if (mutationEvidence.newReferences?.length) {
      outcome.detail += ` with ${mutationEvidence.newReferences[0]}`;
    }
  }

  // A step that CONSUMES earlier values must show them — the numbers in a chosen date or slot
  // survive any formatting.
  //
  // Which steps consume them is the contract's statement, not a guess from its wording. This rule
  // used to arm on confirmation/reference/summary/booking details appearing in the expectation,
  // and on 2026-08-12 it ended a paid run: the app rendered exactly what its step asked for — a
  // confirmation with status Confirmed and a durable reference — passed that check, and was then
  // failed for omitting values the step never said it displayed. The step read the OPERATION
  // (`create-booking`); the review step before it read the six draft fields and was verified on
  // them, and the recovery step after it would have proved durability properly, had this rule not
  // blocked the journey first. So: the values are demanded of the steps whose declared reads are
  // those values, and of no others.
  // There is no structured fact that says a COMMIT step must render what it commits. Its reads are
  // the values it writes, which every mutation has, so keying the rule on them fails exactly the
  // steps the word list failed. The contract states the display requirement in two places, and
  // both are already judged from structure: the REVIEW step, verified above against the exact
  // entered values, and the RECOVERY step, verified below against the durable record. So this is
  // now evidence, not a verdict — a repair prompt still learns that the confirmation showed none
  // of the selections, and a correct application is no longer failed for it.
  if (outcome.status === "pass" && selections.length) {
    const textAfter = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const reflect = confirmationReflectsSelections(textAfter, selections);
    if (reflect.checked) {
      outcome.detail += reflect.ok
        ? ` · reflects the selection (${reflect.matched})`
        : ` · note: ${reflect.detail}`;
    }
  }
  // A recovery or lookup step is judged on DURABLE STATE, never on whether the page narrates
  // itself. The evidence was captured when the mutation succeeded; if it survived, the step
  // passed however the app words it, and if it did not, no vocabulary can rescue it.
  // Evidence may have been created by an EARLIER contracted journey — the primary makes the
  // booking, the recovery journey proves that same record survived. The link is canonical
  // (capability + durable entity), never prose, so one entity's record cannot answer for another.
  // A step that merely OPENS the lookup area is navigation, not recovery: the record cannot be on
  // screen before it has been asked for, and judging it on durable evidence failed a correct app
  // at its first step. Only a step that actually recovers or looks up is measured that way.
  // Narrow: a ROUTE navigation only. A reload IS the recovery step and must stay semantic.
  // Structured when the contract typed the step, prose only for contracts that typed nothing.
  const openedARoute = Boolean(route) && (interactionFlows.length
    ? interactionFlows.some((flow) => flow.kind === "navigation")
    : /open|go to|navigate|visit/i.test(action));
  const recoveryFlow = openedARoute ? null
    : interactionFlows.find((flow) => ["recovery", "lookup"].includes(flow.kind));
  const shared = recoveryFlow ? runEvidence.get(durableRecordKey(recoveryFlow)) : null;
  // Evidence from ANOTHER journey is about the record, not about the screen that made it.
  const evidence = durable.captured ? durable : (shared ? { ...shared, sameSurface: false } : durable);
  const recovers = Boolean(recoveryFlow);
  if (recovers && evidence.captured) {
    const textAfter = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const verdict = recoveryEvidenceVerdict(evidence, textAfter);
    if (verdict.checked) {
      return { ...outcome, status: verdict.ok ? "pass" : "fail", detail: verdict.detail,
        ...(minimal ? { classification: verdict.ok ? VERIFICATION_RESULT_CLASS.PASS
          : VERIFICATION_RESULT_CLASS.PERSISTENCE_FAILURE } : {}),
        controlEvidence: { ...(controlEvidence || {}), durable: evidence } };
    }
  }
  if (outcome.status === "pass" && mutationFlow) {
    Object.assign(durable, await captureDurableEvidence(page, { enteredValues, selections, expect }));
    // Run-scoped and canonically keyed, so a later contracted journey can prove this same record
    // survived. It never outlives one verifyJourneys call, so nothing crosses a build or a user.
    runEvidence.set(durableRecordKey(mutationFlow), { ...durable });
  }
  return controlEvidence ? { ...outcome, controlEvidence } : outcome;
}

/**
 * The step verdict, pure and exported: given what the contract wanted, what is visible, and what
 * is NEWLY visible since before the action, decide the outcome. Exported so the freshness rule —
 * static pre-existing copy proves nothing; only change caused by the action counts — can be
 * proven directly, and so the stage prompts (which now teach TRANSITIONS, not vocabulary) are
 * demonstrably aligned with what this actually tests.
 *
 * A majority of the named things on screen is the bar — requiring all would fail on synonyms,
 * requiring one would pass on coincidence. Plus, for any step that CHANGED something, at least
 * one of those matches must be new: a step whose every match was already there has demonstrated
 * nothing. Navigation and reload are exempt, since the whole page is new by definition.
 */
export function expectationOutcome({
  wanted, found, fresh, drove, action, urlChanged = false, reviewWithValues = false,
  mutationWithValues = false, navigational: declaredNavigational = null, establishedState = false,
  readOnlyAssertion = false, verifierPolicy = LEGACY_RICH_VERIFIER_POLICY,
  stateChanged = false, requiredStateTransition = false, actionProven = false,
  collectionStateRequired = false, collectionStateSatisfied = false,
}) {
  const ratio = found.length / wanted.length;
  if (collectionStateRequired && !collectionStateSatisfied) {
    if (isMinimalContractVerifier(verifierPolicy)) {
      return verificationVerdict(drove && actionProven
        ? VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE
        : VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE,
      drove && actionProven
        ? "the contracted action ran, but the named collection does not contain every required member"
        : "the verifier could not establish the required collection membership",
      { drove });
    }
    return { drove, status: drove && actionProven ? "fail" : "undriveable",
      detail: drove && actionProven
        ? "the contracted action ran, but the named collection does not contain every required member"
        : "the verifier could not establish the required collection membership" };
  }
  if (requiredStateTransition && !stateChanged) {
    if (isMinimalContractVerifier(verifierPolicy)) {
      return verificationVerdict(drove && actionProven
        ? VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE
        : VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE,
      drove && actionProven
        ? "the contracted removal action ran, but the collection member did not leave its required state"
        : "the verifier could not establish the contracted removal transition",
      { drove });
    }
    return { drove, status: drove && actionProven ? "fail" : "undriveable",
      detail: drove && actionProven
        ? "the contracted removal action ran, but the collection member did not leave its required state"
        : "the verifier could not establish the contracted removal transition" };
  }
  if (isMinimalContractVerifier(verifierPolicy)) {
    if (ratio >= 0.5 || reviewWithValues || mutationWithValues || urlChanged || stateChanged
      || (collectionStateRequired && collectionStateSatisfied)) {
      const advisory = ratio >= 0.5 && !fresh.length && drove && !urlChanged && !stateChanged
        ? [{ code: "text_freshness_not_observed", detail: "the contracted result was already visible" }]
        : [];
      return verificationVerdict(VERIFICATION_RESULT_CLASS.PASS,
        collectionStateRequired && collectionStateSatisfied
          ? "the contracted collection contains its required member"
          : ratio >= 0.5 ? `contracted result visible: ${found.join(", ")}`
          : urlChanged ? "the contracted navigation changed route"
            : "the contracted action produced an observable state change",
        { drove, readOnlyAssertion: readOnlyAssertion || undefined, advisories: advisory });
    }
    if (!drove || !actionProven || readOnlyAssertion) {
      return verificationVerdict(VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE,
        readOnlyAssertion
          ? `the verifier could not establish the observation from contract evidence (${wanted.join(", ") || "no exact outcome"})`
          : `the verifier could not reliably drive the contracted action: ${action.slice(0, 80)}`,
        { drove, readOnlyAssertion: readOnlyAssertion || undefined });
    }
    return verificationVerdict(VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE,
      `the contracted action was performed but its required result did not occur (${wanted.join(", ") || "no observable result"})`,
      { drove });
  }
  // A REVIEW step is the one place the freshness rule marks correct applications broken. Showing
  // the running selection as it is made is good UX, so by the time review runs its words are
  // already on screen and nothing can be "new" — four live qualifications failed here with
  // "nothing changed … was already on the page before this step" while the app worked.
  //
  // The exemption is narrow and only ever trades freshness for a STRONGER check: it applies
  // solely when the caller has exact contracted values to verify, and the caller then fails the
  // step unless the review actually contains every one of them. "New words appeared" becomes
  // "the real values are shown", which is what the contract meant by review in the first place.
  if (reviewWithValues && ratio >= 0.5) {
    return { drove, status: "pass", reviewExempt: true,
      detail: `found: ${found.join(", ")} (review: values verified below)` };
  }

  // A durable mutation may legitimately render the expectation's nouns before Save. The caller
  // only arms this exemption after the mutation renders every exact declared input, at least one
  // newly as page text, against a preserved or newly-created durable reference. Recovery remains
  // a separate required step and is what rejects a UI-only update.
  if (mutationWithValues && ratio >= 0.5) {
    return { drove, status: "pass", mutationEvidence: true,
      detail: `found: ${found.join(", ")} (mutation: exact values verified)` };
  }

  // A structured read-only step (inspect/compare) asserts state produced by an earlier action.
  // It deliberately drives nothing, so freshness is inapplicable; the expected evidence still
  // has to meet the same majority bar and missing evidence is a behavioural failure.
  if (readOnlyAssertion) {
    return ratio >= 0.5
      ? { drove, status: "pass", readOnlyAssertion: true,
        detail: `found: ${found.join(", ")} (read-only assertion)` }
      : { drove, status: "fail", readOnlyAssertion: true,
        detail: `expected ${wanted.join(", ")}; found ${found.join(", ") || "none"}` };
  }
  // jump/scroll/navigation joined the navigational class after a live run: a single-page
  // app renders every section statically, so "use the navigation to jump to services" can
  // never produce FRESH words — static presence at ≥half the keywords is the right bar.
  // Whether a step is navigational is a fact the contract types (navigation, recovery, a route
  // primitive). The caller passes that in; the word list below answers only for contracts that
  // typed nothing, and a URL change always answers for itself.
  const navigational = urlChanged || (declaredNavigational === null
    ? /open|go to|navigate|navigation|visit|reload|refresh|jump|scroll/i.test(action)
    : declaredNavigational);
  if (ratio >= 0.5 && (navigational || fresh.length > 0 || establishedState)) {
    return { drove, status: "pass", detail: `found: ${found.join(", ")}${fresh.length ? ` (new: ${fresh.join(", ")})` : ""}` };
  }
  if (!drove) return { drove, status: "undriveable", detail: `could not drive: ${action.slice(0, 80)}` };
  if (ratio >= 0.5) {
    const missing = wanted.filter((w) => !found.includes(w));
    return {
      drove,
      status: "fail",
      // Both halves, because a repair needs to know what was expected as well as what did not move.
      detail: `nothing changed — "${found.join(", ")}" was already on the page before this step`
        + `${missing.length ? `, and ${missing.join(", ")} never appeared` : ""}`,
    };
  }
  return { drove, status: "fail", detail: `expected ${wanted.join(", ")}; found ${found.join(", ") || "none"}` };
}

// ── journey prerequisites ─────────────────────────────────────────────────────────────────────
//
// Contracted secondary journeys routinely begin mid-flow — "select a date and slot with limited
// remaining seats", "advance to the contact details step" — while browser verification starts
// from a clean load. Nothing told the driver how to reach that state, so two working journeys
// were reported undriveable for starting somewhere impossible.
//
// The path is derived from the canonical interaction contract, never from prose: the PRIMARY
// journey already states, in order, every contracted control that leads to each point in the
// flow. A secondary journey's prerequisites are simply the primary's controls that come before
// the first control the secondary drives itself.

/** @returns {{controls: object[], requiresDurableRecord: boolean}} */
export function journeyPrerequisites(flows, journeyId, primaryId, {
  requiresPrimaryRecord = false, reconstructIsolated = false,
} = {}) {
  const routeTarget = (flow) => flow?.kind === "navigation"
    && /^\/[\w/-]*$/.test(String(flow?.target || "").trim())
    && String(flow.target).trim() !== "/"
    ? String(flow.target).trim() : null;
  const controlKey = (flow) => routeTarget(flow)
    ? `route:${routeTarget(flow)}`
    : semanticKey(flow.control?.logicalField || flow.control?.accessibleName);
  const ordered = (id) => flows.filter((flow) => flow.journeyId === id
      && (flow.control || routeTarget(flow)))
    .sort((a, b) => {
      const step = a.stepIndex - b.stepIndex;
      if (step) return step;
      const order = { flow_start: 0, navigation: 0, input: 1, selection: 1,
        flow_advance: 2, mutation: 3, action: 3, cancellation: 3, review: 4, recovery: 4 };
      return (order[a.kind] ?? 2) - (order[b.kind] ?? 2);
    });
  const mine = ordered(journeyId);
  const requiresDurableRecord = flows.some((flow) => flow.journeyId === journeyId
    && (flow.reads || []).some((path) => /\.durable\./.test(path)));
  if (journeyId === primaryId || (!mine.length && !reconstructIsolated)) {
    return { controls: [], requiresDurableRecord };
  }

  const chain = ordered(primaryId);
  // Entering the flow at all — "start booking control" and friends. Every journey that drives a
  // contracted control inside the flow needs these, including one whose own first control is the
  // very first selection.
  const entry = chain.slice(0, Math.max(0, chain.findIndex((flow) => ["selection", "input"].includes(flow.kind))));
  // A journey that works from an existing RECORD (lookup, cancellation) does not re-walk the
  // wizard: its precondition is the durable row the primary journey already created.
  if (requiresDurableRecord && !reconstructIsolated
    && flows.some((flow) => flow.journeyId === journeyId && flow.kind === "lookup")) {
    return { controls: [], requiresDurableRecord };
  }
  // An isolated journey that starts from an EXISTING record needs exactly the producing journey
  // through its durable commit. It must not continue into later read/inspection controls merely
  // because a historical contract gave those fields the same names as this journey's controls.
  // The retained Roblox candidate reached this point, created the row successfully, then setup
  // demanded a fictitious modelSpec chooser that exists only as generated output.
  if (requiresPrimaryRecord || (reconstructIsolated && requiresDurableRecord)) {
    const durableMutation = chain.findIndex((flow) => flow.kind === "mutation" && flow.durableLifecycle);
    return { controls: durableMutation >= 0 ? chain.slice(0, durableMutation + 1) : chain,
      requiresDurableRecord: true };
  }
  const firstOwn = mine.map(controlKey).find((key) => chain.some((flow) => controlKey(flow) === key));
  // A secondary surface may name a control that does not exist in the primary flow (for example
  // a history item). It still needs the primary's authenticated durable setup. Returning no
  // prerequisites made every isolated secondary journey start signed out with no saved record.
  if (!firstOwn) {
    return { controls: reconstructIsolated ? entry : [], requiresDurableRecord };
  }
  const stop = chain.findIndex((flow) => controlKey(flow) === firstOwn);
  if (stop <= 0) return { controls: entry, requiresDurableRecord };
  // EVERYTHING the primary drives before that point. It used to subtract whatever this journey
  // drives itself, which is wrong whenever the journey drives it LATER: "amend the guest name,
  // then change the date" enters at the guest name, so the date and slot before it are still
  // required to get there — and dropping the date left the setup selecting a slot on a screen that
  // has no date yet. A control this journey re-drives after entry is simply driven twice, which
  // costs a click and proves the same thing.
  return { controls: chain.slice(0, stop), requiresDurableRecord };
}

/**
 * Put the application into a journey's required starting state using ALREADY-PROVEN semantic
 * interactions — the same identity-matched selection and contracted-field driving the journeys
 * themselves use. Nothing is guessed: a prerequisite that cannot be established is reported as a
 * machine-readable setup failure, and the journey is NOT_REACHED rather than failed.
 */
async function establishPrerequisites(page, controls, {
  marker, authMarker = marker, journeyFlows, verifierPolicy = LEGACY_RICH_VERIFIER_POLICY,
}) {
  const performed = [];
  // Exact values entered while reconstructing the producing journey. They are not satisfied by
  // an input's DOM value because body.innerText excludes form values; one must be rendered by the
  // resulting durable record (or the mutation must produce a new reference token).
  const enteredValues = [];
  let durableCommitted = false;
  for (const flow of controls) {
    const route = flow.kind === "navigation" && /^\/[\w/-]*$/.test(String(flow.target || "").trim())
      ? String(flow.target).trim() : null;
    const label = route || flow.control?.logicalField || flow.control?.accessibleName || flow.kind;
    if (route) {
      const destination = new URL(route, page.url());
      // Prerequisite navigation is restricted to the preview's current origin. The interaction
      // contract can restore a route, never send the verifier to an external site.
      if (destination.origin !== new URL(page.url()).origin) {
        return { ok: false, performed, failure: { control: label, kind: flow.kind,
          reason: "the contracted prerequisite route left the preview origin" } };
      }
      const response = await page.goto(destination.href, {
        waitUntil: "domcontentloaded", timeout: 10_000,
      }).catch(() => null);
      if (!response && page.url() !== destination.href) {
        return { ok: false, performed, failure: { control: label, kind: flow.kind,
          reason: "the contracted prerequisite route could not be opened" } };
      }
      await waitForActiveSurface(page);
      performed.push({ control: label, kind: flow.kind, detail: `opened ${destination.pathname}` });
      continue;
    }
    if (flow.kind === "selection") {
      let outcome = await driveSelection(page, { action: `select ${label}`, expect: flow.observable || "" },
        flow, new Set(), journeyFlows);
      for (let attempt = 0; !outcome && attempt < MAX_FLOW_ADVANCES; attempt += 1) {
        if (!(await advanceFlow(page)).advanced) break;
        outcome = await driveSelection(page, { action: `select ${label}`, expect: flow.observable || "" },
          flow, new Set(), journeyFlows);
      }
      // SETUP is judged on arrival, not on presentation. A prerequisite selection only has to put
      // the flow where the journey needs it; whether that screen also narrates the contracted
      // outcome is the JOURNEY's business, and holding setup to it made a reachable state
      // unreachable. The contracted next control being visible is the arrival proof.
      // "Next" means the next PREREQUISITE in this chain, not the next flow of the journey under
      // test — the chain belongs to the producing journey, so asking the consumer's flows resolves
      // to nothing and a reachable state reads as unreachable.
      const nextInChain = controls[controls.indexOf(flow) + 1]?.control || null;
      const arrived = outcome?.status === "pass"
        || (outcome && nextInChain && await semanticControlVisible(page, nextInChain));
      if (!arrived) {
        return { ok: false, performed, failure: { control: label, kind: flow.kind,
          reason: outcome ? outcome.detail : "the contracted control was not reachable" } };
      }
      performed.push({ control: label, kind: flow.kind, detail: outcome.detail });
      continue;
    }
    if (flow.kind === "input") {
      let result = await fillContractedFields(page, [flow], marker, { verifierPolicy });
      for (let attempt = 0; !result.complete && attempt < MAX_FLOW_ADVANCES; attempt += 1) {
        if (!(await advanceFlow(page)).advanced) break;
        result = await fillContractedFields(page, [flow], marker, { verifierPolicy });
      }
      if (!result.complete) {
        return { ok: false, performed, failure: { control: label, kind: flow.kind, reason: "field not fillable" } };
      }
      enteredValues.push(...result.evidence.fields.filter((field) => field.status === "filled")
        .map((field) => field.expectedValue).filter(Boolean));
      performed.push({ control: label, kind: flow.kind, detail: `filled ${label}` });
      continue;
    }
    // A mutation/action control ("start booking control") — driven by its contracted accessible
    // name only, never by a keyword sweep, so an unrelated button can never stand in for it.
    let clicked = false;
    const textBefore = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    // A contract names controls descriptively — "start booking control", "Confirm booking
    // control" — while the button itself is labelled "Start booking". The generic control nouns
    // are stripped as a second attempt, so the description still resolves to the real control
    // without matching on prose.
    const aliases = unique(controlAliases(flow.control).flatMap((alias) => [alias,
      String(alias).replace(/\b(control|button|link|action)\b/gi, "").replace(/\s+/g, " ").trim()]));
    for (const alias of aliases) {
      for (const role of DRIVEABLE_ACTION_ROLES) {
        const candidate = page.getByRole(role, { name: new RegExp(`(^|\\W)${escapeRegex(alias)}(\\W|$)`, "i") }).first();
        if (!(await candidate.count().catch(() => 0))) continue;
        if (!(await candidate.isVisible().catch(() => false))) continue;
        await candidate.click({ timeout: 5_000 }).catch(() => {});
        clicked = true;
        break;
      }
      if (clicked) break;
    }
    if (!clicked) {
      return { ok: false, performed, failure: { control: label, kind: flow.kind, reason: "no contracted control matched" } };
    }
    await page.waitForTimeout(600);
    if (flow.kind === "flow_start" && isAuthenticationFlow(flow, { action: flow.control?.purpose })) {
      const authentication = await driveAuthenticationForm(page, `${authMarker}-setup`);
      if (!authentication.authenticated) {
        return { ok: false, performed, failure: { control: label, kind: flow.kind,
          reason: authentication.reason || "authentication did not complete" } };
      }
      performed.push({ control: label, kind: "authentication", detail: `authenticated ${authentication.email}` });
    }
    if (flow.kind === "mutation" && flow.durableLifecycle && flow.observable) {
      const deadline = Date.now() + 12_000;
      let visible = await expectationBecameVisible(page, flow.observable || "", textBefore);
      let textAfter = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
      let identity = durableCommitIdentity({ enteredValues, textBefore, textAfter });
      let { value: durableValue, reference: durableReference } = identity;
      while (!(visible.met && (durableValue || durableReference)) && Date.now() < deadline) {
        await page.waitForTimeout(400);
        visible = await expectationBecameVisible(page, flow.observable || "", textBefore);
        textAfter = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
        identity = durableCommitIdentity({ enteredValues, textBefore, textAfter });
        ({ value: durableValue, reference: durableReference } = identity);
      }
      if (!(visible.met && (durableValue || durableReference))) {
        return { ok: false, performed, failure: { control: label, kind: flow.kind,
          reason: !visible.met
            ? "the durable mutation did not reach its contracted observable state"
            : "the observable transition appeared, but no entered value or new durable reference was committed" } };
      }
      // The durable identity may render before the mutation handler's remaining reads have
      // populated the consumer surface (for example a newly-created asset title appears before
      // its history list refresh finishes). Let the browser settle that same mutation before the
      // journey attempts its first contracted entry; this never initiates another action.
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(200);
      durableCommitted = true;
      performed.push({ control: label, kind: "durable_commit",
        detail: `durable observable reached (${visible.found.join(", ")}) and `
          + `${durableValue ? `retained ${durableValue}` : `created ${durableReference}`}` });
    }
    performed.push({ control: label, kind: flow.kind, detail: `activated ${label}` });
  }
  // If the consumer journey begins by opening a contracted control, setup is not complete until
  // that exact opaque control exists. This closes the race where the durable row is committed but
  // the app's asynchronously refreshed history entry has not mounted yet.
  const entry = durableCommitted
    ? (journeyFlows || []).find((flow) => flow.stepIndex === 0 && flow.kind === "flow_start" && flow.control)
    : null;
  if (entry) {
    const deadline = Date.now() + 5_000;
    while (!(await semanticControlVisible(page, entry.control)) && Date.now() < deadline) {
      await page.waitForTimeout(200);
    }
    if (!(await semanticControlVisible(page, entry.control))) {
      return { ok: false, performed, failure: {
        control: entry.control.logicalField || entry.control.accessibleName,
        kind: "flow_start",
        reason: "the durable mutation committed, but the contracted journey entry did not become ready",
      } };
    }
    performed.push({ control: entry.control.logicalField || entry.control.accessibleName,
      kind: "consumer_ready", detail: "contracted consumer entry became visible" });
  }
  return { ok: true, performed };
}

// ── the journey ───────────────────────────────────────────────────────────────────────────────

/**
 * Drive every journey in the contract.
 *
 * Returns `{ pass, journeys, failures, undriveable, consoleErrors, failedRequests }`.
 * `pass` reflects the PRIMARY journey only — that is the one the brief says gates the preview.
 */
// The interactive descendants of a group that carries no attributes of its own.
const OPTION_SELECTOR = 'button, [role="option"], [role="radio"], option';

/**
 * THE PROBE'S LOCATOR LADDER — the same two rungs the driver already climbs.
 *
 *   1. the opaque machine identity
 *   2. the names the CONTRACT supplied for this control (browserPlan.fallbackNames)
 *
 * Rung 2 is what makes a hand-wired control visible. Run #8 rendered a date chooser with no machine
 * identity; the probe addressed identities only, so it skipped in silence, while the driver found
 * the very same element by name and failed on it eight steps later at a cost of 6.8 credits.
 *
 * `fallbackNames` are strings the CONTRACT handed over — not a platform table. That distinction is
 * the whole lesson of 2026-08-11, when `semanticAliases` invented "party size" out of Thrallo's own
 * vocabulary and drove three contact fields into a number input. This ladder must never reach for
 * it, and a test asserts the probe path does not.
 *
 * Ambiguity is refused rather than guessed. One name matching several visible elements is exactly
 * that failure shape, and a wrong probe result is worse than none: it would spend the bounded
 * mechanics correction on a control that was never broken.
 */
async function locateForProbe(page, control) {
  const visible = async (locator) => {
    const total = await locator.count().catch(() => 0);
    let seen = 0;
    for (let index = 0; index < Math.min(total, 6); index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) seen += 1;
    }
    return seen;
  };

  // An ACTION carries its identity on a different attribute and is reached by a different set of
  // roles. Same ladder, same three outcomes — identity, contracted name, nothing — so a button is
  // addressed exactly the way the driver will address it later.
  const isAction = control.addressAs === "action";
  // A SELECTION SHARES ITS IDENTITY BY DESIGN. The scaffold stamps the same id on the group and on
  // every option, so counting raw matches would call every correctly-bound chooser ambiguous — the
  // group is the addressable element, the options are its contents.
  const byIdentity = isAction
    ? page.locator(`[data-thrallo-action="${control.id}"]`)
    : control.primitive === "selection"
    ? page.locator(`[data-thrallo-control="${control.id}"]:not([data-thrallo-option])`)
    : page.locator(`[data-thrallo-control="${control.id}"]`);
  const identityCount = await visible(byIdentity);
  if (identityCount === 1) return { locator: byIdentity.first(), addressedBy: "identity" };
  if (identityCount > 1) {
    return { ambiguous: true, addressedBy: "identity", candidates: identityCount,
      detail: `${identityCount} visible elements carry ${control.id}` };
  }

  for (const name of control.fallbackNames || []) {
    const pattern = new RegExp(`^\\s*${escapeRegex(String(name))}\\s*$`, "i");
    const roles = isAction ? DRIVEABLE_ACTION_ROLES
      : control.primitive === "textbox"
      ? ["textbox", "spinbutton", "combobox"] : ["group", "radiogroup", "listbox", "combobox"];
    // A UNION, not a sum. One input is found by its label AND by its role+name, and counting each
    // strategy separately called that single element two candidates — reporting ambiguity for a
    // control that was never ambiguous, which would suppress the very probe the ladder exists for.
    let union = page.getByLabel(pattern);
    for (const role of roles) union = union.or(page.getByRole(role, { name: pattern }));
    const seen = await visible(union);
    if (seen > 1) {
      return { ambiguous: true, addressedBy: "fallback_name", candidates: seen,
        detail: `the contracted name "${name}" matches ${seen} visible elements` };
    }
    if (seen === 1) return { locator: union.first(), addressedBy: "fallback_name", matchedName: name };
  }
  return { locator: null };
}

/**
 * THE MECHANICS PROBE — behavioural proof, before the expensive part.
 *
 * Static analysis cannot decide whether a control accepts input. `<input {...field.inputProps} />`
 * hides its handler in an object; a hand-wired `value={draft.x}` with a setter that never lands
 * looks identical to one that does. Run #6 and run #7 produced the SAME static finding for fields
 * that worked and fields that did not, and the difference only showed up eight steps into a paid
 * booking journey.
 *
 * So where structure cannot answer, ask the page — with the cheapest possible question, before any
 * journey runs. Type a probe value into a contracted textbox and read it back. Click one option of
 * a contracted selection and see whether anything became selected. That is the whole test.
 *
 * It is DOMAIN-BLIND by construction: it receives opaque control ids and browser primitives, and
 * nothing else. It does not know what a guest, an email or a booking is, and cannot: the probe
 * value is a fixed generic string, chosen to be typeable into anything.
 *
 * @param {object} page                 an open page on the app's entry route
 * @param {Array}  controls             browserPlan controls: { id, primitive, inputType }
 * @returns {{ probed: number, failures: Array, skipped: Array }}
 */
export async function probeControlMechanics(page, controls = []) {
  const failures = [];
  const skipped = [];
  const outcomes = [];
  let probed = 0;

  for (const control of controls) {
    const located = await locateForProbe(page, control);
    if (located.ambiguous) {
      // A WRONG probe result is worse than none: it would spend the bounded mechanics correction
      // on a control that was never broken. This is the 2026-08-11 shape — one name, several
      // plausible elements — and the only safe answer is to say so and touch nothing.
      skipped.push({ id: control.id, primitive: control.primitive, reason: "ambiguous_identity",
        candidates: located.candidates, addressedBy: located.addressedBy });
      outcomes.push({ id: control.id, outcome: "ambiguous_identity", detail: located.detail });
      continue;
    }
    if (!located.locator) {
      // Not mounted yet is not a verdict. Later steps live behind a flow, and reaching them is the
      // journey's job, not the probe's: a control this cheap phase cannot see is left alone.
      skipped.push({ id: control.id, primitive: control.primitive, reason: "not_mounted_on_entry" });
      outcomes.push({ id: control.id, outcome: "not_mounted_on_entry", detail: null });
      continue;
    }
    if (located.addressedBy === "fallback_name") {
      // Probed, and worth saying out loud: this control was reached only because the CONTRACT
      // supplied a name to look for. It carries no machine identity, so it is invisible to every
      // identity-addressed path — which is how run #8's hand-wired chooser skipped silently.
      outcomes.push({ id: control.id, outcome: "identity_absent",
        detail: "reached by a contract-supplied name; the element carries no machine identity" });
    }
    const target = located.locator;

    if (control.primitive === "textbox") {
      // An input the contract must WRITE and the browser cannot: proven, structurally, here.
      if (await target.isDisabled().catch(() => false)) {
        failures.push({ id: control.id, primitive: "textbox", expected: "value_accepted",
          observed: "disabled", detail: "the contracted textbox is disabled on entry" });
        continue;
      }
      // `type` decides what a value even is: a number input refuses letters and an email input is
      // free to normalise. The probe value comes from the PRIMITIVE, never from meaning.
      const value = PROBE_VALUE[control.inputType] || PROBE_VALUE.text;
      await target.fill(value, { timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(120);
      const readBack = await target.inputValue().catch(() => null);
      probed += 1;
      if (readBack !== value) {
        failures.push({ id: control.id, primitive: "textbox", expected: value,
          observed: readBack === null ? "unreadable" : readBack,
          detail: "the contracted textbox did not retain a probe value" });
      }
      // Leave nothing behind: the journeys that follow write their own values.
      await target.fill("", { timeout: 2_000 }).catch(() => {});
      continue;
    }

    if (control.primitive === "selection") {
      // An identity-addressed group exposes its options by attribute. A hand-wired group has no
      // attributes at all, so its options are the interactive descendants of whatever the
      // contract-supplied name found.
      const nativeSelect = await target.evaluate((element) => element.tagName === "SELECT").catch(() => false);
      const options = nativeSelect
        ? target.locator("option:not([disabled])")
        : located.addressedBy === "identity"
        ? page.locator(`[data-thrallo-control="${control.id}"][data-thrallo-option]`)
        : target.locator(OPTION_SELECTOR);
      const count = await options.count().catch(() => 0);
      if (!count) { skipped.push({ id: control.id, primitive: "selection", reason: "no_options_on_entry" }); continue; }
      const snapshot = () => (nativeSelect
        ? options.evaluateAll((elements) => elements.map((option) => `${option.value}:${option.selected}`)).catch(() => [])
        : located.addressedBy === "identity"
        ? selectionSnapshot(page, control.id)
        : options.evaluateAll((els) => els.map((el) => [el.getAttribute("aria-pressed") || "",
          el.getAttribute("aria-selected") || "", el.getAttribute("data-selected") || "",
          el.className || ""].join(":"))).catch(() => []));
      const before = await snapshot();
      // A valid selector may default its first option. Clicking that same option cannot produce a
      // transition, and used to condemn working generated apps before their journeys even ran.
      // Probe the first UNSELECTED option (the same invariant used by the journey driver) so an
      // unchanged result proves a dead control rather than a no-op chosen by the verifier.
      const selectedBefore = await options.evaluateAll((els) => els.map((el) => {
        if (el.tagName === "OPTION") return el.selected === true;
        const state = (el.getAttribute("data-state") || "").toLowerCase();
        const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
        return el.getAttribute("aria-selected") === "true"
          || el.getAttribute("aria-pressed") === "true"
          || el.checked === true
          || ["on", "active", "selected", "checked"].includes(state)
          || /(^|[\s_-])(is[-_])?(selected|active)([\s_-]|$)/.test(cls);
      })).catch(() => []);
      const clickIndex = selectedBefore.findIndex((selected) => selected !== true);
      if (clickIndex === -1) {
        failures.push({ id: control.id, primitive: "selection", expected: "one_unselected_option",
          observed: "all_selected", detail: "the contracted selection exposes no unselected option to drive" });
        continue;
      }
      if (nativeSelect) {
        const domIndex = await options.nth(clickIndex).evaluate((option) => (
          [...option.parentElement.options].indexOf(option)
        )).catch(() => -1);
        if (domIndex >= 0) {
          await target.selectOption({ index: domIndex }, { timeout: 5_000 }).catch(() => {});
        }
      } else {
        await options.nth(clickIndex).click({ timeout: 5_000 }).catch(() => {});
      }
      await page.waitForTimeout(200);
      const after = await snapshot();
      probed += 1;
      // Gone entirely is legitimate — a chooser that advances its own flow. Present and unchanged
      // is not: nothing observable happened, so nothing can be verified through it later.
      if (after.length && before.join("|") === after.join("|")) {
        failures.push({ id: control.id, primitive: "selection", expected: "selection_state_changed",
          observed: "unchanged", detail: "clicking a contracted option produced no selected state" });
      }
    }
  }
  return { probed, failures, skipped, outcomes };
}

/**
 * THE ACTION PROBE — is the contracted button addressable at all?
 *
 * Fields and choosers got the cheap question first; the buttons never did. Every contracted
 * action already has a machine identity in the manifest, and the failure that mattered — a
 * hand-wired control carrying no identity, reachable only through the name the contract happened
 * to supply — is answerable before any journey runs.
 *
 * IT NEVER ACTIVATES ANYTHING. Pressing a contracted commit button on the entry screen would
 * create a durable record the customer never asked for, so this probe locates and reports and
 * stops there. What it can prove without touching the app is addressing, and addressing is
 * exactly what was missing: an action reached only by name is invisible to every identity-driven
 * path, and an action whose identity matches several visible elements cannot be driven safely.
 *
 * Nothing here is a FAILURE. A button legitimately absent on entry lives behind a flow step; a
 * forward control is legitimately disabled until its form is filled. These are OUTCOMES, attached
 * as evidence to whatever the journeys later prove — unknown is not broken.
 *
 * @param {object} page     an open page on the app's entry route
 * @param {Array}  actions  browserPlan actions: { id, primitive, fallbackNames }
 * @returns {{ probed: number, failures: Array, skipped: Array, outcomes: Array }}
 */
export async function probeActionMechanics(page, actions = []) {
  const outcomes = [];
  const skipped = [];
  let probed = 0;

  for (const action of actions) {
    const located = await locateForProbe(page, { ...action, addressAs: "action" });
    if (located.ambiguous) {
      skipped.push({ id: action.id, primitive: action.primitive, reason: "ambiguous_identity",
        candidates: located.candidates, addressedBy: located.addressedBy });
      outcomes.push({ id: action.id, outcome: "ambiguous_identity", detail: located.detail });
      continue;
    }
    if (!located.locator) {
      skipped.push({ id: action.id, primitive: action.primitive, reason: "not_mounted_on_entry" });
      outcomes.push({ id: action.id, outcome: "not_mounted_on_entry", detail: null });
      continue;
    }
    probed += 1;
    const disabled = await located.locator.isDisabled().catch(() => false);
    if (located.addressedBy === "fallback_name") {
      outcomes.push({ id: action.id, outcome: "identity_absent", addressedBy: located.addressedBy,
        detail: "the contracted action was reached only by a contract-supplied name; the element "
          + "carries no machine identity, so every identity-addressed path is blind to it" });
      continue;
    }
    outcomes.push({ id: action.id, outcome: disabled ? "disabled_on_entry" : "addressable",
      addressedBy: located.addressedBy,
      detail: disabled ? "the contracted action is present and disabled on entry" : null });
  }
  return { probed, failures: [], skipped, outcomes };
}

// Values chosen by INPUT TYPE, which is a browser fact. Nothing here describes a business meaning.
const PROBE_VALUE = Object.freeze({
  text: "Probe", email: "probe@example.com", tel: "07700900123", number: "2",
  search: "Probe", url: "https://example.com", password: "Probe-1234", textarea: "Probe",
});

const selectionSnapshot = (page, id) => page.evaluate((controlId) => [...document
  .querySelectorAll(`[data-thrallo-control="${controlId}"][data-thrallo-option]`)]
  .map((el) => `${el.getAttribute("aria-pressed") || ""}:${el.getAttribute("aria-selected") || ""}`
    + `:${el.getAttribute("data-selected") || ""}:${el.className || ""}`), id).catch(() => []);

function applyMinimalStepClassification(outcome, fatalRuntimeErrors = []) {
  if (outcome?.status !== "pass" && fatalRuntimeErrors.length) {
    return verificationVerdict(
      VERIFICATION_RESULT_CLASS.FATAL_RUNTIME_FAILURE,
      `a fatal runtime error prevented the contracted step: ${fatalRuntimeErrors[0]}`,
      { ...outcome, fatalRuntimeErrors },
    );
  }
  if (outcome?.classification) return outcome;
  if (outcome?.status === "pass") {
    return { ...outcome, classification: VERIFICATION_RESULT_CLASS.PASS };
  }
  const fieldFailure = (outcome?.controlEvidence?.fields || []).some((field) => (
    ["not_editable", "value_not_accepted"].includes(field.status) && field.matchedBy
  ));
  const activationFailure = ["disabled", "click_failed"].includes(
    outcome?.controlEvidence?.activation?.reason,
  );
  // A flow-entry control is required on the active surface by the structured contract itself.
  // Once the preview loaded without a platform/fatal signal, the browser proving that exact entry
  // absent is an application interaction failure. Treating it as verifier uncertainty prevented
  // repair entirely and turned a concrete missing control into a terminal platform block.
  const requiredEntryMissing = outcome?.controlEvidence?.activation?.requiredAtFlowEntry === true
    && outcome?.controlEvidence?.activation?.reason === "not_reliably_located";
  const requiredActionMissing = outcome?.controlEvidence?.activation?.requiredAtContractedStep === true
    && outcome?.controlEvidence?.activation?.reason === "not_reliably_located";
  const requiredSelectionMissing = outcome?.controlEvidence?.requiredControl?.kind === "selection"
    && outcome?.controlEvidence?.requiredControl?.reason === "not_reliably_located";
  const requiredFieldMissing = (outcome?.controlEvidence?.fields || []).some((field) => (
    ["missing", "ambiguous_identity"].includes(field.status)
  ));
  if (activationFailure || requiredEntryMissing || requiredActionMissing
    || requiredSelectionMissing || requiredFieldMissing) {
    return { ...outcome, classification: VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE,
      status: "undriveable" };
  }
  if (fieldFailure) {
    return { ...outcome, classification: VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE,
      status: "fail" };
  }
  if (["undriveable", "not_reached", "skipped"].includes(outcome?.status)) {
    return { ...outcome, classification: VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE,
      status: "undriveable" };
  }
  return { ...outcome, classification: VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE,
    status: "fail" };
}

// Generated applications may resolve their public session before mounting the contracted
// workspace. A fixed post-navigation sleep sampled a legitimate visible `role=status` loading
// surface in production and then falsely concluded that the workspace control did not exist.
// Wait only while the app explicitly advertises active asynchronous readiness; ordinary status
// copy such as "Saved" never delays verification, and a stuck loader still proceeds to the normal
// strict journey failure after this bounded wait.
async function waitForActiveSurface(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const active = await page.evaluate(() => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden"
          && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
      };
      return [...document.querySelectorAll('[aria-busy="true"], [role="status"]')]
        .filter(visible)
        .some((element) => element.getAttribute("aria-busy") === "true"
          || /^(loading|initializing|checking|preparing)\b/i.test((element.textContent || "").trim()));
    }).catch(() => false);
    if (!active || Date.now() >= deadline) return !active;
    await page.waitForTimeout(200);
  }
}

export async function verifyJourneys({
  previewUrl, contract, timeoutMs = 240_000, viewport = { width: 1280, height: 900 },
  browser: sharedBrowser = null,
  verificationIdentity = null,
  verifierPolicy = LEGACY_RICH_VERIFIER_POLICY,
}) {
  const minimal = isMinimalContractVerifier(verifierPolicy);
  const results = [];
  const consoleErrors = [];
  const failedRequests = [];
  const fatalErrors = [];
  const runtimeErrors = [];
  const platformSignals = [];
  const advisories = [];
  const verifierDefects = [];
  const marker = String(Date.now()).slice(-6);
  // Form data stays fresh on every drive so persistence probes observe a real change. Account
  // credentials do not: a repair round for the same project/journey recovers the same test user
  // instead of consuming another app-auth signup slot.
  const authMarker = verificationToken(verificationIdentity,
    `journey:${verificationIdentity?.scope || "default"}`)
    || `${marker}-${Math.random().toString(36).slice(2, 10)}`;
  let browser = sharedBrowser;
  const ownsBrowser = !sharedBrowser;
  const contexts = [];
  // The mechanics phase runs inside the try and is reported outside it.
  let mechanics = null;

  try {
    const { chromium } = requireCjs("playwright");
    // Browser verification runs inside Docker. A real WebGL app across isolated contexts can
    // exhaust the container's small /dev/shm mount, yielding ERR_INSUFFICIENT_RESOURCES and then
    // Page crashed. The sandbox's other Chromium seam already uses this disk-backed path.
    if (!browser) browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--no-sandbox"] });
    // A journey runs in the browser state its SCENARIO calls for. An independent journey gets a
    // fresh context — a legitimate first-time visitor, nothing deleted and nothing fabricated —
    // because inheriting a previous scenario's terminal wizard is not a property of the app under
    // test. Journeys that depend on a durable record stay in the context that created it, so the
    // app's own visitor identity (and therefore RLS) still resolves the record through the normal
    // runtime; no privileged state is ever injected.
    const openContext = async ({ visitorPurpose = "visitor" } = {}) => {
      const created = await browser.newContext({ viewport });
      await seedVerificationVisitorStorage(created, verificationIdentity, visitorPurpose);
      const opened = await created.newPage();
      opened.on("pageerror", (e) => {
        const detail = e.message.slice(0, 200);
        consoleErrors.push(detail);
        runtimeErrors.push(detail);
      });
      opened.on("console", (m) => {
        // Chromium emits this generic console line for the same HTTP failure reported with its
        // exact method, status and URL by the response/requestfailed listeners below. Keeping both
        // made one recovered app-auth race count as two independent blockers.
        if (m.type() === "error" && !/^Failed to load resource:/i.test(m.text())) {
          consoleErrors.push(m.text().slice(0, 200));
        } else if (minimal && m.type() === "warning") {
          advisories.push({ code: "non_blocking_console_warning", detail: m.text().slice(0, 200) });
        }
      });
      opened.on("response", (r) => {
        if (r.status() >= 400 && !r.url().includes("favicon")) {
          failedRequests.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`);
        }
        const defect = appAuthRateLimitDefect(r);
        if (defect) {
          if (minimal) platformSignals.push(defect);
          else verifierDefects.push(defect);
        }
      });
      opened.on("requestfailed", (request) => {
        const reason = request.failure()?.errorText || "failed";
        if (!/net::ERR_ABORTED/.test(reason)) {
          failedRequests.push(`${reason} ${request.method()} ${request.url().slice(0, 140)}`);
        }
      });
      contexts.push(created);
      return opened;
    };
    // Mechanics deliberately writes to controls. It therefore gets a disposable visitor and
    // browser context: reloading the same page is insufficient when a wizard/selection persists
    // through the generated backend, and would make the real journey inherit probe state.
    let page = await openContext({ visitorPurpose: "mechanics" });

    // Is the preview actually there? Without this, an unreachable URL leaves a blank page, every
    // expectation goes unmet, and the run reports confident journey failures for an app it never
    // loaded — failing a build over infrastructure, in the most expensive place possible.
    const landing = await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
      .catch((error) => ({ error }));
    const reachable = landing && !landing.error && (typeof landing.status !== "function" || landing.status() < 400);
    if (!reachable) {
      return {
        pass: null, unavailable: true, journeys: [],
        verifierPolicy,
        error: `the preview did not load (${landing?.error?.message?.slice(0, 120) || `HTTP ${landing?.status?.()}`})`,
        consoleErrors, failedRequests, fatalErrors, advisories,
      };
    }
    await waitForActiveSurface(page);

    const deadline = Date.now() + timeoutMs;

    // MECHANICS BEFORE MEANING. Contracted controls that are already on screen get the cheap
    // question first — does this thing accept the interaction its primitive implies — so a build
    // whose fields cannot hold a value says so in seconds, with the control's own id, instead of
    // eight steps into a journey. Costs one fill per visible control and changes no verdict on its
    // own: the journeys below still run, and still decide.
    const plan = browserPlan(deriveVerificationManifest(contract));
    const probePlan = plan.controls.filter((row) => ["textbox", "selection"].includes(row.primitive));
    mechanics = probePlan.length ? await probeControlMechanics(page, probePlan) : null;
    // The contracted BUTTONS get the same addressing question, without being pressed. Their
    // outcomes join the control outcomes so a repair brief can say "this action carries no
    // machine identity" instead of "the outcome never appeared" eight steps later.
    if (plan.actions?.length) {
      const actionMechanics = await probeActionMechanics(page, plan.actions);
      mechanics = {
        probed: (mechanics?.probed || 0) + actionMechanics.probed,
        failures: [...(mechanics?.failures || []), ...actionMechanics.failures],
        skipped: [...(mechanics?.skipped || []), ...actionMechanics.skipped],
        outcomes: [...(mechanics?.outcomes || []), ...actionMechanics.outcomes],
      };
    }
    // Always discard the mechanics context, even when every probe passed. A successful selection
    // probe still changed state; a durable wizard can restore that state after a reload and hide
    // the flow-entry control the first customer journey is required to drive.
    await page.context().close().catch(() => {});
    page = await openContext();

    // Durable evidence for the WHOLE run: what each contracted journey created, so a later
    // journey that depends on that record can prove it survived.
    const runEvidence = new Map();
    // Primary first: if the run is going to time out, it should time out having proved the thing
    // that actually gates the preview.
    const ordered = [...(contract?.journeys || [])]
      .sort((a, b) => (a.priority === "primary" ? -1 : 0) - (b.priority === "primary" ? -1 : 0));

    for (const journey of ordered) {
      if (Date.now() > deadline) {
        results.push({ id: journey.id, title: journey.title, priority: journey.priority,
          status: minimal ? "undriveable" : "skipped", steps: [],
          ...(minimal ? { classification: VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE } : {}) });
        continue;
      }
      // Scenario isolation. An independent journey opens the app as a brand-new visitor would;
      // a journey that depends on a durable record keeps the identity that created it.
      const scenario = contract?.interactionContract?.scenarios?.[journey.id]
        || { role: "independent", startState: "fresh" };
      const isolatedJourneyContract = Boolean(contract?.prerequisiteInteractionContract)
        && (contract?.journeys || []).length === 1;
      if ((isolatedJourneyContract && journey.priority !== "primary")
        || (!isolatedJourneyContract && (scenario.role === "independent"
          || (scenario.role === "produces" && journey.priority !== "primary")))) {
        page = await openContext();
      }
      // Include fatal errors raised while the contracted surface mounts in the first step's
      // evidence. Once a step passes, those errors are consumed as non-blocking diagnostics so an
      // unrelated page error cannot poison a later action that demonstrably works.
      let runtimeEvidenceCursor = runtimeErrors.length;
      // Every journey starts from a clean load of the app, not from wherever the last one ended.
      await page.goto(previewUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await waitForActiveSurface(page);
      await page.waitForTimeout(200);

      const steps = [];
      const selections = []; // what this journey actually chose — confirmations must reflect it
      const enteredValues = []; // exact contracted values; review must echo them
      const writtenPaths = new Set(); // contracted state this journey has already written
      // What the durable record looked like when it was created — recovery is measured against it.
      const durable = { captured: false };
      const authState = { accounts: [], active: null };
      // The journey's whole contracted order. A selection that advances the flow proves it did so
      // by reaching the control the CONTRACT names next, which cannot be known from one step.
      const journeyFlows = [...((contract?.interactionContract?.flows) || [])]
        .filter((flow) => flow.journeyId === journey.id)
        .sort((a, b) => a.stepIndex - b.stepIndex);
      // Reach the journey's required starting state before judging it. Setup outcomes are kept
      // separate from the journey's own steps: establishing a precondition is not evidence that
      // the contracted journey works.
      const allFlows = contract?.prerequisiteInteractionContract?.flows
        || (contract?.interactionContract?.flows) || [];
      const allJourneys = contract?.allJourneys || ordered;
      const primaryId = (allJourneys.find((j) => j.priority === "primary") || allJourneys[0])?.id;
      const primaryScenario = contract?.prerequisiteInteractionContract?.scenarios?.[primaryId]
        || contract?.interactionContract?.scenarios?.[primaryId] || null;
      const requiresPrimaryRecord = isolatedJourneyContract && Boolean(
        (scenario.lifecycle && scenario.lifecycle === primaryScenario?.lifecycle)
          || /\b(existing|saved|previous|history|generated asset)\b/i.test(String(
            `${journey.steps?.[0]?.action || ""} ${journey.steps?.[0]?.target || ""}`,
          )),
      );
      const explicitAccountStart = /create (?:a )?new account|create account|sign ?up/i
        .test(String(journey.steps?.[0]?.action || ""));
      const prerequisites = explicitAccountStart
        ? { controls: [], requiresDurableRecord: false }
        : journeyPrerequisites(allFlows, journey.id, primaryId, {
          requiresPrimaryRecord, reconstructIsolated: isolatedJourneyContract,
        });
      let setup = null;
      if (prerequisites.controls.length) {
        const directValueEntry = journeyFlows.find((flow) => (
          ["input", "selection"].includes(flow.kind) && flow.control
        ));
        const directEntryReady = !prerequisites.requiresDurableRecord && directValueEntry
          && await semanticValueControlReady(page, directValueEntry.control);
        setup = directEntryReady
          ? { ok: true, performed: [], directEntry: directValueEntry.control.logicalField
            || directValueEntry.control.accessibleName }
          : await establishPrerequisites(page, prerequisites.controls, {
            marker, authMarker, journeyFlows, verifierPolicy,
          });
        if (!setup.ok) {
          results.push({
            id: journey.id, title: journey.title, priority: journey.priority,
            status: minimal ? "undriveable" : "not_reached",
            ...(minimal ? { classification: VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE } : {}),
            steps: (journey.steps || []).map((step) => ({
              action: step.action, expect: step.expect, status: minimal ? "undriveable" : "not_reached",
              ...(minimal ? { classification: VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE } : {}),
              detail: `not reached: the journey's required starting state could not be established (${setup.failure.control}: ${setup.failure.reason})`,
            })),
            failedSteps: 0, undriveableSteps: 0,
            setup: { ok: false, ...setup, code: "journey_prerequisites_unmet" },
          });
          continue;
        }
      }
      let blockedBy = null;
      for (const [stepIndex, step] of (journey.steps || []).entries()) {
        if (Date.now() > deadline) {
          steps.push({ ...step, status: minimal ? "undriveable" : "skipped",
            ...(minimal ? { classification: VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE } : {}) });
          continue;
        }
        if (blockedBy) {
          steps.push({ action: step.action, expect: step.expect, status: "not_reached",
            detail: `not reached because step ${blockedBy.stepIndex + 1} was ${blockedBy.status}`,
            blockedBy: blockedBy.stepIndex });
          continue;
        }
        const interactionFlows = interactionFlowsFor(contract, journey.id, stepIndex);
        // WHAT THE PAGE SAID WHEN IT FAILED.
        //
        // Run #9's commit was refused by the generated app, and the retained source showed three
        // branches that could have refused it: two return a state the UI renders SILENTLY, one
        // renders "Error: …". The step's verdict — five expected words, one found — could not tell
        // them apart, and neither could the source, so diagnosing a 5.7-credit failure stopped at
        // "the mutation failed, cause unknown".
        //
        // So a failing step now keeps what was on screen, and what the browser complained about
        // while it ran. Evidence only: captured after the verdict, never an input to it, and
        // bounded so a page of text cannot bloat the record.
        const consoleBefore = consoleErrors.length;
        const requestsBefore = failedRequests.length;
        const fatalBefore = runtimeEvidenceCursor;
        const platformBefore = platformSignals.length;
        let outcome = await runStep(page, step, {
          marker, authMarker, previewUrl, selections, enteredValues, interactionFlows, journeyFlows, writtenPaths, durable, runEvidence,
          authState, allowEstablishedState: stepIndex === 0 && setup?.ok === true, verifierPolicy,
        }).catch((error) => ({
          status: "undriveable", detail: `driver error: ${error.message.slice(0, 120)}`,
          verifierDefect: { code: "journey_driver_error", detail: error.message.slice(0, 200) },
        }));
        if (minimal) outcome = applyMinimalStepClassification(outcome, runtimeErrors.slice(fatalBefore));
        runtimeEvidenceCursor = runtimeErrors.length;
        if (minimal && outcome.status !== "pass" && platformSignals.length > platformBefore) {
          outcome = verificationVerdict(VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE,
            platformSignals[platformBefore].detail || "the verification platform could not establish the step",
            { ...outcome, platformSignal: platformSignals[platformBefore] });
        }
        if (outcome.classification === VERIFICATION_RESULT_CLASS.FATAL_RUNTIME_FAILURE) {
          fatalErrors.push(...(outcome.fatalRuntimeErrors || []));
        }
        if (outcome.verifierDefect) verifierDefects.push({
          ...outcome.verifierDefect, journeyId: journey.id, stepIndex, action: step.action,
        });
        if (outcome.selectedText) selections.push(outcome.selectedText);
        for (const advisory of outcome.advisories || outcome.controlEvidence?.advisories || []) {
          advisories.push({ journeyId: journey.id, stepIndex, ...advisory });
        }
        if (!["pass", "skipped", "not_reached"].includes(outcome.status)) {
          outcome.observation = {
            text: (await page.evaluate(() => document.body?.innerText || "").catch(() => ""))
              .replace(/\s+/g, " ").trim().slice(0, 600),
            consoleSince: consoleErrors.slice(consoleBefore, consoleBefore + 5),
            requestsSince: failedRequests.slice(requestsBefore, requestsBefore + 5),
          };
        }
        steps.push({ action: step.action, expect: step.expect, ...outcome });
        if (!["pass", "skipped"].includes(outcome.status)) blockedBy = { stepIndex, status: outcome.status };
      }

      const failed = steps.filter((s) => s.status === "fail");
      const undriveable = steps.filter((s) => s.status === "undriveable");
      results.push({
        id: journey.id, title: journey.title, priority: journey.priority,
        // A contracted step the browser cannot drive is not qualified. It remains distinct from a
        // behavioural failure for diagnosis, but the journey cannot become green around it.
        status: failed.length ? "fail" : (undriveable.length ? "undriveable" : "pass"),
        ...(minimal ? { classification: failed[0]?.classification
          || undriveable[0]?.classification
          || (undriveable.length ? VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE
            : VERIFICATION_RESULT_CLASS.PASS) } : {}),
        ...(setup ? { setup: { ok: true, ...setup } } : {}),
        steps, failedSteps: failed.length, undriveableSteps: undriveable.length,
      });
    }
  } catch (error) {
    return {
      pass: null, journeys: results, error: error.message, mechanics, verifierPolicy,
      consoleErrors, failedRequests, fatalErrors, advisories,
      // A verifier that cannot start must not be read as "the app is broken".
      unavailable: true,
    };
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})));
    if (ownsBrowser) await browser?.close().catch(() => {});
  }

  const primary = results.find((j) => j.priority === "primary") || results[0];
  return {
    pass: minimal
      ? (results.length ? results.every((journey) => journey.status === "pass") : null)
      : (primary ? primary.status === "pass" : null),
    verifierPolicy,
    primaryStatus: primary?.status || null,
    journeys: results,
    failures: results.filter((j) => j.status === "fail"),
    undriveable: results.filter((j) => j.status === "undriveable"),
    // Behavioural mechanics evidence, reported whatever the journeys concluded: it names each
    // control by its opaque id and says what the browser observed, which is what a targeted
    // correction needs and what a journey failure eight steps later does not supply.
    mechanics,
    verifierDefects: [...new Map(verifierDefects.map((row) => [row.code, row])).values()],
    consoleErrors: [...new Set(consoleErrors)].slice(0, 10),
    failedRequests: [...new Set(failedRequests)].slice(0, 10),
    fatalErrors: [...new Set(fatalErrors)].slice(0, 10),
    advisories: [
      ...advisories,
      ...(minimal ? [...new Set(consoleErrors)].map((detail) => ({ code: "non_blocking_console", detail })) : []),
      ...(minimal ? [...new Set(failedRequests)].map((detail) => ({ code: "non_blocking_network", detail })) : []),
    ].slice(0, 40),
  };
}

/** The failures, phrased for a repair brief. */
export function journeyFailures(result) {
  const out = [];
  const journeys = result?.journeys || [...(result?.failures || []), ...(result?.undriveable || [])];
  for (const journey of journeys) {
    for (const step of journey.steps.filter((s) => !["pass", "not_reached", "skipped"].includes(s.status))) {
      out.push(`the journey "${journey.title}" fails at "${step.action}": ${step.detail}`);
    }
  }
  for (const error of result?.fatalErrors || []) out.push(`a fatal browser runtime error reports: ${error}`);
  if (result?.verifierPolicy !== MINIMAL_CONTRACT_VERIFIER_POLICY) {
    for (const error of result?.consoleErrors || []) out.push(`the browser console reports: ${error}`);
    for (const request of result?.failedRequests || []) out.push(`a network request failed: ${request}`);
  }
  return out;
}

/** One line for the diagnostics record. */
export function journeySummary(result) {
  if (result?.unavailable) return `journeys not run (${result.error})`;
  return (result?.journeys || [])
    .map((j) => `${j.id}:${j.status}${j.failedSteps ? `(${j.failedSteps} failed)` : ""}`)
    .join(" · ") || "no journeys";
}
