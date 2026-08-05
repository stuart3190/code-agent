// Modular by construction — proven against the 46.10-credit run's real monolith.
//
// fixtures/run178f7fc8/App.jsx is that build's stored App.jsx byte-for-byte: ~11.5k tokens,
// five journeys, every stage re-read and rewrote it. These tests pin that the shape now fails
// the stage gate, that the scaffold's slots pass it, that persistence cannot live in
// components, that later stages cannot collapse the modular tree, and that a verifier failure
// loads the owning module — not the world.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { modularityCheck, fileMetrics, APP_SHELL_MAX_TOKENS, FILE_MAX_TOKENS } from "../../shell/server/lib/appBuild/modularity.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { planStages, stagePrompt, STAGE_GLOBAL_INVARIANTS } from "../../shell/server/lib/appBuild/stagePlan.mjs";
import { buildStageContext } from "../../shell/server/lib/appBuild/contextBuilder.mjs";
import { buildManifest, tokensOf } from "../../shell/server/lib/appBuild/projectManifest.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const CONTRACT = JSON.parse(readFileSync(path.join(FIXTURES, "cf130c23", "contract.json"), "utf8"));
const MONOLITH = readFileSync(path.join(FIXTURES, "run178f7fc8", "App.jsx"), "utf8");

test("the 46-run monolith fails the gate: shell size AND god-component, measured not guessed", () => {
  const result = modularityCheck({ "src/App.jsx": MONOLITH }, { contract: CONTRACT });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /src\/App\.jsx is \d+ tokens/.test(p) && /src\/routes\//.test(p)));
  const app = result.metrics.find((m) => m.path === "src/App.jsx");
  assert.ok(app.tokens > APP_SHELL_MAX_TOKENS, `measured ${app.tokens} tokens`);
  assert.ok(app.journeys.length >= 3, `owns ${app.journeys.length} journeys: ${app.journeys.join(", ")}`);
});

test("the scaffold's shell passes: known-good slots, not an invented architecture", () => {
  const shell = REACT_VITE["src/App.jsx"];
  assert.ok(shell.includes("const ROUTES"), "a routing map the model extends");
  assert.ok(shell.includes("ErrorBoundary"), "error boundary lives in the shell");
  assert.ok(REACT_VITE["src/routes/HomePage.jsx"], "one route, one file, from the first file onward");
  assert.ok(tokensOf(shell) < APP_SHELL_MAX_TOKENS / 2, `the shell itself is small (${tokensOf(shell)} tok)`);
  const result = modularityCheck(
    { "src/App.jsx": shell, "src/routes/HomePage.jsx": REACT_VITE["src/routes/HomePage.jsx"] },
    { contract: CONTRACT },
  );
  assert.equal(result.ok, true, JSON.stringify(result.problems));
});

test("persistence inside a component is flagged; in a data module it is not", () => {
  const bad = modularityCheck({
    "src/routes/BookingPage.jsx": 'import { db } from "../lib/backend";\nexport default function BookingPage() { db.entity("booking").create({}); return null; }',
  }, { contract: CONTRACT });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /db\.entity\(\) inside a component/.test(p)));

  const good = modularityCheck({
    "src/routes/BookingPage.jsx": 'import { createBooking } from "../data/bookings";\nexport default function BookingPage() { return null; }',
    "src/data/bookings.js": 'import { db } from "../lib/backend";\nexport async function createBooking(x) { return db.entity("booking").create(x); }',
  }, { contract: CONTRACT });
  assert.equal(good.ok, true, JSON.stringify(good.problems));
});

test("an oversized file with a stated modularity exception is recorded, not blocked", () => {
  const big = `// modularity: generated data table with ${"x".repeat(20)} fixed rows, no logic\n`
    + `export const ROWS = [${Array.from({ length: 2000 }, (_, i) => `"row-${i}"`).join(",")}];\n`;
  assert.ok(tokensOf(big) > FILE_MAX_TOKENS, "the fixture really is oversized");
  const result = modularityCheck({ "src/data/rows.js": big }, { contract: CONTRACT });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.ok(result.flags.some((f) => /stated exception/.test(f)));
  // Without the comment, the same file blocks.
  const blocked = modularityCheck({ "src/data/rows.js": big.split("\n").slice(1).join("\n") }, { contract: CONTRACT });
  assert.equal(blocked.ok, false);
});

test("a later stage cannot collapse the modular tree: deleted route/data files fail the gate", () => {
  const green = {
    "src/App.jsx": REACT_VITE["src/App.jsx"],
    "src/routes/HomePage.jsx": "export default function HomePage() { return null; }",
    "src/routes/BookingPage.jsx": "export default function BookingPage() { return null; }",
    "src/data/bookings.js": "export const x = 1;",
  };
  const collapsed = { "src/App.jsx": green["src/App.jsx"], "src/routes/HomePage.jsx": green["src/routes/HomePage.jsx"] };
  const result = modularityCheck(collapsed, { contract: CONTRACT, previousGreen: green });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((p) => /src\/routes\/BookingPage\.jsx existed in the last green tree/.test(p)));
  assert.ok(result.problems.some((p) => /src\/data\/bookings\.js existed/.test(p)));
  // The unchanged modular tree passes against its own history.
  assert.equal(modularityCheck(green, { contract: CONTRACT, previousGreen: green }).ok, true);
});

test("a selected-date defect loads DateSelector and its caller — not App.jsx, not the world", () => {
  const tree = {
    "package.json": "{}",
    "src/App.jsx": REACT_VITE["src/App.jsx"].replace('"/": HomePage,', '"/": HomePage,') ,
    "src/routes/HomePage.jsx": "export default function HomePage() { return null; }",
    "src/routes/BookingPage.jsx": 'import DateSelector from "../components/DateSelector";\nexport default function BookingPage() { return <DateSelector />; }',
    "src/components/DateSelector.jsx": "export default function DateSelector() { return <div>dates</div>; }",
    "src/components/NewsletterSignup.jsx": "export default function NewsletterSignup() { return null; }",
    "src/data/bookings.js": "export const b = 1;",
  };
  const context = buildStageContext({
    tree, manifest: buildManifest(tree, { contract: CONTRACT }),
    stageId: "repair", contract: CONTRACT,
    failures: ["the journey fails at 'choose an available date' — src/components/DateSelector.jsx never shows a selected state"],
    budgetTokens: 40_000,
  });
  const full = context.full.map((c) => c.path);
  assert.ok(full.includes("src/components/DateSelector.jsx"), `the named module is in: ${full.join(", ")}`);
  assert.ok(full.includes("src/routes/BookingPage.jsx"), "its direct caller rides along");
  assert.ok(!full.includes("src/App.jsx"), "the shell does NOT — the repair sees the owning modules only");
  assert.ok(!full.includes("src/components/NewsletterSignup.jsx"), "unrelated modules stay out");
});

test("the SDK surface answers what the live build paid a discovery turn for — update() and friends", () => {
  // Run 17b6513f expanded into supabaseBackend.js (+5,813 tokens) with the reason "Need db.entity
  // CRUD method signatures, especially update()". The surface (index.js — the file every stage
  // receives in full) now documents the COMPLETE supported API, so the implementation stays
  // protected and out of context with nothing left to discover.
  const surface = REACT_VITE["src/lib/backend/index.js"];
  for (const signature of [".create(values)", ".get(id)", ".list({ filters, order, ascending, limit, cursor })",
    ".count(filters)", ".update(id, values)", ".delete(id)", ".subscribe(callback)"]) {
    assert.ok(surface.includes(signature), `surface documents ${signature}`);
  }
  assert.match(surface, /REPLACES row\.data with `values` wholesale — it does NOT merge/,
    "the update() trap is stated, with the read-modify-write recipe");
  assert.match(surface, /eq \| neq \| gte \| lte \| ilike \| in/, "filtering is documented");
  assert.match(surface, /cursor: a created_at value for keyset pagination/, "pagination is documented");
  assert.match(surface, /Rows belong to the signed-in\s*\n?\/\/ user \(RLS\)/, "ownership behaviour is documented");
  assert.match(surface, /THIS COMMENT IS THE COMPLETE SUPPORTED SURFACE/, "and it says so, so the model stops looking");

  // The stage context ships the surface in full and the implementation as nothing more than a
  // manifest line — the expansion is structurally unnecessary now.
  const tree = {
    "package.json": "{}",
    "src/App.jsx": REACT_VITE["src/App.jsx"],
    "src/routes/HomePage.jsx": REACT_VITE["src/routes/HomePage.jsx"],
    "src/lib/backend/index.js": surface,
    "src/lib/backend/supabaseBackend.js": REACT_VITE["src/lib/backend/supabaseBackend.js"],
    "src/data/bookings.js": "export const b = 1;",
  };
  const context = buildStageContext({
    tree, manifest: buildManifest(tree, { contract: CONTRACT }),
    stageId: "data", contract: CONTRACT, budgetTokens: 40_000,
  });
  const full = context.full.map((c) => c.path);
  assert.ok(full.includes("src/lib/backend/index.js"), "the surface rides in full");
  assert.ok(!full.includes("src/lib/backend/supabaseBackend.js"), "the implementation does not");
});

test("stage prompts and invariants teach the modular shape; foundation maps one file per route", () => {
  const stages = planStages(CONTRACT, { includePolish: false });
  const foundation = stagePrompt(stages.find((s) => s.id === "foundation"), CONTRACT, { request: "booking site" });
  assert.match(foundation, /ONE FILE PER ROUTE under src\/routes\//);
  assert.match(foundation, /register each in ROUTES/);
  const primary = stagePrompt(stages.find((s) => s.id === "primary_journey"), CONTRACT, { request: "booking site" });
  assert.match(primary, /journey's OWN modules/);
  assert.match(primary, /do not edit other journeys' modules/);
  const supporting = stagePrompt(stages.find((s) => s.id === "supporting"), CONTRACT, { request: "booking site" });
  assert.match(supporting, /never be deleted or merged/);
  assert.match(STAGE_GLOBAL_INVARIANTS, /MODULAR STRUCTURE/);
  assert.match(STAGE_GLOBAL_INVARIANTS, /one route =\n?\s*one file under src\/routes\//);
});
