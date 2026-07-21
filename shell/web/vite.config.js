import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SHELL_PORT = process.env.SHELL_PORT || "8787";

// Dev: proxy /api to the shell server so the UI is same-origin (no CORS, and streaming fetch works).
// fs.allow: the balance meter imports the PROVEN ledger + costModel from the repo's src/ (reuse, not
// re-derive), which live outside this web root — so Vite must be allowed to read them.
export default defineConfig(({ mode }) => {
  // Production keeps server credentials in shell/.env. Vite normally reads only
  // shell/web/.env, so map the two public Supabase values explicitly. This keeps
  // service-role credentials server-only while making fresh VPS builds reliable.
  const shellEnv = loadEnv(mode, path.resolve(HERE, ".."), "");
  const supabaseUrl = process.env.VITE_SUPABASE_URL
    || shellEnv.VITE_SUPABASE_URL
    || process.env.SUPABASE_URL
    || shellEnv.SUPABASE_URL
    || "";
  const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY
    || shellEnv.VITE_SUPABASE_ANON_KEY
    || process.env.SUPABASE_ANON_KEY
    || shellEnv.SUPABASE_ANON_KEY
    || "";

  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(supabaseUrl),
      "import.meta.env.VITE_SUPABASE_ANON_KEY": JSON.stringify(supabaseAnonKey),
    },
    server: {
      port: 5173,
      fs: { allow: [REPO_ROOT] },
      proxy: { "/api": { target: `http://localhost:${SHELL_PORT}`, changeOrigin: true } },
    },
  };
});
