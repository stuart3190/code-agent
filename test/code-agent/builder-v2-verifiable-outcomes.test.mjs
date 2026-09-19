// EVERY CONTRACT STEP STATES A VERIFIABLE OUTCOME.
//
// The verifier judges a step on structured contract evidence only (0573c41): a contracted route,
// operated controls or operations, values an earlier step entered, or contract-declared visible
// text. A step that states none of those is CONTRACT_INCOMPLETE in the browser and can never turn
// a build green. The validator is free and runs first, so the same fact is named in the contract's
// own terms before any generation is paid for, and the contract agent repairs it there.

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import { validateContract } from "../../shell/shared/implementationContract.mjs";
import { SYSTEM_PROMPT } from "../../shell/server/lib/appBuild/contractAgent.mjs";

const RETAINED = new URL("./fixtures/retained/advanced-20260916/", import.meta.url);
const base = (steps) => ({
  version: 2, summary: "Fixture library", projectType: "web app",
  entities: [{ name: "fixture", fields: [{ name: "name", type: "string", required: true }] }],
  operations: [{ id: "create-fixture", entity: "fixture", kind: "create", journey: "browse" }],
  routes: [{ path: "/", name: "Home" }, { path: "/library", name: "Library" }],
  journeys: [{ id: "browse", title: "Browse the library", priority: "primary", steps }],
  sampleData: { fixtures: [{ name: "Pendant Light" }] },
});
const unverifiable = (problems) => problems.filter((problem) => /states no verifiable outcome/.test(problem));

test("an observation step with only prose is rejected; naming what the screen must show makes it verifiable", () => {
  const bare = validateContract(base([
    { action: "open the library", target: "/library", expect: "the library is visible" },
    { action: "view available fixture categories", expect: "Pendant Light, Wall Sconce and Floor Lamp options are visible" },
  ]));
  assert.equal(bare.ok, false);
  assert.equal(unverifiable(bare.problems).length, 1, bare.problems.join("; "));
  assert.match(unverifiable(bare.problems)[0], /browse step 2 states no verifiable outcome/);
  assert.match(unverifiable(bare.problems)[0], /visibleText/);

  const declared = validateContract(base([
    { action: "open the library", target: "/library", expect: "the library is visible" },
    { action: "view available fixture categories", visibleText: ["Pendant Light", "Wall Sconce", "Floor Lamp"],
      expect: "Pendant Light, Wall Sconce and Floor Lamp options are visible" },
  ]));
  assert.deepEqual(unverifiable(declared.problems), []);
});

test("a route target, an operated control or operation, and a read of an entered field are each verifiable outcomes", () => {
  const verdict = validateContract(base([
    { action: "open the library", target: "/library", expect: "the library is visible" },
    { action: "open the home screen", target: "Home", expect: "the home screen is visible" },
    { action: "enter a fixture name", operates: ["name"], expect: "the name is accepted" },
    { action: "review the entered name", reads: ["name"], expect: "the name is shown" },
    { action: "create the fixture", operates: ["create-fixture"], expect: "the fixture is listed" },
    { action: "reload the page", reads: ["name"], expect: "the fixture survives" },
  ]));
  assert.deepEqual(unverifiable(verdict.problems), [], verdict.problems.join("; "));
  // A read of a field NO earlier step entered is not evidence the browser can hold anything to.
  const unentered = validateContract(base([
    { action: "open the library", target: "/library", expect: "the library is visible" },
    { action: "review the fixture", reads: ["name"], expect: "the name is shown" },
  ]));
  assert.equal(unverifiable(unentered.problems).length, 1);
  assert.match(unverifiable(unentered.problems)[0], /reads \["name"\] that no earlier step entered/);
  // Empty declarations do not count.
  const empty = validateContract(base([
    { action: "open the library", target: "/library", expect: "the library is visible" },
    { action: "view the library", visibleText: [], operates: [], reads: [], expect: "things are visible" },
  ]));
  assert.equal(unverifiable(empty.problems).length, 1);
});

test("the retained Advanced contracts carry exactly the four pre-rule observation steps the browser could never verify", async () => {
  const shorts = (await readdir(RETAINED)).filter((name) => /^[0-9a-f]{7}$/.test(name));
  const flagged = [];
  for (const short of shorts) {
    const raw = JSON.parse(await readFile(new URL(`${short}/contract.json`, RETAINED), "utf8"));
    for (const problem of unverifiable(validateContract(raw.contract || raw).problems)) flagged.push(`${short} ${problem.split(" states")[0]}`);
  }
  assert.deepEqual(flagged.sort(), [
    "62841e8 settings-route-and-auth-boundary step 2",
    "62841e8 view-library-route step 2",
    "6833295 library-route-browse-fixtures step 2",
    "ca48824 browse-library-route step 2",
  ]);
});

test("the contract prompt teaches visibleText and the verifiable-outcome rule", () => {
  assert.match(SYSTEM_PROMPT, /"visibleText"/);
  assert.match(SYSTEM_PROMPT, /verifiable outcome/i);
});
