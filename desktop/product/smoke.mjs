#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import * as client from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const { LocalWorkspaceRegistry } = require("../../editor/vscode/lib/localWorkspace.js");
const { createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "thrallo-d9-smoke-"));
const projectRoot = path.join(temporaryRoot, "local-vite-project");
const localValues = new Map();
const productValues = new Map();
const store = (values) => ({ get: (key) => values.get(key), update: async (key, value) => values.set(key, value) });
let passed = 0;
const proof = (condition) => { assert.ok(condition); passed += 1; };

try {
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({ name: "d9-smoke-fixture", private: true, scripts: { dev: "vite" }, dependencies: { react: "0.0.0-fixture", vite: "0.0.0-fixture" } }));
  fs.writeFileSync(path.join(projectRoot, "src", "App.jsx"), "export function App(){return 'fixture';}\n");
  const registry = new LocalWorkspaceRegistry({ state: store(localValues), now: () => new Date("2032-08-09T14:00:00.000Z") });
  const local = await registry.open(projectRoot);
  const controller = await createDesktopProductController({ client, localRegistry: registry, stateStore: store(productValues), scenario: "waiting-plan-approval", seed: "d9-smoke" });
  proof(controller.snapshot().home.brand === "Thrallo");
  proof(controller.snapshot().projects.items.some((item) => item.id === local.id && item.local));
  proof(controller.snapshot().plan.status === "pending");

  await controller.dispatch({ type: "send_message", text: "Approve this ordinary fixture chat message" });
  proof(controller.snapshot().plan.status === "pending");
  await controller.dispatch({ type: "plan_decision", planId: controller.snapshot().plan.id, decision: "approve", comment: "Explicit fixture decision" });
  proof(controller.snapshot().plan.status === "approved" && controller.snapshot().build.state === "queued");
  await controller.dispatch({ type: "select_model", modelId: "fixture-deep" });
  proof(controller.snapshot().models.selected === "fixture-deep");
  await controller.dispatch({ type: "navigate", destination: "agents" });
  proof(controller.snapshot().navigation.current === "agents");
  const html = renderDesktopProductHtml(controller.snapshot(), { nonce: "d9-smoke-nonce", cspSource: "vscode-webview://fixture" });
  proof(html.includes("Activity and control") && html.includes("No production mutations"));
  proof(controller.getCalls().providers.every((call) => call.kind === "read") && controller.snapshot().integration.builderV2Mutation === "capability_unavailable");
  process.stdout.write(`Thrallo D9 desktop product smoke: ${passed}/9 passed\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
