// Retained production regression e6b8b2c0: the generated competition app accepted only the
// domain-correct skill answer "100", while verification invented "Journey <marker>" and then
// blamed the correctly rejecting app. Contract v2 makes that non-secret fixture authoritative.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }

const contract = deriveBuildSpec({
  summary: "A visitor completes a sample competition entry and sees its confirmation.",
  projectType: "form", version: 2, auth: { required: false, rules: [] },
  routes: [{ path: "/", name: "Competition entry", auth: false }],
  entities: [{ name: "demoEntry", owned: false, storage: "client-only transient state", fields: [
    { name: "skillAnswer", type: "string", required: true },
    { name: "reference", type: "string", required: true },
  ], relationships: [] }],
  operations: [],
  journeys: [{ id: "enter-competition", title: "Complete a sample entry", priority: "primary",
    stage: "primary_journey", steps: [
      { action: "open the competition entry", target: "/", expect: "the skill question is visible" },
      { action: "enter the correct skill question answer", target: "skill answer field",
        operates: ["skillAnswer"], primitive: "textbox", verificationValues: { skillAnswer: "100" },
        expect: "the entered skill answer is visible" },
      { action: "submit the demo entry", target: "demo checkout button",
        expect: "an in-app confirmation with a reference number is visible" },
    ], acceptance: ["the correct sample answer permits confirmation"] }],
  acceptance: [
    { id: "a1", statement: "the skill question is visible", journey: "enter-competition" },
    { id: "a2", statement: "the entered skill answer is visible", journey: "enter-competition" },
    { id: "a3", statement: "an in-app confirmation with a reference number is visible", journey: "enter-competition" },
  ], states: [], deferred: [], imageIntents: [], integrations: [],
}).contract;

const answerFlow = contract.interactionContract.flows.find((flow) => (
  flow.journeyId === "enter-competition" && flow.valueWritten === "skillAnswer"
));
assert.equal(answerFlow.control.verificationValue, "100",
  "the build spec must carry the planner fixture into the browser interaction authority");

const app = {
  "src/App.jsx": `import { useState } from "react";
export default function App() {
  const [skillAnswer, setSkillAnswer] = useState("");
  const [confirmation, setConfirmation] = useState(false);
  return <main><h1>Skill question: What is 40 + 60?</h1>
    <label htmlFor="skillAnswer">skill Answer</label>
    <input id="skillAnswer" name="skillAnswer" aria-label="skill Answer" value={skillAnswer}
      onChange={(event) => setSkillAnswer(event.target.value)} />
    <p>The entered skill answer is visible: {skillAnswer}</p>
    <button type="button" aria-label="demo checkout button"
      onClick={() => setConfirmation(skillAnswer === "100")}>Demo checkout button</button>
    {confirmation && <p>In-app confirmation with reference number BC-DEMO-100 is visible</p>}
  </main>;
}`,
};

let server;
let built;
let result;

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  built = await buildTree({ ...fromScaffold(REACT_VITE), ...app }, "bv2-retained-competition-fixture", () => {});
  if (!built.ok) return;
  const root = path.join(workDirFor("bv2-retained-competition-fixture"), "dist");
  server = http.createServer(async (request, response) => {
    const requested = (request.url || "/").split("?")[0];
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
  result = await verifyJourneys({
    previewUrl: `http://127.0.0.1:${server.address().port}`, contract, timeoutMs: 60_000,
  });
}, { timeout: 300_000 });

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("retained competition journey uses the contract fixture and reaches confirmation",
  { skip: playwrightAvailable ? false : "requires playwright", timeout: 120_000 }, () => {
    assert.equal(built.ok, true, built?.stderr);
    const journey = result.journeys[0];
    const transcript = journey.steps.map((step) => `${step.status}: ${step.action} - ${step.detail}`).join("\n");
    assert.equal(journey.status, "pass", `${transcript}\n${JSON.stringify(journey, null, 2)}`);
    const field = journey.steps[1].controlEvidence.fields[0];
    assert.equal(field.expectedValue, "100", JSON.stringify(field));
    assert.equal(field.observedValue, "100", JSON.stringify(field));
    assert.equal(field.fixtureAuthority, "contract", JSON.stringify(field));
    assert.equal(journey.steps[2].status, "pass", transcript);
  });
