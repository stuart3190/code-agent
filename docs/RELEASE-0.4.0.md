# Thrallo v0.4.0 — Release Report

**Released** 2026-08-01 · **Web** live at `https://app.thrallo.com` · **Desktop** Windows x64 0.4.0
**Tests** 454 node + 100 Playwright · **Production smoke** 18/18 · **main** green at `65681f4d`

This release closes every confirmed defect from the 2026-08-01 production audit, restores three
features that had been silently unmounted, makes the desktop release buildable again, and adds
permanent guards so the same classes of defect cannot recur unnoticed.

---

## 1. Architecture overview

**One conversational application.** The user describes an outcome; a durable per-owner Lead Agent
decides how to build it. There is no dashboard and no template picker.

```
Browser / Thrallo Desktop
        │  (Supabase auth, or a personal API token on desktop)
        ▼
thrallo-shell (Node, :8788)  ──► Supabase zczgvcsokfafuyognvwx (control plane + app runtime)
        │                              projects, build_jobs, diag_*, ca_*, entities, app_users
        ├─► Capability Registry ──► the Lead Agent's tool list is GENERATED, never hardcoded
        ├─► buildJobs.runJob    ──► design → build → npm build → audits → preview
        ├─► appBuildService     ──► end-state classification, repair loop, checkpoints
        └─► thrallo-provisiond (:8791) ──► preview containers at *.preview.thrallo.com
                                           published sites at *.app.thrallo.com
Caddy (container) fronts everything and issues wildcard TLS on demand.
```

**Registered capabilities (15).** `create_plan`, `app_build`, `repair_app`, `show_preview`,
`run_qa`, `export_project`, `open_view`, `publish`, `configure_domain`, `create_automation`,
`repo_change`, `repo_review`, `get_status`, `remember`, `ask_business_question`.

**Build lifecycle.** A build is one *lifecycle*: an initial job plus at most two automatic
repairs, sharing one aggregate budget, one repair memory, one checkpoint store and one diagnostics
run. Every job end is classified into one of eleven explicit end states; **only
`transient_interruption` may auto-retry**.

**Generated-app runtime.** Published apps reach a Supabase Edge Function (`app-auth`) that maps
each `(app_id, email)` to a distinct synthetic auth user, so `owner = auth.uid()` isolates per app.
`entities` and `app_notifications` follow that same model.

**Desktop.** A Code-OSS 1.131.0 fork with one builtin extension that hosts the *same* web bundle
in a webview. It bundles its own copy, so it must be repackaged to pick up web changes.

---

## 2. Completed remediation work

| PR | Work | Proven in production by |
|---|---|---|
| #123 | xAI added to two missed provider constraints; 7 tables added to DR backups; anon/authenticated grants revoked on 6 telemetry tables; dead Facebook CSP origins removed | constraints accept `xai`; a real backup contains all 7; the 6 tables now return 401 (were `200 []`) |
| #124 | Remounted `/api/builds/:id/events`, `/api/builds/:id/cancel`, `/api/projects/:id/active-build`; added Stop build; route-manifest guard; post-deploy smoke | a real build cancelled mid-flight: `stop_reason=cancelled`, diagnostics `cancelled`, **0** follow-up jobs, **0** further AI requests |
| #126 | QA / responsive verification restored (new `qa_runs` table, routes, `run_qa` capability) | a real sweep across desktop+mobile found a genuine `mobile_content_overlap` defect |
| #125 | Source export restored (route + `export_project` capability); two secret scrubbers consolidated into one rule set | a real export: 29 files, no secrets, `npm install && npm run build` succeeded standalone |
| #127 | Per-app notifications built properly (table, trusted writer, two real event integrations, SDK write path) | real signup created the welcome; forging a platform `source` refused; cross-user write refused |
| #129 | Tablet Playwright coverage; `apply_patch` whitespace tolerance; feature-health report | 112 tests across 4 viewports; report closed the audit's missing-evidence list |
| #128 | Desktop build repaired and Windows 0.4.0 published | install → launch → token auth → real projects render |
| #130/#131 | Outcome signal producers (`exported`, `deployed`, `rolled_back`) | real export wrote a signal; `userSuccessScore` = 77.6 from real evidence |

### Root cause of the largest cluster

**PR #53's Buildr101 legacy unmount over-swept.** It deleted Thrallo's *own* Phase-19 route bodies
alongside genuine legacy routes, leaving empty `{ let m; }` blocks. Because nothing imports a
handler until it is mounted, this produced no lint error, no type error and no test failure —
users could not cancel a build at all, and export and QA were dead. (The audit blamed PR #73; git
history showed that was only reformatting around the already-empty blocks.)

### Permanent guards added

- **Route manifest** — every route module is mounted *or* retired with a written reason; fails in
  both directions; references are **counted**, so an imported-but-never-dispatched handler fails.
- **Post-deploy smoke** (`scripts/smoke-production.mjs`) — the *deployed* origin must answer every
  critical path. 404 on a mounted route is never acceptable.
- **Backup coverage** — every `create table`, not a name allowlist (which is how 7 tables hid).
- **Provider registry** — the app's provider list checked against *every* AI provider constraint,
  discovered by pattern and classified by value overlap.
- **Desktop build** — 8 tests covering both toolchain fixes and the release-version scheme.
- **Feature health** (`scripts/feature-health.mjs`) — which shipped features have *never* executed
  in production. Currently **19/20 healthy**.

---

## 3. Remaining deferred items

| Item | Why deferred | Trigger to revisit |
|---|---|---|
| **C1 — paid plans** | Awaiting your prices. No code needed. | You provide pricing |
| **Phase 24 retirement** | Meta ad + Stripe subscription audit are yours | Before public launch |
| **R3 — DB-backed concurrency** | `MAX_CONCURRENT_BUILDS_PER_USER` is in-memory; correct on one instance | Before running >1 shell instance |
| **R4 — Caddy re-home** | The container serving Thrallo is still named `buildr-caddy` | With Phase 24 |
| **Legacy cleanup** | 28 never-applied Buildr101 migrations, retired billing ledger, `migrations/` dir | After beta |
| **`preview_opened` signal** | Needs client-side tracking + a product/privacy decision | Product decision |
| **Code signing** | No certificate | Before wide distribution |
| **macOS / Linux desktop** | Configured, never built or launched | Platform demand |

---

## 4. Known limitations

- **Desktop binaries are unsigned.** SmartScreen warnings are expected on first run.
- **The desktop bundles its own web copy.** Every web deploy leaves installed copies behind; the
  in-app notice tells users, but there is no auto-updater.
- **Cancellation is not instantaneous.** The runner checks the flag *between* engine turns, so a
  long model turn finishes first (~45s observed). The UI says "Stopping…" rather than claiming
  otherwise.
- **`maxDailySpend` receives a real total only when enabled**; there is no rolling daily
  aggregation when the control is off (by design — no query, no possibility of blocking).
- **`diag_incidents` has never recorded.** Both call sites are live, so this plausibly means no
  shielded errors have occurred — but it is unproven either way.
- **Uninstall leaves a 0 MB `debug.log`** that Electron writes post-install.
- **Paid plans are disabled**, so there is no revenue path yet.
- **`regenerated` and `preview_opened` outcome signals have no producer** (both deliberate — see
  §2 and §12).

---

## 5. Deployment procedure

Deploys are archive-based; the VPS holds no git checkout.

```bash
# 1. From a clean main
git checkout main && git pull

# 2. Ship the tree
git archive main -o /tmp/thrallo.tar
scp /tmp/thrallo.tar ubuntu@51.195.136.189:/tmp/

# 3. Extract, build the web bundle, restart
ssh ubuntu@51.195.136.189 "cd /home/ubuntu/code-agent && tar xf /tmp/thrallo.tar \
  && cd shell/web && npm run build \
  && sudo systemctl restart thrallo-shell"

# 4. MANDATORY — prove the deployed server answers every critical path
node scripts/smoke-production.mjs        # must print 18/18

# 5. Watch main's CI to completion (a PR check passing is not the same thing)
gh run list --branch main --limit 1
```

**Migrations** are applied via the Supabase MCP `apply_migration` *before* the deploy that depends
on them, and the same SQL is committed under `supabase/migrations/`.

---

## 6. Rollback procedure

**Web (fastest path).** Redeploy the previous commit — the deploy is a tarball extract, so
rollback is the same operation:

```bash
git archive <previous-good-sha> -o /tmp/thrallo.tar
scp /tmp/thrallo.tar ubuntu@51.195.136.189:/tmp/
ssh ubuntu@51.195.136.189 "cd /home/ubuntu/code-agent && tar xf /tmp/thrallo.tar \
  && cd shell/web && npm run build && sudo systemctl restart thrallo-shell"
node scripts/smoke-production.mjs
```

**Migrations.** Every migration this release added is additive (new tables, widened constraints,
revoked grants). To reverse: re-narrow the constraint, re-grant, or `drop table`. No migration
destroyed or rewrote existing data.

**Desktop.** The previous release is retained at `/home/ubuntu/thrallo-releases/previous/`.
Restore by copying it back and regenerating the manifest:

```bash
ssh ubuntu@51.195.136.189 "cd /home/ubuntu/thrallo-releases \
  && cp previous/Thrallo-Setup-x64.exe previous/Thrallo-Portable-x64.zip . \
  && cd /home/ubuntu/code-agent && node scripts/build-release-manifest.mjs \
     /home/ubuntu/thrallo-releases 0.3.0 'rolled back'"
```

Installed copies keep working either way — they target the same production API.

---

## 7. Backup and restore

**Automatic.** `thrallo-backup.timer` runs nightly. `ops/backup-thrallo.mjs` dumps every table in
`CA_TABLES` to gzipped JSON with a checksummed manifest, into `~/thrallo-backups/thrallo-<stamp>/`,
pruning runs older than 14 days (`THRALLO_BACKUP_KEEP_DAYS`).

**Coverage is guarded**: `backup-coverage.test.mjs` fails if any migration creates a table that is
neither backed up nor on an explicitly justified exclusion list.

```bash
# Run on demand
ssh ubuntu@51.195.136.189 "sudo systemctl start thrallo-backup.service"

# Validate a snapshot WITHOUT restoring (checksums + row counts)
ssh ubuntu@51.195.136.189 "cd /home/ubuntu/code-agent && node -e \"
  import('./scripts/lib/backupValidation.mjs').then(async m => {
    const r = await m.validateBackupDirectory('/home/ubuntu/thrallo-backups/<stamp>');
    console.log(r.ok, Object.keys(r.tables).length + ' tables');
  })\""

# Restore — DESTRUCTIVE, requires an explicit flag
node ops/restore-thrallo.mjs /home/ubuntu/thrallo-backups/<stamp> --confirm
```

`PLATFORM_ENC_KEY` must match the environment the backup came from, or encrypted columns
(credentials, tokens) will not decrypt. **Back it up separately from the database.**

---

## 8. Environment variables

Production keys currently set in `shell/.env` (values never leave the server):

**Core** `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PLATFORM_ENC_KEY`,
`SHELL_PORT`, `SHELL_HOST`, `APP_URL`, `PUBLIC_URL`, `CODE_AGENT_STANDALONE`, `CODE_AGENT_STORE`,
`CODE_AGENT_WORKER`, `CODE_AGENT_POLL_MS`, `CODE_AGENT_STALE_RUN_MINUTES`

**Models** `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_MODEL`, `CODE_AGENT_DEFAULT_PROVIDER`

**Preview / publish** `PREVIEW_MODE=vps`, `PROVISIOND_URL`, `PROVISIOND_TOKEN`,
`LEGACY_DOMAIN_CHECK_URL`

**GitHub** `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`,
`GITHUB_APP_STATE_SECRET`, `GITHUB_AGENT_TOKEN`

**Sandboxes** `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_TARGET`, `DAYTONA_AUTO_STOP_MINUTES`,
`DAYTONA_AUTO_ARCHIVE_MINUTES`, `DAYTONA_AUTO_DELETE_MINUTES`

**Notifications / access** `THRALLO_VAPID_PUBLIC_KEY`, `THRALLO_VAPID_PRIVATE_KEY`,
`THRALLO_VAPID_SUBJECT`, `ADMIN_EMAILS`, `THRALLO_OWNER_EMAILS`, `THRALLO_RELEASES_DIR`

**Edge Function secrets** (Supabase, not `.env`): `RESEND_API_KEY`, `RESEND_FROM`

**Required for paid plans** (§9): `THRALLO_STRIPE_SECRET_KEY`, `THRALLO_STRIPE_WEBHOOK_SECRET`,
`THRALLO_STRIPE_PRICE_STARTER`, `THRALLO_STRIPE_PRICE_PRO`, `THRALLO_STARTER_PRICE_GBP`,
`THRALLO_PRO_PRICE_GBP`

⚠️ Every one of these is **`THRALLO_`-prefixed**. The un-prefixed `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` belong to the retired Buildr101 billing code and are deliberately ignored,
so that a Buildr101 credential can never be inherited on the shared host. Setting only those leaves
billing dormant; the server logs the mistake explicitly rather than appearing unconfigured.
The price-ID variables also accept the aliases `THRALLO_STARTER_PRICE_ID` / `THRALLO_PRO_PRICE_ID`.

**Optional tuning** `THRALLO_LIFECYCLE_CREDITS_<PLAN>_<MODE>`, `THRALLO_CHECKPOINT_RETENTION_HOURS`
(48), `THRALLO_COST_APPROVAL_CREDITS` (150), `THRALLO_BACKUP_KEEP_DAYS` (14),
`THRALLO_XAI_ENABLED`, `THRALLO_CTX_BUDGET_*`

---

## 9. Stripe configuration checklist

The billing path is **complete and tested**; plans are gated purely by absent configuration.
`planCatalog()` returns `priceGbp: null, priceApproved: false`, which disables upgrades everywhere.

**Thrallo sells exactly two paid plans: Starter and Pro** (Stuart, 2026-08-02). `PLAN_IDS` is
`["free","starter","pro"]`. Any other price arriving on a webhook is **never granted a plan** —
`applySubscription` refuses to guess an entitlement nobody bought, and logs `ACTION REQUIRED` with
the subscription, customer and price IDs so it can be cancelled and refunded.

### Plan change semantics

| From → to | When it takes effect | Money |
|---|---|---|
| Free → Starter/Pro | Immediately on payment | Stripe Checkout, full price |
| Starter → Pro (**upgrade**) | **Immediately** | Prorated difference invoiced at once (`always_invoice`) |
| Pro → Starter (**downgrade**) | **At the end of the current billing period** | Nothing extra; no credit balance is created |
| Starter/Pro → Free | Cancellation via the Customer Portal, `at_period_end` | Nothing extra |

Downgrades are deliberately deferred: the customer has already paid for the period, so they keep
what they bought and no confusing credit accumulates. Stripe holds the change in a **subscription
schedule**; `ca_subscriptions.pending_plan` mirrors it so the UI can show the date, and the webhook
clears it when the phase actually starts. A pending change is cancelled by choosing the current
plan again ("Keep Pro").

An existing subscriber is **never** sent back to Checkout — their subscription item is updated in
place. Sending them to Checkout is what produced two live subscriptions and two monthly charges.
Stripe idempotency keys make repeated clicks a single operation, and a duplicate subscription
acquired outside Thrallo is detected and cancelled, keeping the newest.

**Portal plan switching is deliberately disabled.** A portal configuration is account-wide, and
this Stripe account also serves Buildr101 — enabling it would list Thrallo's products to a
Buildr101 customer. Plan changes stay under Thrallo's own billing routes.

- [x] Starter and Pro monthly prices decided, products and recurring GBP prices created
- [ ] Create a webhook endpoint → `https://app.thrallo.com/api/v1/billing/webhook`, subscribing to
      `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`;
      note the signing secret. **Without all three, payments succeed but plans never activate.**
- [ ] Configure tax/VAT and the Customer Portal, with cancellation enabled (the only self-service
      cancellation path)
- [ ] Set on the VPS (all `THRALLO_`-prefixed — see §8): `THRALLO_STRIPE_SECRET_KEY`,
      `THRALLO_STRIPE_WEBHOOK_SECRET`, `THRALLO_STRIPE_PRICE_STARTER`, `THRALLO_STRIPE_PRICE_PRO`,
      `THRALLO_STARTER_PRICE_GBP`, `THRALLO_PRO_PRICE_GBP`
- [ ] `sudo systemctl restart thrallo-shell` (env is read at boot)
- [ ] **`node scripts/stripe-live-check.mjs`** — validates every item above against Stripe itself:
      prices exist, are **active** (an archived price retrieves fine but fails at the moment a real
      customer pays), are recurring GBP monthly, the **displayed price equals the charged price**,
      the webhook exists with all required events, and the portal allows cancellation. It also
      reports any active price in the account that Thrallo does not sell. Read-only; re-run it
      after any billing change.
- [ ] **Live test with real money**: checkout → webhook → plan applied → budget raised → portal
      cancel → downgrade
- [ ] Confirm `/pricing` switches from "coming soon" to purchasable automatically

⚠️ Never reuse Buildr101 Stripe credentials — Thrallo ignores the un-prefixed variable names for
exactly this reason. Test-mode `stripe_customer_id`s must be nulled before a live flip; they break
live checkouts. Price IDs live only in the environment: a guard test fails the build if a literal
`price_…` identifier appears anywhere in the shipped source.

---

## 10. Release checklist (web)

- [ ] `npm run verify` green locally (454 node + 100 Playwright)
- [ ] New tests re-run with `shell/.env` moved aside, so CI sees what you see
- [ ] PR opened; CI green **on the PR**
- [ ] Migrations applied to Supabase *before* the dependent deploy
- [ ] Squash-merge; **watch `main`'s CI to completion** (a PR check is not the same run)
- [ ] Deploy (§5)
- [ ] `node scripts/smoke-production.mjs` → **18/18**
- [ ] Live-verify the specific change through its real entry point — HTTP status, database row, or
      Playwright flow. Never a unit test alone.
- [ ] `node scripts/feature-health.mjs` on the VPS if the change added a feature

## 10b. Release checklist (desktop)

- [ ] All web changes merged and deployed **first** — the bundle is baked in
- [ ] Bump `editor/vscode/package.json` version
- [ ] `npm run build` in `shell/web` (the desktop syncs `dist/`)
- [ ] `node desktop/build.mjs compile` → 0 errors
- [ ] `node desktop/build.mjs package --platform win32-x64`
- [ ] `node desktop/build.mjs installer`
- [ ] Copy the zip to `Thrallo-Portable-x64.zip`; retain the previous release under `previous/`
- [ ] Upload both to `/home/ubuntu/thrallo-releases/`
- [ ] `node scripts/build-release-manifest.mjs /home/ubuntu/thrallo-releases '' "<notes>"` —
      the version **defaults to the packaged app's own version**; a mismatch warns
- [ ] Verify served sha256 == manifest == local build
- [ ] Clean-machine install → launch → connect → real project renders

---

## 11. First-launch checklist (new user)

1. Sign up at `https://app.thrallo.com` — Free plan, 1.5M managed tokens/month, 20 runs.
2. Describe an outcome. No stack questions are asked; the team assembles and streams progress.
3. The preview card appears unprompted when the preview is reachable.
4. Optional: **Settings → AI connection** to add your own OpenAI/Anthropic/Gemini/xAI key. BYOK is
   **not capped by Thrallo**; optional safeguards are all off unless you enable them.
5. Optional: Desktop from **Settings → Downloads**. Install (no admin needed), then
   **Thrallo: Connect** with an API token from **Settings → API tokens**.
6. Expect a SmartScreen warning — binaries are unsigned.

---

## 12. Production operations guide

**Services** `thrallo-shell.service` (:8788), `thrallo-provisiond.service` (:8791),
`thrallo-backup.timer` (nightly). Caddy runs as the `buildr-caddy` container (rename pending, §3).

**Health**
```bash
node scripts/smoke-production.mjs                       # 18 critical endpoints
curl -s https://app.thrallo.com/api/health              # liveness + configured capabilities
ssh ubuntu@... "systemctl is-active thrallo-shell thrallo-provisiond"
ssh ubuntu@... "cd /home/ubuntu/code-agent && node scripts/feature-health.mjs"
```

**Logs.** `journalctl -u thrallo-shell -f`. Successful requests are **not** logged by design;
errors, job progress and billing lines are. User-facing text never contains raw errors — technical
detail goes to Diagnostics, referenced by a `THR-XXXXXX` support code.

**Cost controls in force**
- Per-job runaway cap (plan 2 / iterate 40 / build 60 credits) *and* an aggregate **lifecycle**
  budget: Free 90/60, Starter 140/90, Pro 220/140 credits (build/iterate), 3 jobs, 75 turns, 45 min
- Repair loop: initial build + **at most 2** repairs, stopped early by failure fingerprints,
  duplicate briefs, or no measurable progress
- Cost guard refuses non-user-triggered work projected above 150 credits
- BYOK is uncapped by default; optional per-provider safeguards exist

**Data protection.** RLS on every table. Tables holding prompts or telemetry (`diag_*`,
`ai_requests`, `build_signals`) and control-plane tables (`projects`, `build_jobs`,
`build_checkpoints`, `qa_runs`) are **service-role only** and return 401 to a browser client.
Generated-app tables (`entities`, `app_notifications`) are owner-scoped with column-level grants —
`source` is not client-writable, so a compromised app cannot forge a platform security alert.

---

## 13. Troubleshooting guide

| Symptom | Likely cause | Action |
|---|---|---|
| A route returns **404** that should return 401 | Route unmounted (the #53 class) | `node scripts/smoke-production.mjs`; check `shell/server/index.mjs` and the route-manifest test |
| Builds stuck "building" forever | Shell restarted mid-build | Boot sweep marks them `interrupted`; `recoverInterruptedLifecycles()` restores last-known-good |
| Stop build does nothing for ~45s | By design — the runner aborts *between* engine turns | Wait; `stop_reason=cancelled` confirms it landed |
| Repair loop stops early | Identical failure fingerprint, duplicate brief, or no measurable progress | Read Diagnostics: the reason is recorded |
| "provider has reached its current limit" | Quota/rate limit | Connect another provider, or enable auto-fallback in Settings → AI connection |
| Preview never appears | provisiond or Caddy | `systemctl is-active thrallo-provisiond`; `curl 127.0.0.1:8791/health`; the recovery poller retries 9× at 20s |
| A generated app renders but data never saves | Per-app runtime | `backendRuntimeReady()`; the honesty gate should already have failed the build |
| Desktop shows "Connect Thrallo" after connecting | The panel does not refresh on connect | Reopen with **Thrallo: Open Conversation** |
| Desktop shows an update notice permanently | Manifest version ≠ packaged version | Republish with the default version (§10b) |
| `spawn signtool.exe ENOENT` when packaging | Windows SDK not on PATH | Fixed in 0.4.0 — `build.mjs` discovers it; verify the SDK is installed |
| `compile-copilot` ENOENT | Stale checkout | Fixed — `requireCheckout()` repairs the scripts on every build |
| Nightly backup missing tables | New table not in `CA_TABLES` | `backup-coverage.test.mjs` should have failed; add it |
| A feature seems dead | Never executed in production | `node scripts/feature-health.mjs` |

---

## 14. Recommendations for v0.5.0

**Commercial (blocking launch)**
1. **Approve pricing and complete §9.** Everything else is ready; there is no revenue path today.
2. **Complete Phase 24 retirement** — the Meta ad is still spending on a domain being retired.

**Reliability**
3. **Re-home Caddy** off the `buildr-caddy` container, with a reboot test (R4). Thrallo's
   availability currently depends on a Buildr101-named container.
4. **Database-backed concurrency** (R3) *before* any second shell instance, or one user can
   double-spend managed budget.
5. **Scheduled migration-drift check** — repo migrations vs applied migrations vs live constraint
   definitions. This release found 28 never-applied migrations and two constraints that had
   drifted; only a manual query caught them.
6. **Wire `feature-health --strict` into the nightly ops run** so a never-executed feature reports
   itself rather than waiting for an audit.

**Product**
7. **Decide `preview_opened`.** It is the strongest acceptance signal and the only one still
   missing; it needs a client-side tracking decision.
8. **Refresh the desktop conversation panel on connect** — today the user must reopen it.
9. **Code-signing certificate.** SmartScreen warnings will suppress desktop adoption.
10. **Consider an in-app desktop updater** once binaries are signed; the notice is a stopgap.

**Engineering quality**
11. **Scheduled end-to-end pipeline test** (prompt → build → compile → preview → verify → publish),
    weekly and budget-capped. It spends real money, so it must never run per-merge.
12. **Retire the 28 unapplied legacy migrations and the `migrations/` directory** once their
    consumers are proven dead — the QA/`qa_runs` surprise showed why proof comes first.
