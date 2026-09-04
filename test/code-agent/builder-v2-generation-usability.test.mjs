// Retained reproduction of the two defects that ended the 2026-08-09 live booking qualification,
// and proof of the corrected generic paths.
//
// A. Hand-wired selection: the clicked option never gained an observable selected state, so the
//    value never propagated and review/confirmation/recovery all failed behind it.
// B. Entity read before a visitor session existed:
//    401 GET /rest/v1/entities?select=*&type=eq.booking&app_id=eq.<app>
//
// Neither is fixed by a validator. A is fixed by making the correct assembly the cheapest path;
// B is fixed inside the runtime so no generated app has to remember the prerequisite.
//
// The browser verifier stays authoritative throughout: the broken shapes below must REMAIN
// detectably broken.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createSupabaseBackend } from "../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";
import { assemblyNeeds } from "../../shell/server/lib/builderV2/interactionContract.mjs";
import { preferredAssemblyBrief } from "../../shell/server/lib/builderV2/capabilityRegistry.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

// ── B. session-safe entity access (no browser required) ───────────────────────────────────────

/**
 * A fake Supabase REST + app-auth endpoint that enforces the real rule: a protected entity
 * request without a bearer session is 401, exactly as production answered.
 */
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A structurally valid unsigned JWT — supabase-js decodes it locally to read sub/exp. */
const fakeJwt = (sub) => [
  b64url({ alg: "HS256", typ: "JWT" }),
  b64url({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 }),
  Buffer.from("test-signature").toString("base64url"),
].join(".");

function fakeBackendHost() {
  const state = { users: [], sessions: new Map(), rows: [], requests: [], unauthorised: [] };
  const json = (status, payload) => new Response(JSON.stringify(payload), {
    status, headers: { "content-type": "application/json" },
  });
  // supabase-js passes a plain object for auth/functions calls and a Headers instance for
  // PostgREST. Read both, or a genuinely authenticated request looks unauthenticated.
  const headerValue = (headers, name) => {
    if (!headers) return "";
    if (typeof headers.get === "function") return headers.get(name) || "";
    return headers[name] || headers[name.toLowerCase()] || "";
  };
  const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    const authorization = headerValue(options.headers, "Authorization");
    const token = authorization.replace(/^Bearer\s+/i, "");
    const body = options.body ? JSON.parse(options.body) : {};

    if (target.includes("/functions/v1/app-auth")) {
      if (!body.appId) return json(400, { error: "valid appId required" });
      if (body.action === "signup") {
        const id = `user-${state.users.length + 1}`;
        const access = fakeJwt(id);
        state.users.push({ id, email: body.email, password: body.password, access });
        state.sessions.set(access, id);
        return json(200, { user: { id, email: body.email }, session: { access_token: access, refresh_token: `r-${id}` } });
      }
      if (body.action === "signin") {
        const found = state.users.find((u) => u.email === body.email && u.password === body.password);
        if (!found) return json(400, { error: "invalid credentials" });
        state.sessions.set(found.access, found.id);
        return json(200, { user: { id: found.id, email: found.email }, session: { access_token: found.access, refresh_token: `r-${found.id}` } });
      }
      return json(400, { error: `unsupported ${body.action}` });
    }

    // supabase-js validates the installed session here.
    if (target.includes("/auth/v1/user")) {
      const id = state.sessions.get(token);
      if (!id) return json(401, { message: "invalid claim" });
      const user = state.users.find((u) => u.id === id);
      return json(200, { id, email: user?.email, aud: "authenticated", user_metadata: {} });
    }
    if (target.includes("/auth/v1/logout")) return json(204, {});

    // Protected REST surface: a real session token is mandatory.
    state.requests.push(target);
    if (!state.sessions.has(token)) {
      state.unauthorised.push(target);
      return json(401, { message: "JWT expired or missing" });
    }
    if (options.method === "POST") {
      const row = { id: `row-${state.rows.length + 1}`, ...JSON.parse(options.body || "{}"), created_at: new Date(0).toISOString() };
      state.rows.push(row);
      return json(201, [row]);
    }
    return json(200, state.rows);
  };
  return { state, fetchImpl };
}

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

test("REPRODUCTION B — a protected entity read with no session is 401", async () => {
  const host = fakeBackendHost();
  // Drive the raw REST surface the generated app used to reach directly.
  const response = await host.fetchImpl(
    "https://example.supabase.co/rest/v1/entities?select=*&type=eq.booking&app_id=eq.app-1",
    { headers: { Authorization: "Bearer anon-key" } },
  );
  assert.equal(response.status, 401, "an unauthenticated protected read must fail");
  assert.equal(host.state.unauthorised.length, 1);
});

test("CORRECTED B — the runtime establishes the visitor session before any protected operation", async () => {
  const host = fakeBackendHost();
  const backend = createSupabaseBackend({
    url: "https://example.supabase.co", anonKey: "anon-key", appId: "app-1",
    authUrl: "https://example.supabase.co/functions/v1/app-auth",
    fetchImpl: host.fetchImpl, visitorStorage: memoryStorage(),
  });

  // The generated app does NOT call ensureVisitorSession(). It just reads.
  const rows = await backend.db.entity("booking").list({});
  assert.ok(Array.isArray(rows));
  assert.deepEqual(host.state.unauthorised, [], "no protected request was ever sent unauthenticated");
  assert.equal(host.state.users.length, 1, "exactly one app-scoped visitor identity was created");

  // Writes are authenticated too, and reuse the same identity rather than minting another.
  await backend.db.entity("booking").create({ date: "2026-06-14" });
  await backend.db.entity("booking").get("row-1");
  assert.deepEqual(host.state.unauthorised, []);
  assert.equal(host.state.users.length, 1, "the session is established once, not per call");
});

test("CORRECTED B — concurrent first operations share one signup", async () => {
  const host = fakeBackendHost();
  const backend = createSupabaseBackend({
    url: "https://example.supabase.co", anonKey: "anon-key", appId: "app-1",
    authUrl: "https://example.supabase.co/functions/v1/app-auth",
    fetchImpl: host.fetchImpl, visitorStorage: memoryStorage(),
  });
  await Promise.all(Array.from({ length: 8 }, () => backend.db.entity("task").list({})));
  assert.equal(host.state.users.length, 1, "eight concurrent readers share one visitor identity");
  assert.deepEqual(host.state.unauthorised, []);
});

test("CORRECTED B — a signed-in user is never replaced by a visitor identity", async () => {
  const host = fakeBackendHost();
  const backend = createSupabaseBackend({
    url: "https://example.supabase.co", anonKey: "anon-key", appId: "app-1",
    authUrl: "https://example.supabase.co/functions/v1/app-auth",
    fetchImpl: host.fetchImpl, visitorStorage: memoryStorage(),
  });
  await backend.auth.signUp({ email: "real@example.com", password: "Real-pw-1" });
  const usersAfterSignUp = host.state.users.length;
  await backend.db.entity("task").list({});
  assert.equal(host.state.users.length, usersAfterSignUp, "the real account is used, not a visitor");
});

test("CORRECTED B — no privileged credential is used or exposed", async () => {
  const host = fakeBackendHost();
  const backend = createSupabaseBackend({
    url: "https://example.supabase.co", anonKey: "anon-key", appId: "app-1",
    authUrl: "https://example.supabase.co/functions/v1/app-auth",
    fetchImpl: host.fetchImpl, visitorStorage: memoryStorage(),
  });
  await backend.db.entity("booking").list({});
  const serialised = JSON.stringify(host.state);
  assert.equal(/service_role|SUPABASE_SERVICE|sb_secret/i.test(serialised), false);
  // RLS is untouched: the session is an ordinary app-scoped visitor, not an escalation.
  assert.match(host.state.users[0].email, /^visitor-.*@visitor\.local$/);
});

test("CORRECTED B — a platform-auth app is NOT auto-signed-in", async () => {
  const host = fakeBackendHost();
  // No appId/authUrl: this app owns its own sign-in. The runtime must not invent an identity.
  const backend = createSupabaseBackend({
    url: "https://example.supabase.co", anonKey: "anon-key", fetchImpl: host.fetchImpl,
  });
  await backend.db.entity("task").list({}).catch(() => {});
  assert.equal(host.state.users.length, 0, "no visitor identity is minted for a platform-auth app");
});

test("session failures stay red — the runtime never swallows an auth failure", async () => {
  const host = fakeBackendHost();
  const broken = async (url, options) => {
    if (String(url).includes("app-auth")) {
      return new Response(JSON.stringify({ error: "app-auth unavailable" }), { status: 503 });
    }
    return host.fetchImpl(url, options);
  };
  const backend = createSupabaseBackend({
    url: "https://example.supabase.co", anonKey: "anon-key", appId: "app-1",
    authUrl: "https://example.supabase.co/functions/v1/app-auth",
    fetchImpl: broken, visitorStorage: memoryStorage(),
  });
  await assert.rejects(() => backend.db.entity("booking").list({}), /app-auth unavailable|auth signup failed/);
});

// ── A. selection assembly guidance (generic, no validator) ────────────────────────────────────

const domainCase = (id, steps, entities = [{ name: "record", fields: [{ name: "value" }] }]) => ({
  summary: "generic workflow", entities,
  // Session guidance is required only when the contract explicitly owns a durable operation.
  // An entity plus UI prose alone must not invent persistence.
  operations: entities.length
    ? [{ id: "complete-record", entity: "record", kind: "create", journey: id }] : [],
  routes: [{ path: "/", name: "Main" }],
  auth: { required: false },
  journeys: [{ id, title: "Complete the workflow", priority: "primary", steps }],
});

test("GUIDANCE — the assembly brief is derived from the contract and is domain-neutral", () => {
  const domains = {
    "subscription tier": domainCase("manage-subscription", [
      { action: "select a tier", target: "tier", expect: "tier becomes active" },
      { action: "create the subscription", target: "create", expect: "reference shown" },
    ]),
    "product variant": domainCase("buy", [
      { action: "select a product variant", target: "variant", expect: "variant becomes active" },
      { action: "create the order", target: "create", expect: "order reference" },
    ]),
    "inventory option": domainCase("adjust-stock", [
      { action: "select an item", target: "sku", expect: "item becomes active" },
      { action: "create the adjustment", target: "create", expect: "adjustment reference" },
    ]),
    "project status": domainCase("track", [
      { action: "select a project status", target: "status", expect: "status becomes active" },
      { action: "create the update", target: "create", expect: "update reference" },
    ]),
    "shipping method": domainCase("ship", [
      { action: "select a shipping method", target: "method", expect: "method becomes active" },
      { action: "create the shipment", target: "create", expect: "shipment reference" },
    ]),
  };
  for (const [name, contract] of Object.entries(domains)) {
    const spec = deriveBuildSpec(contract);
    const brief = preferredAssemblyBrief(assemblyNeeds(spec.interactionContract, spec.bindings));
    assert.match(brief, /useSemanticSelection/, `${name} is shown the selection binding`);
    assert.match(brief, /aria-pressed/, `${name} is told selected state must be observable`);
    assert.match(brief, /session/i, `${name} is told the runtime owns the session prerequisite`);
    assert.equal(/booking|reservation|party size|supper/i.test(brief), false,
      `${name} brief must contain no foreign domain vocabulary`);
  }
});

test("GUIDANCE — a finishable durable flow is told how a visitor starts a new one", () => {
  // The 2026-08-10 run stalled because a cancelled wizard is restored in its terminal state and
  // refuses every later edit. The flow needs an explicit way back; nothing may reset implicitly.
  const durableFlow = {
    summary: "A multi-step booking workflow",
    entities: [{ name: "booking", fields: [{ name: "date" }] }],
    operations: [{ id: "create-booking", entity: "booking", action: "create" }],
    routes: [{ path: "/", name: "Booking" }], auth: { required: false },
    journeys: [{ id: "complete-booking", title: "Complete a booking", priority: "primary", steps: [
      { action: "select a date", target: "date", expect: "date becomes active" },
      { action: "enter guest details", target: "contact", expect: "details accepted" },
      { action: "review the selection", target: "review", expect: "review shows the date" },
      { action: "confirm the booking", target: "confirm", expect: "durable reference" },
      { action: "cancel the booking", target: "cancel", expect: "cancelled status" },
    ] }],
  };
  const spec = deriveBuildSpec(durableFlow);
  const needs = assemblyNeeds(spec.interactionContract, spec.bindings);
  assert.equal(needs.terminalReset, true, "a confirmable AND cancellable durable flow needs it");

  const brief = preferredAssemblyBrief(needs);
  assert.match(brief, /FINISHED FLOW/);
  assert.match(brief, /reset\(\)/, "the supported recovery is named");
  assert.match(brief, /Never reset implicitly on load/, "an implicit reset would discard a real outcome");
  assert.match(brief, /confirmed|cancelled/, "both terminal states are named");
  // Still domain-neutral: the concept is named, the application is not.
  assert.equal(/booking|reservation|supper|party size/i.test(brief), false, brief);

  // A flow that cannot reach a terminal state is not told about one.
  const oneShot = {
    ...durableFlow,
    journeys: [{ id: "browse-menu", title: "Browse", priority: "primary", steps: [
      { action: "open the menu", target: "menu", expect: "menu is visible" },
      { action: "navigate to contact", target: "contact", expect: "contact is visible" },
    ] }],
  };
  const oneShotSpec = deriveBuildSpec(oneShot);
  const oneShotNeeds = assemblyNeeds(oneShotSpec.interactionContract, oneShotSpec.bindings);
  assert.equal(oneShotNeeds.terminalReset, false);
  assert.equal(/FINISHED FLOW/.test(preferredAssemblyBrief(oneShotNeeds)), false);
});

test("GUIDANCE — the finished-flow pattern generalises beyond any one domain", () => {
  const wizardFlows = {
    checkout: [
      { action: "select a shipping method", target: "method", expect: "method active" },
      { action: "enter the delivery address", target: "address", expect: "accepted" },
      { action: "review the order", target: "review", expect: "review shows the method" },
      { action: "confirm the order", target: "confirm", expect: "order reference" },
    ],
    onboarding: [
      { action: "select a plan", target: "plan", expect: "plan active" },
      { action: "enter the workspace name", target: "workspace", expect: "accepted" },
      { action: "review the setup", target: "review", expect: "review shows the plan" },
      { action: "confirm the setup", target: "confirm", expect: "setup reference" },
    ],
  };
  for (const [id, steps] of Object.entries(wizardFlows)) {
    const contract = {
      summary: `A ${id} flow`, entities: [{ name: "record", fields: [{ name: "value" }] }],
      operations: [{ id: "complete-flow", entity: "record", kind: "create", journey: id }],
      routes: [{ path: "/", name: id }], auth: { required: false },
      journeys: [{ id, title: id, priority: "primary", steps }],
    };
    const spec = deriveBuildSpec(contract);
    const needs = assemblyNeeds(spec.interactionContract, spec.bindings);
    assert.equal(needs.terminalReset, true, `${id} reaches a terminal state`);
    assert.match(preferredAssemblyBrief(needs), /FINISHED FLOW/, `${id} is told how to start a new one`);
  }
});

test("GUIDANCE — nothing is added when the contract does not need it", () => {
  const landing = domainCase("browse", [
    { action: "open the page", target: "home", expect: "hero is visible" },
    { action: "navigate to services", target: "services", expect: "services are visible" },
  ], []);
  const spec = deriveBuildSpec(landing);
  const needs = assemblyNeeds(spec.interactionContract, spec.bindings);
  // …including the forward control: a page with nothing to fill in has nowhere to advance to.
  assert.deepEqual(needs, { selection: false, field: false, entities: false, capabilityState: false,
    terminalReset: false, status: false, flowAdvance: false });
  assert.equal(preferredAssemblyBrief(needs), "", "a landing page pays no prompt cost");
});

test("GUIDANCE — the brief reaches the real generation prompt and stays short", () => {
  const contract = domainCase("manage-subscription", [
    { action: "select a tier", target: "tier", expect: "tier becomes active" },
    { action: "enter the customer email", target: "customerEmail", expect: "email accepted" },
    { action: "create the subscription", target: "create", expect: "reference shown" },
  ]);
  const spec = deriveBuildSpec(contract);
  const prompt = renderPatchPrompt({
    step: "core", contract: spec.contract, tiers: spec.tiers, tree: {},
    modulePlan: spec.modulePlan, moduleContracts: spec.moduleContracts,
  });
  assert.match(prompt, /PREFERRED ASSEMBLY/);
  assert.match(prompt, /useSemanticSelection/);
  assert.match(prompt, /useSemanticField/);
  const section = prompt.slice(prompt.indexOf("PREFERRED ASSEMBLY")).split("\n\n")[0];
  // A bloat guard, not an architectural limit. It moved from 24 to 25 when 1fd3bcd added the
  // line forbidding an explicit ensureVisitorSession() call and db.entity() on a
  // capability-owned type - an earned instruction that stops a specific generation defect.
  // Every line is a named pattern or its one-line caveat; raise this only for the same.
  assert.ok(section.split("\n").length <= 25, `the brief must stay small: ${section.split("\n").length} lines`);
});

// ── A. real browser: broken hand-wiring stays red, the binding propagates ─────────────────────

const CASE = "builder-v2-generation-usability";

// The exact defect shape: a hand-rolled option that updates nothing observable.
const HANDROLLED = `export function HandRolled() {
  let chosen = null;                                  // not React state — nothing re-renders
  return <div>
    {[2, 4, 6].map((size) => (
      <button key={size} id={"hand-" + size} onClick={() => { chosen = size; }}>{size} guests</button>
    ))}
    <p id="hand-review">{chosen ? "Party of " + chosen : "no selection"}</p>
  </div>;
}`;

const ASSEMBLED = `import { useState } from "react";
import { useSemanticSelection } from "../lib/capabilities";
export function Assembled() {
  const [value, setValue] = useState(null);
  const choice = useSemanticSelection({ name: "partySize", value, onSelect: setValue });
  return <div>
    <div {...choice.groupProps}>
      {[2, 4, 6].map((size) => (
        <button key={size} {...choice.optionProps(size, size + " guests assembled")}>{size} guests assembled</button>
      ))}
    </div>
    <p id="assembled-review">{value ? "Party of " + value : "no selection"}</p>
  </div>;
}`;

let server = null;
let baseUrl = "";
let built = null;

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  built = await buildTree({
    ...fromScaffold(REACT_VITE),
    "src/components/HandRolled.jsx": HANDROLLED,
    "src/components/Assembled.jsx": ASSEMBLED,
    "src/App.jsx": `import { HandRolled } from "./components/HandRolled.jsx";
import { Assembled } from "./components/Assembled.jsx";
export default function App() { return <main><HandRolled /><Assembled /></main>; }`,
  }, CASE, () => {});
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

test("both selection shapes compile", { ...needsBrowser }, () => {
  assert.equal(built.ok, true, built?.stderr);
});

test("REPRODUCTION A — the hand-wired option stays broken and stays detectable", { ...needsBrowser }, async () => {
  const { chromium } = requireCjs("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    const option = page.locator("#hand-4");
    const before = await option.evaluate((el) => ({
      aria: el.getAttribute("aria-pressed"), data: el.getAttribute("data-selected"), cls: el.className,
    }));
    await option.click();
    const after = await option.evaluate((el) => ({
      aria: el.getAttribute("aria-pressed"), data: el.getAttribute("data-selected"), cls: el.className,
    }));
    // The exact live symptom: aria/data/class all unchanged after the click.
    assert.deepEqual(after, before, "the hand-wired option gains no observable selected state");
    assert.equal(after.aria, null);
    // ...and the value does not propagate downstream.
    assert.equal((await page.locator("#hand-review").textContent()).trim(), "no selection");
  } finally { await browser.close(); }
});

test("CORRECTED A — the binding exposes selected state and propagates the value", { ...needsBrowser }, async () => {
  const { chromium } = requireCjs("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: "networkidle" });

    const option = page.getByRole("button", { name: "4 guests assembled" });
    assert.equal(await option.getAttribute("aria-pressed"), "false", "unchosen first");
    await option.click();
    await page.waitForFunction(
      () => document.querySelector('[aria-label="4 guests assembled"]')?.getAttribute("aria-pressed") === "true",
      null, { timeout: 5_000 },
    );
    // Downstream receives the exact value — the step that cascaded in the live run.
    assert.equal((await page.locator("#assembled-review").textContent()).trim(), "Party of 4");

    // Selecting another option moves the state: one source of truth.
    await page.getByRole("button", { name: "6 guests assembled" }).click();
    await page.waitForFunction(() => (
      document.querySelector('[aria-label="4 guests assembled"]')?.getAttribute("aria-pressed") === "false"
      && document.querySelector('[aria-label="6 guests assembled"]')?.getAttribute("aria-pressed") === "true"
    ), null, { timeout: 5_000 });
    assert.equal((await page.locator("#assembled-review").textContent()).trim(), "Party of 6");
  } finally { await browser.close(); }
});
