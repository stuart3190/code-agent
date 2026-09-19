# C8 current publish execution map

Baseline: `f2e059bf47a27c3c1be1ebf2b5b8c795644377fd` on `remediation/builder-v2-production`.
This map was completed before C8 implementation. No production service, database, flag, or
filesystem was changed while collecting it.

## Entry points

| Surface | Entry | Current work |
| --- | --- | --- |
| Legacy HTTP publish (Builder V1/Android) | `shell/server/routes/publish.mjs` `materializeAndPublish` | Claims/moves `published_sites`, packages through C7 when enabled (otherwise compiles in shell), sends a base64 file map to provisiond `/publish`, then separately records legacy release/environment state. |
| Conversational publish/republish | `shell/server/lib/appBuild/appPublishService.mjs` `publishApp` | Opens a `deployments` row, claims and sometimes transfers the live site row before packaging, sends files to provisiond `/publish`, separately upserts `published_sites`, then separately supersedes/promotes deployment rows. |
| Android republish | `shell/server/lib/android.mjs` | Calls legacy `materializeAndPublish` after injecting `assetlinks.json`. |
| Environment promote/rollback (legacy surface) | `shell/server/lib/environments.mjs` | Reads stored source and calls `materializeAndPublish`, therefore rebuilds. These tables are a carried Buildr101 surface and are not part of current Thrallo production schema. |
| Deployment rollback | `shell/server/routes/deployments.mjs` -> `rollbackToDeployment` | Reads retained `source_tree`, opens a new deployment, reinjects runtime config, recompiles/repackages, and overwrites the live slug through `/publish`. |
| Unpublish | `routes/publishState.mjs` -> `unpublishApp`; legacy `routes/publish.mjs`; project teardown | Calls provisiond `/unpublish`, which recursively deletes the slug directory, then separately stamps the database and detaches domains. |
| Custom domains | `lib/customDomains.mjs`, `routes/customDomains.mjs`, legacy `routes/domains.mjs` | Domain identity is a DB row. After verification provisiond creates `/publish/_domains/<host> -> ../<slug>`. DNS/certificate state is independent of release bytes. |
| Status/update available | `lib/publishState.mjs`, `shared/publishResolution.mjs` | Derives live/update state from `published_sites`, project timestamps, and the newest/live `deployments` row. |

## Packaging and serving

C7's `publish_package` job compiles inside the build worker and writes `dist` beneath the durable
worker artifact root. `publishBuildWorker.mjs` currently reads that directory back into a base64
file map. With `THRALLO_BUILD_WORKER_ENABLED` disabled, both publish paths retain their original
in-shell fallback. The activation redesign must consume worker output only when both independent
dark flags are enabled; it must not enable C7.

Provisiond `publishSite` writes `<publish>/<slug>.tmp`, removes `<publish>/<slug>` recursively,
then renames the temporary directory into place. Caddy serves Thrallo and Buildr subdomains from
`/publish/<slug>` and custom domains from `/publish/_domains/<host>`. The custom-domain symlink
targets `../<slug>`, so keeping the slug as the stable site pointer preserves DNS and certificates.

## Database state

- `published_sites` is the mutable site identity and slug claim. It has no active artifact pointer
  or activation version.
- `deployments` is history plus a status marker and retained source. `markLive` retires the old
  live row and promotes the new row using several independent PostgREST writes.
- There is no durable activation intent/outbox, no filesystem observation, and no CAS generation.
- Existing one-live partial indexes constrain only database rows; they cannot reconcile the bytes
  Caddy is actually serving.

## Exact failure windows

1. A crash after `rm(<publish>/<slug>)` and before `rename(tmp, slug)` makes the live site disappear.
2. A write/decode failure can leave staging debris; no durable DB row identifies or retries it.
3. A conversational rebuild transfers `published_sites.project_id` before the artifact is built or
   verified, so ownership/state can point at a release that never becomes ready.
4. A provisiond success followed by `published_sites` failure serves new bytes while the DB still
   describes the old site/project.
5. A `published_sites` success followed by `markLive` failure serves new bytes while deployment
   history still marks the old release live.
6. `markLive` retires the old deployment before promoting the replacement; failure between those
   writes leaves no live deployment row.
7. A successful filesystem unpublish followed by a DB update failure returns a partially repaired
   state: the site is offline while `published_sites` can remain live.
8. Domain detach is best effort after unpublish, so domain state can claim active while its target
   was deleted (or detach can succeed while DB state remains live).
9. Rollback recompiles source. Dependency/toolchain drift can make a previously good release
   impossible to restore, and rebuilt bytes need not equal the bytes originally served.
10. Concurrent publishes share mutable slug state and have no pointer CAS. In-flight joining lowers
    the probability but does not protect separate legacy/conversation writers or stale completion.
11. Cleanup/deletion removes the live directory itself; there is no retained immutable rollback
    artifact and no reference-aware release GC.
12. Caddy sees a mutable directory, so a request spanning replacement can observe missing or mixed
    content instead of one complete release.

## C8 boundary

Builder V1 stays on the mapped implementation while `THRALLO_ATOMIC_PUBLISH_ENABLED` is false.
C8 adds a side-by-side release finalisation and activation seam. It does not change build routing,
Builder V2 routing, managed settlement, shadow state, Stripe, or production migrations.
