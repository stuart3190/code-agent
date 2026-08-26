import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

import { verifyJourneys, viewportForAction } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { MINIMAL_CONTRACT_VERIFIER_POLICY } from "../../shell/server/lib/appBuild/verifierPolicy.mjs";

const requireCjs = createRequire(import.meta.url);
let browserAvailable = true;
try { requireCjs("playwright"); } catch { browserAvailable = false; }
const needsBrowser = { skip: browserAvailable ? false : "requires playwright" };

let server;
let baseUrl;

before(async () => {
  server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<main>
      <h1>Software catalogue</h1>
      <p>Search controls, filters, cards, detail panel, and saved software are visible.</p>
      <section>Catalogue grid and selected software detail panel use the available width.</section>
    </main>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => new Promise((resolve) => server?.close(resolve)));

test("viewport intent resolves independently of the action verb", () => {
  assert.deepEqual(viewportForAction("view the page on a narrow mobile viewport"),
    { width: 390, height: 844, kind: "mobile" });
  assert.deepEqual(viewportForAction("view the page on a desktop viewport"),
    { width: 1280, height: 900, kind: "desktop" });
  assert.equal(viewportForAction("view the software catalogue"), null);
});

test("natural mobile and desktop viewport steps remain driveable and retain responsive measurements",
  { ...needsBrowser, timeout: 120_000 }, async () => {
    const steps = [
      {
        action: "view the page on a narrow mobile viewport",
        target: "/",
        expect: "search controls, filters, cards, detail panel, and saved software are visible",
      },
      {
        action: "view the page on a desktop viewport",
        target: "/",
        expect: "catalogue grid and selected software detail panel use the available width",
      },
    ];
    const result = await verifyJourneys({
      previewUrl: baseUrl,
      timeoutMs: 35_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
      contract: {
        journeys: [{ id: "responsive-software-catalogue", title: "Responsive software catalogue",
          priority: "primary", steps }],
        interactionContract: { flows: [] },
      },
    });

    assert.equal(result.pass, true, JSON.stringify(result.journeys));
    assert.equal(result.journeys[0].steps[0].drove, true);
    assert.equal(result.journeys[0].steps[0].controlEvidence.advisories[0].layout.width, 390);
    assert.equal(result.journeys[0].steps[1].drove, true);
    assert.equal(result.journeys[0].steps[1].controlEvidence.advisories[0].layout.width, 1280);
  });
