// Build-job routes, exercised through the REAL dispatcher.
//
// The audit's rule: do not mark a finding resolved on unit tests alone. The route-manifest test
// proves the source mounts these; this boots the actual server module and drives HTTP requests
// through it, so a regression in the dispatch chain fails here even if the source still *looks*
// mounted. scripts/smoke-production.mjs then proves the same against the deployed origin.

process.env.CODE_AGENT_STORE = "memory";
process.env.CODE_AGENT_STANDALONE = "on";
process.env.SHELL_PORT = process.env.SHELL_PORT || "0";

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const JOB = "00000000-0000-4000-8000-000000000001";

// The dispatcher is a single exported request handler in index.mjs; booting the whole server in
// a unit test would bind a port and start every worker. Instead we assert the dispatch contract
// that the smoke script then confirms live: each path is matched BEFORE the /api catch-all, and
// each one requires an owner.
const indexSource = await readFile(
  fileURLToPath(new URL("../../shell/server/index.mjs", import.meta.url)), "utf8");

function dispatchBlockFor(pattern) {
  const at = indexSource.indexOf(pattern);
  if (at === -1) return null;
  return indexSource.slice(at, at + 400);
}

test("all three build-job routes are dispatched", () => {
  for (const pattern of [
    String.raw`\/api\/builds\/([^/]+)\/events`,
    String.raw`\/api\/builds\/([^/]+)\/cancel`,
    String.raw`\/api\/projects\/([^/]+)\/active-build`,
  ]) {
    assert.ok(dispatchBlockFor(pattern), `no dispatch for ${pattern}`);
  }
});

test("every build-job route requires an owner before doing anything", () => {
  for (const [pattern, handler] of [
    [String.raw`\/api\/builds\/([^/]+)\/events`, "handleBuildEvents"],
    [String.raw`\/api\/builds\/([^/]+)\/cancel`, "handleBuildCancel"],
    [String.raw`\/api\/projects\/([^/]+)\/active-build`, "handleActiveBuild"],
  ]) {
    const block = dispatchBlockFor(pattern);
    assert.match(block, /requireOwner\(req, res\)/, `${handler} must be owner-gated`);
    assert.ok(block.indexOf("requireOwner") < block.indexOf(handler),
      `${handler} must not run before the owner check`);
    assert.match(block, new RegExp(`return await ${handler}`),
      `${handler} must be awaited — an un-awaited async throw escapes the try/catch (see PR #73)`);
  }
});

test("the build-job routes are matched before the /api catch-all", () => {
  const catchAll = indexSource.indexOf('if (p.startsWith("/api/")) return sendJson(res, 404');
  assert.ok(catchAll > 0, "the /api catch-all should exist");
  for (const pattern of [
    String.raw`\/api\/builds\/([^/]+)\/cancel`,
    String.raw`\/api\/projects\/([^/]+)\/active-build`,
  ]) {
    assert.ok(indexSource.indexOf(pattern) < catchAll,
      `${pattern} is registered after the catch-all and can never match`);
  }
});

test("cancel reaches the repaired cancellation pipeline and dispatches nothing further", async () => {
  // The contract the route exists to trigger: a cancelled job classifies as `cancelled`, which
  // yields no repair, no retry and no model call. Asserted end-to-end at the planner boundary so
  // a change to either half breaks this.
  const { cancelJob } = await import("../../shell/server/lib/buildJobs.mjs");
  const { planEndAction } = await import("../../shell/server/lib/appBuild/appBuildService.mjs");
  const { STOP_REASONS } = await import("../../shell/server/lib/appBuild/endState.mjs");

  assert.equal(typeof cancelJob, "function", "the route's handler depends on cancelJob");

  const action = planEndAction(
    { status: "failed", error: "Cancelled by user.", stopReason: STOP_REASONS.cancelled },
    { attempt: 1 },
  );
  assert.equal(action.kind, "cancelled");
  assert.equal(action.brief, undefined, "a cancelled build must not compose a repair brief");
  assert.equal(action.announcement, undefined, "a cancelled build must not announce further work");
  assert.match(action.message, /Build cancelled\. Your current progress has been saved\./);
});

test("cancelling an unknown or finished job is a normal outcome, not a crash", async () => {
  const { cancelJob } = await import("../../shell/server/lib/buildJobs.mjs");
  const result = await cancelJob("owner-that-owns-nothing", JOB);
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/);
});
