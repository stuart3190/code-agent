// The two deterministic-persistence shapes from run cf130c23 / build 94ad0b0f, proven against the
// EXACT production sources (test/code-agent/fixtures/cf130c23/* is the stored project tree of the
// blocked build, byte-for-byte — not simplified fixtures).
//
// That run's honesty scan recorded FOUR hard findings and the transform declined both files:
//   src/App.jsx:63/70                 — the visitor-session credential cache in ensureBookingSession
//   src/data/newsletterSignup.js:38/39 — the guest fallback branch (capped-array localStorage write)
//
// The corrected classifications, pinned here:
//   App.jsx's storage is AUTH BOOTSTRAP — its cached value's only consumer is auth.signIn/signUp,
//   and replacing it with db.entity() is circular (entities are owner-scoped by RLS; the read
//   would need the session the credentials establish). It becomes a WARNING, not a hard finding.
//   The newsletter guest branch IS fake persistence, and its provable fix is the app's own
//   bootstrap moved verbatim into a shared module — records land in the database for visitors too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { honestyScan, isSessionBootstrap, findSessionBootstrapFunction } from "../../shell/server/lib/appBuild/honestyScan.mjs";
import { transformPersistence, transformGuestFallback, usesBrowserStorage } from "../../shell/server/lib/appBuild/persistenceTransform.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cf130c23");
const read = (name) => readFileSync(path.join(FIXTURES, name), "utf8");

const CONTRACT = { entities: [{ name: "booking" }, { name: "newsletterSignup" }] };

function productionTree() {
  return {
    "src/App.jsx": read("App.jsx"),
    "src/data/newsletterSignup.js": read("newsletterSignup.js"),
    "src/data/booking.js": read("booking.js"),
  };
}

// ── classification ────────────────────────────────────────────────────────────────────────────

test("SHAPE A — the visitor-session credential cache classifies as session bootstrap, not fake persistence", () => {
  const scan = honestyScan(productionTree(), { contract: CONTRACT });

  // The run recorded 4 hard findings; the correct count is the 2 newsletter lines.
  const hard = scan.findings.filter((f) => f.id === "fake_persistence");
  assert.equal(hard.length, 2, JSON.stringify(scan.findings, null, 1));
  assert.ok(hard.every((f) => f.file === "src/data/newsletterSignup.js"));
  assert.deepEqual(hard.map((f) => f.line).sort(), [38, 39]);

  // App.jsx:63/70 are still REPORTED — as session-credential warnings, visible but not blocking.
  const sessions = scan.warnings.filter((w) => w.id === "session_credentials");
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((w) => w.file === "src/App.jsx"));
  assert.deepEqual(sessions.map((w) => w.line).sort((a, b) => a - b), [63, 70]);
});

test("SHAPE A — the exemption is narrow: the newsletter guest branch is NOT session bootstrap", () => {
  const newsletter = read("newsletterSignup.js");
  // Both flagged expressions in the newsletter module stay hard findings.
  const idx38 = newsletter.indexOf('localStorage.getItem("berry-brook-newsletter-signups"');
  const idx39 = newsletter.indexOf('localStorage.setItem("berry-brook-newsletter-signups"');
  assert.ok(idx38 > 0 && idx39 > 0, "the exact recorded expressions exist in the fixture");
  assert.equal(isSessionBootstrap(newsletter, idx38), false);
  assert.equal(isSessionBootstrap(newsletter, idx39), false);
  // And the bootstrap finder locates the app's own function, by name, verbatim.
  const found = findSessionBootstrapFunction(read("App.jsx"));
  assert.equal(found?.name, "ensureBookingSession");
  assert.match(found.text, /berry-brook-visitor-session/);
  assert.match(found.text, /auth\.signIn\(saved\)/);
});

// ── the transform ─────────────────────────────────────────────────────────────────────────────

test("SHAPE B — the guest fallback branch maps to the app's own visitor session, moved verbatim", () => {
  const tree = productionTree();
  const scan = honestyScan(tree, { contract: CONTRACT });
  const result = transformPersistence(tree, { findings: scan.findings, contract: CONTRACT });

  assert.deepEqual(result.declined, [], JSON.stringify(result.declined, null, 1));
  const files = result.fixed.map((f) => f.file).sort();
  assert.deepEqual(files, ["src/App.jsx", "src/data/newsletterSignup.js"]);

  // The bootstrap now lives in ONE shared module, byte-identical logic, exported.
  const shared = result.tree["src/data/visitorSession.js"];
  assert.ok(shared, "src/data/visitorSession.js was created");
  assert.match(shared, /export async function ensureBookingSession\(\)/);
  assert.match(shared, /berry-brook-visitor-session/);
  assert.match(shared, /import \{ auth \} from "\.\.\/lib\/backend"/);

  // The newsletter module: no browser storage at all; the guest branch establishes the SAME
  // visitor session and falls through to the real create.
  const newsletter = result.tree["src/data/newsletterSignup.js"];
  assert.equal(usesBrowserStorage(newsletter), false);
  assert.match(newsletter, /user = await ensureBookingSession\(\);/);
  assert.match(newsletter, /import \{ ensureBookingSession \} from "\.\/visitorSession"/);
  // Exported name, validation, and the real entity path are untouched.
  assert.match(newsletter, /export async function createNewsletterSignup\(email\)/);
  assert.match(newsletter, /Email must look like an email address\./);
  assert.match(newsletter, /newsletterEntity\(\)\.create\(/);

  // The origin: function replaced with a pointer comment, import added, callers intact.
  const app = result.tree["src/App.jsx"];
  assert.equal(usesBrowserStorage(app), false);
  assert.match(app, /import \{ ensureBookingSession \} from "\.\/data\/visitorSession"/);
  assert.match(app, /await ensureBookingSession\(\)/, "App.jsx still calls the bootstrap");
  assert.doesNotMatch(app, /async function ensureBookingSession/);

  // Untouched bystander: booking.js is byte-identical.
  assert.equal(result.tree["src/data/booking.js"], tree["src/data/booking.js"]);
});

test("SHAPE B — the transformed tree rescans clean: zero hard findings, zero fake persistence", () => {
  const tree = productionTree();
  const first = honestyScan(tree, { contract: CONTRACT });
  const result = transformPersistence(tree, { findings: first.findings, contract: CONTRACT });
  const rescan = honestyScan(result.tree, { contract: CONTRACT });

  assert.equal(rescan.ok, true, JSON.stringify(rescan.findings, null, 1));
  assert.equal(rescan.findings.length, 0);
  // The moved bootstrap is still visible — as the session-credentials warning, in its new home.
  assert.ok(rescan.warnings.some((w) => w.id === "session_credentials" && w.file === "src/data/visitorSession.js"));
  // No business persistence in the browser anywhere in app code.
  for (const [file, source] of Object.entries(result.tree)) {
    if (file === "src/data/visitorSession.js") continue; // session credentials, classified above
    assert.equal(usesBrowserStorage(source), false, `${file} still touches browser storage`);
  }
});

test("SHAPE B — with no bootstrap anywhere in the tree, the module declines loudly with no edits", () => {
  const tree = productionTree();
  delete tree["src/App.jsx"]; // the only session bootstrap in the app
  const scan = honestyScan(tree, { contract: CONTRACT });
  const result = transformPersistence(tree, { findings: scan.findings, contract: CONTRACT });

  const declined = result.declined.find((d) => d.file === "src/data/newsletterSignup.js");
  assert.ok(declined, "the newsletter module must decline, not half-transform");
  assert.ok(declined.reasons.some((r) => /no session-bootstrap function/.test(r)), declined.reasons.join("; "));
  // No partial edits: the module is byte-identical and no shared module appeared.
  assert.equal(result.tree["src/data/newsletterSignup.js"], tree["src/data/newsletterSignup.js"]);
  assert.equal(result.tree["src/data/visitorSession.js"], undefined);
});

test("SHAPE B — re-running the transform on the fixed tree changes nothing (idempotent)", () => {
  const tree = productionTree();
  const first = honestyScan(tree, { contract: CONTRACT });
  const once = transformPersistence(tree, { findings: first.findings, contract: CONTRACT });
  const again = transformGuestFallback(once.tree, { files: ["src/data/newsletterSignup.js"] });
  assert.deepEqual(again.appliedByFile, {}, "no second application");
  assert.equal(again.tree["src/data/newsletterSignup.js"], once.tree["src/data/newsletterSignup.js"]);
});
