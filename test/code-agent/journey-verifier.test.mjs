// PR6 — the contract's journeys are driven in a real browser against the real preview.
//
// The existing verifier proves the app LOADS. It cannot prove the app DOES what was agreed,
// because until PR4 nothing had written down what was agreed. "The page rendered" and "a booking
// made in this browser is still there after a reload" are different claims, and only the second is
// what the customer asked for.
//
// These tests use a real Chromium against a real static server — a fake page object would prove
// the test harness works, not the driver.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { verifyJourneys, journeyFailures, journeySummary } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

// A tiny app that really works: a form that stores to a server-side map and survives a reload.
const WORKING = `<!doctype html><html><body>
<h1>Book a slot</h1>
<div id="app">
  <p>Available slots</p>
  <form id="f">
    <label>Name <input name="name" /></label>
    <label>Email <input type="email" name="email" /></label>
    <button type="submit">Confirm booking</button>
  </form>
  <p id="out"></p>
</div>
<script>
  const out = document.getElementById("out");
  const saved = localStorage.getItem("ref");
  if (saved) out.textContent = "Your booking reference is " + saved;
  document.getElementById("f").addEventListener("submit", (e) => {
    e.preventDefault();
    const ref = "BK-" + Math.floor(Math.random() * 9000 + 1000);
    localStorage.setItem("ref", ref);
    out.textContent = "Your booking reference is " + ref;
  });
</script>
</body></html>`;

// The same page with the confirmation removed: submits, says nothing, stores nothing.
const BROKEN = WORKING
  .replace('out.textContent = "Your booking reference is " + ref;', "/* nothing happens */")
  .replace('if (saved) out.textContent = "Your booking reference is " + saved;', "");

let server = null;
let baseUrl = "";
let body = WORKING;

before(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
});

after(async () => { await new Promise((resolve) => server?.close(resolve)); });

const CONTRACT = {
  journeys: [{
    id: "book", title: "A visitor books a slot", priority: "primary",
    steps: [
      { action: "open the booking page", target: "/", expect: "the available slots are visible" },
      { action: "enter name and email", target: "details form", expect: "the fields accept the details" },
      { action: "click confirm booking", target: "confirm button", expect: "a booking reference is shown" },
    ],
  }],
};

test("a working journey passes against a real browser", needsBrowser, async () => {
  body = WORKING;
  const result = await verifyJourneys({ previewUrl: baseUrl, contract: CONTRACT, timeoutMs: 90_000 });

  assert.equal(result.pass, true, `journeys: ${journeySummary(result)}`);
  assert.equal(result.primaryStatus, "pass");
  assert.deepEqual(result.failures, []);
  // Every step was really driven, not skipped past.
  const steps = result.journeys[0].steps;
  assert.equal(steps.length, 3);
  assert.ok(steps.every((s) => s.status === "pass"), JSON.stringify(steps, null, 1));
  assert.match(journeySummary(result), /book:pass/);
});

test("a journey whose confirmation never appears FAILS", needsBrowser, async () => {
  // The class this exists for: the form submits, the page looks finished, and nothing happened.
  // `npm run build` passes on this. So does "the app loads".
  body = BROKEN;
  const result = await verifyJourneys({ previewUrl: baseUrl, contract: CONTRACT, timeoutMs: 90_000 });

  assert.equal(result.pass, false, `expected a failure; got ${journeySummary(result)}`);
  assert.equal(result.failures.length, 1);

  const failures = journeyFailures(result);
  assert.ok(failures.length, "a failure must produce something a repair brief can act on");
  assert.match(failures[0], /the journey "A visitor books a slot" fails at/);
  assert.match(failures[0], /reference/, "and it names what was expected but missing");
});

test("console errors and failed requests are collected as evidence", needsBrowser, async () => {
  body = WORKING.replace("<script>", '<script>console.error("boom-from-the-app"); fetch("/missing-endpoint").catch(()=>{});\n');
  const result = await verifyJourneys({ previewUrl: baseUrl, contract: CONTRACT, timeoutMs: 90_000 });
  assert.ok(result.consoleErrors.some((e) => /boom-from-the-app/.test(e)));
  body = WORKING;
});

test("the primary journey is driven first, so a timeout still proves what gates the preview", needsBrowser, async () => {
  body = WORKING;
  const twoJourneys = {
    journeys: [
      { id: "secondary", title: "Something else", priority: "secondary",
        steps: [{ action: "open /", expect: "the page loads" }, { action: "look", expect: "slots are visible" }] },
      CONTRACT.journeys[0],
    ],
  };
  const result = await verifyJourneys({ previewUrl: baseUrl, contract: twoJourneys, timeoutMs: 90_000 });
  assert.equal(result.journeys[0].priority, "primary", "the primary journey runs before the others");
  assert.equal(result.pass, true);
});

test("a verifier that cannot start is reported as unavailable, never as a broken app", async () => {
  // An unreachable preview must not be read as "the journeys failed" — that would fail a build
  // over infrastructure, which is the confidently-wrong mistake in the most expensive place.
  const result = await verifyJourneys({
    previewUrl: "http://127.0.0.1:1/", contract: CONTRACT, timeoutMs: 8_000,
  });
  assert.notEqual(result.pass, true);
  // Either it could not start at all, or every step was undriveable — never a confident "fail".
  if (!result.unavailable) {
    assert.notEqual(result.primaryStatus, "fail",
      "an unreachable preview must not produce confident journey failures");
  }
});

test("a contract with no journeys produces no verdict rather than a pass", async () => {
  const result = await verifyJourneys({ previewUrl: baseUrl, contract: { journeys: [] }, timeoutMs: 5_000 });
  assert.equal(result.pass, null);
  assert.equal(journeySummary(result), "no journeys");
});

test("journeyFailures turns a verdict into something a repair can act on", () => {
  const failures = journeyFailures({
    failures: [{
      title: "A visitor books a slot",
      steps: [
        { status: "pass", action: "open the page" },
        { status: "fail", action: "click confirm", detail: "expected reference; found none" },
      ],
    }],
    consoleErrors: ["TypeError: x is not a function"],
    failedRequests: ["500 POST /api/book"],
  });
  assert.equal(failures.length, 3);
  assert.match(failures[0], /fails at "click confirm": expected reference/);
  assert.match(failures[1], /browser console reports/);
  assert.match(failures[2], /network request failed: 500 POST/);
  // A passing step is not reported as a failure.
  assert.ok(!failures.some((f) => /open the page/.test(f)));
});
