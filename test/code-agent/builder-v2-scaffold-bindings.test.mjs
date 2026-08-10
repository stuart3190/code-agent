// The platform React bindings, driven in a REAL browser.
//
// The audit's finding was that Thrallo demanded correct selection-state and accessible-name
// wiring from the model, statically, on every build — and rejected candidates that got the
// shape wrong. These bindings make that wiring assembly rather than invention: the properties
// the browser verifier needs are produced by construction.
//
// A hook that renders correctly only in a unit test is worthless, so this drives the real
// compiled output with Playwright and asserts what a verifier would actually observe.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const CASE = "builder-v2-scaffold-bindings";

// A minimal application built ENTIRELY from the bindings: a capability store for state, a
// semantic field, a semantic selection group and a live status region.
const APP = {
  "src/data/flow.js": `import { makeWizardMachine } from "../lib/capabilities";
export const flow = makeWizardMachine({
  id: "demo",
  steps: ["details", "slot"],
  persistence: null,
});`,
  "src/App.jsx": `import { useCapabilityState, useSemanticField, useSemanticSelection, useStatusRegion } from "./lib/capabilities";
import { flow } from "./data/flow.js";

export default function App() {
  const state = useCapabilityState(flow, (snapshot) => snapshot.values);
  const email = useSemanticField({ name: "customerEmail", value: state.customerEmail || "", type: "email",
    onChange: (value) => flow.setValue("customerEmail", value) });
  const slot = useSemanticSelection({ name: "slot", value: state.slot || null,
    onSelect: (value) => flow.setValue("slot", value) });
  const status = useStatusRegion({ label: "Selection status" });

  return <main>
    <label {...email.labelProps} />
    <input {...email.inputProps} />
    <div {...slot.groupProps}>
      {["10:00", "11:00"].map((option) => (
        <button key={option} {...slot.optionProps(option)}>{option}</button>
      ))}
    </div>
    <p {...status.statusProps}>
      {state.slot ? \`Chosen slot \${state.slot}\` : "No slot chosen"}
    </p>
    <p id="echo">{state.customerEmail || "no email"}</p>
  </main>;
}`,
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
      const type = file.endsWith(".js") ? "text/javascript"
        : file.endsWith(".css") ? "text/css" : "text/html";
      response.writeHead(200, { "content-type": type });
      response.end(body);
    } catch {
      response.writeHead(404); response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test("the binding-built application compiles", { ...needsBrowser }, () => {
  assert.equal(built.ok, true, built?.stderr);
});

test("semantic props produce controls a verifier can find and drive", { ...needsBrowser }, async () => {
  const { chromium } = requireCjs("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.goto(baseUrl, { waitUntil: "networkidle" });

    // Accessible name by construction: located exactly as journeyVerifier locates controls.
    const email = page.getByLabel(/customer email/i);
    assert.equal(await email.count(), 1, "the field has one accessible name");
    await email.fill("visitor@example.com");
    await assert.doesNotReject(page.waitForFunction(
      () => document.getElementById("echo")?.textContent === "visitor@example.com",
      null, { timeout: 5_000 },
    ), "typing propagates to the capability store");

    // Selected state by construction: observable before AND after, which is what a browser
    // verifier asserts and what hand-rolled selection wiring repeatedly failed to expose.
    const slot = page.getByRole("button", { name: "11:00" });
    assert.equal(await slot.getAttribute("aria-pressed"), "false", "unchosen first");
    await slot.click();
    await assert.doesNotReject(page.waitForFunction(
      () => document.querySelector('[aria-label="11:00"]')?.getAttribute("aria-pressed") === "true",
      null, { timeout: 5_000 },
    ), "the click adds a visible selected state");

    // The status region announces the transition, so the outcome is newly visible text.
    const status = page.getByRole("status");
    assert.match(await status.textContent(), /Chosen slot 11:00/);

    assert.deepEqual(consoleErrors, [], "no console errors");
  } finally {
    await browser.close();
  }
});

test("useCapabilityState re-renders from the store, not from local component state", { ...needsBrowser }, async () => {
  const { chromium } = requireCjs("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "10:00" }).click();
    await page.waitForFunction(
      () => document.querySelector('[aria-label="10:00"]')?.getAttribute("aria-pressed") === "true",
      null, { timeout: 5_000 },
    );
    // Selecting the other option must move the selected state, proving a single source of truth.
    await page.getByRole("button", { name: "11:00" }).click();
    await page.waitForFunction(() => (
      document.querySelector('[aria-label="10:00"]')?.getAttribute("aria-pressed") === "false"
      && document.querySelector('[aria-label="11:00"]')?.getAttribute("aria-pressed") === "true"
    ), null, { timeout: 5_000 });
  } finally {
    await browser.close();
  }
});
