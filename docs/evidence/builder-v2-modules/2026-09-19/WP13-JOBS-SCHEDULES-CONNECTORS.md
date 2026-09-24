# WP13 — Jobs, scheduling and integrations (2026-09-19)

The audit's proof for this package: provider-disabled contract tests, queue lifecycle, quotas and
isolation, with provider, connector and job wrappers removed.

## Architectural change

- **Jobs** `src/lib/modules/jobs.js`: an idempotency key derived from the action and its input, so a double-clicked button, a retried effect and a replayed queue message are one job rather than three charges. The key is insensitive to input key order. The usage balance is checked BEFORE dispatch, so a quota refusal names the shortfall instead of arriving at settlement after the work ran. Waiting prefers the live subscription and releases it; with no subscription it polls with backoff and a deadline, rather than the fixed 1.5-second loop that never stopped when the screen unmounted.
- **Schedules** (same runtime): an occurrence key — the schedule plus the exact slot it is for — makes a repeat a no-op, so two workers seeing one schedule due produce one run between them. The occurrence is CLAIMED before dispatch, because claiming after leaves the window that lets both dispatch. Time zones are honoured by offset, since a daily schedule that drifts an hour twice a year is one nobody trusts. Resuming after a pause does not replay missed slots.
- **Connectors** `src/lib/modules/connectors.js`: a connector names the one https host it may reach, and a private or metadata address is refused at compile time. Secrets are REFERENCES; the value comes from the deployment at call time and never enters a contract, a composed file or an error. Responses are validated against a declared shape, so a provider changing its payload is a named failure rather than `undefined` three screens later. Only idempotent methods retry, only on transient statuses, with backoff — retrying a POST is how one charge becomes three.
- **Provider families**: `aiActions`, `media`, `documents`, `knowledge` and `metaConnector` are registered as manifests over operation families the capability runtime already implements. They add no new implementation; what they add is the availability gate, which is the audit's "unavailable services remain unavailable". A declared action names its family, and a deployment without that provider blocks before generation.
- **Plan** `platformModules/automationPlan.mjs` reads declared actions, schedules and connectors, and names the family each action needs.

## What is claimed, and what is not

Nothing is inferred from a domain verb. "Generate an invoice and email it daily" is a document an
application renders on a cadence somebody has to configure; it is not a request for the AI provider
family and not a schedule. A cadence stated in prose is recorded as a mention, because a recurring
job nobody configured is worse than none.

A schedule pointing at an action the contract never declared is refused with its reason, because a
schedule that fails silently at 3am is the worst kind.

## Compatibility

- The SDK's `actions` and `usage` surfaces are unchanged and keep working.
- A contract declaring none of this locks no module and composes no file.
- Coverage ledger: format `automationPlan: 1`. The nine WP13 catalogue rows now point at
  registered modules.

## Two defects found while writing the coverage

**Redaction that was not redaction.** The secret pattern matched only a token's prefix, so
`sk-live-abcdefghijkl` became `[redacted]live-abcdefghijkl` in an error an application could read.
It now matches the whole token.

**A refusal that had not checked.** Cancelling a job this controller had never seen refused on
local state alone. It now fetches the job first, so "cannot be cancelled" is only said of a state
that was actually looked at.

## Tests

`builder-v2-jobs-schedules-connectors.test.mjs` (12): one job per action and input regardless of
key order, with an explicit salt for a genuine re-run; undeclared actions, missing inputs, denied
grants and exhausted quotas all refused before dispatch; waiting via subscription with release,
polling with growing intervals and a deadline, and an already-finished job returned immediately;
cancellation checked rather than assumed; one run per occurrence across retries, a second worker,
a pause and a multi-day gap; occurrence keys per cadence with a time-zone offset; egress refused
for private, metadata and non-https targets with path values encoded; response validation, secret
references, redaction, and retries only on transient statuses and idempotent methods; the plan
reading declarations and never a domain verb, with every nameable family real; composition with no
secret value composed; a provider-disabled contract blocking before generation; and a negative
control.
