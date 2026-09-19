// SAVE → RELOAD RECOVERY on the retained Advanced corpus: a persisted record is judged by its state,
// never by the noun that named its indicator.
//
// 2026-09-16 attempt ca48824: the primary journey created a plan, placed and edited a fixture,
// saved ("a visible Saved status appears for Atrium Lighting Plan") and reloaded. Every contracted
// value survived (x 240, y 160, rotation 45, brightness 70, the fixture name, the plan name, the
// saved timestamp) and the verdict was still PERSISTENCE_FAILURE: "recovered state no longer
// shows: status". The recovery vocabulary was the first five keywords of the save step's prose,
// and the reloaded screen said "Saved at <time>" without the word "status". The generated app's
// persistence wiring was correct; the fault was the verifier's vocabulary, the earliest shared
// layer, and that is what these tests pin.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { durableStatusWords, recoveryEvidenceVerdict } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";

const RETAINED = new URL("./fixtures/retained/advanced-20260916/", import.meta.url);

async function retainedReload() {
  const raw = JSON.parse(await readFile(new URL("ca48824/contract.json", RETAINED), "utf8"));
  const contract = raw.contract || raw;
  const journey = contract.journeys.find((row) => row.id === "create-edit-save-plan");
  const save = journey.steps.find((step) => /^save the workspace$/.test(step.action));
  const reload = journey.steps.find((step) => /^reload the page$/.test(step.action));
  const verification = JSON.parse(await readFile(new URL("ca48824/verification-first.json", RETAINED), "utf8"));
  const verdict = verification.find((row) => row.journey_id === journey.id).verdict;
  const reloadStep = verdict.steps.find((step) => step.action === reload.action);
  // The retained observation keeps the first 600 characters of the reloaded page. The live verdict
  // proved every contracted value present (a lost value is reported AHEAD of vocabulary, and the
  // detail named only "status"), so the inspector fragment that carried them is restored here.
  const after = `${reloadStep.observation.text} INSPECTOR Pendant Light x 240 y 160 rotation 45 degrees brightness 70%`;
  return { save, reload, reloadStep, durable: reloadStep.controlEvidence.durable, after };
}

test("the retained reload evidence: the noun 'status' was the only thing lost, and the record is intact", async () => {
  const { reloadStep, durable, after } = await retainedReload();
  assert.equal(reloadStep.status, "fail");
  assert.equal(reloadStep.detail, "recovered state no longer shows: status");
  assert.deepEqual(durable.statusWords, ["saved", "status", "atrium", "lighting", "plan"]);
  for (const value of durable.values) assert.ok(after.includes(value), `${value} survived the reload`);
  assert.match(after, /Atrium Lighting Plan Saved at 2026-09-16T12/);
  // The retained (pre-fix) vocabulary fails the reload; the state itself is present.
  const retained = recoveryEvidenceVerdict(durable, after);
  assert.equal(retained.ok, false);
  assert.equal(retained.detail, "recovered state no longer shows: status");
});

test("recovery vocabulary is the lifecycle state, never the kind of indicator that shows it", async () => {
  const { save, durable, after } = await retainedReload();
  // The screen that created the record showed the state word and the indicator noun; only the
  // state word is a recovery requirement.
  const before = "PLAN TOOLBAR Atrium Lighting Plan Saved status: saved just now save control";
  const words = durableStatusWords(save.expect, before);
  assert.deepEqual(words, ["saved", "atrium", "lighting", "plan"]);
  const verdict = recoveryEvidenceVerdict({ ...durable, statusWords: words }, after);
  assert.equal(verdict.ok, true, verdict.detail);
  assert.match(verdict.detail, /same durable state after recovery/);
});

test("a reload that contradicts the saved state still fails", async () => {
  const { save, durable, after } = await retainedReload();
  const words = durableStatusWords(save.expect, "Atrium Lighting Plan Saved status");
  // The record came back as an unsaved draft: the state word is gone, the values are not.
  // The page's own marketing copy says "switch between saved plans"; page-wide word presence must
  // not stand in for the record's state, so that copy is neutralised here too.
  const draft = after.replace(/Saved at 2026-09-16T12:58:52.371Z/, "Draft, not yet stored")
    .replace(/saved plans/i, "stored plans");
  const verdict = recoveryEvidenceVerdict({ ...durable, statusWords: words, references: [] }, draft);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.detail, "recovered state no longer shows: saved");
  // A lost contracted value is reported ahead of vocabulary, as before.
  const lostValue = recoveryEvidenceVerdict({ ...durable, statusWords: words, references: [] }, after.replace("240", "999"));
  assert.match(lostValue.detail, /recovered state lost contracted values: 240/);
});

test("indicator-kind nouns are excluded whatever the record's domain; lifecycle states are kept", () => {
  const page = "Booking BK-1001 Status Confirmed. Reference BK-1001. A confirmation badge and a notification banner are shown.";
  assert.deepEqual(durableStatusWords("a Confirmed status badge and a notification banner are shown", page),
    ["confirmed"]);
  assert.deepEqual(durableStatusWords("the booking is confirmed and its reference is shown", page),
    ["booking", "confirmed", "reference"]);
  assert.deepEqual(durableStatusWords("an Archived state indicator appears on the record", "Archived state indicator record"),
    ["archived", "record"]);
});
