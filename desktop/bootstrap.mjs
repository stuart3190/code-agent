// Thrallo Desktop bootstrap: fetches the pinned Code - OSS commit into desktop/vscode
// (gitignored — the upstream tree is never committed here) and injects the Thrallo product
// identity on top of it. Idempotent: re-running verifies the pin and re-applies the overlay.
//
//   node desktop/bootstrap.mjs            clone/verify + prepare
//   node desktop/bootstrap.mjs --verify   check only, no changes (used by tests)
//
// What "prepare" changes inside the checkout (and nothing else):
//   1. product.json         — merged with product.overrides.json (branding, Open VSX gallery,
//                             thrallo protocol, telemetry off, updates off until a server exists)
//   2. resources/           — win32 .ico, linux .png, darwin .icns replaced with Thrallo assets
//   3. extensions/thrallo/  — the repository's editor/vscode extension copied in as a built-in
// A marker (.thrallo-prepared) records the overlay hash so unchanged re-runs are no-ops.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(DESKTOP_DIR);
export const CHECKOUT_DIR = path.join(DESKTOP_DIR, "vscode");

export function upstream() {
  return JSON.parse(readFileSync(path.join(DESKTOP_DIR, "upstream.json"), "utf8"));
}

export function productOverrides() {
  return JSON.parse(readFileSync(path.join(DESKTOP_DIR, "product.overrides.json"), "utf8"));
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function checkoutCommit() {
  if (!existsSync(path.join(CHECKOUT_DIR, ".git"))) return null;
  try { return git(["rev-parse", "HEAD"], CHECKOUT_DIR); } catch { return null; }
}

export async function ensureCheckout({ log = console.log } = {}) {
  const pin = upstream();
  const current = checkoutCommit();
  if (current === pin.commit) {
    log(`checkout OK at ${pin.tag} (${pin.commit.slice(0, 10)})`);
    return CHECKOUT_DIR;
  }
  if (current) {
    throw new Error(`desktop/vscode is at ${current}, expected ${pin.commit}. Delete desktop/vscode to re-bootstrap.`);
  }
  log(`cloning ${pin.repository} at ${pin.tag} (shallow)…`);
  mkdirSync(DESKTOP_DIR, { recursive: true });
  execFileSync("git", [
    "clone", "--depth", "1", "--branch", pin.tag, pin.repository, CHECKOUT_DIR,
  ], { stdio: "inherit" });
  const cloned = checkoutCommit();
  if (cloned !== pin.commit) {
    rmSync(CHECKOUT_DIR, { recursive: true, force: true });
    throw new Error(`cloned commit ${cloned} does not match pinned ${pin.commit}; refusing to continue`);
  }
  log(`checkout OK at ${pin.tag} (${pin.commit.slice(0, 10)})`);
  return CHECKOUT_DIR;
}

// The overlay hash covers everything prepare() writes, so any change re-applies cleanly.
// The builtin extension mirrors editor/vscode VERBATIM. Runs at prepare AND before every
// dev/compile/package (the prepare marker hashes the COMMITTED tree, so uncommitted
// extension work would otherwise never reach the builtin).
export function syncBuiltin({ log = console.log } = {}) {
  const builtinDir = path.join(CHECKOUT_DIR, "extensions", "thrallo");
  rmSync(builtinDir, { recursive: true, force: true });
  cpSync(path.join(REPO_ROOT, "editor", "vscode"), builtinDir, {
    recursive: true,
    filter: (source) => !/thrallo-.*\.vsix$/.test(source) && !source.includes("node_modules"),
  });
  log("built-in extension copied to extensions/thrallo");
  // The copy just wiped media/app — the web bundle must always ride along.
  syncWebApp({ log });
}

// Phase 23: the conversation surface is the SAME built web bundle the product ships —
// copied into the builtin extension as media/app. Runs at prepare AND before every
// dev/compile/package so a fresh `npm run build:web` always reaches the desktop.
export function syncWebApp({ log = console.log } = {}) {
  const dist = path.join(REPO_ROOT, "shell", "web", "dist");
  if (!existsSync(path.join(dist, "index.html"))) {
    throw new Error("shell/web/dist is missing — run `npm run build:web` before building the desktop");
  }
  const target = path.join(CHECKOUT_DIR, "extensions", "thrallo", "media", "app");
  rmSync(target, { recursive: true, force: true });
  cpSync(dist, target, { recursive: true, filter: (source) => !/[\\/]design([\\/]|$)/.test(path.relative(dist, source)) });
  log("web bundle synced into extensions/thrallo/media/app");
}

export function overlayHash() {
  const hash = createHash("sha256");
  hash.update(readFileSync(path.join(DESKTOP_DIR, "product.overrides.json")));
  for (const asset of ["thrallo.ico", "thrallo-512.png", "thrallo.icns"]) {
    hash.update(readFileSync(path.join(DESKTOP_DIR, "assets", asset)));
  }
  hash.update(git(["rev-parse", "HEAD:editor/vscode"], REPO_ROOT));
  return hash.digest("hex");
}

export function mergedProduct() {
  const stock = JSON.parse(readFileSync(path.join(CHECKOUT_DIR, "product.json.orig"), "utf8"));
  return { ...stock, ...productOverrides() };
}

export async function prepare({ log = console.log } = {}) {
  const markerPath = path.join(CHECKOUT_DIR, ".thrallo-prepared");
  const expected = overlayHash();
  if (existsSync(markerPath) && readFileSync(markerPath, "utf8").trim() === expected) {
    log("overlay already applied");
    return;
  }

  // Keep the pristine product.json so re-merges never compound.
  const productPath = path.join(CHECKOUT_DIR, "product.json");
  const pristinePath = path.join(CHECKOUT_DIR, "product.json.orig");
  if (!existsSync(pristinePath)) cpSync(productPath, pristinePath);
  writeFileSync(productPath, `${JSON.stringify(mergedProduct(), null, "\t")}\n`);
  log("product.json overlaid (Thrallo identity, Open VSX gallery, telemetry off)");

  const assets = path.join(DESKTOP_DIR, "assets");
  cpSync(path.join(assets, "thrallo.ico"), path.join(CHECKOUT_DIR, "resources", "win32", "code.ico"));
  cpSync(path.join(assets, "thrallo-512.png"), path.join(CHECKOUT_DIR, "resources", "linux", "code.png"));
  cpSync(path.join(assets, "thrallo.icns"), path.join(CHECKOUT_DIR, "resources", "darwin", "code.icns"));
  log("icons replaced (win32/linux/darwin)");

  // Thrallo ships its own agent; the upstream copilot built-in is a Microsoft service
  // integration and its vendored cross-platform binaries also break win32 packaging
  // (rcedit cannot patch the bundled Linux .node files).
  rmSync(path.join(CHECKOUT_DIR, "extensions", "copilot"), { recursive: true, force: true });
  log("removed upstream copilot built-in extension");

  // The packaging pipeline hard-requires the copilot builtin in one place; make that step
  // tolerate its removal. Idempotent text patch, applied only when the guard is absent.
  const copilotLibPath = path.join(CHECKOUT_DIR, "build", "lib", "copilot.ts");
  const copilotLib = readFileSync(copilotLibPath, "utf8");
  const guard = "\n\tif (!fs.existsSync(builtInCopilotExtensionDir)) { return; } // thrallo: copilot builtin removed";
  const shimSignature = "export function prepareBuiltInCopilotRipgrepShim(platform: string, arch: string, builtInCopilotExtensionDir: string, appNodeModulesDir: string): void {";
  if (!copilotLib.includes("thrallo: copilot builtin removed")) {
    if (!copilotLib.includes(shimSignature)) {
      throw new Error("copilot.ts shim signature changed upstream; update the bootstrap patch");
    }
    writeFileSync(copilotLibPath, copilotLib.replace(shimSignature, shimSignature + guard));
    log("patched build/lib/copilot.ts to tolerate the removed builtin");
  }

  syncBuiltin({ log });

  writeFileSync(markerPath, `${expected}\n`);
  log("prepare complete");
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const verifyOnly = process.argv.includes("--verify");
  if (verifyOnly) {
    const pin = upstream();
    const current = checkoutCommit();
    if (current !== pin.commit) {
      console.error(`verify FAILED: checkout at ${current || "(missing)"}, expected ${pin.commit}`);
      process.exitCode = 1;
    } else {
      console.log(`verify OK: ${pin.tag} (${pin.commit.slice(0, 10)})`);
    }
  } else {
    await ensureCheckout();
    await prepare();
  }
}
