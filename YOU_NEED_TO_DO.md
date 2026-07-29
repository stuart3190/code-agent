# Code Agent — actions for Stuart

This is the short list of actions that require account ownership, billing confirmation, or secret
values. Codex will keep everything else moving locally.

## Completed

- [x] Approve and create a dedicated Supabase project for Code Agent.
  - Project: `Code Agent` (`zczgvcsokfafuyognvwx`)
  - Organization: `nuzfrbtaqkoemvdajzfh`
  - Region: `eu-west-1`
  - Quoted cost: $0/month
  - The separate `AppBuilder` project (`qgemqjcyhuejrsvjxkbh`) was not changed.
- [x] Apply the Code Agent database migrations and verify RLS, grants, policies, and foreign-key
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
- [ ] Decide whether the first live repository test should use a public repository or a private
  GitHub App installation.
- [ ] Create the Code Agent GitHub App when the repository-installation UI is ready for live setup.
  - Setup URL: `https://YOUR_CODE_AGENT_DOMAIN/api/v1/github/callback`
  - Webhook URL: `https://YOUR_CODE_AGENT_DOMAIN/api/v1/github/webhook`
  - Repository permissions planned for the first release: Metadata read, Contents read/write,
    Pull requests read/write, Checks read, and Issues read.
  - Generate a private key, a random state-signing secret, and a separate webhook secret; add them
    only to the server environment as `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_STATE_SECRET`, and
    `GITHUB_WEBHOOK_SECRET`.

## Required before public launch

- [ ] Choose the final product name and domain; `Code Agent` is currently a placeholder.
- [ ] Supply business identity, support email, privacy, terms, and billing details.
- [ ] Approve subscription prices, included usage, and overage policy.
- [ ] Approve GitHub App permissions and marketplace-facing copy after the implementation is ready.
