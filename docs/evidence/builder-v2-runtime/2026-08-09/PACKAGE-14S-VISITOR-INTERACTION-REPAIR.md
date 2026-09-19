# Package 14S — visitor-session concurrency and interaction-quality repair

Date: 2026-08-09

Status: deterministic gate PASS; no live provider call; Package 15 remains blocked.

## Scope and safety

This package changed only the shared generated visitor-session runtime and Builder V2's generic
interactive-workflow planning, validation, repair evidence and terminal quality classification.
It did not change billing, routing, modularity limits, capability grammar, publishing, Caddy,
backups, DR, customer routing or production state. No model/provider or Stripe call ran.

## Visitor-session defect and repair

The generated runtime previously allowed concurrent `ensureAppVisitorSession` callers to race. A
fresh caller stored credentials before app-auth signup had committed; later callers observed those
credentials and attempted sign-in, producing avoidable 401 responses.

The runtime now keeps an in-flight initialization authority in a `WeakMap` keyed by the backend auth
object, with a nested app-identity key. Concurrent callers await the same promise. Completion or
failure removes the flight, failure remains retryable, separate backend/app identities do not share
state, and sign-out/reset invalidates any in-flight authority before clearing the Supabase session.

Deterministic proof:

- 10 concurrent fresh callers: one app-auth signup, zero premature sign-ins, one valid shared user.
- 10 concurrent persisted callers: one recovery sign-in and one valid shared user.
- Failed initialization: every waiter receives the failure; the flight clears; the next call succeeds.
- Different auth/app identities: independent initialization.
- Reset during initialization: the result is rejected as `visitor_session_reset` and signed out.
- Exact generated `VITE_AUTH_URL` runtime path: 10 concurrent entity operations share one signup;
  sign-out followed by recovery uses one sign-in and preserves authenticated entity access.

This preserves Supabase's public app-auth/session boundary; no service-role credential is introduced
into generated or browser runtime configuration.

## Terminal quality classification

`repair_limit_reached` no longer replaces the real terminal quality evidence. When required journeys
remain red, the lifecycle records:

- `failureClassification: contracted_journeys_red`
- the final journey verdicts
- structured final verification diagnostics
- `repair_exhausted` and repair-limit details as supplemental orchestration metadata

An `undriveable` browser step is now a non-pass result everywhere preview/completion eligibility is
decided. A build cannot become green while a required control cannot be driven.

## Interaction and state-flow contract

Before generation, Builder V2 derives and validates a generic, machine-readable interaction graph
from contract journeys, entity fields, module ownership and required capability bindings. Each flow
records:

- semantic kind and purpose
- owning modules and state owner
- action, writes, reads and dependencies
- next-state and browser-observable requirement
- semantic control role/name and selected-state requirement
- durable capability/data-operation owner

Broken input ownership, missing actions, unsourced review values, mutation without inputs,
unowned durable cancellation, missing dependencies or undriveable control contracts block before
model generation. The scoped graph is included in generation and repair prompts.

## Pre-browser structural checks

The generic interaction lint checks generated modules for:

- associated labels/accessibility names and suitable semantic roles
- observable selected state for selection controls
- review modules reading contracted state values
- confirmation deriving its reference/state from durable mutation output
- rejection of locally fabricated confirmation references
- durable cancellation invoking the required capability operation

These checks supplement rather than replace browser verification.

## Repair diagnostics

For every non-pass journey step, repair context now includes the expected state before the action,
the action, expected state after, observed state, responsible modules, state owner, related
capability/data operation and downstream dependencies. A single targeted repair can address the
underlying data-flow break instead of receiving only raw browser text. The repair count is unchanged.

## Retained booking fixture

The zero-model fixture proves the generic representation supports:

1. date and slot selection with observable selected state;
2. party/contact input propagation through one draft-state owner;
3. exact review values;
4. durable mutation output as the confirmation reference;
5. reload/recovery from platform persistence;
6. capacity rejection;
7. durable cancellation and cancelled-state recovery.

It uses deterministic provider output and the shared headless capabilities; it is not a production
booking template.

## Verification

- Focused regression batch: 39/39 PASS.
- Complete relevant V2/provider/runtime/verification matrix: 413/413 PASS across 50 files.
- Package-specific interaction-quality tests: PASS.
- Exact app-auth concurrency tests: PASS.
- Retained Package 14S persistence/capability/Vite fixtures: PASS.
- `git diff --check`: PASS.
- Provider/model calls: 0.
- Production/customer mutation: 0.

## Gate decision

The deterministic repair package is green. One separately approved fresh live strict booking
qualification is technically justified. Builder V2 quality is not declared qualified until that
build reaches strict contracted green. Package 15 remains blocked.
