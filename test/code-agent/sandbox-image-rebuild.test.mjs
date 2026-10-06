import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sandboxImageRebuildDecisionForCheckout } from "../../ops/lib/sandboxImageRebuild.mjs";
import { SANDBOX_IDENTITY_FILES } from "../../shell/server/lib/builderV2/sandboxProvenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "ops", "require-sandbox-image-rebuild.mjs");
const VERIFIER = "shell/server/lib/appBuild/journeyVerifier.mjs";
const CLOSURE_ONLY = "shell/server/lib/builderV2/executionProvenance.mjs";

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8" });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status, stdout: error.stdout?.toString() || "" };
  }
}

test("an unchanged Dockerfile still requires a rebuild when verdict-deciding files changed", async () => {
  const decision = await sandboxImageRebuildDecisionForCheckout({
    root: ROOT,
    changedPaths: ["README.md", `./${VERIFIER}`],
  });
  assert.equal(decision.rebuild, true);
  assert.equal(decision.noimageAllowed, false);
  assert.deepEqual(decision.files, [VERIFIER]);
  assert.match(decision.reason, /pass --image/);
  assert.ok(SANDBOX_IDENTITY_FILES.includes(VERIFIER));
});

test("a closure-only verdict file forces a rebuild even though the Dockerfile did not change", async () => {
  const decision = await sandboxImageRebuildDecisionForCheckout({
    root: ROOT,
    changedPaths: [CLOSURE_ONLY],
  });
  assert.equal(decision.rebuild, true);
  assert.equal(SANDBOX_IDENTITY_FILES.includes(CLOSURE_ONLY), false);
  assert.deepEqual(decision.files, [CLOSURE_ONLY]);
});

test("the Dockerfile itself forces a rebuild, and unrelated files do not", async () => {
  const dockerfile = await sandboxImageRebuildDecisionForCheckout({
    root: ROOT,
    changedPaths: ["build-worker/Dockerfile"],
  });
  assert.equal(dockerfile.rebuild, true);
  const docs = await sandboxImageRebuildDecisionForCheckout({
    root: ROOT,
    changedPaths: ["README.md", "docs/DEPLOY.md"],
  });
  assert.equal(docs.rebuild, false);
  assert.equal(docs.noimageAllowed, true);
  assert.deepEqual(docs.files, []);
});

test("the deploy helper exits 0 for noimage, 2 when a rebuild is required, and 1 when it cannot decide", () => {
  const allowed = runCli(["--paths", "README.md"]);
  assert.equal(allowed.status, 0);
  assert.equal(JSON.parse(allowed.stdout).noimageAllowed, true);

  const required = runCli(["--paths", VERIFIER]);
  assert.equal(required.status, 2);
  assert.equal(JSON.parse(required.stdout).rebuild, true);

  const dockerfile = runCli(["--paths", "build-worker/Dockerfile", "README.md"]);
  assert.equal(dockerfile.status, 2);

  const unknown = runCli([]);
  assert.equal(unknown.status, 1);
});
