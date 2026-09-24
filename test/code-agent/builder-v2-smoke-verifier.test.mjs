// The smoke verifier against a real browser: click-only behaviour on the Simple Counter.
//
// Needs Playwright's Chromium. In this repository that lives in the sandbox image, so run it as:
//   docker run --rm --user root --network none -v <tree>:/src -v <node_modules>:/src/node_modules:ro \
//     -w /src -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright --entrypoint node thrallo-build-sandbox:<tag> \
//     --test test/code-agent/builder-v2-smoke-verifier.test.mjs
// Without a browser the suite skips rather than fails.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { smokeVerifyJourneys } from "../../shell/server/lib/appBuild/smokeVerifier.mjs";
import { SMOKE_VERIFIER_POLICY, VERIFICATION_RESULT_CLASS } from "../../shell/server/lib/appBuild/verifierPolicy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(await readFile(path.join(HERE, "fixtures/retained/simple-20260924-counter/contract.json"), "utf8"));
const journeysOnly = { journeys: contract.journeys.map(({ id, title, priority }) => ({ id, title, priority })) };

// A counter whose labels are misspelled and whose arithmetic is WRONG on purpose: Increase adds 2,
// Decrease adds 1, Reset sets 7. Under the old gate every journey failed; the smoke gate only asks
// that these controls can be clicked without crashing the app.
const WRONG_COUNTER = `<!doctype html><html><head><meta charset="utf-8"><title>Simple Counter</title></head>
<body><div id="root"></div><script>
  const root = document.getElementById("root");
  let n = 0;
  const render = () => { root.innerHTML = '<main><h1>Simpel Countr</h1><output id="v">' + n + '</output>'
    + '<button id="inc">Incraese (+1)</button><button id="dec">Decrease (-1)</button><button id="rst">Reset</button>'
    + '<a href="https://example.com/away">Docs</a><a href="https://example.com/new" target="_blank">Blog</a>'
    + '<input aria-label="step" type="number" value="1"><select aria-label="mode"><option>a</option><option>b</option></select>'
    + '<label><input type="checkbox"> dark</label>'
    // Last on purpose: a same-origin full navigation moves the smoke to that page, and enumeration
    // is live, so anything after it on the first screen is never reached. That is fine for a smoke.
    + '<a href="/about">About</a></main>';
    root.querySelector("#inc").onclick = () => { n += 2; render(); };
    root.querySelector("#dec").onclick = () => { n += 1; render(); };
    root.querySelector("#rst").onclick = () => { n = 7; render(); };
  };
  render();
</script></body></html>`;

// Reset unmounts the app and throws: the one thing the smoke test must call a failure.
const CRASHING_COUNTER = WRONG_COUNTER.replace(
  'root.querySelector("#rst").onclick = () => { n = 7; render(); };',
  'root.querySelector("#rst").onclick = () => { root.innerHTML = ""; throw new TypeError("reset is not a function"); };',
);

const BLANK_APP = `<!doctype html><html><body><div id="root"></div><script>throw new Error("boot failed before render")</script></body></html>`;

function serve(pages) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = pages[req.url] ?? pages["/"];
      res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
      res.end(body || "not found");
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

let chromium = null;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser = null;
if (chromium) {
  try { browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--no-sandbox"] }); }
  catch (error) { console.log(`# smoke verifier browser tests skipped: ${String(error.message).split("\n")[0]}`); browser = null; }
}
const browserTest = (name, fn) => test(name, { skip: browser ? false : "no Playwright Chromium available" }, fn);
test.after(async () => { await browser?.close().catch(() => {}); });

browserTest("Simple Counter with wrong numbers and misspelled labels PASSES: controls click without a crash, nothing is read", async () => {
  const { server, url } = await serve({ "/": WRONG_COUNTER, "/about": "<html><body><div id='root'><a href='/'>home</a></div></body></html>" });
  try {
    const result = await smokeVerifyJourneys({ previewUrl: url, contract: journeysOnly, timeoutMs: 60_000, browser });
    assert.equal(result.pass, true, JSON.stringify(result.smoke));
    assert.equal(result.unavailable, false);
    assert.equal(result.verifierPolicy, SMOKE_VERIFIER_POLICY);
    assert.deepEqual(result.journeys.map((j) => [j.id, j.status, j.classification]),
      contract.journeys.map((j) => [j.id, "pass", VERIFICATION_RESULT_CLASS.PASS]));
    assert.ok(result.journeys.every((j) => j.steps.length === 0), "no contracted step is driven or judged");
    assert.ok(result.smoke.controls.activated >= 3, `at least the three buttons were clicked: ${JSON.stringify(result.smoke.controls)}`);
    assert.ok(result.smoke.controls.skipped.some((row) => row.reason === "external_link"), "the off-site link was skipped, not followed");
    assert.ok(result.smoke.controls.skipped.some((row) => row.reason === "leaves_the_page"), "the new-tab link was skipped");
    assert.ok(result.smoke.controls.activated >= 6, `buttons, number input, select and checkbox were all activated: ${JSON.stringify(result.smoke.controls)}`);
    assert.equal(result.fatalErrors.length, 0);
  } finally { server.close(); }
});

browserTest("a control whose activation blanks the app is a FATAL_RUNTIME_FAILURE on every journey", async () => {
  const { server, url } = await serve({ "/": CRASHING_COUNTER });
  try {
    const result = await smokeVerifyJourneys({ previewUrl: url, contract: journeysOnly, timeoutMs: 60_000, browser });
    assert.equal(result.pass, false, JSON.stringify(result.smoke));
    assert.equal(result.unavailable, false);
    assert.ok(result.journeys.every((j) => j.status === "fail" && j.classification === VERIFICATION_RESULT_CLASS.FATAL_RUNTIME_FAILURE));
    assert.equal(result.smoke.crashes.length, 1);
    assert.match(result.smoke.crashes[0].control, /Reset/);
    assert.match(result.fatalErrors[0], /fatal runtime error|went blank/);
  } finally { server.close(); }
});

browserTest("a preview that renders nothing after a boot error is a fatal load failure, not a platform failure", async () => {
  const { server, url } = await serve({ "/": BLANK_APP });
  try {
    const result = await smokeVerifyJourneys({ previewUrl: url, contract: journeysOnly, timeoutMs: 30_000, browser });
    assert.equal(result.pass, false);
    assert.equal(result.unavailable, false);
    assert.equal(result.smoke.crashes[0].phase, "load");
    assert.match(result.smoke.crashes[0].error, /boot failed before render/);
  } finally { server.close(); }
});

browserTest("an unreachable preview is UNAVAILABLE (platform), never an application failure", async () => {
  const { server, url } = await serve({ "/": WRONG_COUNTER });
  await new Promise((resolve) => server.close(resolve)); // the port is now closed
  const result = await smokeVerifyJourneys({ previewUrl: url, contract: journeysOnly, timeoutMs: 20_000, browser });
  assert.equal(result.pass, null);
  assert.equal(result.unavailable, true);
  assert.match(result.error, /unreachable|ERR_CONNECTION_REFUSED/i);
  assert.ok(result.journeys.every((j) => j.status === "undriveable" && j.classification === VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE));
  assert.equal(result.fatalErrors.length, 0);
});
