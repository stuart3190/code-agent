# Thrallo architecture

## Request path

```text
React workspace
  -> bearer-authenticated /api/v1
  -> owner-scoped control-plane store
  -> queued ca_runs row
  -> single-claim worker
  -> Daytona sandbox + dedicated git branch
  -> encrypted incremental repository index + symbol/reference graph + hybrid context retrieval
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

Definitions, signatures, and qualified names are also AES-GCM encrypted. HMAC hashes make
owner-scoped exact symbol lookup possible without plaintext names. Relationship rows connect
imports, calls, references, inheritance, and file dependencies using opaque IDs and hashes. The
browser receives only decrypted results from owner-authenticated routes. Manual refreshes and
default-branch GitHub pushes enter a durable `FOR UPDATE SKIP LOCKED` queue; a newer push received
during indexing remains queued for a follow-up pass.

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

## Subscriptions, budgets, and telemetry

`ca_subscriptions` is a service-role-only row per owner holding the plan, Stripe identifiers,
billing period, and optional budget overrides. The plan catalog is code-defined with
env-overridable allowances; paid prices surface only when `THRALLO_<PLAN>_PRICE_GBP` is set, and
Stripe checkout/portal/webhook wiring stays dormant until the dedicated `THRALLO_STRIPE_*`
secrets exist. A missing row means the active free plan.

Budget metering sums `ca_usage_records` (tagged with a `billing_source` of managed, byok, or
codex) and non-cancelled run counts over the current period — the Stripe billing window when
one is active, otherwise the UTC calendar month. Run-count and sandbox-compute budgets apply to
every run; the managed-token budget applies only to managed-key runs. Personal spend guards may
only tighten the plan allowance. Enforcement happens three times: run creation returns 402
`budget_exceeded`, the worker re-checks before provisioning (a queued run can outlive its
allowance), and the coding loop aborts a managed run whose accumulated tokens pass the remaining
budget. Failed runs still persist their token usage so budget accounting cannot be escaped by
erroring out.

`/api/v1/ops/telemetry` is gated by the verified-email `ADMIN_EMAILS` allowlist and aggregates
bounded windows of runs (state counts, failure rate, duration, queue depth), webhook-ledger
health, provider reliability from `ca_model_attempts`, platform usage by billing source, and
repository-index states. It reads existing durable tables on demand; a rollup table can replace
the aggregation once traffic outgrows it.

## Publish policies, resume, and artifact storage

Each agent carries a `publish_mode` — `require_approval` (default) or `auto_publish` — plus
`protected_paths` globs. When a run finishes with a diff on a GitHub App repository, the worker
evaluates the policy against the touched paths from `git status`: auto-publish commits, pushes,
and opens the pull request immediately; a touched protected glob (or a publication failure)
falls back to the manual approval gate with the reason recorded on the run result. Glob
matching is segment-aware (`*` stays within one path segment, `**` crosses segments, a bare
directory protects everything beneath it).

A failed or interrupted run no longer discards its sandbox: the workspace is stopped and marked
`preserved`, and Daytona's auto-stop/archive/delete limits cap its cost and lifetime. Resuming
creates a new run linked by `resumed_from_run_id`; the worker re-attaches to the preserved
sandbox and branch, briefs the agent with the previous error and progress summary, and tells it
to inspect the existing uncommitted changes before continuing. Ownership of the sandbox
transfers to the resuming run, and an expired sandbox falls back to a clean clone with an
explicit timeline event. Budget checks treat a resume as a new run.

Artifact content above `CODE_AGENT_ARTIFACT_INLINE_BYTES` (16 KB default) is written to the
private `thrallo-artifacts` Supabase Storage bucket instead of the Postgres row; the bucket has
no browser policies, so only the service role touches it and the shell streams content to
authenticated owners via the artifact-content route.

## Network and command policies, rate controls, and retention

Agents carry a `network_policy` (`full` or `offline`) and a `command_policy` (`standard` or
`restricted`). Offline sandboxes are blocked with Daytona's network controls immediately after
checkout — failing closed if blocking fails — and the block is lifted only for publication.
Codex subscription runs execute Codex's own tooling inside the sandbox and keep network access
under an explicit timeline warning. The restricted command policy refuses network-transfer,
remote-shell, privilege-escalation, DNS, and mail commands inside the tool loop; the refusal is
returned to the model as a policy error and the run continues. Package publication and `git
push` from inside the workspace are refused under every policy — publication always goes
through the approval-gated server path.

Run admission is bounded per owner independent of the monthly budget: at most
`CODE_AGENT_MAX_ACTIVE_RUNS` concurrent runs and `CODE_AGENT_RUNS_PER_HOUR` admissions per
rolling hour. Past-due paid subscriptions are metered at free-plan limits until Stripe reports
recovery, without relabeling the owner's plan.

A retention sweeper prunes run timelines (`ca_run_events`) and artifact content (rows plus
storage objects) for runs finished more than `CODE_AGENT_RETENTION_DAYS` ago (90 by default, 0
disables), marking each run `pruned_at`. Runs, checkpoints, and usage records are kept — they
are the billing and audit history.

## Editor clients and API tokens

`ca_api_tokens` stores SHA-256 hashes of `thrallo_pat_` personal access tokens (plaintext shown
once at creation, at most ten active per owner, revocable, last-use tracked). The shell's
bearer authentication accepts either a Supabase session JWT or a PAT; PAT identities carry no
verified email, so they can never pass the `ADMIN_EMAILS` operator gate, and token management
routes require a real signed-in session so a leaked PAT cannot mint further tokens.

`editor/vscode` is a zero-dependency VS Code extension speaking the same owner-scoped v1 API:
agents tree view, task launching, SSE timeline streaming into an output channel, side-by-side
diff review, modal approve/decline for pull-request publication, and resume for preserved
workspaces. Its API client (`editor/vscode/lib/api.js`) has no `vscode` import and is covered
by the repository test suite.

## Review agents

A review run carries an optional `pull_request` number. The worker checks the PR head out into
a local review branch inside the sandbox (token-authenticated fetch with the token redacted
from any error), computes the diff against the base branch, and embeds it (bounded) in the
review prompt. The review toolset removes `write_file` — the reviewer reads code and may run
tests, but cannot edit — and the same command and network policies apply. The agent must
answer with a single JSON review (verdict, summary, findings with path/line/severity); parsing
tolerates fenced blocks and degrades unparseable answers to a comment-only review. Artifacts
persist `review.md`, `review.json`, and the PR patch.

Posting is approval-gated exactly like publication: the run waits with a `post_review` action,
and approval posts a GitHub review through the App installation — verdict mapped
conservatively (approve only with no major findings, blockers force request-changes), findings
anchored as inline comments where GitHub accepts them, with a body-only retry when it does
not. Reviews without a pull request complete directly with findings as the result.

## Automations

`ca_automations` is service-role only and holds two kinds. `pr_review` automations fire from
the GitHub webhook worker on `pull_request` opened / ready-for-review deliveries (the App must
subscribe to the Pull request event): drafts are skipped unless opted in, and the created run
is a normal review run unless the automation's `autoPost` flag explicitly opts out of the
approval gate — in which case the finished review posts directly, falling back to manual
approval if posting fails. `scheduled_task` automations run every 1–168 hours; a sweeper
claims due rows optimistically (advancing `next_run_at` so concurrent sweepers cannot
double-fire) and creates agent or review runs.

Every automated run passes the same admission guards as a manual one — rate limits and
budgets — and carries `automation_id` provenance on the run row. A rejected or failed trigger
is recorded on the automation (`last_error`) and skipped rather than retried.

## Known production gaps

- Live Stripe pricing, richer dunning, and disaster recovery.
- Extension marketplace publication, inline completion, desktop packaging, CLI/SDK, and
  mobile.
