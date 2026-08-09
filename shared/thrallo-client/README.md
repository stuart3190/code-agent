# `@thrallo/client`

Host-neutral client plumbing for the native and future cloud Code OSS workbenches. The package has
no UI dependency and does not import Builder V2, production routes, Supabase, or Buildr101 code.

Version `0.3.0` preserves the D1 provider and D2 authentication boundaries and adds the D3
desktop account/access presentation foundation:

- request/response envelopes, host-supplied authentication, request IDs, cancellation and bounded
  safe retries;
- typed and redacted errors;
- capability negotiation and explicit `capability_unavailable` results;
- SSE parsing plus cursor-aware reconnect;
- explicit interfaces for all ten D0 provider families;
- deterministic, call-recording fixture providers with no network fallback;
- an opt-in stable read-only adapter whose route map and transport must be supplied by its host.
- a deterministic native authentication state machine with system-browser/PKCE and strict
  `thrallo://auth/callback` correlation;
- a native secure-store abstraction plus a memory-only deterministic development vault;
- opaque, rotating device sessions and a deterministic authorization provider with no network;
- an explicit preferred browser-auth mode while retaining manual PAT compatibility as
  `legacy_manual_pat`.
- account, resource-entitlement, usage/budget and launch-decision models composed from D1 host
  capabilities and D2 session state;
- deterministic account/access fixtures covering billing recovery, suspension, unknown/stale
  data, limits and unavailable desktop/cloud capabilities;
- an allowlisted, token-free portal handoff owned by an injected system-browser host;
- an opt-in stable read-only account adapter with no origin, route map or mutation fallback.

The package deliberately does not contain a Builder V2 adapter. Future adapters must conform to
the same provider suite and can be added after Packages 14R and 15 and the relevant contracts are
frozen. The deliberately unresolved shapes are recorded in
`BUILDER-V2-ADAPTER-BOUNDARY.md` and remain owned by the D0 boundary manifest.

```js
import { createFixtureProviderSuite } from "@thrallo/client/fixtures";

const suite = createFixtureProviderSuite({ scenario: "waiting-approval" });
const plan = await suite.plans.getPlan({ planId: "fixture-plan-0001" });
```

Fixture providers never read environment configuration and never contact a live API. Enabling a
host capability only enables a deterministic in-memory simulation; it does not install a hidden
network or production mutation path.

The production authorization-server shape remains deliberately unresolved in
`AUTH-SERVER-BOUNDARY.md`. D2 does not add routes, protocol registration, plaintext credential
storage, production token formats, or a live authentication fallback.

D3 does not reproduce portal billing, mutate subscriptions, provision cloud workspaces, or mount
production routes. Existing read contracts and deliberately unresolved translations are recorded
in `ACCESS-SERVER-BOUNDARY.md`.
