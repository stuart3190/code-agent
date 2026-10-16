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

// A module-scope throw in a generated source file: nothing mounts, so the smoke sees a blank page.
const THROWING_MODULE_APP = `<!doctype html><html><body><div id="root"></div>
<script type="module" src="/src/components/Flow.js"></script></body></html>`;
const THROWING_MODULE = `const calculationStore = (name) => { throw new Error("No composed entity store for " + name); };
export const flowStore = calculationStore("layoutCalculation");
`;

browserTest("a crash keeps its message, stack and the generated source file it names, on the verdict of every journey", async () => {
  const { server, url } = await serve({ "/": THROWING_MODULE_APP, "/src/components/Flow.js": THROWING_MODULE });
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    const type = req.url.endsWith(".js") ? "text/javascript" : "text/html";
    const body = req.url === "/src/components/Flow.js" ? THROWING_MODULE : THROWING_MODULE_APP;
    res.writeHead(200, { "content-type": type });
    res.end(body);
  });
  try {
    const result = await smokeVerifyJourneys({ previewUrl: url, contract: journeysOnly, timeoutMs: 30_000, browser });
    assert.equal(result.pass, false);
    const [crash] = result.smoke.crashes;
    assert.equal(crash.phase, "load");
    assert.equal(crash.message, "No composed entity store for layoutCalculation");
    assert.ok(crash.stack.length > 0 && crash.stack.length <= 5, JSON.stringify(crash.stack));
    assert.ok(crash.sourceFiles.includes("src/components/Flow.js"), JSON.stringify(crash));
    assert.ok(result.journeys.every((journey) => journey.crash?.message === crash.message
      && journey.crash.sourceFiles.includes("src/components/Flow.js")),
    "the repair brief reads the crash from the journey verdict");
    assert.match(result.fatalErrors[0], /No composed entity store for layoutCalculation/, "the one-line summary is unchanged");
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


browserTest("persistent mobile panel obstruction fails without comparing text or numbers", async () => {
  const html=`<html><body><main><h1>Calculator</h1><button style="position:absolute;top:100px;left:20px;width:120px;height:50px">Metres</button><aside aria-label="Calculator status" style="display:none;position:absolute;top:90px;left:10px;width:200px;height:100px;background:white">Ready</aside></main><style>@media(max-width:500px){aside{display:block!important}}</style></body></html>`;
  const {server,url}=await serve({'/':html});
  try { const result=await smokeVerifyJourneys({previewUrl:url,contract:journeysOnly,browser});
    assert.equal(result.pass,false); assert.equal(result.smoke.responsive.findings.length,1);
    assert.ok(result.journeys.every(j=>j.classification===VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE));
    assert.match(result.journeys[0].detail,/Mobile 390px.*Metres.*Calculator status/);
    assert.equal(result.smoke.crashes.length,0);
  } finally {server.close();}
});

browserTest("an intentional modal covering background controls is not a responsive defect", async () => {
  const html=`<html><body><h1>App</h1><button style="position:absolute;top:100px;left:20px;width:120px;height:50px">Background</button><section role="dialog" aria-modal="true" style="position:absolute;inset:0;background:white"><h2>Confirm</h2><button>Close</button></section></body></html>`;
  const {server,url}=await serve({'/':html});
  try {const result=await smokeVerifyJourneys({previewUrl:url,contract:journeysOnly,browser});assert.equal(result.pass,true);assert.equal(result.smoke.responsive.findings.length,0);}finally{server.close();}
});

browserTest("mobile inspection preserves result state produced by desktop interactions", async () => {
  const html=`<html><body><h1>Calculator</h1><button style="position:absolute;top:100px;left:20px;width:120px;height:50px">Metres</button><button id="calc" style="position:absolute;top:250px" onclick="document.querySelector('aside').hidden=false">Calculate</button><aside hidden aria-label="Result" style="position:absolute;top:90px;left:400px;width:200px;height:100px;background:white">9 lights</aside><style>@media(max-width:500px){aside{left:10px!important}}</style></body></html>`;
  const {server,url}=await serve({'/':html});
  try{const result=await smokeVerifyJourneys({previewUrl:url,contract:journeysOnly,browser});assert.equal(result.pass,false);assert.match(result.journeys[0].detail,/Mobile 390px.*Metres.*Result/);}finally{server.close();}
});

for (const [name, content, expectedPass, phase] of [
  ["visible platform error boundary", '<main data-scaffold-boundary="error" role="alert">This screen could not load</main>', false, "load"],
  ["platform boundary after activation", `<button onclick="document.getElementById('root').innerHTML='<main data-scaffold-boundary=error>This screen could not load</main>'">Open</button>`, false, "activate"],
  ["hidden platform boundary", '<main hidden data-scaffold-boundary="error">This screen could not load</main><h1>Working app</h1>', true],
  ["ordinary validation alert", '<main role="alert">Please enter a valid length</main>', true],
]) {
  browserTest(name + " is classified by platform marker visibility", async () => {
    const { server, url } = await serve({ "/": `<html><body><div id="root">${content}</div></body></html>` });
    try {
      const result = await smokeVerifyJourneys({ previewUrl: url, contract: journeysOnly, timeoutMs: 20_000, browser });
      assert.equal(result.pass, expectedPass, JSON.stringify(result.smoke));
      if (!expectedPass) {
        assert.equal(result.smoke.crashes[0].phase, phase);
        assert.match(result.fatalErrors[0], /platform error boundary/);
        assert.ok(result.journeys.every(j => j.classification === VERIFICATION_RESULT_CLASS.FATAL_RUNTIME_FAILURE));
      }
    } finally { server.close(); }
  });
}

for (const [name, css, expectedPass] of [
  ['root clipping masks mobile control overflow', 'html,body{overflow-x:clip}main{width:500px}', false],
  ['hidden container clips a control', 'main{width:350px;overflow:hidden}', false],
  ['horizontal scrolling board is intentional', 'main{width:350px;overflow-x:auto}', true],
  ['responsive controls fit without clipping', 'main{width:100%}button{margin-left:10px!important}', true],
  ['fully offscreen drawer is not a clipping finding', 'html,body{overflow-x:clip}button{margin-left:600px!important}', true],
]) {
  browserTest(name, async () => {
    const html=`<html><head><style>body{margin:0}button{margin-left:320px;width:160px;height:50px}@media(max-width:500px){${css}}</style></head><body><h1>Task board</h1><main><button>Create task</button></main></body></html>`;
    const {server,url}=await serve({'/':html});
    try {
      const result=await smokeVerifyJourneys({previewUrl:url,contract:journeysOnly,browser});
      assert.equal(result.pass,expectedPass,JSON.stringify(result.smoke));
      if(!expectedPass) {
        assert.equal(result.smoke.responsive.findings[0].kind,'clipped_control');
        assert.match(result.journeys[0].detail,/Create task.*cut off by.*clipping/);
        assert.equal(result.journeys[0].classification,VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE);
      }
    }finally{server.close();}
  });
}
