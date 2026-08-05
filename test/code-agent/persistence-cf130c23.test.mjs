// The persistence shapes from runs cf130c23 (blocked booking build) and 178f7fc8 (the
// 46.10-credit run), proven against the EXACT production sources in fixtures/cf130c23.
//
// Design after the 46.10-credit run: the visitor-session bootstrap is a MAINTAINED SCAFFOLD
// MODULE (src/lib/visitorSession.js), exempted from the honesty scan by path and protected from
// edits by the stage gate. Hand-written variants — the file the model kept re-inventing through
// three in-stage repair loops — are BLOCKING findings with their own label, and the deterministic
// transform maps them to the scaffold: guest fallback branches call ensureVisitorSession, local
// bootstrap functions become an import alias of it. Same callers, one tested implementation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { honestyScan, isSessionBootstrap, findSessionBootstrapFunction } from "../../shell/server/lib/appBuild/honestyScan.mjs";
import { transformPersistence, transformGuestFallback, usesBrowserStorage } from "../../shell/server/lib/appBuild/persistenceTransform.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cf130c23");
const read = (name) => readFileSync(path.join(FIXTURES, name), "utf8");

const CONTRACT = { entities: [{ name: "booking" }, { name: "newsletterSignup" }] };
const SCAFFOLD_SESSION = "src/lib/visitorSession.js";

function productionTree() {
  return {
    "src/App.jsx": read("App.jsx"),
    "src/data/newsletterSignup.js": read("newsletterSignup.js"),
    "src/data/booking.js": read("booking.js"),
  };
}

// ── the scaffold module itself ────────────────────────────────────────────────────────────────

test("the scaffold ships ONE maintained visitor-session module and the scan exempts exactly it", () => {
  const module = REACT_VITE[SCAFFOLD_SESSION];
  assert.ok(module, "src/lib/visitorSession.js ships with the scaffold");
  assert.match(module, /export async function ensureVisitorSession/);
  assert.match(module, /auth\.signIn|auth\.signUp/);

  // The scan does not flag the scaffold module — by PATH, not by shape. (Stage-scoped: a
  // one-file tree has no db.entity call, and the whole-app rule is not what is under test.)
  const scan = honestyScan({ [SCAFFOLD_SESSION]: module }, { contract: CONTRACT, stageScoped: true });
  assert.equal(scan.findings.length, 0, JSON.stringify(scan.findings));
});

// ── classification: local variants BLOCK ──────────────────────────────────────────────────────

test("a hand-written bootstrap is a BLOCKING finding with its own label (the repair-loop shape)", () => {
  const scan = honestyScan(productionTree(), { contract: CONTRACT });

  // All four production expressions are hard findings now — two plain fake persistence in the
  // newsletter module, two labelled as the local bootstrap in App.jsx.
  const newsletter = scan.findings.filter((f) => f.id === "fake_persistence");
  const bootstrap = scan.findings.filter((f) => f.id === "local_session_bootstrap");
  assert.deepEqual(newsletter.map((f) => f.file), ["src/data/newsletterSignup.js", "src/data/newsletterSignup.js"]);
  assert.deepEqual(bootstrap.map((f) => f.file), ["src/App.jsx", "src/App.jsx"]);
  assert.match(bootstrap[0].message, /src\/lib\/visitorSession\.js/, "the finding names the supported module");

  // The classifier is still narrow: the newsletter guest branch is NOT a bootstrap.
  const source = read("newsletterSignup.js");
  assert.equal(isSessionBootstrap(source, source.indexOf("localStorage.getItem")), false);
  assert.equal(findSessionBootstrapFunction(read("App.jsx"))?.name, "ensureBookingSession");
});

// ── the transform: everything maps to the scaffold ────────────────────────────────────────────

test("the transform aliases the local bootstrap to the scaffold and rewires the guest branch", () => {
  const tree = productionTree();
  const scan = honestyScan(tree, { contract: CONTRACT });
  const result = transformPersistence(tree, { findings: scan.findings, contract: CONTRACT });

  assert.deepEqual(result.declined, [], JSON.stringify(result.declined, null, 1));

  // The scaffold module was added to this older tree, verbatim.
  assert.equal(result.tree[SCAFFOLD_SESSION], REACT_VITE[SCAFFOLD_SESSION]);

  // App.jsx: the hand-written function is GONE; its name now aliases the scaffold export, so
  // every existing caller works unchanged.
  const app = result.tree["src/App.jsx"];
  assert.equal(usesBrowserStorage(app), false);
  assert.doesNotMatch(app, /async function ensureBookingSession/);
  assert.match(app, /import \{ ensureVisitorSession as ensureBookingSession \} from "\.\/lib\/visitorSession"/);
  assert.match(app, /await ensureBookingSession\(\)/, "callers untouched");

  // The newsletter guest branch: same scaffold session, then the real create.
  const newsletter = result.tree["src/data/newsletterSignup.js"];
  assert.equal(usesBrowserStorage(newsletter), false);
  assert.match(newsletter, /user = await ensureVisitorSession\(\);/);
  assert.match(newsletter, /import \{ ensureVisitorSession \} from "\.\.\/lib\/visitorSession"/);
  assert.match(newsletter, /export async function createNewsletterSignup\(email\)/);
  assert.match(newsletter, /newsletterEntity\(\)\.create\(/);

  // Booking and newsletter therefore share ONE real backend session — the scaffold's.
  assert.equal(result.tree["src/data/booking.js"], tree["src/data/booking.js"]);

  // And the rescan is clean: no scanner/repair loop is possible on this tree.
  const rescan = honestyScan(result.tree, { contract: CONTRACT });
  assert.equal(rescan.findings.length, 0, JSON.stringify(rescan.findings, null, 1));
});

test("the 46.10-run shape — a local variant living in its own module — maps to the scaffold too", () => {
  // The move-target shape the previous design produced (and the model kept re-inventing):
  // a data-module bootstrap with the exact production function text.
  const local = findSessionBootstrapFunction(read("App.jsx"));
  const tree = {
    "src/data/visitorSession.js": `import { auth } from "../lib/backend";\n\nexport ${local.text.replace(/^export\s+/, "")}\n`,
    "src/data/newsletterSignup.js": read("newsletterSignup.js"),
    "src/data/booking.js": read("booking.js"),
  };
  const scan = honestyScan(tree, { contract: CONTRACT });
  assert.ok(scan.findings.some((f) => f.id === "local_session_bootstrap" && f.file === "src/data/visitorSession.js"),
    "the local variant is a blocking finding");

  const result = transformPersistence(tree, { findings: scan.findings, contract: CONTRACT });
  assert.deepEqual(result.declined, []);
  const variant = result.tree["src/data/visitorSession.js"];
  assert.equal(usesBrowserStorage(variant), false, "the hand-written storage is gone");
  assert.match(variant, /import \{ ensureVisitorSession as ensureBookingSession \} from "\.\.\/lib\/visitorSession"/);
  assert.equal(honestyScan(result.tree, { contract: CONTRACT }).findings.length, 0,
    "one deterministic pass, zero model repairs — the three-stage loop cannot recur");
});

test("an unprovable persistence shape still declines loudly with zero partial edits", () => {
  const tree = {
    "src/data/weird.js": 'export function weird() { localStorage.setItem("x", JSON.stringify(window.everything)); }',
  };
  const scan = honestyScan(tree, { contract: CONTRACT });
  const result = transformPersistence(tree, { findings: scan.findings, contract: CONTRACT });
  const declined = result.declined.find((d) => d.file === "src/data/weird.js");
  assert.ok(declined, "no matching mapping means a loud decline");
  assert.equal(result.tree["src/data/weird.js"], tree["src/data/weird.js"], "byte-identical — no half-transform");
});

test("re-running the transform on a fixed tree changes nothing (idempotent)", () => {
  const tree = productionTree();
  const first = honestyScan(tree, { contract: CONTRACT });
  const once = transformPersistence(tree, { findings: first.findings, contract: CONTRACT });
  const again = transformGuestFallback(once.tree, { files: ["src/data/newsletterSignup.js", "src/App.jsx"] });
  assert.deepEqual(again.appliedByFile, {}, "no second application");
  assert.equal(again.tree["src/data/newsletterSignup.js"], once.tree["src/data/newsletterSignup.js"]);
  assert.equal(again.tree["src/App.jsx"], once.tree["src/App.jsx"]);
});
