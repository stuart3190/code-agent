import crypto from "node:crypto";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

export function sourceContractDigest(contract) {
  return digest({
    entities: contract?.entities, operations: contract?.operations, routes: contract?.routes,
    auth: contract?.auth, buildProfile: contract?.buildProfile,
    journeys: contract?.allJourneys || contract?.journeys,
    interactions: contract?.prerequisiteInteractionContract || contract?.interactionContract,
    scaffoldGraph: contract?.scaffoldGraph,
  });
}

export function executionProvenance(contract) {
  return { version: 1, sourceContractDigest: sourceContractDigest(contract),
    executionDigest: digest({ journeys: contract?.journeys, interactions: contract?.interactionContract }),
    drivenJourneyIds: [...new Set((contract?.interactionContract?.flows || []).map((flow) => flow.journeyId))],
    // Every journey in the bound scope by name, including one that derived no flow and is driven from prose.
    journeyIds: (contract?.journeys || []).map((journey) => journey.id),
  };
}

/**
 * Has the execution contract stayed what was bound?
 *
 * The orchestrator binds provenance over the WHOLE driven scope of a verification pass; the runtime
 * then drives that scope one sandbox job at a time, each carrying one journey and the interactions
 * scoped to it. That split is the bound scope, not a change to it — comparing the whole-scope
 * execution digest against a one-journey job failed every multi-journey pass live (Medium on
 * fb95ecd, 2026-09-07) while a single-journey pass sailed through. So: the source digest must be
 * exact; the driven journeys must lie inside the bound scope; a job carrying the full scope must
 * match the execution digest exactly; a job carrying a subset must reproduce its journeys and
 * flows byte for byte from the bound source it carries (allJourneys / prerequisiteInteractionContract).
 */
export function executionProvenanceValid(contract) {
  const bound = contract?.executionProvenance;
  if (!bound) return true;
  const now = executionProvenance(contract);
  if (bound.sourceContractDigest !== now.sourceContractDigest) return false;
  const boundIds = new Set([...(bound.journeyIds || []), ...(bound.drivenJourneyIds || [])]);
  if (!now.drivenJourneyIds.every((id) => boundIds.has(id))) return false;
  // A journey that derived no flow still has to belong to the bound scope by name.
  if (!(contract.journeys || []).every((journey) => boundIds.has(journey.id))) return false;
  const fullScope = (contract.journeys || []).length === boundIds.size;
  if (fullScope) return bound.executionDigest === now.executionDigest;
  const stringify = (value) => JSON.stringify(canonical(value));
  const sourceFlows = new Map((contract.prerequisiteInteractionContract?.flows || []).map((flow) => [flow.id, stringify(flow)]));
  if (!(contract.interactionContract?.flows || []).every((flow) => sourceFlows.get(flow.id) === stringify(flow))) return false;
  const sourceJourneys = new Map((contract.allJourneys || []).map((journey) => [journey.id, stringify(journey)]));
  return (contract.journeys || []).every((journey) => sourceJourneys.get(journey.id) === stringify(journey));
}
