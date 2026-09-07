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
  };
}

export function executionProvenanceValid(contract) {
  return !contract?.executionProvenance
    || JSON.stringify(canonical(contract.executionProvenance)) === JSON.stringify(canonical(executionProvenance(contract)));
}
