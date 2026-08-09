# `@thrallo/client`

Host-neutral client plumbing for the native and future cloud Code OSS workbenches. The package has
no UI dependency and does not import Builder V2, production routes, Supabase, or Buildr101 code.

Version `0.1.0` implements the D1 boundary:

- request/response envelopes, host-supplied authentication, request IDs, cancellation and bounded
  safe retries;
- typed and redacted errors;
- capability negotiation and explicit `capability_unavailable` results;
- SSE parsing plus cursor-aware reconnect;
- explicit interfaces for all ten D0 provider families;
- deterministic, call-recording fixture providers with no network fallback;
- an opt-in stable read-only adapter whose route map and transport must be supplied by its host.

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
