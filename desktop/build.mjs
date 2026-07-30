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
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKOUT_DIR, ensureCheckout, prepare } from "./bootstrap.mjs";

const PLATFORMS = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: CHECKOUT_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      // The pin requires Node 24.18; allow close patch versions in dev builds.
      VSCODE_SKIP_NODE_VERSION_CHECK: process.env.VSCODE_SKIP_NODE_VERSION_CHECK || "1",
      NODE_OPTIONS: process.env.NODE_OPTIONS || "--max-old-space-size=8192",
    },
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
  run("npm", ["run", "compile"]);
} else if (command === "dev") {
  requireCheckout();
  const script = process.platform === "win32" ? "scripts\\code.bat" : "./scripts/code.sh";
  run(script, process.argv.slice(3));
} else if (command === "package") {
  requireCheckout();
  if (!PLATFORMS.includes(platformArg)) {
    throw new Error(`--platform must be one of ${PLATFORMS.join(", ")}`);
  }
  run("npx", ["gulp", `vscode-${platformArg}-min`]);
  run("npx", ["gulp", `vscode-${platformArg}-archive`]);
  console.log(`\nUnsigned ${platformArg} build + archive complete (see ../VSCode-${platformArg} and ../vscode-${platformArg}.zip beside the checkout).`);
  if (platformArg.startsWith("darwin")) {
    console.log("Reminder: macOS output is UNVERIFIED until launched on a Mac, and public copy stays 'Coming soon to macOS'.");
  }
} else {
  console.log("commands: bootstrap | install | compile | dev | package [--platform <target>]");
  process.exitCode = command === "help" ? 0 : 1;
}
