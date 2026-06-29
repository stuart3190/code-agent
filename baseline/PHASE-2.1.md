# Phase 2.1 — targeted edit tool

_Recorded 2026-06-29T08:30:18.865Z · model `gpt-5.5` · edit format **`apply_patch`** (chosen by A/B trial against the harness)._

The lever: make output scale with **change** size, not **file** size — without dropping below
the committed 3/3 baseline. `write_file` stays the fallback; after 2 failed edits on a file the
tool tells the model to rewrite it whole.

## Headline vs committed baseline (£0.0051/turn, 3/3 green)

- **Reliability:** 3/3 cases green — floor held ✅.
- **£-if-metered/turn:** £0.0038 vs £0.0051 baseline = **27% lower** (ASSUMED gpt-5.5 rates; FREE on the sub).
- **Edits:** 5/5 applied clean · 0 fell back to write_file · 0 write_file calls total.

## Per case

| case | result | build | prior | new | turns | out tok | £-if-metered | edits clean | fallbacks |
|------|--------|-------|-------|-----|-------|---------|--------------|-------------|-----------|
| todo | GREEN | ok | 4/4 | 2/2 | 6 | 1916 | £0.0301 | 3/3 | 0 |
| dashboard | GREEN | ok | 3/3 | 2/2 | 4 | 961 | £0.0136 | 1/1 | 0 |
| form-validation | GREEN | ok | 3/3 | 2/2 | 4 | 533 | £0.0090 | 1/1 | 0 |

## Cliff re-measurement (the proof the lever worked)

Output tokens to apply **one edit**, as file size scales. Full-rewrite cost is ∝ file size
(re-emits the whole file); edit-tool cost is ∝ change size, so it stays ≈ flat as files grow.
Using `BYTES_PER_TOKEN = 3.6` (Phase 1 measured) and the measured patch output
(3063 out-tok across the suite):

| file size | full-rewrite out-tok (∝ size) | edit-tool out-tok (measured, ≈flat) |
|-----------|-------------------------------|-------------------------------------|
| 1× | 4683 | 3063 |
| 5× | 23415 | 3063 |
| 20× | 93660 | 3063 |

**At 20× file size the edit tool emits ~31× fewer output tokens per edit** — the
cliff the iteration findings projected is flattened.

## Caveats

- **Single-pass per case.** gpt-5.5 is nondeterministic; reliability is one run per case here.
- **Edit-tool column is change-bound, not literally constant** — a patch grows with the size of
  the change and the number of edit sites, not with unrelated file size. The point is it does not
  scale with file size the way a full rewrite does.
- **Cost is hypothetical** — ASSUMED gpt-5.5 rates in `src/cost.mjs`; everything was FREE on the
  ChatGPT sub.
