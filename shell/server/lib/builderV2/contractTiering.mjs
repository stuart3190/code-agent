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
  const bindings = [{ name: "crud", version: CAPABILITIES.crud.version },
    { name: "session", version: CAPABILITIES.session.version }];
  const entityNames = new Set((contract?.entities || []).map((e) => String(e.name).toLowerCase()));
  // FEATURE vocabulary only — journey ids/titles and route names, never step prose: "enter
  // your contact details" inside a booking form must not bind the contact-form capability.
  const vocabulary = words([
    ...(contract?.journeys || []).map((j) => `${j.id} ${j.title}`),
    ...(contract?.routes || []).map((r) => `${r.path} ${r.name}`),
  ].join(" "));

  if (entityNames.has("booking") || vocabulary.has("booking") || vocabulary.has("reservation")) {
    bindings.push({ name: "booking", version: CAPABILITIES.booking.version });
  }
  if (entityNames.has("newslettersignup") || vocabulary.has("newsletter")) {
    bindings.push({ name: "newsletter", version: CAPABILITIES.newsletter.version });
  }
  if (entityNames.has("contactmessage") || vocabulary.has("contact")) {
    bindings.push({ name: "contact", version: CAPABILITIES.contact.version });
  }
  if (contract?.auth?.required) bindings.push({ name: "roles", version: CAPABILITIES.roles.version });

  const check = validateBindings(bindings);
  if (!check.ok) throw new Error(`capability binding failed: ${check.problems.join("; ")}`);
  return bindings;
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
