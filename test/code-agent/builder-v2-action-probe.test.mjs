// THE ACTION PROBE — the cheap question, finally asked of the buttons.
//
// Fields and choosers were probed before any journey ran; the contracted BUTTONS never were, even
// though every one of them already carries a machine identity in the manifest. So a hand-wired
// commit control — the run #8 shape, and the most likely thing to be broken — was invisible to
// the probe and was rediscovered eight steps into a paid journey as "the outcome never appeared".
//
// Two claims are held here:
//
//   ADDRESSING IS ANSWERED   identity, contracted name, ambiguity, absence and disabled-on-entry
//                            are five distinct, reported outcomes rather than one silent skip.
//   NOTHING IS PRESSED       activating a contracted commit button on the entry screen would
//                            create a durable record the customer never asked for. The probe
//                            locates and reports; the journeys do the driving.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

import { probeActionMechanics } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { actionIdFor } from "../../shell/server/lib/builderV2/verificationManifest.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const CONFIRM = actionIdFor("confirm booking");
const CANCEL = actionIdFor("cancel booking");

// One page, five presentations of the same contracted action — the only thing that differs is how
// the application chose to render it. A click anywhere records itself, so "nothing was pressed"
// is a measurement rather than a promise.
const PAGES = {
  identity: `<button data-thrallo-action="${CONFIRM}">Confirm booking</button>`,
  handWired: "<button>Confirm booking</button>",
  ambiguous: `<button data-thrallo-action="${CONFIRM}">Confirm booking</button>
    <button data-thrallo-action="${CONFIRM}">Confirm booking (again)</button>`,
  absent: "<p>Nothing to confirm yet.</p>",
  disabled: `<button data-thrallo-action="${CONFIRM}" disabled>Confirm booking</button>`,
};

const page = (body) => `<!doctype html><html><head><title>probe</title></head><body>
<main>${body}</main>
<script>
  window.__PRESSED__ = [];
  document.addEventListener("click", (event) => {
    window.__PRESSED__.push((event.target.textContent || "").trim());
  }, true);
</script>
</body></html>`;

let server = null;
let baseUrl = null;

before(async () => {
  server = http.createServer((request, response) => {
    const mode = (request.url || "/").replace(/^\//, "").split("?")[0] || "identity";
    response.writeHead(PAGES[mode] ? 200 : 404, { "content-type": "text/html" });
    response.end(PAGES[mode] ? page(PAGES[mode]) : "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

async function probe(mode, actions) {
  const { chromium } = requireCjs("playwright");
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext();
    const opened = await context.newPage();
    await opened.goto(`${baseUrl}/${mode}`, { waitUntil: "domcontentloaded" });
    const result = await probeActionMechanics(opened, actions);
    const pressed = await opened.evaluate(() => window.__PRESSED__);
    return { ...result, pressed };
  } finally {
    await browser.close();
  }
}

const CONFIRM_ACTION = { id: CONFIRM, primitive: "mutation", fallbackNames: ["Confirm booking"] };
const outcomeFor = (result, id) => result.outcomes.find((row) => row.id === id) || null;

test("an action carrying its machine identity is addressable, and is not pressed",
  { ...needsBrowser }, async () => {
    const result = await probe("identity", [CONFIRM_ACTION]);
    assert.equal(outcomeFor(result, CONFIRM).outcome, "addressable");
    assert.equal(outcomeFor(result, CONFIRM).addressedBy, "identity");
    assert.equal(result.probed, 1);
    assert.deepEqual(result.failures, [], "addressing is never on its own a failure");
    assert.deepEqual(result.pressed, [], "the probe must never activate a contracted action");
  });

test("a hand-wired action is reported identity_absent — the run #8 shape, before the journey",
  { ...needsBrowser }, async () => {
    const result = await probe("handWired", [CONFIRM_ACTION]);
    const outcome = outcomeFor(result, CONFIRM);
    assert.equal(outcome.outcome, "identity_absent");
    assert.equal(outcome.addressedBy, "fallback_name");
    assert.match(outcome.detail, /no machine identity/);
    assert.deepEqual(result.pressed, []);
  });

test("an identity matching several visible elements probes nothing and says why",
  { ...needsBrowser }, async () => {
    const result = await probe("ambiguous", [CONFIRM_ACTION]);
    assert.equal(outcomeFor(result, CONFIRM).outcome, "ambiguous_identity");
    assert.equal(result.skipped[0].reason, "ambiguous_identity");
    assert.equal(result.skipped[0].candidates, 2);
    // A wrong probe result is worse than none: it would spend a bounded correction on a healthy
    // control. Ambiguity is reported and nothing is touched.
    assert.equal(result.probed, 0);
    assert.deepEqual(result.pressed, []);
  });

test("an action behind a later flow step is skipped, not condemned", { ...needsBrowser }, async () => {
  const result = await probe("absent", [CONFIRM_ACTION]);
  assert.equal(outcomeFor(result, CONFIRM).outcome, "not_mounted_on_entry");
  assert.deepEqual(result.failures, [], "unknown is not broken");
});

test("a contracted action disabled on entry is an outcome, never a failure",
  { ...needsBrowser }, async () => {
    // A forward control is legitimately disabled until its form is filled. Reported so a later
    // failure on that control has its addressing evidence, and no more than that.
    const result = await probe("disabled", [CONFIRM_ACTION]);
    assert.equal(outcomeFor(result, CONFIRM).outcome, "disabled_on_entry");
    assert.deepEqual(result.failures, []);
  });

test("several contracted actions are each answered independently", { ...needsBrowser }, async () => {
  const result = await probe("identity", [
    CONFIRM_ACTION,
    { id: CANCEL, primitive: "cancellation", fallbackNames: ["Cancel booking"] },
  ]);
  assert.equal(outcomeFor(result, CONFIRM).outcome, "addressable");
  assert.equal(outcomeFor(result, CANCEL).outcome, "not_mounted_on_entry");
  assert.deepEqual(result.pressed, []);
});
