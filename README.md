# Code Agent

Code Agent is a standalone cloud coding-agent product. The first implemented slice connects a
GitHub repository, creates a persistent agent, queues a durable run, executes the task in an
isolated Daytona workspace, drives a commercial OpenAI Responses API tool loop, and streams an
ordered timeline plus the final status and diff to the web workspace.

This repository was forked from the Buildr101 backend, but it has its own `main` branch and a
`buildr-backend-baseline` tag. Do not point it at Buildr101 production data or credentials.

## What works now

- Code Agent landing page and authenticated three-pane agent workspace.
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
- Bounded coding loop, cancellation, stale-run recovery, clean-baseline retry, checkpoints,
  durable diff/log/report artifacts, terminal states, setup diagnostics, and usage capture.
- Functional usage dashboard for model tokens and sandbox compute.
- Unit tests and GitHub Actions verification.

## Local setup

Requirements: Node.js 22+, an OpenAI or Anthropic API key, and a Daytona API key. The dedicated
Supabase project is already provisioned; its server-side secret key is still required locally.

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

## Verification

```powershell
npm run verify
```

This runs the Code Agent contract, tenant-isolation, cancellation, provider-wire, and agent-loop
tests, then creates a production web build.

## Roadmap

1. Durable webhook delivery ledger plus repository installation lifecycle synchronization.
2. Add Gemini, managed cost/latency routing, encrypted per-user BYOK, and provider evaluation suites.
3. Hybrid repository indexer, incremental embeddings, symbol graph, and context retrieval.
4. Rich approval policies, sandbox snapshots, retry/resume, and object-storage artifacts.
5. Usage metering, subscriptions, budgets, rate controls, abuse defenses, and operational telemetry.
6. Code OSS desktop application with local indexing, inline completion, chat/edit/agent modes.
7. Review agents, automations, CLI/SDK/plugin system, enterprise controls, and mobile companion.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the component and security boundaries.
