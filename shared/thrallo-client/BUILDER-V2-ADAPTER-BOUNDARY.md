# Builder V2 adapter boundary

There is intentionally no Builder V2 provider in D1. The public provider methods remain narrow,
capability-gated, and endpoint-agnostic until the D0 release conditions are satisfied.

The following wire and persistence questions remain owned by
`desktop/d0/builder-v2-boundary.json` and must not be guessed by desktop foundation work:

- canonical green-snapshot identity, lineage, version and publishability fields;
- working-set creation, checkpoint, optimistic base comparison, conflict and verified-apply shapes;
- build, repair and verification event vocabulary, cursors, terminal states and resumability;
- the durable relationship between plan decisions, conversations, runs and approval audit events;
- concurrent agent checkpoint/branch ownership and verified merge semantics;
- preview identity and its binding to a working set, build and canonical snapshot;
- immutable release source identity for publish, update, rollback and unpublish;
- project environment, secret, database and integration mutation boundaries.

Until Packages 14R and 15 are accepted and these contracts are frozen:

- fixture adapters may simulate the provider interface entirely in memory;
- stable adapters may expose explicitly mapped read-only operations;
- every unsupported mutation returns `capability_unavailable`;
- no adapter may infer routes, tables, migration shapes, publication source, or fallback behavior.
