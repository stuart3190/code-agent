// The project dashboard's structure: code splitting, one set of states, and a complete ARIA
// pattern.
//
// These are source-level because the behaviour they protect is architectural — that no tab grows
// its own dialect of "loading", that the bundle stays split, and that the tab strip keeps the
// promise its roles make. The visible behaviour is covered in e2e/project-dashboard.spec.mjs.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const read = (p) => readFile(fileURLToPath(new URL(p, import.meta.url)), "utf8");

// This codebase documents what each fix replaced, so a negative assertion against raw text matches
// the prose explaining the bug. Only the code should be asserted against.
const readCode = async (p) => (await read(p))
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").map((line) => line.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

const TABS = ["AnalyticsView", "HealthView", "LogsView", "DeploymentsView", "DomainsSection"];

// ── Code splitting ──────────────────────────────────────────────────────────────────────

test("every tab body is code-split, and Overview deliberately is not", async () => {
  const dash = await readCode("../../shell/web/src/publish/ProjectDashboard.jsx");
  for (const tab of [...TABS, "ProjectSettingsBody"]) {
    assert.match(dash, new RegExp(`const ${tab} = lazy\\(`),
      `${tab} must be code-split — all six were in the initial bundle`);
  }
  // Overview opens by default, so splitting it would add a round trip to the common case.
  assert.match(dash, /^import OverviewTab from/m, "Overview stays eager");
  assert.doesNotMatch(dash, /const OverviewTab = lazy\(/);
  assert.match(dash, /<Suspense fallback=/, "with a fallback in the shape of what is arriving");
});

// ── One set of states ───────────────────────────────────────────────────────────────────

test("no tab defines its own loading treatment", async () => {
  // There were three: Analytics, Health and Deployments each rendered their own "Loading…" card,
  // and Domains had none at all — so it rendered as "you have no domains" while fetching.
  for (const tab of TABS) {
    const source = await readCode(`../../shell/web/src/publish/${tab}.jsx`);
    assert.match(source, /TabStates\.jsx/, `${tab} must use the shared states`);
    assert.doesNotMatch(source, /<div className="mg-card"><div className="ct-hint">Loading…<\/div><\/div>/,
      `${tab} must not keep its own loading card`);
  }
});

test("every tab surfaces a load failure with a retry", async () => {
  for (const tab of TABS) {
    const source = await readCode(`../../shell/web/src/publish/${tab}.jsx`);
    assert.match(source, /<TabError[\s\S]{0,160}onRetry=/,
      `${tab} must offer a way to try again — an error you can only stare at is a dead end`);
  }
});

test("a failed domains read is surfaced, never swallowed", async () => {
  const source = await readCode("../../shell/web/src/publish/DomainsSection.jsx");
  assert.doesNotMatch(source, /catch \{ \/\* section simply stays empty/);
  assert.doesNotMatch(source, /catch \{\s*\}/,
    "swallowing it rendered as 'you have no domains' — inviting someone to add one they may have");
  assert.match(source, /setLoadError/);
});

test("an action failure stays beside its action rather than replacing the panel", async () => {
  // TabError replaces the whole panel, which is right when there is nothing else to show and wrong
  // when the customer is still looking at a list.
  for (const [file, why] of [
    ["DeploymentsView", "a failed rollback must not throw away the deployment list"],
    ["DomainsSection", "a failed add must not throw away the domains"],
  ]) {
    const source = await readCode(`../../shell/web/src/publish/${file}.jsx`);
    assert.match(source, /className="mg-error"/, why);
  }
});

// ── The ARIA pattern is complete ────────────────────────────────────────────────────────

test("the tab strip keeps the promise its roles make", async () => {
  const dash = await readCode("../../shell/web/src/publish/ProjectDashboard.jsx");

  // Claiming role="tablist" tells a screen-reader user to expect arrow-key navigation and a
  // labelled panel. Claiming it without implementing it announces a promise and then breaks it.
  assert.match(dash, /role="tablist"/);
  assert.match(dash, /role="tab"/);
  assert.match(dash, /role="tabpanel"/, "there was no panel at all");
  assert.match(dash, /aria-controls="projtab-panel"/, "the tabs must name what they control");
  assert.match(dash, /aria-labelledby=\{`projtab-\$\{tab\}`\}/, "and the panel must name its tab");
  assert.match(dash, /tabIndex=\{tab === t\.id \? 0 : -1\}/, "roving tabindex: one stop for the strip");

  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    assert.match(dash, new RegExp(key), `${key} must move between tabs`);
  }
  assert.match(dash, /event\.key === "Escape"/, "and Escape closes, as every other sheet does");
});

test("the header carries status and address from the shared vocabulary", async () => {
  const dash = await readCode("../../shell/web/src/publish/ProjectDashboard.jsx");
  assert.match(dash, /operationalState\.mjs/,
    "restating health words here is how a header disagrees with the Health page one tab away");
  assert.match(dash, /healthStateOf/);
  assert.match(dash, /target="_blank"[\s\S]{0,60}rel="noopener noreferrer"|rel="noopener noreferrer"/,
    "the address opens in a new tab rather than losing the session");
});

// ── Actions confirm ─────────────────────────────────────────────────────────────────────

test("slow actions say they are working", async () => {
  const deployments = await readCode("../../shell/web/src/publish/DeploymentsView.jsx");
  assert.match(deployments, /Preparing…/,
    "a download that does nothing visible until the save dialog appears reads as broken");
  assert.match(deployments, /Rolling back…/);

  const logs = await readCode("../../shell/web/src/publish/LogsView.jsx");
  assert.match(logs, /exporting === format/, "the export buttons must show they are working");

  const domains = await readCode("../../shell/web/src/publish/DomainsSection.jsx");
  for (const label of ["Adding…", "Checking…", "Retrying…"]) {
    assert.match(domains, new RegExp(label), `${label} keeps the button honest while it works`);
  }
});
