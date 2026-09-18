// The entity schema compiler (WP5).
//
// The typed contract's durable domain entities compile ONCE into the schema the entities module
// validates against, the composer renders, the lock hashes (schemaHash) and later packages query
// through. Platform-owned entities (accounts) and transient entities are excluded: they are not
// application records. The compiled shape comes from the shared schema module so the generated
// application validates exactly what the platform compiled.

import { compileSchema, queryableFields } from "../../../../../src/scaffolds/reactVite/lib/modules/schema.js";
import { entityPersistencePolicy } from "../../../../shared/implementationContract.mjs";

export const ENTITY_SCHEMA_VERSION = 1;

/** Contract entities that are application records: declared, durable, not platform-owned. */
export function durableDomainEntities(contract) {
  return (contract?.entities || []).filter((entity) => entity?.name && !entity.platform
    && entityPersistencePolicy(contract, entity.name) !== "transient");
}

export function compileEntitySchema(contract) {
  const entities = durableDomainEntities(contract);
  // The normalised declarations the composer embeds: the generated application compiles exactly
  // these with the same compileSchema, so platform and app validate one schema.
  const definitions = entities.map((entity) => ({
    name: entity.name,
    owned: entity.owned !== false,
    ...(entity.policy ? { policy: entity.policy } : {}),
    fields: (entity.fields || []).map((field) => (typeof field === "string" ? { name: field } : {
      name: field.name, ...(field.type ? { type: field.type } : {}), ...(field.required === true ? { required: true } : {}),
      ...(Array.isArray(field.options) ? { options: field.options } : Array.isArray(field.enum) ? { options: field.enum } : {}),
      ...(field.target || field.references ? { target: field.target || field.references } : {}),
      ...(Number.isFinite(field.minimum) ? { minimum: field.minimum } : {}), ...(Number.isFinite(field.maximum) ? { maximum: field.maximum } : {}),
      ...(field.onDelete ? { onDelete: field.onDelete } : {}),
    })),
  }));
  const schema = compileSchema(definitions);
  const problems = [];
  for (const entity of Object.values(schema.entities)) {
    for (const relation of entity.relations) {
      if (!schema.entities[relation.target]) {
        problems.push(`${entity.name}.${relation.field} references ${relation.target}, which is not a durable domain entity`);
      }
    }
    if (!entity.policy) problems.push(`${entity.name} has no access policy`);
  }
  return {
    version: ENTITY_SCHEMA_VERSION,
    schema,
    definitions,
    entities: schema.entityNames,
    queryable: Object.fromEntries(schema.entityNames.map((name) => [name, queryableFields(schema, name)])),
    relations: schema.entityNames.flatMap((name) => schema.entities[name].relations.map((relation) => ({ from: name, ...relation }))),
    verdict: { ok: problems.length === 0, problems },
  };
}

/** The compact schema brief a prompt or facade needs: fields, types, required, references. */
export function entitySchemaBrief(compiled) {
  return Object.fromEntries((compiled?.entities || []).map((name) => {
    const entity = compiled.schema.entities[name];
    return [name, Object.fromEntries(Object.entries(entity.fields).map(([field, definition]) => [field,
      `${definition.type}${definition.required ? " required" : ""}${definition.reference ? ` → ${definition.reference.target}` : ""}${definition.options ? ` (${definition.options.join("|")})` : ""}`]))];
  }));
}
