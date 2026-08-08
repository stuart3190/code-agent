# Package 10E — 67-migration backup/runtime schema gate

Status: implementation and local deterministic proof complete; production backup/restore and dark
composition evidence are appended only after each gate passes.

## Authoritative production baseline

- Project: `zczgvcsokfafuyognvwx`
- Ledger count: 67
- Last migration: `20260807221000_bv2_runtime_composition`
- Pending migrations: zero
- Canonical public tables: 83
- Sorted table-name SHA-256:
  `aa975762e8d4c9dac1bb4da3f25c385025876ef541f5e3637c35b7148b451d73`
- Distinct public-to-public FK table pairs: 83
- Sorted `child->parent` FK-pair SHA-256:
  `2b9a0e622e191ace556179b2d6837ed158e6f5fa42b65ce3664a68f8fd3b3bc2`

The table and FK evidence was captured read-only from the connected Supabase production catalog
on 2026-08-08. `bv2_model_reservations` was empty and no V2 composition lifecycle was active.

## Tooling invariants

1. A backup enumerates the live public catalog through `thrallo_public_tables()` before exporting
   data and fails on any live table missing from its manifest.
2. `bv2_model_reservations` is canonical recovery data and restores only after `projects` and
   `bv2_builds`.
3. The restore order is checked against all 83 current public FK dependencies. Nullable cyclic or
   forward references are restored as null and patched only after their parents exist; constraints
   remain active throughout.
4. `bv2_builds.project_id_text` and `diag_runs.project_id_text` are generated values. Backup and
   restore canonicalisation omits them from authoritative writes, then the isolated verifier proves
   PostgreSQL regenerated `project_id::text` exactly.
5. Runtime proof validates reservation identities and state, V2/public-build links, diagnostic
   links, and project/green-snapshot links after restore.

## Migration evidence rows 66–67

| Order | Version | Name | Stored production identity SHA-256 | Local source SHA-256 |
| ---: | --- | --- | --- | --- |
| 66 | `20260807213500` | `bv2_runtime_model_reservations` | `8d068fdbf23238d3fe99c03749fb282a944f6f49927d675671ab938585f5a1b5` | `71162d0be0c66c687ea28530b2dfd95b5e9c25ddd317b570122b333fe8e1b5b4` |
| 67 | `20260807221000` | `bv2_runtime_composition` | `f7658a77b1916722d54e0ffd76d3e1601f5c2d3906ce7a53d30ab74edcd45e15` | `94fbf975ef034cecafe88e9927b6d5aa74dbccb54d098b45387d57120d636016` |

The append-only overlay is
`docs/evidence/migration-reconstruction/2026-08-08/applied-history-overlay.json`; earlier evidence
was not edited.

## Local proof

- Backup/restore focused tests: 27/27 passed.
- Migration history: 60 authoritative base + 7 append-only overlay rows = 67 applied, 67 active,
  zero pending, zero duplicate versions.
- Restore dependency proof: 83/83 FK pairs accounted for, zero unhandled ordering violations.
- Generated-column proof: generated fields absent from authoritative writes; correct regenerated
  values accepted and drift rejected.

## Production gate record

The first post-deployment backup completed and validated its data, but systemd correctly surfaced
a failing `ExecStartPost` drift check. The deployed teardown manifest predated the explicit
`bv2_model_reservations` entry, while the installed schema already guarantees erasure through the
`projects -> bv2_builds -> bv2_model_reservations` `ON DELETE CASCADE` chain. Package 10E records
that database-enforced cascade in the backup drift guard; it does not deploy or activate the V2
composition.

To be completed after backup-tool-only deployment:

- deployed tooling commit/hash:
- live catalog coverage:
- new backup path/manifest hash/counts:
- isolated restore start/end and parity:
- external probe result:
- dark V2 composition deployment and artifact hashes (only if restore is green):
- zero-model canary and cleanup parity:

## Canary recovery status

The backup/restore gate and dark composition deployment passed, but Package 10E remains incomplete.
The scoped recovery on 2026-08-08 stopped before mutation because the production Supabase Data API
was returning broad 504 connection-pool failures. Full evidence, zero-residue proof, and the
credential-rotation prerequisite are recorded in `PACKAGE-10E-CANARY-RECOVERY.md`.
