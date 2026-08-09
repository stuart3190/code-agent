# Package 14S pre-compile persistence repair

Date: 2026-08-09

## Scope and result

The narrow zero-model repair is green. The durable-persistence gate remains strict, while a
structurally valid generated candidate can now be checkpointed and repaired before compilation
instead of being discarded for another full core generation.

No provider call, production mutation, migration, deployment, backup/restore operation, billing
change, router change, Caddy operation, or Package 15 work occurred.

## Root cause

The previous core loop had no resumable boundary between structural validation and compilation.
The retained live booking candidate passed patch, capability and module-plan validation, then the
honesty gate rejected two `sessionStorage` uses in `BookingFlow.jsx`. Because no `working:*`
snapshot existed, the orchestrator discarded the otherwise usable tree and spent another complete
core turn.

The cleaned-up live run retained exact diagnostics, not the complete generated source bytes. The
regression fixture therefore reproduces the evidence-backed file/API shape (two `sessionStorage`
uses in `BookingFlow.jsx`) and the exact contract/module-plan constraints; it does not claim
byte-identical reconstruction of unavailable source.

## Machine-readable generation contract

Durable journeys now produce a persistence ownership plan containing:

- durable journey IDs;
- forbidden business-persistence mechanisms;
- required platform owners and capability modules;
- each planned module's owned state, reload requirement, approved persistence capability and
  durable state owner.

For multi-step booking, `makeBookingSystem` owns durable booking records, capacity, status and the
booking reference. `makeWizardMachine` with platform persistence owns recoverable selections,
review, confirmation and cancellation state. `BookingFlow.jsx` owns ephemeral UI orchestration
only. This JSON contract is emitted as a hard generation/repair constraint.

## Early persistence verdict

The AST validator runs immediately after patch, capability, module-plan, asset and tree-integrity
checks, before compilation. It rejects contracted durable use of:

- `localStorage`;
- `sessionStorage`;
- `indexedDB`;
- `IndexedDB`;
- mutated module/global containers that claim durable state (`process_memory`).

Each finding records a stable code, file, line, byte span, API, affected journey IDs and required
platform owner(s). Parse failures are deliberate machine-readable rejections, not validator
exceptions. The existing final honesty/persistence gate remains in force and now also precedes the
expensive compiler invocation.

## Candidate lifecycle

After a tree passes structural checks it is stored as an immutable, content-addressed
`candidate:<step>:<attempt>` snapshot. Candidate snapshots are owner/project/build scoped,
materialisation-checked and explicitly non-promotable. Cancellation cleanup covers both
`candidate:*` and `working:*` snapshots.

If the narrow persistence gate passes, the same immutable snapshot is marked `working:*` and can
continue through compile, browser verification and the separate atomic green promotion. If the
worker crashes first, repair lookup can resume from the candidate. No mutable `projects.tree`
authority was introduced.

## Targeted repair boundary

One narrow persistence failure selects one repair turn. Its read context contains only:

- the exact offending file bodies;
- relevant adapter interfaces;
- relevant platform capability interfaces;
- the affected journey contract;
- the exact validator findings.

Broad project knowledge and unrelated source bodies are omitted. Writes are machine-limited to
the offending files and relevant adapters. Contract generation, completed core generation and
asset resolution are not replayed. A second persistence failure or a later gate failure stops the
attempt; it does not trigger another full regeneration.

## Deterministic proof

- The retained two-call `BookingFlow.jsx` fixture is rejected with the correct file, API, journey
  and required booking/wizard owners.
- Its immutable candidate remains materialisable and cannot be promoted.
- The orchestrator call sequence is exactly `core -> repair`; contract runs once and the invalid
  candidate never reaches compilation.
- The repair changes only `BookingFlow.jsx`, removes browser persistence and delegates durable
  state to the existing booking capability.
- The corrected candidate reaches the compiler and passes a real Vite build.
- Crash recovery locates `candidate:*` and completes a repair without replaying contract, assets or
  core generation.
- `localStorage`, `sessionStorage`, IndexedDB and fake process-memory durability remain rejected.

## Test evidence

- Focused Package 14S persistence/checkpoint/repair fixture: 7/7 passed.
- Stage/persistence compatibility suite: 69/69 passed.
- Relevant Builder V2, Package 14/14R/14S, provider, verification, snapshot and checkpoint suite:
  357/357 passed.
- Real retained-shape deterministic correction Vite compilation: passed.
- `git diff --check`: passed.

## Verdict

The deterministic Package 14S gate is green and another single live booking qualification is
technically justified under separate approval. Builder V2 quality is not yet qualified, and
Package 15 remains blocked until the live booking lifecycle reaches strict contracted green.
