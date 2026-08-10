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
  ADVANCE_ACTION_PATTERN, DRIVEABLE_ACTION_ROLES, IDENTITY_STOP_WORDS, semanticAliases, semanticKey,
} from "../builderV2/controlIdentity.mjs";

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
  "display", "visible", "appears", "appear", "should", "must", "step", "value", "input"]);

// QUALITATIVE design language is guidance for the builder, not an assertion for this driver.
// "a polished confirmation state" failed a live build because the page did not contain the word
// "polished" — an adjective no reasonable app renders. Observable requirements become literal
// assertions; adjectives never do.
export const QUALITATIVE = new Set(["polished", "premium", "modern", "professional", "beautiful",
  "elegant", "stylish", "seamless", "delightful", "clean", "sleek", "attractive", "lovely",
  "gorgeous", "immersive", "impressive", "refined", "sophisticated", "crisp", "tasteful"]);

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

// Plausible values for a field, chosen from its own label so validation is satisfied rather than
// tripped — the point is to complete the journey, not to fuzz it.
function valueFor(label, marker) {
  const text = String(label || "").toLowerCase();
  if (/e-?mail/.test(text)) return `journey+${marker}@thrallo.dev`;
  if (/phone|tel|mobile/.test(text)) return "07700900123";
  if (/password/.test(text)) return `Jv-${marker}!9a`;
  if (/date/.test(text)) {
    const soon = new Date(Date.now() + 7 * 86_400_000);
    return soon.toISOString().slice(0, 10);
  }
  if (/time/.test(text)) return "10:00";
  if (/number|quantity|adults?|children|guests?|qty/.test(text)) return "2";
  if (/postcode|zip/.test(text)) return "SW1A 1AA";
  return `Journey ${marker}`;
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

function interactionFlowsFor(contract, journeyId, stepIndex, kind = null) {
  const flows = (contract?.interactionContract?.flows || []).filter((flow) => flow.journeyId === journeyId
    && flow.stepIndex === stepIndex && (!kind || flow.kind === kind));
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

/** Drive only the fields the machine-readable contract assigns to this step. */
async function fillContractedFields(page, flows, marker) {
  const evidence = { attemptedLocators: [], renderedControls: await renderedFormControls(page), fields: [] };
  const filled = [];
  for (const flow of flows) {
    const logicalField = flow.control.logicalField || flow.valueWritten || flow.control.accessibleName;
    const attempts = contractedLocators(page, flow.control);
    evidence.attemptedLocators.push(...attempts.map((row) => `${logicalField}:${row.description}`));
    let field = null;
    let matchedBy = null;
    for (const attempt of attempts) {
      const count = Math.min(await attempt.locator.count().catch(() => 0), 3);
      for (let index = 0; index < count; index += 1) {
        const candidate = attempt.locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          field = candidate;
          matchedBy = attempt.description;
          break;
        }
      }
      if (field) break;
    }
    const fieldEvidence = { field: logicalField, expectedStateOwner: flow.stateOwner, matchedBy,
      accessibleNames: flow.control.accessibleNames || [flow.control.accessibleName] };
    if (!field) {
      evidence.fields.push({ ...fieldEvidence, status: "missing" });
      continue;
    }
    const disabled = await field.isDisabled().catch(() => true);
    const editable = await field.isEditable().catch(() => false);
    const facts = await field.evaluate((el) => ({
      tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "text", name: el.getAttribute("name"),
      id: el.id || null, placeholder: el.getAttribute("placeholder"), ariaLabel: el.getAttribute("aria-label"),
      labels: el.labels ? [...el.labels].map((label) => (label.innerText || "").trim()).filter(Boolean) : [],
      disabled: Boolean(el.disabled), readOnly: Boolean(el.readOnly),
    })).catch(() => null);
    if (disabled || !editable) {
      evidence.fields.push({ ...fieldEvidence, status: "not_editable", facts });
      continue;
    }
    const value = valueFor(logicalField, marker);
    await field.fill(value, { timeout: 3_000 }).catch(() => {});
    const observedValue = await field.inputValue().catch(() => "");
    const status = observedValue === value ? "filled" : "value_not_accepted";
    evidence.fields.push({ ...fieldEvidence, status, expectedValue: value, observedValue, facts });
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
    const candidates = [...document.querySelectorAll(
      '[role="option"],[role="tab"],[role="radio"],[aria-selected],[aria-pressed],[data-state],input[type="radio"],button',
    )].filter((el) => el.offsetParent !== null && !el.disabled);
    const byParent = new Map();
    for (const el of candidates) {
      if (!el.parentElement) continue;
      if (!byParent.has(el.parentElement)) byParent.set(el.parentElement, []);
      byParent.get(el.parentElement).push(el);
    }
    // Position-independent identities the group announces about ITSELF. Read from standard
    // HTML/ARIA only, never from prose or ordinal, so revealing a step cannot renumber a group
    // into another group's identity.
    const identitiesOf = (parent, els) => {
      const container = parent.closest("[role=group],fieldset,[role=radiogroup],[role=listbox],[role=tablist]") || parent;
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
    const groups = [];
    let id = 0;
    for (const [parent, els] of byParent) {
      if (els.length < 2) continue;
      groups.push({
        groupId: id,
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

async function groupState(page, groupId) {
  return page.evaluate((gid) => {
    const isSelected = (el) => {
      const state = (el.getAttribute("data-state") || "").toLowerCase();
      const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
      return el.getAttribute("aria-selected") === "true"
        || el.getAttribute("aria-pressed") === "true"
        || el.checked === true
        || ["on", "active", "selected", "checked"].includes(state)
        || /(^|[\s_-])(is[-_])?(selected|active)([\s_-]|$)/.test(cls);
    };
    return [...document.querySelectorAll(`[data-thrallo-opt^="${gid}:"]`)]
      .map((el) => ({
        index: Number(el.getAttribute("data-thrallo-opt").split(":")[1]),
        text: (el.innerText || el.value || "").trim().slice(0, 80),
        selected: isSelected(el),
      }))
      .sort((a, b) => a.index - b.index);
  }, groupId).catch(() => []);
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

/** Which control the contract expects AFTER this one, by contracted order. */
function nextContractedControl(journeyFlows, flow) {
  if (!flow) return null;
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
    if (!(await page.getByText(new RegExp(word, "i")).first().isVisible().catch(() => false))) continue;
    found.push(word);
    if (!before.includes(word)) fresh.push(word);
  }
  return { met: found.length / wanted.length >= 0.5 && fresh.length > 0, found, fresh, wanted };
}

async function advanceFlow(page) {
  const before = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  for (const role of DRIVEABLE_ACTION_ROLES) {
    const control = page.getByRole(role, { name: ADVANCE_ACTION_PATTERN }).first();
    if (!(await control.count().catch(() => 0))) continue;
    if (!(await control.isVisible().catch(() => false))) continue;
    if (await control.isDisabled().catch(() => true)) continue;
    const name = (await control.textContent().catch(() => "")) || role;
    await control.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    // No observable change means the flow did NOT advance — for example a Continue that is
    // correctly refusing to move past an incomplete step. Report that, never assume it.
    if (after === before) return { advanced: false, detail: `"${name.trim().slice(0, 30)}" did not advance the flow` };
    return { advanced: true, via: name.trim().slice(0, 30) };
  }
  return { advanced: false, detail: "no flow-advance control was offered" };
}

// Drive a selection step semantically. Returns a full step outcome, or null when no selectable
// group matches — the caller falls back to the generic text path.
async function driveSelection(page, step, flow = null, excludedKeys = new Set(), journeyFlows = []) {
  const contractedNames = controlAliases(flow?.control);
  const wanted = contractedNames.length
    ? unique(contractedNames.flatMap((name) => keywords(name, 5)))
    : keywords(`${step.target || ""} ${step.action} ${step.expect}`, 8);
  const groups = await selectionGroups(page);
  if (!groups.length) return null;

  const eligible = groups
    // A group of "+"/"−" buttons is a STEPPER, not a selection — clicking one never yields a
    // selected state, and judging it here misfired on "choose numbers of adults and children".
    .filter((g) => g.options.some((o) => (o.text || "").length >= 3))
    .map((g) => ({ ...g, key: groupKey(g) }))
    .filter((g) => !excludedKeys.has(g.key));

  let group = null;
  if (flow?.control) {
    // A CONTRACTED selection is matched on the group's own declared identity, never on prose and
    // never on position. Live proof: scoring by rendered text drove the date options for the
    // slot step AND for the party step, and both "passed" because selection did move — within
    // the wrong group. There is deliberately NO prose fallback here: if the contracted group is
    // not on screen the step is undriveable, which is the truth, rather than a false pass.
    const target = semanticKey(flow.control.logicalField || flow.control.accessibleName);
    group = eligible.find((g) => g.identities.some((identity) => semanticKey(identity) === target)) || null;
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
  // Click a DIFFERENT available option than the current selection (or the first, if none).
  const clickIndex = before.findIndex((o, i) => i !== beforeSelected);
  if (clickIndex === -1) return null;

  const textBefore = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  await page.locator(`[data-thrallo-opt="${group.groupId}:${clickIndex}"]`).click({ timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(600);
  const after = await groupState(page, group.groupId);

  // Only when the group has gone entirely: gather what it would take to prove the disappearance
  // was the contracted advance rather than an unrelated transition.
  let autoAdvance = null;
  if (!after.length) {
    const nextControl = nextContractedControl(journeyFlows, flow);
    const outcome = await expectationBecameVisible(page, step.expect, textBefore);
    autoAdvance = {
      nextControl: nextControl ? (nextControl.logicalField || nextControl.accessibleName) : null,
      nextControlVisible: await semanticControlVisible(page, nextControl),
      expectationMet: outcome.met,
      expectationEvidence: outcome,
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
      selectedGroupContext: group.contextText, selectedOptions: after },
  };
}

// ── running one step ──────────────────────────────────────────────────────────────────────────

async function runStep(page, step, {
  marker, previewUrl, selections = [], enteredValues = [], interactionFlows = [], journeyFlows = [],
  writtenPaths = new Set(),
}) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  const action = String(step.action || "");
  const expect = String(step.expect || "");
  let drove = false;

  // What was already on screen BEFORE this step. A word that was visible beforehand is no evidence
  // that the step did anything: "a booking reference is shown" was passing on a page whose only
  // match was the word "booking" in the button the step had just clicked.
  const textBefore = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const urlBefore = page.url();
  let controlEvidence = null;

  // Navigation, when the step names a route.
  const route = (step.target || "").match(/^\/[\w/-]*/) || action.match(/\s(\/[\w/-]+)/);
  if (route && /open|go to|navigate|visit/i.test(action)) {
    await page.goto(new URL(route[0] ?? route[1], previewUrl).href, { waitUntil: "domcontentloaded" }).catch(() => {});
    drove = true;
  }

  if (/reload|refresh/i.test(action)) {
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

  if (/enter|type|fill|complete|provide/i.test(action)) {
    // A field an EARLIER contracted step already wrote is not this step's to type into. The live
    // contract derives party size as both a selection (its own step) and an input on the contact
    // step; demanding a text box for it would fail a correct application for holding the value it
    // was already given.
    const contractedInputs = interactionFlows.filter((flow) => flow.kind === "input" && flow.control
      && !writtenPaths.has(flow.control.statePath));
    // "select an account type" contains the word "type", so the contract derives BOTH a selection
    // and an input for the same field. Demanding a text box for it fails a correct chooser. When
    // every contracted input on this step is a field the same step also contracts as a SELECTION,
    // the selection is the specific claim and the input is the artefact of an ambiguous verb —
    // a step with a genuinely separate field to fill is untouched.
    const selectionKeys = new Set(interactionFlows.filter((flow) => flow.kind === "selection" && flow.control)
      .map((flow) => semanticKey(flow.control.logicalField || flow.control.accessibleName)));
    const inputsAreSelections = contractedInputs.length > 0 && contractedInputs.every((flow) =>
      selectionKeys.has(semanticKey(flow.control.logicalField || flow.control.accessibleName)));
    if (contractedInputs.length && !inputsAreSelections) {
      let result = await fillContractedFields(page, contractedInputs, marker);
      // The contracted fields may belong to a step the flow has not reached. Advance and retry,
      // bounded, and only while advancing actually changes the page.
      const advances = [];
      for (let attempt = 0; !result.complete && attempt < MAX_FLOW_ADVANCES; attempt += 1) {
        const advance = await advanceFlow(page);
        advances.push(advance);
        if (!advance.advanced) break;
        result = await fillContractedFields(page, contractedInputs, marker);
      }
      if (advances.length) result.evidence.flowAdvances = advances;
      controlEvidence = result.evidence;
      enteredValues.push(...result.evidence.fields.filter((field) => field.status === "filled")
        .map((field) => ({ field: field.field, value: field.expectedValue })));
      drove = drove || result.filled.length > 0;
      if (!result.complete) {
        const missing = result.evidence.fields.filter((field) => field.status !== "filled")
          .map((field) => `${field.field}:${field.status}`).join(", ");
        return { drove, status: "undriveable", detail: `contracted control(s) could not be driven: ${missing}`,
          controlEvidence };
      }
    } else if (!inputsAreSelections) {
      const filled = await fillVisibleForm(page, marker);
      drove = drove || filled.length > 0;
    }
    // inputsAreSelections: type nothing, and let the selection branch below drive the chooser.
  }

  // Selection steps: judged on the SEMANTIC transition (selection must move to the clicked
  // option and off the previous one), never on text freshness — a default-selected date is
  // valid product behaviour and static copy proves nothing in either direction. Triggered on
  // the ACTION verb, not the expectation's wording: "select an available date → timed slots
  // become visible" is still a selection, even though its expect describes the consequence —
  // gating on the word "selected" sent exactly that step back to the text path, which refused
  // the default-selected date all over again. When no selectable group matches, the generic
  // path below still applies.
  if (!navigated && /\b(choose|select|pick)\b/i.test(action) && !/\bnumbers? of\b|amount|quantity/i.test(action)) {
    // "choose to cancel the booking" derives a SELECTION whose field is the bare verb `cancel`,
    // because the step says "choose". There is no option group called cancel — it is a button —
    // and demanding one made a working cancellation undriveable. controlIdentity already names
    // these words as identifying no control on their own; a selection over one of them is an
    // artefact of the verb, and the step's real action kind is handled below.
    const cancels = interactionFlows.some((flow) => flow.kind === "cancellation");
    const selectionFlows = cancels ? [] : interactionFlows.filter((flow) => flow.kind === "selection"
      && flow.control && !identifiesNothing(flow.control.logicalField || flow.control.accessibleName));
    if (selectionFlows.length) {
      const outcomes = [];
      const used = new Set();
      const advances = [];
      for (const flow of selectionFlows) {
        let outcome = await driveSelection(page, step, flow, used, journeyFlows);
        // The contracted group may belong to a step the flow has not reached. Advance and retry,
        // bounded, and only while advancing actually changes the page. The retry re-locates the
        // group by IDENTITY, so advancing can never hand this step a different group's controls.
        for (let attempt = 0; !outcome && attempt < MAX_FLOW_ADVANCES; attempt += 1) {
          const advance = await advanceFlow(page);
          advances.push(advance);
          if (!advance.advanced) break;
          outcome = await driveSelection(page, step, flow, used, journeyFlows);
        }
        if (!outcome) return { drove: outcomes.length > 0, status: "undriveable",
          detail: `no selectable control group matched contracted field ${flow.control.logicalField}`,
          controlEvidence: { contractedField: flow.control.logicalField, flowAdvances: advances,
            aliases: flow.control.accessibleNames || [flow.control.accessibleName] } };
        used.add(outcome.groupKey);
        outcomes.push(outcome);
        if (outcome.status !== "pass") return outcome;
        if (flow.control.statePath) writtenPaths.add(flow.control.statePath);
        if (outcome.selectedText) selections.push(outcome.selectedText);
      }
      return { drove: true, status: "pass", detail: outcomes.map((row) => row.detail).join("; "),
        selectedTexts: outcomes.map((row) => row.selectedText).filter(Boolean),
        controlEvidence: { selections: outcomes.map((row) => row.controlEvidence), flowAdvances: advances } };
    }
    const outcome = await driveSelection(page, step);
    if (outcome) return outcome;
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

  // "use" joined the verb list after a live run: "use the page navigation (Contact
  // navigation link)" drove nothing and the whole journey went undriveable-then-fail.
  if (!navigated && !droveStepper && /click|select|choose|submit|press|tap|continue|advance|proceed|confirm|cancel|sign|book|use/i.test(action)) {
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
      target = await firstVisible(candidatesFor(page, `${step.target || ""} ${action}`), deadline);
    }
    if (target) {
      await target.click({ timeout: 5_000 }).catch(() => {});
      drove = true;
    } else if (!isReviewObservation) {
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
  // Submit-shaped outcomes ride a real backend round-trip — visitor-session establishment
  // through the app-auth edge function measured ~12s on a cold start, past the 10s window.
  const pollBudget = !drove ? 0 : /submit|send|confirm|book|reserve|pay/i.test(action) ? 20_000 : 10_000;
  const pollDeadline = Date.now() + pollBudget;
  for (;;) {
    found = [];
    fresh = [];
    for (const word of wanted) {
      const hit = await page.getByText(new RegExp(word, "i")).first().isVisible().catch(() => false);
      if (!hit) continue;
      found.push(word);
      // New since the step ran, which is the only kind of evidence that the step DID something.
      if (!before.includes(word)) fresh.push(word);
    }
    if (Date.now() >= pollDeadline) break;
    const early = expectationOutcome({ wanted, found, fresh, drove, action, urlChanged: page.url() !== urlBefore });
    if (early.status === "pass") break;
    await page.waitForTimeout(500);
  }

  // A stepper-driven step is judged on the OBSERVABLE transition: the counter's page text
  // changed (2 → 3 is a real state change) while the expectation words are usually meta-
  // prose ("summary updates with counts") that exists statically. Live evidence: a working
  // guest counter failed as "nothing changed" because every keyword was already on screen.
  if (droveStepper && found.length / wanted.length >= 0.5) {
    const textAfter = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    if (textAfter !== textBefore) {
      return { drove, status: "pass", detail: `counter changed the page (${found.join(", ")} present)` };
    }
  }

  // Some expectations are about FORM STATE, not visible text — "the fields accept the details",
  // "continue becomes enabled". Searching the page for the word "fields" will never satisfy those,
  // and reporting them as failures would blame the app for the driver's literalism. So when the
  // step filled something, ask the page the question the step was really asking. Applies BOTH
  // when the words are missing AND when they are all static (nothing fresh) — a live fill step
  // failed as "nothing changed" purely because its meta-words pre-existed on the page.
  if ((found.length / wanted.length < 0.5 || fresh.length === 0) && /field|detail|input|form|accept|valid|enabled|complete/i.test(expect)) {
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
    if (state && /enabled/i.test(expect) && state.enabledButtons > 0) {
      return { drove, status: "pass", detail: `${state.enabledButtons} control(s) enabled` };
    }
  }

  // A click that changed the URL is a navigation whatever verb the contract used: the CTA step
  // failed live because the words it expected existed on the HOME page too — but the whole page
  // was new, which is exactly the navigational exemption.
  const urlChanged = page.url() !== urlBefore;
  // The review exemption is armed ONLY when there are exact contracted values to check, so the
  // stronger verification below always runs in its place. A review with nothing to verify keeps
  // the ordinary freshness rule.
  const isReviewStep = interactionFlows.some((flow) => flow.kind === "review");
  const outcome = expectationOutcome({
    wanted, found, fresh, drove, action, urlChanged,
    reviewWithValues: isReviewStep && enteredValues.length > 0,
  });

  if (outcome.status === "pass" && isReviewStep && enteredValues.length) {
    const reviewText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const missingValues = enteredValues.filter(({ value }) => !reviewText.includes(value));
    if (missingValues.length) return { ...outcome, status: "fail",
      detail: `review omitted exact contracted values: ${missingValues.map((row) => row.field).join(", ")}`,
      controlEvidence: { enteredValues, missingValues } };
    outcome.detail += ` · review contains ${enteredValues.length} exact entered value(s)`;
  }

  // A passing confirmation must reflect what was actually selected earlier in the journey — the
  // numbers in a chosen date/slot survive any formatting.
  if (outcome.status === "pass" && selections.length && /confirmation|reference|summary|booking details/i.test(expect)) {
    const textAfter = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
    const reflect = confirmationReflectsSelections(textAfter, selections);
    if (reflect.checked && !reflect.ok) return { ...outcome, status: "fail", detail: reflect.detail };
    if (reflect.checked) outcome.detail += ` · reflects the selection (${reflect.matched})`;
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
}) {
  const ratio = found.length / wanted.length;
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
  // jump/scroll/navigation joined the navigational class after a live run: a single-page
  // app renders every section statically, so "use the navigation to jump to services" can
  // never produce FRESH words — static presence at ≥half the keywords is the right bar.
  const navigational = urlChanged || /open|go to|navigate|navigation|visit|reload|refresh|jump|scroll/i.test(action);
  if (ratio >= 0.5 && (navigational || fresh.length > 0)) {
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

// ── the journey ───────────────────────────────────────────────────────────────────────────────

/**
 * Drive every journey in the contract.
 *
 * Returns `{ pass, journeys, failures, undriveable, consoleErrors, failedRequests }`.
 * `pass` reflects the PRIMARY journey only — that is the one the brief says gates the preview.
 */
export async function verifyJourneys({
  previewUrl, contract, timeoutMs = 240_000, viewport = { width: 1280, height: 900 },
}) {
  const results = [];
  const consoleErrors = [];
  const failedRequests = [];
  const marker = String(Date.now()).slice(-6);
  let browser = null;

  try {
    const { chromium } = requireCjs("playwright");
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    page.on("pageerror", (e) => consoleErrors.push(e.message.slice(0, 200)));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });
    page.on("response", (r) => {
      if (r.status() >= 400 && !r.url().includes("favicon")) {
        failedRequests.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`);
      }
    });

    // Is the preview actually there? Without this, an unreachable URL leaves a blank page, every
    // expectation goes unmet, and the run reports confident journey failures for an app it never
    // loaded — failing a build over infrastructure, in the most expensive place possible.
    const landing = await page.goto(previewUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
      .catch((error) => ({ error }));
    const reachable = landing && !landing.error && (typeof landing.status !== "function" || landing.status() < 400);
    if (!reachable) {
      return {
        pass: null, unavailable: true, journeys: [],
        error: `the preview did not load (${landing?.error?.message?.slice(0, 120) || `HTTP ${landing?.status?.()}`})`,
        consoleErrors, failedRequests,
      };
    }

    const deadline = Date.now() + timeoutMs;
    // Primary first: if the run is going to time out, it should time out having proved the thing
    // that actually gates the preview.
    const ordered = [...(contract?.journeys || [])]
      .sort((a, b) => (a.priority === "primary" ? -1 : 0) - (b.priority === "primary" ? -1 : 0));

    for (const journey of ordered) {
      if (Date.now() > deadline) {
        results.push({ id: journey.id, title: journey.title, priority: journey.priority, status: "skipped", steps: [] });
        continue;
      }
      // Every journey starts from a clean load of the app, not from wherever the last one ended.
      await page.goto(previewUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForTimeout(700);

      const steps = [];
      const selections = []; // what this journey actually chose — confirmations must reflect it
      const enteredValues = []; // exact contracted values; review must echo them
      const writtenPaths = new Set(); // contracted state this journey has already written
      // The journey's whole contracted order. A selection that advances the flow proves it did so
      // by reaching the control the CONTRACT names next, which cannot be known from one step.
      const journeyFlows = [...((contract?.interactionContract?.flows) || [])]
        .filter((flow) => flow.journeyId === journey.id)
        .sort((a, b) => a.stepIndex - b.stepIndex);
      let blockedBy = null;
      for (const [stepIndex, step] of (journey.steps || []).entries()) {
        if (Date.now() > deadline) { steps.push({ ...step, status: "skipped" }); continue; }
        if (blockedBy) {
          steps.push({ action: step.action, expect: step.expect, status: "not_reached",
            detail: `not reached because step ${blockedBy.stepIndex + 1} was ${blockedBy.status}`,
            blockedBy: blockedBy.stepIndex });
          continue;
        }
        const interactionFlows = interactionFlowsFor(contract, journey.id, stepIndex);
        const outcome = await runStep(page, step, {
          marker, previewUrl, selections, enteredValues, interactionFlows, journeyFlows, writtenPaths,
        }).catch((error) => ({
          status: "undriveable", detail: `driver error: ${error.message.slice(0, 120)}`,
        }));
        if (outcome.selectedText) selections.push(outcome.selectedText);
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
        steps, failedSteps: failed.length, undriveableSteps: undriveable.length,
      });
    }
  } catch (error) {
    return {
      pass: null, journeys: results, error: error.message,
      consoleErrors, failedRequests,
      // A verifier that cannot start must not be read as "the app is broken".
      unavailable: true,
    };
  } finally {
    await browser?.close().catch(() => {});
  }

  const primary = results.find((j) => j.priority === "primary") || results[0];
  return {
    pass: primary ? primary.status === "pass" : null,
    primaryStatus: primary?.status || null,
    journeys: results,
    failures: results.filter((j) => j.status === "fail"),
    undriveable: results.filter((j) => j.status === "undriveable"),
    consoleErrors: [...new Set(consoleErrors)].slice(0, 10),
    failedRequests: [...new Set(failedRequests)].slice(0, 10),
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
  for (const error of result?.consoleErrors || []) out.push(`the browser console reports: ${error}`);
  for (const request of result?.failedRequests || []) out.push(`a network request failed: ${request}`);
  return out;
}

/** One line for the diagnostics record. */
export function journeySummary(result) {
  if (result?.unavailable) return `journeys not run (${result.error})`;
  return (result?.journeys || [])
    .map((j) => `${j.id}:${j.status}${j.failedSteps ? `(${j.failedSteps} failed)` : ""}`)
    .join(" · ") || "no journeys";
}
