import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createD8Project, D8_SCENARIOS } from "./d8-fixtures.mjs";
import { runGuard } from "../../desktop/d0/guard.mjs";
import { createHostCapabilities } from "../../shared/thrallo-client/src/index.mjs";

const require = createRequire(import.meta.url);
const {
  METADATA_KEY,
  WORKSPACE_MODES,
  FUNCTIONAL_WORKSPACE_MODES,
  LocalWorkspaceRegistry,
  workspaceModeCapability,
  validateLocalFolder,
  detectProject,
  discoverPreviewCommands,
  inspectGit,
  inspectLocalWorkspace,
  createImportManifest,
  defaultRunProcess,
} = require("../../editor/vscode/lib/localWorkspace.js");
const { createLocalWorkspaceHost } = require("../../editor/vscode/lib/localWorkspaceHost.js");

const FIXED_NOW = () => new Date("2032-08-09T12:00:00.000Z");

test("D8 declares all workspace modes and fails closed for future Thrallo/cloud modes", () => {
  assert.deepEqual(WORKSPACE_MODES, ["local_folder", "local_git_repository", "imported_local_project", "future_thrallo_project", "future_cloud_workspace"]);
  assert.deepEqual(FUNCTIONAL_WORKSPACE_MODES, WORKSPACE_MODES.slice(0, 3));
  for (const mode of FUNCTIONAL_WORKSPACE_MODES) assert.equal(workspaceModeCapability(mode).state, "available");
  assert.deepEqual(workspaceModeCapability("future_thrallo_project"), {
    ok: false, mode: "future_thrallo_project", state: "integration_pending", code: "capability_unavailable",
    capability: "canonicalThralloAssociation", operationId: "associateLocalWorkspace",
  });
  assert.equal(workspaceModeCapability("future_cloud_workspace").code, "capability_unavailable");
});

test("a local folder opens into presentation-safe desktop metadata without changing project files", async (t) => {
  const fixture = createD8Project("non-git");
  t.after(fixture.cleanup);
  const before = digestTree(fixture.root);
  const workspace = await inspectLocalWorkspace(fixture.root, { now: FIXED_NOW });
  assert.equal(workspace.mode, "local_folder");
  assert.equal(workspace.projectType, "node");
  assert.equal(workspace.association.syncAvailable, false);
  assert.equal(workspace.lastOpenedAt, "2032-08-09T12:00:00.000Z");
  assert.equal(digestTree(fixture.root), before);
  assert.doesNotMatch(JSON.stringify(workspace), /content|FAKE_TEST_TOKEN|not-a-real-secret/);
});

test("project detection recognizes npm/pnpm/yarn, Vite, React, Next, Node and plain HTML", async (t) => {
  const vite = createD8Project("clean-vite-react");
  const pnpm = createD8Project("dirty-git");
  const yarn = createD8Project("moved-project");
  const node = createD8Project("non-git");
  const html = createD8Project("plain-html");
  const missing = createD8Project("missing-package");
  t.after(() => [vite, pnpm, yarn, node, html, missing].forEach((item) => item.cleanup()));
  assert.equal((await detectProject(vite.root)).primary, "vite_react");
  assert.equal((await detectProject(vite.root)).packageManager, "npm");
  assert.equal((await detectProject(pnpm.root)).packageManager, "pnpm");
  assert.equal((await detectProject(yarn.root)).packageManager, "yarn");
  assert.equal((await detectProject(node.root)).primary, "node");
  assert.equal((await detectProject(html.root)).primary, "plain_html");
  assert.equal((await detectProject(missing.root)).primary, "unknown");

  const next = createD8Project("non-git");
  t.after(next.cleanup);
  fs.writeFileSync(path.join(next.root, "package.json"), JSON.stringify({ name: "next-fixture", dependencies: { next: "0.0.0-fixture", react: "0.0.0-fixture" }, scripts: { dev: "next dev" } }));
  assert.equal((await detectProject(next.root)).primary, "next");
});

test("preview discovery is advisory and emits only fixed package-script commands", async (t) => {
  const npm = createD8Project("clean-vite-react");
  const pnpm = createD8Project("dirty-git");
  const html = createD8Project("plain-html");
  t.after(() => [npm, pnpm, html].forEach((item) => item.cleanup()));
  assert.deepEqual(discoverPreviewCommands(await detectProject(npm.root)).map((item) => item.command), ["npm run dev", "npm run start"]);
  assert.deepEqual(discoverPreviewCommands(await detectProject(pnpm.root)).map((item) => item.command), ["pnpm dev", "pnpm start"]);
  assert.deepEqual(discoverPreviewCommands(await detectProject(html.root)), []);
  assert.ok(discoverPreviewCommands(await detectProject(npm.root)).every((item) => item.autoRun === false));
});

test("Git inspection reports clean, dirty, staged, modified, untracked and detached states read-only", async (t) => {
  const clean = createD8Project("clean-vite-react");
  const dirty = createD8Project("dirty-git");
  t.after(() => { clean.cleanup(); dirty.cleanup(); });
  const cleanState = await inspectGit(clean.root);
  assert.equal(cleanState.detected, true);
  assert.equal(cleanState.dirty, false);
  assert.ok(cleanState.branch);
  const dirtyState = await inspectGit(dirty.root);
  assert.equal(dirtyState.dirty, true);
  assert.deepEqual(dirtyState.modifiedFiles, ["src/App.jsx"]);
  assert.deepEqual(dirtyState.stagedFiles, ["staged.js"]);
  assert.deepEqual(dirtyState.untrackedFiles, ["untracked.txt"]);
  await defaultRunProcess("git", ["-C", clean.root, "checkout", "--detach", "--quiet"], { acceptedExitCodes: [0] });
  assert.equal((await inspectGit(clean.root)).detached, true);
});

test("recent workspaces are deterministic, deduplicated, and reopenable after restart", async (t) => {
  const fixture = createD8Project("clean-vite-react");
  t.after(fixture.cleanup);
  const state = memoryState();
  const first = new LocalWorkspaceRegistry({ state, now: FIXED_NOW });
  const opened = await first.open(fixture.root);
  await first.open(fixture.root);
  assert.equal((await first.recent()).length, 1);
  const restarted = new LocalWorkspaceRegistry({ state, now: FIXED_NOW });
  const recovery = await restarted.recovery();
  assert.equal(recovery.state, "ready");
  assert.equal(recovery.action, "reopen");
  assert.equal(recovery.workspace.id, opened.id);
  assert.equal(recovery.workspace.recovery.terminalState, "not_restored");
});

test("missing, moved/renamed and inaccessible folders produce explicit recovery states", async (t) => {
  const movedFixture = createD8Project("moved-project");
  const state = memoryState();
  const registry = new LocalWorkspaceRegistry({ state, now: FIXED_NOW });
  await registry.open(movedFixture.root);
  const renamed = path.join(movedFixture.base, "renamed-project");
  fs.renameSync(movedFixture.root, renamed);
  t.after(movedFixture.cleanup);
  const moved = await registry.recovery([renamed]);
  assert.equal(moved.state, "moved");
  assert.equal(moved.workspace.realPath, await fs.promises.realpath(renamed));

  fs.rmSync(renamed, { recursive: true, force: true });
  assert.equal((await registry.recovery()).state, "missing_folder");

  const inaccessibleFs = { ...fs.promises, lstat: async () => { const error = new Error("denied"); error.code = "EACCES"; throw error; } };
  await assert.rejects(() => validateLocalFolder("C:\\fixture-denied", { fsApi: inaccessibleFs }), (error) => error.code === "inaccessible_folder");
});

test("corrupt desktop-local metadata is reset without touching the user project", async (t) => {
  const fixture = createD8Project("corrupt-metadata");
  t.after(fixture.cleanup);
  const before = digestTree(fixture.root);
  const state = memoryState({ [METADATA_KEY]: { version: 999, recent: "not-an-array" } });
  const registry = new LocalWorkspaceRegistry({ state, now: FIXED_NOW });
  assert.deepEqual(await registry.recovery(), { state: "corrupt_metadata", recovered: true, action: "start_fresh" });
  assert.equal(state.values.get(METADATA_KEY).version, 1);
  assert.equal(digestTree(fixture.root), before);
});

test("safe import excludes secrets, Git internals, dependencies, builds, ignored files and OS metadata", async (t) => {
  const fixture = createD8Project("secret-containing");
  t.after(fixture.cleanup);
  const manifest = await createImportManifest(fixture.root);
  const reasons = new Map(manifest.excludedFiles.map((item) => [item.path, item.reason]));
  assert.equal(manifest.uploaded, false);
  assert.equal(manifest.synchronized, false);
  assert.equal(reasons.get(".env"), "sensitive_file");
  assert.equal(reasons.get(".env.local"), "sensitive_file");
  assert.equal(reasons.get("id_rsa"), "sensitive_file");
  assert.equal(reasons.get("certificate.crt"), "sensitive_certificate");
  assert.equal(reasons.get("credentials.json"), "sensitive_file");
  assert.equal(reasons.get(".aws"), "sensitive_directory");
  assert.equal(reasons.get("node_modules"), "dependency_tree");
  assert.equal(reasons.get(".git"), "git_internal");
  assert.equal(reasons.get("dist"), "build_output");
  assert.equal(reasons.get(".DS_Store"), "os_metadata");
  assert.equal(reasons.get("ignored.txt"), "git_ignored");
  assert.ok(manifest.includedFiles.some((item) => item.path === "src/main.js"));
  assert.doesNotMatch(JSON.stringify(manifest), /not-a-real-secret|FAKE_LOCAL_VALUE|FAKE TEST KEY/);
});

test("binary assets are classified without content and large trees fail bounded", async (t) => {
  const binary = createD8Project("binary-assets");
  const large = createD8Project("large-tree");
  t.after(() => { binary.cleanup(); large.cleanup(); });
  const binaryManifest = await createImportManifest(binary.root);
  assert.equal(binaryManifest.includedFiles.find((item) => item.path === "assets/pixel.png").kind, "binary");
  assert.equal(binaryManifest.includedFiles.find((item) => item.path === "assets/blob.bin").kind, "binary");
  assert.ok(binaryManifest.includedFiles.every((item) => !("content" in item)));
  const limited = await createImportManifest(large.root, { maxEntries: 5 });
  assert.equal(limited.summary.truncated, true);
  assert.ok(limited.excludedFiles.some((item) => item.reason === "tree_limit"));
});

test("symlinks and junctions are never followed into an import manifest", async (t) => {
  const fixture = createD8Project("symlink-case");
  t.after(fixture.cleanup);
  const manifest = await createImportManifest(fixture.root);
  assert.equal(manifest.excludedFiles.find((item) => item.path === "linked-assets").reason, "symlink_or_junction");
  assert.ok(manifest.includedFiles.some((item) => item.path === "real-assets/data.txt"));
});

test("Git worktree pointer files are treated as Git internals", async (t) => {
  const fixture = createD8Project("plain-html");
  t.after(fixture.cleanup);
  fs.writeFileSync(path.join(fixture.root, ".git"), "gitdir: C:/fixture-only/worktree\n");
  const manifest = await createImportManifest(fixture.root);
  assert.equal(manifest.excludedFiles.find((item) => item.path === ".git").reason, "git_internal");
  assert.ok(!manifest.includedFiles.some((item) => item.path === ".git"));
});

test("inspection performs no package install, project script, upload, or mutating Git command", async (t) => {
  const fixture = createD8Project("clean-vite-react");
  t.after(fixture.cleanup);
  const calls = [];
  const runProcess = async (command, args, options) => { calls.push([command, ...args]); return defaultRunProcess(command, args, options); };
  await inspectLocalWorkspace(fixture.root, { runProcess });
  await createImportManifest(fixture.root, { runProcess });
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call[0] === "git"));
  assert.ok(calls.every((call) => !call.some((part) => /^(?:push|pull|commit|reset|checkout|clean|add)$/i.test(part))));
  const source = fs.readFileSync(path.resolve("editor/vscode/lib/localWorkspace.js"), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|https?:\/\/|npm\s+install|pnpm\s+install|yarn\s+install/);
  assert.doesNotMatch(source, /\b(?:upload|createRun|syncProject)\s*\(/i);
});

test("preview tracking starts only from an explicit discovered command and records exit/recovery state", async (t) => {
  const fixture = createD8Project("clean-vite-react");
  t.after(fixture.cleanup);
  const state = memoryState();
  const registry = new LocalWorkspaceRegistry({ state, now: FIXED_NOW });
  const workspace = await registry.open(fixture.root);
  const running = await registry.recordPreview(workspace.id, "npm run dev", { state: "running" });
  assert.equal(running.userInitiated, true);
  assert.equal(running.port, null);
  await registry.recordPreview(workspace.id, "npm run dev", { state: "exited", exitCode: 0 });
  assert.equal((await registry.recent())[0].lastSuccessfulPreviewCommand, "npm run dev");
  await assert.rejects(() => registry.recordPreview(workspace.id, "npm install", { state: "running" }), (error) => error.code === "unsupported_preview_command");
});

test("Code OSS host opens folders through vscode.openFolder and remembers them locally", async (t) => {
  const fixture = createD8Project("non-git");
  t.after(fixture.cleanup);
  const env = mockCodeOss({ selectedFolder: fixture.root });
  const host = createLocalWorkspaceHost(env);
  const opened = await host.openLocalFolder();
  assert.equal(opened.realPath, await fs.promises.realpath(fixture.root));
  assert.deepEqual(env.calls.commands.at(-1), ["vscode.openFolder", opened.realPath, false]);
  assert.ok(env.context.globalState.values.has(METADATA_KEY));
  assert.equal(env.calls.terminals.length, 0);
});

test("Code OSS host opens multiple normal-user terminals at the project root, executes nothing, and represents exit", async (t) => {
  const fixture = createD8Project("plain-html");
  t.after(fixture.cleanup);
  const env = mockCodeOss({ workspaceFolder: fixture.root });
  const host = createLocalWorkspaceHost(env);
  await host.openLocalTerminal();
  await host.openLocalTerminal();
  assert.equal(env.calls.terminals.length, 2);
  assert.ok(env.calls.terminals.every((terminal) => terminal.options.cwd.fsPath === fixture.root));
  assert.ok(env.calls.terminals.every((terminal) => terminal.sent.length === 0));
  assert.ok(env.calls.terminals.every((terminal) => !("shellPath" in terminal.options) && !("env" in terminal.options)));
  assert.equal(host.terminalStatus(env.calls.terminals[0]).state, "running");
  env.calls.terminals[0].exitStatus = { code: 17 };
  await host.onTerminalClosed(env.calls.terminals[0]);
  assert.deepEqual(host.terminalStatus(env.calls.terminals[0]), { state: "exited", rootPath: fixture.root, exitCode: 17 });
  assert.equal(host.terminalStatus(env.calls.terminals[1]).state, "running");
});

test("Code OSS host sends a preview command only after explicit user selection and records terminal exit", async (t) => {
  const fixture = createD8Project("clean-vite-react");
  t.after(fixture.cleanup);
  const env = mockCodeOss({ workspaceFolder: fixture.root });
  const host = createLocalWorkspaceHost(env);
  const started = await host.startLocalPreview();
  assert.equal(started.command.command, "npm run dev");
  assert.deepEqual(env.calls.terminals[0].sent, [{ text: "npm run dev", addNewLine: true }]);
  env.calls.terminals[0].exitStatus = { code: 0 };
  await host.onTerminalClosed(env.calls.terminals[0]);
  assert.equal((await host.registry.recent())[0].lastSuccessfulPreviewCommand, "npm run dev");
});

test("local import review remains local and exposes included/excluded paths in an untitled Code OSS document", async (t) => {
  const fixture = createD8Project("secret-containing");
  t.after(fixture.cleanup);
  const env = mockCodeOss({ workspaceFolder: fixture.root });
  const host = createLocalWorkspaceHost(env);
  const manifest = await host.reviewLocalImport();
  assert.equal(manifest.state, "local_review_only");
  assert.equal(env.calls.documents.length, 1);
  assert.match(env.calls.documents[0].content, /sensitive_file/);
  assert.doesNotMatch(env.calls.documents[0].content, /not-a-real-secret/);
  assert.equal(env.calls.external.length, 0);
});

test("local workspace functions operate while all network access is unavailable", async (t) => {
  const fixture = createD8Project("dirty-git");
  t.after(fixture.cleanup);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network disabled in D8 test"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const workspace = await inspectLocalWorkspace(fixture.root);
  const manifest = await createImportManifest(fixture.root);
  assert.equal(workspace.git.dirty, true);
  assert.equal(manifest.uploaded, false);
});

test("D8 fixture catalogue covers every requested deterministic scenario with fake-only data", () => {
  for (const required of ["clean-vite-react", "dirty-git", "non-git", "plain-html", "missing-package", "missing-workspace", "large-tree", "symlink-case", "secret-containing", "binary-assets", "moved-project", "corrupt-metadata"]) assert.ok(D8_SCENARIOS.includes(required));
  assert.equal(new Set(D8_SCENARIOS).size, D8_SCENARIOS.length);
});

test("D1 host capabilities continue to represent native local filesystem, terminal and Git", () => {
  const capabilities = createHostCapabilities({ localFilesystem: true, localTerminal: true, localGit: true });
  assert.equal(capabilities.localFilesystem, true);
  assert.equal(capabilities.localTerminal, true);
  assert.equal(capabilities.localGit, true);
  assert.equal(capabilities.cloudWorkspace, false);
  assert.equal(capabilities.builderV2Mutation, false);
});

test("extension integration uses built-in Code OSS primitives and contains no Builder V2/Buildr101 dependency", () => {
  const extension = fs.readFileSync(path.resolve("editor/vscode/extension.js"), "utf8");
  const host = fs.readFileSync(path.resolve("editor/vscode/lib/localWorkspaceHost.js"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.resolve("editor/vscode/package.json"), "utf8"));
  for (const command of ["thrallo.local.openFolder", "thrallo.local.openRecent", "thrallo.local.showStatus", "thrallo.local.reviewImport", "thrallo.local.openTerminal", "thrallo.local.startPreview"]) {
    assert.match(extension + host, new RegExp(command.replaceAll(".", "\\.")));
    assert.ok(pkg.contributes.commands.some((item) => item.command === command));
  }
  assert.match(host, /vscode\.openFolder/);
  assert.match(host, /createTerminal/);
  assert.doesNotMatch(host, /builderV2|Buildr101|runtime-worker|app\.thrallo\.com|\/api\//i);
});

test("D8 evidence distinguishes native, fixture-only and blocked future capabilities", () => {
  const evidence = JSON.parse(fs.readFileSync(path.resolve("desktop/local-workspace/evidence.json"), "utf8"));
  const items = new Map(evidence.items.map((item) => [item.id, item]));
  assert.equal(items.get("code-oss-local-workbench").category, "code-oss-native");
  assert.equal(items.get("safe-local-import-review").fixtureVerified, true);
  assert.equal(items.get("canonical-thrallo-association").state, "builder-v2-blocked");
  assert.equal(items.get("canonical-thrallo-association").runtimeVerified, false);
  assert.equal(items.get("cloud-workspace").state, "integration-pending");
  assert.equal(evidence.negativeClaims.projectUploadImplemented, false);
  assert.equal(evidence.negativeClaims.productionMutationDependency, false);
});

test("D0 protected path, production fallback and Buildr101 guards remain green", () => {
  assert.doesNotThrow(() => runGuard());
});

function memoryState(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get(key) { return values.get(key); },
    async update(key, value) { values.set(key, value); },
  };
}

function mockCodeOss({ selectedFolder = null, workspaceFolder = null } = {}) {
  const calls = { commands: [], terminals: [], documents: [], messages: [], external: [] };
  const commandHandlers = new Map();
  const globalState = memoryState();
  const uri = (file) => ({ scheme: "file", fsPath: file, path: file.replaceAll("\\", "/") });
  const folders = workspaceFolder ? [{ name: path.basename(workspaceFolder), uri: uri(workspaceFolder) }] : [];
  const vscode = {
    Uri: { file: uri },
    ViewColumn: { Beside: 2 },
    commands: {
      registerCommand(name, handler) { commandHandlers.set(name, handler); return { dispose() {} }; },
      async executeCommand(name, ...args) { calls.commands.push([name, ...args.map((item) => item?.fsPath || item)]); return commandHandlers.get(name)?.(...args); },
    },
    workspace: {
      workspaceFolders: folders,
      getWorkspaceFolder() { return folders[0] || null; },
      async openTextDocument(options) { calls.documents.push(options); return { ...options }; },
    },
    window: {
      activeTextEditor: null,
      async showOpenDialog() { return selectedFolder ? [uri(selectedFolder)] : []; },
      async showQuickPick(items) { return items[0] || null; },
      showInformationMessage(message) { calls.messages.push(message); },
      showWarningMessage(message) { calls.messages.push(message); },
      async showTextDocument(document) { return document; },
      createTerminal(options) {
        const terminal = { options, sent: [], exitStatus: null, show() {}, sendText(text, addNewLine) { this.sent.push({ text, addNewLine }); } };
        calls.terminals.push(terminal);
        return terminal;
      },
      onDidCloseTerminal(handler) { calls.onDidCloseTerminal = handler; return { dispose() {} }; },
    },
  };
  return { vscode, context: { globalState, subscriptions: [] }, output: { appendLine() {} }, calls };
}

function digestTree(root) {
  const entries = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isSymbolicLink()) entries.push(`${relative}:link`);
      else entries.push(`${relative}:${fs.statSync(absolute).size}:${fs.readFileSync(absolute).toString("base64")}`);
    }
  }
  walk(root);
  return entries.join("\n");
}
