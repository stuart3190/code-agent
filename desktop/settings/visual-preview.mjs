#!/usr/bin/env node

// Loopback-only D12 visual harness. It renders the real product controller/view
// with deterministic metadata and has no mutation endpoint or production origin.

import http from "node:http";
import { createRequire } from "node:module";
import * as client from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const { createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { D12_SCENARIOS, SETTINGS_SECTIONS } = require("../../editor/vscode/lib/settingsFoundation.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");
const port = 43122;
const localRegistry = Object.freeze({ async recent() { return Object.freeze([]); } });

const server = http.createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method || "")) { response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return; }
  try {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    const scenario = D12_SCENARIOS.includes(url.searchParams.get("scenario")) ? url.searchParams.get("scenario") : "supabase-healthy";
    const section = SETTINGS_SECTIONS.includes(url.searchParams.get("section")) ? url.searchParams.get("section") : "overview";
    const controller = await createDesktopProductController({ client, localRegistry, settingsScenario: scenario, seed: "d12-visual" });
    await controller.dispatch({ type: "navigate", destination: "settings" });
    await controller.dispatch({ type: "settings_action", action: { type: "select_section", section } });
    if (url.searchParams.get("review") === "destructive") await controller.dispatch({ type: "settings_action", action: { type: "preview_database_change", changeId: "remove-legacy-column" } });
    const html = renderDesktopProductHtml(controller.snapshot(), { nonce: "d12-visual", cspSource: "'self'" }).replace("const vscode=acquireVsCodeApi();", "const vscode={postMessage:(message)=>console.info('D12 fixture action',message)};");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? "" : html);
  } catch (error) { response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); response.end(`D12 visual harness failed: ${String(error?.message || error).slice(0, 160)}`); }
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`D12 visual preview: http://127.0.0.1:${port}/\n`));
