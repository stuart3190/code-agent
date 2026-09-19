// Prove which code the build sandbox will actually grade with — zero model calls, zero writes.
//
// Runs the provenance probe through the REAL sandbox runner, so it answers for the image the
// worker will really use rather than for a file someone hopes is deployed. Prints a
// machine-readable report and exits non-zero on skew.
//
//   node ops/prove-sandbox-provenance.mjs
//   THRALLO_BUILD_SANDBOX=docker THRALLO_BUILD_SANDBOX_IMAGE=<digest> node ops/prove-sandbox-provenance.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runSandboxJob } from "../build-worker/sandboxRunner.mjs";
import {
  compareSandboxIdentity, computeSandboxIdentity, sandboxSkewSummary,
} from "../shell/server/lib/builderV2/sandboxProvenance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.THRALLO_BUILD_SANDBOX_IMAGE || "thrallo-build-sandbox:latest";

const host = await computeSandboxIdentity({ root });
const outcome = await runSandboxJob({
  id: `provenance-${Date.now().toString(36)}`, job_type: "sandbox_provenance", attempts: 1,
  payload: {}, resource_limits: { wallSeconds: 60, cpu: 1, memoryMb: 512, pids: 64, outputBytes: 256 * 1024 },
}, {});

const report = compareSandboxIdentity(host, { ...(outcome?.provenance || {}), imageDigest: image });
console.log(JSON.stringify({
  ...report,
  sandboxBuiltAt: outcome?.provenance?.builtAt || null,
  sandboxBaked: outcome?.provenance?.baked ?? null,
  sandboxBakedConsistent: outcome?.provenance?.bakedConsistent ?? null,
  hostFiles: host.files,
  sandboxFiles: outcome?.provenance?.files || null,
  summary: sandboxSkewSummary(report),
}, null, 2));

if (!report.compatible) process.exitCode = 1;
