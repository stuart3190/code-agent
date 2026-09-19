// THE VERIFIER JUDGES ON STRUCTURED CONTRACT EVIDENCE, NEVER ON INCIDENTAL PROSE.
//
// Under the contract policy (minimal_contract_v1) a step verdict is decided by structured facts
// the contract states and structured proof the browser measured: a route reached, a contracted
// value rendered, a contracted collection member present, a removal or reset measured on the
// controls, an action fired through its contracted control with a surface change, a flow entry
// that exposed the contract's next control, an input accepted, a selection transitioned, a
// durable record that survived reload, a private record hidden from another account. The words
// of the action/expect sentence are recorded as evidence and can neither pass nor fail a step.
// A step whose contract states none of those facts is CONTRACT_INCOMPLETE, not a guess.

import test from "node:test";
import assert from "node:assert/strict";

import {
  structuredStepVerdict, expectationOutcome, recoveryEvidenceVerdict, accessDenialVerdict,
  routeMatchesCurrent, flowDeclaresDurableStatus, durableStatusWords, selectionTransition,
} from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import {
  MINIMAL_CONTRACT_VERIFIER_POLICY, VERIFICATION_RESULT_CLASS, statusForVerificationClass,
  isAppRepairableVerificationClass,
} from "../../shell/server/lib/appBuild/verifierPolicy.mjs";

const MINIMAL = MINIMAL_CONTRACT_VERIFIER_POLICY;
// Prose words the app never rendered: every verdict below must be indifferent to them.
const PROSE = { wanted: ["polished", "dashboard", "summary", "overview", "greeting"], found: [] };

test("reload with the correct persisted value but without the incidental prose keyword => PASS", () => {
  // The record: an entered value and a reference the confirmation rendered. No declared status.
  const durable = { captured: true, values: ["Atrium Lighting Plan", "240"], references: ["PLAN-7F3A"], statusWords: [] };
  const reloaded = "Workspace · Atrium Lighting Plan · PLAN-7F3A · x 240 · Draft controls";
  const verdict = recoveryEvidenceVerdict(durable, reloaded);
  assert.equal(verdict.ok, true, verdict.detail);
  // The vocabulary is only captured when the contract declares the record carries a status.
  assert.equal(flowDeclaresDurableStatus({ writes: ["j.durable.record", "j.durable.reference"] }), false);
  assert.equal(flowDeclaresDurableStatus({ writes: ["j.durable.status"] }), true);
  assert.deepEqual(durableStatusWords("a visible Saved status appears for the plan", "Plan Saved status"), ["saved", "plan"]);
});

test("wrong persisted value => FAIL (PERSISTENCE_FAILURE)", () => {
  const durable = { captured: true, values: ["Atrium Lighting Plan", "240"], references: [], statusWords: [] };
  const verdict = recoveryEvidenceVerdict(durable, "Workspace · Atrium Lighting Plan · x 999");
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /recovered state lost contracted values: 240/);
});

test("correct collection membership but no literal phrase from the expectation => PASS", () => {
  const verdict = structuredStepVerdict({
    ...PROSE, expect: "the polished dashboard overview greets the user with a summary",
    structured: { memberStructured: true, mutationDeclared: true, observedStateChanged: true },
    drove: true, actionProven: true, collectionStateRequired: true, collectionStateSatisfied: true,
  });
  assert.equal(verdict.classification, VERIFICATION_RESULT_CLASS.PASS);
  assert.equal(verdict.status, "pass");
  assert.match(verdict.detail, /contracted collection contains its required member/);
  assert.equal(verdict.advisories[0].code, "expectation_prose_unobserved", "the words are evidence, not a verdict");
});

test("missing created record => FAIL (APP_FUNCTIONAL_FAILURE)", () => {
  const verdict = structuredStepVerdict({
    wanted: ["created", "project"], found: ["created", "project"], expect: "the created project is visible",
    structured: { memberStructured: true, mutationDeclared: true, observedStateChanged: true },
    drove: true, actionProven: true, collectionStateRequired: true, collectionStateSatisfied: false,
  });
  assert.equal(verdict.classification, VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE, "matching words cannot rescue a missing record");
  assert.match(verdict.detail, /does not contain every required member/);
});

test("dead button / no action => FAIL (APP_FUNCTIONAL_FAILURE)", () => {
  const verdict = structuredStepVerdict({
    wanted: ["saved", "plan"], found: ["saved", "plan"], expect: "a Saved status appears for the plan",
    structured: { actionDeclared: true, observedStateChanged: false, nextControlVisible: false },
    drove: true, actionProven: true, urlChanged: false, mutationWithValues: false,
  });
  assert.equal(verdict.classification, VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE);
  assert.match(verdict.detail, /produced no observable state change/);
  const mutation = structuredStepVerdict({
    ...PROSE, expect: "the plan is stored", structured: { mutationDeclared: true, observedStateChanged: false },
    drove: true, actionProven: true,
  });
  assert.equal(mutation.classification, VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE);
  // A driven action that DID change the surface passes without a single expectation word.
  const live = structuredStepVerdict({
    ...PROSE, expect: "the plan is stored", structured: { actionDeclared: true, observedStateChanged: true },
    drove: true, actionProven: true,
  });
  assert.equal(live.classification, VERIFICATION_RESULT_CLASS.PASS);
});

test("wrong route => FAIL (APP_FUNCTIONAL_FAILURE); the contracted route reached => PASS", () => {
  assert.equal(routeMatchesCurrent("http://127.0.0.1:4173/workspace", "/workspace"), true);
  assert.equal(routeMatchesCurrent("http://127.0.0.1:4173/workspace/", "/workspace"), true);
  assert.equal(routeMatchesCurrent("http://127.0.0.1:4173/plans/42", "/plans/:planId"), true);
  assert.equal(routeMatchesCurrent("http://127.0.0.1:4173/settings", "/workspace"), false);
  assert.equal(routeMatchesCurrent("http://127.0.0.1:4173/plans", "/plans/:planId"), false);
  const wrong = structuredStepVerdict({
    wanted: ["workspace", "canvas"], found: ["workspace", "canvas"], expect: "the workspace canvas is visible",
    structured: { route: "/workspace", routeReached: false, currentPath: "/settings", navigationDeclared: true },
    drove: true, actionProven: true, urlChanged: true,
  });
  assert.equal(wrong.classification, VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE, "words on the wrong page prove nothing");
  assert.match(wrong.detail, /route \/workspace was not reached \(the browser is at \/settings\)/);
  const right = structuredStepVerdict({
    ...PROSE, expect: "the polished dashboard overview greets the user",
    structured: { route: "/workspace", routeReached: true, currentPath: "/workspace", navigationDeclared: true },
    drove: true, actionProven: true, urlChanged: false,
  });
  assert.equal(right.classification, VERIFICATION_RESULT_CLASS.PASS);
});

test("unauthorized action succeeds (private record visible to another account) => FAIL", () => {
  const leaked = accessDenialVerdict({ privateEvidence: ["Atrium Lighting Plan", "PLAN-7F3A"],
    visibleText: "Second account workspace · PLAN-7F3A" });
  assert.equal(leaked.status, "fail");
  assert.match(leaked.detail, /can see private durable evidence: PLAN-7F3A/);
  const denied = accessDenialVerdict({ privateEvidence: ["Atrium Lighting Plan", "PLAN-7F3A"],
    visibleText: "Second account workspace · no plans yet" });
  assert.equal(denied.status, "pass");
});

test("contract lacks a structured expected outcome => CONTRACT_INCOMPLETE, never a guessed pass or fail", () => {
  // Words present, words absent: the verdict is the same, because there is nothing structured to judge.
  for (const found of [[], ["dashboard", "summary", "overview"]]) {
    const verdict = structuredStepVerdict({
      wanted: ["dashboard", "summary", "overview"], found, expect: "the dashboard shows a friendly summary overview",
      structured: {}, drove: false, actionProven: false,
    });
    assert.equal(verdict.classification, VERIFICATION_RESULT_CLASS.CONTRACT_INCOMPLETE);
    assert.equal(verdict.status, "undriveable", "not green, and not an application failure");
    assert.equal(verdict.contractIncomplete, true);
    assert.match(verdict.detail, /states no structured expected outcome/);
  }
  assert.equal(statusForVerificationClass(VERIFICATION_RESULT_CLASS.CONTRACT_INCOMPLETE), "undriveable");
  assert.equal(isAppRepairableVerificationClass(VERIFICATION_RESULT_CLASS.CONTRACT_INCOMPLETE), false,
    "a contract gap never spends the application's repair allowance");
  // A collection member named only in prose (never entered or selected) is a contract gap too.
  const proseMember = structuredStepVerdict({
    wanted: ["both", "saved", "items"], found: [], expect: "both saved items appear in the list",
    structured: { memberStructured: false }, drove: true, actionProven: true,
    collectionStateRequired: true, collectionStateSatisfied: false,
  });
  assert.equal(proseMember.classification, VERIFICATION_RESULT_CLASS.CONTRACT_INCOMPLETE);
  assert.match(proseMember.detail, /collection member named only in prose/);
});

test("expectationOutcome under the contract policy routes structured facts to the structured verdict", () => {
  const outcome = expectationOutcome({
    wanted: ["welcome", "home"], found: [], fresh: [], drove: true, action: "open the workspace",
    verifierPolicy: MINIMAL, actionProven: true, urlChanged: true,
    structured: { route: "/workspace", routeReached: true, navigationDeclared: true },
  });
  assert.equal(outcome.classification, VERIFICATION_RESULT_CLASS.PASS);
  // A driven step whose structured facts are unproven while the words happen to be present is NOT a pass.
  const words = expectationOutcome({
    wanted: ["saved", "plan"], found: ["saved", "plan"], fresh: ["saved"], drove: true, action: "save the plan",
    verifierPolicy: MINIMAL, actionProven: true, urlChanged: false,
    structured: { mutationDeclared: true, observedStateChanged: false },
  });
  assert.equal(words.classification, VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE);
});

test("an undriven step with unproven structured facts is inconclusive, not an application failure", () => {
  const verdict = structuredStepVerdict({
    ...PROSE, expect: "x", structured: { actionDeclared: true, observedStateChanged: false }, drove: false, actionProven: false,
  });
  assert.equal(verdict.classification, VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE);
});

test("a selection that reached the contract's next control is proven by that control, not by prose", () => {
  const before = [{ selected: false, label: "Tuesday" }, { selected: false, label: "Wednesday" }];
  const advanced = selectionTransition({ before, after: [], clickedIndex: 0,
    autoAdvance: { terminalStep: false, nextControl: "slot", nextControlVisible: true, expectationMet: false } });
  assert.equal(advanced.ok, true, advanced.reason);
  const stranded = selectionTransition({ before, after: [], clickedIndex: 0,
    autoAdvance: { terminalStep: false, nextControl: "slot", nextControlVisible: false, expectationMet: true } });
  assert.equal(stranded.ok, false, "prose without the contracted next control is not an advance");
  const terminal = selectionTransition({ before, after: [], clickedIndex: 0,
    autoAdvance: { terminalStep: true, nextControl: null, expectationMet: false, structuralOutcome: true } });
  assert.equal(terminal.ok, true);
  const dead = selectionTransition({ before, after: [], clickedIndex: 0,
    autoAdvance: { terminalStep: true, nextControl: null, expectationMet: false, structuralOutcome: false } });
  assert.equal(dead.ok, false);
});
