# WP4 — Accounts, authorization and admin users (2026-09-18)

The audit's P0: generated role fields and client checks impersonating real account administration.

## Architectural change

- **Server authority** `supabase/functions/app-accounts/` (new Edge Function, not deployed): `policy.js` (pure grant evaluation over the server-derived actor — a role on a business record is never consulted; own membership immutable; suspended/invited denied) and `accountService.mjs` (pure service over a storage seam: me/updateMe/permissions/member/members/invite/provision/setRole/setStatus/activateInvitation; app-scoped actors; last-admin protection; every command recorded). The Edge Function binds the service to service-role storage; app-auth activates an invitation on signup. Deno execution is unverified locally (no Deno); the service and policy are exercised through Node with the memory storage twin.
- **Migration** `20260918120000_app_accounts_memberships.sql` (additive, unapplied): `app_memberships`, `app_profiles`, `app_membership_events`, `app_account_policies` — all service-role only; existing `app_users` backfilled as ordinary members (the explicit account-mapping migration; no role inferred from application data).
- **Client runtime** `src/lib/modules/policy.js` (byte-identical copy of the server policy, enforced by test), `accounts.js` (accounts controller, client-side authorization for UX, admin commands pre-checked locally and enforced server-side), `accountsReact.js`; SDK `accounts` surface (`VITE_ACCOUNTS_URL`).
- **Registry**: capabilities `accounts`, `authorization` (1.1, keeps `roles`), `admin`; modules `thrallo.accounts@1.0.0`, `thrallo.authorization@1.1.0` (1.0.0 retained for old locks), `thrallo.admin@1.0.0`; service `accounts` added to availability, **not** in the baseline (the function is not deployed) — a contract that needs it blocks before generation with `module_unavailable` (configuration required).
- **Contract typing**: an account-shaped entity (appUser, userProfile, …) stays declared as vocabulary but becomes `platform: "accounts"` (no entity store is composed); its CRUD becomes `admin.inviteMember` / `setMemberRole` / `setMemberStatus` / `accounts.updateMe` / `getMember` / `admin.listMembers`; non-platform fields form the profile schema; a generated transformation that only fabricates platform facts (`authUserId` "derived from the email") is dropped and recorded. Requirements accounts/authorization/admin resolve to their modules and are `block` enforced. Bindings, composition (`composed/accounts.js`, `authorization.js`, `admin.js`, facade `app/accounts.js`: `useProfile`, `usePermissions`, `can`, `useAdminMembers`, `useAdminOperation`) and the shell's policy record (`app_account_policies`, optional table) follow.

## Compatibility

- Retained Medium contracts (2026-09-17, 2026-09-18) now: **block** on the baseline deployment (accounts service undeclared) and derive green with the service declared — with no `appUser` store, no generated user management, originals preserved under `ownership.accountEntities`/`retargetedOperations`.
- Legacy `roles` capability and `isOwner`/`requireOwner` unchanged; old locks resolve `thrallo.authorization@1.0.0`.
- Baseline ledger unchanged; additions ledgered (3 capabilities, 1 SDK surface, 2 formats).

## Tests

`builder-v2-accounts-module.test.mjs` (8): policy grants/self-immutability/suspension; service allow/deny, cross-app isolation (an actor of one app is nobody in another, even as an object), suspension denies `me`, role change persists and reshapes permissions, last admin protected, events attributed; profile allow-list (a role can never be written through the profile), invitations activate on signup, provisioning, lookup; policy copy byte-identical + migration additive + app-auth activation; contract typing on the retained Medium contract; block-before-generation vs green-with-service + no fake store + lock tampering attribution; registry; UI binding — a generated-style admin screen shows/hides controls from server-derived permissions, and a member's escalation attempt is refused by the service.

## Availability boundary (settled during the regression)

- `baselineDeploymentAvailability()` = what the SOURCE ships (backend SDK, app-auth, entities, realtime, and now accounts) — the derivation default for tests, replays and compilation.
- `availabilityFromEnv()` = what THIS deployment declares — what a live build resolves against (`runtimeComposition` passes it as `moduleAvailability`). The accounts service is enabled only by `THRALLO_APP_SERVICE_ACCOUNTS=1` after the Edge Function is deployed and the migration applied; without it an admin contract blocks before generation (`module_unavailable`, configuration required). `legacyDeploymentAvailability()` names the pre-WP4 production shape for tests.
- Account-shaped entity detection is deliberately narrow (`appUser`, `userProfile`, `userAccount`, `platformUser`, `authUser`, `appAccount`, or a bare `user` carrying email plus role/status). A gym's `member`, a `customer` or a `technician` is a domain record that may reference a principal — never an account by name.
- `operationUsesDurablePersistence` excludes only operations owned by platform-record modules (identity, accounts, authorization, admin); booking/workflow/capture keep their generic-backend persistence handoff.
- The contract validator accepts platform-output responsibilities (session, accounts, admin, authorization) without entity writes, as it already did for sessions.
