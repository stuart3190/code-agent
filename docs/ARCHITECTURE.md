# Code Agent architecture

## Request path

```text
React workspace
  -> bearer-authenticated /api/v1
  -> owner-scoped control-plane store
  -> queued ca_runs row
  -> single-claim worker
  -> Daytona sandbox + dedicated git branch
  -> commercial model adapter
  -> strict coding tools
  -> ordered run events + final diff/status
  -> authenticated SSE stream
```

## Trust boundaries

The browser is untrusted. It can read presentation-safe owner metadata and call the control plane
with a Supabase access token. It never receives service-role, model, GitHub, or Daytona secrets.

The shell verifies the bearer token and derives ownership from the authenticated subject. Owner IDs
from request bodies are ignored. The service-role client is restricted to orchestration paths.

The worker is trusted with platform credentials but passes only the clone credential required for a
single repository into Daytona. The sandbox is disposable, receives a dedicated branch, and has
automatic stop/archive/delete limits.

## Persistence

`ca_runs` is the durable state machine. `ca_run_events` is its append-only presentation stream.
Sequence numbers make clients resumable using `Last-Event-ID` or the `after` query parameter.
Sensitive tool payloads and index material are not granted to authenticated browser clients.
Completed runs persist separate diff, git-status, and summary artifacts plus normalized usage
records. Stale active runs are marked interrupted on worker startup and can be retried from a clean
repository baseline.

Production uses `CODE_AGENT_STORE=supabase`. `memory` exists for local interface work and fast unit
tests only; it intentionally does not survive a process restart.

## Current state machine

```text
queued -> provisioning -> running -> succeeded
    |          |            |
    +----------+------------+-> failed
    +----------+------------+-> cancelled
```

The schema already reserves indexing, approval, user-wait, interruption, checkpoints, artifacts,
usage records, and encrypted-path index tables for the next slices.

## Model loop

The OpenAI adapter calls the Responses API with `store: false`, a hashed safety identifier, strict
function schemas, and parallel tool calls disabled. Every output item is round-tripped so reasoning
items survive across tool turns. Tool results are returned with their original `call_id`.

The Anthropic adapter translates the same neutral tool history to the Messages API and maps tool
calls and usage back into the orchestrator contract. `CODE_AGENT_DEFAULT_PROVIDER` controls `auto`
selection; explicit model values may use `openai:model` or `anthropic:model`.

The orchestrator allows at most 25 turns and checks cancellation before every model turn and tool
call. Commands are bounded by a 600-second maximum and repository paths reject traversal.

## Known production gaps

- Durable/idempotent GitHub webhook delivery ledger and installation lifecycle synchronization.
- Sandboxed network egress allowlist and policy approvals.
- Gemini, encrypted per-user BYOK, and managed provider-routing policy.
- Artifact object storage and checkpoint resume.
- Incremental repository indexer and symbol graph.
- Billing, budgets, abuse protection, observability, retention controls, and disaster recovery.
- Desktop editor, extension host, completion service, review agents, automations, CLI, and mobile.
