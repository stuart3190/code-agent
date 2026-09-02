// Two contracted shapes the model writes for things that are not controls, from one live build
// (bv2 medium qualification, build a5396ba2 on a18d823):
//
//   1. "clear all filters" targeting a "clear filters button" while operating clearFilters: boolean.
//      The derivation produced a checkbox; the reset rule asked it to be false and found it already
//      false. Nothing could ever transition, and three repair waves had nothing to repair. A reset
//      step that names a button and operates only a boolean field is one activation.
//
//   2. "load the current summary" targeting an "analytics summary panel" while operating a
//      read-only calculation with no input of its own. The derivation produced a button named
//      after a passive surface; the application computes on arrival and offers no such button.
//      When no control exists under that identity, nothing durable is written and the step typed
//      nothing, the contracted result being visible is the operation having run.
//
// Both fixtures are that build's own journeys (fixtures/bv2-medium-reset-button-contract.json,
// fixtures/bv2-medium-load-on-arrival-contract.json), so the derived flows and identities match.

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

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const resetContract = deriveBuildSpec(await load("bv2-medium-reset-button-contract.json")).contract;
const loadContract = deriveBuildSpec(await load("bv2-medium-load-on-arrival-contract.json")).contract;
const flowsOf = (contract, journeyId, stepIndex) => contract.interactionContract.flows
  .filter((flow) => flow.journeyId === journeyId && flow.stepIndex === stepIndex);

const RESET_JOURNEY = "filter-board-and-list-views";
const LOAD_JOURNEY = "view-analytics-summary";
const resetIds = {
  searchText: flowsOf(resetContract, RESET_JOURNEY, 1).find((flow) => flow.control?.logicalField === "searchText")?.control?.machineId,
  statusFilter: flowsOf(resetContract, RESET_JOURNEY, 1).find((flow) => flow.control?.logicalField === "statusFilter")?.control?.machineId,
  apply: flowsOf(resetContract, RESET_JOURNEY, 1).find((flow) => flow.operationId === "filter-tasks")?.control?.machineId,
  clear: flowsOf(resetContract, RESET_JOURNEY, 2)[0]?.control?.machineId,
};
const loadIds = { summary: flowsOf(loadContract, LOAD_JOURNEY, 1)[0]?.control?.machineId };

const tasksApp = ({ broken }) => ({
  "src/App.jsx": `import { useState } from "react";

const TASKS = [
  { id: "t1", title: "Kickoff meeting", status: "todo" },
  { id: "t2", title: "Design review", status: "in-progress" },
  { id: "t3", title: "Kickoff follow-up", status: "done" },
  { id: "t4", title: "Ship release", status: "todo" },
];

export default function App() {
  const [draft, setDraft] = useState({ searchText: "", statusFilter: "all-statuses" });
  const [applied, setApplied] = useState({ searchText: "", statusFilter: "all-statuses" });
  const rows = TASKS.filter((task) => (applied.statusFilter === "all-statuses" || task.status === applied.statusFilter)
    && task.title.toLowerCase().includes(applied.searchText.toLowerCase()));
  const active = applied.searchText || applied.statusFilter !== "all-statuses";
  function clearFilters() {
    ${broken ? "setApplied({ ...applied });" : "setDraft({ searchText: \"\", statusFilter: \"all-statuses\" }); setApplied({ searchText: \"\", statusFilter: \"all-statuses\" });"}
  }
  return (
    <main>
      <h1>Task list</h1>
      <p>The list view shows task rows and search and filter controls.</p>
      <section aria-label="task list search and filters">
        <label>Search Text
          <input data-thrallo-control=${JSON.stringify(resetIds.searchText)} type="text" value={draft.searchText}
            onChange={(event) => setDraft({ ...draft, searchText: event.target.value })} />
        </label>
        <label>Status Filter
          <select data-thrallo-control=${JSON.stringify(resetIds.statusFilter)} value={draft.statusFilter}
            onChange={(event) => setDraft({ ...draft, statusFilter: event.target.value })}>
            <option value="all-statuses">All statuses</option>
            <option value="todo">To Do</option>
            <option value="in-progress">In Progress</option>
            <option value="done">Done</option>
          </select>
        </label>
        <button type="button" data-thrallo-action=${JSON.stringify(resetIds.apply)} onClick={() => setApplied({ ...draft })}>Apply filters</button>
        <button type="button" data-thrallo-action=${JSON.stringify(resetIds.clear)} onClick={clearFilters}>Clear filters</button>
      </section>
      {active && <p role="status">Filter summary: {applied.searchText ? "search " + applied.searchText : ""} {applied.statusFilter !== "all-statuses" ? "status " + applied.statusFilter : ""}</p>}
      <section aria-label="task rows">
        <h2>Task rows</h2>
        <ul>{rows.map((task) => <li key={task.id}>{task.title} · {task.status}</li>)}</ul>
        <p>{rows.length} of {TASKS.length} tasks visible{active ? "" : " · full task list"}</p>
      </section>
    </main>
  );
}
`,
});

const analyticsApp = ({ broken }) => ({
  "src/App.jsx": `import { useEffect, useState } from "react";

const PROJECTS = [{ id: "p1", status: "active" }, { id: "p2", status: "active" }];
const TASKS = [
  { id: "t1", status: "done", dueDate: "2026-01-01" }, { id: "t2", status: "blocked", dueDate: "2026-01-01" },
  { id: "t3", status: "todo", dueDate: "2999-01-01" }, { id: "t4", status: "in-progress", dueDate: "2026-01-01" },
];

export default function App() {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    const completed = TASKS.filter((task) => task.status === "done").length;
    setSummary({
      totalProjects: PROJECTS.length, totalTasks: TASKS.length, completedTasks: completed,
      blockedTasks: TASKS.filter((task) => task.status === "blocked").length,
      overdueTasks: TASKS.filter((task) => task.status !== "done" && task.dueDate < "2026-09-01").length,
      completionRate: Math.round((completed / TASKS.length) * 100),
    });
  }, []);
  const breakdown = ["To Do", "In Progress", "Review", "Blocked", "Done"].map((label) => ({ label,
    count: TASKS.filter((task) => task.status === label.toLowerCase().replace(" ", "-")).length }));
  return (
    <main>
      <h1>Analytics Summary</h1>
      ${broken ? "" : "<p>Metric cards computed from saved projects and tasks.</p>"}
      ${broken ? "<p>Numbers unavailable right now.</p>" : `<section aria-label="metric cards">
        {summary && <ul>
          <li>Total projects: {summary.totalProjects}</li>
          <li>Total tasks: {summary.totalTasks}</li>
          <li>Completed tasks: {summary.completedTasks}</li>
          <li>Blocked tasks: {summary.blockedTasks}</li>
          <li>Overdue tasks: {summary.overdueTasks}</li>
          <li>Completion rate: {summary.completionRate}%</li>
        </ul>}
      </section>`}
      <section aria-label="status breakdown">
        <h2>Status breakdown</h2>
        <ul>{breakdown.map((row) => <li key={row.label}>{row.label}: {row.count}</li>)}</ul>
      </section>
    </main>
  );
}
`,
});

const CASES = {
  resetWorking: { app: tasksApp({ broken: false }), contract: resetContract },
  resetBroken: { app: tasksApp({ broken: true }), contract: resetContract },
  loadWorking: { app: analyticsApp({ broken: false }), contract: loadContract },
  loadBroken: { app: analyticsApp({ broken: true }), contract: loadContract },
};
const servers = new Map();
const results = new Map();
const builds = new Map();

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  for (const [name, spec] of Object.entries(CASES)) {
    const caseName = `bv2-passive-operations-${name}`;
    const built = await buildTree({ ...fromScaffold(REACT_VITE), ...spec.app }, caseName, () => {});
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
      previewUrl: `http://127.0.0.1:${server.address().port}`, contract: spec.contract, timeoutMs: 240_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
    }));
  }
}, { timeout: 900_000 });

after(async () => {
  for (const server of servers.values()) await new Promise((resolve) => server.close(resolve));
});

const transcriptOf = (journey) => (journey.steps || [])
  .map((step) => `${String(step.status).padEnd(12)} | ${step.action} | ${step.detail}`).join("\n");

test("a reset step naming a button and operating only a boolean field derives one button action", () => {
  const [flow, ...rest] = flowsOf(resetContract, RESET_JOURNEY, 2);
  assert.equal(rest.length, 0);
  assert.equal(flow.kind, "action");
  assert.deepEqual(flow.control.roles, ["button"]);
  assert.equal(flow.control.accessibleName, "clear filters button");
  assert.equal(flow.control.logicalField, "clearFilters");
  assert.equal(flow.control.resetsState, true);
  assert.ok(resetIds.clear, "the reset action carries a machine identity");
  assert.equal(resetContract.interactionContract.valid, true, JSON.stringify(resetContract.interactionContract.problems));
});

test("clearing filters through the contracted button passes when the controls really reset",
  { ...needsBrowser, timeout: 300_000 }, () => {
    assert.equal(builds.get("resetWorking").ok, true, builds.get("resetWorking")?.stderr);
    const journey = results.get("resetWorking").journeys.find((row) => row.id === RESET_JOURNEY);
    const transcript = transcriptOf(journey);
    assert.equal(journey.steps[1]?.status, "pass", `the search step sets the filters up\n${transcript}`);
    assert.equal(journey.steps[2]?.status, "pass", `the reset button drives the reset\n${transcript}`);
    assert.equal(journey.steps[2]?.controlEvidence?.activation?.matchedBy, "machine_identity", JSON.stringify(journey.steps[2]?.controlEvidence));
    assert.equal(journey.steps[2]?.controlEvidence?.resetTransition?.ok, true,
      `the reset is proven by the controls returning to their defaults
${JSON.stringify(journey.steps[2]?.controlEvidence?.resetTransition)}`);
  });

// The minimal contract policy passes a step whose contracted words are visible and records an
// advisory when nothing moved; that leniency belongs to the policy, not to this rule. What this
// rule must guarantee is that the reset is DRIVEN as a button and its outcome measured honestly.
test("a clear button that resets nothing is driven and recorded as an unobserved reset", { ...needsBrowser, timeout: 300_000 }, () => {
  assert.equal(builds.get("resetBroken").ok, true, builds.get("resetBroken")?.stderr);
  const journey = results.get("resetBroken").journeys.find((row) => row.id === RESET_JOURNEY);
  const transcript = transcriptOf(journey);
  assert.equal(journey.steps[1]?.status, "pass", transcript);
  const evidence = journey.steps[2]?.controlEvidence || {};
  assert.equal(evidence.activation?.matchedBy, "machine_identity", JSON.stringify(evidence));
  assert.deepEqual(evidence.resetTransition, { checked: true, ok: false, changes: [] }, JSON.stringify(evidence));
  assert.ok((journey.steps[2]?.advisories || []).some((row) => row.code === "text_freshness_not_observed"),
    `the unobserved reset is recorded
${JSON.stringify(journey.steps[2])}`);
});

test("a read-only operation with no input is proven by its visible result when the app offers no control for it",
  { ...needsBrowser, timeout: 300_000 }, () => {
    assert.equal(builds.get("loadWorking").ok, true, builds.get("loadWorking")?.stderr);
    const journey = results.get("loadWorking").journeys.find((row) => row.id === LOAD_JOURNEY);
    const transcript = transcriptOf(journey);
    assert.equal(journey.steps[1]?.status, "pass", `the summary loads on arrival\n${transcript}`);
    assert.equal(journey.steps[1]?.controlEvidence?.activation?.matchedBy, "read_operation_applied_on_load",
      JSON.stringify(journey.steps[1]?.controlEvidence?.activation));
    assert.equal(journey.steps[2]?.status, "pass", transcript);
  });

test("a read-only operation whose result never appears stays undriveable", { ...needsBrowser, timeout: 300_000 }, () => {
  assert.equal(builds.get("loadBroken").ok, true, builds.get("loadBroken")?.stderr);
  const journey = results.get("loadBroken").journeys.find((row) => row.id === LOAD_JOURNEY);
  const transcript = transcriptOf(journey);
  assert.notEqual(journey.steps[1]?.status, "pass", transcript);
  assert.match(journey.steps[1]?.detail || "", /was not offered/, transcript);
});
