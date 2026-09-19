// CONTRACT GATE ON THE RETAINED ADVANCED CORPUS — the first contract the model writes must be
// executable, and a rejection must name a real contract defect, never a derivation blind spot.
//
// On 2026-09-16 four of six first-attempt advanced contracts were rejected with "reads state
// before it is produced" on an export/print/keyboard journey that declared dependsOn on the plan
// producer and READ the plan's fields. Derivation classified such a journey as independent (it
// commits nothing) and mapped its reads to draft paths nothing writes. The inherited record is
// the source: a journey that declares its producers reads their records as durable state and
// inherits their lifecycle. The one remaining rejection (46aab6c: a workspacePreference entity
// that is only ever updated) is a genuine contract defect, now caught by the free validator.

import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { validateContract } from "../../shell/shared/implementationContract.mjs";
import { SYSTEM_PROMPT } from "../../shell/server/lib/appBuild/contractAgent.mjs";

const RETAINED = new URL("./fixtures/retained/advanced-20260916/", import.meta.url);
const FIRST = new URL("./fixtures/retained/advanced-20260916/_first-contracts/", import.meta.url);
const load = async (url) => { const raw = JSON.parse(await readFile(url, "utf8")); return raw.contract || raw; };
const clone = (value) => JSON.parse(JSON.stringify(value));

test("every retained first-attempt advanced contract derives clean except the one with a genuine defect", async () => {
  const files = (await readdir(FIRST)).filter((file) => file.endsWith(".json")).sort();
  assert.equal(files.length, 6);
  for (const file of files) {
    const contract = await load(new URL(file, FIRST));
    const spec = deriveBuildSpec(contract);
    if (file === "46aab6c.json") {
      assert.equal(spec.verdict.ok, false);
      assert.ok(spec.verdict.problems.every((problem) => /workspacePreference records with no proven source/.test(problem)),
        spec.verdict.problems.join(" | "));
      continue;
    }
    assert.equal(spec.verdict.ok, true, `${file}: ${(spec.verdict.problems || []).join(" | ")}`);
  }
});

test("every retained final advanced contract still derives clean", async () => {
  for (const short of ["62841e8", "6833295", "f8e2281", "1f56b9c", "ca48824", "46aab6c"]) {
    const spec = deriveBuildSpec(await load(new URL(`${short}/contract.json`, RETAINED)));
    assert.equal(spec.verdict.ok, true, `${short}: ${(spec.verdict.problems || []).join(" | ")}`);
  }
});

test("a journey that declares its producer reads the producer's record as inherited durable state", async () => {
  const contract = await load(new URL("f8e2281.json", FIRST));
  const spec = deriveBuildSpec(contract);
  const exportJourney = contract.journeys.find((journey) => /export/.test(journey.id));
  const scenario = spec.interactionContract.scenarios[exportJourney.id];
  assert.equal(scenario.role, "consumes");
  assert.equal(scenario.startState, "inherits");
  assert.match(scenario.lifecycle, /:plan$/);
  const reads = spec.interactionContract.flows.filter((flow) => flow.journeyId === exportJourney.id)
    .flatMap((flow) => flow.reads || []);
  assert.ok(reads.some((path) => path === `${exportJourney.id}.durable.name`), JSON.stringify(reads));
  assert.ok(!reads.some((path) => /\.draft\.(name|fixtures)$/.test(path)), JSON.stringify(reads));
  // NEGATIVE: without the declaration the same reads have no source, exactly as before.
  const undeclared = clone(contract);
  const journey = undeclared.journeys.find((row) => row.id === exportJourney.id);
  delete journey.dependsOn; delete journey.durableState;
  const rejected = deriveBuildSpec(undeclared);
  assert.equal(rejected.verdict.ok, false);
  assert.ok(rejected.verdict.problems.some((problem) => /reads state before it is produced/.test(problem)), rejected.verdict.problems.join(" | "));
});

test("an entity that is only ever updated is a contract defect the validator names before any gate", async () => {
  const contract = await load(new URL("46aab6c.json", FIRST));
  const problems = validateContract(contract).problems;
  assert.ok(problems.some((problem) => /workspacePreference.*updated.*never created/i.test(problem)), problems.join(" | "));
  // Declaring the creator resolves it; so does seeding.
  const created = clone(contract);
  created.operations.push({ id: "save-workspace-preferences-create", entity: "workspacePreference", kind: "create", journey: "settings-route-and-signout",
    description: "create the preference record", responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "create", reads: ["keyboardPanStep"], writes: ["keyboardPanStep"] }] });
  assert.ok(!validateContract(created).problems.some((problem) => /never created/i.test(problem)));
  const seeded = clone(contract);
  seeded.sampleData = { workspacePreference: [{ activePlanId: "plan-1", keyboardPanStep: 10, libraryCategory: "all" }] };
  assert.ok(!validateContract(seeded).problems.some((problem) => /never created/i.test(problem)));
  // A transient entity is not a record and needs no creator.
  const transient = clone(contract);
  transient.entities.find((entity) => entity.name === "workspacePreference").storage = "transient";
  assert.ok(!validateContract(transient).problems.some((problem) => /never created/i.test(problem)));
});

test("the contract prompt states the creator rule", () => {
  assert.match(SYSTEM_PROMPT, /updates or deletes must be created by a declared create operation/);
});
