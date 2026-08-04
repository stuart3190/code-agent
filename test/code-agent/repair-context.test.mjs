// PR1 — the repair brief must contain the failure, not a pointer to it.
//
// The regression these guard against is recorded in production diagnostics baa3e8fc / f00c7950:
// the repair agent was handed "the build failed: <200 chars>" plus "open Build Diagnostics
// (baa3e8fc)", could not see the rollup error, and twice patched the wrong file.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRepairBrief, headlineError, redact, referencesDiagnosticsOnly,
} from "../../shell/server/lib/appBuild/repairContext.mjs";
import { planEndAction } from "../../shell/server/lib/appBuild/appBuildService.mjs";

// The exact output rollup produced in both failed production runs.
const LUCIDE_FAILURE = `> booking-site@0.0.0 build
> vite build

vite v5.4.10 building for production...
transforming...
✓ 61 modules transformed.
x Build failed in 2.58s
error during build:
src/App.jsx (7:129): "Instagram" is not exported by "../../.deps/node_modules/lucide-react/dist/esm/lucide-react.mjs", imported by "src/App.jsx".
file: /home/ubuntu/code-agent/harness/.work/shell-521c8922/src/App.jsx:7:129
    at getRollupError (file:///.../parseAst.js:396:41)`;

test("the brief contains the exact failing line, not a diagnostics id", () => {
  const brief = buildRepairBrief({ command: "npm run build", output: LUCIDE_FAILURE });

  // The acceptance criterion, verbatim.
  assert.match(brief, /"Instagram" is not exported by/);
  assert.ok(brief.includes("src/App.jsx (7:129)"), "the file and column survive into the brief");
  assert.match(brief, /COMMAND THAT FAILED: npm run build/);
  assert.ok(!referencesDiagnosticsOnly(brief), "must not point at diagnostics instead of carrying them");
});

test("the headline surfaces the export error above the compiler banner", () => {
  // The old brief led with "the build failed", which is what let a repair agent decide it was
  // looking at a lint problem and delete three unused imports.
  assert.equal(
    headlineError(LUCIDE_FAILURE),
    '"Instagram" is not exported by "../../.deps/node_modules/lucide-react/dist/esm/lucide-react.mjs", imported by "src/App.jsx".',
  );
  assert.match(headlineError("Error: Cannot find module './lib/format'"), /Cannot find module/);
  assert.match(headlineError("src/a.ts(4,9): error TS2304: Cannot find name 'foo'."), /error TS2304/);
});

test("nothing is truncated at 200 characters any more", () => {
  // The old path: `the build failed: ${String(error).slice(0, 200)}`. The export error sits at
  // character 190+ of the real output, so the one line that mattered was routinely cut in half.
  const oldWay = LUCIDE_FAILURE.slice(0, 200);
  assert.ok(!oldWay.includes('"Instagram" is not exported'),
    "200 characters of real build output does not reach the line that names the fault");

  const brief = buildRepairBrief({ output: LUCIDE_FAILURE });
  assert.match(brief, /"Instagram" is not exported by/);
  assert.ok(brief.includes("lucide-react.mjs"), "the module that lacks the export survives too");
});

test("an unchanged fingerprint is stated as a fact the repair agent can act on", () => {
  const brief = buildRepairBrief({
    output: LUCIDE_FAILURE,
    fingerprint: "ac60a9b42a79f171",
    previousFingerprint: "ac60a9b42a79f171",
    changedFiles: ["src/App.jsx"],
    lastDiff: "-import { Clock, Users, Phone } from 'lucide-react';",
  });
  assert.match(brief, /THE LAST REPAIR DID NOT WORK/);
  assert.match(brief, /FILES YOUR LAST PATCH TOUCHED: src\/App\.jsx/);
  // The real second repair removed unused imports; the brief now shows that it did so in vain.
  assert.match(brief, /Clock, Users, Phone/);

  const moved = buildRepairBrief({
    output: LUCIDE_FAILURE, fingerprint: "aaa", previousFingerprint: "bbb",
  });
  assert.ok(!/THE LAST REPAIR DID NOT WORK/.test(moved), "only claimed when the signature really is identical");
});

test("the manifest travels with the brief so a pinned export can be checked", () => {
  const brief = buildRepairBrief({
    output: LUCIDE_FAILURE,
    manifest: JSON.stringify({ dependencies: { "lucide-react": "0.263.1", react: "18.3.1" } }),
  });
  assert.match(brief, /INSTALLED DEPENDENCIES/);
  assert.match(brief, /lucide-react/);
  assert.match(brief, /0\.263\.1/);
});

test("worktree, branch and commit identify what was actually built", () => {
  const brief = buildRepairBrief({
    output: LUCIDE_FAILURE, worktree: "harness/.work/shell-521c8922", branch: "main", commit: "98456c2",
  });
  assert.match(brief, /BUILDING FROM: worktree harness\/\.work\/shell-521c8922 · branch main · commit 98456c2/);
});

test("secrets are redacted before any of this reaches a model", () => {
  const dirty = [
    "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop1234567890",
    'STRIPE_SECRET_KEY="sk_live_51QabcdefghijklmnopQR"',
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijk",
    "SUPABASE_SERVICE_ROLE_KEY: eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.qwertyuiopas",
    "postgres://thrallo:hunter2correct@db.internal:5432/app",
    "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
  ].join("\n");
  const clean = redact(dirty);

  for (const secret of ["sk-ant-api03-abcdefghijklmnop", "sk_live_51Qabcdefghijklmnop",
    "hunter2correct", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ", "qwertyuiopas"]) {
    assert.ok(!clean.includes(secret), `leaked: ${secret}`);
  }
  // Redaction must not eat the surrounding output — the model still needs to read the log.
  assert.match(clean, /ANTHROPIC_API_KEY/);
  assert.match(clean, /db\.internal:5432\/app/);

  const brief = buildRepairBrief({ output: `${LUCIDE_FAILURE}\n${dirty}` });
  assert.ok(!brief.includes("hunter2correct"), "the assembled brief redacts too");
  assert.match(brief, /"Instagram" is not exported by/, "and still carries the error");
});

test("very long output keeps the tail, where the error is", () => {
  const noise = "npm warn deprecated something@1.0.0\n".repeat(2_000);
  const brief = buildRepairBrief({ output: `${noise}${LUCIDE_FAILURE}` });
  assert.match(brief, /"Instagram" is not exported by/);
  assert.match(brief, /earlier characters omitted/);
});

// The shape a compile failure ACTUALLY arrives in: the job completes and reports buildOk false.
// (It is not `status: "failed"` — that classifies as a permanent failure and never reaches repair.)
const COMPILE_FAILED = { status: "complete", result: { buildOk: false, tree: {}, qualityWarnings: [] } };

test("planEndAction dispatches the repair with the real diagnostics attached", () => {
  const action = planEndAction(COMPILE_FAILED, {
    attempt: 2,
    previousFingerprints: [],
    diagnostics: {
      command: "npm run build",
      output: LUCIDE_FAILURE,
      changedFiles: ["src/App.jsx"],
      manifest: JSON.stringify({ dependencies: { "lucide-react": "0.263.1" } }),
    },
  });
  assert.equal(action.kind, "repair");
  assert.match(action.brief, /"Instagram" is not exported by/);
  assert.match(action.brief, /Attempt 2 of 3/);
  assert.ok(!referencesDiagnosticsOnly(action.brief));
});

test("a compile failure is called a compile failure, not a quality check", () => {
  // The exact mislabelling behind "addressing the build quality/lint failure": every compiler
  // error was reported to the repair agent as "the build's quality checks failed".
  const withDiag = planEndAction(COMPILE_FAILED, {
    attempt: 1, previousFingerprints: [],
    diagnostics: { command: "npm run build", output: LUCIDE_FAILURE },
  });
  assert.match(withDiag.brief, /the compiler rejected the project/);
  assert.match(withDiag.brief, /"Instagram" is not exported by/);
  assert.ok(!/quality checks failed/.test(withDiag.brief), "must not be described as a quality problem");

  // And with no output captured at all it still says compile, not quality.
  const bare = planEndAction(COMPILE_FAILED, { attempt: 1, previousFingerprints: [] });
  assert.match(bare.brief, /failed to compile/);
});

test("without diagnostics the brief still stands on the reason list", () => {
  // Quality-warning rounds have no compiler output; they must not regress into an empty brief.
  const action = planEndAction(
    { status: "complete", result: { buildOk: false, qualityWarnings: ["the hero image is missing"] } },
    { attempt: 2, previousFingerprints: [] },
  );
  assert.equal(action.kind, "repair");
  assert.match(action.brief, /failed to compile/);
});

test("referencesDiagnosticsOnly catches the exact regression it exists for", () => {
  assert.equal(referencesDiagnosticsOnly(
    "What failed: npm run build. The exact output is saved with this build — open Build Diagnostics (baa3e8fc) to read it.",
  ), true);
  assert.equal(referencesDiagnosticsOnly(buildRepairBrief({ output: LUCIDE_FAILURE })), false);
});
