import { test, before, after } from "node:test";
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
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const APP = `import { useState } from "react";
export default function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [prompt, setPrompt] = useState("");
  const [created, setCreated] = useState(false);
  const [authMode, setAuthMode] = useState("signin");
  const go = (next) => { window.history.pushState({}, "", next); setPath(next); };
  const completeAuth = (next) => { window.history.pushState({}, "", next); setTimeout(() => setPath(next), 250); };
  if (path === "/auth") return <main><h1>Authentication</h1>
    <button type="button" onClick={() => setAuthMode("signin")}>Use existing account</button>
    <button type="button" onClick={() => setAuthMode("create")}>Use new account</button>
    <form onSubmit={(event) => { event.preventDefault(); completeAuth("/app"); }}>
      <label>Email<input type="email" /></label><label>Password<input type="password" /></label>
      <button type="submit">{authMode === "create" ? "Create account" : "Sign in"}</button>
    </form></main>;
  if (path === "/app") return <main><h1>Editor workspace</h1><p>signed-in account menu</p>
    <label>original Prompt<input value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
    <button aria-label="prompt box labelled Describe the Roblox asset you want to create"
      onClick={() => setCreated(true)}>Generate</button>
    {created ? <p>generation progress complete: named generated asset appears in the centre 3D workspace</p> : null}
  </main>;
  return <main><h1>Roblox Studio AI landing screen</h1>
    <a href="/auth" aria-label="account form" onClick={(event) => { event.preventDefault(); go("/auth"); }}>Create account</a>
    <a href="/auth">Sign in</a></main>;
}`;

const CONTRACT = deriveBuildSpec({
  version: 1, summary: "Authenticated generator", projectType: "web app",
  auth: { required: true }, routes: [{ path: "/", name: "Home" }, { path: "/auth", name: "Auth" }, { path: "/app", name: "Editor" }],
  entities: [{ name: "generation", fields: [{ name: "originalPrompt", type: "string" }] }],
  operations: [{ id: "create-generation", entity: "generation", kind: "create" }],
  journeys: [{ id: "auth-generate", title: "Create account and generate", priority: "primary", steps: [
    { action: "open the app while signed out", target: "/", expect: "the Roblox Studio AI landing screen is visible with Sign in and Create account controls" },
    { action: "create an account or sign in with the authentication form", target: "account form", expect: "the editor workspace opens and the signed-in user's email is visible in the account menu" },
    { action: "type a supported asset request and submit it", target: "prompt box labelled Describe the Roblox asset you want to create", operates: ["originalPrompt"], primitive: "textbox", expect: "generation progress is shown and then a named generated asset appears in the centre 3D workspace" },
  ] }], acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
}).contract;

let server; let result; let built;
before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  built = await buildTree({ ...fromScaffold(REACT_VITE), "src/App.jsx": APP }, "bv2-auth-flow", () => {});
  if (!built.ok) return;
  const root = path.join(workDirFor("bv2-auth-flow"), "dist");
  server = http.createServer(async (request, response) => {
    const requested = (request.url || "/").split("?")[0];
    const file = requested === "/" ? "/index.html" : requested;
    try {
      const body = await readFile(path.join(root, file));
      response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html" }); response.end(body);
    } catch { response.writeHead(200, { "content-type": "text/html" }); response.end(await readFile(path.join(root, "index.html"))); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  result = await verifyJourneys({ previewUrl: `http://127.0.0.1:${server.address().port}`, contract: CONTRACT, timeoutMs: 120_000 });
}, { timeout: 600_000 });

after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

test("contracted auth entry fills and submits the real visible account form", { ...needsBrowser, timeout: 180_000 }, () => {
  assert.equal(built.ok, true, built.stderr);
  const steps = result.journeys[0].steps;
  assert.equal(steps[1].status, "pass", JSON.stringify(steps, null, 2));
  assert.equal(steps[1].controlEvidence.authentication.submitted, true);
  assert.equal(steps[1].controlEvidence.authentication.urlChanged, true);
  assert.equal(steps[2].status, "pass", JSON.stringify(steps, null, 2));
});
