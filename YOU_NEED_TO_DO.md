# Thrallo — actions for Stuart

This is the short list of actions that require account ownership, billing confirmation, or secret
values. Codex will keep everything else moving locally.

## Completed

- [x] Approve and create a dedicated Supabase project for Thrallo.
  - Project: `Code Agent` (`zczgvcsokfafuyognvwx`)
  - Organization: `nuzfrbtaqkoemvdajzfh`
  - Region: `eu-west-1`
  - Quoted cost: $0/month
  - The separate `AppBuilder` project (`qgemqjcyhuejrsvjxkbh`) was not changed.
- [x] Apply the Thrallo database migrations and verify RLS, grants, policies, and foreign-key
  indexes.
- [x] Configure and verify the server-side Supabase secret key.
  - A live service-role query succeeded; the key remains only in ignored `shell/.env`.
  - The project URL and publishable browser key are configured locally.

## Required before a live agent run

- [x] Configure Daytona.
  - API authentication is verified and `DAYTONA_TARGET=eu`.
- [x] Configure an OpenAI API key.
  - Authentication and paid inference are verified against `gpt-5.6-sol`.
  - The credit check completed using 10 input and 5 output tokens.
- [x] Add OpenAI API credits before the first model-backed agent run.
- [x] Create the Thrallo GitHub App after DNS and TLS are live.
  - Setup URL: `https://app.thrallo.com/api/v1/github/callback`
  - Webhook URL: `https://app.thrallo.com/api/v1/github/webhook`
  - Repository permissions planned for the first release: Metadata read, Contents read/write,
    Pull requests read/write, Checks read, and Issues read.
  - Generate a private key, a random state-signing secret, and a separate webhook secret; add them
    only to the server environment as `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_STATE_SECRET`, and
    `GITHUB_WEBHOOK_SECRET`.
  - Installed on `stuart3190/code-agent`; signed delivery and PR publishing are verified.

## Required before public launch

- [x] Disaster-recovery kit, part 1 (done 2026-07-30): `shell/.env` (containing
  `PLATFORM_ENC_KEY`) is stored safely off the VPS. Remember to refresh the copy whenever a
  new secret is added to the server environment (e.g. the future `THRALLO_STRIPE_*` keys).
- [ ] Disaster-recovery kit, part 2 (recurring, low urgency): now and then copy a recent
  `~/thrallo-backups/thrallo-<stamp>/` folder off-host too, so a total VPS loss cannot take
  the newest backup with it. Details in `docs/DISASTER-RECOVERY.md`.

- [x] In GitHub App settings for **Thrallo Code Agent**, subscribe to the **Push** event.
  - Verified from the live installation: subscribed events now report `["push"]`.
- [x] In GitHub App settings for **Thrallo Code Agent**, also subscribe to the **Pull request**
  event. Verified from the live installation on 2026-07-30: subscribed events now report
  `["pull_request", "push"]`, so Phase 12's automatic PR reviews are active.
- [x] Choose the product name and domain: Thrallo at `thrallo.com`.
- [x] Choose production hosting: isolated services on the existing Buildr101 VPS.
- [x] Point Cloudflare DNS for `thrallo.com` and `app.thrallo.com` to `51.195.136.189`.
- [x] In Supabase Authentication → URL Configuration, set both the Site URL and an allowed redirect
  URL to `https://app.thrallo.com`.
- [ ] Upgrade Supabase before public sign-ups if you want leaked-password protection. Supabase
  currently exposes this setting only on a paid plan; it is not blocking development or private use.
- [ ] Supply business identity, support email, privacy, terms, and billing details.
- [ ] Approve subscription prices, included usage, and overage policy. Phase 7 shipped the
  plans (Free/Starter/Pro), budgets, and dormant Stripe wiring; to flip paid plans live:
  1. Approve the included monthly allowances (defaults: Free 20 runs / 1.5M managed tokens /
     3h compute; Starter 200 / 20M / 30h; Pro 1,000 / 100M / 120h) and the two prices.
  2. Create a **dedicated Thrallo Stripe account** (never Buildr101's), add two subscription
     products with monthly GBP prices, and a webhook endpoint for
     `https://app.thrallo.com/api/v1/billing/webhook` subscribed to `checkout.session.completed`,
     `customer.subscription.updated`, and `customer.subscription.deleted`.
  3. Set in the server environment: `THRALLO_STRIPE_SECRET_KEY`, `THRALLO_STRIPE_WEBHOOK_SECRET`,
     `THRALLO_STRIPE_PRICE_STARTER`, `THRALLO_STRIPE_PRICE_PRO`, `THRALLO_STARTER_PRICE_GBP`,
     and `THRALLO_PRO_PRICE_GBP`, then restart `thrallo-shell`. Until then the free plan is
     fully enforced and upgrades show "not available yet".
- [ ] Optional: set `ADMIN_EMAILS=stuart3190@gmail.com` in the Thrallo server environment to
  see the operator Operations view (platform telemetry) in the workspace.
- [ ] Approve GitHub App permissions and marketplace-facing copy after the implementation is ready.
- [ ] Publish the VS Code extension when you want public installs (it is packaged and ready —
  `thrallo-0.2.0.vsix` builds from `editor/vscode` with `npm run package`):
  1. Create a [VS Code Marketplace publisher](https://marketplace.visualstudio.com/manage)
     named `thrallo` (needs a Microsoft/Azure DevOps account and a Personal Access Token with
     Marketplace → Manage scope).
  2. From `editor/vscode`: `npx @vscode/vsce login thrallo`, then `npx @vscode/vsce publish`.
  Until then, the .vsix installs directly via VS Code → Extensions → “Install from VSIX”.

## Optional: use your ChatGPT Codex allowance

- [x] In Thrallo, open **Settings**, click **Continue with Codex**, open the OpenAI sign-in page,
  enter the one-time code, and approve the account. This is per Thrallo user and does not require
  you to create an OAuth application or paste an API key.

## Optional: add more model providers

- [ ] If you want Gemini runs or comparisons, open **Settings → AI providers** and connect a Gemini
  API key from Google AI Studio. Thrallo already works with managed OpenAI, so this is not required.
- [ ] If you want Claude runs or comparisons, connect an Anthropic API key on the same page. This is
  also optional.
