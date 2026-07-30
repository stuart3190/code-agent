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

- [ ] In GitHub App settings for **Thrallo Code Agent**, open **Permissions & events**, subscribe to
  the **Push** event, and save. The installed app currently reports no subscribed events, so manual
  reindexing works but automatic reindexing after a default-branch push will wait for this checkbox.
- [x] Choose the product name and domain: Thrallo at `thrallo.com`.
- [x] Choose production hosting: isolated services on the existing Buildr101 VPS.
- [x] Point Cloudflare DNS for `thrallo.com` and `app.thrallo.com` to `51.195.136.189`.
- [x] In Supabase Authentication → URL Configuration, set both the Site URL and an allowed redirect
  URL to `https://app.thrallo.com`.
- [ ] Upgrade Supabase before public sign-ups if you want leaked-password protection. Supabase
  currently exposes this setting only on a paid plan; it is not blocking development or private use.
- [ ] Supply business identity, support email, privacy, terms, and billing details.
- [ ] Approve subscription prices, included usage, and overage policy.
- [ ] Approve GitHub App permissions and marketplace-facing copy after the implementation is ready.

## Optional: use your ChatGPT Codex allowance

- [x] In Thrallo, open **Settings**, click **Continue with Codex**, open the OpenAI sign-in page,
  enter the one-time code, and approve the account. This is per Thrallo user and does not require
  you to create an OAuth application or paste an API key.
