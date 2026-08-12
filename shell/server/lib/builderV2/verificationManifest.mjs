// THE MACHINE VERIFICATION MANIFEST.
//
// Thrallo's BUILDER knows what it is building. The browser does not need to, and the attempt to
// teach it cost a paid qualification: `semanticAliases("guestName")` returned "party size", so
// three contact fields drove a numeric spinbutton. The fix that day was a better dictionary
// entry. This is the fix that removes the need for the dictionary.
//
// Three layers, each holding the fact it actually owns:
//
//   BUILDER / CONTRACT   knows meaning — that ctl_7f3a is the guest's email
//   UI MECHANICS         knows browser primitives — that ctl_7f3a is a textbox that must accept a
//                        value and keep it. It is never told what the value means.
//   DURABLE OUTCOME      knows business truth — that operation `create-booking` produced a record
//                        with a reference that survives a reload.
//
// The manifest is the contract between the first two. It is derived ONCE, here, from the same
// build spec everything else reads, and it speaks only in primitives and opaque identities. The
// mapping back to business fields stays on this side of the boundary, in `mapping`, which the
// browser layer is never given.

/**
 * A stable, opaque identity for one contracted control.
 *
 * FNV-1a over the field's name. Deterministic and dependency-free ON PURPOSE: the generated app
 * computes the same identity at runtime from the same name (see the scaffold's capabilities/react
 * helpers), so the two agree without the model being told an id, without a registry to keep in
 * sync, and without the browser layer ever seeing the name.
 */
export function controlIdFor(name, prefix = "ctl") {
  const text = String(name || "").trim().toLowerCase();
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}_${hash.toString(16).padStart(8, "0")}`;
}

/** The same identity for an ACTION control (a button/link the contract names). */
export const actionIdFor = (name) => controlIdFor(name, "act");

/**
 * THE CANONICAL ADVANCE IDENTITY.
 *
 * A multi-step flow hides its later controls behind a control that moves it on. The verifier used
 * to find that control by reading its label against a list of English words — next, continue,
 * proceed. A live build labelled its button "Next to party size", which is not in the list, so the
 * party-size step was never reached and a paid run died one control short.
 *
 * Advancing is a MECHANICAL act, so it gets a mechanical identity like every other control: one
 * well-known id the scaffold emits and the browser looks for. It is a convention, not a word — the
 * button may say anything, in any language, or nothing at all.
 */
export const ADVANCE_ACTION_NAME = "advance";
export const ADVANCE_ACTION_ID = actionIdFor(ADVANCE_ACTION_NAME);

// Contracted interaction kinds → the browser primitive that drives them. The verifier switches on
// THIS, never on what the value means.
const PRIMITIVE_BY_KIND = Object.freeze({
  input: "textbox",
  selection: "selection",
  mutation: "button",
  cancellation: "button",
  lookup: "button",
  action: "button",
  flow_start: "button",
  flow_advance: "advance",
  recovery: "reload",
  review: "observation",
  navigation: "route",
});

// What the browser must be able to observe for the interaction to count. Mechanics only: whether
// the value that stuck was the RIGHT value for the business is not a question the browser answers.
const EXPECTATION_BY_PRIMITIVE = Object.freeze({
  textbox: "value_accepted",
  selection: "value_changed",
  button: "state_or_route_changed",
  advance: "state_or_route_changed",
  reload: "state_recovered",
  observation: "values_visible",
  route: "route_changed",
});

const CREATE_KINDS = new Set(["create", "insert", "add", "new", "make", "register"]);
const DELETE_KINDS = new Set(["delete", "remove", "destroy", "purge", "drop"]);
const READ_KINDS = new Set(["read", "get", "list", "find", "lookup", "search", "query", "view", "fetch"]);

const mutationOf = (kind) => {
  const value = String(kind || "").toLowerCase();
  if (CREATE_KINDS.has(value)) return "create";
  if (DELETE_KINDS.has(value)) return "delete";
  if (READ_KINDS.has(value)) return "read";
  return "update";
};

/**
 * Derive the verification manifest from the canonical build spec.
 *
 * Nothing here re-reads journey prose: it reads the interaction contract that deriveBuildSpec
 * already produced, so the plan the browser executes and the plan the builder briefed cannot
 * drift — which is the same reason buildSpec exists at all.
 */
export function deriveVerificationManifest(spec) {
  const flows = spec?.interactionContract?.flows || [];
  const scenarios = spec?.interactionContract?.scenarios || {};
  const controls = [];
  const actions = [];
  const mapping = {};

  for (const flow of flows) {
    const primitive = PRIMITIVE_BY_KIND[flow.kind] || null;
    if (!primitive || !flow.control) continue;
    const logical = flow.control.logicalField || flow.control.accessibleName || flow.kind;
    const expected = EXPECTATION_BY_PRIMITIVE[primitive] || "state_or_route_changed";

    if (primitive === "textbox" || primitive === "selection") {
      const id = controlIdFor(logical);
      mapping[id] = { logicalField: logical, journeyId: flow.journeyId, flowId: flow.id };
      controls.push({
        id,
        primitive,
        journeyId: flow.journeyId,
        stepIndex: flow.stepIndex,
        action: primitive === "textbox" ? "fill" : "select",
        // The browser needs the TYPE to drive the control, not the meaning of the field.
        inputType: primitive === "textbox" ? (flow.control.inputTypes || ["text"])[0] : null,
        // Validity intent is a mechanical instruction: enter something the app must reject.
        valueIntent: flow.control.validity || "unspecified",
        expected,
        // Accessibility remains contracted independently — this is not a substitute for it.
        accessibleNames: flow.control.accessibleNames || [flow.control.accessibleName].filter(Boolean),
      });
      continue;
    }

    const id = primitive === "advance" ? ADVANCE_ACTION_ID : actionIdFor(flow.control.accessibleName || logical);
    mapping[id] = { logicalField: logical, journeyId: flow.journeyId, flowId: flow.id };
    actions.push({
      id,
      primitive,
      journeyId: flow.journeyId,
      stepIndex: flow.stepIndex,
      action: "activate",
      expected,
      accessibleNames: flow.control.accessibleNames || [flow.control.accessibleName].filter(Boolean),
    });
  }

  // An advance action exists to REVEAL something. Naming what it should reveal turns "the button
  // was clicked" into a checkable mechanical transition, and gives the browser a target to look
  // for afterwards without knowing what any of it means.
  for (const action of actions) {
    if (action.primitive !== "advance") continue;
    const next = controls.find((row) => row.journeyId === action.journeyId && row.stepIndex > action.stepIndex);
    action.expectedNextControl = next?.id || null;
  }

  // ── durable outcomes ────────────────────────────────────────────────────────────────────────
  // Proven from canonical evidence (declared operations, capability ownership, durable records),
  // never from whether a page happened to say the word "confirmed".
  const durableEntity = (spec?.entities || [])[0]?.name || null;
  const outcomes = [];
  for (const operation of spec?.operations || []) {
    outcomes.push({
      operationId: operation.id || operation.name || null,
      durableEntity: operation.entity || durableEntity,
      expectedMutation: mutationOf(operation.kind || operation.type),
      journeyId: operation.journey || null,
    });
  }
  // A journey that produces or consumes a durable record states that as an outcome even when the
  // contract declared no operation for it — the lifecycle is canonical either way.
  for (const [journeyId, scenario] of Object.entries(scenarios)) {
    if (scenario.role === "independent") continue;
    if (outcomes.some((row) => row.journeyId === journeyId)) continue;
    outcomes.push({
      operationId: null,
      durableEntity: scenario.lifecycle ? String(scenario.lifecycle).split(":").pop() : durableEntity,
      expectedMutation: scenario.role === "produces" ? "create" : "update",
      journeyId,
      lifecycle: scenario.lifecycle || null,
    });
  }

  return { version: 1, controls, actions, outcomes, mapping };
}

/**
 * The browser's view of the manifest: primitives and opaque identities, with the business mapping
 * removed. Passing this rather than the whole manifest is what makes the boundary real instead of
 * a matter of discipline.
 */
export function browserPlan(manifest) {
  // Journey ids are business-named too ("capture-new-lead"). The browser only ever needs to know
  // WHICH journey a control belongs to, never what that journey is about, so it gets an opaque
  // key and the mapping stays here.
  const journeys = new Map();
  const journeyKey = (journeyId) => {
    if (!journeyId) return null;
    if (!journeys.has(journeyId)) journeys.set(journeyId, controlIdFor(journeyId, "jny"));
    return journeys.get(journeyId);
  };
  const strip = (row) => {
    const { accessibleNames, journeyId, ...rest } = row;
    // Accessible names stay ONLY as a fallback for controls that carry no machine identity; they
    // are contract-supplied strings, never a platform dictionary.
    return { ...rest, journey: journeyKey(journeyId), fallbackNames: accessibleNames || [] };
  };
  const controls = (manifest?.controls || []).map(strip);
  const actions = (manifest?.actions || []).map(strip);
  return { version: manifest?.version || 1, controls, actions };
}
