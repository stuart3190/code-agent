# Builder V2 shadow window restart — 2026-08-07

## Boundary and invalidation

- Authoritative database timestamp: `2026-08-07T20:51:22.594832Z`.
- Earliest completion: `2026-08-14T20:51:22.594832Z`.
- Production state key: `bv2.shadow.window`, status `observing`, validator
  `full-graph-v1`, implementation `c4-atomic-graph-full-shadow`.
- The previous `2026-08-06T10:41:16.165Z` boundary is retained under `previousWindows` as
  `invalid_pre_remediation` with reason codes `non_atomic_graph_persistence`,
  `incomplete_graph_parity_validation`, and `superseded_by_c4`.
- The old append log and timer/service definitions are checksummed under
  `/home/ubuntu/thrallo-deploy-evidence/2026-08-07-shadow-week-restart/pre-remediation`.

## Timer proof

The persistent `bv2-drift.timer` runs daily at `09:00:00 UTC`. Production disposable-owner proof:

| Case | Result |
|---|---|
| complete two-file graph (2 symbols, 1 ref, 1 edge) | exit 0; full-parity CLEAN |
| one symbol removed after the run was pinned | exit 1; persisted integrity, symbol, reference and caller drift recorded |
| zero-hour age threshold against the disposable run | exit 1; `stale_shadow_run` recorded |
| pinned run removed while migration state remained | exit 1; `missing_shadow_run` recorded |
| cleanup/no post-window build | exit 0; expected 0, checked 0, all unhealthy counts 0 |

The failing systemd invocations exposed `Result=exit-code` and `ExecMainStatus=1`; exact JSON is in
the append log copied into the evidence directory. The proof owner, project, build, revisions,
symbols, refs, edges, runs, checks and auth identity were removed afterward. This proof made no
model or Stripe call and did not touch a customer project.

## Acceptance status

The window is observing. No natural V1 completion occurred after the boundary during the restart,
so the first real atomic/CLEAN shadow record is pending normal traffic. Customer Builder V2,
customer worker dispatch and atomic publishing remain disabled; managed settlement remains paused.
