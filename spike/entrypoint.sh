#!/bin/sh
set -e

# Write per-container vite.config.js from environment variables.
# VITE_HOST: the nip.io subdomain the browser uses (e.g. spike-proj-1.1.2.3.4.nip.io)
# VITE_CLIENT_PORT: the port the browser connects to for HMR WebSocket (default 80, the proxy)
cat > /app/vite.config.js << VITEEOF
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    hmr: {
      host: "${VITE_HOST:-localhost}",
      clientPort: ${VITE_CLIENT_PORT:-80},
      protocol: "ws"
    },
    allowedHosts: "all",
    watch: { usePolling: false }
  },
  cacheDir: "/tmp/vite-cache"
});
VITEEOF

exec npm run dev
