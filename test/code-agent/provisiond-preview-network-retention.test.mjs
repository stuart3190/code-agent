import test from "node:test";
import assert from "node:assert/strict";

import {
  isPrunableStoppedPreviewState,
  stoppedPreviewLabelsToPrune,
} from "../../provisiond/docker.mjs";

test("stopped preview retention preserves running capacity and expires old disposable caches", () => {
  const hour = 60 * 60_000;
  const now = Date.parse("2026-08-26T12:00:00Z");
  const entries = [
    { label: "preview-newest", finishedMs: now - hour },
    { label: "preview-recent", finishedMs: now - 2 * hour },
    { label: "preview-over-retain", finishedMs: now - 3 * hour },
    { label: "preview-expired", finishedMs: now - 7 * hour },
    { label: "preview-unknown-age", finishedMs: 0 },
  ];

  assert.deepEqual(stoppedPreviewLabelsToPrune(entries, {
    olderThanMs: 6 * hour,
    retain: 2,
    now,
  }), ["preview-over-retain", "preview-expired", "preview-unknown-age"]);
  assert.deepEqual(stoppedPreviewLabelsToPrune(entries.slice(0, 2), {
    olderThanMs: 6 * hour,
    retain: 8,
    now,
  }), []);
});

test("capacity maintenance cannot prune a preview that is still being created", () => {
  assert.equal(isPrunableStoppedPreviewState("created"), false);
  assert.equal(isPrunableStoppedPreviewState("running"), false);
  assert.equal(isPrunableStoppedPreviewState("restarting"), false);
  assert.equal(isPrunableStoppedPreviewState("paused"), false);
  assert.equal(isPrunableStoppedPreviewState("exited"), true);
});
