import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSharedRateLimiter, requestRateIdentity, resolveClientNetwork, sharedRatePolicy,
} from "../../shell/server/lib/httpSecurity.mjs";
import { handleAnalyticsCollect, handleAnalyticsPreflight, validateAnalyticsOrigin } from "../../shell/server/routes/thralloAnalytics.mjs";
import {
  canonicalDeploymentIdentity, validateDeploymentIdentity,
} from "../../shell/server/lib/deploymentIdentity.mjs";
import { removeCanonicalDirectories } from "../../shell/server/lib/erasureService.mjs";
import { evaluateDrSignals } from "../../ops/dr-health.mjs";
import crypto from "node:crypto";

function limiterClient(authority) {
  return {
    rpc: async (_name, args) => {
      const key = `${args.p_route_class}:${args.p_key_hash}`;
      const now = authority.now;
      let row = authority.buckets.get(key);
      if (!row || row.started + args.p_window_seconds * 1000 <= now) row = { count: 0, started: now };
      row.count += 1; authority.buckets.set(key, row);
      return { data: [{ allowed: row.count <= args.p_limit, remaining: Math.max(0, args.p_limit - row.count),
        retry_after_seconds: 60, current_count: row.count }], error: null };
    },
  };
}

test("shared limiter survives process replacement and coordinates two shell instances", async () => {
  const authority = { buckets: new Map(), now: 1_000 };
  const request = { socket: { remoteAddress: "203.0.113.7" }, headers: {} };
  const policy = { routeClass: "security", limit: 2, networkLimit: 99, windowMs: 60_000 };
  const a = createSharedRateLimiter({ clientFactory: () => limiterClient(authority) });
  const b = createSharedRateLimiter({ clientFactory: () => limiterClient(authority) });
  assert.equal((await a(request, policy)).allowed, true);
  assert.equal((await b(request, policy)).allowed, true);
  const restarted = createSharedRateLimiter({ clientFactory: () => limiterClient(authority) });
  assert.equal((await restarted(request, policy)).allowed, false);
});

test("trusted proxies cannot be spoofed and authenticated NAT users get separate actor buckets", () => {
  const untrusted = { socket: { remoteAddress: "198.51.100.9" }, headers: { "x-forwarded-for": "1.2.3.4" } };
  assert.equal(resolveClientNetwork(untrusted, { trustedProxies: ["10.0.0.0/8"] }), "198.51.100.9");
  const proxied = { socket: { remoteAddress: "10.0.0.2" }, headers: { "x-forwarded-for": "203.0.113.8, 10.0.0.3" } };
  assert.equal(resolveClientNetwork(proxied, { trustedProxies: ["10.0.0.0/8"] }), "203.0.113.8");
  const jwt = (sub) => `x.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.x`;
  const one = requestRateIdentity({ socket: { remoteAddress: "203.0.113.8" }, headers: { authorization: `Bearer ${jwt("11111111-1111-4111-8111-111111111111")}` } });
  const two = requestRateIdentity({ socket: { remoteAddress: "203.0.113.8" }, headers: { authorization: `Bearer ${jwt("22222222-2222-4222-8222-222222222222")}` } });
  assert.notEqual(one.actor, two.actor); assert.equal(one.network, two.network);
});

test("rate policy covers PATCH and fails closed only for security-sensitive route classes", () => {
  assert.equal(sharedRatePolicy("/api/v1/runs/a", "PATCH").routeClass, "expensive");
  assert.equal(sharedRatePolicy("/api/v1/tokens/a", "PATCH").failClosed, true);
  assert.equal(sharedRatePolicy("/api/v1/preferences", "PATCH").failClosed, false);
  assert.equal(sharedRatePolicy("/api/v1/preferences", "GET"), null);
});

function analyticsClient({ site = { slug: "demo", owner: "owner", project_id: "project" }, domain = null } = {}) {
  return {
    from(table) {
      const state = { table };
      const chain = {
        select() { return chain; }, eq(column, value) { state[column] = value; return chain; },
        maybeSingle: async () => table === "published_sites" ? { data: site, error: null }
          : { data: domain && state.domain === domain ? { domain } : null, error: null },
      };
      return chain;
    },
  };
}

test("analytics origin is bound to a live Thrallo hostname or exact custom domain", async () => {
  process.env.PUBLISH_PUBLIC_SUFFIX = "app.thrallo.com";
  assert.equal((await validateAnalyticsOrigin("https://demo.app.thrallo.com", "demo", analyticsClient())).allowed, true);
  assert.equal((await validateAnalyticsOrigin("https://customer.example", "demo", analyticsClient({ domain: "customer.example" }))).kind, "custom");
  assert.equal((await validateAnalyticsOrigin("https://attacker.example", "demo", analyticsClient())).allowed, false);
  assert.equal((await validateAnalyticsOrigin("http://demo.app.thrallo.com", "demo", analyticsClient())).allowed, false);
  assert.equal((await validateAnalyticsOrigin("https://demo.app.thrallo.com:444", "demo", analyticsClient())).allowed, false);
});

function responseRecorder() {
  return { status: 0, headers: {}, body: "", writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = "") { this.body = String(body || ""); } };
}

test("public analytics accepts only a registered HTTPS origin and strict beacon media type", async () => {
  process.env.PUBLISH_PUBLIC_SUFFIX = "app.thrallo.com";
  const client = analyticsClient(); let recorded = 0;
  const ok = responseRecorder();
  await handleAnalyticsCollect({ headers: { "content-type": "text/plain;charset=utf-8", "user-agent": "proof" } }, ok,
    JSON.stringify({ appId: "demo", kind: "pageview" }), "203.0.113.9", "https://demo.app.thrallo.com",
    { client, record: async () => { recorded += 1; } });
  assert.equal(ok.status, 204); assert.equal(ok.headers["Access-Control-Allow-Origin"], "https://demo.app.thrallo.com");
  assert.equal(recorded, 1);
  const hostile = responseRecorder();
  await handleAnalyticsCollect({ headers: { "content-type": "application/json" } }, hostile, "{}", "203.0.113.9",
    "https://demo.app.thrallo.com", { client, record: async () => { throw new Error("must not record"); } });
  assert.equal(hostile.status, 415);
  const badId = responseRecorder();
  await handleAnalyticsCollect({ headers: { "content-type": "text/plain" } }, badId, JSON.stringify({ appId: "invented" }),
    "203.0.113.9", "https://demo.app.thrallo.com", { client: analyticsClient({ site: null }), record: async () => {} });
  assert.equal(badId.status, 403);
  const preflight = responseRecorder(); handleAnalyticsPreflight({}, preflight, "http://demo.app.thrallo.com");
  assert.equal(preflight.status, 403);
});

test("deployment identity is immutable, machine-readable and rejects tampering or secrets", () => {
  const value = {
    schemaVersion: 1, gitCommit: "a".repeat(40), sourceArchiveSha256: "1".repeat(64),
    webArtifactSha256: "2".repeat(64), shellArtifactSha256: "3".repeat(64),
    workerArtifactSha256: "4".repeat(64), migrationLedgerCount: 68,
    migrationLedgerSha256: "5".repeat(64), deployedAt: "2026-08-08T00:00:00.000Z",
  };
  value.manifestSha256 = crypto.createHash("sha256").update(canonicalDeploymentIdentity(value)).digest("hex");
  assert.equal(validateDeploymentIdentity(value).gitCommit, value.gitCommit);
  assert.throws(() => validateDeploymentIdentity({ ...value, migrationLedgerCount: 69 }), /hash mismatch/);
  const secret = { ...value, note: "service_role" };
  secret.manifestSha256 = crypto.createHash("sha256").update(canonicalDeploymentIdentity(secret)).digest("hex");
  assert.throws(() => validateDeploymentIdentity(secret), /secret-like/);
});

test("erasure artifact cleanup refuses symlinks and removes only bounded regular directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "thrallo-erasure-"));
  await mkdir(path.join(root, "job-a")); await writeFile(path.join(root, "job-a", "result.json"), "ok");
  assert.equal(await removeCanonicalDirectories(root, ["job-a"]), 1);
  await symlink(os.tmpdir(), path.join(root, "job-link"), "junction");
  await assert.rejects(() => removeCanonicalDirectories(root, ["job-link"]), /unexpected artifact symlink/);
  await assert.rejects(() => removeCanonicalDirectories(root, [".."]), /escapes its canonical root/);
});

test("browser logs use authenticated streaming fetch and never native EventSource or bearer query strings", async () => {
  const api = await readFile(new URL("../../shell/web/src/lib/codeAgentApi.js", import.meta.url), "utf8");
  const view = await readFile(new URL("../../shell/web/src/publish/LogsView.jsx", import.meta.url), "utf8");
  const stream = api.slice(api.indexOf("export async function streamProjectLogs"));
  assert.match(stream, /logs\/stream/);
  assert.match(stream, /Authorization: `Bearer \$\{token\}`/);
  assert.doesNotMatch(api, /new EventSource/);
  assert.doesNotMatch(api, /access_token|token=.*searchParams/);
  assert.match(view, /AbortController/); assert.match(view, /streamProjectLogs/);
});

test("DR health thresholds alert on stale recovery evidence and operational backlogs", () => {
  const current = new Date().toISOString();
  assert.deepEqual(evaluateDrSignals({ backupCompletedAt: current, restoreDrillAt: current, queueAgeMinutes: 0,
    workerHeartbeatMinutes: 0, reconciliationBacklog: 0, recentBuildFailures: 0, recentVerificationFailures: 0, postgrestHealthy: true,
    deploymentIdentityMatches: true, storageGrowthPercent: 0 }), []);
  const alerts = evaluateDrSignals({ backupCompletedAt: "2020-01-01T00:00:00Z", restoreDrillAt: "2020-01-01T00:00:00Z",
    queueAgeMinutes: 11, workerHeartbeatMinutes: 4, reconciliationBacklog: 1, recentBuildFailures: 2,
    recentVerificationFailures: 3, postgrestHealthy: false,
    deploymentIdentityMatches: false, storageGrowthPercent: 30 }).join("\n");
  for (const expected of ["backup", "restore drill", "queued build", "worker heartbeat", "publishing intents", "build jobs failed",
    "verification runs failed", "PostgREST", "deployment identity", "storage grew"]) {
    assert.match(alerts, new RegExp(expected, "i"));
  }
});

test("release and DR automation cannot deploy production and requires encrypted immutable off-host copies", async () => {
  const release = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  const offsite = await readFile(new URL("../../ops/offsite-backup.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(release, /db push --linked|supabase_apply_migration|ssh /i);
  assert.match(release, /firefox webkit/); assert.match(release, /docker build/); assert.match(release, /schema-diff/);
  assert.match(offsite, /age/); assert.match(offsite, /rclone/); assert.match(offsite, /--immutable/);
});

test("erasure and shared-rate migrations deny browser roles and keep bounded database authority", async () => {
  const erasure = await readFile(new URL("../../supabase/migrations/20260808180841_platform_erasure_audit.sql", import.meta.url), "utf8");
  const limits = await readFile(new URL("../../supabase/migrations/20260808180845_shared_atomic_rate_limits.sql", import.meta.url), "utf8");
  assert.match(erasure, /erase_project_runtime_rows\(p_owner uuid, p_project uuid\)/);
  assert.match(erasure, /delete from public\.bv2_blobs[\s\S]*not exists[\s\S]*delete from public\.bv2_snapshots/);
  assert.match(erasure, /erase_account_runtime_rows\(p_owner uuid\)/);
  assert.match(erasure, /revoke all on function public\.erase_project_runtime_rows\(uuid,uuid\) from public, anon, authenticated/);
  assert.match(erasure, /data_erasure_events_append_only/);
  assert.match(limits, /primary key \(key_hash, route_class\)/);
  assert.match(limits, /on conflict \(key_hash, route_class\) do update/);
  assert.match(limits, /revoke all on function public\.consume_http_rate_limit[^\n]+ from public, anon, authenticated/);
});

test("account erasure is manifest-gated and mounted without weakening customer routing", async () => {
  const server = await readFile(new URL("../../shell/server/index.mjs", import.meta.url), "utf8");
  const service = await readFile(new URL("../../shell/server/lib/erasureService.mjs", import.meta.url), "utf8");
  assert.match(server, /\/api\/v1\/account\/erasure-manifest/);
  assert.match(server, /p === "\/api\/v1\/account" && method === "DELETE"/);
  assert.match(server, /body\?\.confirm !== true/);
  assert.match(service, /approvedManifestSha256/);
  assert.match(service, /client\.auth\.admin\.deleteUser\(ownerId\)/);
  assert.match(service, /status: "succeeded", owner_id: null/);
});
