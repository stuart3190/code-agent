# D4 Daytona feasibility spike

D4 is an isolated, disposable infrastructure experiment. It does not implement a workspace control plane, customer launch flow, gateway, synchronization, database schema, production route, or desktop UI.

The live harness requires host-injected Daytona credentials and the explicit `--confirm-synthetic` switch. It creates only `thrallo-d4-*` resources with synthetic-only labels, records no preview URL or token, and cleans resources in reverse order. Deterministic tests do not use the network.

Evidence is under `evidence/`. The decision is **Daytona conditionally suitable for the next prototype stage**, subject to the blockers in `evidence/recommendation.md`.

The live command is deliberately not part of the test suite:

```powershell
npm run spike:desktop:d4
```

It must only be run with an explicitly injected Daytona control credential in an approved non-customer experiment. D4 tests are:

```powershell
npm run test:desktop:d4
```
