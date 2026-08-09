// Thrallo D8 local-workspace foundation. All filesystem and Git activity stays on the
// desktop host. This module has no network client and no upload/synchronization operation.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn } = require("child_process");

const METADATA_KEY = "thrallo.localWorkspaces.v1";
const METADATA_VERSION = 1;
const MAX_RECENT = 20;

const WORKSPACE_MODES = Object.freeze([
  "local_folder",
  "local_git_repository",
  "imported_local_project",
  "future_thrallo_project",
  "future_cloud_workspace",
]);
const FUNCTIONAL_WORKSPACE_MODES = Object.freeze(WORKSPACE_MODES.slice(0, 3));

const EXCLUDED_DIRECTORIES = Object.freeze({
  ".git": "git_internal",
  node_modules: "dependency_tree",
  bower_components: "dependency_tree",
  ".next": "build_output",
  ".nuxt": "build_output",
  dist: "build_output",
  build: "build_output",
  out: "build_output",
  coverage: "build_output",
  target: "build_output",
  ".cache": "local_cache",
  ".parcel-cache": "local_cache",
  ".turbo": "local_cache",
  ".vite": "local_cache",
  ".pnpm-store": "local_cache",
  ".yarn": "local_cache",
  ".ssh": "sensitive_directory",
  ".aws": "sensitive_directory",
  ".azure": "sensitive_directory",
  ".gnupg": "sensitive_directory",
  ".kube": "sensitive_directory",
});

const OS_METADATA = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
const SECRET_NAMES = [
  /^\.env(?:\..+)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^\.envrc$/i,
  /^credentials(?:\.[^.]+)?$/i,
  /^secrets?(?:\.[^.]+)?$/i,
  /^tokens?(?:\.[^.]+)?$/i,
  /^client[-_.]?secret.*$/i,
  /^firebase[-_.]?adminsdk.*\.json$/i,
  /^kubeconfig(?:\.[^.]+)?$/i,
  /^service[-_.]?account.*\.json$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
  /(?:^|[-_.])private[-_.]?key(?:\.|$)/i,
];
const CERTIFICATE_NAMES = [/\.(?:crt|cer|der)$/i];
const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tgz|tar|7z|rar|woff2?|ttf|eot|mp[34]|webm|mov|avi|wasm|exe|dll|so|dylib)$/i;

class LocalWorkspaceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LocalWorkspaceError";
    this.code = code;
    this.details = { ...details };
  }
}

function workspaceModeCapability(mode) {
  if (!WORKSPACE_MODES.includes(mode)) throw new LocalWorkspaceError("invalid_workspace_mode", `Unknown local workspace mode: ${mode}`);
  if (FUNCTIONAL_WORKSPACE_MODES.includes(mode)) return Object.freeze({ ok: true, mode, state: "available" });
  const capability = mode === "future_thrallo_project" ? "canonicalThralloAssociation" : "cloudWorkspace";
  return Object.freeze({
    ok: false,
    mode,
    state: "integration_pending",
    code: "capability_unavailable",
    capability,
    operationId: mode === "future_thrallo_project" ? "associateLocalWorkspace" : "openCloudWorkspace",
  });
}

async function validateLocalFolder(inputPath, { fsApi = fsp } = {}) {
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new LocalWorkspaceError("invalid_path", "A local folder path is required.");
  const resolved = path.resolve(inputPath);
  let stat;
  try {
    stat = await fsApi.lstat(resolved);
  } catch (error) {
    throw new LocalWorkspaceError(error?.code === "ENOENT" ? "missing_folder" : "inaccessible_folder", "The local folder is unavailable.", { path: resolved });
  }
  if (stat.isSymbolicLink()) throw new LocalWorkspaceError("symlink_root", "A symbolic-link or junction root must be opened through its real folder.", { path: resolved });
  if (!stat.isDirectory()) throw new LocalWorkspaceError("not_a_folder", "The selected path is not a folder.", { path: resolved });
  let realPath;
  try {
    realPath = await fsApi.realpath(resolved);
    await fsApi.access(realPath, fs.constants.R_OK);
  } catch {
    throw new LocalWorkspaceError("inaccessible_folder", "The local folder cannot be read by the current user.", { path: resolved });
  }
  let writable = true;
  try { await fsApi.access(realPath, fs.constants.W_OK); } catch { writable = false; }
  return Object.freeze({ path: resolved, realPath: path.resolve(realPath), writable });
}

async function detectProject(rootPath, options = {}) {
  const { fsApi = fsp } = options;
  const validated = options.validated || await validateLocalFolder(rootPath, { fsApi });
  const names = new Set(await safeDirectoryNames(validated.realPath, fsApi));
  const packageData = await readPackageJson(validated.realPath, fsApi);
  const dependencies = { ...(packageData?.dependencies || {}), ...(packageData?.devDependencies || {}) };
  const packageManager = detectPackageManager(names, packageData?.packageManager);
  const frameworks = [];
  if (dependencies.next) frameworks.push("next");
  if (dependencies.vite || names.has("vite.config.js") || names.has("vite.config.ts") || names.has("vite.config.mjs")) frameworks.push("vite");
  if (dependencies.react || dependencies["react-dom"]) frameworks.push("react");
  const plainHtml = ["index.html", "index.htm"].some((name) => names.has(name));
  const node = Boolean(packageData);
  let primary = "unknown";
  if (frameworks.includes("next")) primary = "next";
  else if (frameworks.includes("vite") && frameworks.includes("react")) primary = "vite_react";
  else if (frameworks.includes("vite")) primary = "vite";
  else if (frameworks.includes("react")) primary = "react";
  else if (node) primary = "node";
  else if (plainHtml) primary = "plain_html";
  return Object.freeze({
    primary,
    frameworks: Object.freeze(frameworks),
    packageManager,
    packageName: typeof packageData?.name === "string" ? packageData.name.slice(0, 160) : null,
    hasPackageJson: node,
    hasPackageMetadata: Boolean(packageData),
    packageJsonValid: packageData !== null || !names.has("package.json"),
    plainHtml,
    gitMarker: names.has(".git"),
    manifests: Object.freeze([...names].filter((name) => ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "index.html", "index.htm"].includes(name)).sort()),
    scripts: Object.freeze(Object.keys(packageData?.scripts || {}).sort()),
  });
}

function discoverPreviewCommands(detection) {
  if (!detection?.hasPackageJson) return Object.freeze([]);
  const runner = detection.packageManager === "pnpm" ? "pnpm" : detection.packageManager === "yarn" ? "yarn" : "npm";
  const commands = [];
  if (detection.scripts.includes("dev")) commands.push(previewCommand("dev", runner));
  if (detection.scripts.includes("start")) commands.push(previewCommand("start", runner));
  return Object.freeze(commands);
}

function previewCommand(script, runner) {
  const command = runner === "npm" ? `npm run ${script}` : `${runner} ${script}`;
  return Object.freeze({ id: `${runner}:${script}`, label: command, command, script, packageManager: runner, source: "package_script", autoRun: false });
}

async function inspectGit(rootPath, { runProcess = defaultRunProcess } = {}) {
  const marker = path.join(rootPath, ".git");
  let markerExists = false;
  try { markerExists = Boolean(await fsp.lstat(marker)); } catch { /* not a repository */ }
  const inside = await runProcess("git", ["-C", rootPath, "rev-parse", "--is-inside-work-tree"], { acceptedExitCodes: [0, 128] });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return Object.freeze({ detected: false, markerExists, available: inside.errorCode !== "ENOENT", branch: null, detached: false, head: null, dirty: false, modifiedFiles: Object.freeze([]), stagedFiles: Object.freeze([]), untrackedFiles: Object.freeze([]) });
  }
  const [branchResult, headResult, statusResult] = await Promise.all([
    runProcess("git", ["-C", rootPath, "symbolic-ref", "--quiet", "--short", "HEAD"], { acceptedExitCodes: [0, 1, 128] }),
    runProcess("git", ["-C", rootPath, "rev-parse", "--short", "HEAD"], { acceptedExitCodes: [0, 128] }),
    runProcess("git", ["-C", rootPath, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { acceptedExitCodes: [0] }),
  ]);
  const status = parseGitStatus(statusResult.stdout);
  return Object.freeze({
    detected: true,
    markerExists,
    available: true,
    branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() : null,
    detached: branchResult.exitCode !== 0,
    head: headResult.exitCode === 0 ? headResult.stdout.trim() : null,
    dirty: status.dirty,
    modifiedFiles: Object.freeze(status.modifiedFiles),
    stagedFiles: Object.freeze(status.stagedFiles),
    untrackedFiles: Object.freeze(status.untrackedFiles),
  });
}

function parseGitStatus(output) {
  const modified = new Set();
  const staged = new Set();
  const untracked = new Set();
  for (const entry of String(output || "").split("\0").filter(Boolean)) {
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = safeRelativePath(entry.slice(3));
    if (!file) continue;
    if (x === "?" && y === "?") untracked.add(file);
    else {
      if (x !== " ") staged.add(file);
      if (y !== " ") modified.add(file);
    }
  }
  return {
    dirty: modified.size > 0 || staged.size > 0 || untracked.size > 0,
    modifiedFiles: [...modified].sort(),
    stagedFiles: [...staged].sort(),
    untrackedFiles: [...untracked].sort(),
  };
}

async function inspectLocalWorkspace(rootPath, { mode = null, fsApi = fsp, runProcess = defaultRunProcess, now = () => new Date() } = {}) {
  const validated = await validateLocalFolder(rootPath, { fsApi });
  const detection = await detectProject(validated.realPath, { fsApi, validated });
  const git = await inspectGit(validated.realPath, { runProcess });
  const resolvedMode = mode || (git.detected ? "local_git_repository" : "local_folder");
  const capability = workspaceModeCapability(resolvedMode);
  if (!capability.ok) return capability;
  const fingerprint = workspaceFingerprint(validated.realPath, detection, git);
  return Object.freeze({
    schemaVersion: METADATA_VERSION,
    id: `local_${hashPath(validated.realPath)}`,
    mode: resolvedMode,
    displayName: path.basename(validated.realPath),
    path: validated.path,
    realPath: validated.realPath,
    writable: validated.writable,
    projectType: detection.primary,
    detection,
    git,
    previewCommands: discoverPreviewCommands(detection),
    lastOpenedAt: now().toISOString(),
    lastSuccessfulPreviewCommand: null,
    recovery: Object.freeze({ state: "healthy", fingerprint, previousPath: null, terminalState: "none", previewState: "none" }),
    association: Object.freeze({ state: "unassociated", capability: "integration_pending", canonicalProjectId: null, syncAvailable: false }),
  });
}

async function createImportManifest(rootPath, {
  fsApi = fsp,
  runProcess = defaultRunProcess,
  maxEntries = 5000,
  maxFileBytes = 100 * 1024 * 1024,
  maxTotalBytes = 500 * 1024 * 1024,
} = {}) {
  const workspace = await inspectLocalWorkspace(rootPath, { mode: "imported_local_project", fsApi, runProcess });
  const root = workspace.realPath;
  const candidates = [];
  const excluded = [];
  const stack = [root];
  let scannedEntries = 0;
  let truncated = false;
  while (stack.length && !truncated) {
    const directory = stack.pop();
    let entries;
    try { entries = await fsApi.readdir(directory, { withFileTypes: true }); } catch { excluded.push(excludedEntry(relative(root, directory), "inaccessible_path", "directory")); continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > maxEntries) { truncated = true; break; }
      const absolute = path.join(directory, entry.name);
      const rel = relative(root, absolute);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) { excluded.push(excludedEntry(rel || entry.name, "path_traversal", entry.isDirectory() ? "directory" : "file")); continue; }
      let stat;
      try { stat = await fsApi.lstat(absolute); } catch { excluded.push(excludedEntry(rel, "inaccessible_path", "unknown")); continue; }
      if (stat.isSymbolicLink()) { excluded.push(excludedEntry(rel, "symlink_or_junction", "link")); continue; }
      if (/\r|\n/.test(entry.name)) { excluded.push(excludedEntry(rel, "unsafe_filename", stat.isDirectory() ? "directory" : "file", stat.size)); continue; }
      if (entry.name.toLowerCase() === ".git") { excluded.push(excludedEntry(rel, "git_internal", stat.isDirectory() ? "directory" : "file", stat.size)); continue; }
      if (stat.isDirectory()) {
        const reason = EXCLUDED_DIRECTORIES[entry.name] || EXCLUDED_DIRECTORIES[entry.name.toLowerCase()];
        if (reason) excluded.push(excludedEntry(rel, reason, "directory"));
        else stack.push(absolute);
        continue;
      }
      if (!stat.isFile()) { excluded.push(excludedEntry(rel, "unsupported_file_type", "other")); continue; }
      const reason = exclusionReasonForFile(entry.name, rel, stat.size, maxFileBytes);
      if (reason) excluded.push(excludedEntry(rel, reason, "file", stat.size));
      else candidates.push({ path: rel, absolute, sizeBytes: stat.size });
    }
  }
  if (truncated) excluded.push(excludedEntry("*", "tree_limit", "summary"));
  const ignored = await gitIgnoredPaths(root, candidates.map((item) => item.path), runProcess);
  const included = [];
  let includedBytes = 0;
  for (const candidate of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
    if (ignored.has(candidate.path)) { excluded.push(excludedEntry(candidate.path, "git_ignored", "file", candidate.sizeBytes)); continue; }
    if (includedBytes + candidate.sizeBytes > maxTotalBytes) { excluded.push(excludedEntry(candidate.path, "manifest_size_limit", "file", candidate.sizeBytes)); continue; }
    const binary = BINARY_EXTENSIONS.test(candidate.path) || await isBinaryFile(candidate.absolute, fsApi);
    included.push(Object.freeze({ path: candidate.path, sizeBytes: candidate.sizeBytes, kind: binary ? "binary" : "text" }));
    includedBytes += candidate.sizeBytes;
  }
  excluded.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason));
  return Object.freeze({
    schemaVersion: 1,
    mode: "imported_local_project",
    state: "local_review_only",
    uploaded: false,
    synchronized: false,
    rootPath: workspace.path,
    workspaceId: workspace.id,
    projectType: workspace.projectType,
    detection: workspace.detection,
    git: workspace.git,
    includedFiles: Object.freeze(included),
    excludedFiles: Object.freeze(excluded),
    summary: Object.freeze({ includedFileCount: included.length, excludedEntryCount: excluded.length, includedBytes, approximateScannedEntries: scannedEntries, truncated }),
    association: workspaceModeCapability("future_thrallo_project"),
  });
}

class LocalWorkspaceRegistry {
  constructor({ state, fsApi = fsp, runProcess = defaultRunProcess, now = () => new Date() }) {
    if (!state?.get || !state?.update) throw new TypeError("Local workspace registry requires desktop-local state get/update methods.");
    this.state = state;
    this.fsApi = fsApi;
    this.runProcess = runProcess;
    this.now = now;
    this.corruptMetadataRecovered = false;
  }

  async open(rootPath, { mode = null, restoreOnStartup = true } = {}) {
    const workspace = await inspectLocalWorkspace(rootPath, { mode, fsApi: this.fsApi, runProcess: this.runProcess, now: this.now });
    if (workspace.ok === false) return workspace;
    const data = await this.read();
    const previous = data.recent.find((item) => item.id === workspace.id || samePath(item.realPath, workspace.realPath));
    const merged = Object.freeze({ ...workspace, lastSuccessfulPreviewCommand: previous?.lastSuccessfulPreviewCommand || null });
    data.recent = [merged, ...data.recent.filter((item) => item.id !== merged.id && !samePath(item.realPath, merged.realPath))].slice(0, MAX_RECENT);
    data.lastWorkspaceId = merged.id;
    data.restoreOnStartup = restoreOnStartup === true;
    await this.write(data);
    return merged;
  }

  async recent() {
    const data = await this.read();
    const output = [];
    for (const item of data.recent) {
      let availability = "available";
      try { await validateLocalFolder(item.realPath, { fsApi: this.fsApi }); } catch (error) { availability = error.code || "inaccessible_folder"; }
      output.push(Object.freeze({ ...item, availability }));
    }
    return Object.freeze(output);
  }

  async recovery(candidatePaths = []) {
    const data = await this.read();
    if (this.corruptMetadataRecovered) return Object.freeze({ state: "corrupt_metadata", recovered: true, action: "start_fresh" });
    const current = data.recent.find((item) => item.id === data.lastWorkspaceId) || null;
    if (!data.restoreOnStartup || !current) return Object.freeze({ state: "none", action: "none" });
    try {
      const reopened = await inspectLocalWorkspace(current.realPath, { mode: current.mode, fsApi: this.fsApi, runProcess: this.runProcess, now: this.now });
      const normalized = normalizeRecoveredWorkspace(reopened, current);
      await this.replaceRecent(data, current, normalized);
      return Object.freeze({ state: "ready", action: "reopen", workspace: normalized });
    } catch (error) {
      if (error.code !== "missing_folder") return Object.freeze({ state: error.code || "inaccessible_folder", action: "prompt", workspace: current });
    }
    for (const candidate of candidatePaths) {
      try {
        const inspected = await inspectLocalWorkspace(candidate, { mode: current.mode, fsApi: this.fsApi, runProcess: this.runProcess, now: this.now });
        if (inspected.recovery.fingerprint !== current.recovery?.fingerprint) continue;
        const moved = Object.freeze({ ...normalizeRecoveredWorkspace(inspected, current), recovery: Object.freeze({ ...inspected.recovery, state: "moved", previousPath: current.realPath, terminalState: "not_restored", previewState: "stale" }) });
        await this.replaceRecent(data, current, moved);
        return Object.freeze({ state: "moved", action: "reopen_moved", workspace: moved });
      } catch { /* candidate is not the previous workspace */ }
    }
    return Object.freeze({ state: "missing_folder", action: "locate_or_remove", workspace: current });
  }

  async recordPreview(workspaceId, command, { state, port = null, exitCode = null } = {}) {
    const data = await this.read();
    const index = data.recent.findIndex((item) => item.id === workspaceId);
    if (index < 0) throw new LocalWorkspaceError("workspace_not_registered", "The local workspace is not registered.");
    const workspace = data.recent[index];
    if (!workspace.previewCommands.some((item) => item.command === command)) throw new LocalWorkspaceError("unsupported_preview_command", "Only a discovered local preview command may be tracked.");
    const preview = Object.freeze({ command, state, port: Number.isInteger(port) ? port : null, exitCode: Number.isInteger(exitCode) ? exitCode : null, updatedAt: this.now().toISOString(), userInitiated: true });
    data.recent[index] = Object.freeze({ ...workspace, lastSuccessfulPreviewCommand: state === "exited" && exitCode === 0 ? command : workspace.lastSuccessfulPreviewCommand, recovery: Object.freeze({ ...workspace.recovery, previewState: state === "running" ? "running" : "exited" }), preview });
    await this.write(data);
    return preview;
  }

  async read() {
    const raw = this.state.get(METADATA_KEY);
    if (raw === undefined) return emptyMetadata();
    if (!validMetadata(raw)) {
      this.corruptMetadataRecovered = true;
      const empty = emptyMetadata();
      await this.state.update(METADATA_KEY, empty);
      return empty;
    }
    return { ...raw, recent: [...raw.recent] };
  }

  async write(data) {
    await this.state.update(METADATA_KEY, Object.freeze({ version: METADATA_VERSION, recent: Object.freeze([...data.recent]), lastWorkspaceId: data.lastWorkspaceId || null, restoreOnStartup: data.restoreOnStartup === true }));
  }

  async replaceRecent(data, previous, next) {
    data.recent = data.recent.map((item) => item.id === previous.id ? next : item);
    data.lastWorkspaceId = next.id;
    await this.write(data);
  }
}

function normalizeRecoveredWorkspace(reopened, previous) {
  return Object.freeze({ ...reopened, lastSuccessfulPreviewCommand: previous.lastSuccessfulPreviewCommand || null, recovery: Object.freeze({ ...reopened.recovery, state: "recovered", terminalState: "not_restored", previewState: previous.preview?.state === "running" ? "stale" : "none" }) });
}

function emptyMetadata() { return { version: METADATA_VERSION, recent: [], lastWorkspaceId: null, restoreOnStartup: false }; }
function validMetadata(value) { return Boolean(value && value.version === METADATA_VERSION && Array.isArray(value.recent) && value.recent.every(validWorkspaceMetadata) && (value.lastWorkspaceId === null || typeof value.lastWorkspaceId === "string") && typeof value.restoreOnStartup === "boolean"); }
function validWorkspaceMetadata(item) { return Boolean(item && typeof item.id === "string" && FUNCTIONAL_WORKSPACE_MODES.includes(item.mode) && typeof item.realPath === "string" && item.association?.syncAvailable === false); }

async function readPackageJson(root, fsApi) {
  const file = path.join(root, "package.json");
  try {
    const stat = await fsApi.stat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const parsed = JSON.parse(await fsApi.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

async function safeDirectoryNames(root, fsApi) {
  try { return (await fsApi.readdir(root)).map(String); } catch { return []; }
}

function detectPackageManager(names, declared) {
  if (typeof declared === "string") {
    if (declared.startsWith("pnpm@")) return "pnpm";
    if (declared.startsWith("yarn@")) return "yarn";
    if (declared.startsWith("npm@")) return "npm";
  }
  if (names.has("pnpm-lock.yaml")) return "pnpm";
  if (names.has("yarn.lock")) return "yarn";
  return names.has("package.json") ? "npm" : null;
}

function exclusionReasonForFile(name, relativePath, size, maxFileBytes) {
  if (OS_METADATA.has(name.toLowerCase())) return "os_metadata";
  if (SECRET_NAMES.some((pattern) => pattern.test(name) || pattern.test(relativePath))) return "sensitive_file";
  if (CERTIFICATE_NAMES.some((pattern) => pattern.test(name))) return "sensitive_certificate";
  if (size > maxFileBytes) return "file_too_large";
  if (/\r|\n/.test(name) || /\r|\n/.test(relativePath)) return "unsafe_filename";
  return null;
}

async function gitIgnoredPaths(root, relativePaths, runProcess) {
  if (!relativePaths.length) return new Set();
  const result = await runProcess("git", ["-C", root, "check-ignore", "--no-index", "--stdin"], { input: `${relativePaths.join("\n")}\n`, acceptedExitCodes: [0, 1, 128] });
  if (result.exitCode === 128 || result.errorCode === "ENOENT") return new Set();
  return new Set(result.stdout.split(/\r?\n/).map(safeRelativePath).filter(Boolean));
}

async function isBinaryFile(file, fsApi) {
  let handle;
  try {
    handle = await fsApi.open(file, "r");
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch { return true; }
  finally { await handle?.close().catch(() => {}); }
}

function excludedEntry(filePath, reason, kind, sizeBytes = 0) { return Object.freeze({ path: safeRelativePath(filePath) || String(filePath), reason, kind, sizeBytes }); }
function relative(root, target) { return path.relative(root, target).replaceAll("\\", "/"); }
function safeRelativePath(value) { const normalized = String(value || "").replaceAll("\\", "/").replace(/^\.\//, ""); return !normalized || normalized.startsWith("/") || normalized.split("/").includes("..") ? null : normalized; }
function samePath(a, b) { return process.platform === "win32" ? String(a).toLowerCase() === String(b).toLowerCase() : String(a) === String(b); }
function hashPath(value) { return crypto.createHash("sha256").update(process.platform === "win32" ? value.toLowerCase() : value).digest("hex").slice(0, 20); }
function workspaceFingerprint(_root, detection, git) { return crypto.createHash("sha256").update(JSON.stringify({ packageName: detection.packageName, primary: detection.primary, manifests: detection.manifests, gitHead: git.head })).digest("hex"); }

function defaultRunProcess(command, args, { input = null, acceptedExitCodes = [0], timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: "", errorCode: error.code || "spawn_error", accepted: false });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = Number(code ?? -1);
      resolve({ exitCode, stdout: stdout.slice(0, 2_000_000), stderr: stderr.slice(0, 20_000), errorCode: null, accepted: acceptedExitCodes.includes(exitCode) });
    });
    if (input !== null) child.stdin.end(input); else child.stdin.end();
  });
}

module.exports = {
  METADATA_KEY,
  WORKSPACE_MODES,
  FUNCTIONAL_WORKSPACE_MODES,
  EXCLUDED_DIRECTORIES,
  LocalWorkspaceError,
  LocalWorkspaceRegistry,
  workspaceModeCapability,
  validateLocalFolder,
  detectProject,
  discoverPreviewCommands,
  inspectGit,
  parseGitStatus,
  inspectLocalWorkspace,
  createImportManifest,
  defaultRunProcess,
};
