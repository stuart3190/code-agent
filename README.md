# Thrallo

Thrallo is a standalone cloud coding-agent product. The first implemented slice connects a
GitHub repository, creates a persistent agent, queues a durable run, executes the task in an
isolated Daytona workspace, drives a commercial OpenAI Responses API tool loop, and streams an
ordered timeline plus the final status and diff to the web workspace.

This repository was derived from the Buildr101 backend but was published with a clean standalone
history. Do not point it at Buildr101 production data or credentials.

## What works now

- Thrallo landing page and authenticated three-pane agent workspace.
- Repository and agent creation with strict owner isolation.
- Durable Supabase schema for repositories, agents, runs, events, tool calls, checkpoints,
  artifacts, usage, and privacy-first repository indexing.
- Local in-memory control-plane mode for tests and UI development.
- Queue claiming with `FOR UPDATE SKIP LOCKED`.
- Authenticated v1 HTTP API and resumable server-sent event stream.
- GitHub App installation flow with signed state, owner isolation, repository discovery, and
  on-demand short-lived installation tokens.
- HMAC-verified GitHub webhook endpoint and explicit approval gate before committing, pushing, and
  opening a pull request.
- Daytona sandbox creation, clone, dedicated branch, file/search/command tools, and cleanup.
- Normalized commercial model gateway with OpenAI Responses and Anthropic Messages adapters.
- Encrypted per-user AI connections: Codex device sign-in with a ChatGPT account, OpenAI and
  Anthropic BYOK, and managed-provider selection.
- Codex subscription runs inside the isolated Daytona workspace with ephemeral auth injection and
  guaranteed credential cleanup before the workspace is preserved or discarded.
- Incremental repository indexing with AES-GCM encrypted paths/source, HMAC exact-identifier
  lookup, OpenAI code embeddings, hybrid retrieval, and relevant context injection before each run.
- Encrypted language-aware definitions, references, calls, inheritance, imports, and file dependency
  graphs across TypeScript/JavaScript, Python, Go, Rust, Java-family languages, Ruby, PHP, and SQL.
- Owner-authenticated code/definition search, reference navigation, dependency views, live indexing
  progress, and manual reindexing in the web workspace.
- Automatic durable reindexing after default-branch GitHub pushes, including follow-up refreshes
  when a newer push arrives during an active index.
- Bounded coding loop, cancellation, stale-run recovery, clean-baseline retry, checkpoints,
  durable diff/log/report artifacts, terminal states, setup diagnostics, and usage capture.
- Subscription plans (Free/Starter/Pro) with monthly managed usage budgets: run count and
  sandbox compute apply to every run, managed-model tokens only to managed-key runs, and owners
  can set personal spend guards below the plan allowance. Budgets are enforced at run creation,
  at worker claim, and mid-run for managed tokens.
- Dormant Stripe subscription wiring behind dedicated `THRALLO_STRIPE_*` configuration; paid
  upgrades stay disabled until pricing is approved and the products exist.
- Usage & billing workspace view with plan cards, budget meters, and spend guards, plus an
  operator-only Operations view backed by `/api/v1/ops/telemetry` (runs, queue depth, failure
  rates, provider reliability, webhook and indexing health).
- Unit tests and GitHub Actions verification.

## Local setup

Requirements: Node.js 22+, a Daytona API key, and either a managed model key or a user-connected
Codex/OpenAI/Anthropic account. The dedicated Supabase project is already provisioned; its
server-side secret key is still required locally.

```powershell
npm install
npm --prefix shell\web install
npm --prefix shell\web run dev
node shell\server\index.mjs
```

The ignored local environment files already contain the dedicated project URL and publishable key.
Add the server-only Supabase secret, Daytona key, and a model-provider key to `shell/.env` before a
live durable run. Use `CODE_AGENT_STORE=memory` for a disposable local control plane or
`CODE_AGENT_STORE=supabase` for durable runs. Private repositories use short-lived GitHub App
installation tokens; `GITHUB_AGENT_TOKEN` remains a temporary development fallback.

The web app runs on `http://localhost:5173` and proxies API requests to the shell server according
to the existing Vite configuration.

Production is hosted separately from Buildr101 at `app.thrallo.com`, even though both products
share the same VPS. See [docs/DEPLOY.md](docs/DEPLOY.md).

## Verification

```powershell
npm run verify
```

This runs the Thrallo contract, tenant-isolation, cancellation, provider-wire, and agent-loop
tests, then creates a production web build.

## Roadmap

Completed: encrypted per-user Codex, OpenAI, Anthropic, and Gemini connections with smart managed
routing and provider evaluations; encrypted incremental hybrid repository indexing; language-aware
symbol/reference graphs; manual and GitHub-triggered repository refreshes; agent context retrieval;
subscription plans with managed usage budgets; and operational telemetry.

1. Rich approval policies, sandbox snapshots, retry/resume, and object-storage artifacts.
2. Live Stripe pricing, rate controls, abuse defenses, retention, and disaster recovery.
3. Code OSS desktop application with local indexing, inline completion, chat/edit/agent modes.
4. Review agents, automations, CLI/SDK/plugin system, enterprise controls, and mobile companion.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the component and security boundaries.
