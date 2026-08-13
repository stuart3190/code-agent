import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APPROVED_V1_PROJECT_IDS,
  EXECUTE_CONFIRMATION,
  assertApprovedInventory,
  assertNoActiveJobs,
  canonicalJson,
  parseRetirementArgs,
  retireApprovedV1Projects,
  sha256,
  writeEvidenceBundle,
} from "../../ops/retire-v1-projects.mjs";

const projects = () => APPROVED_V1_PROJECT_IDS.map((id, index) => ({
  id, owner: `owner-${index}`, builder_version: "v1", tree: { [`src/${index}.js`]: `source-${index}` },
}));

test("the retirement inventory is the exact approved 11 full UUIDs", () => {
  assert.equal(APPROVED_V1_PROJECT_IDS.length, 11);
  assert.equal(new Set(APPROVED_V1_PROJECT_IDS).size, 11);
  for (const id of APPROVED_V1_PROJECT_IDS) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  assert.equal(assertApprovedInventory(projects()).length, 11);
});

test("argument parsing is dry-run by default and destructive mode needs the typed phrase", () => {
  assert.deepEqual(parseRetirementArgs([]), {
    execute: false, confirmation: null, evidenceDir: null, help: false,
  });
  assert.throws(() => parseRetirementArgs(["--execute"]), /requires --confirm/);
  assert.throws(() => parseRetirementArgs(["--execute", "--confirm", "yes"]), /requires --confirm/);
  assert.throws(() => parseRetirementArgs(["--confirm", EXECUTE_CONFIRMATION]), /only valid with --execute/);
  assert.equal(parseRetirementArgs(["--execute", "--confirm", EXECUTE_CONFIRMATION]).execute, true);
});

test("inventory drift and any approved target relabelled V2 fail closed", () => {
  assert.throws(() => assertApprovedInventory(projects().slice(1)), /inventory differs/);
  assert.throws(() => assertApprovedInventory([
    ...projects(), { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", owner: "owner-x", builder_version: "v1" },
  ]), /unexpected=/);
  const changed = projects();
  changed[0] = { ...changed[0], builder_version: "v2" };
  assert.throws(() => assertApprovedInventory(changed), /target is Builder V2/);
});

test("any active execution or publish intent blocks retirement", () => {
  assert.doesNotThrow(() => assertNoActiveJobs({ build_jobs: [], build_work_jobs: [], qa_runs: [] }));
  assert.throws(() => assertNoActiveJobs({
    build_jobs: [{ id: "job-1" }], build_work_jobs: [], qa_runs: [], publish_activation_intents: [],
  }), /build_jobs=1/);
});

test("evidence is canonical, checksummed, private and refuses overwrite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "thrallo-retire-v1-"));
  await chmod(root, 0o700);
  const dir = path.join(root, "evidence");
  const result = await writeEvidenceBundle({
    projects: [{ z: 2, a: 1 }, { a: 0, z: 3 }],
    deployments: [],
  }, { evidenceDir: dir, capturedAt: "2026-08-13T00:00:00.000Z" });

  const manifest = await readFile(path.join(dir, "manifest.json"), "utf8");
  const sidecar = await readFile(path.join(dir, "manifest.sha256"), "utf8");
  const table = await readFile(path.join(dir, "tables", "projects.json"), "utf8");
  assert.equal(result.manifestSha256, sha256(manifest));
  assert.equal(sidecar, `${sha256(manifest)}  manifest.json\n`);
  assert.equal(table, canonicalJson({ table: "projects", rows: [{ a: 0, z: 3 }, { a: 1, z: 2 }] }));
  if (process.platform !== "win32") {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(dir, "manifest.json"))).mode & 0o777, 0o600);
  }
  await assert.rejects(
    writeEvidenceBundle({}, { evidenceDir: dir, capturedAt: "2026-08-13T00:00:00.000Z" }),
    /exist/i,
  );
});

test("dry-run captures evidence but never invokes any teardown or erasure", async () => {
  const calls = [];
  const result = await retireApprovedV1Projects({
    client: {}, evidenceDir: "unused", execute: false,
    inspect: async () => ({ projects: projects(), active: {} }),
    collectEvidence: async () => { calls.push("collect"); return { projects: projects() }; },
    writeEvidence: async () => { calls.push("write"); return { directory: "evidence", manifestSha256: "a".repeat(64) }; },
    takeOffline: async () => { calls.push("offline"); },
    eraseProject: async () => { calls.push("erase"); },
  });
  assert.equal(result.mode, "dry-run");
  assert.deepEqual(calls, ["collect", "write"]);
});

test("execute exports and rechecks before teardown, then uses the audited erasure seam", async () => {
  const previous = process.env.THRALLO_ERASURE_AUDIT_KEY;
  process.env.THRALLO_ERASURE_AUDIT_KEY = "test-only-not-a-production-secret";
  const calls = [];
  const one = projects().slice(0, 1);
  try {
    const result = await retireApprovedV1Projects({
      client: {}, evidenceDir: "unused", execute: true,
      provisiond: async (route) => route.startsWith("/exists") ? { exists: false } : {},
      inspect: async () => { calls.push("inspect"); return { projects: one, active: {} }; },
      collectEvidence: async () => { calls.push("collect"); return {}; },
      writeEvidence: async () => { calls.push("write"); return { directory: "evidence", manifestSha256: "b".repeat(64) }; },
      takeOffline: async ({ projectId }) => { calls.push(`offline:${projectId}`); return { slug: "site", removed: true }; },
      detach: async ({ projectId, strictExternal }) => {
        assert.equal(strictExternal, true); calls.push(`detach:${projectId}`); return { detached: [] };
      },
      buildManifest: async (_owner, projectId) => { calls.push(`manifest:${projectId}`); return { manifestSha256: "c".repeat(64) }; },
      eraseProject: async (_owner, projectId, options) => {
        assert.equal(options.approvedManifestSha256, "c".repeat(64)); calls.push(`erase:${projectId}`);
      },
      verify: async () => { calls.push("verify"); },
    });
    assert.equal(result.mode, "executed");
    assert.deepEqual(calls, [
      "inspect", "collect", "write", "inspect", `manifest:${one[0].id}`, "inspect",
      `offline:${one[0].id}`, `detach:${one[0].id}`, `erase:${one[0].id}`, "verify",
    ]);
  } finally {
    if (previous === undefined) delete process.env.THRALLO_ERASURE_AUDIT_KEY;
    else process.env.THRALLO_ERASURE_AUDIT_KEY = previous;
  }
});

test("a site that remains live aborts before domains or database rows are touched", async () => {
  const previous = process.env.THRALLO_ERASURE_AUDIT_KEY;
  process.env.THRALLO_ERASURE_AUDIT_KEY = "test-only-not-a-production-secret";
  let mutationPastUnpublish = false;
  try {
    await assert.rejects(retireApprovedV1Projects({
      client: {}, evidenceDir: "unused", execute: true, provisiond: async () => ({}),
      inspect: async () => ({ projects: projects().slice(0, 1), active: {} }),
      collectEvidence: async () => ({}),
      writeEvidence: async () => ({ directory: "evidence", manifestSha256: "d".repeat(64) }),
      buildManifest: async () => ({ manifestSha256: "e".repeat(64) }),
      takeOffline: async () => ({ slug: "still-live", removed: false }),
      detach: async () => { mutationPastUnpublish = true; },
      eraseProject: async () => { mutationPastUnpublish = true; },
    }), /teardown was not verified/);
    assert.equal(mutationPastUnpublish, false);
  } finally {
    if (previous === undefined) delete process.env.THRALLO_ERASURE_AUDIT_KEY;
    else process.env.THRALLO_ERASURE_AUDIT_KEY = previous;
  }
});
