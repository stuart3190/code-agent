// A JOURNEY READS THE RECORD IT CREATED.
//
// Recessed-light rerun 7e74b401 (2026-09-18, medium): the second contract attempt passed the
// validator, then the interaction gate rejected it before generation on four steps of two
// journeys - "reads state before it is produced: ...custom.projectId" and "...draft.projectId".
// Each journey had created the project itself a few steps earlier; the `projectId` those later
// steps read is that created record's identity. The resolver had bound it to the foreign key a
// later create-room persists (custom state nothing writes) or to a draft field nothing enters.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { validateContract } from "../../shell/shared/implementationContract.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";

const RETAINED = new URL("./fixtures/retained/medium-20260918-recessed/contract-7e74b401-attempt2.json", import.meta.url);

async function retainedContract() {
  const raw = JSON.parse(await readFile(RETAINED, "utf8"));
  return raw.contract || raw;
}

const flowsOf = (spec, journeyId) => (spec.contract.interactionContract?.flows || spec.interactionContract?.flows || [])
  .filter((flow) => flow.journeyId === journeyId);

test("the retained contract that blocked rerun 7e74b401 passes the gate: identity reads bind to the record the journey created", async () => {
  const contract = await retainedContract();
  assert.equal(validateContract(contract).ok, true);
  const spec = deriveBuildSpec(contract);
  assert.deepEqual(spec.verdict.problems || [], []);
  assert.equal(spec.verdict.ok, true);

  const design = flowsOf(spec, "design-and-estimate-project");
  const detail = design.find((flow) => flow.kind === "navigation" && flow.stepIndex === 4);
  assert.ok(detail, "the detail-route navigation flow exists");
  assert.ok(detail.reads.includes("design-and-estimate-project.durable.record"), JSON.stringify(detail.reads));
  for (const flow of design) {
    assert.ok(!(flow.reads || []).includes("design-and-estimate-project.custom.projectId"), `${flow.id} still reads custom.projectId`);
  }
  const manage = flowsOf(spec, "search-filter-and-manage-projects");
  const remove = manage.find((flow) => flow.kind === "mutation" && flow.operationId === "delete-project");
  assert.ok(remove, "the delete mutation flow exists");
  assert.ok(remove.reads.includes("search-filter-and-manage-projects.durable.record"), JSON.stringify(remove.reads));
  assert.ok(!remove.reads.includes("search-filter-and-manage-projects.draft.projectId"));
});

test("without the in-journey create, the same identity read is still a missing producer", async () => {
  const contract = await retainedContract();
  const journey = contract.journeys.find((row) => row.id === "search-filter-and-manage-projects");
  const createIndex = journey.steps.findIndex((step) => (step.operates || []).includes("create-project"));
  assert.ok(createIndex >= 0);
  journey.steps.splice(createIndex, 1);
  const spec = deriveBuildSpec(contract);
  assert.equal(spec.verdict.ok, false);
  assert.ok((spec.verdict.problems || []).some((problem) => /search-filter-and-manage-projects:\d+:mutation reads state before it is produced: .*projectId/.test(problem)),
    (spec.verdict.problems || []).join("\n"));
});

test("a create operation's own step never reads the identity it generates as a dependency", async () => {
  const contract = await retainedContract();
  const journey = contract.journeys.find((row) => row.id === "design-and-estimate-project");
  const create = journey.steps.find((step) => (step.operates || []).includes("create-project"));
  create.reads = ["projectId"];
  const spec = deriveBuildSpec(contract);
  assert.ok(!(spec.verdict.problems || []).some((problem) => /design-and-estimate-project:4:.*projectId/.test(problem)),
    (spec.verdict.problems || []).join("\n"));
});
