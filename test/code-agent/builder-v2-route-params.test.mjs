// PARAMETERISED ROUTES IN THE COMPOSED SCAFFOLD, PROVEN IN A BROWSER.
//
// Medium qualification 1 on dd7970e (2026-09-07) was blocked for its whole correction allowance:
// the contract mounted /projects/:projectId, the composed router matched it, but no primitive let a
// screen READ the parameter or navigate, and nothing said react-router-dom was unavailable — so the
// model imported Link/useParams/useNavigate from a package the scaffold does not ship. This drives
// the real composed scaffold: a screen reads its param through useRouteParams(), links to a sibling
// record through RouteLink without a page load, and the react-router names bind to the same
// primitives.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  renderScaffoldFoundation, scaffoldCompositionBrief, SCAFFOLD_APP_PATH, SCAFFOLD_PRIMITIVES_PATH,
} from "../../shell/server/lib/builderV2/scaffoldComposer.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const CASE = "bv2-route-params";
const GRAPH = {
  version: 1, registryVersion: 1, families: [], extensions: [],
  screens: [
    { routePath: "/", routeName: "Items", screenId: "items", module: "src/screens/scaffold/ItemsScreen.jsx" },
    { routePath: "/items/:itemId", routeName: "Item", screenId: "item", module: "src/screens/scaffold/ItemScreen.jsx" },
  ],
  routes: [
    { routePath: "/", screenId: "items", module: "src/screens/scaffold/ItemsScreen.jsx", journeyIds: ["browse"] },
    { routePath: "/items/:itemId", screenId: "item", module: "src/screens/scaffold/ItemScreen.jsx", journeyIds: ["open"] },
  ],
  journeyRouteOwnership: [],
};

// Written the way a model writes a screen: react-router names, resolved by the composed primitives.
const SCREENS = {
  "src/screens/scaffold/ItemsScreen.jsx": `import { Link } from "../../lib/scaffolds/composed/primitives.jsx";
export default function ItemsScreen() {
  return <section data-scaffold-slot="items"><h1>Items</h1>
    <Link to="/items/alpha%20one" data-testid="open-alpha">Open alpha</Link>
  </section>;
}`,
  "src/screens/scaffold/ItemScreen.jsx": `import { useParams, useNavigate, useRoute } from "../../lib/scaffolds/composed/primitives.jsx";
export default function ItemScreen() {
  const { itemId } = useParams();
  const navigate = useNavigate();
  const route = useRoute();
  return <section data-scaffold-slot="item">
    <h1 data-testid="title">Item {itemId}</h1>
    <p data-testid="pattern">{route.pattern}</p>
    <button type="button" data-testid="go-beta" onClick={() => navigate("/items/beta")}>Go to beta</button>
    <button type="button" data-testid="go-home" onClick={() => navigate("/", { replace: true })}>Home</button>
  </section>;
}`,
};

const servers = [];
async function serve() {
  const root = path.join(workDirFor(CASE), "dist");
  const server = http.createServer(async (request, response) => {
    const requested = (request.url || "/").split("?")[0];
    const asset = /\.(js|css|svg|png|ico|map)$/.test(requested);
    try {
      const body = await readFile(path.join(root, asset ? requested : "/index.html"));
      response.writeHead(200, { "content-type": requested.endsWith(".js") ? "text/javascript"
        : requested.endsWith(".css") ? "text/css" : "text/html" });
      response.end(body);
    } catch { response.writeHead(404); response.end("not found"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

let built = null;
let baseUrl = "";
before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  const foundation = renderScaffoldFoundation(GRAPH);
  built = await buildTree({ ...fromScaffold(REACT_VITE), ...foundation.protectedFiles, ...foundation.screenFiles, ...SCREENS }, CASE, () => {});
  if (built.ok) baseUrl = await serve();
}, { timeout: 900_000 });
after(async () => { for (const server of servers) await new Promise((resolve) => server.close(resolve)); });

test("the brief tells the model react-router-dom is unavailable and names the primitives instead", () => {
  const brief = scaffoldCompositionBrief(GRAPH);
  assert.match(brief, /react-router-dom is NOT installed/);
  assert.match(brief, /useRouteParams\(\)/);
  assert.match(brief, /useNavigate\(\)/);
  assert.match(brief, /RouteLink/);
});

test("the composed primitives export the routing API under both their own and the react-router names", () => {
  const primitives = renderScaffoldFoundation(GRAPH).protectedFiles[SCAFFOLD_PRIMITIVES_PATH];
  for (const name of ["matchRouteParams", "useRoute", "useRouteParams", "useNavigate", "RouteLink", "ScaffoldRouteContext"]) {
    assert.match(primitives, new RegExp(`export (?:function|const) ${name}\\b`), name);
  }
  assert.match(primitives, /export \{ useRouteParams as useParams, RouteLink as Link \}/);
  const app = renderScaffoldFoundation(GRAPH).protectedFiles[SCAFFOLD_APP_PATH];
  assert.match(app, /ScaffoldRouteContext\.Provider value=\{routeValue\}/);
});

test("a composed app using the primitives compiles", { ...needsBrowser }, () => {
  assert.equal(built?.ok, true, built?.stderr);
});

test("a screen reads its route parameter and navigates client-side without a page load", { ...needsBrowser, timeout: 120_000 }, async () => {
  const { chromium } = requireCjs("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/items/alpha%20one`);
    await page.waitForSelector('[data-testid="title"]');
    assert.equal(await page.textContent('[data-testid="title"]'), "Item alpha one", "decoded param reaches the screen");
    assert.equal(await page.textContent('[data-testid="pattern"]'), "/items/:itemId");
    // Mark the document so a full reload would be visible.
    await page.evaluate(() => { window.__thralloRouteProof = "kept"; });
    await page.click('[data-testid="go-beta"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="title"]')?.textContent === "Item beta");
    assert.equal(new URL(page.url()).pathname, "/items/beta");
    assert.equal(await page.evaluate(() => window.__thralloRouteProof), "kept", "navigate() did not reload the document");
    await page.click('[data-testid="go-home"]');
    await page.waitForSelector('[data-testid="open-alpha"]');
    assert.equal(new URL(page.url()).pathname, "/");
    await page.click('[data-testid="open-alpha"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="title"]')?.textContent === "Item alpha one");
    assert.equal(await page.evaluate(() => window.__thralloRouteProof), "kept", "Link navigated client-side");
    await page.goBack();
    await page.waitForSelector('[data-testid="open-alpha"]');
    assert.equal(new URL(page.url()).pathname, "/", "history entries stay navigable");
  } finally {
    await browser.close();
  }
});
