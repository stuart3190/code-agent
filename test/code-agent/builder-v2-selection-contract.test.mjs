import { test } from "node:test";
import assert from "node:assert/strict";

import { validateContract } from "../../shell/shared/implementationContract.mjs";

const contract = (steps) => ({
  version: 2,
  summary: "A generic public software catalogue with transient filters",
  auth: { required: false, model: "none", rules: [] },
  entities: [{
    name: "catalogueFilterState",
    owned: false,
    storage: "browser-session transient state",
    fields: [{ name: "platformFilter", type: "string", required: false }],
  }],
  operations: [],
  routes: [{ path: "/", name: "Software catalogue" }],
  journeys: [{
    id: "filter-software", title: "Filter the software catalogue", priority: "primary",
    stage: "primary_journey", steps,
  }],
  acceptance: [
    { id: "a1", journey: "filter-software", kind: "visibility", statement: "software cards are visible" },
    { id: "a2", journey: "filter-software", kind: "functional", statement: "a platform filter changes visible cards" },
    { id: "a3", journey: "filter-software", kind: "scope", statement: "filter state remains transient" },
  ],
});

const openStep = { action: "open the software catalogue", target: "/", expect: "software cards are visible" };
const selectPlatform = (value) => ({
  action: `choose ${value} from the platform filter`,
  target: "platform filter",
  expect: "matching software cards remain visible",
  operates: ["platformFilter"],
  primitive: "selection",
  verificationValues: { platformFilter: value },
});

test("an all-options sentinel cannot be an unobservable standalone selection", () => {
  const verdict = validateContract(contract([openStep, selectPlatform("All platforms")]));
  assert.ok(verdict.problems.some((problem) => /gives the browser no transition to verify/.test(problem)),
    verdict.problems.join("\n"));
});

test("returning to all options is driveable after the same field changed", () => {
  const verdict = validateContract(contract([
    openStep,
    selectPlatform("Desktop"),
    selectPlatform("All platforms"),
  ]));
  assert.ok(!verdict.problems.some((problem) => /gives the browser no transition to verify/.test(problem)),
    verdict.problems.join("\n"));
});
