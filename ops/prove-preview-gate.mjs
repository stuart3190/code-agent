// Acceptance: detection now enforces.
//
// One deterministic booking fixture with browser-only persistence injected deliberately. Every
// stage is checked, and the delivery gate is proved twice — once for a build that gets repaired,
// once for a build that does not and must end blocked.
//
// COST: exactly one model call, for the repair itself. Everything else is deterministic. Credits
// are reported after that call.
//
//   node ops/prove-preview-gate.mjs              # deterministic only, zero credits
//   node ops/prove-preview-gate.mjs --with-agent # one repair call

import { loadEnv } from "../shell/server/lib/env.mjs";
import { buildTree, depsNodeModules } from "../harness/workspace.mjs";
import { honestyScan } from "../shell/server/lib/appBuild/honestyScan.mjs";
import { verifyJourneys } from "../shell/server/lib/appBuild/journeyVerifier.mjs";
import { verifyFunctionalRepair } from "../shell/server/lib/appBuild/patchVerification.mjs";
import { functionalRepairBrief, findingKey } from "../shell/server/lib/appBuild/functionalFindings.mjs";
import { resolveBuildState, BUILD_STATES, isShippable } from "../shell/shared/buildStates.mjs";

loadEnv();
const WITH_AGENT = process.argv.includes("--with-agent");
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
  return ok;
};

// ── the fixture: compiles, renders, stores nothing real ───────────────────────────────────────
const CONTRACT = {
  summary: "A booking site for a strawberry farm.",
  journeys: [{
    id: "book", title: "A visitor books a slot", priority: "primary", stage: "primary_journey",
    steps: [
      { action: "open the booking page", target: "/", expect: "the available slots are visible" },
      { action: "enter name and email", target: "details form", expect: "the fields accept the details" },
      { action: "click confirm booking", target: "confirm button", expect: "a booking reference is shown" },
    ],
  }],
  entities: [{
    name: "booking", owned: true,
    fields: [{ name: "slotId", type: "string", required: true }, { name: "email", type: "string", required: true }],
  }],
  auth: { required: true, model: "email + password via the backend SDK", rules: [] },
  operations: [{ id: "create-booking", entity: "booking", kind: "create", description: "persist the booking via db.entity('booking').create" }],
  acceptance: [
    { id: "a1", statement: "a submitted booking is readable after a page reload" },
    { id: "a2", statement: "a booking created in one browser is visible to the owner in another" },
  ],
  states: [], routes: [{ path: "/", name: "Book" }], deferred: [],
};

const BOOKINGS_BROWSER_ONLY = `// Booking storage.
export function listBookings() {
  return JSON.parse(localStorage.getItem("bookings") || "[]");
}

export function createBooking(booking) {
  const all = listBookings();
  const stored = { ...booking, id: "BK-" + (all.length + 1001) };
  all.push(stored);
  localStorage.setItem("bookings", JSON.stringify(all));
  return stored;
}
`;

const FIXTURE = {
  "package.json": JSON.stringify({
    name: "booking-fixture", private: true, version: "0.0.0", type: "module",
    scripts: { build: "vite build" },
    dependencies: { react: "18.3.1", "react-dom": "18.3.1" },
  }, null, 2),
  "vite.config.js": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n`,
  "index.html": `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n`,
  "src/main.jsx": `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\ncreateRoot(document.getElementById("root")).render(<App />);\n`,
  "src/lib/backend/index.js": `export const db = { entity: () => ({ create: async (r) => r, list: async () => [] }) };\nexport const auth = {};\n`,
  "src/data/bookings.js": BOOKINGS_BROWSER_ONLY,
  "src/App.jsx": `import React, { useState } from "react";
import { createBooking, listBookings } from "./data/bookings.js";

export default function App() {
  const [saved, setSaved] = useState(listBookings()[0] || null);
  const [form, setForm] = useState({ name: "", email: "" });
  return (
    <main>
      <h1>Book a slot</h1>
      <p>Available slots: 10:00, 12:00, 14:00</p>
      <form onSubmit={(e) => { e.preventDefault(); setSaved(createBooking({ ...form, slotId: "10:00" })); }}>
        <label>Name <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Email <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
        <button type="submit">Confirm booking</button>
      </form>
      {saved && <p>Your booking reference is {saved.id}</p>}
    </main>
  );
}
`,
};

console.log("ACCEPTANCE — detection now enforces\n");

// ── 1. it compiles ────────────────────────────────────────────────────────────────────────────
console.log("1. the fixture compiles");
const built = await buildTree(FIXTURE, "gate_fixture", () => {});
check("compilation passes", built.ok === true,
  built.ok ? "" : String(built.stderr || "").split("\n").slice(-3).join(" | "));

// ── 2. the honesty scan blocks delivery ───────────────────────────────────────────────────────
console.log("\n2. the honesty scan blocks delivery");
const honestyBefore = honestyScan(FIXTURE, { contract: CONTRACT });
check("the scan finds the browser-only persistence", honestyBefore.ok === false, honestyBefore.summary);
check("and names localStorage specifically",
  honestyBefore.findings.some((f) => /localStorage/.test(f.snippet)));

const stateBefore = resolveBuildState({
  compileOk: true, previewUrl: "https://preview.example/",
  journeys: { pass: true }, honesty: honestyBefore,
});
check("the build state is verification_failed", stateBefore === BUILD_STATES.verificationFailed, stateBefore);
check("preview_ready is NOT emitted", isShippable(stateBefore) === false);

// ── 3. the repair brief ───────────────────────────────────────────────────────────────────────
console.log("\n3. the repair brief carries the exact structured finding");
const brief = functionalRepairBrief({ honesty: honestyBefore, contract: CONTRACT });
check("it names the file and line", /src\/data\/bookings\.js:\d+/.test(brief));
check("it names the detected API", /DETECTED BROWSER STORAGE APIS: localStorage/.test(brief));
check("it states the contract's entity and operation",
  /booking — rows belong to the signed-in user/.test(brief) && /db\.entity\('booking'\)\.create/.test(brief));
check("it gives the exact instruction",
  /Replace browser-only persistence with the generated app's real database entity/.test(brief)
  && /survive refresh and a new authenticated session/.test(brief));
check("it forbids swapping to another browser store",
  /DO NOT substitute one browser store for another/.test(brief) && /sessionStorage/.test(brief));

// ── 4. the substitution is rejected ───────────────────────────────────────────────────────────
console.log("\n4. the sessionStorage substitution is rejected (deterministic)");
const substituted = honestyScan(
  { ...FIXTURE, "src/data/bookings.js": BOOKINGS_BROWSER_ONLY.replace(/localStorage/g, "sessionStorage") },
  { contract: CONTRACT },
);
const subVerdict = verifyFunctionalRepair({
  before: honestyBefore.findings, after: substituted.findings, keyOf: findingKey,
});
check("it is not judged effective", subVerdict.effective === false, subVerdict.summary);
check("and the build still cannot ship",
  isShippable(resolveBuildState({ compileOk: true, previewUrl: "https://p/", journeys: { pass: true }, honesty: substituted })) === false);

// ── 5. an unrepaired fixture ends blocked ─────────────────────────────────────────────────────
console.log("\n5. an unrepaired fixture ends blocked, never delivered");
check("state after exhausting repair is blocked",
  resolveBuildState({ exhausted: true, compileOk: true, previewUrl: "https://p/" }) === BUILD_STATES.blocked);
check("blocked is not shippable", isShippable(BUILD_STATES.blocked) === false);

// ── 6. the real repair ────────────────────────────────────────────────────────────────────────
if (WITH_AGENT) {
  console.log("\n6. a real repair agent, given that brief (ONE model call)");
  const { runRepairForProof } = await import("./lib/repairProbe.mjs");
  const started = Date.now();
  const result = await runRepairForProof({ tree: FIXTURE, brief });
  const usage = result.telemetry || {};
  const credits = Number(usage.credits ?? 0);
  console.log(`     model call complete in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`     tokens in/out: ${usage.input ?? "?"}/${usage.output ?? "?"}${credits ? ` · ${credits.toFixed(2)} credits` : ""}`);

  const after = honestyScan(result.tree, { contract: CONTRACT });
  const verdict = verifyFunctionalRepair({ before: honestyBefore.findings, after: after.findings, keyOf: findingKey });

  check("the repair replaced browser storage with the database", after.ok === true, after.summary);
  check("it is judged effective on the ORIGINAL findings", verdict.effective === true, verdict.summary);
  check("the data module now calls db.entity()", /db\.entity\(/.test(result.tree["src/data/bookings.js"] || ""));
  check("and no browser store remains",
    !/(localStorage|sessionStorage|indexedDB)/.test(result.tree["src/data/bookings.js"] || ""));

  const rebuilt = await buildTree(result.tree, "gate_fixture_fixed", () => {});
  check("the repaired project compiles", rebuilt.ok === true,
    rebuilt.ok ? "" : String(rebuilt.stderr || "").split("\n").slice(-3).join(" | "));

  const stateAfter = resolveBuildState({
    compileOk: rebuilt.ok, previewUrl: "https://preview.example/",
    journeys: { pass: true }, honesty: after,
  });
  check("ONLY NOW is the state preview_ready", stateAfter === BUILD_STATES.previewReady, stateAfter);
  check("and it is shippable", isShippable(stateAfter) === true);
} else {
  console.log("\n6. skipped — pass --with-agent for the single repair model call");
}

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : "PASSED — every check"}`);
process.exit(failures ? 1 : 0);
