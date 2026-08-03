// The publish success experience: sharing, the deployment vocabulary, and the panel's two states.
//
// The panel sits above every conversation forever, so what it shows permanently and what it shows
// for a moment are different questions. These cover the logic behind that split, plus the two
// defects that made the celebration meaningless: it belonged to no project and never ended.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { shareUrl } from "../../shell/web/src/lib/share.js";
import {
  DEPLOY_STATUS, DEPLOY_LABEL, DEPLOY_TONE, TERMINAL_STATUSES,
  isDeploymentSettled, isDeploymentMoving,
} from "../../shell/shared/deploymentState.mjs";

const read = (p) => readFile(fileURLToPath(new URL(p, import.meta.url)), "utf8");

/**
 * Source with comments removed.
 *
 * This codebase deliberately documents what each fix replaced, so a negative assertion against the
 * raw text matches the prose explaining the bug and fails on a file that is correct. Only the code
 * should be asserted against.
 */
const readCode = async (p) => (await read(p))
  // CRLF first: `.` does not match \r, so `//.*$` never reaches the end of a Windows line and the
  // stripper silently does nothing.
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((line) => line.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

// ── Sharing ─────────────────────────────────────────────────────────────────────────────

function withNavigator(stub, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "navigator");
  const previous = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { value: stub, configurable: true, writable: true });
  return Promise.resolve(run()).finally(() => {
    if (had) Object.defineProperty(globalThis, "navigator", { value: previous, configurable: true, writable: true });
    else delete globalThis.navigator;
  });
}

test("the OS share sheet is used where it exists", async () => {
  const shared = [];
  await withNavigator({
    share: async (payload) => { shared.push(payload); },
    clipboard: { writeText: async () => { throw new Error("clipboard must not be used"); } },
  }, async () => {
    assert.equal(await shareUrl("https://focusflow.app.thrallo.com", "FocusFlow"), "shared");
  });
  assert.deepEqual(shared, [{ title: "FocusFlow", url: "https://focusflow.app.thrallo.com" }]);
});

test("without it, the link is copied and the caller is told which happened", async () => {
  const copied = [];
  await withNavigator({ clipboard: { writeText: async (v) => copied.push(v) } }, async () => {
    assert.equal(await shareUrl("https://focusflow.app.thrallo.com"), "copied",
      "the button must be able to say Copied rather than guessing it shared");
  });
  assert.deepEqual(copied, ["https://focusflow.app.thrallo.com"]);
});

test("closing the share sheet copies nothing", async () => {
  // Falling back to the clipboard here would put something on it the user did not ask for.
  const copied = [];
  await withNavigator({
    share: async () => { const e = new Error("cancelled"); e.name = "AbortError"; throw e; },
    clipboard: { writeText: async (v) => copied.push(v) },
  }, async () => {
    assert.equal(await shareUrl("https://x.thrallo.com"), "dismissed");
  });
  assert.deepEqual(copied, [], "a decision is not a failure");
});

test("a share that fails for any other reason still copies", async () => {
  const copied = [];
  await withNavigator({
    share: async () => { throw new Error("permission policy"); },
    clipboard: { writeText: async (v) => copied.push(v) },
  }, async () => {
    assert.equal(await shareUrl("https://x.thrallo.com"), "copied");
  });
  assert.deepEqual(copied, ["https://x.thrallo.com"]);
});

test("nothing to share is not an error", async () => {
  await withNavigator({}, async () => {
    assert.equal(await shareUrl(""), "dismissed");
    assert.equal(await shareUrl(null), "dismissed");
  });
});

// ── Deployment vocabulary, shared with the server ───────────────────────────────────────

test("polling stops at every status a deployment stops moving from", () => {
  for (const status of [DEPLOY_STATUS.live, DEPLOY_STATUS.failed, DEPLOY_STATUS.rolledBack, DEPLOY_STATUS.superseded]) {
    assert.equal(isDeploymentSettled(status), true, `${status} is terminal`);
    assert.equal(isDeploymentMoving(status), false);
  }
  for (const status of [DEPLOY_STATUS.building, DEPLOY_STATUS.deploying]) {
    assert.equal(isDeploymentSettled(status), false, `${status} is still going`);
    assert.equal(isDeploymentMoving(status), true);
  }
  // A surface polling on a value it does not understand would never stop.
  assert.equal(isDeploymentSettled("nonsense"), false);
  assert.equal(isDeploymentMoving("nonsense"), false,
    "an unknown status must not start an endless poll");
});

test("rolled_back and superseded are terminal — a rollback is not 'still deploying'", () => {
  assert.ok(TERMINAL_STATUSES.includes("rolled_back"));
  assert.ok(TERMINAL_STATUSES.includes("superseded"));
});

test("every deployment status has a label and a tone", () => {
  for (const status of Object.values(DEPLOY_STATUS)) {
    assert.ok(DEPLOY_LABEL[status], `${status} needs a label`);
    assert.ok(DEPLOY_TONE[status], `${status} needs a tone`);
  }
});

test("no surface keeps its own copy of the deployment vocabulary", async () => {
  const view = await read("../../shell/web/src/publish/DeploymentsView.jsx");
  assert.doesNotMatch(view, /const STATUS_LABEL = \{/,
    "labels come from the shared module, so a tab and a panel cannot disagree");
  assert.match(view, /deploymentState\.mjs/);

  const service = await read("../../shell/server/lib/deployments/deploymentService.mjs");
  assert.doesNotMatch(service, /export const DEPLOY_STATUS = Object\.freeze/,
    "the server re-exports the shared vocabulary rather than defining a second one");

  // Both pollers stop on the same shared answer.
  const hook = await read("../../shell/web/src/publish/publishState.js");
  assert.match(hook, /isDeploymentSettled/, "the publish panel's poll stops on terminal statuses");
  assert.match(view, /isDeploymentSettled/, "and so does the Deployments tab's");
});

// ── The two panel states ────────────────────────────────────────────────────────────────

test("the celebration is scoped to a project and expires", async () => {
  const shell = await readCode("../../shell/web/src/chat/ChatShell.jsx");

  assert.doesNotMatch(shell, /celebrate=\{!!justPublished\}/,
    "truthiness ignored WHICH project published, so any other project celebrated too");
  assert.match(shell, /celebratingProjectId/, "the celebration names a project");
  assert.match(shell, /PUBLISH_SUCCESS_DURATION_MS/, "and ends on a timer rather than at the next publish");
  assert.match(shell, /setJustPublished\(null\); \}, \[active\?\.id\]\)/,
    "switching conversation ends it too — a celebration belongs to a moment");
});

test("the success duration is configurable, not a magic number", async () => {
  const lifecycle = await read("../../shell/web/src/publish/publishLifecycle.js");
  assert.match(lifecycle, /VITE_PUBLISH_SUCCESS_MS/, "overridable without a code change");
  assert.match(lifecycle, /PUBLISH_SUCCESS_DURATION_MS/);

  const { PUBLISH_SUCCESS_DURATION_MS } = await import("../../shell/web/src/publish/publishLifecycle.js");
  assert.equal(PUBLISH_SUCCESS_DURATION_MS, 30_000, "with a sensible default");
});

test("Open Site always opens in a new tab", async () => {
  // Losing the Thrallo session to look at your own site would be an odd trade.
  const panel = await read("../../shell/web/src/publish/PublishedPanel.jsx");
  const links = panel.match(/<a[^>]*className="ct-btn"[^>]*>/g) || [];
  assert.ok(links.length > 0, "the Open Site link was found");
  for (const link of links) {
    assert.match(link, /target="_blank"/, "every Open Site link opens a new tab");
    assert.match(link, /rel="noopener noreferrer"/, "and never hands the opener over");
  }
});

test("the version is a link to that exact deployment", async () => {
  const panel = await read("../../shell/web/src/publish/PublishedPanel.jsx");
  assert.match(panel, /onDeployments\(deployment\.id\)/,
    "clicking #7 opens Deployments on #7 rather than the top of a list");

  const dashboard = await read("../../shell/web/src/publish/ProjectDashboard.jsx");
  assert.match(dashboard, /focusId=\{buildRef\}/, "the id travels through the URL");

  const view = await read("../../shell/web/src/publish/DeploymentsView.jsx");
  assert.match(view, /id=\{`deployment-\$\{d\.id\}`\}/, "so the card can be found and scrolled to");
});

test("View Logs never falls back to the whole stream", async () => {
  const panel = await read("../../shell/web/src/publish/PublishedPanel.jsx");
  // The rule PR 6 established: without a build run there is no exact log to open, and a button
  // that quietly shows something else is worse than none.
  assert.match(panel, /onLogs && deployment\?\.buildRunId/);
  assert.doesNotMatch(panel, /onLogs\(\)/, "it is never called without a run id");
});

test("the resting panel stays small; the rest is one click away", async () => {
  const panel = await read("../../shell/web/src/publish/PublishedPanel.jsx");
  assert.match(panel, /aria-expanded=\{more\}/, "a real disclosure, not hidden chrome");
  assert.match(panel, /ct-published-more/);
});

test("the thread receipt names the version instead of repeating the panel", async () => {
  const state = await read("../../shell/web/src/chat/conversationState.js");
  assert.match(state, /Deployment #\$\{payload\.deploymentNumber\} is live/);

  const service = await read("../../shell/server/lib/appBuild/appPublishService.mjs");
  assert.match(service, /deploymentNumber: deployment\.number/, "the event carries the number");
});

test("relativeTime and displayUrl are defined once", async () => {
  const state = await read("../../shell/web/src/publish/publishState.js");
  assert.doesNotMatch(state, /export function relativeTime/,
    "two copies with different importers is how they drift apart");
  assert.doesNotMatch(state, /export function displayUrl/);
  assert.match(state, /export \{ relativeTime, displayUrl \} from "\.\/publishLifecycle\.js"/);
});
