// THE PACKAGED RUNTIME MUST BE THE HOST'S CODE, PROVEN BY EXECUTING THE PACKAGED ENTRYPOINT.
//
// sandbox-image-imports.test.mjs walks the static import closure against the Dockerfile's COPY set.
// That is necessary and not sufficient: the sandbox entrypoint also loads its job modules lazily
// (dynamic import inside browserVerify/qaBrowser/compile), and only running the packaged copy proves
// those resolve. This test materialises exactly the COPY set into a disposable root, links the same
// node_modules the image installs from the lockfile, and runs the real entrypoint on a
// sandbox_provenance job. The job recomputes the identity from the packaged files - it must equal
// the host's - and loads every job module the sandbox can be asked to run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { computeSandboxIdentity, SANDBOX_IDENTITY_FILES } from "../../shell/server/lib/builderV2/sandboxProvenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Development-only trees inside copied directories that a build context never contains.
const EXCLUDED = new Set(["harness/.work", "harness/.deps", "harness/.cache"]);

async function copiedRoots() {
  const dockerfile = await readFile(path.join(ROOT, "build-worker/Dockerfile"), "utf8");
  const roots = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const match = /^COPY\s+(.+?)\s+\S+\s*$/.exec(line.trim());
    if (!match) continue;
    for (const source of match[1].split(/\s+/)) roots.push(source.replace(/^\.\//, "").replace(/\/$/, ""));
  }
  return roots;
}

async function materialise(root) {
  for (const source of await copiedRoots()) {
    const from = path.join(ROOT, source);
    if (!existsSync(from)) continue;
    await cp(from, path.join(root, source), {
      recursive: true,
      filter: (entry) => {
        const relative = path.relative(ROOT, entry).split(path.sep).join("/");
        return ![...EXCLUDED].some((excluded) => relative === excluded || relative.startsWith(`${excluded}/`))
          && !/(^|\/)node_modules(\/|$)/.test(relative);
      },
    });
  }
  await symlink(path.join(ROOT, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
}

function runEntrypoint(root, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["build-worker/sandbox.mjs"], { cwd: root, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("the packaged entrypoint runs a sandbox_provenance job from the COPY set alone and reports the host's identity", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thrallo-packaged-"));
  try {
    await materialise(root);
    for (const file of SANDBOX_IDENTITY_FILES) {
      assert.ok(existsSync(path.join(root, file)), `${file} is part of the packaged copy`);
    }
    const input = path.join(root, "input", "payload.json");
    const output = path.join(root, "work", "result.json");
    await mkdir(path.dirname(input), { recursive: true });
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(input, JSON.stringify({ jobType: "sandbox_provenance", payload: {} }));
    const run = await runEntrypoint(root, {
      THRALLO_JOB_INPUT: input, THRALLO_JOB_OUTPUT: output, THRALLO_JOB_WORK: path.join(root, "work", "project"),
      THRALLO_SANDBOX_ROOT: root, SOURCE_COMMIT: "test-commit",
    });
    assert.equal(run.code, 0, `entrypoint exit ${run.code}\n${run.stderr.slice(-2000)}`);
    const result = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 600));
    const host = await computeSandboxIdentity({ root: ROOT, commit: "test-commit" });
    assert.equal(result.provenance.identity, host.identity, "the packaged verdict-deciding code is byte-identical to the host's");
    assert.equal(result.provenance.verifier, host.verifier);
    assert.equal(result.provenance.baked, false, "a disposable copy has no baked record; the live recomputation stands alone");
    // Every job module the entrypoint can be asked to run resolves inside the packaged copy.
    assert.ok(result.provenance.entrypoints, "the provenance job reports the job modules it loaded");
    const failed = Object.entries(result.provenance.entrypoints).filter(([, row]) => row.ok !== true);
    assert.deepEqual(failed, [], `job modules that do not load from the packaged copy: ${JSON.stringify(failed)}`);
    for (const name of ["browser_verify", "qa_browser", "publish_package", "sandbox_provenance"]) {
      assert.ok(result.provenance.entrypoints[name], `${name} is probed`);
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("a packaged copy missing a module the verifier imports is reported, not believed", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thrallo-packaged-broken-"));
  try {
    await materialise(root);
    await rm(path.join(root, "shell/shared"), { recursive: true, force: true });
    const input = path.join(root, "input", "payload.json");
    const output = path.join(root, "work", "result.json");
    await mkdir(path.dirname(input), { recursive: true });
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(input, JSON.stringify({ jobType: "sandbox_provenance", payload: {} }));
    const run = await runEntrypoint(root, {
      THRALLO_JOB_INPUT: input, THRALLO_JOB_OUTPUT: output, THRALLO_JOB_WORK: path.join(root, "work", "project"),
      THRALLO_SANDBOX_ROOT: root,
    });
    const result = JSON.parse(await readFile(output, "utf8"));
    const host = await computeSandboxIdentity({ root: ROOT });
    assert.notEqual(result.provenance?.identity, host.identity,
      "a truncated copy never reports the host's identity: shell/shared is in the verifier's import closure, so its absence moves the hash");
    assert.ok(Object.entries(result.provenance?.files || {}).some(([file, digest]) => file.startsWith("shell/shared/") && digest === "absent"),
      "the missing shared modules are reported as absent by name");
    const failed = Object.entries(result.provenance?.entrypoints || {}).filter(([, row]) => row.ok !== true).map(([name]) => name);
    assert.ok(failed.includes("browser_verify"), `the verifier's closure reaches shell/shared, so browser_verify must fail to load: ${JSON.stringify(result.provenance?.entrypoints)}`);
    assert.equal(run.code === 0 || run.code === 1, true);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
