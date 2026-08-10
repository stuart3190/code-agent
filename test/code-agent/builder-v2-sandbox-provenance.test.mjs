// Host/sandbox version skew must be detectable, and must fail BEFORE model spend.
//
// The 2026-08-10 incident: the worker was pinned to a sandbox image built three days earlier, so
// every live qualification was graded by an old journeyVerifier while four later fixes sat in the
// repository looking deployed. Nothing reported it. A full paid run produced false passes.
//
// These tests pin the mechanism that makes that impossible to repeat silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareSandboxIdentity, computeSandboxIdentity, sandboxSkewSummary,
  SANDBOX_IDENTITY_FILES, VERIFIER_PATH, readBakedProvenance, PROVENANCE_FILENAME,
} from "../../shell/server/lib/builderV2/sandboxProvenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function fixtureTree(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "thrallo-sandbox-identity-"));
  for (const relative of SANDBOX_IDENTITY_FILES) {
    await mkdir(path.join(dir, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(dir, relative), overrides[relative] ?? `contents of ${relative}\n`, "utf8");
  }
  return dir;
}

test("the identity covers the verifier and the files that decide a verdict with it", () => {
  assert.ok(SANDBOX_IDENTITY_FILES.includes(VERIFIER_PATH));
  assert.ok(SANDBOX_IDENTITY_FILES.includes("shell/server/lib/builderV2/controlIdentity.mjs"),
    "the verifier's shared semantic vocabulary decides verdicts too");
  assert.ok(SANDBOX_IDENTITY_FILES.includes("build-worker/sandbox.mjs"),
    "the entrypoint that chooses which verifier to call");
});

test("this checkout can compute its own identity", async () => {
  const identity = await computeSandboxIdentity({ root: ROOT, commit: "test" });
  assert.match(identity.identity, /^[0-9a-f]{64}$/);
  assert.match(identity.verifier, /^[0-9a-f]{64}$/);
  for (const relative of SANDBOX_IDENTITY_FILES) {
    assert.notEqual(identity.files[relative], "absent", `${relative} must exist in the checkout`);
  }
});

test("identical trees are compatible", async () => {
  const a = await fixtureTree();
  const b = await fixtureTree();
  try {
    const report = compareSandboxIdentity(
      await computeSandboxIdentity({ root: a }), await computeSandboxIdentity({ root: b }),
    );
    assert.equal(report.compatible, true, JSON.stringify(report.mismatches));
    assert.equal(report.code, null);
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("a stale verifier in the sandbox is sandbox_version_mismatch, naming the file", async () => {
  const host = await fixtureTree();
  // Exactly the incident: one file behind, everything else identical.
  const sandbox = await fixtureTree({ [VERIFIER_PATH]: "the b45a327 verifier\n" });
  try {
    const report = compareSandboxIdentity(
      await computeSandboxIdentity({ root: host, commit: "new" }),
      await computeSandboxIdentity({ root: sandbox, commit: "b45a327" }),
    );
    assert.equal(report.compatible, false);
    assert.equal(report.code, "sandbox_version_mismatch");
    assert.deepEqual(report.mismatches.map((row) => row.file), [VERIFIER_PATH]);
    assert.match(report.detail, /different verdict-deciding code/);
    assert.notEqual(report.hostVerifier, report.sandboxVerifier);
    assert.match(sandboxSkewSummary(report), /INCOMPATIBLE \(sandbox_version_mismatch\)/);
  } finally {
    await rm(host, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("an image that cannot say what it is counts as incompatible, not as fine", async () => {
  const host = await fixtureTree();
  try {
    const report = compareSandboxIdentity(await computeSandboxIdentity({ root: host }), {});
    assert.equal(report.compatible, false);
    assert.equal(report.code, "sandbox_version_mismatch");
    assert.match(report.detail, /predates provenance reporting/);
  } finally {
    await rm(host, { recursive: true, force: true });
  }
});

test("line endings are a deployment artefact, not a behavioural difference", async () => {
  const lf = await fixtureTree({ [VERIFIER_PATH]: "line one\nline two\n" });
  const crlf = await fixtureTree({ [VERIFIER_PATH]: "line one\r\nline two\r\n" });
  try {
    const report = compareSandboxIdentity(
      await computeSandboxIdentity({ root: lf }), await computeSandboxIdentity({ root: crlf }),
    );
    assert.equal(report.compatible, true,
      "a Windows checkout deployed to Linux must not read as a stale sandbox");
  } finally {
    await rm(lf, { recursive: true, force: true });
    await rm(crlf, { recursive: true, force: true });
  }
});

test("a missing file is reported, never silently equal", async () => {
  const host = await fixtureTree();
  const sandbox = await fixtureTree();
  await rm(path.join(sandbox, VERIFIER_PATH));
  try {
    const report = compareSandboxIdentity(
      await computeSandboxIdentity({ root: host }), await computeSandboxIdentity({ root: sandbox }),
    );
    assert.equal(report.compatible, false);
    assert.equal(report.mismatches[0].sandbox, "absent");
  } finally {
    await rm(host, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("absent provenance reads as null rather than throwing", async () => {
  const dir = await fixtureTree();
  try {
    assert.equal(await readBakedProvenance(dir), null);
    await writeFile(path.join(dir, PROVENANCE_FILENAME), JSON.stringify({ identity: "x" }), "utf8");
    assert.deepEqual(await readBakedProvenance(dir), { identity: "x" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── the wiring: the guard has to be in the path a build actually takes ────────────────────────

test("the sandbox entrypoint answers the provenance job", async () => {
  const source = await readFile(path.join(ROOT, "build-worker", "sandbox.mjs"), "utf8");
  assert.match(source, /jobType === "sandbox_provenance"/);
  assert.match(source, /bakedConsistent/, "a tampered image must not be believed");
});

test("the image bakes its own provenance at build time", async () => {
  const dockerfile = await readFile(path.join(ROOT, "build-worker", "Dockerfile"), "utf8");
  assert.match(dockerfile, /ARG SOURCE_COMMIT/);
  assert.match(dockerfile, /sandbox-provenance\.json/);
  assert.match(dockerfile, /computeSandboxIdentity/);
});

test("the pipeline proves compatibility BEFORE the contract call", async () => {
  const source = await readFile(path.join(ROOT, "shell", "server", "lib", "builderV2",
    "runtimeComposition.mjs"), "utf8");
  const gate = source.indexOf("await ensureSandboxCompatible(workJob)");
  // runBuild is where the orchestrator makes its first model call (the contract stage).
  const dispatch = source.indexOf("orchestrator.runBuild");
  assert.ok(gate > 0, "the gate exists");
  assert.ok(dispatch > 0 && gate < dispatch,
    "a stale sandbox must end the job at zero credits, not after the contract call");
  assert.match(source, /code: report\.code/);
  // And it must be the sandbox that answers, not a file read on the host.
  assert.match(source, /job_type: "sandbox_provenance"/);
});

test("the provenance job has a resource budget of its own", async () => {
  const { jobResourceLimits } = await import("../../shell/server/lib/buildWorkQueue.mjs");
  const limits = jobResourceLimits ? jobResourceLimits("sandbox_provenance") : null;
  const source = await readFile(path.join(ROOT, "shell", "server", "lib", "buildWorkQueue.mjs"), "utf8");
  assert.match(source, /sandbox_provenance: \{/);
  if (limits) assert.ok(limits.wallSeconds <= 120, "hashing five files must not get a build-sized budget");
});

test("the deployment marker is generated from the pin, never hand-maintained", async () => {
  const source = await readFile(path.join(ROOT, "ops", "pin-build-sandbox-image.mjs"), "utf8");
  // The 2026-08-09 run recorded DEPLOYED_COMMIT=0b177e8 while the running source was 1cab2d7.
  assert.match(source, /const markerPath = path\.join\(root, "DEPLOYED_COMMIT"\)/);
  assert.match(source, /writeFile\(markerPath/, "the marker is written by the same code that pins");
  const pinBlock = source.slice(source.indexOf('if (flag("pin"))'));
  assert.ok(pinBlock.includes("writeFile(markerPath"),
    "the marker may only be written when a pin actually happened");
  // The image is built from a subset of the tree, so the record distinguishes the two commits
  // instead of claiming the image is as new as the checkout.
  assert.match(source, /sandboxImageSourceCommit: imageCommit/);
});
