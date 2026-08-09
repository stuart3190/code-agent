#!/usr/bin/env node

// Loopback-only D10 visual harness. It renders the same controller/view code used by the
// Code OSS webview and has no mutation route, production origin or arbitrary navigation.

import http from "node:http";
import { createRequire } from "node:module";
import * as client from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const { createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { D10_SCENARIOS } = require("../../editor/vscode/lib/previewFoundation.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");
const port = 43120;
const localRegistry = Object.freeze({ async recent() { return Object.freeze([]); } });

const server = http.createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return; }
  try {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    const scenario = D10_SCENARIOS.includes(url.searchParams.get("scenario")) ? url.searchParams.get("scenario") : "failed-network-request";
    const controller = await createDesktopProductController({ client, localRegistry, previewScenario: scenario, seed: "d10-visual" });
    await controller.dispatch({ type: "navigate", destination: "preview" });
    if (["idle", "stopped"].includes(controller.snapshot().preview.preview.state)) await controller.dispatch({ type: "preview_action", action: { type: "start_preview", userInitiated: true } });
    const html = renderDesktopProductHtml(controller.snapshot(), { nonce: "d10-visual", cspSource: "'self'" }).replace("const vscode=acquireVsCodeApi();", "const vscode={postMessage:(message)=>console.info('D10 fixture action',message)};");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? "" : html);
  } catch (error) { response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); response.end(`D10 visual harness failed: ${String(error?.message || error).slice(0, 160)}`); }
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`D10 visual preview: http://127.0.0.1:${port}/\n`));
