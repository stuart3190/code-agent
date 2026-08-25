// Contracted browser fixtures must satisfy the control's declared/default input contract before
// the verifier judges a downstream action. The live Roblox-concept build was falsely rejected
// after the verifier typed a 14-character marker into a prompt whose visible default and minimum
// were both longer, then treated the disabled Generate control as successfully activated.

import { after, before, test } from "node:test";
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

const DEFAULT_IDEA = "Mining portals game where players mine ores, fight enemies and bosses, then race to extraction.";
const CASES = {
  contractedDefault: {
    action: "enter the default mining portals idea",
    placeholder: DEFAULT_IDEA,
    minLength: 20,
  },
  declaredMinimum: {
    action: "enter a source idea",
    placeholder: "",
    minLength: 30,
  },
  disabledAction: {
    action: "enter the default mining portals idea",
    placeholder: DEFAULT_IDEA,
    minLength: 20,
    forceDisabled: true,
  },
  networkDedup: {
    action: "enter the default mining portals idea",
    placeholder: DEFAULT_IDEA,
    minLength: 20,
    networkFailure: true,
  },
  declaredFieldTypes: { typed: true },
};

function typedContract() {
  return deriveBuildSpec({
    summary: "Create an auto-layout project", projectType: "web app", version: 1,
    auth: { required: false }, routes: [{ path: "/", name: "Project editor" }],
    entities: [{ name: "project", fields: [
      { name: "projectName", type: "string", required: true },
      { name: "lengthM", type: "number", required: true },
      { name: "targetLux", type: "integer", required: true },
      { name: "targetLuxOverride", type: "boolean", required: false },
    ] }],
    operations: [],
    journeys: [{ id: "create-auto-layout-project", title: "Create an auto-layout project",
      priority: "primary", steps: [
        { action: "open the project editor", target: "/", expect: "the project editor is visible" },
        { action: "enter project and room details", target: "project form",
          operates: ["projectName", "lengthM", "targetLux", "targetLuxOverride"], primitive: "textbox",
          expect: "updated project name, room length, target lux and override state are visible" },
      ] }],
    acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
  }).contract;
}

function contractFor(shape) {
  if (shape.typed) return typedContract();
  const { action } = shape;
  const contract = deriveBuildSpec({
    summary: "Generate a concept", projectType: "web app", version: 1, auth: { required: false },
    routes: [{ path: "/", name: "Dashboard" }],
    entities: [{ name: "concept", fields: [{ name: "sourceIdea", type: "string" }] }],
    operations: [{ name: "generate-concept", entity: "concept", kind: "update" }],
    journeys: [{ id: "generate-concept", title: "Generate a concept", priority: "primary", steps: [
      { action: "open the dashboard", target: "/", expect: "the concept dashboard is visible" },
      { action, target: "source Idea", operates: ["sourceIdea"], primitive: "textbox",
        expect: "the entered source idea remains visible" },
      { action: "start generation", target: "Generate button", reads: ["sourceIdea"],
        expect: "the AI analysis progress panel and changing status are visible" },
      { action: "wait for generated directions", target: "directions panel", reads: ["generate-concept"],
        expect: "three generated directions are visible" },
    ] }],
    acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
  }).contract;
  contract.interactionContract.flows.push({
    id: "generate-concept:3:flow_start", journeyId: "generate-concept", stepIndex: 2,
    kind: "flow_start", semanticPurpose: "start generation", action: "start generation",
    stateOwner: "src/components/generate-concept/GenerateConceptFlow.jsx",
    responsibleModules: ["src/components/generate-concept/GenerateConceptFlow.jsx"],
    reads: ["generate-concept.draft.sourceIdea"], writes: ["generate-concept.flowStarted"],
    dependsOn: [], observable: "the AI analysis progress panel and changing status are visible",
    nextStateRequirement: "the AI analysis progress panel and changing status are visible",
    control: { purpose: "Generate button", accessibleName: "Generate button",
      roles: ["button", "link"], flowEntry: true, stateOwner: "src/components/generate-concept/GenerateConceptFlow.jsx",
      statePath: "generate-concept.flowStarted" },
    capability: null,
  });
  return contract;
}

function appFor({ placeholder, minLength, forceDisabled = false, networkFailure = false, typed = false }) {
  if (typed) return {
    "src/App.jsx": `import { useState } from "react";
export default function App() {
  const [projectName, setProjectName] = useState("");
  const [lengthM, setLengthM] = useState(5.4);
  const [targetLux, setTargetLux] = useState(300);
  const [targetLuxOverride, setTargetLuxOverride] = useState(false);
  return <main><h1>Project editor</h1><form aria-label="project form">
    <label htmlFor="projectName">project Name</label>
    <input id="projectName" name="projectName" aria-label="project Name" required
      value={projectName} onChange={(event) => setProjectName(event.target.value)} />
    <label htmlFor="lengthM">length M</label>
    <input id="lengthM" name="lengthM" aria-label="length M" type="number" min="1" max="20" step="0.1"
      value={lengthM} onChange={(event) => setLengthM(Number(event.target.value))} />
    <label htmlFor="targetLux">target Lux</label>
    <input id="targetLux" name="targetLux" aria-label="target Lux" type="number" min="50" max="1000" step="50"
      value={targetLux} onChange={(event) => setTargetLux(Number(event.target.value))} />
    <label htmlFor="targetLuxOverride">target Lux Override</label>
    <input id="targetLuxOverride" name="targetLuxOverride" aria-label="target Lux Override" type="checkbox"
      checked={targetLuxOverride} onChange={(event) => setTargetLuxOverride(event.target.checked)} />
  </form><p>Updated project name {projectName}; room length {lengthM}; target lux {targetLux};
    override state {String(targetLuxOverride)} are visible</p></main>;
}`,
  };
  return {
    "src/App.jsx": `import { useEffect, useState } from "react";
export default function App() {
  const [sourceIdea, setSourceIdea] = useState("");
  const [started, setStarted] = useState(false);
  const valid = ${forceDisabled ? "false" : `sourceIdea.trim().length >= ${minLength}`};
  ${networkFailure ? "useEffect(() => { fetch('/fixture-401').catch(() => {}); }, []);" : ""}
  return <main>
    <h1>Concept dashboard</h1>
    <label htmlFor="sourceIdea">source Idea</label>
    <textarea id="sourceIdea" name="sourceIdea" aria-label="source Idea"
      minLength={${minLength}} placeholder=${JSON.stringify(placeholder)} value={sourceIdea}
      onChange={(event) => setSourceIdea(event.target.value)} />
    <p>Entered source idea remains visible: {sourceIdea}</p>
    <button type="button" aria-label="Generate button" disabled={!valid}
      onClick={() => setStarted(true)}>Generate button</button>
    {started && <section><h2>AI analysis progress panel</h2><p>Changing status is visible</p>
      <p>Three generated directions are visible</p></section>}
  </main>;
}`,
  };
}

const servers = new Map();
const results = new Map();
const builds = new Map();

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  for (const [name, shape] of Object.entries(CASES)) {
    const caseName = `bv2-verifier-fixture-${name}`;
    const built = await buildTree({ ...fromScaffold(REACT_VITE), ...appFor(shape) }, caseName, () => {});
    builds.set(name, built);
    if (!built.ok) continue;
    const root = path.join(workDirFor(caseName), "dist");
    const server = http.createServer(async (request, response) => {
      const requested = (request.url || "/").split("?")[0];
      if (requested === "/fixture-401") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "expected fixture failure" }));
        return;
      }
      const file = requested === "/" ? "/index.html" : requested;
      try {
        const body = await readFile(path.join(root, file));
        response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript"
          : file.endsWith(".css") ? "text/css" : "text/html" });
        response.end(body);
      } catch {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(await readFile(path.join(root, "index.html")));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.set(name, server);
    results.set(name, await verifyJourneys({
      previewUrl: `http://127.0.0.1:${server.address().port}`,
      contract: contractFor(shape), timeoutMs: 120_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
    }));
  }
}, { timeout: 900_000 });

after(async () => {
  for (const server of servers.values()) await new Promise((resolve) => server.close(resolve));
});

for (const [name, shape] of Object.entries(CASES)) {
  test(`${name}: verifier enters a valid fixture before activating the contracted flow`,
    { ...needsBrowser, timeout: 240_000 }, () => {
      assert.equal(builds.get(name).ok, true, builds.get(name)?.stderr);
      const journey = results.get(name).journeys[0];
      const transcript = journey.steps.map((step) => `${step.status}: ${step.action} — ${step.detail}`).join("\n");
      if (shape.typed) {
        assert.equal(journey.status, "pass", `${transcript}\n${JSON.stringify(journey, null, 2)}`);
        const fields = new Map(journey.steps[1].controlEvidence.fields.map((field) => [field.field, field]));
        assert.equal(fields.get("projectName").status, "filled", JSON.stringify(fields.get("projectName")));
        for (const fieldName of ["lengthM", "targetLux"]) {
          const field = fields.get(fieldName);
          assert.equal(field.status, "filled", JSON.stringify(field));
          assert.equal(field.facts.type, "number", JSON.stringify(field));
          assert.equal(Number.isFinite(Number(field.expectedValue)), true, JSON.stringify(field));
          assert.equal(field.observedValue, field.expectedValue, JSON.stringify(field));
        }
        const toggle = fields.get("targetLuxOverride");
        assert.equal(toggle.status, "filled", JSON.stringify(toggle));
        assert.equal(toggle.facts.type, "checkbox", JSON.stringify(toggle));
        assert.equal(toggle.previousValue, "false", JSON.stringify(toggle));
        assert.equal(toggle.expectedValue, "true", JSON.stringify(toggle));
        assert.equal(toggle.observedValue, "true", JSON.stringify(toggle));
        return;
      }
      if (shape.forceDisabled) {
        assert.equal(journey.status, "fail", `${transcript}\n${JSON.stringify(journey, null, 2)}`);
        assert.equal(journey.steps[2].classification, "APP_FUNCTIONAL_FAILURE", transcript);
        assert.equal(journey.steps[2].drove, false, "a swallowed click failure must never be reported as activation");
        return;
      }
      assert.equal(journey.status, "pass", `${transcript}\n${JSON.stringify(journey, null, 2)}`);
      const field = journey.steps[1].controlEvidence.fields[0];
      assert.equal(field.status, "filled", JSON.stringify(field));
      assert.ok(field.expectedValue.length >= shape.minLength, JSON.stringify(field));
      if (shape.placeholder) assert.equal(field.expectedValue, shape.placeholder);
      assert.equal(journey.steps[2].status, "pass", transcript);
      if (shape.networkFailure) {
        assert.deepEqual(results.get(name).consoleErrors, [], "generic resource-load console noise is redundant");
        assert.equal(results.get(name).failedRequests.filter((request) => request.includes("/fixture-401")).length, 1,
          JSON.stringify(results.get(name)));
      }
    });
}
