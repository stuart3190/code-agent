import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";

test("real shell serves Thrallo capabilities and production SPA", { timeout: 15_000 }, async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["shell/server/index.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, SHELL_PORT: String(port), CODE_AGENT_WORKER: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(() => {
    if (child.exitCode == null) child.kill("SIGTERM");
  });

  const capabilities = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/capabilities`);
    if (!response.ok) throw new Error(`capabilities returned ${response.status}`);
    return response.json();
  }, () => output);
  assert.equal(capabilities.product, "Thrallo");
  assert.equal(capabilities.apiVersion, "v1");

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Thrallo/);
});
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function eventually(fn, diagnostics) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await fn(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${lastError?.message || "server did not start"}\n${diagnostics()}`);
}
