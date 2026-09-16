// ACCOUNT FORM INPUT — a sign-in control that will not take a value is the app's failure.
//
// The 2026-09-16 Lumen advanced qualification (build 7739f39e) generated a sign-in form whose
// inputs re-mounted on every keystroke. Playwright's fill() retried for its 30-second default,
// the exception climbed out of prerequisite setup into the verifier's outer catch, and the run
// was reported "journey_verifier_unavailable": a PLATFORM stop that discarded four driven
// journeys and skipped repair for an app defect the browser had just proven. These tests pin the
// two halves: the account-form fills are bounded and described, and a driver exception during
// one journey's setup stays with that journey.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

import { describeInputFailure, verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

// A sign-in form whose password control never becomes editable. Playwright resolves the locator,
// waits for it to become editable and retries until its timeout - the same actionability wait
// that the re-mounting production form kept failing with "element was detached from the DOM".
const UNEDITABLE_FORM = `<!doctype html><html><body>
<h1>Lumen Layouts</h1>
<p>Create an account to open the workspace</p>
<form id="auth">
  <label for="email">Email</label><input id="email" type="email" />
  <label for="password">Password</label><input id="password" type="password" readonly />
  <button type="submit">Create account</button>
</form>
<script>document.getElementById("auth").addEventListener("submit", (event) => { event.preventDefault(); });</script>
</body></html>`;

let server = null;
let baseUrl = "";
let body = UNEDITABLE_FORM;

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
});
after(async () => { await new Promise((resolve) => server?.close(resolve)); });

test("describeInputFailure names the cause Playwright reported", () => {
  const detached = describeInputFailure("password", new Error(
    "locator.fill: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByLabel(/password/i).first()\n"
    + "    - locator resolved to <input id=\"password\" type=\"password\"/>\n  - element was detached from the DOM, retrying",
  ));
  assert.equal(detached.control, "password");
  assert.match(detached.cause, /re-mounted \(was detached from the DOM\)/);
  assert.equal(detached.reason, `the account form's password control could not accept input: ${detached.cause}`);
  assert.ok(detached.log.split("\n").length <= 8);
  assert.match(describeInputFailure("email", new Error("locator.fill: Element is not editable")).cause, /not editable/);
  assert.match(describeInputFailure("email", new Error("locator.fill: element is disabled")).cause, /disabled/);
  assert.match(describeInputFailure("email", new Error("locator.fill: Timeout 8000ms exceeded.\nCall log:\n  - waiting for x")).cause, /never became ready/);
  assert.match(describeInputFailure("email", "something else").cause, /something else/);
});

test("a sign-in control that never accepts input fails the step in bounded time; the verifier stays available", needsBrowser, async () => {
  body = UNEDITABLE_FORM;
  const contract = {
    journeys: [{
      id: "sign-in", title: "A user signs in", priority: "primary",
      steps: [
        { action: "open the app", target: "/", expect: "the Lumen Layouts heading and the email and password fields are visible" },
        { action: "create account with email and password", target: "sign-in form",
          expect: "the workspace is visible" },
      ],
    }],
  };
  const started = Date.now();
  const result = await verifyJourneys({ previewUrl: baseUrl, contract, timeoutMs: 120_000 });
  const elapsed = Date.now() - started;
  assert.notEqual(result.unavailable, true, `the verifier must not report itself unavailable: ${result.error}`);
  const journey = result.journeys.find((row) => row.id === "sign-in");
  assert.ok(journey, JSON.stringify(result.journeys));
  const step = journey.steps[1];
  assert.equal(step.status, "fail", JSON.stringify(step));
  assert.match(step.detail, /password control could not accept input: the control is not editable/);
  assert.ok(elapsed < 45_000, `bounded input attempts, took ${elapsed}ms`);
});
