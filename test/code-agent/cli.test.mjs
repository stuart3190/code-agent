import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";

import { parseArgs, runCli } from "../../cli/lib/cli.mjs";

function harness({ config = { server: null, token: "thrallo_pat_test" }, answers = [] } = {}) {
  const lines = [];
  const saved = [];
  return {
    lines,
    saved,
    options: (server) => ({
      config: config ? { ...config, server: config.server ?? server } : null,
      stdout: (line) => lines.push(line),
      prompt: async () => answers.shift() ?? "",
      persistConfig: (value) => { saved.push(value); return "/tmp/config.json"; },
      removeConfig: () => true,
    }),
  };
}

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

function json(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

test("argument parsing separates commands, positionals, and flags", () => {
  const parsed = parseArgs(["run", "fix", "the", "bug", "--repo", "o/r", "--yes"]);
  assert.equal(parsed.command, "run");
  assert.deepEqual(parsed.positional, ["fix", "the", "bug"]);
  assert.equal(parsed.flags.repo, "o/r");
  assert.equal(parsed.flags.yes, true);
});

test("version prints the repository package version without a stored connection", async () => {
  const { version } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const { lines, options } = harness({ config: null });
  const code = await runCli(["version"], options("http://x"));
  assert.equal(code, 0);
  assert.deepEqual(lines, [version]);
});

test("help lists the version command", async () => {
  const { lines, options } = harness({ config: null });
  const code = await runCli(["help"], options("http://x"));
  assert.equal(code, 0);
  assert.match(lines[0], /^\s*version\s+Print the Thrallo package version$/m);
});

test("login validates the token shape and stores the config after a probe", async () => {
  await withServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer thrallo_pat_good");
    json(res, 200, { agents: [] });
  }, async (base) => {
    const { lines, saved, options } = harness({ config: null });
    const bad = await runCli(["login", "--server", base, "--token", "wrong"], options(base));
    assert.equal(bad, 1);
    const ok = await runCli(["login", "--server", base, "--token", "thrallo_pat_good"], options(base));
    assert.equal(ok, 0);
    assert.equal(saved[0].token, "thrallo_pat_good");
    assert.ok(lines.some((line) => line.includes("Connected")));
  });
});

test("commands require a stored connection", async () => {
  const { lines, options } = harness({ config: null });
  const code = await runCli(["repos"], options("http://x"));
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.includes("thrallo login")));
});

test("run streams the timeline and approves the pull request on confirmation", async () => {
  const calls = [];
  await withServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === "/api/v1/agents" && req.method === "GET") {
      return json(res, 200, { agents: [{ id: "a1", name: "Builder", mode: "agent", repositoryId: "r1" }] });
    }
    if (req.url === "/api/v1/repositories") {
      return json(res, 200, { repositories: [{ id: "r1", fullName: "o/r", status: "ready" }] });
    }
    if (req.url === "/api/v1/agents/a1/runs" && req.method === "POST") {
      return json(res, 202, { run: { id: "run1", state: "queued" } });
    }
    if (req.url.startsWith("/api/v1/runs/run1/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: {\"sequence\":1,\"type\":\"run.running\",\"payload\":{\"message\":\"Agent is working\"}}\n\n");
      return res.end();
    }
    if (req.url === "/api/v1/runs/run1" && req.method === "GET") {
      return json(res, 200, {
        run: {
          id: "run1", state: "waiting_for_approval",
          result: { approval: { required: true, action: "create_pull_request" } },
        },
      });
    }
    if (req.url === "/api/v1/runs/run1/publish") {
      return json(res, 200, {
        run: {
          id: "run1", state: "succeeded",
          result: { publication: { pullRequest: { number: 4, url: "https://pr/4" } } },
        },
      });
    }
    json(res, 404, { error: "nope" });
  }, async (base) => {
    const { lines, options } = harness({ answers: ["y"] });
    const code = await runCli(["run", "fix", "it"], options(base));
    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes("Agent is working")));
    assert.ok(lines.some((line) => line.includes("https://pr/4")));
    assert.ok(calls.includes("POST /api/v1/runs/run1/publish"));
  });
});

test("review resolves a reviewer agent by repo and declines cleanly", async () => {
  const calls = [];
  await withServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.url === "/api/v1/agents" && req.method === "GET") return json(res, 200, { agents: [] });
    if (req.url === "/api/v1/repositories") {
      return json(res, 200, { repositories: [{ id: "r1", fullName: "o/r", status: "ready" }] });
    }
    if (req.url === "/api/v1/agents" && req.method === "POST") {
      return json(res, 201, { agent: { id: "rev1", name: "Reviewer", mode: "review", repositoryId: "r1" } });
    }
    if (req.url === "/api/v1/agents/rev1/runs" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        assert.equal(parsed.pullRequestNumber, 9);
        assert.equal(parsed.mode, "review");
        json(res, 202, { run: { id: "run9", state: "queued" } });
      });
      return undefined;
    }
    if (req.url.startsWith("/api/v1/runs/run9/events")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end();
    }
    if (req.url === "/api/v1/runs/run9" && req.method === "GET") {
      return json(res, 200, {
        run: {
          id: "run9", state: "waiting_for_approval",
          result: {
            approval: { action: "post_review" }, verdict: "comment",
            findings: [{ severity: "minor", path: "a.js", line: 3, title: "Nit" }],
          },
        },
      });
    }
    if (req.url === "/api/v1/runs/run9/cancel") {
      return json(res, 202, { run: { id: "run9", state: "cancelled" } });
    }
    json(res, 404, { error: "nope" });
  }, async (base) => {
    const { lines, options } = harness({ answers: ["n"] });
    const code = await runCli(["review", "9", "--repo", "o/r"], options(base));
    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes("[minor] a.js:3")));
    assert.ok(calls.includes("POST /api/v1/runs/run9/cancel"));
    assert.ok(!calls.some((call) => call.includes("publish")));
  });
});

test("usage prints plan and budget meters", async () => {
  await withServer((req, res) => {
    if (req.url === "/api/v1/billing") {
      return json(res, 200, {
        subscription: { planName: "Free", status: "active" },
        pastDue: false,
        budgets: {
          runs: { used: 2, limit: 20 },
          managedTokens: { used: 1000, limit: 1500000 },
          computeSeconds: { used: 60, limit: 10800 },
        },
        period: { end: "2026-08-01T00:00:00.000Z" },
      });
    }
    json(res, 404, { error: "nope" });
  }, async (base) => {
    const { lines, options } = harness();
    const code = await runCli(["usage"], options(base));
    assert.equal(code, 0);
    assert.ok(lines.some((line) => line.includes("Plan: Free")));
    assert.ok(lines.some((line) => line.includes("runs: 2 / 20")));
  });
});
