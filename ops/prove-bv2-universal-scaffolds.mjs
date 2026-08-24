// Zero-model end-to-end proof for Builder V2 universal scaffold composition.
// Contract -> capability graph -> scaffold graph -> deterministic composition -> bounded custom
// extension -> static gates -> Vite compile -> Chromium interactions. No provider/control plane.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { deriveBuildSpec } from "../shell/server/lib/builderV2/buildSpec.mjs";
import { composeCapabilityFoundation } from "../shell/server/lib/builderV2/capabilityComposer.mjs";
import { composeScaffoldFoundation } from "../shell/server/lib/builderV2/scaffoldComposer.mjs";
import { runStaticApplicationGate } from "../shell/server/lib/builderV2/staticApplicationGate.mjs";
import { deriveVerificationManifest } from "../shell/server/lib/builderV2/verificationManifest.mjs";
import { SCAFFOLDS } from "../shell/server/lib/builderV2/scaffoldRegistry.mjs";
import { fromScaffold } from "../src/engine/fileTree.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../harness/workspace.mjs";

const requireCjs = createRequire(import.meta.url);
const { chromium } = requireCjs("playwright");
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const profile = (signals = [], subtype = "general_application") => ({ version: 1,
  requestedBuildType: "application", resolvedBuildType: "application", applicationSubtype: subtype,
  requirementSignals: signals, inferenceSource: "explicit", confidence: 1 });
const contract = (value) => ({ auth: { required: false }, deferred: [], imageIntents: [], integrations: [], ...value });

const CONTRACTS = {
  content: contract({
    summary: "responsive content catalogue with browse and detail",
    entities: [{ name: "article", fields: [{ name: "title", type: "string" }] }],
    operations: [{ id: "list-articles", entity: "article", kind: "list", journey: "browse" },
      { id: "view-article", entity: "article", kind: "get", journey: "detail" }],
    journeys: [{ id: "browse", title: "Browse content", priority: "primary", steps: [
      { action: "view the catalogue", target: "/", operates: ["list-articles"], expect: "articles are visible" },
      { action: "filter the catalogue", target: "search", primitive: "textbox", expect: "matching articles remain" },
    ] }, { id: "detail", title: "Read detail", priority: "primary", steps: [
      { action: "open an article", target: "/detail", operates: ["view-article"], expect: "article detail is visible" },
    ] }], routes: [{ path: "/", name: "Catalogue" }, { path: "/detail", name: "Detail" }],
  }),
  business: contract({
    summary: "authenticated internal dashboard for durable records and workflow", auth: { required: true },
    buildProfile: profile(["user_accounts", "admin"], "internal_tool"),
    entities: [{ name: "workItem", fields: [{ name: "title", type: "string" }, { name: "status", type: "string" }] }],
    operations: [{ id: "create-work", entity: "workItem", kind: "create", journey: "manage" },
      { id: "update-work", entity: "workItem", kind: "update", journey: "manage" }],
    journeys: [{ id: "manage", title: "Manage work workflow", priority: "primary", steps: [
      { action: "enter a title", target: "/dashboard", operates: ["title"], primitive: "textbox", expect: "the title is visible" },
      { action: "create the work item", target: "save", operates: ["create-work"], expect: "the item is saved" },
      { action: "change its status", target: "status", operates: ["status", "update-work"], primitive: "selection", expect: "the new status is visible" },
      { action: "reload the dashboard", target: "/dashboard", expect: "the item is restored" },
    ] }, { id: "administer", title: "Administer work access", priority: "primary", steps: [
      { action: "open admin management", target: "/admin", expect: "authorized management is visible" },
      { action: "approve a management action", target: "approve", expect: "management action is complete" },
    ] }], routes: [{ path: "/dashboard", name: "Dashboard" }, { path: "/account", name: "Account" },
      { path: "/admin", name: "Admin" }],
  }),
  transaction: contract({
    summary: "durable multi-step scheduling transaction with availability, review and confirmation",
    entities: [{ name: "booking", fields: [{ name: "slotId", type: "string" },
      { name: "partySize", type: "number" }, { name: "guestName", type: "string" },
      { name: "guestEmail", type: "string" }] }],
    operations: [{ id: "create-booking", entity: "booking", kind: "create", journey: "complete" }],
    journeys: [{ id: "complete", title: "Complete scheduled transaction", priority: "primary", steps: [
      { action: "select an available slot", target: "slot", operates: ["slotId"], primitive: "selection", expect: "the slot is selected" },
      { action: "continue to guest details", target: "continue", expect: "the details step opens" },
      { action: "enter guest details and party size", target: "details", operates: ["guestName", "guestEmail", "partySize"], primitive: "textbox", expect: "the details are visible" },
      { action: "review the booking", target: "review", expect: "the selected values are shown" },
      { action: "confirm the booking", target: "confirm", operates: ["create-booking"], expect: "the booking is confirmed" },
      { action: "reload the confirmation", target: "/", expect: "the booking is restored" },
    ] }], routes: [{ path: "/", name: "Schedule" }],
  }),
  interactive: contract({
    summary: "interactive project workspace canvas calculation save reopen and export",
    buildProfile: profile(["custom_logic", "interactive_workspace", "export"]),
    entities: [{ name: "project", fields: [{ name: "width", type: "number" }, { name: "height", type: "number" },
      { name: "result", type: "number" }, { name: "position", type: "object" }] }],
    operations: [
      { id: "calculate", entity: "project", kind: "calculate", journey: "workspace",
        responsibilities: [{ type: "functional", behavior: "calculate result", reads: ["width", "height"], writes: ["result"] }] },
      { id: "move", entity: "project", kind: "transform", journey: "workspace",
        responsibilities: [{ type: "functional", behavior: "move object", reads: ["position"], writes: ["position"] }] },
      { id: "save", entity: "project", kind: "create", journey: "workspace" },
    ],
    journeys: [{ id: "workspace", title: "Project workspace", priority: "primary", steps: [
      { action: "enter dimensions", target: "/workspace", operates: ["width", "height"], primitive: "textbox", expect: "dimensions are visible" },
      { action: "calculate the result", target: "calculate", operates: ["calculate"], expect: "the result is visible" },
      { action: "move the object", target: "canvas", operates: ["move"], expect: "the position changes" },
      { action: "save the project", target: "save", operates: ["save"], expect: "the project is saved" },
      { action: "reopen the project", target: "/workspace", expect: "the project is restored" },
      { action: "export the result", target: "export", expect: "the output is available" },
    ] }], routes: [{ path: "/projects", name: "Projects" }, { path: "/workspace", name: "Workspace" }],
  }),
};

const BACKEND = `const call = async (action, type, payload = {}) => { const response = await fetch("/__fixture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, type, ...payload }) }); if (!response.ok) throw new Error(await response.text()); return response.json(); };
export const db = { entity(type) { return { list: (options = {}) => call("list", type, { options }), get: (id) => call("get", type, { id }), create: (data) => call("create", type, { data }), update: (id, data) => call("update", type, { id, data }), delete: (id) => call("delete", type, { id }), count: () => call("count", type), subscribe: () => () => {} }; } };
export const auth = { currentUser: async () => ({ id: "proof-user" }), signOut: async () => {}, signIn: async () => ({ id: "proof-user" }), signUp: async () => ({ id: "proof-user" }) }; export const storage = {};`;

const CONTENT_SCREENS = {
  "/": `import { useCatalogueState } from "../../lib/scaffolds/composed/primitives.jsx"; const ARTICLES=["Systems thinking","Composable software","Verified delivery"]; export default function CatalogueScreen(){ const catalogue=useCatalogueState(ARTICLES); return <section className="catalogue"><p>FIELD NOTES / 01</p><h1>Ideas worth opening</h1><label>Search articles<input aria-label="Search articles" value={catalogue.query} onChange={(event)=>catalogue.setQuery(event.target.value)}/></label><ul>{catalogue.visibleItems.map((row)=><li key={row}>{row}</li>)}</ul></section>; }`,
  "/detail": `export default function DetailScreen(){ return <article className="detail"><p>FIELD NOTES / DETAIL</p><h1>Composable software</h1><p>Article detail is visible through a mounted route.</p></article>; }`,
};
const BUSINESS_SCREEN = `import { useEffect, useState } from "react"; import { entityStore, currentUser } from "../../lib/capabilities/composed/index.js"; import { useResourceState } from "../../lib/scaffolds/composed/primitives.jsx"; const work=entityStore("workItem"); export default function DashboardScreen(){ const [title,setTitle]=useState(""); const [user,setUser]=useState(null); const resource=useResourceState(work); useEffect(()=>{ currentUser().then(setUser); },[]); const row=resource.selected||resource.rows[0]||null; const create=()=>resource.create({title,status:"open"}); const close=()=>resource.update(row.id,{status:"closed"}); return <section className="dashboard"><p>Signed in {user?.id||"loading"}</p><h1>Operations dashboard</h1><label>Work title<input aria-label="Work title" value={title} onChange={(event)=>setTitle(event.target.value)}/></label><button onClick={create}>Save work item</button>{row&&<article data-testid="work-row"><b>{row.title}</b><span>{row.status}</span><button onClick={close}>Close work item</button></article>}</section>; }`;
const ADMIN_SCREEN = `import { useState } from "react"; import { isOwner } from "../../lib/capabilities/composed/index.js"; export default function AdminScreen(){ const [done,setDone]=useState(false); const allowed=isOwner({owner:"proof-user"},{id:"proof-user"}); return <section><h1>Authorized management</h1><button disabled={!allowed} onClick={()=>setDone(true)}>Approve access</button>{done&&<p>Management action complete</p>}</section>; }`;
const TRANSACTION_SCREEN = `import { useEffect } from "react"; import { bookingCapability } from "../../lib/capabilities/composed/index.js"; import { useWorkflowState } from "../../lib/scaffolds/composed/primitives.jsx"; const STEPS=["slot","details","review","confirmed"]; export default function ScheduleScreen(){ const workflow=useWorkflowState({steps:STEPS,initialValues:{slotId:"",partySize:"",guestName:"",guestEmail:"",date:"2026-10-01"}}); useEffect(()=>{ bookingCapability.listBookings().then((rows)=>{if(rows[0]&&!workflow.result)workflow.confirm({result:"ok",booking:rows[0]});}); },[workflow]); const confirm=async()=>workflow.confirm(await bookingCapability.createBooking({date:workflow.values.date,slotId:workflow.values.slotId,partySize:Number(workflow.values.partySize),name:workflow.values.guestName,email:workflow.values.guestEmail})); if(workflow.stepIndex===3)return <section className="receipt"><h1>Booking confirmed</h1><p>{workflow.result?.booking?.reference}</p></section>; return <section className="transaction"><h1>Schedule a transaction</h1>{workflow.stepIndex===0&&<button aria-pressed={workflow.values.slotId==="slot-a"} onClick={()=>workflow.setField("slotId","slot-a")}>Morning slot</button>}{workflow.stepIndex===1&&<div><label>Guest name<input aria-label="Guest name" value={workflow.values.guestName} onChange={(event)=>workflow.setField("guestName",event.target.value)}/></label><label>Guest email<input aria-label="Guest email" value={workflow.values.guestEmail} onChange={(event)=>workflow.setField("guestEmail",event.target.value)}/></label><label>Party size<input aria-label="Party size" type="number" value={workflow.values.partySize} onChange={(event)=>workflow.setField("partySize",event.target.value)}/></label></div>}{workflow.stepIndex===2&&<div data-testid="review">Review {workflow.values.slotId} {workflow.values.guestName} {workflow.values.partySize}<button onClick={confirm}>Confirm booking</button></div>}{workflow.stepIndex<2&&<button onClick={workflow.next}>Continue</button>}</section>; }`;
const CUSTOM = `export function runWorkspaceCustomBehavior(input){ const width=Number(input.width)||0; const height=Number(input.height)||0; return { result: width*height, position: { x:Number(input.x||0)+20, y:Number(input.y||0)+12 } }; }`;
const INTERACTIVE_SCREEN = `import { useEffect, useState } from "react"; import { entityStore } from "../../lib/capabilities/composed/index.js"; import { useCanvasState, useProjectWorkspace } from "../../lib/scaffolds/composed/primitives.jsx"; import { runWorkspaceCustomBehavior } from "../../extensions/custom/workspace.js"; const projects=entityStore("project"); const INITIAL={width:"",height:"",x:0,y:0}; export default function WorkspaceScreen(){ const workspace=useProjectWorkspace(projects,INITIAL); const canvas=useCanvasState([{id:"object",x:0,y:0}]); const [output,setOutput]=useState(null); const [status,setStatus]=useState("Unsaved"); useEffect(()=>{if(workspace.rows[0]&&!workspace.activeProject){workspace.open(workspace.rows[0]);setOutput(workspace.rows[0].output);setStatus("Project restored");}},[workspace]); const calculate=()=>setOutput(runWorkspaceCustomBehavior(workspace.draft)); const move=()=>{const next=runWorkspaceCustomBehavior({...workspace.draft,...(output?.position||{})});setOutput(next);canvas.updateObject("object",next.position);}; const save=async()=>{await workspace.save({output});setStatus("Project saved");}; const object=canvas.objects[0]; return <section className="studio"><aside><h1>Spatial workspace</h1><label>Width<input aria-label="Width" type="number" value={workspace.draft.width} onChange={(event)=>workspace.setDraft({...workspace.draft,width:event.target.value})}/></label><label>Height<input aria-label="Height" type="number" value={workspace.draft.height} onChange={(event)=>workspace.setDraft({...workspace.draft,height:event.target.value})}/></label><button onClick={calculate}>Calculate</button><button onClick={save}>Save project</button><p>{status}</p></aside><div className="canvas"><div data-testid="object" style={{transform:"translate("+(object?.x||0)+"px,"+(object?.y||0)+"px)"}}/><output>{output?"Result "+output.result:"Awaiting calculation"}</output><button onClick={move}>Move object</button><button onClick={()=>setStatus("Output available")}>Export result</button></div></section>; }`;
const STYLES = {
  content: `.catalogue,.detail{max-width:760px;margin:8vh auto;font:18px Georgia;color:#17232d}.catalogue h1,.detail h1{font-size:64px}.catalogue label{display:grid;gap:8px}.catalogue li{padding:20px;border-top:1px solid}`,
  business: `.dashboard{max-width:900px;margin:5vh auto;font-family:system-ui;background:#eef3ff;padding:48px;display:grid;gap:20px}.dashboard article{display:flex;gap:24px;background:white;padding:24px}`,
  transaction: `.transaction,.receipt{max-width:640px;margin:10vh auto;padding:64px;background:#142838;color:#fff;font-family:system-ui}.transaction button,.transaction input{margin:16px;padding:14px}`,
  interactive: `.studio{min-height:100vh;display:grid;grid-template-columns:360px 1fr;background:#090b10;color:#d8ff44;font-family:Arial}.studio aside{padding:32px;display:grid;gap:12px}.canvas{position:relative;margin:32px;border:1px solid #70802c}.canvas [data-testid=object]{position:absolute;width:100px;height:80px;background:#d8ff44;left:100px;top:100px}`,
};

function fixture(name, spec) {
  let tree = composeCapabilityFoundation(fromScaffold(REACT_VITE), spec.capabilityGraph).tree;
  tree = composeScaffoldFoundation(tree, spec.scaffoldGraph).tree;
  tree["src/lib/backend/index.js"] = BACKEND;
  for (const screen of spec.scaffoldGraph.screens) {
    if (name === "content") tree[screen.module] = CONTENT_SCREENS[screen.routePath];
    else if (name === "business") tree[screen.module] = screen.routePath === "/dashboard"
      ? BUSINESS_SCREEN : screen.routePath === "/admin" ? ADMIN_SCREEN
        : "export default function AccountScreen(){return <section><h1>Account</h1><p>Session ready</p></section>;}";
    else if (name === "transaction") tree[screen.module] = TRANSACTION_SCREEN;
    else tree[screen.module] = screen.routePath === "/workspace" ? INTERACTIVE_SCREEN
      : "export default function ProjectsScreen(){return <section><h1>Projects</h1><p>Open a workspace.</p></section>;}";
  }
  if (name === "transaction") tree["src/extensions/capabilityConfiguration.js"]
    = 'export const capabilityConfiguration = Object.freeze({ booking: Object.freeze({ slots: Object.freeze([{ id: "slot-a", capacity: 4 }]) }), wizard: Object.freeze({}) });';
  if (name === "interactive") tree["src/extensions/custom/workspace.js"] = CUSTOM;
  tree["src/index.css"] = `${tree["src/index.css"]}\n${STYLES[name]}`;
  return tree;
}

async function serve(name, cycle, tree) {
  const rows = new Map(); let counter = 0;
  const workspace = `bv2-universal-scaffold-${name}-${cycle}`;
  const built = await buildTree(tree, workspace, () => {});
  assert.equal(built.ok, true, built.stderr);
  const root = path.join(workDirFor(workspace), "dist");
  const server = http.createServer(async (request, response) => {
    if (request.url === "/__fixture" && request.method === "POST") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw || "{}"); const typeRows = [...rows.values()].filter((row) => row.type === body.type);
      let result = null;
      if (body.action === "create") { result = { id: `row-${++counter}`, type: body.type, data: { ...body.data } }; rows.set(result.id, result); }
      else if (body.action === "list") result = typeRows;
      else if (body.action === "get") result = rows.get(body.id) || null;
      else if (body.action === "update") { const current = rows.get(body.id); result = { ...current, data: { ...(current?.data || {}), ...body.data } }; rows.set(body.id, result); }
      else if (body.action === "delete") { rows.delete(body.id); result = null; }
      else if (body.action === "count") result = typeRows.length;
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(result)); return;
    }
    const target = (request.url || "/").split("?")[0]; const file = target === "/" ? "/index.html" : target;
    try { const body = await readFile(path.join(root, file)); response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }); response.end(body); }
    catch { response.writeHead(200, { "content-type": "text/html" }); response.end(await readFile(path.join(root, "index.html"))); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { built, server, url: `http://127.0.0.1:${server.address().port}` };
}

async function verify(name, page) {
  if (name === "content") {
    await page.getByRole("textbox", { name: "Search articles" }).fill("Composable");
    assert.equal(await page.locator("li").count(), 1);
    await page.getByRole("link", { name: "Detail" }).click(); await page.getByText("Article detail is visible").waitFor();
  } else if (name === "business") {
    await page.getByRole("textbox", { name: "Work title" }).fill("Verified record");
    await page.getByRole("button", { name: "Save work item" }).click(); await page.getByTestId("work-row").waitFor();
    await page.getByRole("button", { name: "Close work item" }).click(); await page.getByText("closed", { exact: true }).waitFor();
    await page.reload(); assert.match(await page.getByTestId("work-row").textContent(), /Verified record.*closed/s);
    await page.getByRole("link", { name: "Admin" }).click(); await page.getByText("Authorized management").waitFor();
    await page.getByRole("button", { name: "Approve access" }).click(); await page.getByText("Management action complete").waitFor();
  } else if (name === "transaction") {
    await page.getByRole("button", { name: "Morning slot" }).click(); await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("textbox", { name: "Guest name" }).fill("Proof Guest");
    await page.getByRole("textbox", { name: "Guest email" }).fill("proof@example.test");
    await page.getByRole("spinbutton", { name: "Party size" }).fill("2"); await page.getByRole("button", { name: "Continue" }).click();
    assert.match(await page.getByTestId("review").textContent(), /slot-a Proof Guest 2/); await page.getByRole("button", { name: "Confirm booking" }).click();
    await page.getByText("Booking confirmed").waitFor(); await page.reload(); await page.getByText("Booking confirmed").waitFor();
  } else {
    await page.getByRole("link", { name: "Workspace" }).click();
    await page.getByRole("spinbutton", { name: "Width" }).fill("8"); await page.getByRole("spinbutton", { name: "Height" }).fill("5");
    await page.getByRole("button", { name: "Calculate" }).click(); await page.getByText("Result 40").waitFor();
    const before = await page.getByTestId("object").getAttribute("style"); await page.getByRole("button", { name: "Move object" }).click();
    assert.notEqual(await page.getByTestId("object").getAttribute("style"), before);
    await page.getByRole("button", { name: "Save project" }).click(); await page.getByText("Project saved").waitFor();
    await page.reload(); await page.getByText("Project restored").waitFor();
    await page.getByRole("button", { name: "Export result" }).click(); await page.getByText("Output available").waitFor();
  }
}

await ensureDeps(() => {});
const browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--no-sandbox"] });
const results = [];
try {
  for (const [name, source] of Object.entries(CONTRACTS)) {
    const spec = deriveBuildSpec(source); assert.equal(spec.verdict.ok, true, spec.verdict.problems.join("; "));
    const tree = fixture(name, spec);
    const gate = runStaticApplicationGate(tree, { contract: spec.contract, modulePlan: spec.modulePlan,
      journeys: spec.journeys });
    assert.equal(gate.ok, true, gate.blocking.map((finding) => finding.message).join("; "));
    const manifest = deriveVerificationManifest(spec);
    assert.equal(manifest.scaffoldAssertions.length, source.journeys.length);
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      const runtime = await serve(name, cycle, tree); const page = await browser.newPage();
      try { await page.goto(runtime.url, { waitUntil: "networkidle" }); await verify(name, page); }
      finally { await page.close(); await new Promise((resolve) => runtime.server.close(resolve)); }
    }
    results.push({ application: name, families: spec.scaffoldGraph.families.map((node) => node.scaffoldId),
      routes: spec.scaffoldGraph.routes.map((route) => route.routePath),
      customExtensions: spec.scaffoldGraph.extensions.map((extension) => extension.extensionId),
      staticGate: true, compileCycles: 2, browserCycles: 2, visualSignature: digest(STYLES[name]).slice(0, 16) });
  }
} finally { await browser.close(); }
assert.equal(new Set(results.map((row) => row.visualSignature)).size, 4);
assert.deepEqual([...new Set(results.flatMap((row) => row.families))].sort(), Object.keys(SCAFFOLDS).sort(),
  "the repeated browser proof must exercise every scaffold family marked proven");
process.stdout.write(`${JSON.stringify({ ok: true, providerCalls: 0, customerBuilds: 0,
  repeatedCyclesPerApplication: 2, applications: results }, null, 2)}\n`);
