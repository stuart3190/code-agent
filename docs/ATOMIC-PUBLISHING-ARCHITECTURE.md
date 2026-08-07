# Atomic publishing architecture

C8 is a side-by-side publishing path controlled by `THRALLO_ATOMIC_PUBLISH_ENABLED`. The shell
flag defaults off. Builder V1 therefore keeps the pre-C8 path until an explicit cutover; Builder V2
selection, the C7 build-worker flag, managed settlement, and shadow state are independent.

## Boundaries

1. The C7 worker performs production compilation/package work. The shell reads that completed
   output and applies the deterministic platform analytics envelope. Enabling the atomic publish
   flag without the worker flag fails closed before installation or compilation; there is no
   in-process build fallback on the atomic path.
2. Provisiond validates paths/base64/limits, recomputes the canonical manifest, checks `index.html`
   and every local asset reference through a loopback HTTP server, writes a private staging tree,
   renames it into `.thrallo/releases/<owner>/<project>/<release>`, changes files to `0444` and
   directories to `0555`, and re-hashes the stored bytes.
3. `register_verified_publish_release` records only that verified immutable identity. Artifact
   fields are protected by a trigger after verification.
4. `request_publish_activation` locks the site, checks ownership/health and compares
   `activation_version`, then commits a durable outbox intent. It does not transfer the site row.
5. Provisiond serializes the site, atomically renames a temporary symlink over
   `.thrallo/sites/<slug>/current`, and returns the observed release id.
6. The shell re-hashes and health-checks the now-routed immutable release, records that observation,
   and `complete_publish_activation` atomically moves the site, domain and deployment state. A
   failed post-switch proof restores the verified previous pointer before recording rollback. A
   lost completion acknowledgement is resolved by reading the durable intent before retrying.

Caddy resolves `*.app.thrallo.com` through the stable `current` pointer. A custom-domain symlink
also targets that same pointer. Release activation changes neither DNS nor certificate storage.

## State and invariants

- `publish_releases` is immutable content plus mutable health/activation lifecycle.
- `publish_activation_intents` is the durable activation, rollback, or unpublish outbox.
- `published_sites.activation_version` is the CAS token; stale writers lose.
- One partial index permits one active release per site. Another permits one unfinished intent.
- Authenticated and anonymous roles have neither table nor RPC access. Every RPC checks
  `service_role`; registration also proves `projects.owner`.
- Site/project transfer occurs only in the completion transaction, after health and pointer proof.
- A deployment rollback activates a retained release id. It never reads source, installs packages,
  compiles, regenerates assets, calls a provider, or mutates the release bytes.

## Existing-site adoption

Legacy live directories cannot be overwritten atomically, so C8 does not pretend they can be.
Before Caddy cutover, each live directory is copied and byte-hashed into a baseline immutable
release while the old Caddy root continues serving the original. Its stable site pointer and custom
domain links are created against byte-identical content, the database records the adoption, and only
then can Caddy reload to the new root. The legacy directory remains until post-cutover retention.

## Retention and backup

The active release is always retained. The newest five verified successful releases per site are
rollback candidates by default; failed releases are retained for 14 days. Cleanup receives the full
retained-id set and cannot remove any referenced id. Project erasure purges immutable release bytes
before deleting its release/intent rows.

`publish_releases` and `publish_activation_intents` are in database backup/restore order. The
existing `publish` filesystem root backup includes `.thrallo/releases`, `.thrallo/sites`, domain
links, and legacy baselines with byte hashes and modes. No backup format version changed.
