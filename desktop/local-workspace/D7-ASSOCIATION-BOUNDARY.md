# D7 canonical association boundary

D8 deliberately stops at a local import review. A local folder remains owned by the user and is neither uploaded nor made canonical by opening, inspecting, previewing, or reviewing it.

The later association sequence is fixed as:

1. The user explicitly requests Thrallo association.
2. The desktop obtains the approved D7 capability and authoritative project contract.
3. The user reviews included files, ignored files, sensitive exclusions, size, framework and Git state.
4. D7 creates a Builder-V2-backed working set through the frozen provider adapter.
5. The desktop performs verified synchronization and reports conflicts explicitly.

Until that provider exists, `future_thrallo_project` returns `capability_unavailable` with `integration_pending`. `future_cloud_workspace` behaves the same way. There is no implicit retry, production origin, upload transport, mutation fallback, or association inferred from a local path.

Still unresolved for D7 are canonical identity allocation, snapshot and working-set formats, conflict semantics, file-size and repository limits, sensitive-file override policy, transactional upload behavior, recovery after a partial transfer, and authoritative Builder V2 validation. D8 does not guess these contracts.
