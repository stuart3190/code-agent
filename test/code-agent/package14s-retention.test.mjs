// THE EVIDENCE OF A FAILED PAID RUN, AND THE PROOF THAT IT IS ANNOUNCED.
//
// Runs #7 and #8 each cost about 6.8 credits, each failed on the generated application, and the
// only artefact that could explain either was erased by the stand-down before anyone read it.
// Run #9's source survived — and the retention ran SILENTLY: the files were on disk and neither
// `state.cleanup.retention` nor the `cleanup_complete` event mentioned them. A forensic step nobody
// can see is one that stops working unnoticed, discovered the next time it is needed, which is
// always straight after a failure.
//
// The runner needs live credentials, so this reads its source instead of executing it. What is
// asserted is therefore structural — but the properties that matter here ARE structural: retention
// must happen BEFORE the erasure it precedes, it must be reported in both places, it must not fire
// for a passing run, and it must never be able to stop the teardown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../ops/run-package14s-live-booking.mjs", import.meta.url), "utf8");

test("Package 14S uses the real medium-customer ceiling instead of a smaller qualification-only cap", () => {
  assert.match(source, /profileFor\(COMPLEXITY\.medium\)\.maxCredits/);
  assert.doesNotMatch(source, /const TOTAL_CEILING = 15/);
});
const cleanup = source.slice(source.indexOf("async function cleanup(state)"),
  source.indexOf("await mkdir(evidenceDir"));
const retain = source.slice(source.indexOf("async function retainGeneratedSource"),
  source.indexOf("async function cleanup(state)"));

test("retention runs BEFORE the erasure it precedes", () => {
  assert.ok(cleanup.length > 100, "the cleanup function was not found");
  const retained = cleanup.indexOf("retainGeneratedSource(state)");
  const erased = cleanup.indexOf("eraseProjectPermanently");
  assert.notEqual(retained, -1, "cleanup never retains the generated source");
  assert.notEqual(erased, -1, "cleanup never erases the project");
  assert.ok(retained < erased,
    "the source is retained AFTER the erasure that destroys it — the ordering is the whole point");
});

test("the retention result is announced in the state AND in the event", () => {
  // Both, because they are read by different people at different times: the event is what a human
  // watching the run sees, the state is what a later session reads back.
  assert.match(cleanup, /state\.cleanup = \{[^}]*retention/s,
    "state.cleanup does not carry the retention result");
  assert.match(cleanup, /emit\("cleanup_complete", \{[^}]*retention/s,
    "the cleanup_complete event does not carry the retention result");
});

test("a PASSING run retains nothing", () => {
  // Retention exists to explain failures. A green run's tree is not evidence of anything, and
  // keeping it would quietly widen what the stand-down leaves behind.
  assert.match(retain, /result === "pass"/,
    "retention does not exempt a passing run");
});

test("retention can never stop the teardown", () => {
  // Forensics must not gate the erasure. A throw here would leave a project standing — the exact
  // outcome the stand-down exists to prevent — in exchange for a diagnostic nicety.
  assert.match(retain, /catch \(error\)/, "retention has no failure path");
  assert.equal(/catch \(error\) \{[^}]*throw/s.test(retain), false,
    "retention rethrows, so a forensic failure would block the erasure");
  assert.match(retain, /return \{ retained: 0, error/, "a retention failure is not reported");
});

test("teardown itself is untouched: nothing is exempted from the erasure", () => {
  // The alternative design — exempting snapshots and blobs from teardown — would have bought the
  // same evidence by weakening a load-bearing guarantee. The manifest is still approved by hash and
  // the survivor check still runs.
  assert.match(cleanup, /buildProjectErasureManifest/);
  assert.match(cleanup, /approvedManifestSha256/);
  assert.match(cleanup, /Package 14S cleanup left the project/);
});

test("one zero-spend pre-dispatch repair may be archived, but never a provider attempt", () => {
  const archive = source.slice(source.indexOf("async function archiveZeroSpendPreDispatchRepair"),
    source.indexOf("async function cleanup(state)"));
  assert.match(archive, /stageCredits \|\| 0\) === 0/);
  assert.match(archive, /!\(evidence\.reservations \|\| \[\]\)\.length/);
  assert.match(archive, /!\(evidence\.aiRequests \|\| \[\]\)\.length/);
  assert.match(archive, /cannot fit a useful response inside approved headroom/);
  assert.match(archive, /state\.stages\.repair_predispatch_1/,
    "the archive must be single-use rather than an unbounded retry loop");
});

test("post-repair platform re-verification is zero-model and single-use", () => {
  const branch = source.slice(source.indexOf('} else if (STAGE === "reverify")'),
    source.indexOf('} else if (STAGE === "repair2")'));
  assert.match(branch, /state\.stages\.reverify/);
  assert.match(branch, /reservations\.length !== 1/);
  assert.match(branch, /mode: "resume_verify"/);
  assert.match(branch, /maxRepairs: 0/);
});

test("the final browser-informed repair is checkpointed, provider-bounded, and single-use", () => {
  const branch = source.slice(source.indexOf('} else if (STAGE === "repair2")'),
    source.indexOf('} else if (STAGE === "report")'));
  assert.match(branch, /state\.stages\.repair2/);
  assert.match(branch, /stageCredits \|\| 0\) !== 0/);
  assert.match(branch, /evidence\?\.reservations/);
  assert.match(branch, /evidence\?\.aiRequests/);
  assert.match(branch, /TOTAL_CEILING - current\.credits/);
  assert.match(branch, /mode: "resume_repair"/);
  assert.match(branch, /sourceBuildId: v2\.id/);
});

test("one zero-spend pre-dispatch final repair may be archived, but never a provider attempt", () => {
  const archive = source.slice(source.indexOf("async function archiveZeroSpendPreDispatchRepair2"),
    source.indexOf("async function cleanup(state)"));
  assert.match(archive, /stageCredits \|\| 0\) === 0/);
  assert.match(archive, /!\(evidence\.reservations \|\| \[\]\)\.length/);
  assert.match(archive, /!\(evidence\.aiRequests \|\| \[\]\)\.length/);
  assert.match(archive, /cannot fit a useful response inside approved headroom/);
  assert.match(archive, /state\.stages\.repair2_predispatch_1/,
    "the archive must be single-use rather than an unbounded retry loop");
});

test("one zero-spend pre-execution reverify may be archived, but never a started verification", () => {
  const archive = source.slice(source.indexOf("async function archiveZeroSpendPreExecutionReverify"),
    source.indexOf("async function cleanup(state)"));
  assert.match(archive, /stageCredits \|\| 0\) !== 0/);
  assert.match(archive, /evidence\.reservations \|\| \[\]\)\.length/);
  assert.match(archive, /evidence\.aiRequests \|\| \[\]\)\.length/);
  assert.match(archive, /evidence\.v2Builds \|\| \[\]\)\.length/);
  assert.match(archive, /state\.stages\.reverify_preexecution_1/,
    "the infrastructure retry must be bounded to one archived attempt");
});

test("an ambiguous final provider incident permits only one zero-model checkpoint re-verification", () => {
  const branch = source.slice(source.indexOf('} else if (STAGE === "reverify2")'),
    source.indexOf('} else if (STAGE === "report")'));
  assert.match(branch, /state\.stages\.reverify2/);
  assert.match(branch, /provider dispatch may have occurred/);
  assert.match(branch, /reservations\[0\]\?\.state === "held"/);
  assert.match(branch, /!\(attemptedEvidence\.aiRequests \|\| \[\]\)\.length/);
  assert.match(branch, /!\(attemptedEvidence\.patches \|\| \[\]\)\.length/);
  assert.match(branch, /mode: "resume_verify"/);
  assert.match(branch, /maxRepairs: 0/);
});

test("the qualification operator repair is exact, one-file, zero-model, and immutable", () => {
  const repair = source.slice(source.indexOf("async function applyQualificationCapacityCopy"),
    source.indexOf("async function cleanup(state)"));
  assert.match(repair, /failures\.length !== 1/);
  assert.match(repair, /capacity-is-enforced: expected date, choices, current, availability, copy; found date, choices/);
  assert.match(repair, /source\.includes\("\\r\\n"\) \? "\\r\\n" : "\\n"/,
    "the exact guarded edit must tolerate only the source snapshot's line-ending representation");
  assert.match(repair, /source\.split\(anchor\)\.length !== 2/,
    "the exact guarded edit requires one and only one source anchor");
  assert.match(repair, /source\.includes\(replacement\)/,
    "similar availability copy elsewhere must not look like this exact insertion");
  assert.match(repair, /source\.replace\(anchor, replacement\)/);
  assert.match(repair, /filesChanged: \[target\]/);
  assert.match(repair, /reason: "working:package14s-operator-capacity-copy"/);
  assert.match(repair, /providerCalls: 0, credits: 0/);
  assert.doesNotMatch(repair, /createJob|runLifecycle|runTurn/,
    "the operator patch must not gain a provider or public-job path");
});

test("the operator checkpoint receives one final zero-model verification", () => {
  const branch = source.slice(source.indexOf('} else if (STAGE === "reverify3")'),
    source.indexOf('} else if (STAGE === "report")'));
  assert.match(branch, /state\.stages\.reverify3/);
  assert.match(branch, /filesChanged\?\.length !== 1/);
  assert.match(branch, /mode: "resume_verify"/);
  assert.match(branch, /sourceBuildId: repaired\.buildId/);
  assert.match(branch, /maxRepairs: 0/);
});
