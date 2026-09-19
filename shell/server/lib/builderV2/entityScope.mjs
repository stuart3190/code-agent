// An increment owns a bounded set of operations, but must know the schemas those
// operations read. Schema visibility is not permission to implement more journeys.
export function operationReadEntityNames(contract, operation) {
  const entities = contract?.entities || [];
  const owner = entities.find((entity) => entity.name === operation.entity);
  return [...new Set((operation.responsibilities || []).flatMap((row) => row.reads || []).flatMap((path) => {
    const parts = String(path).split(".");
    const field = parts.at(-1);
    const qualified = entities.find((entity) => parts.slice(0, -1).includes(entity.name));
    if (qualified) return [qualified.name];
    const referenced = entities.find((entity) => entity.name !== owner?.name
      && field.toLowerCase() === `${entity.name}id`.toLowerCase());
    if (referenced) return [referenced.name];
    if ((owner?.fields || []).some((entry) => entry.name === field)) return [owner.name];
    return entities.filter((entity) => (entity.fields || []).some((entry) => entry.name === field))
      .map((entity) => entity.name);
  }))];
}

export function entitiesForOperations(contract, operations, { include = [] } = {}) {
  const entities = contract?.entities || [];
  const names = new Set([...include, ...operations.map((operation) => operation.entity)].filter(Boolean));
  const readPaths = operations.flatMap((operation) => [
    ...(operation.reads || []),
    ...(operation.responsibilities || []).flatMap((responsibility) => responsibility.reads || []),
  ]);
  for (const path of readPaths) {
    const parts = String(path).split(".");
    const qualified = entities.find((entity) => parts.includes(entity.name));
    if (qualified) names.add(qualified.name);
    else for (const entity of entities) {
      if ((entity.fields || []).some((field) => field.name === parts.at(-1))) names.add(entity.name);
    }
  }
  // Follow declared relationships transitively. Token boundaries prevent `task`
  // matching `taskFilter`; plural names are accepted for legacy prose contracts.
  let changed = true;
  while (changed) {
    changed = false;
    for (const entity of entities.filter((candidate) => names.has(candidate.name))) {
      const relationships = JSON.stringify(entity.relationships || []).toLowerCase();
      for (const dependency of entities) {
        const escaped = dependency.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!names.has(dependency.name) && new RegExp(`\\b${escaped}s?\\b`, "i").test(relationships)) {
          names.add(dependency.name);
          changed = true;
        }
      }
    }
  }
  return entities.filter((entity) => names.has(entity.name));
}
