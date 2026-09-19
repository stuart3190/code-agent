// Zero-model release proof for deterministic Builder V2 capability composition.
// No provider, Supabase, billing, worker queue, or customer project is contacted.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { deriveBuildSpec } from "../shell/server/lib/builderV2/buildSpec.mjs";
import {
  composeCapabilityFoundation, validateCapabilityComposition,
} from "../shell/server/lib/builderV2/capabilityComposer.mjs";
import { validateModuleConformance } from "../shell/server/lib/builderV2/moduleContracts.mjs";
import { deriveVerificationManifest } from "../shell/server/lib/builderV2/verificationManifest.mjs";
import { fromScaffold } from "../src/engine/fileTree.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../harness/workspace.mjs";

const requireCjs = createRequire(import.meta.url);
const { chromium } = requireCjs("playwright");
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

const contract = ({ summary, entities, operations, journey }) => ({
  summary, entities, operations, journeys: [journey], routes: [{ path: "/", name: "Workspace" }],
  auth: { required: false }, deferred: [], imageIntents: [], integrations: [],
});

const CONTRACTS = {
  crud: contract({
    summary: "generic business record workflow",
    entities: [{ name: "workItem", fields: [
      { name: "title", type: "string", required: true },
      { name: "status", type: "string", required: true },
    ] }],
    operations: [
      { id: "create-item", entity: "workItem", kind: "create", journey: "record-workflow" },
      { id: "update-item", entity: "workItem", kind: "update", journey: "record-workflow" },
      { id: "delete-item", entity: "workItem", kind: "delete", journey: "record-workflow" },
    ],
    journey: { id: "record-workflow", title: "Record workflow", priority: "primary", steps: [
      { action: "enter a record title", target: "title", operates: ["title"], primitive: "textbox", expect: "the title remains visible" },
      { action: "create the record", target: "create record", operates: ["create-item"], expect: "the record is visible" },
      { action: "change the record status", target: "change status", operates: ["status"], primitive: "selection", expect: "the changed status is visible" },
      { action: "delete the record", target: "delete record", operates: ["delete-item"], expect: "the record is removed" },
    ] },
  }),
  transaction: contract({
    summary: "generic multi-step transactional application",
    entities: [{ name: "transaction", fields: [
      { name: "method", type: "string", required: true },
      { name: "amount", type: "number", required: true },
    ] }],
    operations: [{ id: "create-transaction", entity: "transaction", kind: "create", journey: "transaction-wizard" }],
    journey: { id: "transaction-wizard", title: "Transaction wizard", priority: "primary", steps: [
      { action: "select a method", target: "method", operates: ["method"], primitive: "selection", expect: "the method is selected" },
      { action: "continue to amount", target: "continue", expect: "the amount step opens" },
      { action: "enter an amount", target: "amount", operates: ["amount"], primitive: "textbox", expect: "the amount remains visible" },
      { action: "review the transaction", target: "review", expect: "the selected values are shown" },
      { action: "confirm the transaction", target: "confirm transaction", operates: ["create-transaction"], expect: "the transaction is confirmed" },
      { action: "reload the page", target: "/", expect: "the confirmed transaction is restored" },
    ] },
  }),
  interactive: contract({
    summary: "generic interactive calculation and object workspace",
    entities: [{ name: "project", fields: [
      { name: "width", type: "number", required: true },
      { name: "height", type: "number", required: true },
    ] }],
    operations: [
      { id: "calculate-result", entity: "project", kind: "calculate", journey: "interactive-workspace" },
      { id: "move-object", entity: "project", kind: "transform", journey: "interactive-workspace" },
      { id: "save-project", entity: "project", kind: "create", journey: "interactive-workspace" },
    ],
    journey: { id: "interactive-workspace", title: "Interactive workspace", priority: "primary", steps: [
      { action: "enter width and height", target: "dimensions", operates: ["width", "height"], primitive: "textbox", expect: "the dimensions remain visible" },
      { action: "calculate the result", target: "calculate result", operates: ["calculate-result"], expect: "the derived result is visible" },
      { action: "move the selected object", target: "move object", operates: ["move-object"], expect: "the object position changes" },
      { action: "save the project", target: "save project", operates: ["save-project"], expect: "the project is saved" },
    ] },
  }),
};

const BACKEND_FIXTURE = `const request = async (action, type, payload = {}) => {
  const response = await fetch("/__capability_fixture", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, type, ...payload }) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
};
export const db = { entity(type) { return {
  list: (options = {}) => request("list", type, { options }), get: (id) => request("get", type, { id }),
  create: (data) => request("create", type, { data }), update: (id, data) => request("update", type, { id, data }),
  delete: (id) => request("delete", type, { id }), count: () => request("count", type), subscribe: () => () => {},
}; } };
export const auth = { currentUser: async () => ({ id: "proof-user" }), signOut: async () => {}, signIn: async () => ({ id: "proof-user" }), signUp: async () => ({ id: "proof-user" }) };
export const storage = {};
`;

const CRUD_APP = `import { useEffect, useState } from "react";
import { entityStore, useSemanticAction, useSemanticField, useStatusRegion } from "./lib/capabilities/composed/index.js";
const store = entityStore("workItem");
export default function App() {
  const [title, setTitle] = useState(""); const [row, setRow] = useState(null); const [message, setMessage] = useState("Ready");
  const field = useSemanticField({ name: "title", label: "Record title", value: title, onChange: setTitle });
  const status = useStatusRegion({ label: "Record status" });
  const create = useSemanticAction({ name: "create record", label: "Create record", onActivate: async () => { const next = await store.create({ title, status: "open" }); setRow(next); setMessage("Record created"); } });
  const change = useSemanticAction({ name: "change status", label: "Change status", onActivate: async () => { const next = await store.update(row.id, { status: "closed" }); setRow(next); setMessage("Status closed"); } });
  const remove = useSemanticAction({ name: "delete record", label: "Delete record", onActivate: async () => { await store.remove(row.id); setRow(null); setMessage("Record removed"); } });
  useEffect(() => { store.list().then((rows) => setRow(rows[0] || null)); }, []);
  return <main className="ledger"><header><small>OPERATIONS LEDGER</small><h1>Work register</h1></header><section className="card">
    <label {...field.labelProps}/><input {...field.inputProps}/><button {...create.buttonProps}>Create record</button>
    {row && <article data-testid="record"><strong>{row.title}</strong><span>{row.status}</span><button {...change.buttonProps}>Change status</button><button {...remove.buttonProps}>Delete record</button></article>}
    <p {...status.statusProps}>{message}</p></section></main>;
}`;

const TRANSACTION_APP = `import { useState } from "react";
import { entityStore, useCapabilityState, useFlowAdvance, useSemanticAction, useSemanticField, useSemanticSelection, wizardFor } from "./lib/capabilities/composed/index.js";
const wizard = wizardFor("transaction-wizard"); const transactions = entityStore("transaction");
export default function App() {
  const state = useCapabilityState(wizard); const [confirmed, setConfirmed] = useState(null);
  const method = useSemanticSelection({ name: "method", value: state.values.method, onSelect: (value) => wizard.select("method", value) });
  const amount = useSemanticField({ name: "amount", type: "number", value: state.values.amount || "", onChange: (value) => wizard.setValue("amount", value) });
  const next = useFlowAdvance({ label: "Continue", onActivate: () => wizard.next() });
  const confirm = useSemanticAction({ name: "confirm transaction", label: "Confirm transaction", onActivate: async () => { const row = await transactions.create(state.values); await wizard.confirm(); setConfirmed(row); } });
  if (state.status === "confirmed") return <main className="receipt"><p>TRANSACTION TERMINAL</p><h1>Confirmed</h1><strong>{confirmed?.id || "Restored transaction"}</strong><p>Method {state.values.method}, amount {state.values.amount}</p></main>;
  return <main className="transaction"><aside><b>01</b><b>02</b><b>03</b></aside><section><h1>Complete a transaction</h1>
    {state.stepIndex === 0 && <div {...method.groupProps}>{["direct", "scheduled"].map((value) => <button key={value} {...method.optionProps(value)}>{value}</button>)}</div>}
    {state.stepIndex === 1 && <><label {...amount.labelProps}/><input {...amount.inputProps}/></>}
    {state.stepIndex >= 2 && <div data-testid="review">Review {state.values.method} {state.values.amount}<button {...confirm.buttonProps}>Confirm transaction</button></div>}
    {state.stepIndex < 2 && <button {...next.buttonProps}>Continue</button>}</section></main>;
}`;

const CUSTOM_MODULE = `export function runInteractiveWorkspaceCustomBehavior(input) {
  const width = Number(input.width) || 0; const height = Number(input.height) || 0;
  return { result: width * height, position: { x: Number(input.x || 0) + 24, y: Number(input.y || 0) + 12 } };
}`;
const INTERACTIVE_APP = `import { useState } from "react";
import { entityStore, useSemanticAction, useSemanticField, useStatusRegion } from "./lib/capabilities/composed/index.js";
import { runInteractiveWorkspaceCustomBehavior } from "./extensions/custom/interactive-workspace.js";
const projects = entityStore("project");
export default function App() {
  const [draft, setDraft] = useState({ width: "", height: "", x: 0, y: 0 }); const [output, setOutput] = useState(null); const [message, setMessage] = useState("Unsaved");
  const width = useSemanticField({ name: "width", type: "number", value: draft.width, onChange: (value) => setDraft({ ...draft, width: value }) });
  const height = useSemanticField({ name: "height", type: "number", value: draft.height, onChange: (value) => setDraft({ ...draft, height: value }) });
  const status = useStatusRegion({ label: "Project status" });
  const calculate = useSemanticAction({ name: "calculate result", label: "Calculate result", onActivate: () => setOutput(runInteractiveWorkspaceCustomBehavior(draft)) });
  const move = useSemanticAction({ name: "move object", label: "Move object", onActivate: () => { const next = runInteractiveWorkspaceCustomBehavior({ ...draft, ...(output?.position || {}) }); setOutput(next); } });
  const save = useSemanticAction({ name: "save project", label: "Save project", onActivate: async () => { await projects.create({ ...draft, output }); setMessage("Project saved"); } });
  return <main className="studio"><nav>VECTOR LAB / 03</nav><section className="controls"><h1>Spatial calculator</h1><label {...width.labelProps}/><input {...width.inputProps}/><label {...height.labelProps}/><input {...height.inputProps}/><button {...calculate.buttonProps}>Calculate result</button><button {...save.buttonProps}>Save project</button><p {...status.statusProps}>{message}</p></section>
    <section className="canvas"><div className="object" style={{ transform: \`translate(\${output?.position.x || 0}px, \${output?.position.y || 0}px)\` }}/><output>{output ? \`Area \${output.result}\` : "Awaiting dimensions"}</output><button {...move.buttonProps}>Move object</button></section></main>;
}`;

const STYLES = {
  crud: `.ledger{max-width:760px;margin:5rem auto;font-family:Georgia;background:#f3efe2;color:#252019;padding:3rem}.card{border-top:4px double #252019;padding-top:2rem;display:grid;gap:1rem}.card article{display:flex;gap:1rem;align-items:center}`,
  transaction: `.transaction{min-height:100vh;display:grid;grid-template-columns:90px 1fr;background:#102234;color:#e8f1f7;font-family:system-ui}.transaction aside{background:#f4b942;color:#102234;display:grid;align-content:center;gap:2rem;text-align:center}.transaction section{max-width:720px;padding:10vh 8vw}.transaction button,.transaction input{margin:1rem;padding:1rem}.receipt{margin:12vh auto;max-width:620px;border:1px solid;padding:4rem;font-family:monospace}`,
  interactive: `.studio{min-height:100vh;display:grid;grid-template-columns:360px 1fr;grid-template-rows:60px 1fr;background:#090b10;color:#d8ff44;font-family:Arial}.studio nav{grid-column:1/-1;border-bottom:1px solid #46511c;padding:20px}.controls{padding:2rem;display:grid;gap:1rem}.canvas{position:relative;margin:2rem;border:1px solid #46511c;overflow:hidden}.object{position:absolute;left:120px;top:100px;width:120px;height:90px;background:#d8ff44}.canvas output{position:absolute;right:20px;top:20px}.canvas button{position:absolute;bottom:20px;right:20px}`,
};

function fixtureTree(name, spec) {
  const composed = composeCapabilityFoundation(fromScaffold(REACT_VITE), spec.capabilityGraph);
  const app = name === "crud" ? CRUD_APP : name === "transaction" ? TRANSACTION_APP : INTERACTIVE_APP;
  const tree = {
    ...composed.tree,
    "src/lib/backend/index.js": BACKEND_FIXTURE,
    "src/App.jsx": app,
    "src/styles.css": `${composed.tree["src/styles.css"] || ""}\n${STYLES[name]}`,
    ...(name === "interactive" ? { "src/extensions/custom/interactive-workspace.js": CUSTOM_MODULE } : {}),
  };
  return { tree, composition: composed.plan };
}

async function serve(name, tree) {
  const rows = new Map(); let counter = 0;
  const built = await buildTree(tree, `bv2-capability-composition-${name}`, () => {});
  assert.equal(built.ok, true, built.stderr);
  const root = path.join(workDirFor(`bv2-capability-composition-${name}`), "dist");
  const server = http.createServer(async (request, response) => {
    if (request.url === "/__capability_fixture" && request.method === "POST") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || "{}"); const typeRows = [...rows.values()].filter((row) => row.type === body.type);
      let result = null;
      if (body.action === "create") { result = { id: `row-${++counter}`, type: body.type, data: body.data, created_at: new Date().toISOString() }; rows.set(result.id, result); }
      else if (body.action === "list") result = typeRows;
      else if (body.action === "get") result = rows.get(body.id) || null;
      else if (body.action === "update") { result = rows.get(body.id); result.data = body.data; }
      else if (body.action === "delete") { rows.delete(body.id); result = null; }
      else if (body.action === "count") result = typeRows.length;
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result)); return;
    }
    const requested = (request.url || "/").split("?")[0]; const file = requested === "/" ? "/index.html" : requested;
    try {
      const body = await readFile(path.join(root, file));
      response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }); response.end(body);
    } catch {
      response.writeHead(200, { "content-type": "text/html" }); response.end(await readFile(path.join(root, "index.html")));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { built, server, url: `http://127.0.0.1:${server.address().port}`, rows };
}

async function browserProof(name, page) {
  if (name === "crud") {
    await page.getByRole("textbox", { name: "Record title" }).fill("Universal record");
    await page.getByRole("button", { name: "Create record" }).click();
    await page.getByTestId("record").waitFor(); assert.match(await page.getByTestId("record").textContent(), /Universal record.*open/s);
    await page.getByRole("button", { name: "Change status" }).click(); await page.getByText("closed", { exact: true }).waitFor();
    await page.reload(); assert.match(await page.getByTestId("record").textContent(), /Universal record.*closed/s);
    await page.getByRole("button", { name: "Delete record" }).click();
    await page.getByText("Record removed", { exact: true }).waitFor();
    await page.getByTestId("record").waitFor({ state: "detached" });
    await page.reload();
    assert.equal(await page.getByTestId("record").count(), 0);
  } else if (name === "transaction") {
    await page.getByRole("button", { name: "direct" }).click(); await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("spinbutton", { name: "Amount" }).fill("125"); await page.getByRole("button", { name: "Continue" }).click();
    assert.match(await page.getByTestId("review").textContent(), /direct 125/); await page.getByRole("button", { name: "Confirm transaction" }).click();
    await page.getByText("Confirmed", { exact: true }).waitFor(); await page.reload(); await page.getByText("Confirmed", { exact: true }).waitFor();
    assert.match(await page.locator("main").textContent(), /direct.*125/s);
  } else {
    await page.getByRole("spinbutton", { name: "Width" }).fill("8"); await page.getByRole("spinbutton", { name: "Height" }).fill("5");
    await page.getByRole("button", { name: "Calculate result" }).click(); await page.getByText("Area 40").waitFor();
    const before = await page.locator(".object").getAttribute("style"); await page.getByRole("button", { name: "Move object" }).click();
    const after = await page.locator(".object").getAttribute("style"); assert.notEqual(after, before);
    await page.getByRole("button", { name: "Save project" }).click(); await page.getByText("Project saved").waitFor();
  }
}

await ensureDeps(() => {});
const browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--no-sandbox"] });
const results = [];
try {
  for (const [name, sourceContract] of Object.entries(CONTRACTS)) {
    const spec = deriveBuildSpec(sourceContract);
    assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
    const { tree, composition } = fixtureTree(name, spec);
    assert.equal(validateCapabilityComposition(tree, spec.capabilityGraph, composition).ok, true);
    const conformance = validateModuleConformance(tree, {
      contract: spec.contract, modulePlan: spec.modulePlan, moduleContracts: spec.moduleContracts,
      interactionContract: spec.interactionContract, bindings: spec.bindings, capabilityGraph: spec.capabilityGraph,
    });
    assert.equal(conformance.ok, true, conformance.problems.join("; "));
    const generated = [tree["src/App.jsx"], ...Object.entries(tree).filter(([file]) => file.startsWith("src/extensions/custom/"))
      .map(([, source]) => source)].join("\n");
    assert.equal(/\bmake(?:EntityStore|WizardMachine|BookingSystem|ContactForm|Newsletter)\s*\(/.test(generated), false,
      `${name}: fixture must consume composition instead of regenerating known capabilities`);
    const manifest = deriveVerificationManifest(spec);
    assert.equal(manifest.capabilityGraphVersion, spec.capabilityGraph.version);
    assert.ok(manifest.capabilityAssertions.some((row) => row.journeyId === sourceContract.journeys[0].id));

    if (name === "interactive") {
      const protectedBefore = Object.fromEntries(composition.protectedFiles.map((file) => [file, digest(tree[file])]));
      const broken = { ...tree, "src/extensions/custom/interactive-workspace.js": "export const broken = true;" };
      assert.equal(validateCapabilityComposition(broken, spec.capabilityGraph, composition).ok, false);
      const protectedAfter = Object.fromEntries(composition.protectedFiles.map((file) => [file, digest(tree[file])]));
      assert.deepEqual(protectedAfter, protectedBefore, "repairing one custom module must not replace capability modules");
    }

    const runtime = await serve(name, tree); const page = await browser.newPage();
    try { await page.goto(runtime.url, { waitUntil: "networkidle" }); await browserProof(name, page); }
    finally { await page.close(); await new Promise((resolve) => runtime.server.close(resolve)); }
    results.push({
      application: name, graph: true, composition: true, compile: runtime.built.ok, browser: true,
      deterministicNodes: spec.capabilityGraph.nodes.filter((node) => node.type === "deterministic_capability").map((node) => node.id),
      customBehavior: spec.capabilityGraph.customBehavior,
      visualSignature: digest(STYLES[name]).slice(0, 16),
    });
  }
} finally { await browser.close(); }

assert.equal(new Set(results.map((row) => row.visualSignature)).size, 3,
  "composition must not collapse structurally different applications into one visual template");
process.stdout.write(`${JSON.stringify({ ok: true, providerCalls: 0, customerBuilds: 0, applications: results }, null, 2)}\n`);
