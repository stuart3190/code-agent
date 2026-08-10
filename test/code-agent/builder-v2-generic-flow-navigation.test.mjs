// The correction, proved on a NON-BOOKING multi-step flow — and proved not to invent passes.
//
// The live defect was diagnosed on a booking wizard, so the fix must be shown to be generic and
// to be a fix rather than a loosening. Three fixtures, one contract shape, zero provider calls:
//
//   1. checkout   — a strictly step-gated checkout wizard (delivery speed → card brand →
//                   crate count → buyer email → review → confirm). Every contracted selection must
//                   drive its OWN group, reached through real Continue navigation.
//   2. decoy      — the same app with the card-brand group REPLACED by an unrelated group whose
//                   rendered text echoes the card step's expectation prose. This is the exact
//                   shape that produced the live false pass. The graded verifier passes it; the
//                   corrected verifier must report it undriveable and never green.
//   3. stale-review — the same app whose review screen shows the contracted VOCABULARY but not
//                   the values that were actually entered. The review-freshness exemption
//                   (3b5a523) must not rescue it.
//
// The contract's interaction contract is derived by the production code (deriveBuildSpec), never
// hand-written, and journeyVerifier is driven through its real entry point against real Chromium.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIVE_VERIFIER = path.join(HERE, "fixtures", "live-journeyVerifier-b45a327.mjs");

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

// ── the contract, and the interaction contract the production derivation makes of it ──────────

const RAW_CONTRACT = {
  summary: "A multi-step checkout", projectType: "web app", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Checkout" }],
  entities: [{ name: "order", fields: [
    { name: "deliverySpeed", type: "string" }, { name: "cardBrand", type: "string" },
    { name: "crateCount", type: "number" }, { name: "buyerEmail", type: "string" },
    { name: "status", type: "string" }] }],
  operations: [
    { name: "create-order", entity: "order", kind: "create" },
    { name: "read-order-by-reference", entity: "order", kind: "read" }],
  journeys: [{ id: "complete-checkout", title: "A buyer completes a checkout", priority: "primary", steps: [
    { action: "open the store page", target: "/",
      expect: "the storefront headline and a visible 'Start checkout' control are shown" },
    { action: "click the Start checkout control", target: "Start checkout control",
      expect: "step 1 is visible with the title 'Choose delivery' and the shipping options" },
    { action: "select a delivery speed", target: "delivery speed picker",
      expect: "the selected delivery speed is highlighted and the card step becomes available" },
    { action: "select a card brand", target: "card brand picker",
      expect: "the selected card brand is highlighted and the crate count step becomes available" },
    { action: "choose a crate count within stock", target: "crate count control",
      expect: "the selected crate count is displayed and the buyer details step becomes available" },
    { action: "enter a valid buyer email", target: "buyer details form",
      expect: "the buyer fields show valid state and the review step becomes available" },
    { action: "review the order", target: "review step",
      expect: "the exact selected delivery speed, card brand, crate count and buyer email are displayed before confirmation" },
    { action: "confirm the order", target: "Confirm order control",
      expect: "a confirmation screen appears with status 'Confirmed' and a durable order reference" },
  ] }],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
};

const SPEC = deriveBuildSpec(RAW_CONTRACT);
const CONTRACT = SPEC.contract;

test("the production derivation gives each contracted step exactly one control", () => {
  assert.equal(SPEC.verdict.ok, true, JSON.stringify(SPEC.verdict.problems));
  const selections = SPEC.interactionContract.flows.filter((flow) => flow.kind === "selection");
  assert.deepEqual(selections.map((flow) => flow.control.logicalField),
    ["deliverySpeed", "cardBrand", "crateCount"]);
  assert.deepEqual(selections.map((flow) => flow.stepIndex), [2, 3, 4]);
  // Nothing in the contract says how to move between the steps. That is the gap under test.
  assert.equal(SPEC.interactionContract.flows.some((flow) => /advance|continue|next/i.test(flow.kind)), false);
});

// ── the fixtures ──────────────────────────────────────────────────────────────────────────────

const DATA = `import { makeWizardMachine } from "../lib/capabilities/wizard.js";

let saved = null;
const memory = {
  async save(state) { saved = JSON.parse(JSON.stringify(state)); },
  async load() { return saved ? JSON.parse(JSON.stringify(saved)) : null; },
  async clear() { saved = null; },
};

export const SPEEDS = [{ value: "standard", label: "Standard" }, { value: "express", label: "Express" }];
export const CARDS = [{ value: "visa", label: "Visa" }, { value: "amex", label: "Amex" }];
export const CRATE_COUNTS = [1, 2, 3];

export const wizard = makeWizardMachine({
  id: "complete-checkout",
  steps: ["delivery", "card", "crateCount", "buyer", "review"],
  initialValues: { started: false, deliverySpeed: null, cardBrand: null, crateCount: null, buyerEmail: "" },
  persistence: memory,
  validate: ({ stepId, values }) => {
    const errors = {};
    if (stepId === "delivery" && !values.deliverySpeed) errors.deliverySpeed = "required";
    if (stepId === "card" && !values.cardBrand) errors.cardBrand = "required";
    if (stepId === "crateCount" && !values.crateCount) errors.crateCount = "required";
    if (stepId === "buyer" && !values.buyerEmail) errors.buyerEmail = "required";
    return errors;
  },
  onConfirm: async () => ({ reference: "ORD-4471" }),
});
`;

/**
 * @param {{ decoyCardGroup?: boolean, staleReview?: boolean }} options
 */
const flowSource = ({ decoyCardGroup = false, staleReview = false }) => `import { useCapabilityState, useSemanticSelection, useSemanticField } from "../lib/capabilities/react.js";
import { wizard, SPEEDS, CARDS, CRATE_COUNTS } from "../data/checkout.js";

export function CheckoutFlow() {
  const state = useCapabilityState(wizard);
  const values = state.values || {};
  const speed = useSemanticSelection({ name: "deliverySpeed", value: values.deliverySpeed, onSelect: (v) => wizard.select("deliverySpeed", v) });
  const card = useSemanticSelection({ name: ${decoyCardGroup ? '"giftWrap"' : '"cardBrand"'}, value: values.cardBrand, onSelect: (v) => wizard.select(${decoyCardGroup ? '"giftWrap"' : '"cardBrand"'}, v) });
  const crateCount = useSemanticSelection({ name: "crateCount", value: values.crateCount, onSelect: (v) => wizard.select("crateCount", v) });
  const email = useSemanticField({ name: "buyerEmail", type: "email", value: values.buyerEmail, onChange: (v) => wizard.setValue("buyerEmail", v) });

  if (state.status === "confirmed") return <main>
    <h1>Order Confirmed</h1>
    <p>A confirmation screen. Status: Confirmed. Durable order reference {state.confirmation ? state.confirmation.reference : ""}.</p>
  </main>;

  if (!values.started) return <main>
    <h1>Northwind Supply</h1>
    <p>The storefront headline for a supply company.</p>
    <div><button type="button" onClick={() => wizard.setValue("started", true)}>Start checkout</button></div>
  </main>;

  return <main>
    <h2>Choose delivery</h2>
    <p>Step 1 title: Choose delivery — the shipping options.</p>

    {state.stepId === "delivery" ? <>
      <h3>Delivery speeds</h3>
      <div {...speed.groupProps}>
        {SPEEDS.map((s) => (
          <button key={s.value} {...speed.optionProps(s.value, "Choose delivery speed " + s.label)}>
            <span style={{ display: "block" }}>{s.label} delivery</span>
            {values.deliverySpeed === s.value ? <span style={{ display: "block" }}>selected delivery speed is highlighted</span> : null}
          </button>
        ))}
      </div>
    </> : null}

    {state.stepId === "card" ? <>
      <div {...card.groupProps}>
        {CARDS.map((c) => (
          <button key={c.value} {...card.optionProps(c.value, ${decoyCardGroup ? '"Choose gift wrap " + c.label' : '"Choose card brand " + c.label'})}>
            <span style={{ display: "block" }}>{c.label}</span>
            <span style={{ display: "block" }}>selected card brand is highlighted</span>
          </button>
        ))}
      </div>
    </> : null}

    {state.stepId === "crateCount" ? <>
      <div {...crateCount.groupProps}>
        {CRATE_COUNTS.map((q) => (
          <button key={q} {...crateCount.optionProps(q, "Choose crate count " + q)}>
            <span style={{ display: "block" }}>{q} units</span>
            {values.crateCount === q ? <span style={{ display: "block" }}>selected crate count is displayed</span> : null}
          </button>
        ))}
      </div>
    </> : null}

    {state.stepId === "buyer" ? <div>
      <label {...email.labelProps} /><input {...email.inputProps} />
    </div> : null}

    {state.stepId === "review" ? <section>
      <h3>Review</h3>
      <p>The exact selected delivery speed, card brand, crate count and buyer email are displayed before confirmation.</p>
      ${staleReview ? "" : `<p>{values.deliverySpeed} · {values.cardBrand} · {String(values.crateCount)} · {values.buyerEmail}</p>`}
      <div><button type="button" onClick={() => { wizard.confirm().catch(() => {}); }}>Confirm order</button></div>
    </section> : null}

    <div><button type="button" onClick={() => { wizard.next(); }}>Continue</button></div>
  </main>;
}
`;

const SHAPES = {
  checkout: {},
  decoy: { decoyCardGroup: true },
  "stale-review": { staleReview: true },
};

const servers = new Map();
const urls = new Map();
const builds = new Map();

async function serve(caseName) {
  const root = path.join(workDirFor(caseName), "dist");
  const server = http.createServer(async (request, response) => {
    const file = (request.url || "/").split("?")[0] === "/" ? "/index.html" : (request.url || "/").split("?")[0];
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
  servers.set(caseName, server);
  return `http://127.0.0.1:${server.address().port}`;
}

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  for (const [shape, options] of Object.entries(SHAPES)) {
    const caseName = `bv2-generic-flow-${shape}`;
    const built = await buildTree({
      ...fromScaffold(REACT_VITE),
      "src/data/checkout.js": DATA,
      "src/components/CheckoutFlow.jsx": flowSource(options),
      "src/App.jsx": `import { CheckoutFlow } from "./components/CheckoutFlow.jsx";\nexport default function App() { return <CheckoutFlow />; }\n`,
    }, caseName, () => {});
    builds.set(shape, built);
    if (built.ok) urls.set(shape, await serve(caseName));
  }
}, { timeout: 900_000 });

after(async () => {
  for (const server of servers.values()) await new Promise((resolve) => server.close(resolve));
});

test("all three checkout fixtures compile", { ...needsBrowser }, () => {
  for (const [shape, built] of builds) assert.equal(built.ok, true, `${shape}: ${built?.stderr}`);
});

const line = (step) => `${step.status.padEnd(11)} | ${step.action} | ${(step.detail || "").replace(/\n/g, "\\n")}`;

test("NON-BOOKING step-gated checkout: each contracted selection drives its own control",
  { ...needsBrowser, timeout: 300_000 }, async () => {
    const result = await verifyJourneys({ previewUrl: urls.get("checkout"), contract: CONTRACT, timeoutMs: 180_000 });
    const steps = result.journeys[0].steps;
    const transcript = steps.map(line).join("\n");
    console.log(`\n[checkout · corrected verifier]\n${transcript}\n`);

    assert.match(steps[2].detail, /Standard|Express/, `delivery drives delivery\n${transcript}`);
    assert.equal(steps[2].status, "pass", transcript);
    assert.equal(steps[3].status, "pass", transcript);
    assert.match(steps[3].detail, /Visa|Amex/, `card drives card, not delivery\n${transcript}`);
    assert.equal(/Standard|Express/.test(steps[3].detail), false, transcript);
    assert.equal(steps[4].status, "pass", transcript);
    assert.match(steps[4].detail, /units/, `the crate-count step drives the crate count\n${transcript}`);
    assert.equal(steps[5].status, "pass", `the buyer step becomes reachable\n${transcript}`);
    assert.equal(steps[6].status, "pass", `review verifies the exact values\n${transcript}`);
    assert.match(steps[6].detail, /exact entered value/, transcript);
    assert.equal(result.journeys[0].status, "pass", transcript);
  });

test("DECOY group: the graded verifier passes it, the corrected verifier refuses to",
  { ...needsBrowser, timeout: 300_000 }, async () => {
    const { verifyJourneys: gradedVerify } = await import(`file://${LIVE_VERIFIER.replace(/\\/g, "/")}`);
    const graded = await gradedVerify({ previewUrl: urls.get("decoy"), contract: CONTRACT, timeoutMs: 180_000 });
    const gradedSteps = graded.journeys[0].steps;
    console.log(`\n[decoy · graded verifier]\n${gradedSteps.map(line).join("\n")}\n`);

    const corrected = await verifyJourneys({ previewUrl: urls.get("decoy"), contract: CONTRACT, timeoutMs: 180_000 });
    const steps = corrected.journeys[0].steps;
    const transcript = steps.map(line).join("\n");
    console.log(`\n[decoy · corrected verifier]\n${transcript}\n`);

    // The whole point: an app that does not offer the contracted control cannot be green.
    assert.notEqual(steps[3].status, "pass",
      `the card step must not pass against a group named for something else\n${transcript}`);
    assert.match(steps[3].detail, /no selectable control group matched contracted field cardBrand/, transcript);
    assert.notEqual(corrected.journeys[0].status, "pass", transcript);
  });

test("REVIEW FRESHNESS (3b5a523): vocabulary alone cannot satisfy a review step",
  { ...needsBrowser, timeout: 300_000 }, async () => {
    const result = await verifyJourneys({ previewUrl: urls.get("stale-review"), contract: CONTRACT, timeoutMs: 180_000 });
    const steps = result.journeys[0].steps;
    const transcript = steps.map(line).join("\n");
    console.log(`\n[stale-review · corrected verifier]\n${transcript}\n`);

    // The review screen renders every contracted word and none of the entered values. The
    // exemption trades freshness for the STRONGER value check, so this must fail.
    assert.equal(steps[6].status, "fail", `a values-free review must fail\n${transcript}`);
    assert.match(steps[6].detail, /review omitted exact contracted values/, transcript);
    assert.notEqual(result.journeys[0].status, "pass", transcript);
  });
