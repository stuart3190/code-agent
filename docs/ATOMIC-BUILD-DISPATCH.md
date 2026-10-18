# Atomic Builder V2 dispatch

The public build row and durable work payload previously committed in separate calls. A shell crash between them left a queued public build with no work ID; the project uniqueness constraint blocked another build, and cancellation returned `work unavailable`.

`build_pipeline_dispatch` creates both records in one transaction. A project-scoped advisory lock serializes concurrent new callers, and the active-project unique index preserves compatibility with older callers during rollout. Queue failures roll back the public row and payload. Retrying a lost response returns the committed authority. The caller does not mark a potentially executing job failed on transport uncertainty.

## Rollout

1. Confirm the new function is absent, record the migration ledger, and check for stale queued/running public builds without work IDs. Investigate any existing orphan separately; this migration does not rewrite legacy jobs.
2. Replay the migration against the complete schema. Run `ATOMIC_DISPATCH_PROOF=1 ATOMIC_DISPATCH_CONTAINER=<isolated-network-none-proof-container> node ops/prove-atomic-build-dispatch.mjs` and the atomic caller/entry/approval/worker tests. The proof refuses networked or port-published containers and uses synthetic identities.
3. Apply the additive migration before deploying its caller. Only the service role may execute the new function. Confirm browser-role denial and record the actual applied migration version.
4. Deploy the immutable source using the normal idle-worker gate. Prefer `THRALLO_PREBUILT_SANDBOX_IMAGE=sha256:<qualified-digest>` with image mode: the release script verifies the target commit, baked manifest and actual runtime bytes before reusing the image. It also serializes releases with a host lock.
5. Check worker admission, production health, and a representative own retained build through the normal queue. Verify source/contract lineage, result, and credit accounting. Retained builds are not fresh-generation success measurements.

## Rollback

Roll back the caller to the previous qualified release through the normal deployment process. Leave the unused additive RPC in place; do not delete public builds, queued work, payloads, or customer records. The original queue RPC remains unchanged. Do not drop the new function while any deployed caller still uses it.

A lost dispatch response must preserve the project and consumed approval when a durable job exists. The existing entry cleanup checks durable build existence before deleting an empty project or reopening approval; the atomic transaction preserves that guard.
