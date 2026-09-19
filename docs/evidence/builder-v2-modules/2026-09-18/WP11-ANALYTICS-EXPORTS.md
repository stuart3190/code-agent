# WP11 — Analytics and exports (2026-09-18)

The audit's instruction for this package is "separate telemetry from domain metrics". Two things
wear the word analytics, they have opposite rules, and generated code conflated them.

## Architectural change

- **Telemetry** (`thrallo.analyticsEvents`): product usage. Events and their properties are allow-listed at compile time, and a property whose name contains a person — `customerEmail`, `userName` — is stripped before the schema even exists, so it cannot be sent by mistake later. Consent gates the send, not the declaration. A per-minute quota exists because a `track()` inside a render loop is a bill rather than a signal, and a telemetry failure never fails the thing being measured.
- **Domain metrics** (`thrallo.analyticsQueries`): exact answers about the customer's own records. A metric names the entity and field it reads, both checked against the compiled schema, so a metric over a field that does not exist is refused at compile time rather than returning `NaN` on a dashboard. The read is EVERY matching record, never one page: a metric over a page is a wrong answer told confidently, which is the defect this replaces. A metric may name a grant, and an unauthorised metric never reaches the data.
- **Exports** (`thrallo.exports`): a real artifact — bytes, a media type, a filename, a byte count and a row count the caller can check against what the screen claimed. Serialization is correct by construction: quoting is implemented once, and the leading `=`, `+`, `-` and `@` that turn a spreadsheet cell into a formula are neutralised. Columns are declared, so nothing leaves by accident. The download path creates a real Blob, clicks a real anchor, and revokes the object URL on the next tick rather than leaking the file for the life of the page.
- **Ownership**: an operation whose platform value is an artifact now resolves to `thrallo.exports` and is enforced as `block`. WP2 recorded that requirement as unresolved because no module existed; it exists now. The same flip applies to the WP10 requirements: files, realtime and notifications move from `warn` to `block`.
- **Plan** `platformModules/insightPlan.mjs` derives all three.

## Two defects found while writing the coverage

Both were in code written earlier in this package, caught by the regression rather than by review.

**`Number(null)` is 0.** The aggregate filtered with `Number.isFinite` after coercing, so a record
with no amount counted as a zero. An average over four bookings worth 100, 250, 50 and nothing
returned 100 instead of 133.33 — quietly, and always in the direction that looks lower than
reality. Absent values are now excluded before coercion.

**camelCase personal fields.** The personal-property test required a word boundary, so `email`
was caught and `customerEmail` was not. It now splits names into words the way the settings
singleton rule does, which is the second time this exact shape has been the bug.

## What is claimed, and what is not

Telemetry is NEVER inferred from prose. "Track the job", "room usage", "measure the beam angle" are
domain sentences, and every retained contract contains at least one; reading them as a request for
product analytics installed a telemetry stream into applications that never asked for one, which
the regression caught immediately. Telemetry comes only from the explicit build-profile signal.

Metrics are derived from a count operation, a dashboard route, or an aggregate STATEMENT — "total
revenue across all bookings", "how many", "over time" — not from the word "total", because "the
total for this quote" is one record's own field. A metric is never grouped by a free-text field:
that produces one bucket per record, which is a list wearing a chart's clothes. Fields named like
secrets are neither metrics nor export columns.

## Compatibility

- The SDK's `analytics.track` and `analytics.page` are unchanged; the module sits above them.
- No module is locked for a contract that declares none of it, and a plain CRUD contract composes
  exactly as before.
- Coverage ledger: format `insightPlan: 1`; the WP11 catalogue rows were in place from WP0 and now
  point at registered modules.

## Tests

`builder-v2-analytics-exports.test.mjs` (9): allow-listing with compile-time stripping, the consent
gate, the quota, undeclared events, personal values inside allow-listed properties, and a
telemetry outage that does not propagate; exact aggregates over a known fixture including sum,
average with an absent value, max, count, group-by and month buckets, with the average of nothing
distinguished from zero; compile-time refusal of an undeclared field and of a sum with no field,
plus an unauthorised metric that never reaches the data; CSV quoting of commas, quotes and
newlines, formula neutralisation, declared-column enforcement, and JSON/TSV in the same columns;
the filter reaching the store so the export is re-read rather than taken from a page, with
unauthorised and unknown exports refused; a real Blob, a real click and a revoked object URL;
telemetry never inferred from domain prose with metrics and exports derived from structure; a
declaring contract locking both modules and composing protected facades; and a negative control.
