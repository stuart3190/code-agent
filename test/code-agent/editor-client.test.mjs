import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ThralloClient, parseEventBlock, describeEvent } = require("../../editor/vscode/lib/api.js");

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("editor client sends the bearer token and surfaces API errors", async () => {
  await withServer((req, res) => {
    if (req.url === "/api/v1/agents") {
      assert.equal(req.headers.authorization, "Bearer thrallo_pat_test");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ agents: [{ id: "a1", name: "Agent" }] }));
    }
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "budget spent", code: "budget_exceeded" }));
  }, async (base) => {
    const client = new ThralloClient({ serverUrl: `${base}/`, token: "thrallo_pat_test" });
    const { agents } = await client.listAgents();
    assert.equal(agents[0].id, "a1");
    await assert.rejects(client.createRun("a1", "do it"),
      (error) => error.code === "budget_exceeded" && error.status === 402);
  });
});

test("editor client streams and parses run events", async () => {
  await withServer((req, res) => {
    assert.match(req.url, /\/api\/v1\/runs\/r1\/events/);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("id: 1\nevent: run.queued\ndata: {\"sequence\":1,\"type\":\"run.queued\",\"payload\":{\"message\":\"Run queued\"}}\n\n");
    res.write(": heartbeat\n\n");
    res.write("id: 2\nevent: run.succeeded\ndata: {\"sequence\":2,\"type\":\"run.succeeded\",\"payload\":{\"message\":\"Run completed\"}}\n\n");
    res.end();
  }, async (base) => {
    const client = new ThralloClient({ serverUrl: base, token: "thrallo_pat_test" });
    const seen = [];
    const last = await client.streamRunEvents("r1", (event) => seen.push(event.type));
    assert.deepEqual(seen, ["run.queued", "run.succeeded"]);
    assert.equal(last, 2);
  });
});

test("event helpers tolerate malformed blocks and describe payloads", () => {
  assert.equal(parseEventBlock(": heartbeat"), null);
  assert.equal(parseEventBlock("data: not-json"), null);
  const described = describeEvent({ type: "tool.started", payload: { name: "read_file" } });
  assert.equal(described, "[tool.started] read_file");
});

test("client rejects non-http server URLs", () => {
  assert.throws(() => new ThralloClient({ serverUrl: "ftp://x", token: "t" }), /http/);
});

test("the extension is marketplace-packagable: metadata and assets are present", async () => {
  const { readFile, access } = await import("node:fs/promises");
  const root = new URL("../../editor/vscode/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(manifest.publisher, "thrallo");
  assert.equal(manifest.icon, "media/icon.png");
  assert.ok(manifest.repository?.url);
  assert.ok(manifest.categories.includes("AI"));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  for (const file of ["media/icon.png", "LICENSE.txt", "CHANGELOG.md", "README.md", "extension.js"]) {
    await access(new URL(file, root));
  }
  const icon = await readFile(new URL("media/icon.png", root));
  assert.deepEqual([...icon.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "icon must be a real PNG");
});
