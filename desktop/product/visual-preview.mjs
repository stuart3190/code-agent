#!/usr/bin/env node

// Loopback-only visual harness for D9. It renders the same view/controller code as the
// Code OSS webview and never opens a production origin or accepts mutation requests.

import http from "node:http";
import { createRequire } from "node:module";
import * as client from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const { createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { D9_SCENARIOS } = require("../../editor/vscode/lib/desktopProductFixtures.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");

const port = 43119;
const localRegistry = Object.freeze({
  async recent() {
    return Object.freeze([Object.freeze({
      id: "local_visual_fixture",
      mode: "local_git_repository",
      displayName: "Local Vite workspace",
      realPath: "C:\\fixture-only\\local-vite-workspace",
      lastOpenedAt: "2032-08-09T13:30:00.000Z",
      projectType: "vite_react",
      availability: "available",
      git: Object.freeze({ detected: true, branch: "main", dirty: true }),
      previewCommands: Object.freeze([Object.freeze({ command: "npm run dev", autoRun: false })]),
    })]);
  },
});

const server = http.createServer(async (request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    const scenario = D9_SCENARIOS.includes(url.searchParams.get("scenario")) ? url.searchParams.get("scenario") : "waiting-plan-approval";
    const destination = ["home", "projects", "conversation", "agents", "usage"].includes(url.searchParams.get("view")) ? url.searchParams.get("view") : "home";
    const controller = await createDesktopProductController({ client, localRegistry, scenario, seed: "d9-visual-preview" });
    if (destination !== controller.snapshot().navigation.current) await controller.dispatch({ type: "navigate", destination });
    const html = renderDesktopProductHtml(controller.snapshot(), { nonce: "d9-visual-preview", cspSource: "'self'" })
      .replace("const vscode=acquireVsCodeApi();", "const vscode={postMessage:(message)=>console.info('D9 fixture action',message)};");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? "" : html);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`D9 visual harness failed: ${String(error?.message || error).slice(0, 160)}`);
  }
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`D9 visual preview: http://127.0.0.1:${port}/\n`));
