import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyWebAuthArtifact } from "../../shell/web/authArtifactGate.mjs";
import {
  containsPrivilegedSupabaseCredential,
  resolvePublicAuthConfig,
} from "../../shell/web/publicAuthConfig.mjs";
import { verifyPublicWebAuth } from "../../scripts/lib/public-web-auth-smoke.mjs";

function jwt(role) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role })}.signature`;
}

test("public auth config prefers publishable keys and preserves the legacy anon fallback", () => {
  const preferred = resolvePublicAuthConfig({
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_preferred",
    SUPABASE_ANON_KEY: jwt("anon"),
  }, { required: true });
  assert.equal(preferred.key, "sb_publishable_preferred");
  assert.equal(preferred.keySource, "SUPABASE_PUBLISHABLE_KEY");
  assert.equal(preferred.keyKind, "publishable");

  const legacy = resolvePublicAuthConfig({
    VITE_SUPABASE_URL: "https://project.supabase.co",
    VITE_SUPABASE_ANON_KEY: jwt("anon"),
  }, { required: true });
  assert.equal(legacy.keySource, "VITE_SUPABASE_ANON_KEY");
  assert.equal(legacy.keyKind, "legacy_anon");
});

test("public auth config fails closed for missing or privileged browser credentials", () => {
  assert.throws(() => resolvePublicAuthConfig({}, { required: true }), /required/);
  assert.throws(() => resolvePublicAuthConfig({
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_secret_never_public",
  }, { required: true }), /not a publishable or legacy anon key/);
  assert.throws(() => resolvePublicAuthConfig({
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: jwt("service_role"),
  }, { required: true }), /legacy_service_role/);
  assert.equal(containsPrivilegedSupabaseCredential(`asset:${jwt("service_role")}`), true);
});

test("artifact gate proves the exact public config and rejects missing auth or a server credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "thrallo-web-auth-"));
  const assets = path.join(root, "assets");
  await mkdir(assets);
  const config = resolvePublicAuthConfig({
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_artifact_test",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_server_only_test",
  }, { required: true });
  await writeFile(path.join(root, "index.html"), '<script type="module" src="/assets/index.js"></script>');
  await writeFile(path.join(assets, "index.js"), `${config.url}\n${config.key}`);
  const proof = await verifyWebAuthArtifact({ distDir: root, config });
  assert.equal(proof.ok, true);
  assert.equal(proof.sourceMapCount, 0);
  assert.equal(proof.assets.length, 1);
  assert.match(proof.assets[0].sha256, /^[a-f0-9]{64}$/);

  await writeFile(path.join(assets, "index.js"), config.url);
  await assert.rejects(() => verifyWebAuthArtifact({ distDir: root, config }), /does not contain the configured public Supabase key/);
  await writeFile(path.join(assets, "index.js"), `${config.url}\n${config.key}\nsb_secret_server_only_test`);
  await assert.rejects(() => verifyWebAuthArtifact({ distDir: root, config }), /privileged/);
});

test("live smoke rejects the broken deployed bundle and proves configured auth without exposing env files", async () => {
  const config = resolvePublicAuthConfig({
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_live_smoke_test",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_live_server_only",
  }, { required: true });
  const index = '<script type="module" src="/assets/index-fixed.js"></script>';
  const fixedAsset = `const url=${JSON.stringify(config.url)},key=${JSON.stringify(config.key)};`;
  const fetchFor = (asset) => async (url) => {
    const value = String(url);
    if (value === "https://app.thrallo.test/") return new Response(index);
    if (value === "https://app.thrallo.test/assets/index-fixed.js") return new Response(asset);
    if (value.startsWith("https://app.thrallo.test/")) return new Response(index);
    if (value === `${config.url}/auth/v1/settings`) {
      return Response.json({ disable_signup: false });
    }
    return new Response("not found", { status: 404 });
  };
  const proof = await verifyPublicWebAuth({
    origin: "https://app.thrallo.test",
    config,
    fetchImpl: fetchFor(fixedAsset),
  });
  assert.equal(proof.ok, true);
  assert.equal(proof.signupEnabled, true);
  assert.equal(proof.sourceMapCount, 0);
  await assert.rejects(() => verifyPublicWebAuth({
    origin: "https://app.thrallo.test",
    config,
    fetchImpl: fetchFor("const url='',key='';"),
  }), /omit.*public Supabase URL/);
});

test("release workflow and production runbook require the auth-configured build and live bundle smoke", async () => {
  const [rootPackage, webPackage, workflow, deploy, smoke, vite, backend] = await Promise.all([
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
    readFile(new URL("../../shell/web/package.json", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8"),
    readFile(new URL("../../docs/DEPLOY.md", import.meta.url), "utf8"),
    readFile(new URL("../../scripts/smoke-production.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../shell/web/vite.config.js", import.meta.url), "utf8"),
    readFile(new URL("../../shell/web/src/lib/backend.js", import.meta.url), "utf8"),
  ]);
  assert.match(rootPackage, /build:web:production/);
  assert.match(webPackage, /build:production/);
  assert.match(workflow, /THRALLO_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  assert.match(workflow, /npm run build:web:production/);
  assert.match(deploy, /build:web:production/);
  assert.match(deploy, /smoke-production\.mjs/);
  assert.match(smoke, /verifyPublicWebAuth/);
  assert.match(vite, /VITE_SUPABASE_PUBLISHABLE_KEY/);
  assert.match(backend, /VITE_SUPABASE_PUBLISHABLE_KEY \|\| import\.meta\.env\.VITE_SUPABASE_ANON_KEY/);
});
