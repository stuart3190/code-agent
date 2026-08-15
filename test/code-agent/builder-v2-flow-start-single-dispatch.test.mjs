// flow_start must drive EXACTLY ONE control, and never fall through into generic clicking.
//
// The defect this pins cost three sessions to find. The flow_start branch activated the contracted
// entry control correctly and then fell through, so the generic keyword click path ran on the same
// step. Its verb test is a loose alternation — /…|book|use/i, no word boundaries — so
// "start the booking flow" matched on `book`, and its role candidates included a LINK named
// "Look up booking". The driver opened the wizard and immediately navigated out of it to /manage,
// and the step failed with "found none" because the manage page holds none of the wizard's words.
//
// Both fixtures therefore render the entry control AND a decoy whose name collides with the
// action's own vocabulary. If a second dispatch ever returns, the flow leaves the wizard and these
// go red. Nothing here asserts that clicking alone passes a step: the contracted expectation still
// decides the verdict.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  shouldSubmitContractedForm,
  verifyJourneys,
} from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

/**
 * @param {object} shape
 * @param {string} shape.entry     the contracted entry control's label
 * @param {string} shape.decoy     a control whose name collides with the action's vocabulary
 * @param {string} shape.heading   copy proving the flow actually opened
 */
const appFor = ({ entry, decoy, heading }) => ({
  "src/App.jsx": `import { useState } from "react";
import { useSemanticSelection } from "./lib/capabilities/react.js";

export default function App() {
  const [started, setStarted] = useState(false);
  const [tier, setTier] = useState(null);
  const choice = useSemanticSelection({ name: "tierId", value: tier, onSelect: setTier });
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/elsewhere")) {
    return <main><h1>Somewhere else entirely</h1><p>This page is not the flow.</p></main>;
  }
  if (!started) return <main>
    <h1>Northwind</h1>
    <p>The Northwind headline and summary are shown.</p>
    <div><button type="button" onClick={() => setStarted(true)}>${entry}</button></div>
    <div><a href="/elsewhere">${decoy}</a></div>
  </main>;
  return <main>
    <p>${heading}</p>
    <div {...choice.groupProps}>
      {["Bronze", "Silver"].map((t) => (
        <button key={t} {...choice.optionProps(t, "tier Id " + t)}>
          <span style={{ display: "block" }}>Tier Id {t}</span>
        </button>
      ))}
    </div>
    <div><a href="/elsewhere">${decoy}</a></div>
  </main>;
}`,
});

const contractFor = ({ id, action, target, expect }) => deriveBuildSpec({
  summary: "Single dispatch", projectType: "web app", version: 1, auth: { required: false },
  routes: [{ path: "/", name: "Home" }],
  entities: [{ name: "record", fields: [{ name: "tierId", type: "string" }] }],
  operations: [{ name: "create-record", entity: "record", kind: "create" }],
  journeys: [{ id, title: id, priority: "primary", steps: [
    { action: "open the home page", target: "/", expect: "the Northwind headline and summary are shown" },
    { action, target, expect },
    { action: "select a tier", target: "tier picker", expect: "the selected tier is highlighted" },
  ] }],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
}).contract;

const CASES = {
  booking: {
    app: appFor({ entry: "Start booking", decoy: "Look up booking",
      heading: "The booking wizard shows the available dates and the current step indicator." }),
    contract: contractFor({ id: "start-booking", action: "start the booking flow",
      target: "start booking control",
      expect: "the available dates and the current wizard step indicator are shown" }),
  },
  checkout: {
    app: appFor({ entry: "Begin checkout", decoy: "View checkout history",
      heading: "The checkout wizard shows the available tiers and the current step indicator." }),
    contract: contractFor({ id: "begin-checkout", action: "begin checkout",
      target: "begin checkout control",
      expect: "the available tiers and the current wizard step indicator are shown" }),
  },
};

const servers = new Map();
const results = new Map();
const builds = new Map();

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  for (const [name, spec] of Object.entries(CASES)) {
    const caseName = `bv2-single-dispatch-${name}`;
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
      previewUrl: `http://127.0.0.1:${server.address().port}`, contract: spec.contract, timeoutMs: 180_000,
    }));
  }
}, { timeout: 900_000 });

after(async () => {
  for (const server of servers.values()) await new Promise((resolve) => server.close(resolve));
});

for (const name of Object.keys(CASES)) {
  test(`${name}: flow_start drives the contracted control and nothing else`,
    { ...needsBrowser, timeout: 300_000 }, () => {
      assert.equal(builds.get(name).ok, true, builds.get(name)?.stderr);
      const journey = results.get(name).journeys[0];
      const steps = journey.steps;
      const transcript = steps.map((s) => `${String(s.status).padEnd(12)} | ${s.action} | ${s.detail}`).join("\n");

      // The entry step passes on its CONTRACTED EXPECTATION, not merely because a click happened.
      assert.equal(steps[1].status, "pass", `flow entry must pass\n${transcript}`);
      assert.match(steps[1].detail, /found: /, `the verdict comes from the expectation\n${transcript}`);

      // The decoy was never activated: had the generic path fired a second time it would have
      // followed the link, and the flow's own vocabulary could not then be visible.
      assert.equal(/Somewhere else entirely/.test(steps[1].detail || ""), false, transcript);

      // And the flow really is open — the step after it drives a control that only exists inside.
      assert.equal(steps[2].status, "pass", `the flow stayed open\n${transcript}`);
      assert.match(steps[2].detail, /Bronze|Silver/, transcript);
    });
}

test("the contracts derive flow_start, so these cases exercise the real dispatch", () => {
  for (const [name, spec] of Object.entries(CASES)) {
    const kinds = spec.contract.interactionContract.flows.map((flow) => `${flow.stepIndex}:${flow.kind}`);
    assert.ok(kinds.includes("1:flow_start"), `${name} must derive flow_start, got ${kinds.join(" ")}`);
  }
});

test("the generic click path is still available to steps with no contracted action kind", async () => {
  // The guard must be narrow: it suppresses generic clicking only after a contracted kind has
  // driven. Removing generic clicking wholesale would strand every uncontracted step.
  const source = await readFile(path.join(workDirFor("."), "..", "..", "shell", "server", "lib",
    "appBuild", "journeyVerifier.mjs"), "utf8").catch(async () => readFile(
    new URL("../../shell/server/lib/appBuild/journeyVerifier.mjs", import.meta.url), "utf8"));
  assert.match(source, /!droveStepper && !contractDriven &&/);
  assert.match(source, /let contractDriven = false;/);
});

test("contracted edit and iteration fields submit their owning form", () => {
  for (const action of [
    "Change the selected object's properties",
    "Edit the selected object",
    "Update its material",
    "Enter an iteration request",
    "Iterate on the generated asset",
  ]) {
    assert.equal(shouldSubmitContractedForm(action), true, action);
  }
  assert.equal(shouldSubmitContractedForm("Inspect the selected object"), false);
});
