#!/usr/bin/env node

// Loopback-only D11 visual harness. It renders the real D9/D10/D11 controller and view
// with deterministic fixtures and exposes no mutation handler or production origin.

import http from "node:http";
import { createRequire } from "node:module";
import * as client from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const { createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { D11_SCENARIOS } = require("../../editor/vscode/lib/deploymentFoundation.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");
const port = 43121;
const localRegistry = Object.freeze({ async recent() { return Object.freeze([]); } });

const server = http.createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method || "")) { response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return; }
  try {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    const scenario = D11_SCENARIOS.includes(url.searchParams.get("scenario")) ? url.searchParams.get("scenario") : "live-healthy";
    const controller = await createDesktopProductController({ client, localRegistry, deploymentScenario: scenario, seed: "d11-visual" });
    await controller.dispatch({ type: "navigate", destination: "deployments" });
    if (url.searchParams.get("review") === "rollback") await controller.dispatch({ type: "deployment_action", action: { type: "review_action", actionId: "rollback" } });
    if (url.searchParams.get("review") === "unpublish") await controller.dispatch({ type: "deployment_action", action: { type: "review_action", actionId: "unpublish" } });
    const html = renderDesktopProductHtml(controller.snapshot(), { nonce: "d11-visual", cspSource: "'self'" }).replace("const vscode=acquireVsCodeApi();", "const vscode={postMessage:(message)=>console.info('D11 fixture action',message)};");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? "" : html);
  } catch (error) { response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); response.end(`D11 visual harness failed: ${String(error?.message || error).slice(0, 160)}`); }
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`D11 visual preview: http://127.0.0.1:${port}/\n`));
