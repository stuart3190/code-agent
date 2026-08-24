// Contract tiering, capability binding and image intents (finish plan WP-6; master plan
// Parts 5, 6 and 14 — correction C4: first-green is a PERSISTED platform invariant).
//
// All pure and deterministic over an existing contract: the Contract Engine's model call is
// unchanged; the orchestrator runs these AFTER contract generation and persists the result,
// so essential/secondary is decided once, stored, and never recomputed ad hoc.

import { CAPABILITIES, canonicalCapabilityId, validateBindings } from "./capabilityRegistry.mjs";
import { serviceClient } from "../supabase.mjs";
import {
  contractUsesDurablePersistence, entityPersistencePolicy, operationUsesDurablePersistence,
} from "../../../shared/implementationContract.mjs";

const words = (text) => new Set(String(text || "")
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .toLowerCase().match(/[a-z0-9]{3,}/g) || []);
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

/**
 * A contract that explicitly declares its workflow data as browser-local/transient must not be
 * upgraded into a platform-persisted booking or wizard merely because its product vocabulary says
 * "reservation". The entity storage declaration is the contract authority; mixed contracts with
 * any durable operation remain on the normal durable capability path.
 */
export function contractUsesExplicitTransientState(contract) {
  return !contractUsesDurablePersistence(contract)
    && (contract?.entities || []).some((entity) => (
      entityPersistencePolicy(contract, entity?.name) === "transient"
    ));
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

  const essentialOperations = (contract?.operations || [])
    .filter((op) => essentialJourneys.includes(op?.journey)
      || (!op?.journey && overlaps(words(`${op.id} ${op.description || ""}`), essentialText)))
    .map((op) => op.id);
  const operationEntities = new Set((contract?.operations || [])
    .filter((operation) => essentialOperations.includes(operation.id))
    .map((operation) => operation.entity).filter(Boolean));
  const essentialEntities = (contract?.entities || [])
    .filter((entity) => operationEntities.has(entity.name)
      || essentialText.has(String(entity.name).toLowerCase())
      || overlaps(words(entity.name), essentialText))
    .map((entity) => entity.name);

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
  const sessionMethods = (contract?.operations || []).flatMap((operation) =>
    (operation?.responsibilities || []).filter((responsibility) =>
      canonicalCapabilityId(responsibility?.capabilityId || responsibility?.capability) === "session")
      .map((responsibility) => responsibility?.capabilityMethod || responsibility?.method || responsibility?.operation)
      .filter((method) => CAPABILITIES.session.supportedOperations.includes(method)));
  const bindings = [capabilityBinding("crud"), capabilityBinding("session", null, sessionMethods)];
  const entityNames = new Set((contract?.entities || []).map((e) => String(e.name).toLowerCase()));
  // FEATURE vocabulary only — journey ids/titles and route names, never step prose: "enter
  // your contact details" inside a booking form must not bind the contact-form capability.
  const vocabulary = words([
    ...(contract?.journeys || []).map((j) => `${j.id} ${j.title}`),
    ...(contract?.routes || []).map((r) => `${r.path} ${r.name}`),
  ].join(" "));
  const explicitlyTransient = contractUsesExplicitTransientState(contract);

  const bookingEntity = entityFor(contract, /^(booking|reservation)/) || "booking";
  const bookingRequired = !explicitlyTransient && (
    entityNames.has("booking") || vocabulary.has("booking") || vocabulary.has("reservation")
    || (contract?.operations || []).some((operation) => /booking|reservation/.test(normalized(operation?.entity)))
  );
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
  if (!explicitlyTransient
      && (vocabulary.has("wizard") || vocabulary.has("onboarding") || vocabulary.has("checkout"))) {
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
      const entry = CAPABILITIES[binding.name];
      const factory = entry.interface.find((name) => /^make[A-Z]/.test(name));
      if (!factory) {
        return `- ${binding.name}: import [${binding.requiredMethods.join(", ")}] from `
          + `src/lib/capabilities/composed/${binding.name}.js and use those protected operations.`;
      }
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
  const durableOperations = (contract?.operations || []).filter((operation) => (
    operationUsesDurablePersistence(contract, operation)
  ));
  const durableJourneyIds = new Set(durableOperations.map((operation) => operation?.journey).filter(Boolean));
  const legacyEntityContract = !(contract?.operations || []).length && (contract?.entities || []).length > 0;
  const hasUnscopedDurableOperation = durableOperations.some((operation) => !operation?.journey);
  return (journeys || []).filter((journey) => {
    if (durableJourneyIds.has(journey?.id)) return true;
    if (!contractUsesDurablePersistence(contract) && !legacyEntityContract) return false;
    const text = journeyText(journey).toLowerCase();
    if (legacyEntityContract || hasUnscopedDurableOperation) {
      return /persist|durable|reload|refresh|recover|reference|confirm|cancel|booking|reservation|create|submit|save|store/.test(text);
    }
    return /persist|durable|reload|refresh|recover/.test(text);
  });
}

/**
 * Machine-readable storage ownership carried from contract to every generation/repair turn.
 * Visual modules may own ephemeral presentation state, never durable business records.
 */
export function persistenceOwnershipPlan(contract, journeys = contract?.journeys || [], modulePlan = null) {
  const durableJourneys = durablePersistenceJourneys(contract, journeys);
  if (!durableJourneys.length) return null;
  const plan = modulePlan || deriveModulePlan(contract, journeys);
  const bindings = bindingsForJourneys(contract, bindCapabilities(contract), journeys);
  // Every bound capability declares its own durable ownership; none is named specially here.
  const owners = bindings.map((binding) => {
    const capability = CAPABILITIES[binding.name];
    const factory = (capability?.interface || []).find((entry) => /^make[A-Z]/.test(entry))
      || capability?.interface?.[0];
    const adapter = plan.find((module) => module.factory === factory)?.path || capability?.package;
    return {
      state: `${binding.name} contracted durable records and status`,
      capability: factory,
      module: adapter,
      ...(binding.configuration?.persistence === "platform" ? { persistence: "platform" } : {}),
    };
  }).filter((owner) => owner.capability);
  // Generic entity-backed applications bind CRUD without a domain-specific required-method list.
  // Their adapter still owns durable records. Omitting it produced a contradictory live prompt:
  // four persisted entities and ten operations, but `owners: []` and `modules: []`.
  for (const module of plan) {
    if (!module.factory || !module.stateOwnership?.approvedPersistence) continue;
    if (owners.some((owner) => owner.module === module.path || owner.capability === module.factory)) continue;
    owners.push({
      state: module.stateOwnership.owns || "contracted durable records and status",
      capability: module.factory,
      module: module.path,
    });
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

const pascal = (value) => String(value || "")
  .split(/[^a-zA-Z0-9]+/).filter(Boolean)
  .map((part) => part[0].toUpperCase() + part.slice(1)).join("") || "Flow";

/**
 * A deterministic module plan derived from the CONTRACT — capability bindings and journey
 * shape — rather than from an application domain.
 *
 * This replaces `bookingModulePlan`, which hardcoded six literal booking file paths
 * (src/data/bookingSystem.js, src/components/booking/BookingFlow.jsx, …) into the generic
 * production path for every application Thrallo builds. Module responsibilities are real and
 * worth planning; their domain is not Thrallo's to assume. A CRM gets CRM module names, an
 * inventory system gets inventory ones, and a booking benchmark still gets booking-shaped
 * modules — because its contract says booking, not because this function does.
 *
 * Module paths are ADVISORY (see validationSeverity): the plan shapes generation and gives
 * repair a vocabulary, but a working application is never rejected for naming a file
 * differently.
 */
export function deriveModulePlan(contract, journeys = contract?.journeys || [], { dependencyPlan = null } = {}) {
  const scopedContract = { ...contract, journeys };
  const all = bindCapabilities(contract);
  const scopedBindings = bindingsForJourneys(contract, all, journeys);
  // Plan modules only where the work is genuinely multi-part: a durable owner plus a journey
  // that walks through several observable states. A one-step form needs no prescribed layout.
  const coordinatedFlow = (journeys || []).some((journey) => (journey?.steps || []).length >= 3
    && journeyStepKinds(journey).some((kind) => (
      ["input", "selection", "mutation", "recovery", "lookup", "output", "presentation"].includes(kind)
    )));
  if (!requiresWizard(scopedContract) && !coordinatedFlow
      && !(dependencyPlan?.requirements || []).length) return [];

  // Capabilities the contract requires methods from own their own adapters. A contract that
  // requires none — an ordinary entity-backed CRM, inventory or admin app — falls back to the
  // registry's GENERIC entity store, identified by its interface rather than by its name.
  const genericStore = all.filter((binding) => {
    const factory = (CAPABILITIES[binding.name]?.interface || []).find((entry) => /^make[A-Z]/.test(entry));
    const methods = factory ? CAPABILITIES[binding.name]?.storeInterface || [] : [];
    return ["create", "update", "remove"].every((method) => methods.includes(method));
  });
  const owners = scopedBindings.filter((binding) => binding.requiredMethods?.length);
  const planned = owners.length ? owners
    : (durablePersistenceJourneys(contract, journeys).length ? genericStore : []);
  if (!planned.length && !coordinatedFlow && !(dependencyPlan?.requirements || []).length) return [];

  const plan = [];
  const adapterOwners = [];
  for (const binding of planned) {
    const factory = (CAPABILITIES[binding.name]?.interface || []).find((entry) => /^make[A-Z]/.test(entry));
    if (!factory) continue;
    const path = `src/data/${binding.name}.js`;
    adapterOwners.push(factory);
    plan.push({
      path,
      role: `${binding.name} capability adapter`,
      factory,
      stateOwnership: {
        owns: `${binding.name} contracted durable records and status`,
        survivesReload: true,
        approvedPersistence: factory,
      },
    });
  }
  if (!plan.length && !coordinatedFlow && !(dependencyPlan?.requirements || []).length) return [];

  const durableStateOwner = adapterOwners.join(" + ");
  for (const journey of journeys) {
    const kinds = new Set(journeyStepKinds(journey));
    if (!["mutation", "selection", "input", "output", "presentation"]
      .some((kind) => kinds.has(kind))) continue;
    const name = pascal(journey.id);
    const directory = `src/components/${String(journey.id).replace(/[^a-zA-Z0-9-]+/g, "-").toLowerCase()}`;
    plan.push({ path: `${directory}/${name}Flow.jsx`, role: "step navigation and flow composition",
      journeyIds: [journey.id],
      stateOwnership: { owns: "ephemeral UI orchestration only", survivesReload: false, durableStateOwner } });
    if (kinds.has("review")) {
      plan.push({ path: `${directory}/${name}Review.jsx`, role: "review presentation",
        journeyIds: [journey.id],
        stateOwnership: { owns: "presentation only", survivesReload: false, durableStateOwner } });
    }
    if (kinds.has("mutation")) {
      plan.push({ path: `${directory}/${name}Confirmation.jsx`, role: "confirmation and reference presentation",
        journeyIds: [journey.id],
        stateOwnership: { owns: "presentation only", survivesReload: false, durableStateOwner } });
    }
    if (kinds.has("output")) {
      plan.push({ path: `${directory}/${name}Output.jsx`, role: "format serialization and download responsibility",
        journeyIds: [journey.id],
        stateOwnership: { owns: "ephemeral export preparation only", survivesReload: false, durableStateOwner } });
    }
    if (kinds.has("cancellation") || kinds.has("recovery") || kinds.has("lookup")) {
      plan.push({ path: `${directory}/${name}Status.jsx`, role: "restored and cancelled status presentation",
        journeyIds: [journey.id],
        stateOwnership: { owns: "presentation only", survivesReload: false, durableStateOwner } });
    }
  }
  for (const requirement of dependencyPlan?.requirements || []) {
    if (!requirement.ownerModule || plan.some((module) => module.path === requirement.ownerModule)) continue;
    plan.push({
      path: requirement.ownerModule,
      role: `${requirement.capability.replace(/_/g, " ")} specialist rendering module`,
      journeyIds: [...new Set(
        requirement.journeyIds?.length
          ? requirement.journeyIds
          : [requirement.ownerJourneyId].filter(Boolean),
      )],
      requiredImports: [requirement.package],
      stateOwnership: {
        owns: "ephemeral rendered scene and interaction state",
        survivesReload: false,
        durableStateOwner,
      },
    });
  }
  return plan;
}

/**
 * Domain-neutral step vocabulary shared by the module plan and the interaction contract, so
 * one journey is not interpreted twice by two different regex tables.
 */
export function journeyStepKinds(journey) {
  const kinds = [];
  for (const step of journey?.steps || []) {
    const text = `${step?.action || ""} ${step?.target || ""}`.toLowerCase();
    if (/\b(select|choose|pick)\b/.test(text)) kinds.push("selection");
    if (/\b(enter|type|fill|provide|complete)\b/.test(text)) kinds.push("input");
    if (/\b(review|summary)\b/.test(text)) kinds.push("review");
    if (/\b(confirm|submit|book|reserve|create|save|rename|duplicate|delete|undo|redo|apply)\b/.test(text)) kinds.push("mutation");
    if (/\b(reload|refresh|recover|restore|sign[ -]?in)\b/.test(text)) kinds.push("recovery");
    if (/\b(look ?up|find|search)\b/.test(text)) kinds.push("lookup");
    if (/\bcancel\b/.test(text)) kinds.push("cancellation");
    if (/\b(download|export|serialize|file)\b/.test(text)) kinds.push("output");
    if (/\b(responsive|viewport|mobile|tablet|desktop|layout)\b/.test(text)) kinds.push("presentation");
  }
  return [...new Set(kinds)];
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
    else if (outcome.status !== "pass") failures.push(`essential journey ${id} is ${outcome.status || "not green"}`);
  }
  for (const row of backendRowFailures) if (essential.has(row.journeyId)) failures.push(`essential backend-row check failed (${row.journeyId})`);
  if (blockingErrors.length) failures.push(`blocking console/network errors: ${blockingErrors.length}`);

  const pendingIncrements = (journeyResults?.journeys || [])
    .filter((j) => !essential.has(j.id) && j.status !== "pass")
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
