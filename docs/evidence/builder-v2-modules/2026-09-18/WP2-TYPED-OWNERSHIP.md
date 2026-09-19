# WP2 — Typed ownership and platform values (2026-09-18)

New shared module: `shell/shared/contractOwnership.mjs` (versioned normalisation, ownership v1).

## Architectural change

- Every operation carries `owner: "module" | "generated"`; a module-owned operation names `module` and `moduleOperation`; a generated operation that hands persistence to a module keeps `moduleBindings`. Every operation carries `output: { type }` from the platform value vocabulary — session, entity, collection, transient_result, artifact, job, external_effect.
- Session-shaped entities (session, authSession, credential-only entities) leave the domain schema; credential/token-shaped fields leave every entity. Session operations bind to `thrallo.identity` (signIn/signUp/signOut/resetPassword/confirmReset), the reserved credential controls stay the only inputs, and a contract that declared the session as an entity without `auth.required` has it set with `inferredFrom: "session_entity"`.
- Platform infrastructure the contract needs is declared under `ownership.platformRequirements` (identity, entities, accounts, authorization, admin, exports, payments, file_uploads, realtime) with `status` and `enforcement`. `block` fails the contract before generation; `warn` records the gap until the owning work package lands (accounts/authorization/admin → WP4, file_uploads/realtime → WP10, exports → WP11, payments → WP12).
- `deriveBuildSpec()` normalises on entry; `verdict.ownership` checks every module reference against the registry (an operation naming `thrallo.entities.upsert` fails). `contractAgent.normaliseContract()` emits typed contracts. Graph operation rows and the execution spec carry `owner/module/moduleOperation/output`.

## Shared-layer defects fixed on the way

- `interactionContract`: a capability method with no registered required inputs (session signOut) no longer needs `reads`; retained sign-out operations had satisfied the rule only by reading a fake session field.
- `implementationContract.validateContract`: same exemption for functional session responsibilities (`SESSION_METHODS_WITHOUT_INPUTS`), matching the prompt's own sign-out shape; `isSessionOperation` recognises the camel-case session methods.
- `routeResolution.authRoute`: the canonical vocabulary (`capability: "session"`, kinds signIn/signOut) receives the authentication route basis exactly as the legacy `"auth"` spelling did.

## Compatibility impact

- Originals preserved: `ownership.removedEntities` and `retargetedOperations[].from` hold the historical shapes verbatim; a contract already at ownership v1 passes through unchanged (idempotent).
- All ten retained contracts (six Advanced 2026-09-16, fresh Advanced 2026-09-17, both Medium recessed, Lumen) derive green with no session entity and identity-owned sign-in.
- Core write units unchanged for 6833295, f8e2281, ca48824, 1f56b9c, 62841e8. For 46aab6c the sign-out step now resolves to the sign-in route (authentication basis), which joins the settings journey to the primary write unit — the same scoping HEAD already applied to 6833295. Its retained candidate predates that scope, so the corpus suite pins the exact findings it now reports instead of "clean".
- Execution-spec identity counts drop where fake session plumbing left generation (f8e2281 890→758, ca48824 1268→1085, 1f56b9c 1464→1341): custom sign-in/sign-out extension nodes and an authSession entity store are no longer stated to the model.

## Tests

`builder-v2-typed-ownership.test.mjs` (7): typing rules, idempotence, removal + verbatim preservation, retained Advanced compile without fake entities, fresh/Medium derive green with accounts flagged, agent emits typed contracts + execution spec ownership, negative controls.
