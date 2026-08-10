// Scaffold primitives must be driveable by THRALLO'S OWN verifier.
//
// The 2026-08-10 paid qualification failed because useSemanticSelection emitted role="radio"
// onto a <button>. That overrode the native role, and journeyVerifier — which locates things to
// act on as button/link/tab — reported "no clickable option was identified" for the date, slot
// and party controls. The control was correct and undriveable at the same time.
//
// The previous scaffold test proved the implementation against ITSELF (getByRole("radio")).
// These tests instead compile a real fixture and run the REAL verifyJourneys() over it, so a
// primitive advertised to the model cannot again be un-driveable by the platform that grades it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import {
  DRIVEABLE_ACTION_ROLES, SELECTED_STATE_ATTRIBUTES,
} from "../../shell/server/lib/builderV2/controlIdentity.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const CASE = "builder-v2-verifier-driveability";

// Three sequential single-selection groups — the exact class that failed live (date, slot,
// party). Domain-neutral names so nothing here is booking-specific.
const APP = {
  "src/components/Choices.jsx": `import { useState } from "react";
import { useSemanticSelection } from "../lib/capabilities";

export function Choices() {
  const [tier, setTier] = useState(null);
  const [region, setRegion] = useState(null);
  const [quantity, setQuantity] = useState(null);
  const tierChoice = useSemanticSelection({ name: "tier", value: tier, onSelect: setTier });
  const regionChoice = useSemanticSelection({ name: "region", value: region, onSelect: setRegion });
  const quantityChoice = useSemanticSelection({ name: "quantity", value: quantity, onSelect: setQuantity });
  return <main>
    <h1>Choose your plan</h1>
    <div {...tierChoice.groupProps}>
      {["Starter", "Standard", "Premium"].map((o) => (
        <button key={o} {...tierChoice.optionProps(o, o + " tier")}>{o} tier</button>
      ))}
    </div>
    <div {...regionChoice.groupProps}>
      {["Europe", "Americas"].map((o) => (
        <button key={o} {...regionChoice.optionProps(o, o + " region")}>{o} region</button>
      ))}
    </div>
    <div {...quantityChoice.groupProps}>
      {[2, 4, 6].map((o) => (
        <button key={o} {...quantityChoice.optionProps(o, o + " seats")}>{o} seats</button>
      ))}
    </div>
    <p id="summary">{[tier, region, quantity].filter(Boolean).join(" / ") || "nothing chosen"}</p>
  </main>;
}`,
  "src/App.jsx": `import { Choices } from "./components/Choices.jsx";
export default function App() { return <Choices />; }`,
};

let server = null;
let baseUrl = "";
let built = null;

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  built = await buildTree({ ...fromScaffold(REACT_VITE), ...APP }, CASE, () => {});
  if (!built.ok) return;
  const root = path.join(workDirFor(CASE), "dist");
  server = http.createServer(async (request, response) => {
    const requested = (request.url || "/").split("?")[0];
    const file = requested === "/" ? "/index.html" : requested;
    try {
      const body = await readFile(path.join(root, file));
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
      response.writeHead(200, { "content-type": type });
      response.end(body);
    } catch { response.writeHead(404); response.end("not found"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

test("the selection fixture compiles", { ...needsBrowser }, () => {
  assert.equal(built.ok, true, built?.stderr);
});

test("the binding emits only roles the real verifier will act on", () => {
  // Static half of the contract: no role override, and selected state uses an accepted attribute.
  const source = REACT_VITE["src/lib/capabilities/react.js"] || "";
  assert.ok(source.length, "the React binding ships in the scaffold");
  assert.equal(/role:\s*["']radio["']/.test(source), false,
    "optionProps must not override the native button role");
  assert.match(source, /"aria-pressed":/, "selected state uses an attribute the platform reads");
  assert.ok(SELECTED_STATE_ATTRIBUTES.includes("aria-pressed"));
  assert.deepEqual(DRIVEABLE_ACTION_ROLES, ["button", "link", "tab"]);
});

// ── the real verifier, driving three sequential groups ────────────────────────────────────────

const CONTRACT = {
  summary: "A plan chooser",
  entities: [], operations: [], routes: [{ path: "/", name: "Home" }], auth: { required: false },
  journeys: [{
    id: "choose-plan", title: "Choose a plan", priority: "primary",
    steps: [
      { action: "open the plan chooser", target: "home", expect: "Choose your plan heading is visible" },
      { action: "select the Premium tier", target: "Premium tier", expect: "Premium is shown in the summary" },
      { action: "select the Americas region", target: "Americas region", expect: "Americas is shown in the summary" },
      { action: "select 6 seats", target: "6 seats", expect: "the summary shows 6" },
    ],
  }],
};

let verdict = null;

test("REAL VERIFIER — verifyJourneys drives every generated option", { ...needsBrowser }, async () => {
  verdict = await verifyJourneys({ previewUrl: baseUrl, contract: CONTRACT, timeoutMs: 120_000 });
  const journey = verdict.journeys[0];
  const detail = (journey.steps || []).map((s) => `${s.status}: ${s.action} — ${s.detail || ""}`).join("\n");

  // The exact live symptom must not appear anywhere.
  assert.equal(/no clickable option was identified/.test(detail), false,
    `the verifier must identify every option:\n${detail}`);
  for (const step of journey.steps || []) {
    assert.notEqual(step.status, "undriveable", `"${step.action}" must be driveable — ${step.detail}`);
  }
  assert.equal(journey.status, "pass", `every step must pass:\n${detail}`);
  assert.deepEqual(verdict.consoleErrors, []);
});

test("SEQUENTIAL GROUPS — each selection lands without disturbing the others", { ...needsBrowser }, async () => {
  const { chromium } = requireCjs("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const pressed = (label) => page.locator(`[aria-label="${label}"]`).getAttribute("aria-pressed");
    const summary = () => page.locator("#summary").textContent();

    assert.equal(await summary(), "nothing chosen");

    // Group A
    await page.getByRole("button", { name: "Premium tier" }).click();
    await page.waitForFunction(() => document.getElementById("summary").textContent.includes("Premium"));
    assert.equal(await pressed("Premium tier"), "true");
    assert.equal(await pressed("Starter tier"), "false");

    // Group B — must not disturb A
    await page.getByRole("button", { name: "Americas region" }).click();
    await page.waitForFunction(() => document.getElementById("summary").textContent.includes("Americas"));
    assert.equal(await pressed("Premium tier"), "true", "group A survives a group B selection");
    assert.equal(await pressed("Americas region"), "true");
    assert.equal(await pressed("Europe region"), "false");

    // Group C — must not disturb A or B
    await page.getByRole("button", { name: "6 seats" }).click();
    await page.waitForFunction(() => document.getElementById("summary").textContent.includes("6"));
    assert.equal(await pressed("Premium tier"), "true", "group A survives a group C selection");
    assert.equal(await pressed("Americas region"), "true", "group B survives a group C selection");
    assert.equal(await pressed("6 seats"), "true");
    assert.equal(await pressed("2 seats"), "false");

    // Exact values propagated downstream, in order.
    assert.equal((await summary()).trim(), "Premium / Americas / 6");

    // Re-selecting within a group moves the state rather than accumulating it.
    await page.getByRole("button", { name: "Starter tier" }).click();
    await page.waitForFunction(() => document.getElementById("summary").textContent.includes("Starter"));
    assert.equal(await pressed("Premium tier"), "false", "one source of truth per group");
    assert.equal(await pressed("Starter tier"), "true");
    assert.equal((await summary()).trim(), "Starter / Americas / 6");
  } finally { await browser.close(); }
});

// ── the exact paid failure, reproduced and fixed ──────────────────────────────────────────────

const ROLE_OVERRIDE_CASE = "builder-v2-verifier-driveability-regression";

test("PAID-FAILURE REGRESSION — role=\"radio\" is undriveable, the shipped binding is not",
  { ...needsBrowser }, async () => {
    await ensureDeps(() => {});
    // The exact generated shape from the live run, in both forms.
    const regression = await buildTree({
      ...fromScaffold(REACT_VITE),
      "src/App.jsx": `import { useState } from "react";
import { useSemanticSelection } from "./lib/capabilities";
const LEGACY = ["alpha", "bravo", "charlie"];
const SHIPPED = ["delta", "echo", "foxtrot"];
export default function App() {
  const [legacy, setLegacy] = useState(null);
  const [shipped, setShipped] = useState(null);
  const choice = useSemanticSelection({ name: "shipped", value: shipped, onSelect: setShipped });
  return <main>
    <h1>Two option groups</h1>
    {/* PRE-FIX SHAPE — exactly what the paid run shipped: role override on a button */}
    <div role="radiogroup" aria-label="legacy group">
      {LEGACY.map((o) => (
        <button key={o} role="radio" aria-checked={legacy === o} aria-label={o + " legacy"}
          onClick={() => setLegacy(o)}>{o} legacy</button>
      ))}
    </div>
    {/* SHIPPED BINDING */}
    <div {...choice.groupProps}>
      {SHIPPED.map((o) => (
        <button key={o} {...choice.optionProps(o, o + " shipped")}>{o} shipped</button>
      ))}
    </div>
    <p id="out">{[legacy, shipped].filter(Boolean).join(",") || "none"}</p>
  </main>;
}`,
    }, ROLE_OVERRIDE_CASE, () => {});
    assert.equal(regression.ok, true, regression.stderr);

    const root = path.join(workDirFor(ROLE_OVERRIDE_CASE), "dist");
    const srv = http.createServer(async (request, response) => {
      const requested = (request.url || "/").split("?")[0];
      const file = requested === "/" ? "/index.html" : requested;
      try {
        const body = await readFile(path.join(root, file));
        const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
        response.writeHead(200, { "content-type": type });
        response.end(body);
      } catch { response.writeHead(404); response.end("not found"); }
    });
    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${srv.address().port}`;
    try {
      const contract = {
        summary: "Slot chooser", entities: [], operations: [],
        routes: [{ path: "/", name: "Home" }], auth: { required: false },
        journeys: [
          { id: "legacy", title: "Legacy role override", priority: "secondary", steps: [
            { action: "select the bravo legacy option", target: "bravo legacy", expect: "bravo appears in the output" },
          ] },
          { id: "shipped", title: "Shipped binding", priority: "primary", steps: [
            { action: "select the echo shipped option", target: "echo shipped", expect: "echo appears in the output" },
          ] },
        ],
      };
      const result = await verifyJourneys({ previewUrl: url, contract, timeoutMs: 120_000 });
      const byId = new Map(result.journeys.map((j) => [j.id, j]));

      // BEFORE the fix — reproduced here as the role-override shape — the verifier cannot act.
      const legacyStep = byId.get("legacy").steps[0];
      assert.notEqual(legacyStep.status, "pass",
        "role=\"radio\" on a button hides it from the verifier — this is the paid failure");

      // AFTER the fix — the shipped binding is found and driven.
      const shippedStep = byId.get("shipped").steps[0];
      assert.equal(shippedStep.status, "pass",
        `the shipped binding must be driveable: ${shippedStep.detail}`);
      assert.equal(/no clickable option was identified/.test(shippedStep.detail || ""), false);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  });
