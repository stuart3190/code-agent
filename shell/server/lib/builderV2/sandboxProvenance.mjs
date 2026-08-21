// Identity of the code that actually grades a build, on both sides of the sandbox boundary.
//
// Browser verification does not run this checkout. The worker ships the job into a Docker image
// pinned by digest, and that image carries its OWN copy of the verifier. On 2026-08-10 the pin
// was three days stale: every live qualification since 2026-08-07 was graded by journeyVerifier
// from commit b45a327, while four later fixes sat in the repository looking deployed. Nothing
// reported the skew — the build simply produced a confident, wrong verdict, after full model
// spend. See docs/evidence/builder-v2-runtime/2026-08-10/PACKAGE-14S-VERIFIER-PROVENANCE.md.
//
// This module is the single definition of "which code decides a verdict", used to compute that
// identity on the host and inside the image with the same function, so the two can be compared
// before a single token is spent.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The files whose contents change what a build verdict IS. Not every file in the image — a
 * drifting comment in an unrelated module must not block a qualification — but every file that
 * can silently turn a red journey green or a green one red.
 */
export const SANDBOX_IDENTITY_FILES = Object.freeze([
  "build-worker/sandbox.mjs",
  "shell/server/lib/appBuild/journeyVerifier.mjs",
  "shell/server/lib/appBuild/verificationAgent.mjs",
  // Stable, server-sealed verifier accounts and platform app-auth failure classification are
  // verdict-deciding. A stale image that still creates a new account per round will hit the auth
  // cap and turn otherwise-correct application journeys red.
  "shell/server/lib/appBuild/verificationIdentity.mjs",
  "shell/server/lib/builderV2/controlIdentity.mjs",
  "src/scaffolds/reactVite.mjs",
  // reactVite.mjs imports this catalogue to build package.json. A stale sandbox catalogue means
  // the host may approve a specialist runtime that the offline compiler does not actually have.
  "src/scaffolds/dependencyCatalog.mjs",
  // reactVite.mjs READS the scaffold's sources at import, so its own bytes never move when they
  // change. This file emits the machine identity the verifier now targets: if the host and the
  // image disagreed about it, every contracted control would be addressed by an id the generated
  // app never wrote, and the skew guard would have called that pair compatible.
  "src/scaffolds/reactVite/lib/capabilities/react.js",
  "src/scaffolds/reactVite/lib/capabilities/crud.js",
  "src/scaffolds/reactVite/lib/capabilities/session.js",
  "src/scaffolds/reactVite/lib/capabilities/roles.js",
  "src/scaffolds/reactVite/lib/capabilities/booking.js",
  "src/scaffolds/reactVite/lib/capabilities/forms.js",
  // Wizard mutations decide whether controlled values remain observable while durable persistence
  // is in flight. A stale image/scaffold pairing can therefore turn a driveable field into a red
  // journey even when the verifier itself is current.
  "src/scaffolds/reactVite/lib/capabilities/wizard.js",
  // …and its export barrel: a stale one turns a new binding into an unresolved import at compile
  // time. The brief belongs here for the mirror-image reason — an image whose prompt never teaches
  // the forward control produces apps the new verifier correctly calls undriveable.
  "src/scaffolds/reactVite/lib/capabilities/index.js",
  "shell/server/lib/builderV2/capabilityRegistry.mjs",
  "shell/server/lib/builderV2/capabilityGraph.mjs",
  "shell/server/lib/builderV2/capabilityComposer.mjs",
  "shell/server/lib/builderV2/buildSpec.mjs",
  "shell/server/lib/builderV2/moduleContracts.mjs",
  // WHICH controls a step drives is as verdict-deciding as how they are driven. A paid run failed
  // because the derivation contracted a control the step only referenced; fixing it moved no hash
  // in this list, so an image carrying the old derivation would have been reported compatible with
  // a host carrying the new one. These four decide what the browser is asked to do at all.
  "shell/server/lib/builderV2/interactionContract.mjs",
  "shell/server/lib/builderV2/verificationManifest.mjs",
  "shell/server/lib/builderV2/actionIntent.mjs",
  "shell/server/lib/builderV2/lifecycleOperations.mjs",
]);

/** The one whose staleness caused the incident, reported by name in every skew message. */
export const VERIFIER_PATH = "shell/server/lib/appBuild/journeyVerifier.mjs";

export const PROVENANCE_FILENAME = "sandbox-provenance.json";

// Line endings are a deployment artefact, not a behavioural one: the same commit checked out on
// Windows and copied to Linux must produce the same identity, or the guard cries wolf on every
// deploy and gets switched off.
const hash = (text) => createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");

/**
 * Hash every verdict-deciding file under `root`. A missing file is recorded as `absent:` rather
 * than throwing, so an image built from a truncated context is reported as incompatible instead
 * of crashing the check that exists to catch exactly that.
 */
export async function computeSandboxIdentity({ root = process.cwd(), commit = null } = {}) {
  const files = {};
  for (const relative of SANDBOX_IDENTITY_FILES) {
    files[relative] = await readFile(path.join(root, relative), "utf8")
      .then((text) => hash(text)).catch(() => "absent");
  }
  const identity = hash(SANDBOX_IDENTITY_FILES.map((name) => `${name}:${files[name]}`).join("\n"));
  return { identity, commit: commit || null, verifier: files[VERIFIER_PATH], files };
}

/** Resolve the deployed host revision without trusting a short, malformed or absent marker. */
export async function readDeploymentCommit({ root = process.cwd(), env = process.env } = {}) {
  const configured = String(env?.THRALLO_DEPLOY_COMMIT || "").trim().toLowerCase();
  if (/^[0-9a-f]{40}$/.test(configured)) return configured;
  const marker = await readFile(path.join(root, "DEPLOYED_COMMIT"), "utf8")
    .then((value) => String(value).trim().toLowerCase()).catch(() => "");
  return /^[0-9a-f]{40}$/.test(marker) ? marker : null;
}

/** The provenance baked into an image at build time, or null when it predates this mechanism. */
export async function readBakedProvenance(root = process.cwd()) {
  return readFile(path.join(root, PROVENANCE_FILENAME), "utf8")
    .then((text) => JSON.parse(text)).catch(() => null);
}

/**
 * Is the sandbox running the same verdict-deciding code as this host?
 *
 * Returns a machine-readable result rather than throwing, so callers decide where the failure
 * belongs. `code` is `sandbox_version_mismatch` for any incompatibility, including a sandbox too
 * old to report an identity at all — an image that cannot say what it is has to be treated as
 * unknown, which is precisely the state that produced the incident.
 */
export function compareSandboxIdentity(host, sandbox) {
  const report = {
    compatible: false,
    code: "sandbox_version_mismatch",
    hostIdentity: host?.identity || null,
    sandboxIdentity: sandbox?.identity || null,
    hostVerifier: host?.verifier || null,
    sandboxVerifier: sandbox?.verifier || null,
    hostCommit: host?.commit || null,
    sandboxCommit: sandbox?.commit || null,
    imageDigest: sandbox?.imageDigest || null,
    mismatches: [],
  };
  if (!sandbox?.identity) {
    report.mismatches.push({ file: "*", reason: "the sandbox reported no provenance" });
    report.detail = "the sandbox image predates provenance reporting and cannot be trusted to grade a build";
    return report;
  }
  for (const relative of SANDBOX_IDENTITY_FILES) {
    const expected = host?.files?.[relative];
    const actual = sandbox?.files?.[relative];
    if (expected !== actual) report.mismatches.push({ file: relative, host: expected || null, sandbox: actual || null });
  }
  if (report.mismatches.length) {
    const names = report.mismatches.map((row) => row.file);
    report.detail = `the sandbox image is running different verdict-deciding code (${names.join(", ")})`;
    return report;
  }
  return { ...report, compatible: true, code: null, detail: "host and sandbox agree on every verdict-deciding file" };
}

/** One line for a log or a preflight table. */
export function sandboxSkewSummary(report) {
  return [
    `host verifier ${String(report.hostVerifier).slice(0, 16)}`,
    `sandbox verifier ${String(report.sandboxVerifier).slice(0, 16)}`,
    `image ${report.imageDigest || "unknown"}`,
    report.compatible ? "compatible" : `INCOMPATIBLE (${report.code})`,
  ].join(" · ");
}
