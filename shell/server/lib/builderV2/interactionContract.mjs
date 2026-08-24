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
import {
  contractUsesDurablePersistence, operationUsesDurablePersistence,
} from "../../../shared/implementationContract.mjs";

export const INTERACTION_CONTRACT_VERSION = 2;

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
const list = (value) => (Array.isArray(value) ? value : []);
const IDENTITY_FIELD = /(?:id|key|reference)$/i;
const DERIVED_SELECTION_FIELD = /(?:name|title|label|description|price|cost|amount|value|pence|cents|remaining|capacity|date|status|image|url)$/i;

/**
 * One chooser may atomically supply metadata about the selected record. Exactly one identity
 * field is the user-operated control; descriptive siblings are outputs of that same selection.
 * Multiple identities remain multiple controls because their ordering cannot be inferred safely.
 */
function atomicSelectionPlan(step, operands) {
  const explicit = list(step?.produces).map((value) => String(value).split(".").pop()).filter(Boolean);
  if (explicit.length && operands.length === 1) return { controls: operands, produces: explicit };
  if (step?.primitive !== "selection" || operands.length < 2) return { controls: operands, produces: [] };
  const identities = operands.filter((field) => IDENTITY_FIELD.test(field));
  if (identities.length !== 1) return { controls: operands, produces: [] };
  const derived = operands.filter((field) => field !== identities[0]);
  if (!derived.length || !derived.every((field) => DERIVED_SELECTION_FIELD.test(field))) {
    return { controls: operands, produces: [] };
  }
  return { controls: identities, produces: derived };
}

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
function controlRequirement(kind, field, step, declaredField = null) {
  const name = field || String(step?.target || step?.action || "control");
  if (kind === "input") {
    const aliases = fieldAliases(name);
    const valueType = String(declaredField?.type || "").toLowerCase() || null;
    const inputTypes = ["number", "integer"].includes(valueType) ? ["number"]
      : valueType === "boolean" ? ["checkbox"]
        : /email/i.test(name) ? ["email"] : /phone|telephone/i.test(name)
          ? ["tel", "text"] : /party|quantity|number/i.test(name) ? ["number", "text"] : ["text"];
    // Keep the broad text/spinbutton discovery set so source lint can locate a correctly named
    // but wrongly typed native control and report `invalid_control_type`. `inputTypes` is the
    // authoritative type requirement; checkboxes need their distinct native role.
    const roles = valueType === "boolean" ? ["checkbox"] : ["textbox", "spinbutton", "combobox"];
    return { purpose: name, logicalField: field || name, machineId: controlIdFor(field || name),
      roles, inputTypes, valueType, required: declaredField?.required === true,
      accessibleName: aliases[0], accessibleNames: aliases, editable: true };
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
  const durableOwner = contractUsesDurablePersistence(contract) ? durableOperationOwner(bindings) : null;
  const draftOwner = draftStateOwner(bindings);
  // The only things a browser control can HOLD: the fields the contract's entities declare.
  // Operations, entity names and routes are all legal contract references and none of them is a
  // field, which is exactly the distinction that was missing.
  const declaredFields = new Map();
  for (const field of (contract?.entities || []).flatMap((entity) => entity?.fields || [])) {
    const key = normalized(field?.name);
    if (key && !declaredFields.has(key)) declaredFields.set(key, field);
  }
  const operableFields = new Set(declaredFields.keys());
  const declaredOperations = new Map((contract?.operations || [])
    .map((operation) => [normalized(operation?.id || operation?.name), operation])
    .filter(([identity]) => identity));
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
      const stepFlowStart = flows.length;
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
      const declaredOperationIds = unique((declaredOperands || [])
        .map((operand) => declaredOperations.get(normalized(operand))?.id
          || declaredOperations.get(normalized(operand))?.name)
        .filter(Boolean));
      const declaredOperationObjects = declaredOperationIds
        .map((identity) => declaredOperations.get(normalized(identity))).filter(Boolean);
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
      const selectionPlan = operandKind === "selection"
        ? atomicSelectionPlan(step, operands || []) : { controls: operands || [], produces: [] };
      const controlOperands = operandKind === "selection" ? selectionPlan.controls : operands;
      const localOperationOnly = declaredOperationObjects.length > 0
        && !declaredOperationObjects.some((operation) => operationUsesDurablePersistence(contract, operation));
      const ownershipKinds = localOperationOnly
        ? kinds.map((kind) => kind === "mutation" ? "action" : kind) : kinds;
      const effectiveKinds = operands && !ownershipKinds.includes(operandKind)
        ? [...ownershipKinds, operandKind] : ownershipKinds;
      for (const kind of effectiveKinds) {
        const drivesValues = ["selection", "input"].includes(kind);
        // A step that performs an operation writes no value THROUGH A CONTROL of its own: the verb
        // list may still read "confirm" as an input, and there is no field for it to fill.
        if (drivesValues && operandsAreOperations) continue;
        // A recovery step types nothing: "reload the page ⇒ the reference is visible again"
        // OPERATES the reference only in the sense that the step is about it, and deriving a text
        // box there asks the browser to fill a control the app is right to render read-only. A
        // navigation target is different only when the action itself declares the value act: a
        // composite step may open /book AND make its declared selections after navigation. A
        // navigation-only step with a stray operand must remain read-only; the inferred fallback
        // input in `effectiveKinds` is not authority to type after changing routes.
        const routeWithoutValueIntent = /^\s*\//.test(String(step?.target || ""))
          && !kinds.includes(kind);
        if (drivesValues && operands && (kinds.includes("recovery") || routeWithoutValueIntent)) continue;
        // A second value-writing kind on a step whose operands are declared is an artefact of an
        // ambiguous verb ("select an account type" is a chooser, not a chooser AND a text box).
        if (drivesValues && operands && kind !== operandKind) continue;
        const fields = drivesValues
          ? (controlOperands || fieldCandidates(contract, `${step.action || ""} ${step.target || ""}`, kind))
          : [null];
        for (const field of fields.length ? fields : [null]) {
          const writes = [];
          const reads = [];
          if (["selection", "input"].includes(kind)) {
            const path = `${journey.id}.draft.${field || `value${stepIndex + 1}`}`;
            writes.push(path);
            draftWrites.push(path);
            if (kind === "selection" && field === selectionPlan.controls[0]) {
              const produced = selectionPlan.produces.map((name) => `${journey.id}.draft.${name}`);
              writes.push(...produced);
              draftWrites.push(...produced);
            }
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
          const control = controlRequirement(kind, field, step,
            field ? declaredFields.get(normalized(field)) || null : null);
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
            producedValues: kind === "selection" && field === selectionPlan.controls[0]
              ? [...selectionPlan.produces] : [],
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

      // Opening one concrete item is also the act which selects its identity. Representing a
      // single declared selection operand beside an activation as a second control made the
      // browser click the card, navigate successfully, and then search the destination page for
      // a chooser that had correctly disappeared. Fold that state production into the real
      // activation control. Multi-field/composite selection steps remain separate interactions.
      if (operands?.length === 1
          && kinds.some((kind) => ["action", "flow_start"].includes(kind))) {
        const stepFlows = flows.slice(stepFlowStart);
        const actionFlow = stepFlows.find((flow) => ["action", "flow_start"].includes(flow.kind)
          && flow.control);
        const selectionFlows = stepFlows.filter((flow) => ["selection", "input"].includes(flow.kind));
        if (actionFlow && selectionFlows.length === 1) {
          const [selectionFlow] = selectionFlows;
          actionFlow.writes = unique([...(actionFlow.writes || []), ...(selectionFlow.writes || [])]);
          actionFlow.valueWritten = selectionFlow.valueWritten;
          Object.assign(actionFlow.control, {
            logicalField: selectionFlow.valueWritten,
            statePath: selectionFlow.writes?.[0] || actionFlow.control.statePath || null,
          });
          flows.splice(flows.indexOf(selectionFlow), 1);
        }
      }

      // An operation identity names what the step DOES, not another value control. Preserve that
      // identity on the step itself before the capability graph is derived. Without it, the graph
      // can only guess among unclaimed interactions of the same kind in the whole journey. A
      // calculation declared beside a quantity control was consequently attached to an earlier
      // "Enter" button and read both values before their producer controls ran.
      //
      // Operation-only commit/action steps already have one suitable interaction. A mixed
      // value-plus-operation step receives a control-free semantic interaction immediately after
      // its value flows: selecting the value is the producer; the declared operation is the
      // consumer. No user action or business behavior is invented.
      if (declaredOperationIds.length) {
        const stepFlows = flows.slice(stepFlowStart);
        const unclaimedActionFlows = stepFlows.filter((flow) => !flow.operationId && !flow.valueWritten
          && ["action", "lookup", "mutation", "cancellation"].includes(flow.kind));
        for (const operationId of declaredOperationIds) {
          if (declaredOperationIds.length === 1 && unclaimedActionFlows.length === 1) {
            unclaimedActionFlows[0].operationId = operationId;
            unclaimedActionFlows[0].declaredOperation = true;
            continue;
          }
          const operation = declaredOperations.get(normalized(operationId));
          const owners = ownerModules(modulePlan, "action", { durableOwner, draftOwner });
          const stateOwner = owners[0] || `journey:${journey.id}`;
          flows.push({
            id: `${journey.id}:operation:${normalized(operationId)}`,
            journeyId: journey.id,
            stepIndex,
            kind: "action",
            operationId,
            declaredOperation: true,
            semanticPurpose: operation?.description || step.action || operationId,
            stateOwner,
            responsibleModules: owners,
            action: step.action || operation?.description || operationId,
            valueWritten: null,
            reads: [],
            writes: [],
            dependsOn: [],
            nextStateRequirement: step.expect,
            observable: step.expect,
            control: null,
            capability: null,
          });
        }
      }

      // Structured `reads` are dependencies, not controls. Carry field reads into the state graph
      // even when no capability operation happens to restate them. Prefer an already-declared
      // prior producer path; otherwise retain the canonical draft path so validation emits a
      // precise missing-producer defect instead of silently treating the value as external input.
      const declaredReadFields = unique(list(step?.reads)
        .map((value) => String(value).split(".").pop())
        .filter((name) => operableFields.has(normalized(name))));
      if (declaredReadFields.length) {
        const stepFlows = flows.slice(stepFlowStart);
        const operationConsumers = stepFlows.filter((flow) => flow.operationId);
        const nonValueConsumers = stepFlows.filter((flow) => !flow.valueWritten);
        const consumers = operationConsumers.length ? operationConsumers
          : nonValueConsumers.length ? [nonValueConsumers[0]]
            : stepFlows.length ? [stepFlows[0]] : [];
        for (const consumer of consumers) {
          const reads = declaredReadFields.map((field) => {
            const suffix = `.${field}`;
            const priorProducer = flows.slice(0, flows.indexOf(consumer))
              .filter((flow) => flow.journeyId === journey.id)
              .flatMap((flow) => flow.writes || [])
              .findLast((path) => String(path).endsWith(suffix));
            if (priorProducer) return priorProducer;
            const operationProducer = (contract?.operations || []).map((operation) => {
              const writesField = (operation.responsibilities || []).some((responsibility) => (
                list(responsibility?.writes).some((value) => normalized(value) === normalized(field))
              ));
              if (!writesField) return null;
              const identity = normalized(operation?.id || operation?.name);
              const producerStep = stepsList.findIndex((candidate) => list(candidate?.operates)
                .some((value) => normalized(value) === identity)
                || list(candidate?.reads).some((value) => normalized(value) === identity));
              if (operation?.journey && operation.journey !== journey.id && producerStep < 0) return null;
              return { operation, producerStep };
            }).find(Boolean);
            if (operationProducer?.producerStep >= 0) return `${journey.id}.custom.${field}`;
            // A legacy operation with no structured step identity is bound later by the capability
            // graph. Let that authority attach its exact custom/capability output path rather than
            // inventing a parallel draft dependency here.
            if (operationProducer) return null;
            // A first-step read is the journey's declared external starting input. Reads introduced
            // later remain draft dependencies and require an earlier producer or explicit start
            // authority.
            return stepIndex === 0
              ? `${journey.id}.input.${field}` : `${journey.id}.draft.${field}`;
          }).filter(Boolean);
          consumer.reads = unique([...(consumer.reads || []), ...reads]);
          consumer.dependsOn = [...consumer.reads];
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
    const declaredStartAuthority = {
      initialState: list(journey.initialState),
      durableState: list(journey.durableState),
      externalState: list(journey.externalState),
      capabilityOutputs: list(journey.capabilityOutputs),
      availableState: list(journey.availableState),
    };
    const scenario = produces
      ? { scenario: lifecycle, role: "produces", startState: "fresh", lifecycle, basis }
      : consumes
        ? { scenario: lifecycle, role: "consumes", startState: "inherits", lifecycle, basis }
        : { scenario: `independent:${journey.id}`, role: "independent", startState: "fresh", lifecycle: null,
          basis: touchesDurable ? basis : "data-flow" };
    scenarios[journey.id] = { ...scenario, ...declaredStartAuthority };
  }

  const plan = {
    version: INTERACTION_CONTRACT_VERSION,
    flows,
    scenarios,
    initialState: contract?.initialState || null,
    durableState: contract?.durableState || null,
    externalState: contract?.externalState || null,
    capabilityOutputs: contract?.capabilityOutputs || null,
  };
  const verdict = validateInteractionContract(plan);
  return { ...plan, valid: verdict.ok, problems: verdict.problems };
}

const interactionKindFor = (responsibilities) => {
  if (responsibilities.some((responsibility) => responsibility.requiresTransformation)) return "action";
  const method = responsibilities.find((responsibility) => responsibility.type === "persistence")?.capabilityMethod;
  return ["get", "list", "count"].includes(method) ? "lookup" : "mutation";
};

const moduleForNode = (node) => node?.type === "custom_behavior"
  ? node.extension?.module || null
  : node?.compositionModule || null;

const statePaths = (value, journeyId) => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (!value || typeof value !== "object") return [];
  return [
    ...list(value[journeyId]).map(String),
    ...list(value.paths).map(String),
  ].filter(Boolean);
};

function journeyStartState(plan, journeyId) {
  const scenario = plan?.scenarios?.[journeyId] || {};
  return new Set(unique([
    ...statePaths(plan?.initialState, journeyId),
    ...statePaths(plan?.durableState, journeyId),
    ...statePaths(plan?.externalState, journeyId),
    ...statePaths(plan?.capabilityOutputs, journeyId),
    ...statePaths(scenario.initialState, journeyId),
    ...statePaths(scenario.durableState, journeyId),
    ...statePaths(scenario.externalState, journeyId),
    ...statePaths(scenario.capabilityOutputs, journeyId),
    ...statePaths(scenario.availableState, journeyId),
  ]));
}

function stateAvailableAtJourneyStart(plan, journeyId, path, available) {
  if (available.has(path)) return true;
  // `.input` is the interaction contract's explicit external-input namespace. It is never a
  // value silently borrowed from another journey.
  if (String(path).startsWith(`${journeyId}.input`)) return true;
  const scenario = plan?.scenarios?.[journeyId] || null;
  return scenario?.startState === "inherits"
    && String(path).startsWith(`${journeyId}.durable.`);
}

const dependencyIssueKey = (issue) => `${issue?.journeyId || "unknown"}|${issue?.missingStatePath || "unknown"}`;

/**
 * Compare two dependency-defect sets without treating a moved consumer index as progress.
 */
export function interactionDependencyProgress(beforeIssues = [], afterIssues = []) {
  const counts = (issues) => list(issues)
    .filter((issue) => issue?.code === "interaction_state_dependency_missing")
    .reduce((map, issue) => map.set(dependencyIssueKey(issue), (map.get(dependencyIssueKey(issue)) || 0) + 1), new Map());
  const before = counts(beforeIssues);
  const after = counts(afterIssues);
  const resolved = [...before.entries()].flatMap(([key, count]) => {
    const delta = count - (after.get(key) || 0);
    return delta > 0 ? Array.from({ length: delta }, () => key) : [];
  });
  return {
    moved: resolved.length > 0,
    resolved,
    equivalent: before.size > 0 && resolved.length === 0,
    before: Object.fromEntries(before),
    after: Object.fromEntries(after),
  };
}

function canMoveProducer(producer, consumer) {
  if (producer.journeyId !== consumer.journeyId) return false;
  const explicitlyUnconstrained = producer.reorderable === true && consumer.reorderable === true;
  const sameStepSemanticEdge = producer.stepIndex === consumer.stepIndex && !producer.control;
  if (!explicitlyUnconstrained && !sameStepSemanticEdge) return false;
  const consumerWrites = new Set(consumer.writes || []);
  return !(producer.reads || []).some((path) => consumerWrites.has(path));
}

/**
 * Safely topologically normalize already-declared producer/consumer interactions.
 *
 * User controls are never moved across steps unless both interactions explicitly declare that
 * their order is unconstrained. Control-free semantic producers may be moved within their source
 * step. Missing producers remain structured defects for contract correction.
 */
export function normalizeInteractionStateDependencies(plan) {
  const flows = (plan?.flows || []).map((flow) => ({ ...flow }));
  const moves = [];
  for (let consumerIndex = 0; consumerIndex < flows.length; consumerIndex += 1) {
    const consumer = flows[consumerIndex];
    for (const path of consumer.reads || []) {
      const prior = flows.slice(0, consumerIndex).some((flow) => flow.journeyId === consumer.journeyId
        && (flow.writes || []).includes(path));
      if (prior || stateAvailableAtJourneyStart(plan, consumer.journeyId, path,
        journeyStartState(plan, consumer.journeyId))) continue;
      const relativeProducer = flows.slice(consumerIndex + 1).findIndex((flow) => (
        flow.journeyId === consumer.journeyId && (flow.writes || []).includes(path)
        && canMoveProducer(flow, consumer)
      ));
      if (relativeProducer < 0) continue;
      const producerIndex = consumerIndex + 1 + relativeProducer;
      const [producer] = flows.splice(producerIndex, 1);
      flows.splice(consumerIndex, 0, producer);
      moves.push({
        journeyId: consumer.journeyId,
        statePath: path,
        producerInteractionId: producer.id,
        consumerInteractionId: consumer.id,
      });
      consumerIndex += 1;
    }
  }
  return {
    plan: { ...plan, flows, dependencyNormalization: { changed: moves.length > 0, moves } },
    changed: moves.length > 0,
    moves,
  };
}

/**
 * Bind the authoritative graph semantics back into the interaction contract.
 *
 * The base interaction pass discovers controls and journey order. The graph then decides who
 * owns each operation and which state it transforms. This pass joins those two deterministic
 * views; it never re-reads application prose to invent functional semantics.
 */
export function composeCapabilityGraphInteractions(plan, graph, contract) {
  const nodes = new Map((graph?.nodes || []).map((node) => [node.id, node]));
  const journeys = new Map((contract?.journeys || []).map((journey, index) => [journey.id, { ...journey, index }]));
  const flows = (plan?.flows || []).map((flow, index) => ({
    ...flow,
    reads: [...(flow.reads || [])], writes: [...(flow.writes || [])],
    dependsOn: [...(flow.dependsOn || [])], responsibleModules: [...(flow.responsibleModules || [])],
    control: flow.control ? { ...flow.control, downstream: [...(flow.control.downstream || [])] } : null,
    _sourceOrder: index,
  }));
  const byId = new Map(flows.map((flow) => [flow.id, flow]));
  const coverage = [];
  const operationsAtStep = new Map();
  for (const operation of graph?.operationResponsibilities || []) {
    const key = `${operation.journeyId}:${operation.stepIndex}`;
    operationsAtStep.set(key, (operationsAtStep.get(key) || 0) + 1);
  }

  for (const operation of graph?.operationResponsibilities || []) {
    const responsibilities = operation.responsibilities || [];
    const functionalResponsibilities = responsibilities
      .filter((responsibility) => responsibility.requiresTransformation);
    const functional = functionalResponsibilities[0] || null;
    const persistence = responsibilities.find((responsibility) => responsibility.type === "persistence") || null;
    const semantic = functional || persistence;
    if (!semantic) continue;

    const kind = interactionKindFor(responsibilities);
    // Identity must be real on BOTH sides: an operation with none once matched every flow whose
    // operationId was also unset, i.e. all of them.
    const exactTargets = operation.operationId
      ? flows.filter((flow) => flow.operationId === operation.operationId
        && flow.journeyId === operation.journeyId)
      : [];
    let targets = exactTargets;
    if (!targets.length && operationsAtStep.get(`${operation.journeyId}:${operation.stepIndex}`) === 1) {
      const candidates = unique(responsibilities.flatMap((responsibility) => responsibility.interactionIds || []))
        .map((id) => byId.get(id)).filter(Boolean)
        .filter((flow) => !flow.operationId && ["action", "lookup", "mutation", "navigation"].includes(flow.kind));
      targets = candidates.length ? [candidates[0]] : [];
    }
    if (!targets.length) {
      // No step NAMES this operation, but the journey's own prose already derived the transition
      // it performs. Fabricating a second interaction for it put two commits of the same kind in
      // one journey: the generator was briefed to build both, and the operation's copy read the
      // capability's parameter names (`input.id`, `input.partialValues`) while the contracted
      // field values stayed on the flow nobody had bound. Claim the existing one instead — but
      // only when exactly one unclaimed flow of that kind exists, because a journey with two is a
      // genuine ambiguity this must never guess at.
      const unclaimed = flows.filter((flow) => flow.journeyId === operation.journeyId
        && !flow.operationId && flow.kind === kind);
      if (unclaimed.length === 1) targets = unclaimed;
    }

    const journey = journeys.get(operation.journeyId) || null;
    const step = operation.stepIndex >= 0 ? journey?.steps?.[operation.stepIndex] || null : null;
    const semanticNode = nodes.get(semantic.owner);
    const semanticModule = moduleForNode(semanticNode) || `journey:${operation.journeyId}`;
    const persistenceNode = persistence ? nodes.get(persistence.owner) : null;
    const persistenceModule = moduleForNode(persistenceNode);

    if (!targets.length) {
      const id = `${operation.journeyId}:operation:${normalized(operation.operationId)}`;
      const control = step ? controlRequirement(kind, null, step) : null;
      const created = {
        id, journeyId: operation.journeyId, stepIndex: operation.stepIndex, kind,
        semanticPurpose: semantic.behavior || operation.operationId,
        action: step?.action || semantic.behavior || operation.operationId,
        valueWritten: null, reads: [], writes: [], dependsOn: [],
        nextStateRequirement: step?.expect || semantic.behavior || operation.operationId,
        observable: step?.expect || semantic.behavior || operation.operationId,
        stateOwner: semanticModule, responsibleModules: unique([semanticModule, persistenceModule]),
        control, capability: null, _sourceOrder: flows.length,
      };
      flows.push(created);
      byId.set(created.id, created);
      targets = [created];
    }

    // One operation may own several independent functional responsibilities (validation, copying
    // selected state, calculating totals, clearing state). Downstream edges are derived from all
    // of them, so the producer flow must expose all of their reads/writes too. Selecting only the
    // first responsibility made later consumers depend on custom state that no flow produced.
    // Persistence remains represented through its handoff/source contract when transformations
    // exist; it is the fallback semantic surface only for persistence-only operations.
    const semanticResponsibilities = functionalResponsibilities.length
      ? functionalResponsibilities : responsibilities;
    const semanticReads = unique(semanticResponsibilities.flatMap((row) => row.reads || []));
    const semanticWrites = unique(semanticResponsibilities.flatMap((row) => row.writes || []));
    const downstreamConsumers = unique(responsibilities.flatMap((row) => row.downstreamDependencies || []));
    const handoff = functional?.persistenceHandoff || null;
    const persistenceSource = functional?.persistenceSource || null;
    const requiredExports = semanticNode?.extension?.requiredExports || [];
    const observation = step?.expect || semanticNode?.verificationSemantics?.observe
      || semanticNode?.verificationSemantics?.actions || semantic.behavior || operation.operationId;

    for (const flow of targets) {
      const reads = unique([...(flow.reads || []), ...semanticReads]);
      const writes = unique([...(flow.writes || []), ...semanticWrites]);
      const responsibleModules = unique([...(flow.responsibleModules || []), semanticModule, persistenceModule]);
      Object.assign(flow, {
        operationId: operation.operationId,
        responsibilityIds: responsibilities.map((responsibility) => responsibility.id),
        semanticResponsibilityTypes: responsibilities.map((responsibility) => responsibility.type),
        actionIdentity: {
          operationId: operation.operationId, interactionId: flow.id,
          controlId: flow.control?.machineId || null,
        },
        stateOwner: semanticModule,
        responsibleModules,
        reads,
        writes,
        dependsOn: reads,
        nextStateRequirement: flow.nextStateRequirement || step?.expect || semantic.behavior,
        downstreamConsumers,
        capabilityId: semantic.capabilityId || null,
        capabilityMethod: semantic.capabilityMethod || null,
        customBehavior: functional?.customBehavior || null,
        customBehaviorModule: semanticNode?.type === "custom_behavior" ? semanticNode.extension?.module || null : null,
        customBehaviorExports: semanticNode?.type === "custom_behavior" ? [...requiredExports] : [],
        outputEffect: functional?.outputEffect || null,
        persistenceHandoff: handoff,
        persistenceSource,
        expectedStateTransition: {
          produces: semanticWrites,
          persists: handoff?.writes || (persistence ? persistence.writes || [] : []),
          readsPersisted: persistenceSource?.writes || [],
          requirement: flow.nextStateRequirement || step?.expect || semantic.behavior,
        },
        verificationObservation: observation,
        observable: flow.observable || step?.expect || semantic.behavior,
        capability: semanticNode?.type === "deterministic_capability"
          ? factoryFor(semantic.capabilityId) : null,
      });
      if (flow.control) Object.assign(flow.control, {
        stateOwner: semanticModule,
        statePath: semanticWrites[0] || flow.control.statePath || null,
        downstream: unique([...(flow.control.downstream || []), ...downstreamConsumers]),
      });
    }

    coverage.push({
      operationId: operation.operationId, journeyId: operation.journeyId,
      responsibilityIds: responsibilities.map((responsibility) => responsibility.id),
      interactionIds: targets.map((flow) => flow.id),
    });
  }

  // A semantic producer is authoritative for its declared consumers. Stamp those reads onto the
  // consumer flows so ordering validation and generation receive the same data-flow edge.
  for (const operation of graph?.operationResponsibilities || []) {
    for (const responsibility of operation.responsibilities || []) {
      if (!responsibility.requiresTransformation) continue;
      for (const downstreamId of responsibility.downstreamDependencies || []) {
        const downstream = byId.get(downstreamId);
        if (!downstream) continue;
        downstream.reads = unique([...(downstream.reads || []), ...(responsibility.writes || [])]);
        downstream.dependsOn = [...downstream.reads];
      }
    }
  }

  flows.sort((left, right) => {
    const journey = (journeys.get(left.journeyId)?.index ?? Number.MAX_SAFE_INTEGER)
      - (journeys.get(right.journeyId)?.index ?? Number.MAX_SAFE_INTEGER);
    if (journey) return journey;
    if (left.stepIndex !== right.stepIndex) return left.stepIndex - right.stepIndex;
    return left._sourceOrder - right._sourceOrder;
  });
  for (const flow of flows) delete flow._sourceOrder;

  const composedBeforeNormalization = {
    ...plan, version: INTERACTION_CONTRACT_VERSION, flows,
    operationCoverage: coverage,
    capabilityGraphVersion: graph?.version || null,
  };
  const { plan: composed } = normalizeInteractionStateDependencies(composedBeforeNormalization);
  const verdict = validateInteractionContract(composed, { capabilityGraph: graph });
  return { ...composed, valid: verdict.ok, problems: verdict.problems, issues: verdict.issues };
}

/** Reject a broken ownership/data-flow graph before implementation generation. */
export function validateInteractionContract(plan, { capabilityGraph = null } = {}) {
  const problems = [];
  const issues = [];
  const semanticIssue = (flow, missing) => {
    const issue = {
      code: "interaction_contract_semantics_incomplete",
      operationId: flow.operationId || null,
      interactionId: flow.id || null,
      missingFields: missing,
    };
    issues.push(issue);
    problems.push(`${issue.code} operation=${issue.operationId || "unknown"} `
      + `interaction=${issue.interactionId || "unknown"} missing=${missing.join(",")}`);
  };
  const producedByJourney = new Map();
  const availableByJourney = new Map();
  for (const flow of plan?.flows || []) {
    const journeyId = flow.journeyId || "unknown";
    const produced = producedByJourney.get(journeyId) || new Set();
    const available = availableByJourney.get(journeyId) || journeyStartState(plan, journeyId);
    producedByJourney.set(journeyId, produced);
    availableByJourney.set(journeyId, available);
    if (!flow.id || !flow.journeyId) problems.push("interaction flow is missing identity");
    if ((flow.writes || []).length && !flow.stateOwner) problems.push(`${flow.id} writes state without an owner`);
    const missing = (flow.reads || []).filter((path) => !produced.has(path)
      && !stateAvailableAtJourneyStart(plan, journeyId, path, available));
    if (missing.length) {
      const candidateFlows = (plan?.flows || []).filter((candidate) => candidate.journeyId === journeyId
        && (candidate.writes || []).some((path) => missing.includes(path)));
      for (const path of missing) {
        const issue = {
          code: "interaction_state_dependency_missing",
          journeyId,
          consumerStepId: flow.id || null,
          consumerStepIndex: Number.isInteger(flow.stepIndex) ? flow.stepIndex : null,
          consumerOperationId: flow.operationId || null,
          missingStatePath: path,
          expectedProducerSource: "journey_start_or_prior_step",
          expectedProducerSources: [
            "journey_initial_state", "durable_state", "external_input",
            "capability_output", "prior_step",
          ],
          candidateProducers: candidateFlows.filter((candidate) => (candidate.writes || []).includes(path))
            .map((candidate) => ({
              interactionId: candidate.id || null,
              operationId: candidate.operationId || null,
              stepIndex: Number.isInteger(candidate.stepIndex) ? candidate.stepIndex : null,
            })),
        };
        issues.push(issue);
      }
      problems.push(`${flow.id} reads state before it is produced: ${missing.join(", ")}`);
    }
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
    // Declared operation placeholders are intentionally incomplete until composition binds the
    // capability graph. Enforce the semantic envelope only on the graph-bound final plan.
    if (flow.operationId && (!flow.declaredOperation || capabilityGraph)) {
      const missingFields = [
        ...(!flow.actionIdentity?.operationId || !flow.actionIdentity?.interactionId ? ["actionIdentity"] : []),
        ...(!flow.stateOwner ? ["stateOwner"] : []),
        ...(!flow.expectedStateTransition ? ["expectedStateTransition"] : []),
        ...(!Array.isArray(flow.downstreamConsumers) ? ["downstreamConsumers"] : []),
        ...(!flow.verificationObservation ? ["verificationObservation"] : []),
        ...(!(flow.responsibilityIds || []).length ? ["responsibilityIds"] : []),
      ];
      const types = new Set(flow.semanticResponsibilityTypes || []);
      if (types.has("custom_functional")) missingFields.push(
        ...(!(flow.reads || []).length ? ["reads"] : []),
        ...(!(flow.writes || []).length ? ["writes"] : []),
        ...(!flow.customBehavior ? ["customBehavior"] : []),
        ...(!flow.customBehaviorModule ? ["customBehaviorModule"] : []),
        ...(!(flow.customBehaviorExports || []).length ? ["customBehaviorExports"] : []),
        ...(!flow.persistenceHandoff && !flow.persistenceSource && types.has("persistence")
          ? ["persistenceRelationship"] : []),
      );
      if (types.has("capability_functional")) missingFields.push(
        ...(!flow.capabilityId ? ["capabilityId"] : []),
        ...(!flow.capabilityMethod ? ["capabilityMethod"] : []),
        ...(!(flow.reads || []).length ? ["reads"] : []),
        ...(!(flow.writes || []).length ? ["writes"] : []),
      );
      if (types.size === 1 && types.has("persistence")) missingFields.push(
        ...(!flow.capabilityId ? ["capabilityId"] : []),
        ...(!flow.capabilityMethod ? ["capabilityMethod"] : []),
        ...(!(flow.writes || []).length ? ["writes"] : []),
      );
      if (missingFields.length) semanticIssue(flow, unique(missingFields));
    }
    for (const path of flow.writes || []) produced.add(path);
  }
  if (capabilityGraph) {
    const flows = plan?.flows || [];
    for (const operation of capabilityGraph.operationResponsibilities || []) {
      const represented = flows.filter((flow) => flow.operationId === operation.operationId
        && flow.journeyId === operation.journeyId);
      const required = new Set((operation.responsibilities || []).map((responsibility) => responsibility.id));
      const covered = new Set(represented.flatMap((flow) => flow.responsibilityIds || []));
      const missingResponsibilities = [...required].filter((id) => !covered.has(id));
      if (!represented.length || missingResponsibilities.length) {
        semanticIssue({ operationId: operation.operationId, id: null }, [
          ...(!represented.length ? ["interaction"] : []),
          ...missingResponsibilities.map((id) => `responsibility:${id}`),
        ]);
      }
    }
  }
  return { ok: problems.length === 0, problems, issues };
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
  return {
    version: plan?.version || INTERACTION_CONTRACT_VERSION,
    flows: (plan?.flows || []).filter((flow) => ids.has(flow.journeyId)),
    operationCoverage: (plan?.operationCoverage || []).filter((operation) => (
      ids.has(operation.journeyId) && (plan?.flows || []).some((flow) => (
        flow.operationId === operation.operationId && flow.journeyId === operation.journeyId
      ))
    )),
    capabilityGraphVersion: plan?.capabilityGraphVersion || null,
  };
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
        // WHAT THIS SCAN CANNOT SEE. `<input {...field.inputProps} />` carries its value, its
        // change handler and its accessible name in an object this file never evaluates, so every
        // attribute-based conclusion about such an element is a guess. Recording that explicitly is
        // what separates "I can prove this control is dead" from "I cannot tell" — and the second
        // one fired on a WORKING application in the 2026-08-12 run #6, which is why the whole
        // finding had to stay advisory. Now only the provable half is allowed to block.
        hasSpread: (opening.attributes || []).some((row) => row?.type === "JSXSpreadAttribute"),
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

/**
 * TWO DIFFERENT CLAIMS, WHICH USED TO SHARE ONE CODE.
 *
 * `interaction_control_undriveable` meant both "this control provably cannot accept the contracted
 * interaction" and "I looked and could not tell". Run #6 fired the second on three fields that
 * worked perfectly; run #7 fired it on three that did not. Identical output, opposite truths — so
 * the finding could never be allowed to stop a build, and a real defect went to a paid browser run.
 *
 * PROVEN_UNDRIVEABLE is now reserved for structure that settles the question: an element the
 * contract needs to edit that is disabled, read-only, or holds a value with no way to change it.
 * Everything else is SUSPECT_INTERACTION — a shape worth reporting and worth PROBING, never worth
 * failing on. Unknown is not broken.
 */
export const DIAGNOSTIC_LEVEL = Object.freeze({
  PROVEN: "PROVEN_UNDRIVEABLE",
  SUSPECT: "SUSPECT_INTERACTION",
});

// Reasons whose evidence is structural and complete. Each is a fact about the element itself, not
// an absence of something this scan is able to see.
const PROVEN_REASONS = new Set(["disabled", "readonly", "controlled_without_change_handler",
  "invalid_control_type", "selected_state_unobservable"]);

/**
 * A finding may only be PROVEN when the evidence is not defeated by what the scan cannot read.
 * An element carrying a spread holds its props somewhere else, so nothing absent from its
 * attributes proves anything about it.
 */
export function diagnosticLevel(reason, controls = []) {
  if (!PROVEN_REASONS.has(String(reason))) return DIAGNOSTIC_LEVEL.SUSPECT;
  const rows = Array.isArray(controls) ? controls : [controls];
  if (rows.length && rows.some((control) => control?.hasSpread)) return DIAGNOSTIC_LEVEL.SUSPECT;
  return DIAGNOSTIC_LEVEL.PROVEN;
}

/** Generic pre-browser lint: driveability plus obvious review/confirmation/cancellation breaks. */
export function lintInteractiveWorkflow(tree, { interactionContract, modulePlan = [], bindings = [] } = {}) {
  const findings = [];
  const controls = collectInteractionControls(tree);
  const reject = (code, message, flow = null, details = {}) => findings.push({ code, message,
    journeyId: flow?.journeyId || null, interactionId: flow?.id || null,
    // Every interaction finding now says how strong its evidence is, so a consumer never has to
    // infer that from the message.
    ...(code === "interaction_control_undriveable"
      ? { level: diagnosticLevel(details.reason, details.controls) } : {}),
    ...details });

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
      // LEVELLED, like every other interaction finding. A selection whose chosen state lives only
      // in a closure can never be verified — nothing on the page changes when it is clicked — so
      // where the elements are readable this is PROVEN. But `{...choice.optionProps(o)}` supplies
      // aria-pressed at runtime, so a spread defeats it exactly as it defeats the others, and an
      // unlabelled finding would eventually be promoted and start failing correct applications.
      reject("selection_state_unobservable", `${flow.id} selectable control does not expose selected state`, flow,
        { files: unique(matches.map((row) => row.file)),
          reason: "selected_state_unobservable", controls: matches,
          level: diagnosticLevel("selected_state_unobservable", matches) });
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
        // Browser facts describe what was rendered; source facts retain where the matching
        // implementation lives. Keep both. Preferring the browser array used to discard the source
        // file precisely when a real browser had observed the broken control, leaving repair unable
        // to target the rendered owner.
        renderedControlFacts: [
          ...(step.controlEvidence?.renderedControls || []),
          ...sourceControls,
        ],
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
