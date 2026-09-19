# WP15 — Full catalogue migration and qualification (2026-09-19)

The audit's acceptance for the whole migration is three claims. This package makes them checkable
per contract rather than asserted once.

## Architectural change

- **Qualification** `platformModules/qualification.mjs` answers three questions about a derived build spec, with no provider call, so the answer is the same every time:
  1. every repeatable operation a registered module implements is module-owned;
  2. the build's journeys pass;
  3. nothing standard degraded into generated code — an unavailable module BLOCKED rather than falling back.
- **What stays generated must say what it does.** An operation keeps generation only when it declares custom work: a domain calculation, or a document whose layout is the product. The audit is explicit that format and layout vary and unique document design stays the application's. A repeatable operation with no module owner and no declared custom behaviour is the generic fallthrough the migration forbids, and is reported by name.
- **Compatibility matrix**: a stored lock keeps replaying at the versions it recorded. A pinned version that has left the registry is reported as a compatibility break, never silently upgraded.
- **Per-contract opt-in**: `qualifyCorpus` reports passing and failing contracts separately, with the reason for each failure. One project's readiness is not an average.

## The last generic fallthrough, found and closed

Running the harness over the retained corpus immediately surfaced what it was built to find: every
filtered read was still generated. "Filter visible projects by customer name and status" had been
written as a predicate over whatever page the browser happened to have loaded — a wrong answer that
looks right until the second page, and exactly the defect WP7's query module exists to remove.

`query` is now a registered capability provided by `thrallo.query`, and a read whose only work is
selecting which durable records to show binds to it. The claim is narrow on purpose: a collection
kind qualifies outright, a singular read only when it declares a read-result output. A read that
CALCULATES keeps its calculation, because claiming it would delete the one part of the operation no
module can do. Both retained contracts now qualify on all three claims.

## Compatibility

- Historical contracts and snapshots are not mutated. The suite asserts that normalising a retained
  fixture leaves both the in-memory contract and the file on disk byte-identical, and that every
  retargeted operation keeps its original verbatim with a stated reason.
- Coverage ledger: a `capability: query` row mapped to `thrallo.query` at WP15.

## What is not done, and why

Two things in the catalogue remain deliberately unimplemented, and neither is selectable, so no
build can claim them:

- **`thrallo.browser3d`** (catalogued at WP9). Its required proof is real-render, picking and
  cleanup in a browser, which is browser evidence rather than deterministic coverage.
- **Paid qualification of the live catalogue.** Every qualification here runs against derived build
  specs with no provider call. Running the corpus through real generation is a paid activity and
  needs separate approval; the harness is what makes that run cheap to judge when it happens.

## Tests

`builder-v2-catalogue-qualification.test.mjs` (8): both retained contracts qualifying on all three
claims; retained generated work declaring its own behaviour, including the export whose layout is
the product; filtered reads bound to the query module with a calculating read left generated; an
unavailable module blocking rather than degrading, and the same contract qualifying once the
service is declared; a lock replaying at its recorded versions with a break reported rather than
upgraded; historical fixtures unmutated on disk and in memory with reversible normalisation; the
ledger mapping every live capability; and per-contract qualification naming exactly what fails.
