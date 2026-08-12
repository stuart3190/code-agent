// IDENTITY INTEGRITY: can two legitimate controls become ambiguous?
//
// `controlIdFor` hashes the control's NAME. Distinct names are distinct identities — including
// dotted ones, so `checkout.email` and `account.email` never collide. Two controls that share a
// bare name share an identity, which is correct when they are the same control on two screens and
// a problem only when both are on screen at once.
//
// This proves the boundary in both directions: scoped names are distinct, and an unscoped
// duplicate is REPORTED rather than resolved by position.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { controlIdFor } from "../../shell/server/lib/builderV2/verificationManifest.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";
import { scopedIdentityApp, SCOPED_CONTRACT } from "./fixtures/scopedIdentityApp.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

// ── the pure property ──────────────────────────────────────────────────────────────────────────

test("a scoped name is a distinct identity", () => {
  const pairs = [
    ["checkout.email", "account.email"],
    ["shipping.address", "billing.address"],
    ["createLead.name", "editLead.name"],
    ["intake.notes", "review.notes"],
  ];
  for (const [left, right] of pairs) {
    assert.notEqual(controlIdFor(left), controlIdFor(right), `${left} vs ${right}`);
    // …and stable: the same scoped name is the same identity every time it is derived.
    assert.equal(controlIdFor(left), controlIdFor(left));
  }
  // A scope changes the identity, so a scoped control is never confused with its bare form.
  assert.notEqual(controlIdFor("notes"), controlIdFor("intake.notes"));
});

test("the same bare name IS the same identity — which is why duplicates must be reported", () => {
  // Not a bug in the hash: two screens showing the same contracted field SHOULD address the same
  // control. It only becomes ambiguous when both are visible at once, which the browser layer
  // detects rather than resolves.
  assert.equal(controlIdFor("notes"), controlIdFor("notes"));
});

// ── the browser proof ──────────────────────────────────────────────────────────────────────────

const SPEC = deriveBuildSpec(SCOPED_CONTRACT);
const CASE = "bv2-identity-scope";
let built = null;
const runs = new Map();

async function drive(scoped) {
  const root = path.join(workDirFor(CASE), "dist");
  const inject = (html) => html.replace("</head>",
    `<script>window.__SCOPED__=${scoped ? "true" : "false"}</script></head>`);
  const server = http.createServer(async (request, response) => {
    const requested = (request.url || "/").split("?")[0];
    const file = requested === "/" ? "/index.html" : requested;
    const asset = /\.(js|css|svg|png|ico)$/.test(file);
    try {
      const body = await readFile(path.join(root, file));
      response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript"
        : file.endsWith(".css") ? "text/css" : "text/html" });
      response.end(asset ? body : inject(body.toString("utf8")));
    } catch {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(inject((await readFile(path.join(root, "index.html"))).toString("utf8")));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await verifyJourneys({
      previewUrl: `http://127.0.0.1:${server.address().port}`, contract: SPEC.contract, timeoutMs: 600_000,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  built = await buildTree({ ...fromScaffold(REACT_VITE), ...scopedIdentityApp() }, CASE, () => {});
  if (!built.ok) return;
  runs.set("unscoped", await drive(false));
  runs.set("scoped", await drive(true));
}, { timeout: 1_800_000 });

after(() => {
  for (const [variant, run] of runs) {
    const journey = run.journeys[0];
    console.log(`\n### ${variant} => ${journey.status}`);
    for (const [index, step] of (journey.steps || []).entries()) {
      console.log(`  ${index + 1} ${String(step.status).toUpperCase().padEnd(12)} ${(step.detail || "").slice(0, 96)}`);
    }
  }
});

test("the scope fixture compiles", { ...needsBrowser }, () => {
  assert.equal(built.ok, true, built?.stderr);
});

test("two visible controls sharing one identity are REPORTED, never resolved by position", { ...needsBrowser }, () => {
  const journey = runs.get("unscoped").journeys[0];
  const step = journey.steps[1];
  assert.notEqual(step.status, "pass", `ambiguity must not pass: ${JSON.stringify(step)}`);
  const rows = step.controlEvidence?.fields || [];
  const ambiguous = rows.find((row) => row.status === "ambiguous_identity");
  assert.ok(ambiguous, `an ambiguity is named: ${JSON.stringify(rows)}`);
  assert.match(String(ambiguous.detail || ""), /share the machine identity ctl_/);
  assert.match(String(ambiguous.detail || ""), /distinct scoped name/, "and says how to resolve it");
  // Nothing was typed into either control on a guess.
  for (const row of rows) assert.notEqual(row.status, "filled", JSON.stringify(row));
});

test("scoping the same two controls makes each independently addressable", { ...needsBrowser }, () => {
  // Same application, same contract, scopes added: the identities separate and the ambiguity is
  // gone. Nothing about labels, order or business vocabulary changed.
  const page = runs.get("scoped");
  const journey = page.journeys[0];
  const step = journey.steps[1];
  const rows = step.controlEvidence?.fields || [];
  assert.equal(rows.some((row) => row.status === "ambiguous_identity"), false,
    `scoped controls are not ambiguous: ${JSON.stringify(rows)}`);
});
