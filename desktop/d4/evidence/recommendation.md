# D4 recommendation

## Decision

**Daytona conditionally suitable for the next prototype stage.**

Daytona is suitable enough to continue because live synthetic evidence confirmed fast container creation/start, filesystem persistence, archive/restore, volume persistence, experimental snapshot replacement, a reconnectable/resizable PTY, multi-port signed previews with expiry, Playwright/Chromium, distinct workspace namespaces, cgroup memory enforcement, region selection, and deterministic cleanup.

It is not yet suitable for production or D5 integration. The next prototype must first close these blockers:

1. Produce a reproducible pinned Code OSS web/server artifact. D4 fetched the exact source pin but the clean checkout could not start `code-web.sh` without its dependency/build/package pipeline, and no web Thrallo extension artifact exists.
2. Benchmark the real artifact on explicit 2/4 and 4/8 CPU/RAM classes. The lower-bound workload used about 750MiB of a 1GiB container without Code OSS.
3. Prove the Thrallo PTY and preview gateways, account-to-workspace authorization, token revocation, WebSocket backpressure, audit, and recovery. Direct vendor links/APIs are not the customer security boundary.
4. Obtain enforceable egress, process, runtime, bandwidth, and abuse controls. The tested organization tier would not allow per-sandbox network override and exposed an unsuitable `pids.max` for hostile workloads.
5. Resolve vendor durability, experimental snapshot API, regional placement, usage export, and billing questions before a commercial model.

The raw launch samples satisfy the provisional numeric targets, but sample counts are too small for p95 and do not include Code OSS readiness. These targets therefore remain unproven.

## Fallback comparison

| Approach | Evidence-based fit | Main trade-off |
|---|---|---|
| Daytona | Best next prototype: required primitives already work and cleanup is fast. | Vendor/tier controls, artifact packaging, and per-workspace economics remain unresolved. |
| Self-managed Kubernetes pods/PVCs | Preferred fallback if Daytona cannot provide egress/abuse/isolation guarantees or economical larger classes. | Maximum control, but substantially more control-plane, node isolation, storage, gateway, patching, and on-call burden. |
| Shared multi-tenant Code OSS | Not recommended for untrusted customer code. | Lower cost, but shared process/file/terminal failure domains conflict with the required security boundary. |
| Streamed VM/remote desktop | Defer; only reconsider if a real browser/GUI OS becomes essential. | Stronger OS boundary and full GUI, but higher cold latency, bandwidth, GPU/streaming, and operating cost. |

## Go/no-go condition for Kubernetes evaluation

Move to a Kubernetes evaluation if the next bounded prototype cannot (a) run the pinned Thrallo workbench within target latency on a priced class, (b) enforce outbound/process/runtime controls, (c) support an independently reviewed Thrallo gateway without bearer-link leakage, or (d) obtain acceptable durability and usage-export guarantees.
