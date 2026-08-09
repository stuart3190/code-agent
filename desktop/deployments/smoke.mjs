#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as client from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const { createDeploymentController } = require("../../editor/vscode/lib/deploymentFoundation.js");
const { createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");

let passed = 0;
const proof = (condition) => { assert.ok(condition); passed += 1; };
const localRegistry = Object.freeze({ async recent() { return Object.freeze([]); } });

const deployment = createDeploymentController({ scenario: "rollback-available", seed: "d11-smoke" });
proof(deployment.snapshot().sourceIdentity.classification === "fixture_source");
proof(deployment.snapshot().currentDeploymentActive === false);
proof(deployment.snapshot().releases.length === 3);
const releases = deployment.snapshot().releases;
await deployment.dispatch({ type: "review_action", actionId: "rollback" });
proof(deployment.snapshot().pendingReview?.confirmationRequired === true);
await deployment.dispatch({ type: "confirm_action", actionId: "rollback", confirmed: true });
proof(deployment.snapshot().activeReleaseId === releases.at(-2).id);
proof(JSON.stringify(deployment.snapshot().logs).includes("REDACTED"));

const desktop = await createDesktopProductController({ client, localRegistry, deploymentScenario: "domain-pending-dns" });
await desktop.dispatch({ type: "navigate", destination: "deployments" });
proof(desktop.snapshot().navigation.current === "deployments");
proof(desktop.snapshot().preview.boundaries.builderV2Mutation === "capability_unavailable");
proof(desktop.snapshot().deployment.boundaries.productionMutations === "capability_unavailable");
const html = renderDesktopProductHtml(desktop.snapshot(), { nonce: "d11-smoke", cspSource: "vscode-webview://fixture" });
proof(html.includes("Deployment history") && html.includes("Immutable history"));
proof(html.includes("Deployment logs") && html.includes("Custom domain"));
proof(!/fake-|db\.fixture|Bearer abc|Cookie:/i.test(html));

process.stdout.write(`Thrallo D11 deployment foundation smoke: ${passed}/12 passed\n`);
