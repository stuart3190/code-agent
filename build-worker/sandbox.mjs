import { readFile, mkdir, rm, symlink, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { flushDir } from "../src/engine/fileTree.mjs";
import { runProcess } from "./processTree.mjs";

const INPUT = process.env.THRALLO_JOB_INPUT || "/input/payload.json";
const OUTPUT = process.env.THRALLO_JOB_OUTPUT || "/work/result.json";
const WORK = process.env.THRALLO_JOB_WORK || "/work/project";
const DEPS = process.env.THRALLO_SCAFFOLD_NODE_MODULES || "/opt/scaffold/node_modules";
// The packaged application root: /app in the image; overridable so the packaged entrypoint can be
// executed against a disposable copy of the COPY set (test/code-agent/sandbox-packaged-entrypoint).
const ROOT = process.env.THRALLO_SANDBOX_ROOT || "/app";

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
  // The mandatory preview gate is the minimal smoke test (shell/server/lib/appBuild/smokeVerifier.mjs):
  // the preview opens, something renders without a fatal error, and visible controls can be
  // activated without crashing the app. The contracted journey verifier no longer grades a build.
  const { smokeVerifyJourneys } = await import("../shell/server/lib/appBuild/smokeVerifier.mjs");
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] });
  try {
    const journeys = await smokeVerifyJourneys({
      previewUrl: payload.previewUrl, contract: payload.contract || {},
      timeoutMs: Number(payload.journeyTimeoutMs || payload.timeoutMs) || 120_000, browser,
      log: (line) => console.log(line),
    });
    // `app` keeps the shape older evidence readers expect: one load check from the same run.
    const app = {
      pass: journeys.unavailable ? false : journeys.pass !== false,
      verifierPolicy: journeys.verifierPolicy,
      checks: [{ id: "load", label: "App loads", status: journeys.smoke?.load?.ok ? "pass" : "fail",
        detail: String(journeys.smoke?.load?.detail || "").slice(0, 300) }],
      verifierDefects: [], consoleErrors: journeys.consoleErrors, failedRequests: journeys.failedRequests,
      advisories: journeys.advisories, failures: journeys.fatalErrors,
      summary: journeys.smoke?.load?.ok ? "✓ App loads" : "✗ App loads",
    };
    return { ok: journeys.pass === true, app, journeys, exitCode: 0, stdout: "", stderr: "" };
  } finally {
    await browser.close().catch(() => {});
  }
}

// What this image IS, answered through the SAME path a real job takes — same image, same
// entrypoint, same runner. A provenance file read any other way proves nothing about the code
// that will actually grade a build. The baked record is returned alongside a live recomputation
// so a tampered or truncated image is caught rather than believed.
// Every job module this entrypoint loads lazily, by job type. The provenance job imports each one
// so that "the image can run browser_verify" is proven by loading browser_verify's code from the
// image, not inferred from a file list (browser_verify exited 1 with ERR_MODULE_NOT_FOUND on
// 2026-09-07 while every static check passed).
const JOB_MODULES = {
  compile: ["../src/engine/fileTree.mjs", "./processTree.mjs"],
  publish_package: ["../shell/server/lib/pwa.mjs", "@playwright/test"],
  browser_verify: ["../shell/server/lib/appBuild/smokeVerifier.mjs", "@playwright/test"],
  qa_browser: ["../shell/server/lib/qaRunner.mjs"],
  sandbox_provenance: ["../shell/server/lib/builderV2/sandboxProvenance.mjs"],
};

async function probeJobModules() {
  const entrypoints = {};
  for (const [job, specifiers] of Object.entries(JOB_MODULES)) {
    const failures = [];
    for (const specifier of specifiers) {
      try { await import(specifier); } catch (error) {
        failures.push({ specifier, code: error?.code || null, message: String(error?.message || error).slice(0, 300) });
      }
    }
    entrypoints[job] = failures.length ? { ok: false, failures } : { ok: true, modules: specifiers.length };
  }
  return entrypoints;
}

async function sandboxProvenance() {
  const { computeSandboxIdentity, readBakedProvenance, compareSandboxIdentity } =
    await import("../shell/server/lib/builderV2/sandboxProvenance.mjs");
  const observed = await computeSandboxIdentity({ root: ROOT, commit: process.env.SOURCE_COMMIT || null });
  const baked = await readBakedProvenance(ROOT);
  const consistent = compareSandboxIdentity(observed, baked || {});
  const entrypoints = await probeJobModules();
  const loadable = Object.values(entrypoints).every((row) => row.ok);
  return {
    ok: true, exitCode: 0, stdout: "", stderr: "",
    provenance: { ...observed, builtAt: baked?.builtAt || null, baked: Boolean(baked),
      bakedConsistent: consistent.compatible, entrypoints, entrypointsLoadable: loadable },
  };
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
  else if (envelope.jobType === "sandbox_provenance") result = await sandboxProvenance();
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
