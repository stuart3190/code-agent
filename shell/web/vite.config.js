import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SHELL_PORT = process.env.SHELL_PORT || "8787";

// Dev: proxy /api to the shell server so the UI is same-origin (no CORS, and streaming fetch works).
// fs.allow: the balance meter imports the PROVEN ledger + costModel from the repo's src/ (reuse, not
// re-derive), which live outside this web root — so Vite must be allowed to read them.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: [REPO_ROOT] },
    proxy: { "/api": { target: `http://localhost:${SHELL_PORT}`, changeOrigin: true } },
  },
});
