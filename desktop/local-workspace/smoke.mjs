#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  METADATA_KEY,
  LocalWorkspaceRegistry,
  createImportManifest,
  workspaceModeCapability,
} = require("../../editor/vscode/lib/localWorkspace.js");
const { createLocalWorkspaceHost } = require("../../editor/vscode/lib/localWorkspaceHost.js");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "thrallo-d8-smoke-"));
const projectRoot = path.join(temporaryRoot, "fixture-project");
const stateValues = new Map();
const state = {
  get: (key) => stateValues.get(key),
  update: async (key, value) => stateValues.set(key, value),
};

let passed = 0;
function proof(assertion) {
  assert.ok(assertion);
  passed += 1;
}

try {
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "node_modules", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "package.json"), JSON.stringify({
    name: "thrallo-d8-smoke-fixture",
    private: true,
    scripts: { dev: "vite" },
    dependencies: { react: "0.0.0-fixture", vite: "0.0.0-fixture" },
  }, null, 2));
  fs.writeFileSync(path.join(projectRoot, "src", "main.js"), "export const fixture = true;\n");
  fs.writeFileSync(path.join(projectRoot, ".env"), "FIXTURE_ONLY_TOKEN=not-a-real-secret\n");
  fs.writeFileSync(path.join(projectRoot, "node_modules", "fixture", "index.js"), "fixture\n");

  const registry = new LocalWorkspaceRegistry({ state, now: () => new Date("2026-08-09T00:00:00.000Z") });
  const opened = await registry.open(projectRoot);
  proof(opened.mode === "local_folder" && opened.projectType === "vite_react");
  proof(opened.previewCommands.length === 1 && opened.previewCommands[0].command === "npm run dev" && opened.previewCommands[0].autoRun === false);
  proof((await registry.recent()).length === 1 && stateValues.has(METADATA_KEY));

  const calls = { commands: [], terminals: [], sent: [] };
  const uri = { scheme: "file", fsPath: opened.realPath };
  const vscode = {
    Uri: { file: (fsPath) => ({ scheme: "file", fsPath }) },
    workspace: { workspaceFolders: [{ uri, name: "fixture-project" }], getWorkspaceFolder: () => ({ uri, name: "fixture-project" }) },
    window: {
      activeTextEditor: null,
      createTerminal: (options) => {
        const terminal = { options, show() {}, sendText: (command) => calls.sent.push(command) };
        calls.terminals.push(terminal);
        return terminal;
      },
    },
    commands: { executeCommand: async (...args) => calls.commands.push(args) },
  };
  const host = createLocalWorkspaceHost({ vscode, context: { globalState: state } });
  await host.openLocalTerminal();
  proof(calls.terminals[0].options.cwd.fsPath === opened.realPath && calls.sent.length === 0);

  const manifest = await createImportManifest(projectRoot);
  const exclusions = new Map(manifest.excludedFiles.map((entry) => [entry.path, entry.reason]));
  proof(manifest.uploaded === false && manifest.synchronized === false && exclusions.get(".env") === "sensitive_file");
  proof(exclusions.get("node_modules") === "dependency_tree" && manifest.includedFiles.some((entry) => entry.path === "src/main.js"));

  const restarted = new LocalWorkspaceRegistry({ state, now: () => new Date("2026-08-09T00:01:00.000Z") });
  const recovery = await restarted.recovery();
  proof(recovery.state === "ready" && recovery.workspace.recovery.terminalState === "not_restored");
  proof(workspaceModeCapability("future_thrallo_project").code === "capability_unavailable");
  proof(workspaceModeCapability("future_cloud_workspace").state === "integration_pending");

  process.stdout.write(`Thrallo D8 local workspace smoke: ${passed}/9 passed\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
