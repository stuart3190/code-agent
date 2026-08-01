// Export safety.
//
// Export hands a user a durable artifact built from platform-managed state, so the interesting
// question is not "does it produce a ZIP" but "what did it fail to remove". These tests assert
// the removal, the refusal, and that both share one rule set — Thrallo previously had two
// independent secret filters, so a marker added to one silently did not protect the other.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";

import {
  scrubTree, stripExportNoise, assertNoPlatformSecrets, findPlatformSecrets,
  PLATFORM_SECRET_MARKERS, SECRET_PATH, EXCLUDED_FROM_EXPORT,
} from "../../shell/server/lib/secretScrub.mjs";
import { buildProjectZip, safeZipFilename } from "../../shell/server/lib/exportProject.mjs";

const APP = {
  id: "p1",
  name: "Barber Booking",
  tree: {
    "package.json": JSON.stringify({ name: "barber", private: true }, null, 2),
    "index.html": "<!doctype html><div id=root></div>",
    "src/App.jsx": "export default function App(){ return <h1>Book</h1>; }",
  },
};

test("the export package is the user's code, not the platform's configuration", () => {
  const built = buildProjectZip(APP);
  const paths = Object.keys(built.files);
  assert.ok(paths.includes("src/App.jsx"), "the user's source is included");
  assert.ok(paths.some((p) => /README/i.test(p)), "a readme is included");
  assert.ok(built.zip.length > 0);
  assert.doesNotMatch(built.filename, /buildr101/i, "the artifact is no longer Buildr101-branded");
});

test("dependencies, build output and local state never travel", () => {
  const noisy = {
    "src/App.jsx": "ok",
    "node_modules/react/index.js": "…",
    "dist/assets/index.js": "…",
    "build/output.js": "…",
    ".git/config": "…",
    "coverage/lcov.info": "…",
    ".DS_Store": "",
    "src/.DS_Store": "",
  };
  const { files, removed } = stripExportNoise(noisy);
  assert.deepEqual(Object.keys(files), ["src/App.jsx"]);
  assert.equal(removed, 7);
  for (const path of ["node_modules/react/index.js", "dist/assets/index.js", ".git/config"]) {
    assert.match(path, EXCLUDED_FROM_EXPORT, `${path} must be excluded`);
  }
});

test("env files and key material are stripped, not merely redacted, from an export", () => {
  const { files } = stripExportNoise({
    "src/App.jsx": "ok",
    ".env": "VITE_SUPABASE_ANON_KEY=abc",
    ".env.production": "X=1",
    "certs/server.pem": "-----BEGIN PRIVATE KEY-----",
    "deploy.key": "ssh-rsa",
    ".npmrc": "//registry:_authToken=x",
  });
  assert.deepEqual(Object.keys(files), ["src/App.jsx"]);
  for (const path of [".env", ".env.production", "certs/server.pem", "deploy.key", ".npmrc"]) {
    assert.match(path, SECRET_PATH, `${path} must match the secret-path rule`);
  }
});

test("a platform secret refuses the export outright rather than shipping redacted", () => {
  for (const marker of ["SUPABASE_SERVICE_ROLE", "STRIPE_SECRET_KEY", "BYOK_ENC_KEY", "PLATFORM_ENC_KEY"]) {
    assert.throws(
      () => assertNoPlatformSecrets({ "src/config.js": `const x = "${marker}=value";` }),
      /forbidden secret markers/,
      `${marker} must refuse the export`,
    );
  }
  assert.throws(() => assertNoPlatformSecrets({ "a.js": "const k = 'sk_live_abcdef';" }), /forbidden/);
});

test("a user's own provider key never travels either", () => {
  for (const key of [
    "sk-abcdefghijklmnopqrstuvwx",
    "xai-abcdefghijklmnopqrstuvwx",
    "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ01",
    "ghp_abcdefghijklmnopqrstuvwxyz01",
  ]) {
    const found = findPlatformSecrets({ "src/secrets.js": `const key = "${key}";` });
    assert.ok(found.length > 0, `${key.slice(0, 8)}… must be detected`);
  }
  // Ordinary code with no key material passes cleanly.
  assert.deepEqual(findPlatformSecrets(APP.tree), []);
});

test("checkpoints and export share ONE rule set", async () => {
  // The consolidation this PR performed: buildCheckpoints re-exports the shared scrubTree, and
  // exportProject delegates to the shared assertion. A marker added once protects both.
  const checkpoints = await import("../../shell/server/lib/appBuild/buildCheckpoints.mjs");
  assert.equal(checkpoints.scrubTree, scrubTree, "checkpoints must use the shared scrubber");

  const exportModule = await import("../../shell/server/lib/exportProject.mjs");
  assert.deepEqual(exportModule._internal.REQUIRED_SECRET_MARKERS, PLATFORM_SECRET_MARKERS,
    "export must use the shared marker list");

  // And the shared scrubber is actually wired into checkpoint creation, not merely exported —
  // `export { x } from "…"` creates no local binding, which silently breaks the call site.
  const store = checkpoints.createCheckpointStore();
  const entry = store.create({ tree: { "a.js": "ok", ".env": "K=sk-live-1" }, attempt: 1 });
  assert.ok(!(".env" in entry.tree), "checkpoint creation must apply the scrubber");
  assert.equal(entry.fileCount, 1);
});

test("export filenames are safe and Thrallo-branded", () => {
  assert.match(safeZipFilename("Barber Booking"), /^barber-booking\.zip$/);
  assert.doesNotMatch(safeZipFilename(""), /buildr101/i);
  // Path traversal and shell characters cannot reach a Content-Disposition header.
  assert.doesNotMatch(safeZipFilename("../../etc/passwd"), /\.\.|\//);
});

test("export_project is registered and reachable conversationally", async () => {
  const registry = await import("../../shell/server/lib/capabilityRegistry.mjs");
  const core = await import("../../shell/server/lib/capabilities/coreCapabilities.mjs");
  registry.resetCapabilityRegistryForTests?.();
  core.registerCoreCapabilities();
  const capability = registry.listCapabilities().find((c) => c.id === "export_project");
  assert.ok(capability, "export_project must be registered");
  assert.equal(capability.costProfile, "free");
  assert.match(capability.description, /download|export/i);
});
