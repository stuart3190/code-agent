// Thrallo Desktop build orchestrator. Windows x64 is the release priority; macOS and Linux
// targets are configured from the same pipeline but are NOT verified until built and
// smoke-tested on their platforms (see desktop/README.md for the honest status table).
//
//   node desktop/build.mjs bootstrap      clone pin + apply Thrallo overlay
//   node desktop/build.mjs install        npm ci inside the checkout (needs MSVC + Python on Windows)
//   node desktop/build.mjs compile        compile core + built-in extensions
//   node desktop/build.mjs dev            launch the editor from sources (scripts/code)
//   node desktop/build.mjs package [--platform win32-x64|darwin-x64|darwin-arm64|linux-x64]
//                                         minified build + archive (unsigned)
//
// Nothing here signs, notarises, or publishes anything.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKOUT_DIR, ensureCheckout, ensureCopilotFreeScripts, prepare, syncBuiltin, syncWebApp } from "./bootstrap.mjs";

const PLATFORMS = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];

// Windows packaging needs signtool.exe on PATH — not to SIGN anything (we ship unsigned), but
// because upstream's patchWin32DependenciesTask calls `signtool verify` and `signtool remove` to
// strip Authenticode signatures that rcedit would otherwise invalidate. Its helper REJECTS on
// spawn error instead of resolving false, so a missing SDK fails the whole build with a bare
// `spawn signtool.exe ENOENT`.
//
// Microsoft's own pipeline works around this by adding the Windows SDK to PATH before packaging.
// We do the same automatically: requiring a developer to have launched a specific shell is a
// reproducibility trap, and it is exactly why a build that worked on 31 July failed afterwards.
export function windowsSdkBinDir() {
  if (process.platform !== "win32") return null;
  if (spawnSync("where", ["signtool.exe"], { shell: true }).status === 0) return null; // already found

  const roots = [
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Windows Kits", "10", "bin"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Windows Kits", "10", "bin"),
  ].filter((dir) => existsSync(dir));

  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const candidates = [];
  for (const root of roots) {
    for (const entry of readdirSync(root)) {
      const candidate = path.join(root, entry, arch, "signtool.exe");
      if (existsSync(candidate)) candidates.push({ version: entry, dir: path.dirname(candidate) });
    }
  }
  if (!candidates.length) return null;
  // Newest SDK wins; version directories sort naturally (10.0.22621.0 < 10.0.26100.0).
  candidates.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  return candidates[candidates.length - 1].dir;
}

// Inno Setup, same problem as signtool: it installs to %LOCALAPPDATA%\Programs by default
// (a per-user install needs no admin), so it is not on PATH and the release step silently
// depended on the operator knowing where it lived. Discovered rather than assumed.
export function innoSetupCompiler() {
  if (process.platform !== "win32") return null;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Inno Setup 6", "ISCC.exe"),
    path.join(process.env.ProgramFiles || "", "Inno Setup 6", "ISCC.exe"),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

let sdkBinDirCache;
function buildEnv() {
  if (sdkBinDirCache === undefined) {
    sdkBinDirCache = windowsSdkBinDir();
    if (sdkBinDirCache) console.log(`[build] using Windows SDK tools from ${sdkBinDirCache}`);
  }
  return {
    ...process.env,
    // The pin requires Node 24.18; allow close patch versions in dev builds.
    VSCODE_SKIP_NODE_VERSION_CHECK: process.env.VSCODE_SKIP_NODE_VERSION_CHECK || "1",
    NODE_OPTIONS: process.env.NODE_OPTIONS || "--max-old-space-size=8192",
    ...(sdkBinDirCache ? { PATH: `${sdkBinDirCache}${path.delimiter}${process.env.PATH || ""}` } : {}),
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: CHECKOUT_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: buildEnv(),
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function requireCheckout() {
  if (!existsSync(path.join(CHECKOUT_DIR, "package.json"))) {
    throw new Error("desktop/vscode is missing — run: node desktop/build.mjs bootstrap");
  }
  // A usable checkout is one whose scripts match the overlay we applied to it. prepare() is
  // marker-guarded, so a checkout prepared before this fix would otherwise keep the broken
  // compile-copilot fan-out forever. Idempotent.
  ensureCopilotFreeScripts({ log: console.log });
}

const command = process.argv[2] || "help";
const platformArg = process.argv.includes("--platform")
  ? process.argv[process.argv.indexOf("--platform") + 1]
  : "win32-x64";

if (command === "bootstrap") {
  await ensureCheckout();
  await prepare();
} else if (command === "install") {
  requireCheckout();
  run("npm", ["ci"]);
} else if (command === "compile") {
  requireCheckout();
  syncBuiltin();
  syncWebApp();
  run("npm", ["run", "compile"]);
} else if (command === "dev") {
  requireCheckout();
  syncBuiltin();
  syncWebApp();
  const script = process.platform === "win32" ? "scripts\\code.bat" : "./scripts/code.sh";
  run(script, process.argv.slice(3));
} else if (command === "package") {
  requireCheckout();
  syncBuiltin();
  syncWebApp();
  if (!PLATFORMS.includes(platformArg)) {
    throw new Error(`--platform must be one of ${PLATFORMS.join(", ")}`);
  }
  run("npx", ["gulp", `vscode-${platformArg}-min`]);
  // The pinned build has no vscode-*-archive gulp task (upstream zips separately in CI),
  // so create the unsigned archive ourselves from the min output directory.
  const desktopDir = path.dirname(fileURLToPath(import.meta.url));
  const builtDir = path.resolve(desktopDir, `VSCode-${platformArg}`);
  if (!existsSync(builtDir)) {
    throw new Error(`expected build output at ${builtDir} — did the min task change its layout?`);
  }
  const outDir = path.join(desktopDir, "out");
  mkdirSync(outDir, { recursive: true });
  const archivePath = path.join(outDir, `thrallo-${platformArg}.zip`);
  rmSync(archivePath, { force: true });
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile", "-Command",
      `Compress-Archive -Path '${builtDir}\\*' -DestinationPath '${archivePath}' -CompressionLevel Optimal`,
    ], { cwd: desktopDir, shell: false });
  } else {
    run("zip", ["-qry", archivePath, path.basename(builtDir)], { cwd: path.dirname(builtDir) });
  }
  console.log(`\nUnsigned ${platformArg} build: ${builtDir}`);
  console.log(`Unsigned ${platformArg} archive: ${archivePath}`);
  if (platformArg.startsWith("darwin")) {
    console.log("Reminder: macOS output is UNVERIFIED until launched on a Mac, and public copy stays 'Coming soon to macOS'.");
  }
} else if (command === "installer") {
  // Turns the packaged folder into the shipped Windows installer. Previously a manual ISCC
  // invocation documented in the README, which is how the release step ended up depending on
  // the operator's shell — the same reproducibility trap as signtool.
  const desktopDir = path.dirname(fileURLToPath(import.meta.url));
  const builtDir = path.resolve(desktopDir, "VSCode-win32-x64");
  if (!existsSync(builtDir)) {
    throw new Error("no packaged build found — run: node desktop/build.mjs package --platform win32-x64");
  }
  const iscc = innoSetupCompiler();
  if (!iscc) {
    throw new Error(
      "Inno Setup 6 was not found. Install it (https://jrsoftware.org/isdl.php) — the default "
      + "per-user location %LOCALAPPDATA%\\Programs\\Inno Setup 6 is detected automatically.",
    );
  }
  console.log(`[build] using Inno Setup at ${iscc}`);
  const script = path.join(desktopDir, "installer", "Thrallo.iss");
  if (!existsSync(script)) throw new Error(`installer script missing: ${script}`);
  run(iscc, [script], { cwd: desktopDir, shell: false });

  const installer = path.join(desktopDir, "out", "Thrallo-Setup-x64.exe");
  if (!existsSync(installer)) {
    throw new Error(`Inno Setup reported success but produced no installer at ${installer}`);
  }
  console.log(`\nUnsigned Windows installer: ${installer}`);
} else {
  console.log("commands: bootstrap | install | compile | dev | package [--platform <target>] | installer");
  process.exitCode = command === "help" ? 0 : 1;
}
