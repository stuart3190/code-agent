# WP3 — Identity/session vertical slice (2026-09-18)

## Architectural change

- **Runtime** `src/lib/modules/identity.js` (protected, shipped in the scaffold): one deterministic session controller with the explicit state vocabulary — initializing, signed_out, visitor, signed_in, expired, error — over the existing backend auth SDK. Owns sign-in/sign-up/sign-out, password reset + confirm, reload recovery (`ensure`/`recover`), expiry (`markExpired`, backend-detected expiry) and the member guard. Credentials never enter state. `identityGuard()` refuses a visitor for a member requirement.
- **React bindings** `src/lib/modules/identityReact.js`: `useIdentityState`, `useIdentityAction`, `useIdentityGuard` — state and functions only, no JSX.
- **Plan** `platformModules/identityPlan.mjs`: `deriveIdentityPlan(contract)` → mode (member when auth.required, else visitor), session methods used, protected routes, signed-out/signed-in redirects, roles, and the deterministic verification probes (initial, signIn/signUp, reload, expiry→recover, signOut, reset, visitor denied on member routes). Carried on the build spec.
- **Composer**: when the lock resolves `thrallo.identity` ≥ 1.2 and the base tree ships the module runtime, emits `src/lib/capabilities/composed/identity.js` (the configured controller) and the public application facade `src/lib/app/index.js` + `src/lib/app/identity.js` (`useSession`, `useSignIn`, `useSignUp`, `useSignOut`, `usePasswordReset`, `useConfirmReset`, `useSessionGuard`, `THRALLO_APP_ABI`). The lock file moved into the same rendering path.
- **Registry**: `thrallo.identity@1.2.0` registered beside 1.1.0 (old locks still resolve their exact version); new protected artefacts hashed into the lock.
- **Write guard**: `src/lib/modules/` and `src/lib/app/` protected; orchestrator refresh seam includes `modules/`. Ledger records `CURRENT_PROTECTED_PATH_SOURCES` / `CURRENT_RUNTIME_REFRESH_PATTERN`.
- **ABI lint** `platformModules/abiLint.mjs`, wired into module conformance: generated code importing `lib/backend`, `lib/visitorSession` or `lib/modules` is `private_platform_import` (blocking) on a locked tree and `private_platform_import_legacy` (advisory) on a legacy tree; direct `auth.*`/`ensureVisitorSession()` orchestration beside an installed identity module is `generated_session_orchestration` (advisory — the browser decides).

## Compatibility

- The legacy session capability (`ensureSession`, `currentUser`, `signIn`, …) keeps every export and byte; it is the adapter the audit asked to preserve.
- Retained foundation trees (no module runtime) compose exactly as before: no identity or facade files, plan reflects what was composed.
- Verification identity/verifier untouched; the plan's probes are the deterministic contract the browser layer binds to in later packages.

## Tests

`builder-v2-identity-module.test.mjs` (8): state walk (sign up/in/out, reset, failed sign-in changes nothing, no credential in state), reload keeps the canonical principal + expiry/recover + backend error state, visitor never satisfies member + visitor mode re-establishes after sign-out, plan derivation, registry 1.2.0 beside 1.1.0 + lock hashes the new runtime + tampering detected + legacy exports unchanged + protected paths, composer output byte-stable + retained trees unchanged, UI binding through the shipped hooks rendered with the scaffold's React across every state, ABI lint positive/negative through the conformance validator.

## ABI enforcement note

`ABI_ENFORCEMENT = { modules: "block", backend: "warn", visitorSession: "warn" }`: importing `src/lib/modules/*` (never a taught surface) blocks on a locked tree; importing the backend SDK or the visitor session — still what the generation prompt teaches — is reported as `private_platform_import_legacy` until WP14 re-teaches the public facade and flips `backend` to block. Lock verification runs only when the composer actually installed the module runtime (a legacy base tree composes nothing and is not judged against the lock).

Regression: 108 deterministic Builder V2 suites, 1301 tests, green after two expectation updates (typed operations carry owner/output; lock verification skipped on legacy base trees).
