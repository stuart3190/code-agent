#!/usr/bin/env node

// Loopback-only D14 visual harness. It renders the real shared desktop controller
// and companion view; it has no mutation endpoint, production origin or external asset.

import http from "node:http";
import { createRequire } from "node:module";
import * as client from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const { createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { D14_SCENARIOS, getD14Scenario, COMPANION_NAVIGATION } = require("../../editor/vscode/lib/companionFoundation.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");
const port = 43124;
const localRegistry = Object.freeze({ async recent() { return Object.freeze([]); } });

const server = http.createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method || "")) { response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return; }
  try {
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    const scenarioName = D14_SCENARIOS.includes(url.searchParams.get("scenario")) ? url.searchParams.get("scenario") : "first-companion-launch";
    const definition = getD14Scenario(scenarioName);
    const requestedView = url.searchParams.get("view");
    const view = COMPANION_NAVIGATION.some((item) => item.id === requestedView) ? requestedView : definition.initialView;
    const controller = await createDesktopProductController({ client, localRegistry, seed: "d14-visual", scenario: definition.desktop, previewScenario: definition.preview, deploymentScenario: definition.deployment, settingsScenario: definition.settings, companionScenario: scenarioName });
    await controller.dispatch({ type: "navigate", destination: "companion" });
    await controller.dispatch({ type: "companion_action", action: { type: "navigate", destination: view } });
    const html = renderDesktopProductHtml(controller.snapshot(), { nonce: "d14-visual", cspSource: "'self'" }).replace("const vscode=acquireVsCodeApi();", "const vscode={postMessage:(message)=>console.info('D14 fixture action',message)};");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? "" : html);
  } catch (error) { response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); response.end(`D14 visual harness failed: ${String(error?.message || error).slice(0, 160)}`); }
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`D14 visual preview: http://127.0.0.1:${port}/\n`));
