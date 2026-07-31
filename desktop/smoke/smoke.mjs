// Thrallo Desktop smoke test: drives the ACTUAL built editor (dev Electron build) with
// Playwright and proves the non-negotiables — a real local folder opens, a file edit hits
// disk, the integrated terminal executes a command, and the built-in Thrallo extension signs
// in against https://app.thrallo.com with a real API token and lists agents.
//
//   node desktop/smoke/smoke.mjs
//
// Prereqs: `node desktop/build.mjs bootstrap|install|compile` done plus `npm run electron`,
// and a Thrallo API token in THRALLO_SMOKE_TOKEN (or ~/.thrallo-dogfood-token). Steps are
// isolated: one failure does not skip the rest. Screenshots land in desktop/out/smoke/.

import { _electron } from "playwright";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHECKOUT = path.join(DESKTOP, "vscode");
const OUT = path.join(DESKTOP, "out", "smoke");
mkdirSync(OUT, { recursive: true });

const results = [];
function record(step, ok, detail = "") {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? ` — ${detail}` : ""}`);
}

// THRALLO_SMOKE_PACKAGED=1 targets the packaged min build instead of the dev build.
const PACKAGED = process.env.THRALLO_SMOKE_PACKAGED === "1";

function electronExecutable() {
  if (PACKAGED) {
    const exe = path.join(DESKTOP, "VSCode-win32-x64", "Thrallo.exe");
    if (!existsSync(exe)) throw new Error("no packaged build — run `node desktop/build.mjs package` first");
    return exe;
  }
  const dir = path.join(CHECKOUT, ".build", "electron");
  const exe = readdirSync(dir).find((name) => name.endsWith(".exe"));
  if (!exe) throw new Error("no electron executable in .build/electron — run `npm run electron` first");
  return path.join(dir, exe);
}

const token = process.env.THRALLO_SMOKE_TOKEN
  || (existsSync(path.join(os.homedir(), ".thrallo-dogfood-token"))
    ? readFileSync(path.join(os.homedir(), ".thrallo-dogfood-token"), "utf8").trim()
    : null);

const workspace = path.join(OUT, "workspace");
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(path.join(workspace, "hello.js"), "// thrallo smoke fixture\n");

const userData = path.join(OUT, "user-data");
rmSync(userData, { recursive: true, force: true });

const executable = electronExecutable();
console.log(`launching ${path.basename(executable)}…`);
const app = await _electron.launch({
  executablePath: executable,
  args: [
    ...(PACKAGED ? [] : [CHECKOUT]),
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    `--user-data-dir=${userData}`,
    `--extensions-dir=${path.join(OUT, "extensions")}`,
    workspace,
  ],
  cwd: PACKAGED ? path.dirname(executable) : CHECKOUT,
  env: PACKAGED
    ? { ...process.env }
    : { ...process.env, VSCODE_DEV: "1", VSCODE_SKIP_NODE_VERSION_CHECK: "1" },
  timeout: 120_000,
});

async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === "string" ? detail : "");
  } catch (error) {
    record(name, false, String(error.message || error).split("\n")[0].slice(0, 140));
  }
}

async function shot(window, name) {
  await window.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
}

async function palette(window, command) {
  await window.keyboard.press("Control+Shift+p");
  await window.waitForSelector(".quick-input-widget input", { state: "visible", timeout: 15_000 });
  await window.keyboard.type(command, { delay: 40 });
  await window.waitForTimeout(1_200);
  await window.keyboard.press("Enter");
}

let window = null;
try {
  window = await app.firstWindow({ timeout: 120_000 });
  await window.waitForSelector(".monaco-workbench", { timeout: 120_000 });
  // Let the workbench, explorer, and extension host settle before driving the keyboard.
  await window.waitForTimeout(8_000);
  record("editor launches", true, path.basename(executable));
  await shot(window, "01-launched");

  await step("window title carries Thrallo product identity", async () => {
    const title = await window.title();
    if (!/thrallo/i.test(title)) throw new Error(`title: ${title}`);
    return title;
  });

  await step("real file edit reaches disk", async () => {
    await window.click(".monaco-workbench");
    await window.keyboard.press("Control+p");
    await window.waitForSelector(".quick-input-widget input", { state: "visible", timeout: 15_000 });
    await window.keyboard.type("hello.js", { delay: 50 });
    await window.waitForTimeout(1_500);
    await window.keyboard.press("Enter");
    await window.waitForSelector(".tab", { timeout: 20_000 });
    await window.click(".monaco-editor .view-lines");
    await window.keyboard.press("Control+End");
    await window.keyboard.type("const edited = true;", { delay: 15 });
    await window.keyboard.press("Control+s");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await window.waitForTimeout(500);
      if (readFileSync(path.join(workspace, "hello.js"), "utf8").includes("const edited = true;")) return;
    }
    throw new Error("saved content never appeared on disk");
  });
  await shot(window, "02-edited");

  await step("integrated terminal runs a command", async () => {
    await palette(window, "Terminal: Create New Terminal");
    await window.waitForSelector(".xterm", { timeout: 60_000 });
    await window.waitForTimeout(7_000);
    await window.keyboard.type("Set-Content -Path proof.txt -Value smoke-proof", { delay: 30 });
    await window.keyboard.press("Enter");
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await window.waitForTimeout(500);
      if (existsSync(path.join(workspace, "proof.txt"))) return;
    }
    throw new Error("proof.txt never appeared");
  });
  await shot(window, "03-terminal");

  await step("built-in Thrallo extension signs in and lists agents", async () => {
    if (!token) throw new Error("no token available (set THRALLO_SMOKE_TOKEN)");
    await palette(window, "Thrallo: Connect");
    await window.waitForSelector(".quick-input-widget input", { state: "visible", timeout: 15_000 });
    await window.keyboard.type(token, { delay: 2 });
    await window.keyboard.press("Enter");
    await window.waitForTimeout(5_000);
    await palette(window, "View: Show Thrallo");
    await window.waitForTimeout(5_000);
    const body = await window.textContent("body");
    if (!/Reviewer|code-agent/.test(body || "")) throw new Error("agents did not appear in the Thrallo view");
    return "agents listed in the Thrallo view";
  });
  await shot(window, "04-thrallo-signed-in");

  await step("conversation surface opens and hosts the web bundle", async () => {
    await palette(window, "Thrallo: Open Conversation");
    await window.waitForSelector('.tab[aria-label*="Thrallo Conversation"]', { timeout: 30_000 });
    // The webview should be up; give the bundle a moment, then look for the Begin screen
    // inside the nested webview frames (best-effort — frame nesting varies by build).
    await window.waitForTimeout(9_000);
    let inner = "";
    for (const frame of window.frames()) {
      try { inner += (await frame.evaluate(() => document.body?.innerText || "").catch(() => "")) + "\n"; } catch {}
    }
    if (/What are we building today\?|Welcome back/.test(inner)) {
      return "conversation bundle rendered (Begin screen text found in the webview)";
    }
    if (/Connect Thrallo/.test(inner)) throw new Error("panel still shows the connect prompt after sign-in");
    const frameCount = window.frames().length;
    if (frameCount < 2) throw new Error("no webview frame appeared for the conversation panel");
    throw new Error(`webview present but Begin screen not found (${frameCount} frames)`);
  });
  await shot(window, "05-conversation");
} catch (error) {
  record("smoke run", false, error.message);
} finally {
  if (window) await shot(window, "99-final");
  await app.close().catch(() => {});
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
process.exit(failed.length ? 1 : 0);
