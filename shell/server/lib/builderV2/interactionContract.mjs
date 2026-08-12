// Machine-readable interaction and data-flow authority for generated workflows.
//
// This is deliberately generic: it describes controls, state transitions and durable edges from
// the implementation contract. It does not render JSX or prescribe a booking visual template.

import { parse } from "@babel/parser";

import {
  ACTION_INTENT, actionIntents, commencesSomething, progressesSomething,
} from "./actionIntent.mjs";
import { aggregateCapabilityFacts, FACTORY_METHODS } from "./capabilityLint.mjs";
import { CAPABILITIES } from "./capabilityRegistry.mjs";
import { bindCapabilities, deriveModulePlan } from "./contractTiering.mjs";
import {
  IDENTITY_STOP_WORDS, identityMatches, semanticAliases, semanticKey, semanticQualifier,
} from "./controlIdentity.mjs";
import { declaredLifecycleRole } from "./lifecycleOperations.mjs";
import { ADVANCE_ACTION_ID, actionIdFor, controlIdFor } from "./verificationManifest.mjs";

// A method name that changes a durable record. Domain-neutral vocabulary: it reads the
// registry's real interfaces rather than naming any application's capability.
const DURABLE_MUTATION = /^(?:cancel|remove|delete|update|archive|void|close)/i;
const factoryFor = (name) => (CAPABILITIES[name]?.interface || []).find((entry) => /^make[A-Z]/.test(entry)) || null;

/**
 * Which bound capability owns durable state changes for this contract.
 *
 * Derived from the contract's own bindings and the registry's declared interfaces, so a CRM
 * resolves to makeEntityStore.update/remove, a booking app to makeBookingSystem.cancelBooking,
 * and a contract that binds no durable owner resolves to nothing at all.
 */
export function durableOperationOwner(bindings = []) {
  const candidates = (bindings || [])
    .map((binding) => ({ binding, factory: factoryFor(binding.name) }))
    .filter((row) => row.factory && FACTORY_METHODS[row.factory])
    .map((row) => ({ ...row, methods: FACTORY_METHODS[row.factory].filter((method) => DURABLE_MUTATION.test(method)) }))
    .filter((row) => row.methods.length);
  const preferred = candidates.find((row) => row.binding.requiredMethods?.length) || candidates[0];
  return preferred
    ? { capability: preferred.binding.name, factory: preferred.factory, methods: preferred.methods }
    : null;
}

/** Which bound capability owns in-progress (pre-commit) interaction state, if any. */
export function draftStateOwner(bindings = []) {
  const binding = (bindings || []).find((row) => Array.isArray(CAPABILITIES[row.name]?.uiContract)
    && (CAPABILITIES[row.name]?.entities || []).length === 0 && factoryFor(row.name)
    && FACTORY_METHODS[factoryFor(row.name)]?.includes("getState"));
  return binding ? { capability: binding.name, factory: factoryFor(binding.name) } : null;
}

const SOURCE = /^src\/.*\.(?:jsx?|tsx?)$/;
const PLATFORM = /^src\/lib\/(?:capabilities\/|backend\/|visitorSession\.js$|assets\.js$|assetData\.js$)/;
const AST_SKIP = new Set(["loc", "start", "end", "extra", "errors", "comments", "tokens"]);
const STOP = IDENTITY_STOP_WORDS;

const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const words = (value) => String(value || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
const unique = (values) => [...new Set(values.filter(Boolean))];

/**
 * Does this step ENTER a multi-step flow?
 *
 * A live contract derived no flow at all for "start the booking flow": the mutation test matched
 * `\bbook\b`, "booking" is not "book", and nothing else applied. Two secondary journeys were then
 * unreachable because the contract never said how the flow is entered. Adding "booking" to a word
 * list would fix that one prose and leave "begin checkout", "create an order", "open onboarding"
 * and "start a return" just as broken.
 *
 * Flow entry is therefore recognised STRUCTURALLY. A commencement verb is necessary but never
 * sufficient: the step must also write no contracted value of its own, and the journey must go on
 * to drive contracted controls. That is what distinguishes "begin checkout" (an entry action, with
 * a flow behind it) from "the created order is displayed" (prose, with nothing behind it).
 *
 * The language half of that test — is a commencement verb even present, in any inflection — is
 * canonical (actionIntent.mjs); only the structure is decided here.
 */
function entersFlow(step, { laterStepsDriveControls = false, writesOwnValue = false } = {}) {
  if (!laterStepsDriveControls || writesOwnValue) return false;
  // A step whose target is a ROUTE is navigation — "open the booking application (/)" loads a
  // page, it does not press the control that begins the flow.
  if (/^\s*\//.test(String(step?.target || ""))) return false;
  return commencesSomething(step);
}

/**
 * Does this step ADVANCE an established flow without writing anything itself?
 *
 * "advance to the contact details step" derived NO flow at all: it writes no value, names no
 * route, and "advance" appears in no verb list — so the contract never represented the one thing
 * the step exists to do, and the driver fell through to keyword clicking. The same hole swallows
 * "continue to payment", "proceed to shipping" and "move to review".
 *
 * Structural, exactly like flow entry: a progression verb is necessary but never sufficient. The
 * step must write no contracted value, must not target a route, and the journey must go on to
 * drive contracted controls — otherwise "continue" in ordinary prose would become an action.
 */
function advancesFlow(step, { laterStepsDriveControls = false, writesOwnValue = false } = {}) {
  if (!laterStepsDriveControls || writesOwnValue) return false;
  if (/^\s*\//.test(String(step?.target || ""))) return false;
  return progressesSomething(step);
}

/**
 * The contracted interaction kinds of one step, from its CANONICAL intents.
 *
 * Every language decision here comes from actionIntent.mjs, so "booking", "cancellation",
 * "confirmation", "recovery" and "advancing" are understood as the same intents as their bare
 * stems, and a record noun in ordinary prose is understood as neither.
 */
function actionKinds(step, context = {}) {
  const intents = actionIntents(step);
  const kinds = [];
  if (intents.has(ACTION_INTENT.SELECTION)) kinds.push("selection");
  if (intents.has(ACTION_INTENT.INPUT)) kinds.push("input");
  if (intents.has(ACTION_INTENT.REVIEW)) kinds.push("review");
  if (intents.has(ACTION_INTENT.CONFIRM)) kinds.push("mutation");
  if (intents.has(ACTION_INTENT.RECOVER)) kinds.push("recovery");
  if (intents.has(ACTION_INTENT.LOOKUP)) kinds.push("lookup");
  // A cancellation is its own durable transition. It rides ALONGSIDE the commit rather than
  // replacing it: "confirm cancellation" both presses a commit control and cancels the record,
  // and dropping either half loses a real contracted fact.
  if (intents.has(ACTION_INTENT.CANCEL)) kinds.push("cancellation");
  // Flow entry outranks the mutation reading of the same verb: "create an order" that is followed
  // by the steps which fill the order is the door, not the commit.
  const writesOwnValue = kinds.includes("selection") || kinds.includes("input");
  if (entersFlow(step, { laterStepsDriveControls: context.laterStepsDriveControls, writesOwnValue })) {
    return unique(["flow_start", ...kinds.filter((kind) => !["mutation", "navigation", "action"].includes(kind))]);
  }
  // A pure transition step: it writes nothing, so it is only ever the movement between two
  // contracted states. Checked before the loose navigation/action fallbacks, which would
  // otherwise swallow it as an untyped click.
  if (!kinds.length && advancesFlow(step, { laterStepsDriveControls: context.laterStepsDriveControls })) {
    return ["flow_advance"];
  }
  if (!kinds.length && intents.has(ACTION_INTENT.NAVIGATE)) kinds.push("navigation");
  if (!kinds.length && intents.has(ACTION_INTENT.ACTIVATE)) kinds.push("action");
  return unique(kinds);
}

/**
 * Does the ACTION ask for a deliberately invalid value?
 *
 * A contracted negative-validation step ("enter an invalid email address") could not be driven:
 * value generation always produced a realistic, VALID value, so a correct application's validation
 * never fired and the step failed the app for working. Intent is read from the action alone —
 * never from the expectation, or every step mentioning a validation message would start entering
 * rubbish.
 */
export function inputValidity(step) {
  const action = String(step?.action || "");
  if (/\binvalid\b/i.test(action)) return "invalid";
  if (/\bvalid\b/i.test(action)) return "valid";
  return "unspecified";
}

/**
 * WHICH field the validity intent is about.
 *
 * A step contracts one intent but may contract several fields: "enter an invalid contact email"
 * derives contactEmail AND contactName, because naming the contact pulls the whole contact group
 * in. Stamping the invalid intent on both asks the application to reject a perfectly ordinary
 * name — a demand no correct app can satisfy and one the driver reports as
 * `validation_intent_unsupported`. The action already says which value it means, by naming it.
 *
 * When the action names none of the step's fields the intent stays with all of them, which is the
 * single-field case every earlier contract had ("enter an invalid email address").
 */
function validityFor(step, field, fields) {
  const validity = inputValidity(step);
  if (validity === "unspecified" || !field) return validity;
  const names = (candidate) => semanticAliases(candidate).map(normalized).filter(Boolean);
  const action = normalized(step?.action);
  const named = (fields || []).filter((candidate) => candidate
    && names(candidate).some((alias) => action.includes(alias)));
  if (!named.length || named.includes(field)) return validity;
  return "unspecified";
}

function fieldCandidates(contract, text, kind) {
  const haystack = normalized(text);
  const allDeclared = (contract?.entities || []).flatMap((entity) => entity?.fields || []);
  const declared = allDeclared
    .map((field) => String(field?.name || "")).filter(Boolean)
    .filter((name) => haystack.includes(normalized(name))
      || words(name.replace(/([a-z])([A-Z])/g, "$1 $2")).some((word) => haystack.includes(normalized(word))));
  let semantic = [
    ["date", /date|day/], ["slot", /slot|time/], ["partySize", /party|quantity|people|guest|adult|child/],
    ["name", /name/], ["email", /email/], ["phone", /phone|telephone/], ["contact", /contact|details/],
  ].filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  if (kind === "selection") semantic = semantic.filter((name) => ["date", "slot", "partySize"].includes(name));
  if (kind === "input") semantic = semantic.filter((name) => ["partySize", "name", "email", "phone", "contact"].includes(name));
  if (semantic.includes("contact") && semantic.some((name) => ["name", "email", "phone"].includes(name))) {
    semantic = semantic.filter((name) => name !== "contact");
  }
  if (kind === "input" && /contact|details|guest|customer|profile/i.test(text)) {
    declared.push(...allDeclared.map((field) => String(field?.name || "")).filter((name) => /name|email|phone|contact/i.test(name)));
  }
  // Prefer the contract's actual field identity over a second generic alias. A booking entity
  // with guestName/guestEmail/guestPhone needs three controls, not six parallel `guestName` +
  // `name` facts that can drift independently.
  const declaredSuffixes = new Set(declared.map((name) => normalized(name).match(/(name|email|phone)$/)?.[1]).filter(Boolean));
  semantic = semantic.filter((name) => !declaredSuffixes.has(normalized(name))
    || declared.some((declaredName) => normalized(declaredName) === normalized(name)));
  const fallback = words(text).filter((word) => !STOP.has(word)).slice(0, 2);
  const candidates = unique([...declared, ...semantic, ...(declared.length || semantic.length ? [] : fallback)]);
  // One control per CONCEPT AND QUALIFIER. `date`, `dateId` and `dateLabel` are one control
  // described three ways, and `guestName` beside a generic `name` is still one control — those
  // must not multiply. But `guestName` and `leadName` are two different boxes, and collapsing
  // them by concept alone dropped one of every such pair before it ever reached the contract.
  const kept = [];
  for (const name of candidates) {
    const key = semanticKey(name);
    const qualifier = semanticQualifier(name);
    const sameControl = kept.some((existing) => {
      if (semanticKey(existing) !== key) return false;
      const other = semanticQualifier(existing);
      return !other || !qualifier || other === qualifier;
    });
    if (!sameControl) kept.push(name);
  }
  return kept.slice(0, kind === "input" ? 8 : 4);
}

// One shared vocabulary with the browser verifier — see controlIdentity.mjs.
const fieldAliases = semanticAliases;

/**
 * Which planned modules own a flow of this kind — resolved through the contract's capability
 * owners, never through a hardcoded factory name.
 */
function ownerModules(modulePlan, kind, { durableOwner = null, draftOwner = null } = {}) {
  const byFactory = (factory) => (factory
    ? modulePlan.find((module) => module.factory === factory)?.path : null) || null;
  const visual = modulePlan.find((module) => /flow|composition/i.test(module.role || ""))?.path || null;
  if (["mutation", "cancellation", "lookup"].includes(kind)) {
    return unique([byFactory(durableOwner?.factory), visual]);
  }
  if (["selection", "input", "review", "recovery", "action", "flow_start"].includes(kind)) {
    return unique([byFactory(draftOwner?.factory), visual]);
  }
  return unique([visual]);
}

/**
 * What the browser must find, and — first — the OPAQUE MACHINE IDENTITY it should find it by.
 *
 * `machineId` is computed from the control's own name by the same pure function the generated app
 * uses (verificationManifest.controlIdFor ↔ the scaffold's controlId), so the two agree without a
 * registry and without the model being told an id. Accessible names remain, but as a FALLBACK for
 * controls that carry no machine identity — never as the primary way to recognise meaning.
 */
function controlRequirement(kind, field, step) {
  const name = field || String(step?.target || step?.action || "control");
  if (kind === "input") {
    const aliases = fieldAliases(name);
    const inputTypes = /email/i.test(name) ? ["email"] : /phone|telephone/i.test(name)
      ? ["tel", "text"] : /party|quantity|number/i.test(name) ? ["number", "text"] : ["text"];
    return { purpose: name, logicalField: field || name, machineId: controlIdFor(field || name),
      roles: ["textbox", "spinbutton", "combobox"],
      inputTypes, accessibleName: aliases[0], accessibleNames: aliases, editable: true };
  }
  if (kind === "selection") return { purpose: name, roles: ["button", "radio", "option", "combobox"],
    logicalField: field || name, machineId: controlIdFor(field || name),
    accessibleName: fieldAliases(name)[0], accessibleNames: fieldAliases(name), selectedState: true };
  if (kind === "flow_start") {
    return { purpose: name, roles: ["button", "link"], flowEntry: true,
      machineId: actionIdFor(String(step?.target || step?.action || name)),
      accessibleName: String(step?.target || step?.action || name) };
  }
  // Moving a flow FORWARD is the one mechanical act every later control depends on, and the one
  // the platform can name without knowing anything about the application: there is exactly one
  // forward control per step, so it takes the canonical identity rather than one derived from
  // whatever the step's prose happened to call it.
  if (kind === "flow_advance") {
    const named = String(step?.target || step?.action || name);
    return { purpose: name, roles: ["button", "link"], flowAdvance: true,
      machineId: ADVANCE_ACTION_ID, accessibleName: named, accessibleNames: [named] };
  }
  if (["mutation", "cancellation", "lookup", "action"].includes(kind)) {
    return { purpose: name, roles: ["button"],
      machineId: actionIdFor(String(step?.target || step?.action || name)),
      accessibleName: String(step?.target || step?.action || name) };
  }
  return null;
}

/** Derive the interaction/data-flow contract once, before implementation generation. */
export function buildInteractionContract(contract, {
  modulePlan = deriveModulePlan(contract, contract?.journeys || []),
  bindings = bindCapabilities(contract),
} = {}) {
  const durableOwner = durableOperationOwner(bindings);
  const draftOwner = draftStateOwner(bindings);
  // The only things a browser control can HOLD: the fields the contract's entities declare.
  // Operations, entity names and routes are all legal contract references and none of them is a
  // field, which is exactly the distinction that was missing.
  const operableFields = new Set((contract?.entities || [])
    .flatMap((entity) => (entity?.fields || []).map((field) => normalized(field?.name)))
    .filter(Boolean));
  const flows = [];
  for (const journey of contract?.journeys || []) {
    const draftWrites = [];
    let durableRecord = null;
    // Flow entry is a structural claim: a commencement verb only enters a flow if the journey
    // actually goes on to drive contracted controls.
    const stepsList = journey.steps || [];
    const drivesControls = (from) => stepsList.slice(from).some((later) => {
      const intents = actionIntents(later);
      return intents.has(ACTION_INTENT.SELECTION) || intents.has(ACTION_INTENT.INPUT);
    });
    for (const [stepIndex, step] of stepsList.entries()) {
      const kinds = actionKinds(step, { laterStepsDriveControls: drivesControls(stepIndex + 1) });
      // WHICH CONTROLS THIS STEP OPERATES is a structured fact the contract states, not a reading
      // of its prose. "select a party size that does not exceed the slot's remaining capacity"
      // OPERATES the party size and READS the slot; the prose reader saw both as operands,
      // re-contracted a control an earlier step had already consumed and unmounted, and killed a
      // paid run on it. `reads` never becomes a browser action — it is context, not a control.
      //
      // AND AN OPERAND HAS A TYPE. `operates` may name three different kinds of thing, and until
      // 2026-08-12 all three became "a field to type into". A live contract said
      // `operates: ["create-booking"]` on its confirm step — an OPERATION id, which the contract
      // brief expressly permitted — so derivation built a textbox called "create-booking", the
      // driver tried to type into it, and the commit button was never pressed.
      //
      // Naming an operation is not a mistake; it says what the step DOES. It just does not name a
      // control that can hold a value, so it contributes no value control. An operand that names
      // nothing operable at all is a contract error, refused before generation (see
      // `implementationContract.validateContract`), never a control invented from the target text.
      const declaredOperands = Array.isArray(step?.operates)
        ? step.operates.map((value) => String(value).split(".").pop()).filter(Boolean) : null;
      const operands = declaredOperands?.length
        ? declaredOperands.filter((name) => operableFields.has(normalized(name)))
        : null;
      // Operands that were ALL operations: the step performs them and writes no value of its own.
      // Its commit/action control still comes from the kinds below — this only stops the invented
      // textbox — and an empty `operates: []` means the same as omitting it.
      const operandsAreOperations = Boolean(declaredOperands?.length) && !operands?.length;
      // With operands declared, one step drives ONE kind of control. The verb usually names the
      // primitive ("select"/"enter"); when it does not ("set the reorder quantity", "update the
      // status"), the CONTRACT decides — a declared operand means a control is operated whether or
      // not the platform's verb list happens to contain that word. `primitive` states it outright.
      const declaredPrimitive = step?.primitive === "selection" ? "selection"
        : ["textbox", "input"].includes(step?.primitive) ? "input" : null;
      const operandKind = operands
        ? (declaredPrimitive || kinds.find((row) => ["selection", "input"].includes(row)) || "input")
        : null;
      const effectiveKinds = operands && !kinds.includes(operandKind) ? [...kinds, operandKind] : kinds;
      for (const kind of effectiveKinds) {
        const drivesValues = ["selection", "input"].includes(kind);
        // A step that performs an operation writes no value THROUGH A CONTROL of its own: the verb
        // list may still read "confirm" as an input, and there is no field for it to fill.
        if (drivesValues && operandsAreOperations) continue;
        // Nor does a step that goes somewhere or comes back to it. "reload the page ⇒ the reference
        // is visible again" OPERATES the reference in the sense that the step is about it, and a
        // reload types nothing: deriving a text box there asks the browser to fill a control the
        // app is right to render read-only. A LOOKUP still keeps its input — asking for a record by
        // reference means typing the reference — so only these two kinds are excluded.
        if (drivesValues && operands
          && (kinds.includes("recovery") || /^\s*\//.test(String(step?.target || "")))) continue;
        // A second value-writing kind on a step whose operands are declared is an artefact of an
        // ambiguous verb ("select an account type" is a chooser, not a chooser AND a text box).
        if (drivesValues && operands && kind !== operandKind) continue;
        const fields = drivesValues
          ? (operands || fieldCandidates(contract, `${step.action || ""} ${step.target || ""}`, kind))
          : [null];
        for (const field of fields.length ? fields : [null]) {
          const writes = [];
          const reads = [];
          if (["selection", "input"].includes(kind)) {
            const path = `${journey.id}.draft.${field || `value${stepIndex + 1}`}`;
            writes.push(path);
            draftWrites.push(path);
          } else if (kind === "review") reads.push(...(draftWrites.length ? draftWrites : [`${journey.id}.durable.record`]));
          else if (kind === "mutation") {
            reads.push(...(draftWrites.length ? draftWrites : [`${journey.id}.input`]));
            durableRecord ||= `${journey.id}.durable.record`;
            writes.push(durableRecord, `${journey.id}.durable.reference`);
          } else if (["recovery", "lookup"].includes(kind)) {
            reads.push(durableRecord || `${journey.id}.durable.reference`);
            writes.push(`${journey.id}.restored`);
          } else if (kind === "flow_advance") {
            writes.push(`${journey.id}.advanced`);
          } else if (kind === "flow_start") {
            writes.push(`${journey.id}.flowStarted`);
          } else if (kind === "cancellation") {
            reads.push(durableRecord || `${journey.id}.durable.reference`);
            writes.push(`${journey.id}.durable.status`);
          }
          const owners = ownerModules(modulePlan, kind, { durableOwner, draftOwner });
          const stateOwner = owners[0] || `journey:${journey.id}`;
          const control = controlRequirement(kind, field, step);
          if (control) Object.assign(control, {
            stateOwner,
            statePath: writes[0] || null,
            validationOwner: kind === "input" ? stateOwner : null,
            ...(kind === "input" ? { validity: validityFor(step, field, fields) } : {}),
          });
          flows.push({
            id: `${journey.id}:${stepIndex + 1}:${kind}${field ? `:${normalized(field)}` : ""}`,
            journeyId: journey.id,
            stepIndex,
            kind,
            semanticPurpose: step.action,
            stateOwner,
            responsibleModules: owners,
            action: step.action,
            valueWritten: field || null,
            reads: unique(reads),
            writes: unique(writes),
            dependsOn: unique(reads),
            nextStateRequirement: step.expect,
            observable: step.expect,
            control,
            capability: ["mutation", "cancellation", "lookup"].includes(kind)
              ? durableOwner?.factory || null
              : draftOwner?.factory || null,
          });
        }
      }
    }
  }
  for (const flow of flows) {
    if (!flow.control) continue;
    flow.control.downstream = unique(flows.filter((candidate) => candidate.journeyId === flow.journeyId
      && candidate.stepIndex > flow.stepIndex
      && (candidate.reads || []).some((path) => (flow.writes || []).includes(path))).map((candidate) => candidate.id));
  }
  // ── durable lifecycle identity ──────────────────────────────────────────────────────────────
  //
  // One durable record must have ONE identity across every journey that touches it. Keying by the
  // capability that happens to own a STEP does not do that: a booking's confirmation is owned by
  // makeBookingSystem while the reload that recovers it is owned by makeWizardMachine, so the
  // journey that created the record and the journey that recovers it keyed to different things
  // and cross-journey recovery silently fell back to keyword matching.
  //
  // The lifecycle is therefore named once, from the contract's durable owner and its entity, and
  // stamped on every flow that reads or writes durable state. Unrelated entities cannot collide
  // because they resolve to different owners/entities.
  const durableEntity = durableOwner?.capability
    ? ((contract?.entities || []).find((entity) => (bindings || [])
      .some((binding) => binding.name === durableOwner.capability
        && binding.configuration?.entity === entity?.name))?.name
      || contract?.entities?.[0]?.name || "record")
    : contract?.entities?.[0]?.name || "record";
  const lifecycle = `${durableOwner?.capability || "durable"}:${durableEntity}`;
  for (const flow of flows) {
    const touchesDurable = [...(flow.reads || []), ...(flow.writes || [])]
      .some((path) => /\.durable\./.test(String(path)));
    if (touchesDurable) flow.durableLifecycle = lifecycle;
  }

  // ── journey scenarios ───────────────────────────────────────────────────────────────────────
  //
  // Independent journeys were being driven in whatever state a previous journey left behind —
  // after a confirmed-then-cancelled booking, a validation journey could not even reach step one.
  //
  // LIFECYCLE FIRST, GRAPH SECOND, LANGUAGE NEVER.
  //
  // The question is which of three things this journey does to a durable record: CREATE it, UPDATE
  // an existing one, or CANCEL/ARCHIVE an existing one. Two verb-based attempts answered it in
  // opposite directions and both failed, because natural-language tests are inflection-sensitive:
  // `\bbook\b` does not match "booking" and `\bcancel\b` does not match "cancellation".
  //
  // The contract's DECLARED operations answer it exactly (lifecycleOperations.mjs): a journey whose
  // operation kind is `create` produces the record; `update`, `delete` and `read` all act on a
  // record that already exists. That is what makes generic case H — an existing record reference
  // plus substantive edited fields plus UPDATE — a consumer rather than a producer, which no
  // amount of field-overlap analysis could decide, because an edit legitimately supplies the same
  // declared fields a creation does.
  //
  // The data-flow graph remains the fallback for a contract that declares no operation for a
  // journey: you CREATE a record by supplying its contents (draft values this same journey
  // gathered, naming the entity's own declared fields) WITHOUT first locating a record to act on.
  // A journey that looks one up or recovers one before committing is editing, not creating.
  const scenarios = {};
  for (const journey of contract?.journeys || []) {
    const own = flows.filter((flow) => flow.journeyId === journey.id);
    const entityFields = new Set((contract?.entities || [])
      .flatMap((entity) => (entity?.fields || []).map((field) => String(field?.name || ""))).filter(Boolean));
    // Identity and lifecycle metadata are not record CONTENTS: knowing which record you mean is
    // not the same as supplying what it contains, so a journey that reads only a reference or a
    // status is operating on something that already exists.
    const identityField = (name) => /^(id|reference|status)$/i.test(name)
      || /^(created|updated|cancelled|archived)_?at$/i.test(name)
      || (contract?.entities || []).some((entity) => new RegExp(`^${entity?.name}_?id$`, "i").test(name));
    const ownDraftPaths = new Set(own.flatMap((flow) => (flow.writes || [])
      .filter((path) => /\.draft\./.test(String(path)))));
    const draftFieldsRead = (flow) => (flow.reads || [])
      .filter((path) => ownDraftPaths.has(path))
      .map((path) => String(path).split(".draft.")[1])
      .filter(Boolean);
    const suppliesRecordContents = (flow) => draftFieldsRead(flow)
      .some((field) => entityFields.has(field) && !identityField(field));
    const readsDurable = (flow) => (flow.reads || []).some((path) => /\.durable\./.test(String(path)));

    const commits = own.filter((flow) => flow.durableLifecycle && flow.kind === "mutation");
    const firstCommit = commits.length ? Math.min(...commits.map((flow) => flow.stepIndex)) : Infinity;
    // Locating a record BEFORE committing means the record already existed, so the commit is an
    // edit however much of the record's contents it supplies. Ordered, which is what keeps generic
    // case E — create, then update the record it just created, then reload — a producer.
    //
    // A journey that is HANDED an existing record's identity without a lookup step cannot be told
    // apart structurally: field derivation legitimately writes a draft for an entity's id field
    // from prose that merely names the entity ("select a lead source" → draft.leadId), so treating
    // an identity draft as proof of an existing record turns every creation into a consumer. That
    // shape is exactly what declared operations resolve, and it is the reason they are consulted
    // first rather than as a tie-breaker.
    const actsOnExistingRecord = own.some((flow) => flow.durableLifecycle
      && ["lookup", "recovery", "cancellation"].includes(flow.kind)
      && flow.stepIndex < firstCommit && readsDurable(flow));

    const touchesDurable = own.some((flow) => flow.durableLifecycle);
    const declared = declaredLifecycleRole(contract, journey, { entity: durableEntity });
    const produces = touchesDurable && (declared
      ? declared === "creates"
      : commits.some(suppliesRecordContents) && !actsOnExistingRecord);
    // Depending on a record it did not create: it READS durable state, or the contract declares
    // that its operation acts on an existing record.
    const consumes = !produces && touchesDurable
      && (own.some((flow) => flow.durableLifecycle && readsDurable(flow)) || declared === "existing");
    const basis = declared ? "declared-operation" : "data-flow";
    scenarios[journey.id] = produces
      ? { scenario: lifecycle, role: "produces", startState: "fresh", lifecycle, basis }
      : consumes
        ? { scenario: lifecycle, role: "consumes", startState: "inherits", lifecycle, basis }
        : { scenario: `independent:${journey.id}`, role: "independent", startState: "fresh", lifecycle: null,
          basis: touchesDurable ? basis : "data-flow" };
  }

  const plan = { version: 1, flows, scenarios };
  const verdict = validateInteractionContract(plan);
  return { ...plan, valid: verdict.ok, problems: verdict.problems };
}

/** Reject a broken ownership/data-flow graph before implementation generation. */
export function validateInteractionContract(plan) {
  const problems = [];
  const produced = new Set();
  for (const flow of plan?.flows || []) {
    if (!flow.id || !flow.journeyId) problems.push("interaction flow is missing identity");
    if ((flow.writes || []).length && !flow.stateOwner) problems.push(`${flow.id} writes state without an owner`);
    const missing = (flow.reads || []).filter((path) => !produced.has(path)
      && !/\.(?:durable\.(?:record|reference)|input)$/.test(path));
    if (missing.length) problems.push(`${flow.id} reads state before it is produced: ${missing.join(", ")}`);
    if (flow.kind === "review" && !(flow.reads || []).length) problems.push(`${flow.id} review has no source values`);
    if (flow.kind === "mutation" && !(flow.reads || []).length) problems.push(`${flow.id} mutation consumes no contracted input state`);
    // Any bound durable capability may own cancellation; the registry decides which, not a
    // hardcoded factory name.
    if (flow.kind === "cancellation" && !flow.capability) {
      problems.push(`${flow.id} cancellation has no durable operation owner`);
    }
    if (flow.control && (!flow.control.accessibleName || !(flow.control.roles || []).length)) {
      problems.push(`${flow.id} interactive control has no driveable semantic contract`);
    }
    for (const path of flow.writes || []) produced.add(path);
  }
  return { ok: problems.length === 0, problems };
}

export function interactionContractBrief(plan) {
  if (!(plan?.flows || []).length) return "INTERACTION CONTRACT: no interactive state transitions in this scope.";
  return [
    "INTERACTION CONTRACT (machine-enforced JSON; implement these state/data-flow edges before styling):",
    JSON.stringify({ version: plan.version, flows: plan.flows }, null, 2),
    "Every contracted control must be present, editable when it accepts input, semantically identifiable through standard HTML/ARIA, connected to its declared state owner, and propagated to downstream review/confirmation consumers.",
    "Use label/htmlFor, a wrapping label, aria-label, or aria-labelledby for accessible names; name/id/placeholder may assist location but do not replace an accessible name.",
    "Visual design remains unrestricted.",
  ].join("\n");
}

/**
 * Which assembly shapes this scope actually needs — derived from the interaction contract and
 * the contract's own bindings, so it is identical for a party size, a subscription tier, an
 * inventory option, a CRM stage or a shipping method. No domain vocabulary participates.
 */
export function assemblyNeeds(plan, bindings = []) {
  const kinds = new Set((plan?.flows || []).map((flow) => flow.kind));
  const controls = (plan?.flows || []).filter((flow) => flow.control);
  return {
    selection: controls.some((flow) => flow.control.selectedState === true) || kinds.has("selection"),
    field: controls.some((flow) => flow.control.editable === true) || kinds.has("input"),
    // Durable records are implied by what the journeys DO — a mutation, a lookup, a recovery or
    // a cancellation — not by which capability happens to declare an entity name.
    entities: ["mutation", "lookup", "recovery", "cancellation"].some((kind) => kinds.has(kind)),
    // A store only holds screen state when there is in-progress state to hold or records to
    // render. Every contract binds the generic entity store, so its mere presence proves nothing.
    capabilityState: Boolean(draftStateOwner(bindings))
      || ["mutation", "lookup", "recovery", "cancellation"].some((kind) => kinds.has(kind)),
    // A durable multi-step flow that can be completed or abandoned reaches a TERMINAL state its
    // store refuses to edit and restores on the next visit. A live run stalled on exactly that.
    terminalReset: Boolean(draftStateOwner(bindings))
      && ["mutation", "cancellation"].some((kind) => kinds.has(kind)),
    status: ["mutation", "recovery", "cancellation", "lookup"].some((kind) => kinds.has(kind)),
    // A flow that writes more than one value MAY paginate, and a paginated flow hides its later
    // controls behind a forward control. Whether it does is a design choice; that the forward
    // control must be identifiable if it exists is not. Counted per journey, from value-writing
    // steps alone — no vocabulary, and the same for a wizard, a checkout or a multi-part form.
    flowAdvance: kinds.has("flow_advance") || Boolean(draftStateOwner(bindings))
      || [...new Set(controls.map((flow) => flow.journeyId))].some((journeyId) => new Set(controls
        .filter((flow) => flow.journeyId === journeyId && ["input", "selection"].includes(flow.kind))
        .map((flow) => flow.stepIndex)).size > 1),
  };
}

export function scopeInteractionContract(plan, journeys = []) {
  const ids = new Set((journeys || []).map((journey) => journey?.id).filter(Boolean));
  return { version: plan?.version || 1, flows: (plan?.flows || []).filter((flow) => ids.has(flow.journeyId)) };
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (AST_SKIP.has(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}

function literal(node) {
  if (["StringLiteral", "Literal"].includes(node?.type)) return String(node.value || "");
  if (node?.type === "JSXText") return String(node.value || "");
  if (node?.type === "JSXExpressionContainer") return literal(node.expression);
  if (node?.type === "TemplateLiteral" && !node.expressions?.length) return node.quasis.map((row) => row.value.cooked).join("");
  return "";
}

function attr(opening, name) {
  const row = (opening?.attributes || []).find((item) => item.type === "JSXAttribute" && item.name?.name === name);
  if (!row) return null;
  if (!row.value) return "true";
  return literal(row.value);
}

function attrRow(opening, name) {
  return (opening?.attributes || []).find((item) => item.type === "JSXAttribute" && item.name?.name === name) || null;
}

function attrSource(raw, opening, name) {
  const row = attrRow(opening, name);
  return row && Number.isInteger(row.start) && Number.isInteger(row.end) ? String(raw).slice(row.start, row.end) : "";
}

function staticBooleanAttr(opening, name) {
  const row = attrRow(opening, name);
  if (!row) return false;
  if (!row.value) return true;
  if (["StringLiteral", "Literal"].includes(row.value.type)) return String(row.value.value).toLowerCase() !== "false";
  const expression = row.value.type === "JSXExpressionContainer" ? row.value.expression : null;
  if (expression?.type === "BooleanLiteral") return expression.value;
  return null; // dynamic: browser verification remains authoritative
}

function jsxName(node) {
  return node?.name?.type === "JSXIdentifier" ? node.name.name : null;
}

function handlerDefinition(raw, handlerSource) {
  const name = String(handlerSource || "").match(/=\{\s*([A-Za-z_$][\w$]*)\s*\}/)?.[1];
  if (!name) return "";
  const pattern = new RegExp(`(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\s*=)`);
  const match = pattern.exec(raw);
  return match ? String(raw).slice(match.index, match.index + 1200) : "";
}

function nativeRole(tag, opening) {
  const lower = String(tag || "").toLowerCase();
  const component = ["input", "textarea", "select", "button", "option"].includes(lower) ? lower : null;
  if (component === "input") {
    const type = String(attr(opening, "type") || "text").toLowerCase();
    if (type === "number") return "spinbutton";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "textbox";
  }
  return { textarea: "textbox", select: "combobox", button: "button", option: "option" }[component] || null;
}

/** Source-backed facts used by both the deterministic lint and browser-repair diagnostics. */
export function collectInteractionControls(tree) {
  const controls = [];
  for (const [file, raw] of Object.entries(tree || {})) {
    if (!SOURCE.test(file) || PLATFORM.test(file)) continue;
    let ast;
    try {
      ast = parse(String(raw), { sourceType: "module", plugins: [/\.tsx?$/.test(file) ? "typescript" : null,
        /\.(?:jsx|tsx)$/.test(file) ? "jsx" : null].filter(Boolean) });
    } catch { continue; }
    const labels = [];
    const namedText = new Map();
    walk(ast, (node) => {
      if (node.type !== "JSXElement") return;
      const opening = node.openingElement;
      const tag = jsxName(opening);
      const childText = (node.children || []).map(literal).join(" ").replace(/\s+/g, " ").trim();
      const id = attr(opening, "id");
      if (id && childText) namedText.set(id, childText);
      if (String(tag || "").toLowerCase() === "label") {
        labels.push({ htmlFor: attr(opening, "htmlFor") || attr(opening, "for"), text: childText,
          start: node.start ?? -1, end: node.end ?? -1 });
      }
    });
    walk(ast, (node) => {
      if (node.type !== "JSXElement") return;
      const opening = node.openingElement;
      const tag = jsxName(opening);
      const role = attr(opening, "role") || nativeRole(tag, opening);
      if (!role) return;
      const childText = (node.children || []).map(literal).join(" ").replace(/\s+/g, " ").trim();
      const id = attr(opening, "id");
      const label = labels.find((row) => (id && row.htmlFor === id)
        || (row.start <= (node.start ?? -1) && row.end >= (node.end ?? -1)));
      const ariaLabel = attr(opening, "aria-label");
      const labelledBy = attr(opening, "aria-labelledby");
      const labelledByText = labelledBy ? labelledBy.split(/\s+/).map((key) => namedText.get(key)).filter(Boolean).join(" ") : "";
      const title = attr(opening, "title");
      const accessibleName = ariaLabel || labelledByText || label?.text || title || null;
      const nameAttr = attr(opening, "name");
      const placeholder = attr(opening, "placeholder");
      const type = String(attr(opening, "type") || (String(tag).toLowerCase().includes("textarea") ? "textarea" : "text")).toLowerCase();
      const changeHandlerSource = [attrSource(raw, opening, "onChange"), attrSource(raw, opening, "onInput")].filter(Boolean).join(" ");
      const resolvedHandlerSource = handlerDefinition(String(raw), changeHandlerSource);
      const valueSource = [attrSource(raw, opening, "value"), attrSource(raw, opening, "defaultValue"),
        attrSource(raw, opening, "checked")].filter(Boolean).join(" ");
      controls.push({
        file, line: node.loc?.start?.line || null, span: { start: node.start ?? null, end: node.end ?? null },
        tag, role, inputType: type, name: unique([accessibleName, nameAttr, id, placeholder, title, childText]).join(" "),
        accessibleName, ariaLabel: ariaLabel || null, labelledBy: labelledBy || null,
        label: label?.text || null, nameAttr: nameAttr || null, id: id || null,
        placeholder: placeholder || null, title: title || null,
        locatorIdentities: unique([accessibleName, ariaLabel, labelledByText, label?.text, nameAttr, id, placeholder, title, childText]),
        disabled: staticBooleanAttr(opening, "disabled"), readOnly: staticBooleanAttr(opening, "readOnly"),
        controlled: Boolean(attrRow(opening, "value") || attrRow(opening, "checked")),
        hasChangeHandler: Boolean(changeHandlerSource), changeHandlerSource, resolvedHandlerSource, valueSource,
        selectedState: ["aria-pressed", "aria-selected", "checked"].some((key) => attrRow(opening, key) !== null),
      });
    });
  }
  return controls;
}

function nameMatches(control, required) {
  return identityMatches(control.locatorIdentities || [control.name], required);
}

function stateConnection(control, flow) {
  const aliases = unique([flow.valueWritten, flow.control?.logicalField, ...(flow.control?.accessibleNames || [])]);
  const evidence = normalized([control.valueSource, control.changeHandlerSource, control.resolvedHandlerSource].join(" "));
  if (aliases.some((alias) => evidence.includes(normalized(alias)))) return true;
  const actualName = normalized(control.nameAttr);
  const named = Boolean(actualName) && aliases.some((alias) => normalized(alias)
    && (actualName === normalized(alias) || actualName.endsWith(normalized(alias)) || normalized(alias).endsWith(actualName)));
  const generic = /targetname|currenttargetname|formdata/.test(evidence);
  // A named uncontrolled field can be read by its containing form. AST lint deliberately stops
  // here; only the browser can prove the later transition.
  return named && (!control.controlled || generic);
}

/** Generic pre-browser lint: driveability plus obvious review/confirmation/cancellation breaks. */
export function lintInteractiveWorkflow(tree, { interactionContract, modulePlan = [], bindings = [] } = {}) {
  const findings = [];
  const controls = collectInteractionControls(tree);
  const reject = (code, message, flow = null, details = {}) => findings.push({ code, message,
    journeyId: flow?.journeyId || null, interactionId: flow?.id || null, ...details });

  for (const flow of interactionContract?.flows || []) {
    if (!flow.control) continue;
    const roleMatches = controls.filter((control) => flow.control.roles.includes(control.role));
    const matches = roleMatches.filter((control) =>
      nameMatches(control, flow.control.accessibleNames || flow.control.accessibleName));
    if (!matches.length) {
      const provenanceMatches = flow.control.editable ? roleMatches.filter((control) => stateConnection(control, flow)) : [];
      if (provenanceMatches.length) {
        reject("interaction_control_undriveable", `${flow.id} has no standards-based accessible identity`, flow, {
          field: flow.control.logicalField, expectedRoles: flow.control.roles,
          accessibleName: flow.control.accessibleName, expectedStateOwner: flow.stateOwner,
          reason: "missing_accessible_identity", controls: provenanceMatches,
        });
        continue;
      }
      reject("interaction_control_undriveable", `${flow.id} has no semantic ${flow.control.roles.join("/")} control named for ${flow.control.accessibleName}`, flow,
        { field: flow.control.logicalField, expectedRoles: flow.control.roles,
          accessibleName: flow.control.accessibleName, expectedStateOwner: flow.stateOwner,
          reason: "missing_editable_control", responsibleModules: flow.responsibleModules });
      continue;
    }
    const compatible = matches.filter((control) => !flow.control.inputTypes?.length
      || !control.inputType || flow.control.inputTypes.includes(control.inputType));
    if (flow.control.editable && flow.control.inputTypes?.length && !compatible.length) {
      reject("interaction_control_undriveable", `${flow.id} uses the wrong control type`, flow, {
        field: flow.control.logicalField, reason: "invalid_control_type", expectedInputTypes: flow.control.inputTypes,
        expectedStateOwner: flow.stateOwner, controls: matches,
      });
      continue;
    }
    const candidates = compatible.length ? compatible : matches;
    if (flow.control.editable && candidates.every((control) => control.disabled === true || control.readOnly === true)) {
      reject("interaction_control_undriveable", `${flow.id} has no editable control`, flow, {
        field: flow.control.logicalField, reason: candidates.every((control) => control.disabled === true) ? "disabled" : "readonly",
        expectedStateOwner: flow.stateOwner, controls: candidates,
      });
    } else if (flow.control.editable && candidates.every((control) => !control.accessibleName)) {
      reject("interaction_control_undriveable", `${flow.id} has no standards-based accessible identity`, flow, {
        field: flow.control.logicalField, reason: "missing_accessible_identity", expectedStateOwner: flow.stateOwner,
        controls: candidates,
      });
    } else if (flow.control.editable && candidates.every((control) => control.controlled && !control.hasChangeHandler)) {
      reject("interaction_control_undriveable", `${flow.id} is controlled but has no input/change transition`, flow, {
        field: flow.control.logicalField, reason: "controlled_without_change_handler", expectedStateOwner: flow.stateOwner,
        controls: candidates,
      });
    } else if (flow.control.editable && candidates.every((control) => !stateConnection(control, flow))) {
      reject("interaction_control_undriveable", `${flow.id} is not connected to the contracted state owner`, flow, {
        field: flow.control.logicalField, reason: "state_owner_not_connected", expectedStateOwner: flow.stateOwner,
        controls: candidates,
      });
    } else if (flow.control.selectedState && !matches.some((control) => control.selectedState || ["radio", "option", "combobox"].includes(control.role))) {
      reject("selection_state_unobservable", `${flow.id} selectable control does not expose selected state`, flow,
        { files: unique(matches.map((row) => row.file)) });
    }
  }

  const moduleSource = (pattern) => modulePlan.filter((module) => pattern.test(module.role || ""))
    .map((module) => String(tree?.[module.path] || "")).join("\n");
  const reviewSource = moduleSource(/review/i);
  const reviewReads = unique((interactionContract?.flows || []).filter((flow) => flow.kind === "review").flatMap((flow) => flow.reads || []));
  if (reviewReads.length && reviewSource) {
    const missing = reviewReads.filter((path) => !normalized(reviewSource).includes(normalized(path.split(".").at(-1))));
    if (missing.length) reject("review_data_flow_missing", `review presentation does not read contracted values: ${missing.join(", ")}`, null, { missing });
  }
  const confirmationSource = moduleSource(/confirmation/i);
  if (confirmationSource && (interactionContract?.flows || []).some((flow) => flow.kind === "mutation")) {
    if (!/(reference|record|result|booking|reservation)/i.test(confirmationSource)) {
      reject("confirmation_data_flow_missing", "confirmation presentation is not derived from a durable mutation result");
    }
    if (/\b(?:Math\.random|Date\.now|randomUUID)\s*\(/.test(confirmationSource)) {
      reject("fabricated_confirmation_reference", "confirmation reference is fabricated locally instead of using the durable mutation result");
    }
  }
  // Durable cancellation is checked against the capability the CONTRACT actually binds.
  //
  // This previously hardcoded makeBookingSystem.cancelBooking for any journey step matching
  // /\bcancel\b/, with no guard on the booking capability being bound at all — so "cancel the
  // subscription", "cancel the order" and "cancel the invitation" each demanded a booking
  // capability the contract never bound and the prompt never mentioned, in applications that
  // have nothing to do with bookings.
  const cancellationFlows = (interactionContract?.flows || []).filter((flow) => flow.kind === "cancellation");
  if (cancellationFlows.length) {
    const owner = durableOperationOwner(bindings);
    if (owner) {
      const facts = aggregateCapabilityFacts(tree, bindings).get(owner.factory);
      const satisfied = owner.methods.some((method) => facts?.used?.has(method));
      if (!satisfied) {
        reject("durable_cancellation_missing",
          `cancellation does not reach a durable operation on ${owner.factory} `
          + `(any of [${owner.methods.join(", ")}])`,
          cancellationFlows[0], { factory: owner.factory, acceptableMethods: owner.methods });
      }
    }
  }
  return { ok: findings.length === 0, findings, problems: findings.map((row) => JSON.stringify(row)), controls };
}

/** Structured browser-failure context for one causal repair rather than symptom patching. */
export function interactionFailureDiagnostics({ contract, interactionContract, journeyResults, tree = null }) {
  const journeys = new Map((contract?.journeys || []).map((journey) => [journey.id, journey]));
  const flows = interactionContract?.flows || [];
  const diagnostics = [];
  for (const result of journeyResults?.journeys || []) {
    const journey = journeys.get(result.id);
    for (const [stepIndex, step] of (result.steps || []).entries()) {
      if (["pass", "not_reached", "skipped"].includes(step.status)) continue;
      const related = flows.filter((flow) => flow.journeyId === result.id && flow.stepIndex === stepIndex);
      const sourceControls = tree ? collectInteractionControls(tree).filter((control) => related.some((flow) =>
        flow.control && flow.control.roles.includes(control.role)
        && (nameMatches(control, flow.control.accessibleNames || flow.control.accessibleName)
          || ((flow.responsibleModules || []).includes(control.file) && stateConnection(control, flow))))) : [];
      const expectedBefore = unique(related.flatMap((flow) => flow.dependsOn || []));
      if (!expectedBefore.length) {
        expectedBefore.push(...unique(related.map((flow) => flow.kind === "selection"
          ? `${flow.valueWritten || "control"}:unselected`
          : flow.kind === "input" ? `${flow.valueWritten || "field"}:empty` : null)));
      }
      diagnostics.push({
        code: "interaction_verification_failure",
        journeyId: result.id,
        stepIndex,
        status: step.status,
        expectedStateBefore: expectedBefore,
        userAction: step.action || journey?.steps?.[stepIndex]?.action || null,
        expectedStateAfter: step.expect || journey?.steps?.[stepIndex]?.expect || null,
        actualObservedState: step.detail || "no observable transition",
        controlEvidence: step.controlEvidence || null,
        expectedControls: related.filter((flow) => flow.control).map((flow) => ({
          field: flow.control.logicalField, roles: flow.control.roles,
          accessibleNames: flow.control.accessibleNames || [flow.control.accessibleName],
          expectedStateOwner: flow.stateOwner,
        })),
        renderedControlFacts: step.controlEvidence?.renderedControls || sourceControls,
        attemptedLocators: step.controlEvidence?.attemptedLocators || [],
        responsibleModules: unique([...(result.owners || []), ...related.flatMap((flow) => flow.responsibleModules || [])]),
        stateOwners: unique(related.map((flow) => flow.stateOwner)),
        capabilities: unique(related.map((flow) => flow.capability)),
        dataOperations: (contract?.operations || []).filter((operation) => operation.journey === result.id
          || related.some((flow) => normalized(operation.entity) && normalized(flow.semanticPurpose).includes(normalized(operation.entity))))
          .map((operation) => operation.id || operation.description).filter(Boolean),
        downstreamDependencies: unique(flows.filter((flow) => flow.journeyId === result.id
          && flow.stepIndex > stepIndex && (flow.reads || []).some((path) => related.some((owner) => (owner.writes || []).includes(path))))
          .map((flow) => flow.id)),
      });
    }
  }
  return diagnostics;
}
