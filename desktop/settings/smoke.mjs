#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as client from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const { createSettingsController } = require("../../editor/vscode/lib/settingsFoundation.js");
const { createDesktopProductController } = require("../../editor/vscode/lib/desktopProduct.js");
const { renderDesktopProductHtml } = require("../../editor/vscode/lib/desktopProductView.js");
const localRegistry = Object.freeze({ async recent() { return Object.freeze([]); } });
let passed = 0;
const proof = (condition) => { assert.ok(condition); passed += 1; };

const settings = createSettingsController({ scenario: "no-integrations", seed: "d12-smoke" });
const synthetic = "sk-proj-SYNTHETIC_D12_SMOKE_123456";
await settings.dispatch({ type: "create_secret", name: "FIXTURE_SMOKE_KEY", secretClass: "provider_api_key", value: synthetic });
proof(settings.snapshot().secrets.items[0].valueRetrievable === false);
proof(!JSON.stringify(settings.snapshot()).includes(synthetic));
proof(!JSON.stringify(settings.getCalls()).includes(synthetic));
await settings.dispatch({ type: "preview_database_change", changeId: "remove-legacy-column" });
proof(settings.snapshot().database.pendingReview.dataLossWarning === true);
proof((await settings.dispatch({ type: "apply_database_change", changeId: "remove-legacy-column", approved: true })).result.code === "integration_pending");
proof(settings.snapshot().boundaries.builderV2Mutation === "capability_unavailable");

const desktop = await createDesktopProductController({ client, localRegistry, settingsScenario: "stripe-webhook-failure" });
await desktop.dispatch({ type: "navigate", destination: "settings" });
proof(desktop.snapshot().navigation.current === "settings");
proof(desktop.snapshot().settings.stripe.webhookHealth === "failing");
proof(desktop.snapshot().preview.boundaries.builderV2Mutation === "capability_unavailable");
proof(desktop.snapshot().deployment.boundaries.productionMutations === "capability_unavailable");
const html = renderDesktopProductHtml(desktop.snapshot(), { nonce: "d12-smoke", cspSource: "vscode-webview://fixture" });
proof(html.includes("Settings and integrations") && html.includes("No live mutation path"));
proof(html.includes("Database / Supabase") && html.includes("External Integrations"));
proof(!/service[_ -]?role|sk-proj-SYNTHETIC|postgresql:\/\//i.test(html));

process.stdout.write(`Thrallo D12 settings/integrations foundation smoke: ${passed}/13 passed\n`);
