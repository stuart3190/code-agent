// EXECUTION PROVENANCE — one bound specification, exact projections of it.
//
// The orchestrator binds a verification pass over a SOURCE (the enriched contract: entities,
// operations, routes, auth, profile, every journey, the full interaction plan, the scaffold graph)
// and a SCOPE (which journeys this pass drives, which it reuses from cache). Everything that runs
// afterwards - the per-journey sandbox jobs, the verifier, the evidence that later authorises a
// repair - must be a projection of that same binding, never a re-interpretation of it.
//
// Two failures taught the shape of this file. Live Medium on fb95ecd (2026-09-07) stopped every
// multi-journey pass because the whole-scope digest was compared against a one-journey job. The
// audit that followed found the opposite hole: a one-journey job with a REQUIRED flow removed, or
// with its scenario metadata altered, still passed a membership-only check. So a projection is
// judged for completeness and semantic equality, not membership:
//
//   - the source digest is exact;
//   - projected journeys lie inside the bound DRIVEN scope (a cached journey is never driven);
//   - each projected journey equals its bound source journey byte for byte;
//   - each projected journey carries EXACTLY the bound flows for that journey - none missing, none
//     foreign, every flow identical (identity, semantics, producer requirements, controls);
//   - each projected scenario (role / start state / lifecycle / basis) equals the bound one;
//   - operation coverage for the projected journeys is complete and identical;
//   - a projection carrying the whole driven scope matches the execution digest exactly.

import crypto from "node:crypto";

export const EXECUTION_PROVENANCE_VERSION = 2;

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;
const stringify = (value) => JSON.stringify(canonical(value));
const digest = (value) => crypto.createHash("sha256").update(stringify(value)).digest("hex");

const sourceInteractions = (contract) => contract?.prerequisiteInteractionContract || contract?.interactionContract || null;
const sourceJourneys = (contract) => contract?.allJourneys || contract?.journeys || [];
const journeyIdsOf = (journeys) => (journeys || []).map((journey) => journey?.id).filter(Boolean);
const flowsFor = (interactions, journeyId) => (interactions?.flows || []).filter((flow) => flow.journeyId === journeyId);
const coverageFor = (interactions, journeyId) => (interactions?.operationCoverage || [])
  .filter((row) => row.journeyId === journeyId);

/** The digest of what was SPECIFIED - independent of which journeys a pass happens to drive. */
export function sourceContractDigest(contract) {
  return digest({
    entities: contract?.entities, operations: contract?.operations, routes: contract?.routes,
    auth: contract?.auth, buildProfile: contract?.buildProfile,
    journeys: sourceJourneys(contract),
    interactions: sourceInteractions(contract),
    scaffoldGraph: contract?.scaffoldGraph,
  });
}

/** Per-journey digests of the bound source: flows, scenario, coverage - the units a projection must reproduce. */
export function journeyProvenance(contract) {
  const interactions = sourceInteractions(contract);
  return Object.fromEntries(sourceJourneys(contract).map((journey) => [journey.id, {
    journey: digest(journey),
    flows: digest(flowsFor(interactions, journey.id)),
    flowIds: flowsFor(interactions, journey.id).map((flow) => flow.id).sort(),
    scenario: digest(interactions?.scenarios?.[journey.id] ?? null),
    coverage: digest(coverageFor(interactions, journey.id)),
  }]));
}

/**
 * Bind provenance to an execution contract (see orchestrator.verificationExecutionContract).
 * `journeyIds` is the pass's whole scope, `drivenJourneyIds` the part actually driven (the rest
 * is reused from cache), so a later projection can prove both what is fresh and what is reused.
 */
export function executionProvenance(contract) {
  const scopeIds = journeyIdsOf(contract?.journeys);
  const drivenIds = contract?.interactionContract?.scopedJourneyIds
    || [...new Set((contract?.interactionContract?.flows || []).map((flow) => flow.journeyId))];
  const driven = scopeIds.length ? scopeIds.filter((id) => drivenIds.includes(id)) : drivenIds;
  return {
    version: EXECUTION_PROVENANCE_VERSION,
    sourceContractDigest: sourceContractDigest(contract),
    // What EXECUTES: the driven journeys and their interactions. A reused journey is bound (its
    // cached verdict is part of the pass) but never run, so it is not part of the execution digest.
    executionDigest: digest({ journeys: (contract?.journeys || []).filter((journey) => driven.includes(journey?.id)),
      interactions: contract?.interactionContract }),
    journeyIds: scopeIds,
    drivenJourneyIds: driven,
    reusedJourneyIds: scopeIds.filter((id) => !driven.includes(id)),
    journeyDigests: journeyProvenance(contract),
  };
}

/**
 * Project a bound execution contract onto a subset of its driven journeys - the one operation
 * that turns "the pass" into "this sandbox job". It is what runtimeComposition sends to the
 * browser worker and what any harness must send too, so there is exactly one place where the
 * per-journey shape is decided. The binding travels with it unchanged.
 */
export function projectExecutionJourneys(execution, journeys = []) {
  const kept = (journeys || []).map((journey) => journey?.journey || journey).filter(Boolean);
  const interactions = execution?.interactionContract || null;
  const ids = new Set(journeyIdsOf(kept));
  return {
    ...execution,
    journeys: kept,
    allJourneys: sourceJourneys(execution),
    prerequisiteInteractionContract: sourceInteractions(execution),
    interactionContract: interactions ? {
      ...interactions,
      flows: (interactions.flows || []).filter((flow) => ids.has(flow.journeyId)),
      scenarios: Object.fromEntries(Object.entries(interactions.scenarios || {})
        .filter(([journeyId]) => ids.has(journeyId))),
      operationCoverage: (interactions.operationCoverage || []).filter((row) => ids.has(row.journeyId)),
      scopedJourneyIds: [...ids],
    } : interactions,
    executionProvenance: execution?.executionProvenance,
  };
}

/**
 * Judge a projection against its binding. Returns { ok, reasons[] } so a refusal can be
 * reported precisely; `executionProvenanceValid` is the boolean form the verifier gates on.
 */
export function executionProvenanceReport(contract) {
  const bound = contract?.executionProvenance;
  if (!bound) return { ok: true, reasons: [], unbound: true };
  const reasons = [];
  const now = executionProvenance(contract);
  if (bound.sourceContractDigest !== now.sourceContractDigest) {
    return { ok: false, reasons: ["source contract changed after binding (stale fingerprint)"] };
  }
  const projected = journeyIdsOf(contract?.journeys);
  const drivenBound = new Set(bound.drivenJourneyIds || bound.journeyIds || []);
  const scopeBound = new Set([...(bound.journeyIds || []), ...(bound.drivenJourneyIds || [])]);
  const interactions = contract?.interactionContract || {};
  const source = sourceInteractions(contract) || {};
  const sourceById = new Map(sourceJourneys(contract).map((journey) => [journey.id, journey]));
  const boundDigests = bound.journeyDigests || {};

  for (const id of projected) {
    if (!scopeBound.has(id)) reasons.push(`journey ${id} is outside the bound scope`);
    else if (!drivenBound.has(id)) reasons.push(`journey ${id} was bound as reused from cache, not driven`);
  }
  // Flows outside the projected journeys are foreign to this projection.
  for (const flow of interactions.flows || []) {
    if (!projected.includes(flow.journeyId)) reasons.push(`flow ${flow.id} belongs to journey ${flow.journeyId}, outside this projection`);
  }
  for (const id of projected) {
    const journey = (contract.journeys || []).find((row) => row?.id === id);
    const expectedJourney = sourceById.get(id);
    if (!expectedJourney || stringify(journey) !== stringify(expectedJourney)) reasons.push(`journey ${id} differs from its bound source`);
    const expectedFlows = flowsFor(source, id);
    const actualFlows = flowsFor(interactions, id);
    const expectedIds = new Set(expectedFlows.map((flow) => flow.id));
    const actualIds = new Set(actualFlows.map((flow) => flow.id));
    for (const flowId of expectedIds) if (!actualIds.has(flowId)) reasons.push(`journey ${id} is missing required flow ${flowId}`);
    for (const flowId of actualIds) if (!expectedIds.has(flowId)) reasons.push(`journey ${id} carries foreign flow ${flowId}`);
    const expectedByid = new Map(expectedFlows.map((flow) => [flow.id, stringify(flow)]));
    for (const flow of actualFlows) {
      if (expectedByid.has(flow.id) && expectedByid.get(flow.id) !== stringify(flow)) reasons.push(`flow ${flow.id} differs from its bound source`);
    }
    if (stringify(interactions.scenarios?.[id] ?? null) !== stringify(source.scenarios?.[id] ?? null)) {
      reasons.push(`scenario metadata for journey ${id} differs from its bound source`);
    }
    if (stringify(coverageFor(interactions, id)) !== stringify(coverageFor(source, id))) {
      reasons.push(`operation coverage for journey ${id} is incomplete or differs from its bound source`);
    }
    // The bound per-journey digests are the authority when the job also carries them.
    const boundJourney = boundDigests[id];
    if (boundJourney) {
      if (boundJourney.flows !== digest(actualFlows)) reasons.push(`flows of journey ${id} do not match the bound digest`);
      if (boundJourney.scenario !== digest(interactions.scenarios?.[id] ?? null)) reasons.push(`scenario of journey ${id} does not match the bound digest`);
      if (boundJourney.journey !== digest(journey)) reasons.push(`journey ${id} does not match the bound digest`);
    }
  }
  if (bound.executionDigest && projected.length === drivenBound.size
    && projected.every((id) => drivenBound.has(id)) && bound.executionDigest !== now.executionDigest) {
    reasons.push("the full driven scope no longer matches the bound execution digest");
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function executionProvenanceValid(contract) {
  return executionProvenanceReport(contract).ok;
}
