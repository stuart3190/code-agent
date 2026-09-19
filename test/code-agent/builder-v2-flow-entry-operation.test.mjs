// A contracted step that ENTERS a flow, TYPES its values and COMMITS an operation is three
// contracted identities on one step, and the verifier must drive all three.
//
// Retained defect (bv2 medium qualification, build 37228e5f on 2397cbc, journey
// create-and-update-work step 4): the contract derived the "project creation form" entry control,
// six inputs and the declared create-project action under its own machine identity. The verifier
// filled the inputs, activated the ENTRY control, and — because a flow entry marks the step as
// contract-driven — never activated the create-project control. Nothing was submitted, nothing was
// persisted, and the verdict still read "the contracted action ran, but the named collection does
// not contain every required member" because the fill alone counted as proof of the action. Three
// repair waves (exact owner, causal dependency, owner regeneration) could not move a verdict the
// application had no part in. The same expectation also demanded the literal words "new project
// card" inside the projects list — the record reference with its rendering noun was never resolved
// to the title the step had typed.
//
// The fixture contract is the retained journey's own shape (fixtures/bv2-medium-create-step-
// contract.json, sign-in steps removed, routes reduced to "/"); its derivation reproduces the
// identical flow set and machine identities, so this is the production dispatch, not a stand-in.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { MINIMAL_CONTRACT_VERIFIER_POLICY } from "../../shell/server/lib/appBuild/verifierPolicy.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const JOURNEY_ID = "create-and-update-work";
const CREATE_STEP = 1;

const model = JSON.parse(await readFile(
  new URL("./fixtures/bv2-medium-create-step-contract.json", import.meta.url), "utf8"));
const contract = deriveBuildSpec(model).contract;
const stepFlows = contract.interactionContract.flows
  .filter((flow) => flow.journeyId === JOURNEY_ID && flow.stepIndex === CREATE_STEP);
const controlId = (field) => stepFlows.find((flow) => flow.kind === "input"
  && flow.control?.logicalField === field)?.control?.machineId;
const identities = {
  flowStart: stepFlows.find((flow) => flow.kind === "flow_start")?.control?.machineId,
  createProject: stepFlows.find((flow) => flow.operationId === "create-project")?.control?.machineId,
  tasksPanel: contract.interactionContract.flows.find((flow) => flow.journeyId === JOURNEY_ID
    && flow.stepIndex === CREATE_STEP + 1 && flow.control?.machineId)?.control?.machineId || "act_tasks_panel",
  title: controlId("title"), clientName: controlId("clientName"), description: controlId("description"),
  ownerId: controlId("ownerId"), dueDate: controlId("dueDate"), status: controlId("status"),
};

/**
 * The projects screen the retained build rendered after its first repair: a flow-entry button that
 * only announces the form, text inputs (owner included), a status select, and one submit control.
 * `broken` keeps every identity but never adds the card — the shape a real defect takes.
 */
const appFor = ({ broken }) => ({
  "src/App.jsx": `import { useState } from "react";

const EMPTY = { title: "", clientName: "", description: "", ownerId: "", dueDate: "", status: "Active" };

export default function App() {
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState(EMPTY);

  function createProject(event) {
    event.preventDefault();
    ${broken
    ? `setMessage("Saving project failed, try again.");
    return;`
    : `const projectId = "project-" + (projects.length + 1);
    setProjects([...projects, { projectId, ...draft }]);
    setSelectedProjectId(projectId);
    setMessage("Project saved: " + draft.title + ".");
    setDraft(EMPTY);`}
  }

  const selected = projects.find((project) => project.projectId === selectedProjectId);
  const field = (key, label, id) => (
    <label key={key}>{label}
      <input data-thrallo-control={id} type="text" value={draft[key]}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
    </label>
  );

  return (
    <main>
      <header>
        <h1>Projects workspace</h1>
        <p>Create project control, task creation form, assignment selectors, and durable work board.</p>
        <button type="button" data-thrallo-action=${JSON.stringify(identities.flowStart)}
          onClick={() => setMessage("Project creation form is ready.")}>Project creation form</button>
      </header>
      {message && <p role="status">{message}</p>}
      <form onSubmit={createProject} aria-label="Create project">
        <h2>Create project</h2>
        {field("title", "Title", ${JSON.stringify(identities.title)})}
        {field("clientName", "Client Name", ${JSON.stringify(identities.clientName)})}
        {field("description", "Description", ${JSON.stringify(identities.description)})}
        {field("ownerId", "Owner Id", ${JSON.stringify(identities.ownerId)})}
        {field("dueDate", "Due Date", ${JSON.stringify(identities.dueDate)})}
        <label>Status
          <select data-thrallo-control=${JSON.stringify(identities.status)} value={draft.status}
            onChange={(event) => setDraft({ ...draft, status: event.target.value })}>
            <option value="Active">Active</option>
            <option value="Paused">Paused</option>
            <option value="Complete">Complete</option>
          </select>
        </label>
        <button type="submit" data-thrallo-action=${JSON.stringify(identities.createProject)}>Create project</button>
      </form>
      <section aria-label="Projects list">
        <h2>Projects list</h2>
        {projects.length === 0 && <p>No projects yet.</p>}
        {projects.map((project) => (
          <article key={project.projectId}>
            <h3>{project.title}</h3>
            <p>Client: {project.clientName}</p>
            <p>Owner: {project.ownerId}</p>
            <p>Due date: {project.dueDate}</p>
            <p>{project.status} status</p>
            <button type="button" data-thrallo-action=${JSON.stringify(identities.tasksPanel)}
              onClick={() => setSelectedProjectId(project.projectId)}>Project card tasks panel</button>
          </article>
        ))}
      </section>
      {selected && (
        <section aria-label="Task creation form">
          <h2>Task creation form for {selected.title}</h2>
        </section>
      )}
    </main>
  );
}
`,
});

// The same journey with a CONTRACT-supplied status value the app's select never offers. Live proof
// (bv2 medium, build d6a2ab65): this exact shape was charged to the verifier as a fixture defect and
// the build stopped with zero repair; it is the application failing a contracted requirement.
const contractedStatusModel = structuredClone(model);
contractedStatusModel.journeys[0].steps[CREATE_STEP].verificationValues = { status: "To Do" };
const contractedStatusContract = deriveBuildSpec(contractedStatusModel).contract;

const CASES = {
  working: { broken: false },
  broken: { broken: true },
  contractedOption: { broken: false, contract: contractedStatusContract },
};
const servers = new Map();
const results = new Map();
const builds = new Map();

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  for (const [name, spec] of Object.entries(CASES)) {
    const caseName = `bv2-flow-entry-operation-${name}`;
    const built = await buildTree({ ...fromScaffold(REACT_VITE), ...appFor(spec) }, caseName, () => {});
    builds.set(name, built);
    if (!built.ok) continue;
    const root = path.join(workDirFor(caseName), "dist");
    const server = http.createServer(async (request, response) => {
      const requested = (request.url || "/").split("?")[0];
      const file = requested === "/" ? "/index.html" : requested;
      try {
        const body = await readFile(path.join(root, file));
        response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript"
          : file.endsWith(".css") ? "text/css" : "text/html" });
        response.end(body);
      } catch {
        try {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(await readFile(path.join(root, "index.html")));
        } catch { response.writeHead(404); response.end("not found"); }
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.set(name, server);
    results.set(name, await verifyJourneys({
      previewUrl: `http://127.0.0.1:${server.address().port}`, contract: spec.contract || contract, timeoutMs: 240_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
    }));
  }
}, { timeout: 900_000 });

after(async () => {
  for (const server of servers.values()) await new Promise((resolve) => server.close(resolve));
});

const transcriptOf = (journey) => journey.steps
  .map((step) => `${String(step.status).padEnd(12)} | ${step.action} | ${step.detail}`).join("\n");

test("the retained contract shape derives entry, inputs and the operation on ONE step", () => {
  const kinds = stepFlows.map((flow) => flow.kind);
  assert.ok(kinds.includes("flow_start"), `flow_start expected, got ${kinds.join(",")}`);
  assert.ok(kinds.includes("action"), `operation action expected, got ${kinds.join(",")}`);
  assert.equal(kinds.filter((kind) => kind === "input").length, 6);
  assert.ok(identities.flowStart && identities.createProject
    && identities.flowStart !== identities.createProject,
  "entry and operation carry distinct machine identities");
  for (const key of ["title", "clientName", "description", "ownerId", "dueDate", "status"]) {
    assert.ok(identities[key], `${key} control identity derived`);
  }
});

test("a working create step passes: entry activated, then the operation control, then the entered title is in the list",
  { ...needsBrowser, timeout: 300_000 }, () => {
    assert.equal(builds.get("working").ok, true, builds.get("working")?.stderr);
    const journey = results.get("working").journeys.find((row) => row.id === JOURNEY_ID);
    const step = journey.steps[CREATE_STEP];
    const transcript = transcriptOf(journey);
    assert.equal(step.status, "pass", `the create step must pass\n${transcript}`);
    const evidence = step.controlEvidence || {};
    assert.equal(evidence.flowEntry?.matchedBy, "machine_identity", `flow entry evidence retained\n${JSON.stringify(evidence)}`);
    assert.equal(evidence.activation?.requiredAtContractedStep, true, `the operation control was activated\n${JSON.stringify(evidence)}`);
    assert.equal(evidence.activation?.matchedBy, "machine_identity", JSON.stringify(evidence.activation));
    const typedTitle = evidence.fields?.find((field) => field.field === "title")?.expectedValue;
    assert.ok(typedTitle, "the step typed a title");
    assert.equal(evidence.collectionMembership?.ok, true, JSON.stringify(evidence.collectionMembership));
    assert.deepEqual(evidence.collectionMembership?.present, [typedTitle],
      "the membership check looks for the ENTERED title, never the literal words \"new project card\"");
  });

test("a create step whose operation persists nothing still fails — the fix weakens nothing",
  { ...needsBrowser, timeout: 300_000 }, () => {
    assert.equal(builds.get("broken").ok, true, builds.get("broken")?.stderr);
    const journey = results.get("broken").journeys.find((row) => row.id === JOURNEY_ID);
    const step = journey.steps[CREATE_STEP];
    const transcript = transcriptOf(journey);
    assert.equal(step.status, "fail", `the broken create step must fail, not pass or go undriveable\n${transcript}`);
    assert.match(step.detail, /does not contain every required member/, transcript);
    const evidence = step.controlEvidence || {};
    assert.equal(evidence.activation?.requiredAtContractedStep, true,
      "the operation control was genuinely activated before the verdict");
    assert.deepEqual(evidence.collectionMembership?.missing,
      [evidence.fields?.find((field) => field.field === "title")?.expectedValue]);
  });

test("a contract-supplied value the app's control never offers is the app's failure, not a verifier fixture defect",
  { ...needsBrowser, timeout: 300_000 }, () => {
    assert.equal(builds.get("contractedOption").ok, true, builds.get("contractedOption")?.stderr);
    const result = results.get("contractedOption");
    const journey = result.journeys.find((row) => row.id === JOURNEY_ID);
    const step = journey.steps[CREATE_STEP];
    const transcript = transcriptOf(journey);
    assert.equal(step.status, "undriveable", transcript);
    assert.equal(step.classification, "APP_FUNCTIONAL_FAILURE", transcript);
    const status = step.controlEvidence?.fields?.find((field) => field.field === "status");
    assert.equal(status?.status, "fixture_invalid", JSON.stringify(status));
    assert.equal(status?.fixtureAuthority, "contract", JSON.stringify(status));
    assert.equal(status?.expectedValue, "To Do", JSON.stringify(status));
    assert.equal(step.verifierDefect, undefined, "the contract's own value is never the verifier's fixture defect");
    assert.deepEqual(result.verifierDefects || [], [], JSON.stringify(result.verifierDefects));
  });
