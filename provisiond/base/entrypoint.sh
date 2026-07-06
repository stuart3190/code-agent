#!/bin/sh
set -e

# Generalized from spike/entrypoint.sh. One base image serves every project; the per-container
# vite.config.js is written here from env so the image stays generic. The tree injected via
# `docker cp` deliberately OMITS vite.config.js — this file is authoritative for the dev server.
#   VITE_HOST           the public hostname the browser uses (e.g. <label>.33c388bd.nip.io)
#   VITE_CLIENT_PORT    the port the browser's HMR websocket connects to (80 plain / 443 TLS)
#   VITE_HMR_PROTOCOL   ws (plain) or wss (behind TLS)
#   VITE_USE_POLLING    fallback for file-watching if inotify misses docker-cp writes (CP-2 knob)
cat > /app/vite.config.js << VITEEOF
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": "/app/src" } },
  server: {
    host: "0.0.0.0",
    port: 5173,
    hmr: {
      host: "${VITE_HOST:-localhost}",
      clientPort: ${VITE_CLIENT_PORT:-80},
      protocol: "${VITE_HMR_PROTOCOL:-ws}"
    },
    allowedHosts: "all",
    watch: { usePolling: ${VITE_USE_POLLING:-false} }
  },
  cacheDir: "/tmp/vite-cache"
});
VITEEOF

exec npm run dev
