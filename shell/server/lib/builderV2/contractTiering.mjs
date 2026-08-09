// Contract tiering, capability binding and image intents (finish plan WP-6; master plan
// Parts 5, 6 and 14 — correction C4: first-green is a PERSISTED platform invariant).
//
// All pure and deterministic over an existing contract: the Contract Engine's model call is
// unchanged; the orchestrator runs these AFTER contract generation and persists the result,
// so essential/secondary is decided once, stored, and never recomputed ad hoc.

import { CAPABILITIES, validateBindings } from "./capabilityRegistry.mjs";
import { serviceClient } from "../supabase.mjs";

const words = (text) => new Set(String(text || "").toLowerCase().match(/[a-z]{4,}/g) || []);
const journeyText = (j) => `${j.id} ${j.title} ${(j.steps || []).map((s) => `${s.action} ${s.expect}`).join(" ")}`;
const overlaps = (setA, setB) => [...setA].some((w) => setB.has(w));

export const FORBIDDEN_DURABLE_PERSISTENCE = Object.freeze([
  "localStorage", "sessionStorage", "indexedDB", "IndexedDB", "process_memory",
]);

const normalized = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const featureText = (contract) => [
  ...(contract?.journeys || []).map((journey) => `${journey.id} ${journey.title}`),
  ...(contract?.routes || []).map((route) => `${route.path} ${route.name}`),
].join(" ");

function entityFor(contract, pattern) {
  return (contract?.entities || []).find((entity) => pattern.test(normalized(entity?.name)))?.name || null;
}

/**
 * A wizard is a behavioural requirement, not a synonym for every booking. A one-step booking
 * button can use the booking system alone; a journey that selects several values and then
 * reviews/confirms them needs the durable wizard state machine as well.
 */
export function requiresWizard(contract) {
  const explicit = words(featureText(contract));
  if (["wizard", "onboarding", "checkout", "multistep"].some((word) => explicit.has(word))) return true;
  return (contract?.journeys || []).some((journey) => {
    const steps = journey?.steps || [];
    const text = steps.map((step) => `${step.action} ${step.expect}`).join(" ").toLowerCase();
    const chooses = /(choose|select|date|slot|party|quantity|details|guest)/.test(text);
    const finishes = /(review|summary|confirm|confirmation|reference)/.test(text);
    return steps.length >= 4 && chooses && finishes;
  });
}

function capabilityBinding(name, configuration = null, methods = []) {
  return {
    name,
    version: CAPABILITIES[name].version,
    ...(configuration ? { configuration } : {}),
    ...(methods.length ? { requiredMethods: [...new Set(methods)] } : {}),
  };
}

/**
 * ESSENTIAL = the one primary journey, the entities it touches, the operations it invokes,
 * and its states. SECONDARY = everything else, unless the user's own words marked it
 * critical (`userCritical` journey ids from the conversation). Deterministic.
 */
export function tierContract(contract, { userCritical = [] } = {}) {
  const journeys = contract?.journeys || [];
  const primary = journeys.find((j) => j.priority === "primary") || journeys[0] || null;
  const critical = new Set(userCritical);
  const essentialJourneys = journeys
    .filter((j) => j === primary || critical.has(j.id))
    .map((j) => j.id);
  const essentialText = words(journeys.filter((j) => essentialJourneys.includes(j.id)).map(journeyText).join(" "));

  const essentialEntities = (contract?.entities || [])
    .filter((e) => essentialText.has(String(e.name).toLowerCase()) || overlaps(words(e.name), essentialText))
    .map((e) => e.name);
  const essentialOperations = (contract?.operations || [])
    .filter((op) => overlaps(words(`${op.id} ${op.description || ""}`), essentialText))
    .map((op) => op.id);

  return {
    essential: {
      journeys: essentialJourneys,
      entities: essentialEntities,
      operations: essentialOperations,
    },
    secondary: {
      journeys: journeys.filter((j) => !essentialJourneys.includes(j.id)).map((j) => j.id),
      entities: (contract?.entities || []).map((e) => e.name).filter((n) => !essentialEntities.includes(n)),
      operations: (contract?.operations || []).map((o) => o.id).filter((id) => !essentialOperations.includes(id)),
    },
  };
}

/** Which registry capabilities this contract binds — from entities and journey vocabulary. */
export function bindCapabilities(contract) {
  const bindings = [capabilityBinding("crud"), capabilityBinding("session")];
  const entityNames = new Set((contract?.entities || []).map((e) => String(e.name).toLowerCase()));
  // FEATURE vocabulary only — journey ids/titles and route names, never step prose: "enter
  // your contact details" inside a booking form must not bind the contact-form capability.
  const vocabulary = words([
    ...(contract?.journeys || []).map((j) => `${j.id} ${j.title}`),
    ...(contract?.routes || []).map((r) => `${r.path} ${r.name}`),
  ].join(" "));

  const bookingEntity = entityFor(contract, /^(booking|reservation)/) || "booking";
  const bookingRequired = entityNames.has("booking") || vocabulary.has("booking") || vocabulary.has("reservation")
    || (contract?.operations || []).some((operation) => /booking|reservation/.test(normalized(operation?.entity)));
  const allJourneyText = (contract?.journeys || []).map(journeyText).join(" ").toLowerCase();
  if (bookingRequired) {
    const bookingMethods = ["createBooking"];
    if (/cancel/.test(allJourneyText)) bookingMethods.push("cancelBooking", "getBooking");
    bindings.push(capabilityBinding("booking", { entity: bookingEntity }, bookingMethods));
    if (requiresWizard(contract)) {
      bindings.push(capabilityBinding("wizard", { persistence: "platform" }, [
        "getState", "subscribe", "restore", "select", "next", "confirm", "cancel",
      ]));
    }
  }
  if (vocabulary.has("wizard") || vocabulary.has("onboarding") || vocabulary.has("checkout")) {
    if (!bindings.some((binding) => binding.name === "wizard")) {
      bindings.push(capabilityBinding("wizard", { persistence: "platform" }, [
        "getState", "subscribe", "restore", "select", "next", "confirm", "cancel",
      ]));
    }
  }
  if (entityNames.has("newslettersignup") || vocabulary.has("newsletter")) {
    const entity = entityFor(contract, /newsletter.*signup/) || "newsletterSignup";
    bindings.push(capabilityBinding("newsletter", { entity }, ["subscribe"]));
  }
  if (entityNames.has("contactmessage") || vocabulary.has("contact")) {
    const entity = entityFor(contract, /(contact.*(?:message|enquiry)|enquiry)/) || "contactMessage";
    bindings.push(capabilityBinding("contact", { entity }, ["submitContact"]));
  }
  if (contract?.auth?.required) bindings.push(capabilityBinding("roles"));

  const check = validateBindings(bindings);
  if (!check.ok) throw new Error(`capability binding failed: ${check.problems.join("; ")}`);
  return bindings;
}

/** Exact, machine-derived capability requirements carried by every generation/repair prompt. */
export function capabilityRequirementsBrief(contract) {
  const required = bindCapabilities(contract).filter((binding) => binding.requiredMethods?.length);
  if (!required.length) return "REQUIRED CAPABILITY BINDINGS: none for this contract.";
  return [
    "REQUIRED CAPABILITY BINDINGS (structurally checked after every patch; headless behaviour only):",
    ...required.map((binding) => {
      const factory = CAPABILITIES[binding.name].interface[0];
      const configuration = binding.configuration?.entity
        ? `{ entity: ${JSON.stringify(binding.configuration.entity)} }`
        : binding.configuration?.persistence === "platform" ? "{ id: <stable flow id>, steps: [...] } (platform persistence is automatic)" : "{}";
      return `- ${binding.name}: instantiate ${factory}(${configuration}); use [${binding.requiredMethods.join(", ")}].`;
    }),
    "These capabilities render no JSX and impose no layout, colour, typography or visual design.",
  ].join("\n");
}

/** Restrict structural enforcement to the journeys implemented by this increment. */
export function bindingsForJourneys(contract, bindings, journeys = []) {
  const text = journeys.map(journeyText).join(" ").toLowerCase();
  const scopedContract = { ...contract, journeys };
  return (bindings || []).filter((binding) => {
    if (!binding.requiredMethods?.length) return false;
    if (binding.name === "wizard") return requiresWizard(scopedContract);
    if (binding.name === "booking") return /booking|reservation/.test(text);
    if (binding.name === "newsletter") return /newsletter|mailing list|subscribe/.test(text);
    if (binding.name === "contact") return /contact|enquiry|inquiry|message/.test(text);
    return true;
  });
}

/** Journeys whose contracted outcome must survive a reload or exist outside one JS process. */
export function durablePersistenceJourneys(contract, journeys = contract?.journeys || []) {
  const hasPersistedEntity = (contract?.entities || []).length > 0;
  return (journeys || []).filter((journey) => {
    const text = journeyText(journey).toLowerCase();
    return /persist|durable|reload|refresh|recover|reference|confirm|cancel|booking|reservation/.test(text)
      || (hasPersistedEntity && /(create|submit|save|store)/.test(text));
  });
}

/**
 * Machine-readable storage ownership carried from contract to every generation/repair turn.
 * Visual modules may own ephemeral presentation state, never durable business records.
 */
export function persistenceOwnershipPlan(contract, journeys = contract?.journeys || [], modulePlan = null) {
  const durableJourneys = durablePersistenceJourneys(contract, journeys);
  if (!durableJourneys.length) return null;
  const plan = modulePlan || bookingModulePlan(contract, journeys);
  const bindings = bindingsForJourneys(contract, bindCapabilities(contract), journeys);
  const owners = [];
  if (bindings.some((binding) => binding.name === "booking")) {
    owners.push({ state: "booking records, capacity, status and durable reference",
      capability: "makeBookingSystem", module: "src/data/bookingSystem.js" });
  }
  if (bindings.some((binding) => binding.name === "wizard")) {
    owners.push({ state: "recoverable wizard selections, review, confirmation and cancellation",
      capability: "makeWizardMachine", persistence: "platform", module: "src/data/bookingWizard.js" });
  }
  for (const binding of bindings) {
    if (!["booking", "wizard"].includes(binding.name)) {
      owners.push({ state: `${binding.name} contracted records`, capability: CAPABILITIES[binding.name].interface[0],
        module: CAPABILITIES[binding.name].package });
    }
  }
  return {
    durableJourneys: durableJourneys.map((journey) => journey.id),
    forbiddenBusinessPersistence: [...FORBIDDEN_DURABLE_PERSISTENCE],
    owners,
    modules: plan.map((module) => ({
      path: module.path,
      owns: module.stateOwnership?.owns || "presentation only",
      survivesReload: module.stateOwnership?.survivesReload === true,
      approvedPersistence: module.stateOwnership?.approvedPersistence || null,
      durableStateOwner: module.stateOwnership?.durableStateOwner || null,
      forbiddenPersistence: [...FORBIDDEN_DURABLE_PERSISTENCE],
    })),
  };
}

/**
 * A deterministic, visually headless module plan for the one class that repeatedly
 * collapsed into a single route during live qualification: multi-step booking.
 * Ordinary one-step booking forms deliberately have no prescribed module layout.
 */
export function bookingModulePlan(contract, journeys = contract?.journeys || []) {
  const scopedContract = { ...contract, journeys };
  const bindings = bindingsForJourneys(contract, bindCapabilities(contract), journeys);
  if (!bindings.some((binding) => binding.name === "booking") || !requiresWizard(scopedContract)) return [];

  const text = journeys.map(journeyText).join(" ").toLowerCase();
  const plan = [
    { path: "src/data/bookingSystem.js", role: "booking persistence adapter", factory: "makeBookingSystem",
      stateOwnership: { owns: "booking records, capacity, status and durable reference", survivesReload: true,
        approvedPersistence: "makeBookingSystem" } },
    { path: "src/data/bookingWizard.js", role: "durable wizard state adapter", factory: "makeWizardMachine",
      stateOwnership: { owns: "wizard selections, review, confirmation and cancellation", survivesReload: true,
        approvedPersistence: "makeWizardMachine platform persistence" } },
    { path: "src/components/booking/BookingFlow.jsx", role: "step navigation and flow composition",
      stateOwnership: { owns: "ephemeral UI orchestration only", survivesReload: false,
        durableStateOwner: "makeBookingSystem + makeWizardMachine" } },
  ];
  if (/review|summary/.test(text)) {
    plan.push({ path: "src/components/booking/BookingReview.jsx", role: "review presentation",
      stateOwnership: { owns: "presentation only", survivesReload: false,
        durableStateOwner: "makeWizardMachine" } });
  }
  if (/confirm|confirmation|reference/.test(text)) {
    plan.push({ path: "src/components/booking/BookingConfirmation.jsx", role: "confirmation and reference presentation",
      stateOwnership: { owns: "presentation only", survivesReload: false,
        durableStateOwner: "makeBookingSystem + makeWizardMachine" } });
  }
  if (/cancel|reload|refresh|recover|status/.test(text)) {
    plan.push({ path: "src/components/booking/BookingStatus.jsx", role: "restored and cancelled booking presentation",
      stateOwnership: { owns: "presentation only", survivesReload: false,
        durableStateOwner: "makeBookingSystem + makeWizardMachine" } });
  }
  return plan;
}

/** Final success is stricter than the internal first-green progression gate. */
export function completionEligibility({ contract, gates, journeyResults, backendRowFailures = [], blockingErrors = [] }) {
  const required = contract?.journeys || [];
  const failures = [];
  if (!gates?.ok) failures.push("deterministic gates (D0-D2) are not green");
  const byId = new Map((journeyResults?.journeys || []).map((journey) => [journey.id, journey]));
  for (const journey of required) {
    const outcome = byId.get(journey.id);
    if (!outcome) failures.push(`required journey ${journey.id} was never verified`);
    else if (outcome.status !== "pass") failures.push(`required journey ${journey.id} is ${outcome.status || "not green"}`);
  }
  for (const row of backendRowFailures) {
    failures.push(`required backend-row check failed (${row.journeyId || "unknown journey"})`);
  }
  if (blockingErrors.length) failures.push(`blocking console/network errors: ${blockingErrors.length}`);
  return { eligible: failures.length === 0, failures };
}

/** Image intents per route — the Asset Service's input; the model never searches (Part 18). */
export function imageIntents(contract) {
  const subject = String(contract?.summary || "").split(/[.!?]/)[0].slice(0, 80).trim();
  const intents = [{ slot: "hero", intent: subject || "welcoming small business", orientation: "landscape" }];
  for (const route of contract?.routes || []) {
    if (route.path === "/") continue;
    intents.push({
      slot: `route:${route.path}`,
      intent: `${subject} — ${route.name || route.path}`.slice(0, 100),
      orientation: "landscape",
    });
  }
  return intents;
}

/**
 * C4 — preview eligibility, EXACTLY: every essential D0-D3 check passes, no essential
 * backend-row failure, no essential blocking console/network error. Secondary failures
 * never block; they come back as pendingIncrements the conversation must list.
 */
export function previewEligibility({ tiers, gates, journeyResults, backendRowFailures = [], blockingErrors = [] }) {
  const essential = new Set(tiers.essential.journeys);
  const failures = [];
  if (!gates?.ok) failures.push("deterministic gates (D0-D2) are not green");
  const byId = new Map((journeyResults?.journeys || []).map((j) => [j.id, j]));
  for (const id of essential) {
    const outcome = byId.get(id);
    if (!outcome) failures.push(`essential journey ${id} was never verified`);
    else if (outcome.status === "fail") failures.push(`essential journey ${id} fails`);
  }
  for (const row of backendRowFailures) if (essential.has(row.journeyId)) failures.push(`essential backend-row check failed (${row.journeyId})`);
  if (blockingErrors.length) failures.push(`blocking console/network errors: ${blockingErrors.length}`);

  const pendingIncrements = (journeyResults?.journeys || [])
    .filter((j) => !essential.has(j.id) && j.status === "fail")
    .map((j) => ({ journeyId: j.id, title: j.title }));

  return { eligible: failures.length === 0, failures, pendingIncrements };
}

/** Persist the tiered contract — version = prior + 1, per project. */
export async function persistContract(owner, projectId, { buildId = null, contract, tiers, bindings, intents }, { client = serviceClient() } = {}) {
  const { data: prior, error: priorError } = await client.from("bv2_contracts")
    .select("version").eq("owner", owner).eq("project_id", projectId)
    .order("version", { ascending: false }).limit(1).maybeSingle();
  if (priorError) throw new Error(`contract version read: ${priorError.message}`);
  const version = (prior?.version || 0) + 1;
  const { data, error } = await client.from("bv2_contracts").insert({
    owner, project_id: projectId, build_id: buildId, version,
    contract: { ...contract, tiers, imageIntents: intents },
    capabilities: bindings,
  }).select("id,version").single();
  if (error) throw new Error(`contract persist: ${error.message}`);
  return data;
}
