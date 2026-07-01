# PROVISIOND-PLAN — remote-driven container preview on the VPS

_Recorded 2026-07-01. An **approved build plan**, not code — the build is its own session. Governing
doc: `DECISION-hosting.md` (provisiond = preview-only, bare OVH Docker, per-project proxy, reaper).
Seam of record: `shell/server/preview/index.mjs`._

## Context

Phase 5 shipped the product shell with a **preview seam** already in place:
`provider.start/update/stop/get`. Two backings exist — `localVite` (real, on the EPYC box) and
`vpsProvision` (a no-op **stub**). `DECISION-hosting.md` decided the real backing runs as **Docker
containers on the OVH VPS** (`51.195.136.189`, 4 vCPU/7.6 GB), preview-only. `provisiond` is the
service that makes that stub real.

The runtime spike (`spike/`, `baseline/RUNTIME.md`) proved a lot **on the VPS via localhost**:
container isolation, per-project Docker nets, nginx→Vite HMR (WS 101 + inotify rebuild), 118 MiB/
container, ~55/box RAM-bound, `docker stop` reaper. What it did **not** prove — the un-retired risks
this plan centres on:
1. **Remote-driven provisioning** — the shell runs on the **EPYC box**, the containers on the **VPS**.
   The spike drove Docker locally; here the control plane is remote from the data plane.
2. **The public subdomain proxy + HMR over the wire** — a real browser, over the internet, holding a
   live HMR websocket through a TLS-terminating proxy. The spike used localhost `curl`.
3. **Dynamic tree injection** — the spike **baked** a fixed app into the image; real previews inject a
   generated tree into a running container.

### Locked design decisions (resolved with the user)
- **Control plane:** shell (EPYC) → **SSH tunnel** → `provisiond` bound to **127.0.0.1** on the VPS.
  No Docker-controlling API on the public internet; only 443 (preview) is public.
- **Data plane:** browser → **443** → **Caddy** (auto wildcard TLS) → app container's Vite `:5173`.
- **Preview domain/TLS:** `*.preview.<a-domain-you-control>` with Caddy/Let's Encrypt **DNS-01
  wildcard** auto-TLS. Required because the prod shell is HTTPS and the preview loads in an
  `<iframe src=previewUrl>` — http/ws would be mixed-content-blocked (`Builder.jsx:146`).

### Build-session prerequisites (no code; confirm before CP-1)
- A **domain + DNS-01 API credentials** for the wildcard cert.
- **SSH key** EPYC→VPS (control plane). Docker on the VPS is already proven.

---

## Architecture

```
EPYC (shell server)                         OVH VPS (51.195.136.189)
  previewProvider() = vpsProvision   ─ssh tunnel→  provisiond  (127.0.0.1:PORT)
   (thin HTTP client, real seam)                     │ docker create/cp/start/stop
                                                      ▼
browser ──https 443──►  Caddy (wildcard TLS, subdomain route, WS upgrade) ──► app container :5173
          <proj>.preview.<domain>                         per-project --internal net (no egress/peer)
```

- **provisiond** owns all Docker orchestration (reuses the spike's proven flags/topology). It never
  faces the public internet.
- **Caddy** replaces the spike's front-nginx: it does automatic **wildcard TLS** + subdomain routing +
  WS upgrade with far less config. **The proven `spike/nginx.conf` directives become the checklist
  Caddy must satisfy** — especially forwarding `Sec-WebSocket-Protocol: vite-hmr` (Vite 5 silently
  drops upgrades without it), `Upgrade/Connection`, long read timeout, and dynamic upstream
  resolution. Verified at CP-2; the nginx config is the fallback if Caddy mishandles the subprotocol.
- **Tree injection:** one **base image** with the reactVite scaffold deps **preinstalled**
  (`node_modules` baked, source NOT). `provision` = `docker create` → `docker cp <tree>` into `/app` →
  `docker start`; the entrypoint (generalized `spike/entrypoint.sh`) writes `vite.config.js` from env
  (`VITE_HOST`, `VITE_CLIENT_PORT=443`, `protocol wss`) then runs Vite. `update` = `docker cp` changed
  files → Vite inotify → HMR. No per-project `npm install` on the hot path.

---

## Risk-ordered checkpoints (each independently stoppable, highest variance first)

### CP-1 — Remote drive + dynamic tree injection · *the first provable slice*
The smallest thing that proves remote provisioning end-to-end.
- `provisiond` skeleton on VPS (127.0.0.1): `provision`, `update`, `stop`, `get`, `health`.
- Base image (scaffold deps preinstalled) + generalized entrypoint.
- `provision` = create+cp+start; per-project `--internal` net + spike isolation flags; Caddy routes
  subdomain→container (TLS can be minimal/staging here).
- Driven from EPYC over the SSH tunnel by a **standalone script** (the shell stays untouched).
- **Retires:** remote control plane + dynamic tree materialization + public subdomain serving.
- **Evidence:** remote `provision` returns `{id,url}`; `docker ps` on VPS shows it; GET the public
  subdomain from off-box → **200** serving the generated app.

### CP-2 — HMR over the wire + wildcard TLS · *highest-variance, longest "works except…" tail*
- Wildcard domain live; Caddy DNS-01 auto-TLS issuing `*.preview.<domain>`.
- **De-risk in two sub-steps:**
  - **2a (ws mechanics):** headless upgrade client (mirror the spike's node `http 'upgrade'` test) against
    the **public host** over http → **101** with `sec-websocket-protocol: vite-hmr`.
  - **2b (TLS + real browser):** load `https://<proj>.preview.<domain>` in a real browser →
    page renders, **wss** HMR connects (`VITE_CLIENT_PORT=443`, `protocol:"wss"`), and an
    `update` (docker cp a changed file) **live-updates without a full reload**.
- **Retires:** the single biggest risk — mixed content, wss through a TLS-terminating proxy, clientPort,
  vite-hmr subprotocol passthrough.

### CP-3 — Lifecycle: reaper, cold-start, capacity
The behavior the billing model already assumes (`PHASE-4-BILLING.md`: `docker stop` reaper, 55-slot cap).
- Idle tracking (Caddy access log or a container `/ping`) → `docker stop` after ~10 min → **RAM
  reclaimed** (`docker stats` proves it).
- Next request → `provisiond` restarts the container, **buffers/retries** until Vite is ready (~3–5 s)
  → 200. `provision` idempotent (re-provision same id = restart — matches the seam's idempotent `start`).
- Capacity guard: refuse past `available_ram / 118 MiB` (~55). Orphan cleanup on boot.

### CP-4 — Isolation hardening to decision spec · *deferrable to a follow-up*
Bounded, documented risk (preview runs the user's own generated code).
- Close the shared-proxy **Host-header pivot** gap (`RUNTIME.md` §4) per `DECISION-hosting.md` —
  per-project proxy **or** request-auth between Caddy and containers.
- Re-run the spike's five isolation assertions (no host FS, no egress, no peer reach, `CapBnd=0`,
  non-root) under provisiond-managed containers. Optional: rootless Docker.

### CP-5 — Shell flip · *the one-line switch (last)*
- Replace `createVpsProvisionStub` with `createVpsProvision`: a thin HTTP client conforming **exactly**
  to `start/update/stop/get → {url,id,mode}` (the real seam — see gap #1), calling provisiond over the
  tunnel. Additive to the existing `PREVIEW_MODE` branch; **the only edit to the shell.**
- New env: `PROVISIOND_URL` (tunnel localhost:port), `PROVISIOND_TOKEN` (defense-in-depth),
  `PREVIEW_PUBLIC_SUFFIX=preview.<domain>`.
- **Flip:** `PREVIEW_MODE=vps`. Re-run `shell/harness/prove-shell.mjs` with it set.

**First provable slice = CP-1. Deferrable to a follow-up = CP-4** (keep CP-3 — the cost model depends
on the reaper).

---

## The proof shape (define evidence before code)

New harness `provisiond/prove-provisiond.mjs`, styled on `runtime-spike.mjs` (PASS/FAIL per assertion),
run from EPYC over the tunnel. Mirrors every prior phase's live proof:

| step | evidence |
|---|---|
| REMOTE PROVISION | `provision {projectId, tree}` → `{id,url,mode:"vps"}`; VPS `docker ps` shows the container |
| PUBLIC SERVE | GET `url` from the public internet → **200** + generated-app marker in body |
| HMR WIRE | `update {changedFiles}` → within N s Vite log `hmr update` **and** a wss client on the public host gets **101** + the update frame; a real-browser check documented |
| REAPER | force idle → container `stop` (`docker stats` shows RAM reclaimed) → next GET cold-starts → **200** (buffered) |
| ISOLATION (CP-4) | spike's five assertions green under provisiond containers |
| CLEANUP | `stop`+`rm` container/net; VPS back to baseline |

---

## Under-specified in `DECISION-hosting.md`'s hand-off (caught during planning)

1. **Seam shape mismatch.** The doc says `provision/update/stop → {previewUrl, previewRef}`; the **real**
   seam is `start/update/stop/get → {url,id,mode}`, and `update()` is called **in-process by
   `generate.mjs:98`** (no browser-facing PATCH — the "PATCH /preview/:id" framing doesn't exist).
   **Build the shell client to the real seam;** keep provisiond's own HTTP verbs internal.
2. **Tree injection unspecified** (spike baked the app). Plan: base image + `docker cp`. **Assumption to
   verify:** generated trees use only the fixed scaffold deps. `makeFileTools` *can* let the model rewrite
   `package.json`; if deps drift, provisiond needs an `npm install` fallback (slower cold start). Verify
   against the engine/scaffold before relying on the baked base image.
3. **TLS/domain absent** from the hand-off but required (mixed content). Resolved: wildcard domain +
   auto-TLS. New external prereq: a domain + DNS-01 creds.
4. **Control-plane transport absent.** Resolved: SSH tunnel, provisiond binds 127.0.0.1.
5. **"Per-project nginx" implies a front router too** (single public :443). Plan: Caddy front +
   per-project hardening at CP-4; lighter request-auth noted as the alternative.
6. **projectId → subdomain label:** real ids are UUIDs → sanitize to a DNS-safe lowercase label. A real
   wildcard domain removes the spike's trailing-digit nip.io bug (that was dotted-decimal-specific).
7. **Capacity split:** provisiond enforces the **box RAM cap**; per-user/BYOK slot policy stays in the
   shell/billing and is passed as params. Flag the boundary at CP-5.
8. **VPS £/month** (billing knob #1) still unconfirmed — not blocking; record it when provisiond runs.
9. **Proxy choice:** Caddy (auto wildcard TLS + WS) over the proven nginx. The nginx HMR directives are
   the checklist Caddy must pass at CP-2 (esp. `Sec-WebSocket-Protocol: vite-hmr`).

## What flips in the shell when this lands (noted, not made)
`shell/server/preview/index.mjs`: stub → real HTTP client; set `PREVIEW_MODE=vps` + the three new env
vars. **Nothing** in `src/engine`, `src/billing`, or the web app changes.

## Files (build session)
- **New:** `provisiond/` (server + docker-orchestration lib + base-image Dockerfile + entrypoint +
  Caddyfile) and `provisiond/prove-provisiond.mjs`.
- **Reuse:** `spike/entrypoint.sh` (vite.config-from-env), `spike/nginx.conf` (HMR checklist),
  `src/scaffolds/reactVite.mjs` (base-image deps), `runtime-spike.mjs` (proof-harness structure).
- **Edit (CP-5 only):** `shell/server/preview/index.mjs` + `shell/.env`.

## Verification
Per checkpoint: CP-1 remote `provision` + off-box `curl`; CP-2 `prove-provisiond.mjs` HMR-wire step +
manual browser; CP-3 reaper/cold-start assertions; CP-4 isolation assertions; CP-5
`PREVIEW_MODE=vps node shell/harness/prove-shell.mjs` (the existing 17-step proof, now on real VPS
preview). Ship gate mirrors prior phases: the live proof is green, not just a build.
