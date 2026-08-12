// PROVEN UNDRIVEABLE, VERSUS I CANNOT TELL.
//
// One static finding used to mean both. In run #6 `interaction_control_undriveable` named
// guestName, guestEmail and guestPhone on an application where all three worked; in run #7 it named
// the same three on an application where none of them did. Same code, same reason, opposite truths —
// so it could never be allowed to stop a build, and a real defect rode all the way to a paid
// browser journey to be discovered on step 5.
//
// The split is this suite's subject:
//
//   PROVEN_UNDRIVEABLE   structure settles it — disabled, read-only, a value with no way to change
//   SUSPECT_INTERACTION  the scan cannot see (a spread, a wrapper, a store) — report, never fail
//
// and for everything in the second bucket, a behavioural probe answers the question before the
// journeys run: type into the contracted textbox and read it back. The probe is domain-blind — it
// gets an opaque id and a browser primitive, and its probe values come from `type`, not meaning.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { probeControlMechanics, verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import {
  DIAGNOSTIC_LEVEL, diagnosticLevel, lintInteractiveWorkflow,
} from "../../shell/server/lib/builderV2/interactionContract.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  browserPlan, controlIdFor, deriveVerificationManifest,
} from "../../shell/server/lib/builderV2/verificationManifest.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";
import { MECHANICS_CONTRACT, mechanicsApp } from "./fixtures/mechanicsApp.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const SPEC = deriveBuildSpec(MECHANICS_CONTRACT);
const CASE = "bv2-control-mechanics";
const PLAN = browserPlan(deriveVerificationManifest(SPEC)).controls
  .filter((row) => ["textbox", "selection"].includes(row.primitive));

let built = null;
const runs = new Map();
const probes = new Map();

async function open(mode, work) {
  const root = path.join(workDirFor(CASE), "dist");
  const inject = (html) => html.replace("</head>",
    `<script>window.__MECHANICS__=${JSON.stringify(mode)}</script></head>`);
  const server = http.createServer(async (request, response) => {
    const requested = (request.url || "/").split("?")[0];
    const file = requested === "/" ? "/index.html" : requested;
    const asset = /\.(js|css|svg|png|ico)$/.test(file);
    try {
      const body = await readFile(path.join(root, file));
      response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript"
        : file.endsWith(".css") ? "text/css" : "text/html" });
      response.end(asset ? body : inject(body.toString("utf8")));
    } catch {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(inject((await readFile(path.join(root, "index.html"))).toString("utf8")));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  built = await buildTree({ ...fromScaffold(REACT_VITE), ...mechanicsApp(controlIdFor) }, CASE, () => {});
  assert.equal(built.ok, true, `the fixture must compile: ${built.detail || ""}`);
  const { chromium } = requireCjs("playwright");
  for (const mode of ["broken", "corrected"]) {
    // The probe alone, on a bare page — this is the cheap pre-journey phase in isolation.
    await open(mode, async (url) => {
      const browser = await chromium.launch({ args: ["--no-sandbox"] });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(600);
      probes.set(mode, await probeControlMechanics(page, PLAN));
      await browser.close();
    });
    // …and the full contracted verification, for comparison.
    await open(mode, async (url) => {
      runs.set(mode, await verifyJourneys({ previewUrl: url, contract: SPEC.contract, timeoutMs: 600_000 }));
    });
  }
}, { timeout: 900_000 });

after(() => { runs.clear(); probes.clear(); });

// ── 5. THE EXACT RUN #7 REGRESSION ─────────────────────────────────────────────────────────────

test("LIVE REGRESSION — all three contact controls are caught BEFORE any journey runs",
  needsBrowser, () => {
    const probe = probes.get("broken");
    const failed = probe.failures.map((row) => row.id).sort();
    assert.deepEqual(failed,
      [controlIdFor("guestName"), controlIdFor("guestEmail"), controlIdFor("guestPhone")].sort(),
      `the probe caught ${JSON.stringify(probe.failures)}`);
    for (const failure of probe.failures) {
      assert.equal(failure.primitive, "textbox");
      // Correction evidence, not prose: the control's own id, what was expected, what happened.
      assert.ok(failure.expected, "no expected mechanic recorded");
      assert.ok(failure.observed !== undefined, "no observed result recorded");
    }
  });

test("the probe reaches its verdict without knowing what any control means", needsBrowser, () => {
  const text = JSON.stringify(probes.get("broken"));
  for (const word of ["guest", "email", "phone", "booking", "date", "name"]) {
    assert.equal(new RegExp(word, "i").test(text), false,
      `the probe result leaks the business word "${word}": ${text.slice(0, 300)}`);
  }
});

test("the full journey verifier agrees with the probe on the broken build", needsBrowser, () => {
  const journey = (runs.get("broken").journeys || [])[0];
  assert.notEqual(journey.status, "pass", "a build whose fields hold nothing was graded green");
  // The same evidence now arrives from the cheap phase as well as the expensive one.
  assert.equal(runs.get("broken").mechanics.failures.length, 3);
});

test("corrected bindings accept and retain their values, and the journey proceeds", needsBrowser, () => {
  assert.deepEqual(probes.get("corrected").failures, [],
    `the corrected build was still flagged: ${JSON.stringify(probes.get("corrected").failures)}`);
  const journey = (runs.get("corrected").journeys || [])[0];
  assert.equal(journey.status, "pass", `${journey.detail || ""} ${JSON.stringify(journey.steps?.map((s) => s.status))}`);
});

// ── 6. FALSE POSITIVES — legitimate shapes that must stay accepted ─────────────────────────────

test("the corrected build covers a controlled field, a defaultValue field and a wrapper", needsBrowser, () => {
  // guestName is value+onChange, guestEmail is uncontrolled with defaultValue and NO onChange,
  // guestPhone is a custom component backed by a reducer. All three must probe clean, because all
  // three genuinely work — no React idiom is required.
  const probe = probes.get("corrected");
  assert.equal(probe.probed >= 3, true, `only ${probe.probed} control(s) were probed`);
  assert.deepEqual(probe.failures, []);
});

// ── 2. THE TWO LEVELS, AS A PURE RULE ──────────────────────────────────────────────────────────

test("only structure that settles the question is PROVEN", () => {
  for (const reason of ["disabled", "readonly", "controlled_without_change_handler", "invalid_control_type"]) {
    assert.equal(diagnosticLevel(reason, [{ hasSpread: false }]), DIAGNOSTIC_LEVEL.PROVEN, reason);
  }
  for (const reason of ["missing_editable_control", "missing_accessible_identity", "state_owner_not_connected"]) {
    assert.equal(diagnosticLevel(reason, [{ hasSpread: false }]), DIAGNOSTIC_LEVEL.SUSPECT, reason);
  }
});

test("a spread defeats every attribute-based proof", () => {
  // `<input {...field.inputProps} />` holds its value and its handler out of reach of this scan, so
  // nothing missing from its attributes proves anything. This is the exact reason run #6's finding
  // was a false positive on a working application.
  assert.equal(diagnosticLevel("controlled_without_change_handler", [{ hasSpread: true }]),
    DIAGNOSTIC_LEVEL.SUSPECT);
  assert.equal(diagnosticLevel("disabled", [{ hasSpread: true }]), DIAGNOSTIC_LEVEL.SUSPECT);
});

test("the lint labels every interaction finding with its evidence strength", () => {
  const tree = { "src/App.jsx": `export default function App() {
    return <main>
      <label htmlFor="guestName">Guest name</label>
      <input id="guestName" type="text" value="" />
      <label htmlFor="guestEmail">Guest email</label>
      <input id="guestEmail" type="email" disabled value="" onChange={() => {}} />
    </main>;
  }` };
  const findings = lintInteractiveWorkflow(tree, { interactionContract: SPEC.interactionContract }).findings
    .filter((row) => row.code === "interaction_control_undriveable");
  assert.ok(findings.length, "no interaction findings at all");
  for (const finding of findings) {
    assert.ok([DIAGNOSTIC_LEVEL.PROVEN, DIAGNOSTIC_LEVEL.SUSPECT].includes(finding.level),
      `finding ${finding.reason} carries no level`);
  }
  // A value with no change transition, and a disabled required field, are both provable.
  const proven = findings.filter((row) => row.level === DIAGNOSTIC_LEVEL.PROVEN).map((row) => row.reason);
  assert.ok(proven.length, `nothing was proven: ${JSON.stringify(findings.map((f) => [f.reason, f.level]))}`);
  // And a field the scan simply could not find is never proven.
  for (const finding of findings) {
    if (finding.reason === "missing_editable_control") {
      assert.equal(finding.level, DIAGNOSTIC_LEVEL.SUSPECT);
    }
  }
});

test("an uncontrolled native input is never PROVEN undriveable", () => {
  // The shape the instructions single out: no value, no onChange, perfectly driveable.
  const tree = { "src/App.jsx": `export default function App() {
    return <main>
      <label htmlFor="guestName">Guest name</label>
      <input id="guestName" type="text" />
    </main>;
  }` };
  const proven = lintInteractiveWorkflow(tree, { interactionContract: SPEC.interactionContract }).findings
    .filter((row) => row.level === DIAGNOSTIC_LEVEL.PROVEN);
  assert.deepEqual(proven, [], `an uncontrolled input was condemned: ${JSON.stringify(proven)}`);
});

test("selection_state_unobservable carries a level, like every other interaction finding", () => {
  // A selection whose chosen state lives in a closure can never be verified: nothing on the page
  // changes when it is clicked. Where the elements are readable that is PROVEN — but a spread
  // supplies aria-pressed at runtime, so it must degrade like the rest. Unlabelled, this finding
  // would eventually be promoted and start failing correct applications.
  const readable = { "src/App.jsx": `export default function App() {
    return <main>
      <div role="group" aria-label="Date"><button id="dateId">14 Feb</button></div>
      <label htmlFor="guestName">Guest name</label><input id="guestName" />
    </main>;
  }` };
  const findings = lintInteractiveWorkflow(readable, { interactionContract: SPEC.interactionContract })
    .findings.filter((row) => row.code === "selection_state_unobservable");
  for (const finding of findings) {
    assert.ok([DIAGNOSTIC_LEVEL.PROVEN, DIAGNOSTIC_LEVEL.SUSPECT].includes(finding.level),
      `selection_state_unobservable still carries no level: ${JSON.stringify(finding)}`);
  }

  // …and a spread degrades it to SUSPECT rather than condemning a bound chooser.
  const spread = { "src/App.jsx": `
    import { useSemanticSelection } from "./lib/capabilities/react.js";
    export default function App() {
      const dates = useSemanticSelection({ name: "dateId", label: "Date" });
      return <div {...dates.groupProps}><button {...dates.optionProps("a")}>A</button></div>;
    }` };
  const spreadFindings = lintInteractiveWorkflow(spread, { interactionContract: SPEC.interactionContract })
    .findings.filter((row) => row.code === "selection_state_unobservable");
  for (const finding of spreadFindings) {
    assert.equal(finding.level, DIAGNOSTIC_LEVEL.SUSPECT,
      "a spread-bound chooser was PROVEN unobservable");
  }
});

// ── the locator ladder ─────────────────────────────────────────────────────────────────────────

test("LADDER — a hand-wired control is probed via its contract-supplied name, and said so",
  needsBrowser, async () => {
    // Run #8's shape: no machine identity, so the identity rung finds nothing. Before the ladder
    // this skipped in silence while the driver found the same element by name and failed on it
    // eight steps later.
    const { chromium } = requireCjs("playwright");
    const probe = await open("handwired", async (url) => {
      const browser = await chromium.launch({ args: ["--no-sandbox"] });
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(600);
      const result = await probeControlMechanics(page, PLAN);
      await browser.close();
      return result;
    });
    const identityAbsent = probe.outcomes.filter((row) => row.outcome === "identity_absent");
    assert.ok(identityAbsent.some((row) => row.id === controlIdFor("guestName")),
      `the hand-wired control was not reported identity_absent: ${JSON.stringify(probe.outcomes)}`);
    // It was PROBED, not skipped — and it works, so it must not be reported as a failure.
    assert.equal(probe.failures.some((row) => row.id === controlIdFor("guestName")), false,
      "a working hand-wired control was failed");
    assert.equal(probe.skipped.some((row) => row.id === controlIdFor("guestName")), false,
      "the hand-wired control was skipped rather than probed");
  });

test("LADDER — one name on two visible controls is refused, not guessed", needsBrowser, async () => {
  // The 2026-08-11 shape. A wrong probe result is worse than none: it would spend the bounded
  // mechanics correction on a control that was never broken.
  const { chromium } = requireCjs("playwright");
  const probe = await open("ambiguous", async (url) => {
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    const result = await probeControlMechanics(page, PLAN);
    await browser.close();
    return result;
  });
  const ambiguous = probe.skipped.filter((row) => row.reason === "ambiguous_identity");
  assert.ok(ambiguous.some((row) => row.id === controlIdFor("guestName")),
    `ambiguity was not reported: ${JSON.stringify({ skipped: probe.skipped, outcomes: probe.outcomes })}`);
  assert.equal(probe.failures.some((row) => row.id === controlIdFor("guestName")), false,
    "an ambiguous control was probed and failed anyway");
});

test("LADDER — a bound control is unchanged: addressed by identity, never by name", needsBrowser, () => {
  // The corrected build binds everything, so nothing should report identity_absent.
  const probe = probes.get("corrected");
  assert.deepEqual(probe.failures, []);
  assert.equal((probe.outcomes || []).some((row) => row.outcome === "identity_absent"), false,
    `a bound control was reached by name: ${JSON.stringify(probe.outcomes)}`);
});

test("LADDER — the probe path never reaches for the platform's alias table", async () => {
  // `semanticAliases` invented "party size" out of Thrallo's own vocabulary and drove three contact
  // fields into a number input on 2026-08-11. The ladder's second rung uses contract-supplied
  // fallbackNames and nothing else; this holds the file to that.
  const source = await readFile(new URL("../../shell/server/lib/appBuild/journeyVerifier.mjs", import.meta.url), "utf8");
  const ladder = source.slice(source.indexOf("async function locateForProbe"),
    source.indexOf("export async function probeControlMechanics"));
  assert.ok(ladder.length > 200, "the ladder was not found in the verifier");
  assert.equal(/semanticAliases|semanticKey/.test(ladder), false,
    "the probe ladder reaches for the platform alias table");
  assert.match(ladder, /fallbackNames/);
});

// ── what the page said when it failed ──────────────────────────────────────────────────────────

test("a failing step keeps what was on screen, and what the browser complained about",
  needsBrowser, () => {
    // Run #9's commit was refused by the app. Three branches in the retained source could have
    // refused it — two render nothing at all, one renders "Error: …" — and the verdict ("five words
    // expected, one found") could not tell them apart. Neither could the source. A 5.7-credit
    // failure was diagnosable only as far as "the mutation failed, cause unknown".
    const journey = (runs.get("broken").journeys || [])[0];
    const failed = (journey.steps || []).find((row) => !["pass", "skipped", "not_reached"].includes(row.status));
    assert.ok(failed, "the broken build produced no failing step to observe");
    assert.ok(failed.observation, "a failing step carries no observation");
    assert.equal(typeof failed.observation.text, "string");
    assert.ok(failed.observation.text.length > 0, "nothing of the page was captured");
    // Bounded: a long page must not bloat the retained record.
    assert.ok(failed.observation.text.length <= 600, `observation text is ${failed.observation.text.length} chars`);
    assert.ok(Array.isArray(failed.observation.consoleSince));
    assert.ok(Array.isArray(failed.observation.requestsSince));
    // It captures what was actually rendered, not a summary of the verdict.
    assert.match(failed.observation.text, /Who is coming|Supper club/);
  });

test("the observation is evidence, never an input to the verdict", needsBrowser, () => {
  // Captured after the status is decided, and only for steps that did not pass — so it cannot
  // widen or narrow what counts as success, and a green run carries none of it.
  const corrected = (runs.get("corrected").journeys || [])[0];
  for (const step of corrected.steps || []) {
    if (step.status === "pass") {
      assert.equal("observation" in step, false, `a passing step carried an observation: ${step.action}`);
    }
  }
});
