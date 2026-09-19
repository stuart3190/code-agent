import { build, loadEnv } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyWebAuthArtifact } from "../authArtifactGate.mjs";
import { resolvePublicAuthConfig } from "../publicAuthConfig.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");
const SHELL_ROOT = path.resolve(WEB_ROOT, "..");
const environment = {
  ...loadEnv("production", SHELL_ROOT, ""),
  ...loadEnv("production", WEB_ROOT, ""),
  ...process.env,
  THRALLO_REQUIRE_PUBLIC_AUTH: "1",
};
const config = resolvePublicAuthConfig(environment, { required: true });

process.env.THRALLO_REQUIRE_PUBLIC_AUTH = "1";
process.env.NODE_ENV = "production";
await build({ root: WEB_ROOT, mode: "production" });
const proof = await verifyWebAuthArtifact({ distDir: path.join(WEB_ROOT, "dist"), config });
console.log(JSON.stringify({
  ok: proof.ok,
  authUrlHost: proof.authUrlHost,
  keyKind: proof.keyKind,
  keyFingerprint: proof.keyFingerprint,
  sourceMapCount: proof.sourceMapCount,
  assets: proof.assets,
}));
