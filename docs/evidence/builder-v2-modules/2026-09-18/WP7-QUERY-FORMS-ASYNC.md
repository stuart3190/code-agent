# WP7 — Query/collections, forms/interactions and async resource state (2026-09-18)

Completes the first acceptance milestone: identity/session → accounts/authorization/admin →
schema/entities → routing → query/forms/async state.

## Architectural change

- **Query** `src/lib/modules/query.js` (pure): a query is a *compiled specification*, not a predicate over a fetched page. Fields and operators come from the schema's allow-list (`query_field_not_allowed`, `query_operator_not_allowed`), values are normalised per field type, JSON fields are not queryable, and only server-stable orders (`created_at`, `id`) paginate — sorting a page by a domain field is refused rather than silently approximated, because it would make paging unstable. The cursor is opaque, composite (`sort value` + `id`) and **bound to its query key**, so a page from one query can never continue another.
- **Collections** `src/lib/modules/collections.js`: the screen owns the search/filter/sort controls; this owns the specification, the server round-trip, cursor paging and the collection state. An invalid field is an error state, never a silent no-op, and a superseded load never overwrites a newer one.
- **SDK**: `db.entity(type).list()` now accepts a composite cursor and emits a real **keyset** condition (`created_at.gt.X` OR `created_at.eq.X AND id.gt.Y`) with `order=created_at,id`, so rows sharing a timestamp are neither skipped nor repeated; `count()` applies the **same** operator predicate as `list()` through one shared filter builder, so a total can never disagree with the page it describes.
- **Forms** `src/lib/modules/forms.js`: field state, coercion from the schema's field types (an input's string becomes the typed value — `onChange` never sees a DOM event), schema plus custom-rule validation, touched/dirty tracking, one submission path with stale-submit protection, and a reset that returns a genuinely new draft.
- **Async state** `src/lib/modules/asyncState.js`: loading/ready/empty/error with cancellation of superseded loads, mutations with optimistic application and **rollback on failure**, and a keyed resource cache so two screens reading one key share a load and an invalidation.
- **Modules**: `thrallo.query@1.0.0`, `thrallo.async@1.0.0`, and `thrallo.forms@1.1.0` — the form runtime belongs to the same module as the legacy interaction primitives, so it is a new **version** of that wrapper (1.0.0 stays registered for snapshots locked to it), not a second module claiming the id.
- **Facade**: the entities facade gains `useCollection`, `useForm`, `useResource`, `useMutation` and the `create*` factories; `queryableFields` is re-exported so a screen can ask what it may filter on.
- **Lint**: `query_field_not_declared` (advisory), wired into module conformance — it reads only literal, top-level filter keys and abstains wherever attribution would be a guess.

## Compatibility

- The scaffold's own `useFormState`, `useResourceState`, `useCatalogueState` and `useWorkflowState` primitives keep shipping unchanged for screens already written against them.
- `interaction-primitives` still resolves (now to forms 1.1.0); a v3 snapshot's adapted lock carries only its capability-derived modules and never claims the query, async or routing bytes it does not contain.

## Tests

`builder-v2-query-forms-async.test.mjs` (8): specification validation and refusals; stable pagination across three pages over records that share a `created_at`, with cursor/query binding enforced; the SDK's server-side operator filters, keyset cursor and count; the collection controller filtering across all rows rather than the loaded page, plus a superseded-load race; the form runtime's coercion, validation, single submission and reset; resource cancellation, optimistic rollback and cache invalidation; the facade exports; and the query lint's positive and abstaining cases.

## Shared-layer defect found and fixed

Wiring WP7 exposed a defect that predates it: five linters still described platform infrastructure as `src/lib/{backend,capabilities,scaffolds}` only, so the module runtime added by WP3–WP7 (`src/lib/modules`) and the composed public facade (`src/lib/app`) were judged as **generated application source**. The static application gate consequently reported the platform's own code as application defects (`undefined_identifier` for `btoa`/`atob` in the query module, and a false positive on a default-parameter binding in the async module), which blocked every composing build into a correction loop until its allowance ran out — 69 regression failures.

The platform boundary is now stated identically in every linter that judges generated source: `staticApplicationGate`, `moduleContracts`, `persistenceLint`, `wizardEntryTransform` and — most importantly — `repairGovernance`, where it means repair can never rewrite module code, which is exactly the audit's §14 rule that a module fault is platform remediation rather than an application patch.
