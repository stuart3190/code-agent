import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.PLATFORM_ENC_KEY = "11".repeat(32);

const { FEATURE_REGISTRY, disabledFeatureMatrix, evaluateFeature, rolloutBucket } = await import("../src/features/entitlements.mjs");
const { decryptSecret, encryptSecret, encryptedStorageConfigured, secretHint } = await import("../shell/server/lib/secretCrypto.mjs");

assert.equal(Object.keys(FEATURE_REGISTRY).length, 18);
assert.equal(rolloutBucket("owner-1", "test_fix"), rolloutBucket("owner-1", "test_fix"));
assert.ok(rolloutBucket("owner-1", "test_fix") >= 0 && rolloutBucket("owner-1", "test_fix") < 100);

const enabled = { enabled: true, rollout_percent: 100, config: { sample: true } };
assert.equal(evaluateFeature({ feature: "github_export", flag: enabled, ownerId: "free", tier: null }).allowed, false);
assert.equal(evaluateFeature({ feature: "github_export", flag: enabled, ownerId: "paid", tier: "starter" }).allowed, true);
assert.equal(evaluateFeature({ feature: "github_sync", flag: enabled, ownerId: "paid", tier: "pro" }).allowed, true);
assert.equal(evaluateFeature({ feature: "github_export", flag: { enabled: true, rollout_percent: 0 }, ownerId: "admin", admin: true }).allowed, true);
assert.equal(evaluateFeature({ feature: "github_export", flag: { enabled: false, rollout_percent: 100 }, ownerId: "admin", admin: true }).allowed, false);
assert.equal(evaluateFeature({ feature: "publish", ownerId: "paid", tier: "starter" }).allowed, true);
assert.equal(evaluateFeature({ feature: "publish", ownerId: "free", tier: null }).reason, "paid_plan_required");
assert.equal(evaluateFeature({ feature: "custom_domains", ownerId: "starter", tier: "starter" }).allowed, false);
assert.equal(disabledFeatureMatrix({ ownerId: "paid", tier: "starter" }).publish.allowed, true);
assert.equal(disabledFeatureMatrix({ ownerId: "paid", tier: "starter" }).github_export.allowed, false);
assert.equal(evaluateFeature({ feature: "missing", flag: enabled }).reason, "unknown_feature");

assert.equal(encryptedStorageConfigured(), true);
const value = "top-secret-value-123";
const encrypted = encryptSecret(value);
assert.notEqual(encrypted, value);
assert.equal(encrypted.split(":").length, 3);
assert.equal(decryptSecret(encrypted), value);
assert.equal(secretHint(value), "top••••-123");
assert.throws(() => decryptSecret(`${encrypted.slice(0, -2)}aa`));

const migration = await readFile(new URL("../supabase/migrations/20260721131113_platform_foundations.sql", import.meta.url), "utf8");
for (const table of ["feature_flags", "project_secrets", "project_integrations", "project_environments", "project_releases", "background_tasks", "audit_events"]) {
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
}
assert.match(migration, /revoke all on table public\.project_secrets from anon, authenticated/i);
assert.doesNotMatch(migration, /grant .*project_secrets.*authenticated/i);
assert.match(migration, /grant select on table public\.project_releases to authenticated/i);

const viteConfig = await readFile(new URL("../shell/web/vite.config.js", import.meta.url), "utf8");
assert.match(viteConfig, /loadEnv\(mode, path\.resolve\(HERE, "\.\."\), ""\)/);
assert.match(viteConfig, /shellEnv\.SUPABASE_URL/);
assert.match(viteConfig, /shellEnv\.SUPABASE_ANON_KEY/);
assert.doesNotMatch(viteConfig, /SUPABASE_SERVICE_ROLE_KEY/);

console.log("platform foundations: pass");
