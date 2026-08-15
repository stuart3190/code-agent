import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePublicAuthConfig } from "./publicAuthConfig.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SHELL_PORT = process.env.SHELL_PORT || "8787";

// Dev: proxy /api to the shell server so the UI is same-origin (no CORS, and streaming fetch works).
// fs.allow: the balance meter imports the PROVEN ledger + costModel from the repo's src/ (reuse, not
// re-derive), which live outside this web root — so Vite must be allowed to read them.
export default defineConfig(({ mode }) => {
  // Production keeps server credentials in shell/.env and public browser config in
  // shell/web/.env. Read both, but expose only the validated public URL/key pair.
  const webEnv = loadEnv(mode, HERE, "");
  const shellEnv = loadEnv(mode, path.resolve(HERE, ".."), "");
  const environment = { ...shellEnv, ...webEnv, ...process.env };
  const publicAuth = resolvePublicAuthConfig(environment, {
    required: environment.THRALLO_REQUIRE_PUBLIC_AUTH === "1",
  });

  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(publicAuth.url),
      "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(publicAuth.key),
      // Keep the old name populated for older modules during the publishable-key transition.
      "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(publicAuth.key),
    },
    server: {
      port: 5173,
      fs: { allow: [REPO_ROOT] },
      proxy: { "/api": { target: `http://localhost:${SHELL_PORT}`, changeOrigin: true } },
    },
  };
});
