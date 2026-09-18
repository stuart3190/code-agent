# WP5 — Schema-backed entity persistence (2026-09-18)

## Architectural change

- **Schema** `src/lib/modules/schema.js` (pure, shared by platform and generated app): compiles contract entities into typed fields (string/text/number/integer/boolean/date/datetime/email/url/reference/enum/json), many-to-one references from `<entity>Id` fields or declared targets (with `onDelete`, default restrict), enum options, min/max, access policy and indexes; `validateValues` (full or partial) rejects reserved metadata (`id`, `version`, `createdAt`, `updatedAt`, `owner`, …), missing required fields, type/enum/range errors; `queryableFields` is the allow-list the query module (WP7) uses. Server compiler `platformModules/schema.mjs` selects durable, non-platform entities and refuses references to non-entities.
- **Entities** `src/lib/modules/entities.js`: `EntityRecord = { id, version, createdAt, updatedAt, values }`; server-produced identity (caller-supplied id/version ignored); create/update validated; references checked against the caller's own visible records (RLS proves ownership) before a write; update merges a validated patch with **optimistic concurrency** — a compare-and-set on the stored version (`version_conflict` when another writer moved the record), never a blind read-modify-write; delete honours the relation policy (`reference_restricted`); reload resolves the same canonical id; legacy flat records through `toLegacyRecord`.
- **SDK** `db.entity(type).updateVersioned(id, data, expectedVersion)`: a PostgREST conditional update filtered on `data->__meta->>version`, app-scoped, under the existing owner RLS — no migration required for atomic updates.
- **Composition**: `composed/entities.js` (the compiled schema + one repository per entity) and facade `app/entities.js` (`repository(name)`, `useEntity(name, id)`, `useEntityMutation(name)`); the legacy `composed/crud.js` store keeps composing beside it. `thrallo.entities@1.1.0` (provides crud + entities; `update` declares `concurrency: "versioned"`) registered beside 1.0.0.
- **Persistence lint**: `generated_record_shape_wrapper` (advisory) reports generated code that re-derives record shape from raw rows (`row.data` spreads, `created_at`) where the typed module is installed.

## Compatibility

- `makeEntityStore` unchanged; the JSONB `entities` table is the storage behind the adapter; rows written before WP5 (no `__meta`) read as version 1.
- Old locks resolve `thrallo.entities@1.0.0`; trees without the module runtime compose as before.

## Settled during implementation

- **`entities` is an alias of `crud`**, not a second capability entry — the same precedent as `auth` aliasing `session`. One capability, one module, two names: `canonicalCapabilityId("entities") === "crud"`, and `thrallo.entities` declares `provides.capabilities: ["crud", "entities"]`. A contract may name either.
- **The composed module embeds the normalised declarations, not a compiled shape.** `composed/entities.js` ships `entityDefinitions` and calls the same `compileSchema` the platform used, so the generated application validates one schema rather than a copy that could drift from the platform's.
- **Record-shape lint wired into `lintDurablePersistence`**, and it runs whether or not the contract has a durable journey: the module owns identity and shape either way. `generated_record_shape_wrapper` is advisory (`validationSeverity`), so a working wrapper still reaches the browser while repair is told to replace it with the module's record.
- **Version honesty across both entity module versions.** `thrallo.entities@1.0.0` keeps declaring `concurrency: null` for its read-modify-write `update`; 1.1.0 declares `versioned` and adds `version_conflict`, `validation_failed`, `reference_not_found`, `reference_restricted` to the operations that can raise them. Old locks still resolve 1.0.0.

## Tests

`builder-v2-entities-module.test.mjs` (8): schema compilation + exact validation; CRUD with server identity, immutable reserved metadata, validated patches, reference checks, restrict-on-delete and canonical reload; concurrent updates where exactly one writer wins the compare-and-set and the loser retries from a fresh read with no lost update; the SDK's conditional update filtered on the stored version; build-spec compilation + composer output + lock hashing + tamper attribution; registry (1.1 beside 1.0, alias, protected paths); the record-shape lint positive and its legacy-tree negative; UI binding through the shipped hooks.
