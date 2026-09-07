// A secondary journey's SETUP judges the producing journey's durable commit by the same rules the
// journey driver applies to that very step.
//
// Retained defect (bv2 medium qualification, build a708c296 on 83dde91): the primary journey passed
// its create-project step on the contracted collection containing the entered title, then the
// isolated filter-board-view journey replayed that same chain as its prerequisite and failed it —
// "new project form: the durable mutation did not reach its contracted observable state". The
// replay accepted only keyword FRESHNESS for the observable, and "the new project appears in the
// projects list with its title, client, owner, status, and due date" names nothing the form's own
// labels had not already shown. Every secondary journey started "not reached", the defect was
// attributed to the app's extension module, and two repair waves could not move a verdict the app
// had no part in.
//
// The fixture contract is that live contract's own primary and consumer journeys (sign-in steps
// removed); its derived prerequisite chain is identical: /projects, six inputs, the durable create
// mutation under machine identity act_6a90b035.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { journeyPrerequisites, verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { MINIMAL_CONTRACT_VERIFIER_POLICY } from "../../shell/server/lib/appBuild/verifierPolicy.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { verificationExecutionContract } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const PRIMARY = "create-and-update-work";
const CONSUMER = "filter-board-view";

const model = JSON.parse(await readFile(
  new URL("./fixtures/bv2-medium-consumer-replay-contract.json", import.meta.url), "utf8"));
const contract = deriveBuildSpec(model).contract;
const consumerJourney = contract.journeys.find((journey) => journey.id === CONSUMER);
// Production verifies each secondary journey in isolation with the complete contract retained for
// prerequisite reconstruction — the exact shape the orchestrator hands the verifier.
const isolated = verificationExecutionContract(contract, [consumerJourney], [consumerJourney]);
const createFlows = contract.interactionContract.flows
  .filter((flow) => flow.journeyId === PRIMARY && flow.stepIndex === 1);
const controlId = (field) => createFlows.find((flow) => flow.kind === "input"
  && flow.control?.logicalField === field)?.control?.machineId;
const identities = {
  createProject: createFlows.find((flow) => flow.kind === "mutation")?.control?.machineId,
  projectTitle: controlId("projectTitle"), projectDescription: controlId("projectDescription"),
  clientName: controlId("clientName"), projectStatus: controlId("projectStatus"),
  projectOwnerId: controlId("projectOwnerId"), projectDueDate: controlId("projectDueDate"),
};

const prerequisiteChain = () => {
  const scenario = contract.interactionContract.scenarios[CONSUMER];
  const primaryScenario = contract.interactionContract.scenarios[PRIMARY];
  const produces = primaryScenario.role === "produces" && scenario.role === "consumes"
    && Boolean(scenario.lifecycle) && scenario.lifecycle === primaryScenario.lifecycle;
  return journeyPrerequisites(isolated.prerequisiteInteractionContract.flows, CONSUMER, PRIMARY, {
    requiresPrimaryRecord: produces, reconstructIsolated: true,
    primaryProducesDurableRecord: produces, requiresAuthenticatedStart: false,
  });
};

/**
 * The projects screen the live build rendered: every observable keyword ("project", "projects",
 * "list", "title", "client", "owner", "status", "due", "date") is on the page BEFORE the commit,
 * so only the contracted collection can prove the record. `broken` keeps every identity and label
 * but never adds the card.
 */
const taskFlows = contract.interactionContract.flows.filter((flow) => flow.journeyId === PRIMARY && flow.stepIndex === 3);
const taskInputs = taskFlows.filter((flow) => flow.kind === "input").map((flow) => flow.control);
const taskCommit = taskFlows.find((flow) => flow.durableOperation === "create");
const appFor = ({ broken, brokenTask = false }) => ({
  "src/App.jsx": `import { useState } from "react";

const EMPTY = { projectTitle: "", projectDescription: "", clientName: "", projectStatus: "", projectOwnerId: "", projectDueDate: "" };
const load = () => { try { return JSON.parse(localStorage.getItem("projects") || "[]"); } catch { return []; } };

function ProjectsScreen() {
  const [projects, setProjects] = useState(load);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState(EMPTY);
  function createProject(event) {
    event.preventDefault();
    ${broken
    ? `setMessage("Saving project failed, try again.");
    return;`
    : `const next = [...projects, { projectId: "project-" + (projects.length + 1), ...draft }];
    localStorage.setItem("projects", JSON.stringify(next));
    setProjects(next);
    setMessage("Project saved.");
    setDraft(EMPTY);`}
  }
  const field = (key, label, id) => (
    <label key={key}>{label}
      <input data-thrallo-control={id} type="text" value={draft[key]}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} />
    </label>
  );
  return (
    <main>
      <h1>Projects workspace</h1>
      <p>Create a new project; the project list shows each project with its title, client, owner, status and due date.</p>
      {message && <p role="status">{message}</p>}
      <form aria-label="new project form" onSubmit={createProject}>
        <h2>New project</h2>
        {field("projectTitle", "Project Title", ${JSON.stringify(identities.projectTitle)})}
        {field("projectDescription", "Project Description", ${JSON.stringify(identities.projectDescription)})}
        {field("clientName", "Client Name", ${JSON.stringify(identities.clientName)})}
        {field("projectStatus", "Project Status", ${JSON.stringify(identities.projectStatus)})}
        {field("projectOwnerId", "Project Owner Id", ${JSON.stringify(identities.projectOwnerId)})}
        {field("projectDueDate", "Project Due Date", ${JSON.stringify(identities.projectDueDate)})}
        <button type="submit" data-thrallo-action=${JSON.stringify(identities.createProject)}>new project form</button>
      </form>
      <section aria-label="Projects list">
        <h2>Projects list</h2>
        {projects.length === 0 && <p>No projects yet.</p>}
        {projects.map((project) => (
          <article key={project.projectId}>
            <h3>{project.projectTitle}</h3>
            <p>Client: {project.clientName}</p>
            <p>Owner: {project.projectOwnerId}</p>
            <p>Due date: {project.projectDueDate}</p>
            <p>{project.projectStatus} status</p>
          </article>
        ))}
      </section>
      <a href="/board">Board</a>
    </main>
  );
}

function BoardScreen() {
  const projects = load();
  const [tasks, setTasks] = useState(() => JSON.parse(localStorage.getItem("tasks") || "[]"));
  const [draft, setDraft] = useState({});
  const fields = ${JSON.stringify(taskInputs)};
  function createTask(event) {
    event.preventDefault();
    if (${JSON.stringify(brokenTask)}) return;
    const next = [...tasks, { ...draft, taskId: "task-" + (tasks.length + 1) }];
    localStorage.setItem("tasks", JSON.stringify(next));
    setTasks(next);
    setDraft({});
  }
  return (
    <main>
      <h1>Task board</h1>
      <p>The board shows task cards and filter controls for every saved project.</p>
      <section aria-label="board filter controls"><h2>Filter controls</h2><p>No filters applied.</p></section>
      <form aria-label="new task form" onSubmit={createTask}>
        {fields.map((field) => <label key={field.machineId}>{field.logicalField}
          <input data-thrallo-control={field.machineId} value={draft[field.logicalField] || ""}
            onChange={(event) => setDraft({ ...draft, [field.logicalField]: event.target.value })} />
        </label>)}
        <button data-thrallo-action=${JSON.stringify(taskCommit.control.machineId)} type="submit">new task form</button>
      </form>
      <section aria-label="task cards"><h2>Task cards</h2>
        {projects.map((project) => <article key={project.projectId}>{project.projectTitle}</article>)}
        {tasks.map((task) => <section key={task.taskId} aria-label={task.taskStatus + " status column"}>
          <h2>{task.taskStatus} status column</h2>
          <article aria-label="task card"><h3>{task.taskTitle}</h3>
            <p>Project: {task.projectId}</p><p>Owner: {task.taskOwnerId}</p>
            <p>Priority: {task.taskPriority}</p><p>Due date: {task.taskDueDate}</p>
            <p>{task.taskDescription}</p>
          </article>
        </section>)}
      </section>
      <a href="/projects">Projects</a>
    </main>
  );
}

export default function App() {
  const pathname = typeof window === "undefined" ? "/" : window.location.pathname;
  if (pathname.startsWith("/board")) return <BoardScreen />;
  return <ProjectsScreen />;
}
`,
});

const CASES = { working: { broken: false }, broken: { broken: true }, brokenTask: { broken: false, brokenTask: true } };
const servers = new Map();
const results = new Map();
const builds = new Map();

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  for (const [name, spec] of Object.entries(CASES)) {
    const caseName = `bv2-prerequisite-replay-${name}`;
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
      previewUrl: `http://127.0.0.1:${server.address().port}`, contract: isolated, timeoutMs: 240_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
    }));
  }
}, { timeout: 900_000 });

after(async () => {
  for (const server of servers.values()) await new Promise((resolve) => server.close(resolve));
});

const transcriptOf = (journey) => (journey.steps || [])
  .map((step) => `${String(step.status).padEnd(12)} | ${step.action} | ${step.detail}`).join("\n");

test("the live contract shape replays both required durable create mutations", () => {
  const chain = prerequisiteChain().controls;
  const kinds = chain.map((flow) => flow.kind);
  assert.deepEqual(kinds.slice(0, 8), ["navigation", "input", "input", "input", "input", "input", "input", "mutation"], kinds.join(","));
  assert.deepEqual(chain.filter((flow) => flow.durableOperation === "create").map((flow) => flow.entity), ["project", "task"]);
  const mutation = chain.at(-1);
  assert.equal(chain[7].control.machineId, identities.createProject);
  assert.equal(mutation.control.machineId, taskCommit.control.machineId);
  assert.ok(mutation.durableLifecycle, "the replayed commit is a durable mutation");
  assert.match(chain[7].observable, /appears in the projects list/);
  for (const key of Object.keys(identities)) assert.ok(identities[key], `${key} identity derived`);
});

test("setup accepts the contracted collection containing the entered title, exactly as the journey driver does",
  { ...needsBrowser, timeout: 300_000 }, () => {
    assert.equal(builds.get("working").ok, true, builds.get("working")?.stderr);
    const journey = results.get("working").journeys.find((row) => row.id === CONSUMER);
    const transcript = transcriptOf(journey);
    assert.equal(journey.setup?.ok ?? true, true, `prerequisites must be established\n${JSON.stringify(journey.setup)}`);
    assert.equal(journey.steps[0]?.status, "pass", `the consumer's first step runs\n${transcript}`);
    assert.doesNotMatch(journey.steps[0]?.detail || "", /required starting state/, transcript);
  });

test("a working project commit cannot conceal a failed task prerequisite", needsBrowser, () => {
  assert.equal(builds.get("brokenTask").ok, true, builds.get("brokenTask")?.stderr);
  const journey = results.get("brokenTask").journeys.find((row) => row.id === CONSUMER);
  assert.equal(journey.setup?.ok, false, JSON.stringify(journey.setup));
  assert.equal(journey.setup.failure.producerInteractionId, taskCommit.id);
});

test("setup still fails when the replayed commit persists nothing — the rule is not weakened",
  { ...needsBrowser, timeout: 300_000 }, () => {
    assert.equal(builds.get("broken").ok, true, builds.get("broken")?.stderr);
    const journey = results.get("broken").journeys.find((row) => row.id === CONSUMER);
    assert.equal(journey.setup?.ok, false, JSON.stringify(journey.setup));
    assert.equal(journey.setup.failure.control, "new project form");
    assert.match(journey.setup.failure.reason, /did not reach its contracted observable state/);
    assert.equal(journey.status, "undriveable", transcriptOf(journey));
  });
