# WP8 — Settings and audit history (2026-09-18)

Replaces the audit's "Settings singleton inferred from prose" (§12) and "generated history records"
(§7.2) with two platform modules, a service that owns both, and typed contract ownership for the
settings entity a contract declares.

## Architectural change

- **Settings** `src/lib/modules/settings.js` (pure): a setting is a TYPED key with an explicit scope (`app`, `user`, `workspace`), an explicit default and a version. Reading a key that was never written returns its **declared default**, so no screen has to invent one and two screens cannot disagree about it. Writing coerces against the declared type and refuses a value outside declared options. The module owns the value; presentation stays the application's.
- **Audit** `src/lib/modules/audit.js` (pure): reads authorised history and redacts it. There is deliberately **no append** — an application that could write its own history could also write a false one — and redaction is applied both on the server before a row is stored and again before anything renders, so a field declared sensitive cannot leak through an older row.
- **Service** `supabase/functions/app-accounts/platformStateService.mjs`: pure ESM over a storage seam, like the account service, so the same logic runs in the Edge Function and in tests. Scope isolation is **server-side**: a `user` value is keyed by the ACTOR, so naming someone else's id in a request reads your own row, and an `app` value requires the `settings.write` grant while a member's own preference requires only membership. A `workspace` read without its record id is refused rather than answered from the application scope.
- **Storage** migration `20260918140000_app_settings_audit.sql` (additive, idempotent, unapplied): `app_settings`, `app_audit_events` (append-only, enforced by a `before update` trigger that raises), and `app_audit_config`. All three are deny-all RLS, service-role only, so a generated client can neither set an application value it has no grant for nor write its own history.
- **Typed ownership** `shell/shared/contractOwnership.mjs`: a settings singleton becomes `platform: "settings"` — still declared, because its fields are the contract's vocabulary for the keys, but never an application record. It leaves the compiled entity schema, so no entity store is composed for it, and its CRUD retargets to the settings command it means (`update` → `set`, `read` → `get`, `delete` → `reset`). A transformation that only chooses which declared key to write is **absorbed** into that command and recorded under `droppedResponsibilities`; one that writes anything outside the declared keys is real domain logic and stays generated.
- **Selection** requests `thrallo.settings` when a singleton is declared and `thrallo.audit` only when the contract's own vocabulary asks to review changes. History nobody reads is history nobody can check.
- **Capabilities/modules**: `settings` and `audit` are registered capabilities (not structure-selected like routing/query/forms/async), provided by `thrallo.settings@1.0.0` and `thrallo.audit@1.0.0`. Both declare the `accounts` service, so a deployment without it **blocks** with `module_unavailable` + `configurationRequired` rather than falling back to a generated settings record.
- **Composition**: `src/lib/capabilities/composed/settings.js` embeds the declarations (not a re-derivation) and `composed/audit.js` wires a list-only transport; `src/lib/app/settings.js` exposes `useSettings`/`useHistory`. A build with no singleton and no history vocabulary composes exactly as before — no settings files, no settings module in the lock.
- **Shell persistence**: the account policy recorded for an application now carries the compiled settings definitions, so the service validates a write against the schema the BUILD declared rather than against the request; the audit configuration is written when the contract asks for history.

## Why the claim is narrow

An entity becomes platform settings only when it is genuinely a singleton: a settings-shaped name,
no create and no collection read, and no field whose last word is `id`/`key`/`code`/`slug`. The
word test is camelCase-aware, so `roomTypeKey` addresses a table and disqualifies the entity while
`roomType` is an attribute of one settings record and does not. `name` and `type` are deliberately
NOT key words: `siteName` and `invoiceType` are ordinary settings values far more often than they
are addresses. Claiming a keyed lookup table would silently delete a real application concept,
which is worse than leaving it a domain entity.

Entity-level audit capture is opt-in per application through `app_audit_config`, and the trigger
records identity and action only — never values. Field-level diffs exist only where the platform
mediates the write (the account and settings commands), because that is the only place redaction
can be applied truthfully.

## Known limitation

A secret-shaped settings key (`apiToken`) stays a setting an administrator may set and is marked
sensitive, so its value never reaches an audit row — but the platform does **not** encrypt it.
Settings are not a secret store and nothing here claims otherwise; encrypted integration
credentials belong to WP13. Exact credential names (`password`, `token`, `apiKey`, …) are still
stripped from the schema entirely by the WP2 rule before they can become settings at all.

## Compatibility

- Every retained contract and snapshot still derives green. The 2026-09-18 recessed-lighting
  contract's settings entity is now claimed as the singleton it describes ("update … in the
  settings record"), its `roomType` selector left intact.
- The settings/audit modules are additive: `deploymentAvailability`, the module lock and the v3
  snapshot adapter are unchanged, and an adapted legacy lock never claims settings bytes it did
  not contain.
- Coverage ledger: formats `settingsPlan: 1` and `platformStateService: 1`; capability rows
  `settings` and `audit` mapped to WP8.

## Tests

`builder-v2-settings-audit.test.mjs` (15): typed compilation and coercion; declared defaults before
any write, a change surviving a reload through a fresh controller, and reset; server-side scope
isolation across two members, workspace isolation, the missing-target refusal, the member's refusal
on an application value, unknown keys and cross-application refusal; append-only history with
attribution and the superseded value preserved; a sensitive value absent from the stored row and
always-sensitive names redacted in a legacy row; the history controller's paging, redaction,
empty/error states and superseded-load discard; the singleton claim with its lookup-table,
create and list negative controls; the entity leaving the schema with its CRUD retargeted and the
original preserved; a full build locking both modules and composing a protected facade, with a
control build that composes none of it; the unavailable-service block; and the persisted schema
the service validates against.

## Shared-layer defect found and fixed

`PLATFORM_OUTPUT_CAPABILITIES` in `shell/shared/implementationContract.mjs` listed session,
accounts, admin and authorization but not the WP8 capabilities, so a settings command — which
declares reads and no writes, because it stores a platform value rather than a declared entity
field — was rejected with "has no declared functional outputs". A contract the gate should have
accepted on attempt 1 therefore burned a second model call. `settings` and `audit` are now typed
the same way WP2 and WP4 typed their capabilities.

Fixing it also cleared a retained budget failure that predates WP8. The gate-repair prompt embeds
the prior contract verbatim; the 7e74b401 fixture's two settings operations carried CRUD
persistence plus a transformation that only chose which declared key to write, and at HEAD that
payload pushed the repair's estimated input to 17381 tokens — past the protected remainder, so the
call could not fit any output at all (`recovery_envelope_exhausted`). Retargeting those operations
to the settings command removes the bytes, and the repair fits again. Typed ownership is cheaper
than the prose it replaces, which is the point the audit makes about compact generation (§14).
