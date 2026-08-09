#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as client from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const { createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");
const { createCompanionPortalHandoff, createReturnContext } = require("../../editor/vscode/lib/companionFoundation.js");
const localRegistry = Object.freeze({ async recent() { return Object.freeze([]); } });
let passed = 0;
const proof = (condition) => { assert.ok(condition); passed += 1; };

const controller = await createDesktopProductController({ client, localRegistry, scenario: "waiting-plan-approval", companionScenario: "waiting-plan-approval" });
await controller.dispatch({ type: "navigate", destination: "companion" });
proof(controller.snapshot().companion.sourceRefs.length === 7);
proof(controller.snapshot().companion.attention.some((item) => item.id === "plan-waiting"));
const planId = controller.snapshot().companion.plan.id;
proof((await controller.dispatch({ type: "companion_action", action: { type: "plan_decision", planId, decision: "approve" } })).result.code === "explicit_typed_confirmation_required");
proof((await controller.dispatch({ type: "companion_action", action: { type: "plan_decision", planId, decision: "approve", confirmed: true } })).result.state === "approved");
proof(controller.snapshot().plan.status === controller.snapshot().companion.plan.status);
proof((await controller.dispatch({ type: "companion_action", action: { type: "request_capability", capability: "terminal" } })).result.availability === "capability_unavailable");
proof((await controller.dispatch({ type: "companion_action", action: { type: "future_cloud_launch" } })).result.code === "integration_pending");
const html = renderDesktopProductHtml(controller.snapshot(), { nonce: "d14-smoke", cspSource: "vscode-webview://fixture" });
proof(html.includes("Thrallo Companion") && html.includes("companion_touch"));
proof(html.includes("--touch:44px") && html.includes("orientation:portrait"));
proof(!html.includes("data-companion-nav=\"terminal\""));
const opened = [];
const portal = createCompanionPortalHandoff({ openExternal: async (url) => opened.push(url) });
proof((await portal.open("billing")).ok && opened[0] === "https://app.thrallo.com/settings/billing");
proof((await portal.open("cloud_workspace_launch")).code === "integration_pending" && opened.length === 1);
proof(createReturnContext({ actionType: "project_status", projectReference: "fixture-project-0001", destinationView: "projects" }).ok);
proof(createReturnContext({ actionType: "project_status", projectReference: "token=fake", destinationView: "projects" }).code === "return_context_rejected");
proof(controller.snapshot().companion.boundaries.builderV2Mutation === "capability_unavailable");

process.stdout.write(`Thrallo D14 portal/companion foundation smoke: ${passed}/15 passed\n`);
