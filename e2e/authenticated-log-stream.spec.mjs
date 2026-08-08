import { test, expect } from "@playwright/test";
import http from "node:http";
import { once } from "node:events";
import { handleLogsStream } from "../shell/server/routes/logs.mjs";

let server; let origin; const requests = [];
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/") return res.end("<!doctype html><title>stream proof</title>");
    if (!req.url.startsWith("/api/v1/projects/project-a/logs/stream")) { res.writeHead(404); return res.end(); }
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (req.headers.authorization !== "Bearer browser-session-token") { res.writeHead(401); return res.end(); }
    let emitted = false;
    return handleLogsStream(req, res, { id: "owner-a" }, "project-a", new URL(req.url, "http://proof"), {
      tickMs: 15,
      readSinceFn: async () => {
        if (emitted) return { entries: [] };
        emitted = true;
        return { entries: [{ id: "log-1", at: "2026-08-08T18:30:00.000Z", level: "info", source: "build", message: "ready" }] };
      },
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { server.close(); await once(server, "close"); });

test("authenticated browser fetch receives and closes the real SSE handler without query credentials", async ({ page }) => {
  await page.goto(origin);
  const entry = await page.evaluate(async (base) => {
    const response = await fetch(`${base}/api/v1/projects/project-a/logs/stream`, {
      headers: { Authorization: "Bearer browser-session-token", Accept: "text/event-stream" },
    });
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) throw new Error("stream ended before a log");
      buffer += decoder.decode(value, { stream: true });
      const match = /event: log\ndata: (.+)\n\n/.exec(buffer);
      if (match) { await reader.cancel(); return JSON.parse(match[1]); }
    }
  }, origin);
  expect(entry.message).toBe("ready");
  expect(requests).toHaveLength(1);
  expect(requests[0].authorization).toBe("Bearer browser-session-token");
  expect(requests[0].url).not.toMatch(/token|bearer/i);
});
