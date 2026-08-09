#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as client from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const { createPreviewController } = require("../../editor/vscode/lib/previewFoundation.js");
const { createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");

let passed = 0;
const proof = (condition) => { assert.ok(condition); passed += 1; };
const localRegistry = Object.freeze({ async recent() { return Object.freeze([]); } });

const preview = createPreviewController({ scenario: "failed-network-request", seed: "d10-smoke" });
proof(preview.snapshot().preview.source === "fixture_preview");
await preview.dispatch({ type: "start_preview", userInitiated: true });
proof(preview.snapshot().preview.state === "running");
await preview.dispatch({ type: "set_viewport", presetId: "tablet_portrait" });
proof(preview.snapshot().viewport.width === 768 && preview.snapshot().viewport.height === 1024);
await preview.dispatch({ type: "capture_screenshot", name: "D10 smoke" });
proof(preview.snapshot().artifacts.some((artifact) => artifact.kind === "screenshot" && artifact.uploaded === false));
await preview.dispatch({ type: "run_tests" });
proof(preview.snapshot().testSession.state === "passed");
proof(preview.snapshot().diagnostics.network.some((item) => item.state === "failed" && !item.path.includes("fake-secret")));

const desktop = await createDesktopProductController({ client, localRegistry, previewScenario: "runtime-exception" });
const fixtureProject = desktop.snapshot().projects.items.find((item) => item.workspaceType === "fixture_thrallo_project");
await desktop.dispatch({ type: "open_preview", projectId: fixtureProject.id });
proof(desktop.snapshot().navigation.current === "preview");
const html = renderDesktopProductHtml(desktop.snapshot(), { nonce: "d10-smoke", cspSource: "vscode-webview://fixture" });
proof(html.includes("Application testing") && html.includes("Responsive viewport simulation"));
proof(html.includes("Console") && html.includes("Network") && html.includes("Runtime"));
proof(desktop.snapshot().preview.boundaries.builderV2Mutation === "capability_unavailable" && desktop.snapshot().preview.boundaries.cloudPreview === "integration_pending_D6");

process.stdout.write(`Thrallo D10 preview/testing smoke: ${passed}/10 passed\n`);
