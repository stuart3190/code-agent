import crypto from "node:crypto";
import { assertSyntheticPayload } from "./policy.mjs";

export function createSyntheticProject(seed = "thrallo-d4-synthetic-v1") {
  const marker = crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 16);
  const files = {
    "package.json": JSON.stringify({ name: "thrallo-d4-synthetic-app", private: true, type: "module", scripts: { start: "node server.mjs" } }, null, 2),
    "server.mjs": `import http from "node:http";\nconst port = Number(process.env.PORT || 4173);\nconst html = await import("node:fs/promises").then(fs => fs.readFile(new URL("./index.html", import.meta.url)));\nconst server = http.createServer((request, response) => {\n  if (request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, marker: "${marker}" })); return; }\n  if (request.url === "/intentional-404") { response.writeHead(404); response.end("missing"); return; }\n  response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); response.end(html);\n});\nserver.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ ready: true, port })));\nfor (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));\n`,
    "index.html": `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>D4 synthetic app</title></head><body><main data-marker="${marker}">Thrallo D4 synthetic workspace</main><script>console.log("d4-console-ready:${marker}");fetch("/intentional-404").then(r=>console.warn("d4-http-status:"+r.status));fetch("http://127.0.0.1:9/unreachable").catch(()=>console.error("d4-network-failure-observed"));</script></body></html>`,
    "worker.mjs": `const end = Date.now() + Number(process.argv[2] || 15000); let value = 0; while (Date.now() < end) { for (let i=0;i<50000;i++) value = (value + i) % 2147483647; await new Promise(r=>setTimeout(r, 5)); } console.log("worker-complete", value);`,
    "playwright-check.mjs": `import { chromium } from "playwright"; import fs from "node:fs/promises";\nconst baseURL = process.env.D4_BASE_URL || "http://127.0.0.1:4173"; const events = { console: [], requestFailed: [] };\nconst browser = await chromium.launch({ headless: true }); const context = await browser.newContext(); await context.tracing.start({ screenshots: true, snapshots: true }); const page = await context.newPage();\npage.on("console", message => events.console.push({ type: message.type(), text: message.text() })); page.on("requestfailed", request => events.requestFailed.push({ urlClass: request.url().includes("127.0.0.1:9") ? "intentional-local-failure" : "other", error: request.failure()?.errorText || "unknown" }));\nawait page.goto(baseURL, { waitUntil: "networkidle" }); const marker = await page.locator("main").getAttribute("data-marker"); await page.screenshot({ path: "artifacts/screenshot.png", fullPage: true }); await context.tracing.stop({ path: "artifacts/trace.zip" }); await browser.close();\nawait fs.writeFile("artifacts/result.json", JSON.stringify({ marker, events }, null, 2)); console.log(JSON.stringify({ marker, consoleEvents: events.console.length, requestFailures: events.requestFailed.length }));`,
  };
  assertSyntheticPayload(files);
  return { seed: String(seed), marker, files };
}

export function projectDigest(project) {
  const hash = crypto.createHash("sha256");
  for (const [name, content] of Object.entries(project.files).sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update("\0").update(content).update("\0");
  return hash.digest("hex");
}
