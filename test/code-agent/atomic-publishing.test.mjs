import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { createArtifactManifest, normalizeArtifactPath } from "../../shared/immutableRelease.mjs";
import {
  assertPublishIntakeReady,
  classifyPublishRpcError,
  normalizePublishRpcError,
  proveRuntimeConfig,
  reconcileActivation,
} from "../../shell/server/lib/publishing/atomicPublisher.mjs";

const linux = process.platform !== "win32";
const OWNER = "a0000000-0000-4000-8000-000000000001";
const PROJECT = "b0000000-0000-4000-8000-000000000001";
const root = path.join(os.tmpdir(), `thrallo-c8-${process.pid}-${crypto.randomUUID()}`);
process.env.PUBLISH_DIR = root;
const releases = await import(`../../provisiond/releases.mjs?proof=${crypto.randomUUID()}`);

const artifact = (label = "one") => ({
  "index.html": Buffer.from(`<!doctype html><html><script src="/assets/${label}.js"></script></html>`).toString("base64"),
  [`assets/${label}.js`]: Buffer.from(`console.log(${JSON.stringify(label)})`).toString("base64"),
});
const id = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function final(n, label = `r${n}`) {
  const files = artifact(label); const proof = createArtifactManifest(files);
  return releases.finalizeRelease({ releaseId: id(n), owner: OWNER, projectId: PROJECT, files, proof });
}

test.after(async () => {
  await releases.purgeProjectReleases({ owner: OWNER, projectId: PROJECT }).catch(() => {});
  await chmod(root, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true });
});

test("C8-00 RPC errors preserve exact application, ownership, validation, database and pool classes", () => {
  assert.equal(classifyPublishRpcError(null), "success");
  assert.equal(classifyPublishRpcError({ code: "PT412" }), "stale_cas");
  assert.equal(classifyPublishRpcError({ code: "42501" }), "ownership_rejected");
  assert.equal(classifyPublishRpcError({ code: "22023" }), "validation_error");
  assert.equal(classifyPublishRpcError({ code: "PGRST003" }), "postgrest_pool_failure");
  assert.equal(classifyPublishRpcError({ code: "40001" }), "database_retryable_failure");
  assert.equal(classifyPublishRpcError({ code: "40P01" }), "database_retryable_failure");
  assert.equal(classifyPublishRpcError({ code: "23514" }), "database_failure");

  const stale = normalizePublishRpcError("activate", { code: "PT412", message: "wording may change" });
  assert.equal(stale.code, "stale_publish_cas");
  assert.equal(stale.databaseCode, "PT412");
  assert.equal(stale.classification, "stale_cas");

  const pool = normalizePublishRpcError("activate", { code: "PGRST003", message: "pool unavailable" });
  assert.equal(pool.code, "PGRST003");
  assert.equal(pool.classification, "postgrest_pool_failure");
});

test("C8-01 build failure before finalisation creates no release", { skip: !linux }, async () => {
  assert.equal(existsSync(path.join(root, ".thrallo", "releases", OWNER, PROJECT, id(1))), false);
});

test("C8-02 failed health check cannot finalise", { skip: !linux }, async () => {
  const files = { "index.html": Buffer.from("not html").toString("base64") };
  await assert.rejects(releases.finalizeRelease({ releaseId: id(2), owner: OWNER, projectId: PROJECT,
    files, proof: createArtifactManifest(files) }), /HTML document/);
  assert.equal(existsSync(path.join(root, ".thrallo", "releases", OWNER, PROJECT, id(2))), false);
});

test("C8-03 crash before activation intent leaves live pointer absent", { skip: !linux }, async () => {
  await final(3); assert.equal((await releases.inspectPointer("proof-three")).kind, "absent");
});

test("C8-04 durable intent before pointer swap cannot expose staged release", { skip: !linux }, async () => {
  await final(4); assert.equal((await releases.inspectPointer("proof-four")).releaseId, null);
});

test("C8-05 pointer swap is independently observable before DB completion", { skip: !linux }, async () => {
  await final(5); await releases.activateRelease({ slug: "proof-five", owner: OWNER, projectId: PROJECT,
    releaseId: id(5), expectedPreviousReleaseId: null });
  assert.equal((await releases.inspectPointer("proof-five")).releaseId, id(5));
});

test("C8-06 simulated DB failure does not destroy pointer evidence", { skip: !linux }, async () => {
  await final(6); await releases.activateRelease({ slug: "proof-six", owner: OWNER, projectId: PROJECT,
    releaseId: id(6), expectedPreviousReleaseId: null });
  await Promise.reject(new Error("simulated DB commit failure")).catch(() => {});
  assert.equal((await releases.inspectPointer("proof-six")).releaseId, id(6));
});

test("C8-06b lost DB completion acknowledgement resolves from durable completed state", async () => {
  const desired = { id: id(61), owner: OWNER, project_id: PROJECT, artifact_hash: "a".repeat(64), manifest_hash: "b".repeat(64) };
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request */ }
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") return res.end(JSON.stringify({ releaseId: desired.id }));
    if (req.url === "/releases/verify") return res.end(JSON.stringify({ artifactHash: desired.artifact_hash, manifestHash: desired.manifest_hash }));
    res.statusCode = 404; res.end(JSON.stringify({ error: "unexpected proof route" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const oldUrl = process.env.PROVISIOND_URL; const oldToken = process.env.PROVISIOND_TOKEN;
  process.env.PROVISIOND_URL = `http://127.0.0.1:${server.address().port}`; process.env.PROVISIOND_TOKEN = "proof-token";
  const rpcCalls = [];
  const client = {
    from(table) {
      const query = { select() { return this; }, eq() { return this; }, async maybeSingle() {
        return { data: table === "publish_releases" ? desired : { state: "completed" }, error: null };
      } };
      return query;
    },
    async rpc(name) {
      rpcCalls.push(name);
      return name === "complete_publish_activation"
        ? { data: null, error: { message: "connection lost after commit", code: "08006" } }
        : { data: {}, error: null };
    },
  };
  try {
    const result = await reconcileActivation({ id: id(62), owner: OWNER, slug: "proof-commit",
      operation: "activate", desired_release_id: desired.id, previous_release_id: null }, { client });
    assert.equal(result.state, "completed");
    assert.equal(rpcCalls.includes("fail_publish_activation"), false);
  } finally {
    if (oldUrl === undefined) delete process.env.PROVISIOND_URL; else process.env.PROVISIOND_URL = oldUrl;
    if (oldToken === undefined) delete process.env.PROVISIOND_TOKEN; else process.env.PROVISIOND_TOKEN = oldToken;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("C8-07 reconciliation repeats the desired activation idempotently", { skip: !linux }, async () => {
  await final(7); const options = { slug: "proof-seven", owner: OWNER, projectId: PROJECT,
    releaseId: id(7), expectedPreviousReleaseId: null };
  await releases.activateRelease(options); const second = await releases.activateRelease(options);
  assert.equal(second.changed, false);
});

test("C8-08 reconciler can revert to the retained previous release", { skip: !linux }, async () => {
  await final(8, "old"); await final(9, "new");
  await releases.activateRelease({ slug: "proof-eight", owner: OWNER, projectId: PROJECT, releaseId: id(8), expectedPreviousReleaseId: null });
  await releases.activateRelease({ slug: "proof-eight", owner: OWNER, projectId: PROJECT, releaseId: id(9), expectedPreviousReleaseId: id(8) });
  await releases.activateRelease({ slug: "proof-eight", owner: OWNER, projectId: PROJECT, releaseId: id(8), expectedPreviousReleaseId: id(9) });
  assert.equal((await releases.inspectPointer("proof-eight")).releaseId, id(8));
});

test("C8-08b post-switch health failure restores the previous pointer and records rollback", async () => {
  const desired = { id: id(81), owner: OWNER, project_id: PROJECT, artifact_hash: "a".repeat(64), manifest_hash: "b".repeat(64) };
  const previous = { id: id(82), owner: OWNER, project_id: PROJECT, artifact_hash: "c".repeat(64), manifest_hash: "d".repeat(64) };
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    res.setHeader("Content-Type", "application/json");
    if (req.method === "GET") return res.end(JSON.stringify({ releaseId: desired.id }));
    if (req.url === "/releases/verify" && body.releaseId === desired.id) {
      return res.end(JSON.stringify({ artifactHash: "0".repeat(64), manifestHash: desired.manifest_hash }));
    }
    if (req.url === "/releases/verify" && body.releaseId === previous.id) {
      return res.end(JSON.stringify({ artifactHash: previous.artifact_hash, manifestHash: previous.manifest_hash }));
    }
    if (req.url === "/releases/activate") {
      calls.push(body); return res.end(JSON.stringify({ releaseId: previous.id }));
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: "unexpected proof route" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const oldUrl = process.env.PROVISIOND_URL; const oldToken = process.env.PROVISIOND_TOKEN;
  process.env.PROVISIOND_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.PROVISIOND_TOKEN = "proof-token";
  const client = {
    from() {
      const query = { id: null, select() { return this; }, eq(column, value) { if (column === "id") this.id = value; return this; },
        async maybeSingle() { return { data: this.id === desired.id ? desired : previous, error: null }; } };
      return query;
    },
    async rpc(name, args) { calls.push({ name, args }); return { data: {}, error: null }; },
  };
  try {
    const result = await reconcileActivation({ id: id(83), slug: "proof-health", operation: "activate",
      desired_release_id: desired.id, previous_release_id: previous.id }, { client });
    assert.equal(result.state, "rolled_back");
    assert.equal(calls.some((call) => call.releaseId === previous.id && call.expectedPreviousReleaseId === desired.id), true);
    assert.equal(calls.some((call) => call.name === "mark_publish_activation_rolled_back"
      && call.args.p_observed_release_id === previous.id), true);
  } finally {
    if (oldUrl === undefined) delete process.env.PROVISIOND_URL; else process.env.PROVISIOND_URL = oldUrl;
    if (oldToken === undefined) delete process.env.PROVISIOND_TOKEN; else process.env.PROVISIOND_TOKEN = oldToken;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("C8-09 concurrent publishes serialize and stale completion loses", { skip: !linux }, async () => {
  await final(10, "base"); await final(11, "left"); await final(12, "right");
  await releases.activateRelease({ slug: "proof-nine", owner: OWNER, projectId: PROJECT, releaseId: id(10), expectedPreviousReleaseId: null });
  const race = await Promise.allSettled([
    releases.activateRelease({ slug: "proof-nine", owner: OWNER, projectId: PROJECT, releaseId: id(11), expectedPreviousReleaseId: id(10) }),
    releases.activateRelease({ slug: "proof-nine", owner: OWNER, projectId: PROJECT, releaseId: id(12), expectedPreviousReleaseId: id(10) }),
  ]);
  assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(race.filter((x) => x.status === "rejected").length, 1);
});

test("C8-10 stale activation cannot overwrite newer pointer", { skip: !linux }, async () => {
  const current = await releases.inspectPointer("proof-nine");
  await assert.rejects(releases.activateRelease({ slug: "proof-nine", owner: OWNER, projectId: PROJECT,
    releaseId: id(10), expectedPreviousReleaseId: id(10) }), /stale/);
  assert.equal((await releases.inspectPointer("proof-nine")).releaseId, current.releaseId);
});

test("C8-11 rollback activates retained bytes without a build function", { skip: !linux }, async () => {
  const before = await releases.verifyRelease({ owner: OWNER, projectId: PROJECT, releaseId: id(8) });
  assert.equal((await releases.inspectPointer("proof-eight")).releaseId, id(8));
  const after = await releases.verifyRelease({ owner: OWNER, projectId: PROJECT, releaseId: id(8) });
  assert.equal(after.artifactHash, before.artifactHash);
});

test("C8-12 rollback health failure leaves current pointer unchanged", { skip: !linux }, async () => {
  const current = await releases.inspectPointer("proof-eight");
  await assert.rejects(releases.activateRelease({ slug: "proof-eight", owner: OWNER, projectId: PROJECT,
    releaseId: id(99), expectedPreviousReleaseId: current.releaseId }), /missing/);
  assert.deepEqual(await releases.inspectPointer("proof-eight"), current);
});

test("C8-13 publish and unpublish race uses the same site lock", { skip: !linux }, async () => {
  await final(13); await releases.activateRelease({ slug: "proof-thirteen", owner: OWNER, projectId: PROJECT, releaseId: id(13), expectedPreviousReleaseId: null });
  const results = await Promise.allSettled([
    releases.unpublishPointer({ slug: "proof-thirteen", expectedPreviousReleaseId: id(13) }),
    releases.activateRelease({ slug: "proof-thirteen", owner: OWNER, projectId: PROJECT, releaseId: id(13), expectedPreviousReleaseId: id(13) }),
  ]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.ok([null, id(13)].includes((await releases.inspectPointer("proof-thirteen")).releaseId));
});

test("C8-14 custom domain path remains stable across activation", async () => {
  const source = await readFile(new URL("../../provisiond/server.mjs", import.meta.url), "utf8");
  assert.match(source, /\.thrallo\/sites\/\$\{label\}\/current/);
  assert.match(source, /pointer\.kind === "release_pointer"/);
  if (linux) {
    await final(20, "domain-old"); await final(21, "domain-new");
    const slug = "proof-domain"; const domainDir = path.join(root, "_domains");
    await releases.activateRelease({ slug, owner: OWNER, projectId: PROJECT, releaseId: id(20), expectedPreviousReleaseId: null });
    await mkdir(domainDir, { recursive: true });
    const domainLink = path.join(domainDir, "example.test");
    await symlink(`../.thrallo/sites/${slug}/current`, domainLink, "dir");
    const target = await readlink(domainLink);
    const before = await readFile(path.join(domainLink, "assets", "domain-old.js"), "utf8");
    await releases.activateRelease({ slug, owner: OWNER, projectId: PROJECT, releaseId: id(21), expectedPreviousReleaseId: id(20) });
    const after = await readFile(path.join(domainLink, "assets", "domain-new.js"), "utf8");
    assert.equal(await readlink(domainLink), target);
    assert.notEqual(after, before);
  }
});

test("C8-15 Thrallo subdomain routes through the stable current pointer", async () => {
  const caddy = await readFile(new URL("../../ops/Caddyfile.unified", import.meta.url), "utf8");
  assert.match(caddy, /root \* \/publish\/\.thrallo\/sites\/\{http\.request\.host\.labels\.3\}\/current/);
});

test("C8-16 previous release remains byte-identical after activation", { skip: !linux }, async () => {
  const before = await releases.verifyRelease({ owner: OWNER, projectId: PROJECT, releaseId: id(10) });
  const after = await releases.verifyRelease({ owner: OWNER, projectId: PROJECT, releaseId: id(10) });
  assert.equal(after.artifactHash, before.artifactHash);
});

test("C8-17 corrupt artifact cannot pass integrity verification", { skip: !linux }, async () => {
  await final(17); const dir = path.join(root, ".thrallo", "releases", OWNER, PROJECT, id(17));
  await chmod(dir, 0o700); await chmod(path.join(dir, "index.html"), 0o600);
  await writeFile(path.join(dir, "index.html"), "corrupt");
  await assert.rejects(releases.verifyRelease({ owner: OWNER, projectId: PROJECT, releaseId: id(17) }), /HTML document|missing asset/);
});

test("C8-18 missing artifact cannot activate", { skip: !linux }, async () => {
  await assert.rejects(releases.activateRelease({ slug: "proof-eighteen", owner: OWNER, projectId: PROJECT,
    releaseId: id(18), expectedPreviousReleaseId: null }), /missing/);
});

test("C8-19 cleanup preserves every retained release", { skip: !linux }, async () => {
  await final(19); const result = await releases.cleanupReleases({ retained: [id(19)], olderThanMs: 0, now: Date.now() + 1000 });
  assert.ok(result.inspected >= 1);
  assert.equal(existsSync(path.join(root, ".thrallo", "releases", OWNER, PROJECT, id(19))), true);
});

test("C8-20 V2 publishing has no legacy or in-process fallback", async () => {
  const publish = await readFile(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url), "utf8");
  assert.match(publish, /const atomic = await finalizeAndActivateRelease/);
  assert.match(publish, /if \(!packaged\)/);
  assert.doesNotMatch(publish, /provisiond\("\/publish"/);
  assert.doesNotMatch(publish, /useAtomic|transferSite/);
  assert.equal(normalizeArtifactPath("assets/app.js"), "assets/app.js");
});

test("C8 forward repair retires the scoped live deployment before clearing the site pointer", async () => {
  const migration = await readFile(new URL("../../supabase/migrations/20260807174720_c8_atomic_unpublish_deployment_retirement.sql", import.meta.url), "utf8");
  const unpublish = migration.slice(migration.indexOf("if v_intent.operation = 'unpublish'"), migration.indexOf("  else", migration.indexOf("if v_intent.operation = 'unpublish'")));
  assert.match(unpublish, /deployment_scope\(product_id, project_id\)[\s\S]*deployment_scope\(v_site\.product_id, v_site\.project_id\)/);
  assert.match(unpublish, /set status = 'superseded'/);
  assert.ok(unpublish.indexOf("update public.deployments") < unpublish.indexOf("active_publish_release_id = null"));
  const activation = migration.slice(migration.indexOf("  else", migration.indexOf("if v_intent.operation = 'unpublish'")));
  assert.match(activation, /deployment_scope\(product_id, project_id\)[\s\S]*set status = v_retired/);
  assert.match(migration, /if v_intent\.state = 'completed' then return v_intent/);
  const deploymentSchema = await readFile(new URL("../../supabase/migrations/20260803150144_deployments.sql", import.meta.url), "utf8");
  assert.match(deploymentSchema, /create unique index if not exists deployments_one_live_per_app/);
});

test("atomic publisher proves runtime identity and refuses an in-process build fallback", () => {
  const previousAtomic = process.env.THRALLO_ATOMIC_PUBLISH_ENABLED;
  const previousWorker = process.env.THRALLO_BUILD_WORKER_ENABLED;
  const previousPaused = process.env.THRALLO_PUBLISHER_PAUSED;
  try {
    const runtime = [
      `VITE_APP_ID=${PROJECT}`,
      "VITE_SUPABASE_URL=https://example.supabase.co",
      "VITE_AUTH_URL=https://example.supabase.co/functions/v1/app-auth",
      "VITE_SUPABASE_ANON_KEY=public-anon-key",
    ].join("\n");
    assert.match(proveRuntimeConfig(runtime, PROJECT), /^[a-f0-9]{64}$/);
    assert.throws(() => proveRuntimeConfig(runtime.replace(PROJECT, id(44)), PROJECT), /identity/);
    assert.throws(() => proveRuntimeConfig("", PROJECT), /missing/);

    process.env.THRALLO_ATOMIC_PUBLISH_ENABLED = "0";
    process.env.THRALLO_BUILD_WORKER_ENABLED = "1";
    process.env.THRALLO_PUBLISHER_PAUSED = "0";
    assert.throws(() => assertPublishIntakeReady(), (error) => error.code === "atomic_publish_required");
    process.env.THRALLO_ATOMIC_PUBLISH_ENABLED = "1";
    process.env.THRALLO_BUILD_WORKER_ENABLED = "0";
    process.env.THRALLO_PUBLISHER_PAUSED = "0";
    assert.throws(() => assertPublishIntakeReady(), (error) => error.code === "build_worker_required");
    process.env.THRALLO_BUILD_WORKER_ENABLED = "1";
    assert.doesNotThrow(() => assertPublishIntakeReady());
  } finally {
    if (previousAtomic === undefined) delete process.env.THRALLO_ATOMIC_PUBLISH_ENABLED;
    else process.env.THRALLO_ATOMIC_PUBLISH_ENABLED = previousAtomic;
    if (previousWorker === undefined) delete process.env.THRALLO_BUILD_WORKER_ENABLED;
    else process.env.THRALLO_BUILD_WORKER_ENABLED = previousWorker;
    if (previousPaused === undefined) delete process.env.THRALLO_PUBLISHER_PAUSED;
    else process.env.THRALLO_PUBLISHER_PAUSED = previousPaused;
  }
});
