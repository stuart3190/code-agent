// Private packaged-workbench smoke. It uses only a disposable local project and
// the deterministic D9-D14 product providers. It never requests a PAT or opens a
// Thrallo production service. Screenshots remain in the ignored private output.

import { _electron } from "playwright";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const executable = path.join(desktop, "VSCode-win32-x64", "Thrallo.exe");
const output = path.join(desktop, "out", "d15-private-smoke");
const workspace = path.join(output, "workspace");
const userData = path.join(output, "user-data");
const extensions = path.join(output, "extensions");
if (!existsSync(executable)) throw new Error(`Private package missing: ${executable}`);
rmSync(output, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(path.join(workspace, "fixture.js"), "// D15 disposable fixture\n");

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

async function step(name, operation) {
  try { record(name, true, String((await operation()) || "")); }
  catch (error) { record(name, false, String(error?.message || error).split(/\r?\n/)[0].slice(0, 180)); }
}

async function palette(window, command) {
  await window.keyboard.press("Control+Shift+p");
  const input = window.locator(".quick-input-widget input");
  await input.waitFor({ state: "visible", timeout: 20_000 });
  await input.fill(command);
  await window.waitForTimeout(700);
  await window.keyboard.press("Enter");
}

async function allFrameText(window) {
  const chunks = [];
  for (const frame of window.frames()) chunks.push(await frame.evaluate(() => document.body?.innerText || "").catch(() => ""));
  return chunks.join("\n");
}

async function verifySurface(window, command, pattern, screenshot) {
  await palette(window, command);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await window.waitForTimeout(400);
    const text = await allFrameText(window);
    if (pattern.test(text)) {
      await window.screenshot({ path: path.join(output, screenshot) });
      return pattern.source;
    }
  }
  throw new Error(`surface marker not found: ${pattern}`);
}

const app = await _electron.launch({
  executablePath: executable,
  args: ["--no-sandbox", "--disable-gpu-sandbox", "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, workspace],
  cwd: path.dirname(executable), timeout: 120_000,
});

let window;
try {
  window = await app.firstWindow({ timeout: 120_000 });
  await window.waitForSelector(".monaco-workbench", { timeout: 120_000 });
  await window.waitForTimeout(8_000);
  record("packaged workbench launch", true, await window.title());

  await step("Thrallo product identity", async () => {
    const title = await window.title();
    if (!/thrallo/i.test(title)) throw new Error(`unexpected title: ${title}`);
    return title;
  });

  await step("Code OSS file edit persists", async () => {
    await window.keyboard.press("Control+p");
    const input = window.locator(".quick-input-widget input");
    await input.waitFor({ state: "visible", timeout: 20_000 });
    await input.fill("fixture.js");
    await window.keyboard.press("Enter");
    await window.waitForSelector(".monaco-editor .view-lines", { timeout: 30_000 });
    await window.click(".monaco-editor .view-lines");
    await window.keyboard.press("Control+End");
    await window.keyboard.type("const d15Edited = true;");
    await window.keyboard.press("Control+s");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await window.waitForTimeout(300);
      if (readFileSync(path.join(workspace, "fixture.js"), "utf8").includes("d15Edited")) return "saved locally";
    }
    throw new Error("edit did not reach disposable project");
  });

  await step("integrated terminal runs in fixture root", async () => {
    await palette(window, "Terminal: Create New Terminal");
    await window.waitForSelector(".xterm", { timeout: 60_000 });
    await window.waitForTimeout(4_000);
    await window.keyboard.type("Set-Content -Path d15-terminal.txt -Value private-smoke");
    await window.keyboard.press("Enter");
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await window.waitForTimeout(400);
      if (existsSync(path.join(workspace, "d15-terminal.txt"))) return "fixture-root proof created";
    }
    throw new Error("terminal root proof missing");
  });

  const surfaces = [
    ["Thrallo: Open Home", /Recent local workspaces|Thrallo Desktop/, "01-home.png"],
    ["Thrallo: Open Conversation", /Build with Thrallo/, "02-conversation.png"],
    ["Thrallo: Open Projects", /Project launcher/, "03-projects.png"],
    ["Thrallo: Open Agent Activity", /Activity and control/, "04-agents.png"],
    ["Thrallo: Open Usage", /Usage and budget/, "05-usage.png"],
    ["Thrallo: Open Application Preview", /Application preview|Responsive viewport simulation/, "06-preview.png"],
    ["Thrallo: Open Deployments and Releases", /Deployments and releases|Release history/, "07-deployments.png"],
    ["Thrallo: Open Settings and Integrations", /Settings|Project environment/, "08-settings.png"],
    ["Thrallo: Open Companion Foundation", /Companion|What needs your attention/, "09-companion.png"],
  ];
  for (const [command, marker, screenshot] of surfaces) await step(`surface ${command}`, () => verifySurface(window, command, marker, screenshot));
} catch (error) {
  record("packaged smoke harness", false, String(error?.message || error));
} finally {
  await app.close().catch(() => {});
  for (const disposable of [workspace, userData, extensions]) {
    if (existsSync(disposable)) rmSync(disposable, { recursive: true, force: true });
  }
}

const summary = { schemaVersion: 1, classification: "PRIVATE_NOT_CUSTOMER_RELEASED", executable, workspace: "disposed", results, productionCredentialsUsed: false, productionNetworkRequired: false, screenshots: results.filter((item) => item.name.startsWith("surface ") && item.ok).length, processCleanup: "electron_closed_and_disposable_workspace_removed" };
writeFileSync(path.join(output, "results.json"), `${JSON.stringify(summary, null, 2)}\n`);
const failed = results.filter((item) => !item.ok);
console.log(`D15 packaged workbench smoke: ${results.length - failed.length}/${results.length}`);
process.exitCode = failed.length ? 1 : 0;
