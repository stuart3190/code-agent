// Can the real verifier walk a multi-step wizard?
//
// Runs 3 and 4 both died in the same place: selections drove, then the flow never reached
// contact entry, review or confirmation. Run 4's step "choose a party size" actually moved the
// DATE selection — so when the verifier asked for party size, only the date controls were on
// screen. The flow had not advanced.
//
// The contracts the model writes name the SELECTIONS ("select a date", "select a slot") but not
// the advancement ("click Continue"). journeyVerifier performs the action it is given. So the
// open question is whether a step-gated wizard is driveable at all by such a contract.
//
// This drives BOTH shapes through the REAL verifyJourneys with a live-shaped contract:
//   A. step-gated   — each step renders only its own controls; Continue advances
//   B. auto-advance — selecting a value advances the wizard itself
// Whichever the verifier can walk is the shape generation must be steered toward.
//
// Zero provider calls. No platform behaviour changed by this file.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const CASE = "builder-v2-wizard-advancement";

// A faithful reproduction of the generated shape: platform primitives, a local wizard-like
// state machine (no backend needed to answer the advancement question), three selection groups,
// a contact step, review and confirmation.
const FLOW = (autoAdvance) => `import { useState } from "react";
import { useSemanticSelection, useSemanticField } from "../lib/capabilities";

const DATES = ["Friday 18 October", "Saturday 19 October"];
const SLOTS = ["18:30", "20:30"];
const SIZES = [2, 4];

export function Flow() {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState({ date: null, slot: null, size: null, name: "", email: "" });
  const [reference, setReference] = useState(null);
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const advance = () => ${autoAdvance ? "setStep((s) => s + 1)" : "undefined"};
  const status = draft.size ? "Selected party size highlighted" : draft.slot ? "Selected slot highlighted" : draft.date ? "Selected date highlighted" : "Choose your evening";

  const dateChoice = useSemanticSelection({ name: "date", value: draft.date, onSelect: (v) => { set("date", v); advance(); } });
  const slotChoice = useSemanticSelection({ name: "slot", value: draft.slot, onSelect: (v) => { set("slot", v); advance(); } });
  const sizeChoice = useSemanticSelection({ name: "partySize", value: draft.size, onSelect: (v) => { set("size", v); advance(); } });
  const nameField = useSemanticField({ name: "guestName", label: "Guest name", value: draft.name, onChange: (v) => set("name", v) });
  const emailField = useSemanticField({ name: "guestEmail", label: "Guest email", type: "email", value: draft.email, onChange: (v) => set("email", v) });

  return <main>
    <h1>Ember Table supper club</h1>
    <p role="status">{status}</p>
    {step === 0 && <section>
      <h2>Choose your evening date</h2>
      <div {...dateChoice.groupProps}>
        {DATES.map((d) => <button key={d} {...dateChoice.optionProps(d, d + " date")}>{d}</button>)}
      </div>
      ${autoAdvance ? "" : '<button onClick={() => setStep(1)}>Continue to slots</button>'}
    </section>}
    {step === 1 && <section>
      <h2>Choose an available slot</h2>
      <div {...slotChoice.groupProps}>
        {SLOTS.map((s) => <button key={s} {...slotChoice.optionProps(s, s + " slot")}>{s}</button>)}
      </div>
      ${autoAdvance ? "" : '<button onClick={() => setStep(2)}>Continue to party size</button>'}
    </section>}
    {step === 2 && <section>
      <h2>Choose your party size</h2>
      <div {...sizeChoice.groupProps}>
        {SIZES.map((n) => <button key={n} {...sizeChoice.optionProps(n, n + " guests party size")}>{n} guests</button>)}
      </div>
      ${autoAdvance ? "" : '<button onClick={() => setStep(3)}>Continue to guest details</button>'}
    </section>}
    {step === 3 && <section>
      <h2>Enter your guest details</h2>
      <label {...nameField.labelProps} /><input {...nameField.inputProps} />
      <label {...emailField.labelProps} /><input {...emailField.inputProps} />
      <button onClick={() => setStep(4)}>Review your booking</button>
    </section>}
    {step === 4 && <section>
      <h2>Review the exact selection</h2>
      <p>{draft.date} · {draft.slot} · {draft.size} guests · {draft.name} · {draft.email}</p>
      <button onClick={() => { setReference("EMB-4417"); setStep(5); }}>Confirm the booking</button>
    </section>}
    {step === 5 && <section>
      <h2>Booking confirmed</h2>
      <p>Your durable booking reference is {reference} and the status is Confirmed</p>
    </section>}
  </main>;
}`;

const app = (autoAdvance) => ({
  "src/components/Flow.jsx": FLOW(autoAdvance),
  "src/App.jsx": `import { Flow } from "./components/Flow.jsx";
export default function App() { return <Flow />; }`,
});

// The live-shaped contract: it names the SELECTIONS, not the advancement.
const CONTRACT = {
  summary: "A multi-step supper club booking",
  entities: [], operations: [], routes: [{ path: "/", name: "Home" }], auth: { required: false },
  journeys: [{
    id: "complete-booking", title: "Complete a booking", priority: "primary",
    steps: [
      { action: "open the home page", target: "home", expect: "Ember Table supper club is visible" },
      { action: "select a dinner date", target: "date", expect: "the selected date is highlighted" },
      { action: "select an available slot", target: "slot", expect: "the selected slot is highlighted" },
      { action: "choose a party size", target: "party size", expect: "the party size is highlighted" },
      { action: "enter valid guest name and email", target: "guest details", expect: "the details are accepted" },
      { action: "review the booking", target: "review", expect: "review shows the exact selection" },
      { action: "confirm the booking", target: "confirm", expect: "a durable booking reference is shown" },
    ],
  }],
};

const servers = [];
async function serve(caseName) {
  const root = path.join(workDirFor(caseName), "dist");
  const srv = http.createServer(async (request, response) => {
    const requested = (request.url || "/").split("?")[0];
    const file = requested === "/" ? "/index.html" : requested;
    try {
      const body = await readFile(path.join(root, file));
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
      response.writeHead(200, { "content-type": type });
      response.end(body);
    } catch { response.writeHead(404); response.end("not found"); }
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  servers.push(srv);
  return `http://127.0.0.1:${srv.address().port}`;
}

let gatedUrl = "";
let autoUrl = "";
let builds = {};

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  builds.gated = await buildTree({ ...fromScaffold(REACT_VITE), ...app(false) }, `${CASE}-gated`, () => {});
  builds.auto = await buildTree({ ...fromScaffold(REACT_VITE), ...app(true) }, `${CASE}-auto`, () => {});
  if (builds.gated.ok) gatedUrl = await serve(`${CASE}-gated`);
  if (builds.auto.ok) autoUrl = await serve(`${CASE}-auto`);
});

after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); });

test("both flow shapes compile", { ...needsBrowser }, () => {
  assert.equal(builds.gated.ok, true, builds.gated?.stderr);
  assert.equal(builds.auto.ok, true, builds.auto?.stderr);
});

const walk = async (url) => {
  const result = await verifyJourneys({ previewUrl: url, contract: CONTRACT, timeoutMs: 150_000 });
  const steps = result.journeys[0].steps || [];
  return {
    passed: steps.filter((s) => s.status === "pass").length,
    total: steps.length,
    detail: steps.map((s) => `${s.status}: ${s.action} — ${(s.detail || "").slice(0, 120)}`).join("\n"),
  };
};

test("DISPROVED — step gating is NOT what blocks the later journey steps", { ...needsBrowser }, async () => {
  const [gated, auto] = [await walk(gatedUrl), await walk(autoUrl)];
  console.log(`\nSTEP-GATED   ${gated.passed}/${gated.total}\n${gated.detail}`);
  console.log(`\nAUTO-ADVANCE ${auto.passed}/${auto.total}\n${auto.detail}\n`);

  // The hypothesis was that a contract naming only the selections cannot walk a step-gated
  // wizard. Both shapes score IDENTICALLY under the identical contract, so advancement is not
  // the discriminator. Recorded so the idea is not re-proposed.
  assert.equal(auto.passed, gated.passed,
    `advancement style did not change the outcome:\ngated:\n${gated.detail}\nauto:\n${auto.detail}`);
});

test("REPRODUCED — the freshness rule is what stops the flow: outcome copy must be NEW per step",
  { ...needsBrowser }, async () => {
    const gated = await walk(gatedUrl);
    // Both fixtures render one status line whose wording is reused across steps, and the
    // contract's expectations are written in selection-state language ("the selected date is
    // highlighted"). Selection state is proved structurally, so "selected" and "highlighted" are
    // not keywords: the expectation reduces to "date", a word the wizard shows before anything is
    // chosen. Nothing can be NEW, and the very first selection is where the walk stops.
    //
    // This is the live run-4 failure shape ("nothing changed — '…' was already on the page
    // before this step"), now reached one step earlier than when the words still counted.
    assert.match(gated.detail, /nothing changed/,
      `the freshness rule must be the observed blocker:\n${gated.detail}`);
    assert.match(gated.detail, /fail: select a dinner date — nothing changed — "date" was already on the page before this step/);
    // The step BEFORE it passed, proving the app itself mounts and is driveable.
    assert.match(gated.detail, /pass: open the home page/);
  });
