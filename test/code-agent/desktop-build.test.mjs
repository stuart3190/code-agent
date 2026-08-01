// Desktop build reproducibility.
//
// The 2026-08-01 audit found the shipped installer five merged PRs stale. Investigating why
// turned up two defects that made the release UNBUILDABLE from an ordinary shell:
//
//   1. `build.mjs compile` failed with ENOENT because bootstrap removes extensions/copilot but
//      upstream's root `compile` script still fanned out to `compile-copilot`.
//   2. `build.mjs package` failed with `spawn signtool.exe ENOENT` because upstream's
//      hasAuthenticodeSignature() REJECTS on spawn error, and the Windows SDK is not on PATH
//      unless the operator happens to have opened a developer shell.
//
// Both were invisible to CI because nothing exercised the desktop build. These tests cannot run
// a 10-minute Electron build, but they can assert the fixes exist and stay correct — and that
// the tool discovery actually resolves on a machine that has the tools.

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("the copilot compile task is stripped from any checkout before it is used", async () => {
  const bootstrap = await import("../../desktop/bootstrap.mjs");
  assert.equal(typeof bootstrap.ensureCopilotFreeScripts, "function");

  // requireCheckout() runs it on every compile/dev/package, not just bootstrap — prepare() is
  // marker-guarded, so a checkout prepared before the fix would otherwise never receive it.
  const build = read("../../desktop/build.mjs");
  const requireBlock = build.slice(build.indexOf("function requireCheckout()"), build.indexOf("const command ="));
  assert.match(requireBlock, /ensureCopilotFreeScripts\(/,
    "every build path must repair the checkout's scripts, not only bootstrap");
});

test("stripping compile-copilot leaves the rest of the fan-out intact", async () => {
  const source = read("../../desktop/bootstrap.mjs");
  const fn = source.slice(source.indexOf("export function ensureCopilotFreeScripts"), source.indexOf("export async function prepare"));
  // It must edit the script in place rather than blanking it — `compile` still needs
  // compile-client.
  assert.match(fn, /filter\(\(token\) => token !== "compile-copilot"\)/);
  assert.match(fn, /delete scripts\["compile-copilot"\]/);
  assert.doesNotMatch(fn, /scripts\.compile = ""/);
});

test("the packaged checkout no longer carries the broken task", { skip: !existsSync(fileURLToPath(new URL("../../desktop/vscode/package.json", import.meta.url))) }, () => {
  const pkg = JSON.parse(read("../../desktop/vscode/package.json"));
  assert.ok(!pkg.scripts["compile-copilot"], "compile-copilot must be gone from the checkout");
  assert.doesNotMatch(pkg.scripts.compile || "", /compile-copilot/);
  assert.match(pkg.scripts.compile || "", /compile-client/, "the real compile task must survive");
});

test("Windows SDK discovery resolves without a developer shell", async () => {
  const { windowsSdkBinDir } = await import("../../desktop/build.mjs");
  assert.equal(typeof windowsSdkBinDir, "function");
  if (process.platform !== "win32") {
    assert.equal(windowsSdkBinDir(), null, "non-Windows platforms need no SDK");
    return;
  }
  const onPath = spawnSync("where", ["signtool.exe"], { shell: true }).status === 0;
  const discovered = windowsSdkBinDir();
  if (onPath) {
    assert.equal(discovered, null, "nothing to add when signtool is already reachable");
    return;
  }
  // The case that broke the release: not on PATH, so discovery must find it.
  assert.ok(discovered, "signtool.exe is not on PATH and was not discovered — packaging would fail");
  assert.ok(existsSync(path.join(discovered, "signtool.exe")),
    `discovered directory does not contain signtool.exe: ${discovered}`);
});

test("Inno Setup is discovered rather than assumed to be on PATH", async () => {
  const { innoSetupCompiler } = await import("../../desktop/build.mjs");
  assert.equal(typeof innoSetupCompiler, "function");
  if (process.platform !== "win32") return;
  const iscc = innoSetupCompiler();
  // Its default install is per-user (%LOCALAPPDATA%\Programs), which is never on PATH — the
  // reason the installer step used to be a manual instruction in the README.
  if (iscc) assert.ok(existsSync(iscc), `discovered ISCC path does not exist: ${iscc}`);
});

test("build.mjs exposes an installer command so the release is one pipeline", () => {
  const build = read("../../desktop/build.mjs");
  assert.match(build, /command === "installer"/);
  assert.match(build, /Thrallo-Setup-x64\.exe/);
  // It must FAIL when Inno Setup produced nothing, rather than reporting success.
  assert.match(build, /reported success but produced no installer/);
  assert.match(build, /commands: bootstrap \| install \| compile \| dev \| package .* \| installer/);
});

test("the release version comes from one source, so the update notice can work", () => {
  const script = read("../../scripts/build-release-manifest.mjs");
  // The first release was published as the Code-OSS pin (1.131.0), which never changes between
  // Thrallo releases — so an installed copy could never tell it was out of date. Verified live:
  // the notice fired permanently against a packaged 0.4.0.
  assert.match(script, /editor\/vscode\/package\.json/,
    "the manifest version must default to the packaged app's own version");
  assert.match(script, /WARNING: publishing/,
    "an explicit mismatched version must warn rather than silently break the notice");
});

test("the update notice compares the packaged version with the published one", () => {
  const shell = read("../../shell/web/src/chat/ChatShell.jsx");
  const block = shell.slice(shell.indexOf("function DesktopUpdateNotice"), shell.indexOf("// Stop a running build"));
  assert.match(block, /__THRALLO_DESKTOP__/, "web users must never see it");
  assert.match(block, /api\/v1\/downloads/);
  assert.match(block, /numeric: true/, "0.10.0 must sort above 0.9.0");
  assert.match(block, /catch\(\(\) => \{\}\)/, "an offline desktop says nothing rather than erroring");

  // And the extension must actually supply the version, or the notice can never render.
  const panel = read("../../editor/vscode/lib/conversationPanel.js");
  assert.match(panel, /version = null/);
  assert.match(panel, /token, email, version/);
  const extension = read("../../editor/vscode/extension.js");
  assert.match(extension, /packageJSON\?\.version/);
});
