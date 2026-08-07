import { readFile, mkdir, rm, symlink, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { flushDir } from "../src/engine/fileTree.mjs";
import { runProcess } from "./processTree.mjs";

const INPUT = process.env.THRALLO_JOB_INPUT || "/input/payload.json";
const OUTPUT = process.env.THRALLO_JOB_OUTPUT || "/work/result.json";
const WORK = process.env.THRALLO_JOB_WORK || "/work/project";
const DEPS = process.env.THRALLO_SCAFFOLD_NODE_MODULES || "/opt/scaffold/node_modules";

async function compileTree(payload) {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(WORK, { recursive: true });
  await flushDir(payload.tree || {}, WORK);
  await symlink(DEPS, path.join(WORK, "node_modules"), "dir");
  const result = await runProcess("npm", ["run", "build"], {
    cwd: WORK,
    env: { PATH: process.env.PATH, HOME: "/tmp/home", TMPDIR: "/tmp", CI: "1", NODE_ENV: "production" },
    wallMs: Number(payload.wallMs) || 300_000,
    outputBytes: Number(payload.outputBytes) || 4 * 1024 * 1024,
  });
  if (result.ok && payload.renderIcons) {
    const { chromium } = await import("@playwright/test");
    const { renderIcons } = await import("../shell/server/lib/pwa.mjs");
    const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
    try {
      await renderIcons({
        appName: payload.appName, tree: payload.tree, iconGlyph: payload.iconGlyph || null,
        distDir: path.join(WORK, "dist"),
        renderer: async (htmlPath, outPath, size) => {
          const page = await browser.newPage({ viewport: { width: size, height: size } });
          try { await page.goto(`file://${htmlPath}`); await page.screenshot({ path: outPath }); }
          finally { await page.close(); }
        },
      });
    } finally { await browser.close(); }
  }
  if (result.ok && payload.copyDist) {
    await cp(path.join(WORK, "dist"), "/work/artifact", { recursive: true, force: true });
  }
  return result;
}

async function browserVerify(payload) {
  const { verifyApp } = await import("../shell/server/lib/appBuild/verificationAgent.mjs");
  const { verifyJourneys } = await import("../shell/server/lib/appBuild/journeyVerifier.mjs");
  const app = await verifyApp({
    previewUrl: payload.previewUrl, usesBackend: payload.usesBackend !== false,
    timeoutMs: Number(payload.timeoutMs) || 180_000,
  });
  const journeys = payload.contract?.journeys?.length
    ? await verifyJourneys({ previewUrl: payload.previewUrl, contract: payload.contract, timeoutMs: Number(payload.timeoutMs) || 180_000 })
    : null;
  return { ok: app.pass !== false && (!journeys || journeys.pass !== false), app, journeys, exitCode: 0, stdout: "", stderr: "" };
}

async function qaBrowser(payload) {
  const { runQaBrowser } = await import("../shell/server/lib/qaRunner.mjs");
  const report = await runQaBrowser({ previewUrl: payload.previewUrl, runId: payload.runId, artifactRoot: "/work/qa" });
  return { ok: true, report, exitCode: 0, stdout: "", stderr: "" };
}

async function proofSlow(payload) {
  const durationMs = Math.max(100, Math.min(120_000, Number(payload.durationMs) || 1_000));
  const script = payload.spawnGrandchild
    ? `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('grandchild:'+c.pid); setTimeout(()=>{},${durationMs});`
    : `console.log(${JSON.stringify(String(payload.phase || "slow"))}); setTimeout(()=>{},${durationMs});`;
  return runProcess(process.execPath, ["-e", script], {
    cwd: "/work", env: { PATH: process.env.PATH, HOME: "/tmp/home", TMPDIR: "/tmp" },
    wallMs: Number(payload.wallMs) || durationMs + 5_000,
    outputBytes: Number(payload.outputBytes) || 1024 * 1024,
  });
}

async function main() {
  const envelope = JSON.parse(await readFile(INPUT, "utf8"));
  const payload = envelope.payload || {};
  let result;
  if (["compile", "publish_package", "dependency_install"].includes(envelope.jobType)) {
    if (envelope.jobType === "dependency_install") {
      await rm(WORK, { recursive: true, force: true }); await mkdir(WORK, { recursive: true });
      await writeFile(path.join(WORK, "package.json"), JSON.stringify(payload.packageJson || {}, null, 2));
      result = await runProcess("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
        cwd: WORK, env: { PATH: process.env.PATH, HOME: "/tmp/home", TMPDIR: "/tmp", CI: "1" },
        wallMs: Number(payload.wallMs) || 600_000, outputBytes: Number(payload.outputBytes) || 4 * 1024 * 1024,
      });
    } else result = await compileTree({
      ...payload,
      copyDist: envelope.jobType === "publish_package",
      renderIcons: envelope.jobType === "publish_package" && payload.renderIcons !== false,
    });
  } else if (envelope.jobType === "browser_verify") result = await browserVerify(payload);
  else if (envelope.jobType === "qa_browser") result = await qaBrowser(payload);
  else if (envelope.jobType === "proof_slow") result = await proofSlow(payload);
  else throw new Error(`sandbox does not support ${envelope.jobType}`);
  await writeFile(OUTPUT, JSON.stringify(result), "utf8");
  if (result.ok === false) process.exitCode = result.exitCode || 1;
}

main().catch(async (error) => {
  await writeFile(OUTPUT, JSON.stringify({ ok: false, exitCode: 1, classification: error.classification || "sandbox_error", stdout: "", stderr: String(error.stack || error) }), "utf8").catch(() => {});
  process.exitCode = 1;
});
