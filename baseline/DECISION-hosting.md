# DECISION — Hosting: runtime host, publish model, per-app data

_Recorded 2026-07-01. A **decision record**, not a build — no code shipped, no proven layer touched.
Resolves the three coupled hosting questions that gate the `provisiond` build (the very next session)
and the deferred `PREVIEW_MODE=vps` / `publishStub.js` seams from Phase 5._

## The unlocking insight (why the three questions decouple)

Generated apps are **Vite+React SPAs whose entire backend is the Phase 3 Supabase SDK**
(`auth`/`db`/`storage`). A *published* app is therefore **static bundle + Supabase** and needs **no
container at all**. Containers are a **preview-only** concern (live Vite dev server + HMR); publish is
a **static-hosting** concern. This is why `provisiond` can be built now as a preview-only orchestrator
and will **not** be rebuilt when publish ships — publish does not go through it.

---

## Decision 1 — Runtime host: **bare OVH Docker, `provisiond` = PREVIEW-ONLY** ✅ DECIDED

`provisiond` targets the **proven bare OVH box** (51.195.136.189, 4 vCPU / 7.6 GB, `RUNTIME.md`) as a
**preview-only container orchestrator**. Preview and publish are **deliberately split** — different
targets by nature (ephemeral HMR containers vs. static assets), even if both physically sit on the
same OVH box at first.

**Why (ranked):**
1. Proven + cheap + owned ops; the billing model already prices runtime against this exact box
   (`£13/mo` assumed, 55 slots, `£0.236/slot-mo`, `docker stop` reaper → near-zero idle).
2. A long-lived Vite **HMR dev server is precisely what managed scale-to-zero is bad at**, so a managed
   container platform buys little for preview and adds cost + lock-in.
3. Serving publish as containers on the same host was rejected — it reintroduces the always-on idle
   cost cliff.

**Rejected:** managed scale-to-zero platform (revisit only if one box can't hold preview concurrency —
more likely add a second OVH box than change model); same-host-both-as-containers (cost cliff by
construction).

## Decision 2 — Published-app hosting: **static export + shared Supabase** ✅ DECIDED

Publish = `npm run build` the project tree → serve the static `dist/` (SPA) → point a subdomain at it.
Backend stays the **Supabase SDK** (no per-app server runtime). Idle cost ≈ £0 — the documented cost
cliff is solved because static assets cost nothing at rest.

- **Physical static host: OVH nginx now**; move to object-store + CDN (Cloudflare R2/Pages or
  S3/CloudFront) when scale demands. This is a deferrable *staging*, not a fork in the model — the
  publish output (a `dist/` dir) is identical either way. **CDN/object-store pricing = needs-verification**
  before that move; it does **not** gate anything now.
- **Two known-trivial wrinkles:** (a) SPA client-side routing needs an nginx catch-all rewrite to
  `index.html`; (b) `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are baked at build (already the
  reactVite scaffold's model).
- **Escape hatch kept:** export / BYO-deploy (hand the user the code) stays available as a secondary
  option, not the default.

**Rejected:** container-per-app always-on (idle RAM cliff); scale-to-zero shared server runtime
(unneeded while the SDK covers the backend — revisit only if generated apps ever need server-side code).

## Decision 3 — Per-app end-user data layer: **DEFERRED to the publish session (lean recorded)** ⏸

**Deferred deliberately** — not forced now. `provisiond` is preview-only and preview already runs on
the **shared Supabase project** (`qgemqjcyhuejrsvjxkbh`) with the proven Phase 3.1 per-end-user RLS
(`owner = auth.uid()`). The per-app *end-user* data layer only becomes forcing at **publish** time
(real external users on a published app), and publish is itself a later session.

**Lean to build toward (not locked):** shared Supabase project + an **`app_id` namespace dimension**
on `entities` (extend the Phase 3.1 RLS to composite owner+app scope) as the scalable default;
**project-per-app** reserved as an isolation escape hatch for apps needing hard isolation or their own
auth branding.

**Open tension to resolve in the publish session:** a shared project means **one shared `auth.users`
pool across all published apps** (platform-SSO feel). Accept that, or go project-per-app — the latter
hits Supabase management-API / project-quota + ops ceilings at scale (**needs-verification**).

**The one hard rule forced NOW (binds D2):** publish / static-export must treat **"which Supabase
backend" as a parameter** (URL + anon key injected at build), never hardcode the single preview
project — so either data model drops in later with **no rebuild**.

---

## What `provisiond` builds against (concrete hand-off for the next session)

- **Host:** the OVH box in `RUNTIME.md`. Root Docker + the proven hardening flags (`--cap-drop ALL`,
  `--no-new-privileges`, `--user node`, `--memory 512m`, `--cpus 1.0`, `--pids-limit 200`,
  `--tmpfs /tmp`). Per-project `--internal` bridge net; **per-project nginx** (closes the spike's
  shared-nginx Host-header pivot gap). Reaper: `docker stop` after ~10 min idle; buffer + retry the
  first request on cold start (~3–5 s).
- **Scope:** **preview only.** Publish does NOT call `provisiond`.
- **Seam it implements:** the Phase 5 `PreviewProvider` interface already stubbed at
  `shell/server/preview/index.mjs` (`localVite` REAL | `vpsProvision` STUB). `provisiond` is the real
  `vpsProvision` backing. Expected shape (matches the existing seam):
  - `provision({ projectId, tree }) -> { previewUrl, previewRef }` — materialize the tree into a
    container, return the proxied subdomain URL (`<proj>.<hex>.nip.io` pattern from `RUNTIME.md`).
  - `update({ previewRef, tree })` — push an edited tree into the running container (HMR picks it up).
  - `stop({ previewRef })` / idle-reap — free the slot.
  - capacity cap = `available_ram / 118 MiB` (≈ 55 on the current box); BYOK free = 3 concurrent slots
    (`PHASE-4-BILLING.md`).
- **What publish will build against later (NOT this session):** a static pipeline — `buildTree` →
  `dist/` → static host (OVH nginx first) + subdomain, with the Supabase backend target passed as a
  build-time parameter per Decision 3's hard rule.

## Status of the deferred seams after this decision
- `PREVIEW_MODE=vps` stub → will be replaced by `provisiond` (D1), next session.
- `publishStub.js` → will be replaced by the static-export pipeline (D2), its own later session; its
  data layer follows D3 (deferred, parameterized backend).

## Needs-verification (flagged, none gates a decided path)
1. Managed-container platform pricing/capability — only relevant if D1 is ever revisited.
2. CDN / object-store pricing — only relevant when D2's static host moves off OVH nginx at scale.
3. Supabase project-per-app quotas + management-API limits — only relevant if D3 lands on project-per-app.
