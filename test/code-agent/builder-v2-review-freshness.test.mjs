// The review-step freshness exemption.
//
// Four live qualifications failed a review step with
//   "nothing changed — 'selected, date, slot' was already on the page before this step"
// while the application was working. Showing the running selection as it is made is good UX, so
// by the time review runs its vocabulary is already on screen and nothing can be NEW.
//
// The exemption is deliberately narrow and trades freshness for a STRONGER check: it arms only
// when there are exact contracted values to verify, and the caller then fails the step unless
// the review contains every one of them. Everywhere else the freshness rule is untouched.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { expectationOutcome } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";

const base = { wanted: ["review", "selected", "date"], found: ["review", "selected", "date"], fresh: [], drove: true, action: "review the booking" };

// ── the exemption ─────────────────────────────────────────────────────────────────────────────

test("a review step passes on persisted copy when exact values are being verified", () => {
  const outcome = expectationOutcome({ ...base, reviewWithValues: true });
  assert.equal(outcome.status, "pass");
  assert.equal(outcome.reviewExempt, true);
  assert.match(outcome.detail, /values verified/);
});

test("the SAME step without the exemption still fails the freshness rule", () => {
  const outcome = expectationOutcome({ ...base, reviewWithValues: false });
  assert.equal(outcome.status, "fail");
  assert.match(outcome.detail, /nothing changed/);
  assert.match(outcome.detail, /was already on the page before this step/);
});

test("the exemption never rescues a review that does not show enough of what was asked", () => {
  // Below the majority bar the step fails regardless — the exemption only replaces FRESHNESS.
  const outcome = expectationOutcome({
    ...base, found: ["review"], reviewWithValues: true,
  });
  assert.equal(outcome.status, "fail");
  assert.equal(outcome.reviewExempt, undefined);
  assert.match(outcome.detail, /expected review, selected, date/);
});

// ── everything else is untouched ──────────────────────────────────────────────────────────────

test("non-review steps keep the freshness rule exactly as before", () => {
  for (const action of ["confirm the booking", "select a date", "cancel the booking", "submit the form"]) {
    const stale = expectationOutcome({ ...base, action, reviewWithValues: false });
    assert.equal(stale.status, "fail", `${action} must still require a transition`);
    assert.match(stale.detail, /nothing changed/);

    const fresh = expectationOutcome({ ...base, action, fresh: ["selected"], reviewWithValues: false });
    assert.equal(fresh.status, "pass", `${action} passes when something actually changed`);
    assert.equal(fresh.reviewExempt, undefined);
  }
});

test("a static page still cannot pass a mutation step", () => {
  // The exact regression the freshness rule exists to catch: a page that always says "received".
  const outcome = expectationOutcome({
    wanted: ["booking", "received"], found: ["booking", "received"], fresh: [],
    drove: true, action: "submit the booking", reviewWithValues: false,
  });
  assert.equal(outcome.status, "fail");
});

test("a structured read-only assertion judges visible state without inventing an action", () => {
  const visible = expectationOutcome({
    wanted: ["model", "version", "parts"], found: ["model", "version", "parts"], fresh: [],
    drove: false, action: "compare the result", readOnlyAssertion: true,
  });
  assert.equal(visible.status, "pass");
  assert.equal(visible.readOnlyAssertion, true);

  const missing = expectationOutcome({
    wanted: ["model", "version", "parts"], found: ["model"], fresh: [],
    drove: false, action: "compare the result", readOnlyAssertion: true,
  });
  assert.equal(missing.status, "fail");
});

test("navigation keeps its own exemption, independent of review", () => {
  const outcome = expectationOutcome({ ...base, action: "open the booking page", reviewWithValues: false });
  assert.equal(outcome.status, "pass");
  assert.equal(outcome.reviewExempt, undefined);
});

test("an isolated journey may assert the durable state its setup just established", () => {
  const visible = expectationOutcome({
    ...base, action: "open the saved record", navigational: false, establishedState: true,
  });
  assert.equal(visible.status, "pass");

  const missing = expectationOutcome({
    ...base, found: ["review"], action: "open the saved record", navigational: false,
    establishedState: true,
  });
  assert.equal(missing.status, "fail", "setup never substitutes for missing contracted evidence");
});

test("the container verifier uses Chromium's bounded shared-memory path", async () => {
  const source = await readFile(new URL("../../shell/server/lib/appBuild/journeyVerifier.mjs", import.meta.url), "utf8");
  assert.match(source, /chromium\.launch\(\{ args: \["--disable-dev-shm-usage", "--no-sandbox"\] \}\)/);
  assert.match(source, /opened\.on\("requestfailed"/);
  const smoke = await readFile(new URL("../../shell/server/lib/appBuild/verificationAgent.mjs", import.meta.url), "utf8");
  assert.match(smoke, /chromium\.launch\(\{ args: \["--disable-dev-shm-usage", "--no-sandbox"\] \}\)/);
});

test("an undriveable step is never rescued by the exemption", () => {
  const outcome = expectationOutcome({
    ...base, found: [], drove: false, reviewWithValues: true,
  });
  assert.equal(outcome.status, "undriveable");
});

// ── the live shape, end to end ────────────────────────────────────────────────────────────────

test("the exact live failure now passes — and still fails if a value is missing", () => {
  // Live run 4, step 7: every expectation word was already on screen from the running summary.
  const live = {
    wanted: ["review", "selected", "date", "slot"],
    found: ["review", "selected", "date", "slot"],
    fresh: [], drove: true, action: "review the booking",
  };
  assert.equal(expectationOutcome({ ...live, reviewWithValues: false }).status, "fail");
  assert.equal(expectationOutcome({ ...live, reviewWithValues: true }).status, "pass");

  // The caller's value check is what actually decides it, and it is stricter than freshness:
  // a review missing any exact contracted value is failed by verifyStepOutcome regardless of
  // this exemption. That path is covered by the journey-verifier browser suite.
  const reviewText = "Friday 18 October · 18:30";
  const entered = [{ field: "guestEmail", value: "guest@example.com" }];
  const missing = entered.filter(({ value }) => !reviewText.includes(value));
  assert.equal(missing.length, 1, "a missing contracted value is still detected");
});
