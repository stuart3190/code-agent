// AUTHENTICATION ON THE CONTRACTED SURFACE — an explicit sign-up step drives the form the
// previous step opened, and only hunts for an entry link when no form is on screen.
//
// The 2026-09-16 Lumen advanced qualification (build 5f670fc9) contracted "open the workspace
// route" (a sign-in panel appears when no session exists) followed by "sign up or sign in with
// email and password". The explicit-authentication handler navigated back to the site root to
// look for a create-account link, found an empty composed Home placeholder, and reported "the
// create account entry was not offered". Six repair rounds (20 credits) were then spent on a
// journey controller that could never have answered a verdict taken on the wrong screen.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

// The site root is a composed placeholder with no authentication entry at all.
const HOME = `<!doctype html><html><body>
<nav><a href="/">Home</a> <a href="/workspace">Workspace</a></nav>
<section><h1>Home</h1><p>Application screen ready for composition.</p></section>
</body></html>`;

// The workspace route shows a sign-in panel while no session exists, and the workspace shell
// once the form is submitted. Nothing on this page links back to a separate account entry.
const WORKSPACE = `<!doctype html><html><body>
<nav><a href="/">Home</a> <a href="/workspace">Workspace</a></nav>
<section id="panel">
  <h1>Lumen Layouts</h1>
  <p>Sign in to open the workspace</p>
  <form id="auth">
    <label for="email">Email</label><input id="email" type="email" />
    <label for="password">Password</label><input id="password" type="password" />
    <button type="submit">Create account</button>
  </form>
</section>
<script>
  document.getElementById("auth").addEventListener("submit", (event) => {
    event.preventDefault();
    document.getElementById("panel").innerHTML = "<h1>Workspace</h1><p>Workspace shell ready: the plan list panel, SVG canvas, fixture library and inspector are visible.</p>";
    history.pushState({}, "", "/workspace/app");
  });
</script>
</body></html>`;

let server = null;
let baseUrl = "";

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(req.url.startsWith("/workspace") ? WORKSPACE : HOME);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/`;
});
after(async () => { await new Promise((resolve) => server?.close(resolve)); });

test("an explicit sign-up step drives the sign-in panel the contracted route already opened", needsBrowser, async () => {
  const contract = {
    routes: [{ path: "/", name: "Home" }, { path: "/workspace", name: "Workspace", auth: true }],
    auth: { required: true },
    journeys: [{
      id: "create-plan", title: "A user signs in and opens the workspace", priority: "primary",
      steps: [
        { action: "open the workspace route", target: "/workspace",
          expect: "the Lumen Layouts sign in panel with email and password fields is visible" },
        { action: "sign up or sign in with email and password", target: "authentication form",
          expect: "the workspace shell with the plan list panel and SVG canvas is visible" },
      ],
    }],
  };
  const result = await verifyJourneys({ previewUrl: baseUrl, contract, timeoutMs: 120_000 });
  assert.notEqual(result.unavailable, true, result.error);
  const journey = result.journeys.find((row) => row.id === "create-plan");
  assert.ok(journey, JSON.stringify(result.journeys));
  assert.equal(journey.steps[0].status, "pass", JSON.stringify(journey.steps[0]));
  const signUp = journey.steps[1];
  assert.notEqual(signUp.detail, "the create account entry was not offered", JSON.stringify(signUp));
  assert.equal(signUp.status, "pass", JSON.stringify(signUp));
  const authentication = signUp.authentication || signUp.controlEvidence?.authentication || null;
  assert.equal(authentication?.authenticated ?? signUp.drove, true, JSON.stringify(signUp));
  assert.match(JSON.stringify(signUp), /contracted_surface|the workspace shell/i);
});
