// Journey-verifier calibration — proven against the live modular build's exact failure modes.
//
// Run 17b6513f built default-selected dates (valid product behaviour) and the freshness rule
// refused them: "'selected, slot' was already on the page before this step". And "a polished
// confirmation state" hunted the word "polished" — an adjective no app renders. Selection is now
// judged on the SEMANTIC transition; qualitative language never becomes an assertion; a click
// that changes the URL is a navigation whatever verb the contract used.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectionTransition, confirmationReflectsSelections, expectationOutcome, expectationKeywords, QUALITATIVE,
} from "../../shell/server/lib/appBuild/journeyVerifier.mjs";

// ── selection semantics ───────────────────────────────────────────────────────────────────────

test("no default selection → clicking an option CREATES selection and passes", () => {
  const verdict = selectionTransition({
    before: [{ text: "Fri 20 Jun", selected: false }, { text: "Sat 21 Jun", selected: false }],
    after: [{ text: "Fri 20 Jun", selected: true }, { text: "Sat 21 Jun", selected: false }],
    clickedIndex: 0,
  });
  assert.equal(verdict.ok, true, verdict.reason);
  assert.match(verdict.detail, /selection created/);
  assert.equal(verdict.selectedText, "Fri 20 Jun");
});

test("default selection → clicking ANOTHER option must MOVE selection (the live failure, fixed)", () => {
  // The exact live shape: option 0 pre-selected. Clicking option 1 moves it — passes.
  const moved = selectionTransition({
    before: [{ text: "Fri 20 Jun", selected: true }, { text: "Sat 21 Jun", selected: false }],
    after: [{ text: "Fri 20 Jun", selected: false }, { text: "Sat 21 Jun", selected: true }],
    clickedIndex: 1,
  });
  assert.equal(moved.ok, true, moved.reason);
  assert.match(moved.detail, /selection moved from "Fri 20 Jun" to "Sat 21 Jun"/);

  // Selection that never moves — both show selected, or the clicked one never gains — fails.
  const stuck = selectionTransition({
    before: [{ text: "A", selected: true }, { text: "B", selected: false }],
    after: [{ text: "A", selected: true }, { text: "B", selected: true }],
    clickedIndex: 1,
  });
  assert.equal(stuck.ok, false);
  assert.match(stuck.reason, /did not MOVE/);

  const inert = selectionTransition({
    before: [{ text: "A", selected: true }, { text: "B", selected: false }],
    after: [{ text: "A", selected: true }, { text: "B", selected: false }],
    clickedIndex: 1,
  });
  assert.equal(inert.ok, false);
  assert.match(inert.reason, /never gained a selected state/);
});

test("clicking the already-selected option is NOT a transition", () => {
  const verdict = selectionTransition({
    before: [{ text: "A", selected: true }, { text: "B", selected: false }],
    after: [{ text: "A", selected: true }, { text: "B", selected: false }],
    clickedIndex: 0,
  });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /already-selected/);
});

test("static text containing 'selected' cannot pass a selection verdict — it never enters it", () => {
  // The semantic evaluator sees STATES, not copy. A page whose prose says "selected" everywhere
  // contributes nothing: with no state change, the verdict fails regardless of any text.
  const verdict = selectionTransition({
    before: [{ text: "selected date selected", selected: false }, { text: "also selected!", selected: false }],
    after: [{ text: "selected date selected", selected: false }, { text: "also selected!", selected: false }],
    clickedIndex: 0,
  });
  assert.equal(verdict.ok, false);
});

// ── the submitted booking reflects the selection ──────────────────────────────────────────────

test("a confirmation must contain the selected date/slot values; abstains when nothing checkable", () => {
  const good = confirmationReflectsSelections(
    "Booking confirmed! Reference BB-1042 — Sat 21 Jun, 10:30–12:00, 2 adults.",
    ["Sat 21 Jun", "10:30–12:00"],
  );
  assert.deepEqual([good.checked, good.ok], [true, true]);

  const wrong = confirmationReflectsSelections(
    "Booking confirmed! Reference BB-1042 — Fri 20 Jun, 09:00.",
    ["Sat 21 Jun", "10:30–12:00"],
  );
  assert.deepEqual([wrong.checked, wrong.ok], [true, false]);
  assert.match(wrong.detail, /none of the selected values/);

  const abstain = confirmationReflectsSelections("Confirmed!", ["the meadow option"]);
  assert.deepEqual([abstain.checked, abstain.ok], [false, true], "no numbers to check → abstain, never guess");
});

// ── qualitative language never becomes an assertion ───────────────────────────────────────────

test("'a polished confirmation state' verifies confirmation behaviour, not the word 'polished'", () => {
  const wanted = expectationKeywords("a polished confirmation state appears with a booking reference");
  assert.ok(!wanted.includes("polished"), wanted.join(","));
  assert.ok(wanted.includes("confirmation") && wanted.includes("reference"));
  for (const adjective of ["premium", "modern", "professional"]) {
    assert.ok(QUALITATIVE.has(adjective), `${adjective} is design guidance, never an assertion`);
  }
  // The exact live failure re-judged: found booking+reference (reference FRESH) out of the
  // observable words — passes now that "polished" no longer dilutes the ratio.
  const outcome = expectationOutcome({
    wanted, found: ["booking", "reference"], fresh: ["reference"], drove: true,
    action: "enter name, email and phone, accept the farm terms, and submit",
  });
  assert.equal(outcome.status, "pass", outcome.detail);
});

// ── URL change is navigation, whatever the verb ───────────────────────────────────────────────

test("a click that changes the URL is navigational — pre-existing words on the target page pass", () => {
  // The live CTA failure: /book's words also existed on the home page, so nothing was "fresh".
  const before = expectationOutcome({
    wanted: ["booking", "dates", "picking"], found: ["booking", "dates", "picking"], fresh: [],
    drove: true, action: "click the book call to action", urlChanged: false,
  });
  assert.equal(before.status, "fail", "without the URL signal the old verdict stands");

  const after = expectationOutcome({
    wanted: ["booking", "dates", "picking"], found: ["booking", "dates", "picking"], fresh: [],
    drove: true, action: "click the book call to action", urlChanged: true,
  });
  assert.equal(after.status, "pass", after.detail);
});

// ── in-page section navigation is navigational (bv2 live run 5) ───────────────────────────────

test("jump/scroll-to-section steps pass on static presence — a single-page app cannot mint fresh words", () => {
  // Both verdicts from the live run, re-judged: every section was statically rendered, the
  // click scrolled, nothing was "fresh" — and the step is navigation in all but verb.
  for (const action of [
    "use the navigation to jump to services",
    "scroll to the about section",
    "use the page navigation",
  ]) {
    const outcome = expectationOutcome({
      wanted: ["services", "section", "room", "styling", "full"],
      found: ["services", "section", "room", "styling", "full"], fresh: [],
      drove: true, action, urlChanged: false,
    });
    assert.equal(outcome.status, "pass", `${action}: ${outcome.detail}`);
  }

  // An ACTION step (submit) still demands a transition — static presence keeps failing it.
  const submit = expectationOutcome({
    wanted: ["clear", "confirmation", "stating"], found: ["clear", "confirmation", "stating"], fresh: [],
    drove: true, action: "fill in name, email, and message and submit", urlChanged: false,
  });
  assert.equal(submit.status, "fail", "the navigational exemption must not leak into submits");
});
