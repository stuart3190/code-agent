# Thrallo v1.0 — release readiness

Dated 2026-08-04, against production at https://app.thrallo.com (VPS 51.195.136.189,
Supabase `zczgvcsokfafuyognvwx`).

**Verdict: ready to launch, with two documented gaps and one item I would not launch without
watching.** Both gaps are recorded below rather than hidden behind a green tick.

---

## 1. Evidence

### Live production proofs — 587 checks, zero failures

| Proof | Result |
|---|---|
| `prove-geoip` | 44/44 |
| `prove-first-run` | 37/37 |
| `prove-production-quality` | 40/40 |
| `prove-settings` | 60/60 |
| `prove-projects` | 28/28 |
| `prove-dashboard` | 21/21 |
| `prove-publish-experience` | 24/24 |
| `prove-operational` | 41/41 |
| `prove-analytics` | 62/62 |
| `prove-deployments` | 49/49 |
| `prove-publish-agreement` | 36/36 |
| `prove-logs` | 38/38 |
| `prove-domains` | 48/48 |
| `prove-health` | 28/28 |
| `smoke-production` | 31/31 |

Plus, run deliberately rather than nightly because it spends real tokens:
`prove-starters-build` — **54/54**, all ten starter prompts built for real (21–45s each).

### Test suites

- **817 node tests**, 0 failures (run with `shell/.env` moved aside, so CI sees what a developer sees)
- **832 Playwright tests**, 0 failures, 12 skipped — across **six** projects:
  desktop Chromium, iPad portrait, iPad landscape, Pixel 7, **Firefox (Gecko)**, **WebKit**

### Database and backups

- **No migration drift**
- **Publish-state repair clean** — every product resolves to exactly one publish record
- **Backup validated**: `thrallo-2026-08-04T122252`, 57 files decoded and checksummed against its manifest
- **Restore dry-run clean** against that backup — all 57 tables read, `auth_users: 10`, storage objects included

### Operations

| | |
|---|---|
| Disk | 43% used (31G/72G) |
| Backups on disk | 181 MB |
| GeoLite2 database | 8.4 MB, built 2026-07-31 |
| `Restart=` | `always`, 0 restarts since deploy |
| Backup timer | next 2026-08-05 03:22 UTC |
| Errors in the last hour | **0** |
| Non-terminal build jobs | **0** |

---

## 2. Billing — what is proven, and what is not

**Proven with a real £19 payment on the `support@thrallo.com` account:**

- Signed webhook delivery — `charge.succeeded` → `invoice.paid` → `customer.subscription.updated`
  at 15:05:32, Thrallo's row written at 15:05:33
- Unsigned POST to the webhook is refused with **400**
- Free → Starter activation; customer `cus_V00Y55hgZNfdub`, subscription `sub_1U0jtRC6PoSrpLpGC80uljA3`
- Settings → Usage and Billing both read **Starter**, limits **200 builds / 20M tokens / 30h** matching the catalogue
- Customer Portal opens on a real live session
- **Exactly one** live subscription; **exactly one** Stripe customer for the owner; no shared records
- Statement descriptor is **THRALLO**
- Cancel at period end → Thrallo and Stripe both say *ends 2026-09-04*; **Keep Starter** reverses it;
  same subscription id throughout, never replaced. **Zero charges created** by any of it
- Post-checkout return works signed in and signed out (24/24 browser tests, four viewports)

**NOT proven — deliberately, at Stuart's instruction:**

- **Starter → Pro upgrade.** Verified by Stripe's upcoming-invoice preview only. The preview shows
  **£0.00 charged immediately**; the next invoice on **2026-09-04** would be **£78.99**
  (−£18.99 unused Starter, +£48.98 remaining Pro, +£49.00 Pro recurring). No `subscriptions.update`
  was executed and no invoice was created.
- **Pro → Starter downgrade.** Gated behind the above; unexercised.

The upgrade path's *code* is covered by unit tests (in-place modification, no duplicate subscription,
proration semantics) — but the money has never moved through it.

---

## 3. Security posture

Verified live this phase and in the production-quality audit:

- Every mutating endpoint refuses anonymous callers — 16/16 return 401
- Owner isolation asserted in the SQL statement, not by convention; cross-owner reads return nothing
  even when the row exists
- Service-role only on every `ca_*` table; browsers are denied by restrictive RLS policy
- API tokens: SHA-256 hashed, secret shown once, never returned again; revoked tokens cannot be renamed
- Stripe webhook signature verification enforced
- Path traversal refused on four encodings; no secret served
- CSP: `frame-ancestors 'none'`, `object-src 'none'`, `form-action` limited to self + Stripe; HSTS set
- **CORS derived from `APP_URL`** — previously trusted `buildr101.com` unconditionally
- Analytics is cookieless; **no raw IP is stored anywhere**, asserted by dumping every column and
  searching the serialised events for the addresses used
- GeoLite2 licence key absent from the client bundle, absent from `/api/health`, redacted in
  download errors, logged nowhere

---

## 4. Supported platforms

Fully covered by automation: Chromium (4 viewports), Firefox, WebKit.
Covered by engine equivalence: Microsoft Edge.

**Not covered — stated, not implied** (see `docs/PLATFORMS.md`): real iOS/iPadOS Safari, real
Android Chrome, real device hardware, and screen readers. ARIA roles, focus order and focus return
are asserted structurally; no test drives NVDA, JAWS or VoiceOver, so "announced correctly" is
claimed nowhere.

---

## 5. Rollback procedure

**Application** — the deploy is a tarball over `/home/ubuntu/code-agent`; `shell/.env` is never in
the archive and survives:

```
git archive --format=tar <known-good-sha> -o /tmp/rollback.tar
scp /tmp/rollback.tar ubuntu@51.195.136.189:/tmp/
ssh ubuntu@51.195.136.189 "cd /home/ubuntu/code-agent && tar xf /tmp/rollback.tar \
  && cd shell/web && npm run build && sudo systemctl restart thrallo-shell"
```

**Customer deployments** — per-project rollback in the Deployments tab; the source of every
deployment is retained, so any earlier one can be restored without a rebuild.

**Data** — `ops/restore-thrallo.mjs <backup-dir>` is a dry run by default; writing requires
`RESTORE_TARGET_URL`, `RESTORE_TARGET_SERVICE_KEY` **and** `--confirm`, so a production key lying
in `shell/.env` cannot clobber anything by accident. **The backup is useless without
`PLATFORM_ENC_KEY`** — keep an offline copy of `shell/.env`.

---

## 6. Launch checklist

- [ ] **Watch one unattended nightly backup succeed** (2026-08-05 03:22 UTC). The nightly run was
      broken until today; the fix is verified by hand but not yet by the timer.
- [ ] Decide on the Starter → Pro upgrade: leave preview-only, or spend £78.99 on 4 September to
      prove it with real money
- [ ] Confirm the Stripe account rename to "Thrallo" is acceptable while Buildr101 still has four
      live products on the same account
- [ ] Add a logo/icon in Stripe branding (currently name-only text on Checkout)
- [ ] Top up or deselect the xAI key on `support@thrallo.com`, which currently cannot build
- [ ] Take an offline copy of `shell/.env` for the disaster-recovery kit

## 7. Post-launch monitoring

- **Daily**: `node scripts/validate-backup.mjs` — it now names the run it validated
- **Daily**: `journalctl -u thrallo-backup --since -24h` for a completed run
- **Weekly**: `node ops/migration-drift.mjs`, `node ops/repair-publish-state.mjs`
- **Weekly**: `/api/health` — `supabase`, `provisiond`, `stripe`, `stripeWebhook` all true
- **Weekly**: disk (`df -h /`) and backup growth; 43% today
- **On any incident**: `ops/prove-production-quality.mjs` first — it covers the failure classes
  that have actually bitten this product
- **Watch for**: non-terminal `build_jobs` older than 90 minutes, and GeoLite2 `builtAt` older than
  30 days (the UI degrades honestly, but it means the updater is failing)

---

## 8. Known limitations

1. **The Starter → Pro upgrade has never been executed with real money.** Preview only.
2. **Limit enforcement is unobservable on the accounts used for testing.** Both are owner accounts
   (`unlimited: true`), so limits are recorded but never enforced. Enforcement is covered by unit
   tests; it has not been demonstrated against a real paying non-owner account.
3. **No real-device or screen-reader coverage.**
4. **Buildr101 shares this Stripe account** — four live products. Account-wide settings (business
   name, portal configuration) affect both. This has already caused two issues; a separate Stripe
   account for Thrallo remains the clean answer.
5. **One nightly backup has not yet run unattended since the fix.**
