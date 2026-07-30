# Thrallo architecture

## Request path

```text
React workspace
  -> bearer-authenticated /api/v1
  -> owner-scoped control-plane store
  -> queued ca_runs row
  -> single-claim worker
  -> Daytona sandbox + dedicated git branch
  -> encrypted incremental repository index + hybrid context retrieval
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

Repository paths and source excerpts are encrypted with AES-256-GCM before persistence. Stable
HMAC blind indexes support exact identifier lookup without storing plaintext tokens. Semantic
vectors use `text-embedding-3-small` at 1536 dimensions, and a service-role-only database function
combines token and cosine ranks. The worker indexes only bounded, Git-visible text files, skips
generated outputs and lockfiles, reuses unchanged files by content hash, and skips the entire pass
when the Git head and embedding model are current. Retrieved excerpts are marked as untrusted
source context, and the agent must verify them against the live sandbox before editing.

Production uses `CODE_AGENT_STORE=supabase`. `memory` exists for local interface work and fast unit
tests only; it intentionally does not survive a process restart.

## GitHub webhook lifecycle

The webhook route verifies GitHub's HMAC signature before parsing or persisting the payload.
`X-GitHub-Delivery` is the primary key in the server-only `ca_github_webhook_deliveries` ledger, so
redeliveries are acknowledged without repeating lifecycle work. A background worker atomically
claims pending deliveries with `FOR UPDATE SKIP LOCKED`; stale claims are recovered after ten
minutes and transient GitHub failures use bounded exponential retry.

Installation suspension or deletion disconnects every linked repository. Installation activation,
permission acceptance, and repository-selection changes refresh the authoritative installation and
accessible repository list from GitHub. New and retried agent runs reject disconnected
repositories. Raw payloads have no browser grants and a restrictive RLS deny policy.

## Current state machine

```text
queued -> provisioning -> indexing -> running -> succeeded
    |          |             |          |
    +----------+-------------+----------+-> failed
    +----------+-------------+----------+-> cancelled
```

The schema and service implement indexing, approval, interruption, checkpoints, artifacts, usage
records, and encrypted repository context. User-wait and richer resume flows remain reserved.

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

- Sandboxed network egress allowlist and policy approvals.
- Gemini, encrypted per-user BYOK, and managed provider-routing policy.
- Artifact object storage and checkpoint resume.
- Language-aware symbol/reference graph beyond the current hashed symbol extraction.
- Billing, budgets, abuse protection, observability, retention controls, and disaster recovery.
- Desktop editor, extension host, completion service, review agents, automations, CLI, and mobile.
