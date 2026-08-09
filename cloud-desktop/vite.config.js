import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const LOOPBACK_HOST = "127.0.0.1";
const DEVELOPMENT_PORT = 4174;

export default defineConfig({
  plugins: [react()],
  server: {
    host: LOOPBACK_HOST,
    port: DEVELOPMENT_PORT,
    strictPort: true,
  },
  preview: {
    host: LOOPBACK_HOST,
    port: DEVELOPMENT_PORT,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
