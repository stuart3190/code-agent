// PR7 — an app that looks finished and does nothing is a failure, not a success.
//
// Every pattern here is something a generated app has really produced. The localStorage one is
// from production: staged run 2 built the entire reservation layer on it, survived a reload on
// that browser, looked completely working, and would have lost every booking anywhere else.

import { test } from "node:test";
import assert from "node:assert/strict";
import { honestyScan, honestyFailures } from "../../shell/server/lib/appBuild/honestyScan.mjs";

const CONTRACT = {
  entities: [{ name: "booking", fields: [], owned: true }],
  deferred: [{ item: "card payment", reason: "paid on arrival" }],
};

const honest = (body) => ({
  "src/App.jsx": `import { db } from "./lib/backend";\n${body}`,
});

test("an honest app passes", () => {
  const result = honestyScan(honest(`
export default function App() {
  const save = async (form) => {
    await db.entity("booking").create(form);
  };
  return <button onClick={() => save({})}>Book</button>;
}
`), { contract: CONTRACT });
  assert.equal(result.ok, true, JSON.stringify(result.findings, null, 1));
  assert.equal(result.summary, "honest");
});

test("PRODUCTION DEFECT — a reservation layer built on localStorage is caught", () => {
  // Verbatim shape of what the data stage actually produced: "LocalStorage-backed reservation
  // creation, lookup, cancellation, and reload persistence." It passed the compiler, passed the
  // preflight, passed "the app loads", and survived a reload in the verifying browser.
  const result = honestyScan({
    "src/data/reservation.js": `
export function createReservation(booking) {
  const all = JSON.parse(localStorage.getItem("reservations") || "[]");
  all.push(booking);
  localStorage.setItem("reservations", JSON.stringify(all));
  return booking;
}
`,
  }, { contract: CONTRACT });

  assert.equal(result.ok, false);
  const fake = result.findings.filter((f) => f.id === "fake_persistence");
  assert.ok(fake.length >= 2, "both the read and the write are dishonest");
  assert.match(fake[0].message, /src\/data\/reservation\.js:\d+/);
  assert.match(fake[0].message, /data exists on one browser only/);
  assert.match(fake[0].message, /invisible everywhere else/);
});

test("a form that only shows a success toast is caught", () => {
  const result = honestyScan({
    "src/Contact.jsx": `
export default function Contact() {
  return <form onSubmit={(e) => {}}>
    <button type="submit">Send</button>
  </form>;
}
`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].id, "empty_handler");
  assert.match(result.findings[0].message, /does nothing when used/);
});

test("a handler that only logs is caught", () => {
  const result = honestyScan({
    "src/Nav.jsx": `export default () => <button onClick={() => console.log("clicked")}>Export</button>;`,
  });
  assert.equal(result.findings[0].id, "todo_handler");
  assert.match(result.findings[0].message, /only logs or alerts/);
});

test("a simulated API delay is caught", () => {
  // The cruellest one: it gives an app that does nothing a convincing loading state.
  const result = honestyScan({
    "src/api.js": `
export async function save(x) {
  await new Promise((resolve) => setTimeout(resolve, 800));
  return { ok: true, id: 42 };
}
`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].id, "simulated_delay");
  assert.match(result.findings[0].message, /makes an app that does nothing feel like an app that is working/);
});

test("authentication that authenticates nothing is caught", () => {
  const result = honestyScan({
    "src/Login.jsx": `
export default function Login({ setIsLoggedIn }) {
  return <button onClick={() => setIsLoggedIn(true)}>Sign in</button>;
}
`,
  });
  assert.ok(result.findings.some((f) => f.id === "fake_auth"));
  assert.match(result.findings.find((f) => f.id === "fake_auth").message, /anyone is signed in as anyone/);
});

test("declared data that is never stored anywhere is caught as a whole-app failure", () => {
  // Every screen can look right while nothing is saved. No single line is wrong; the absence is.
  const result = honestyScan({
    "src/App.jsx": `
import { useState } from "react";
export default function App() {
  const [bookings, setBookings] = useState([]);
  return <button onClick={() => setBookings([...bookings, {}])}>Book</button>;
}
`,
  }, { contract: CONTRACT });

  assert.equal(result.ok, false);
  const finding = result.findings.find((f) => f.id === "no_backend_at_all");
  assert.ok(finding, JSON.stringify(result.findings));
  assert.match(finding.message, /contract declares booking/);
  assert.match(finding.message, /nothing the user creates is saved anywhere/);
});

test("comments and strings do not produce false findings", () => {
  // "TODO: wire up the backend" in a comment is a note, not a fake handler. A scan that cannot
  // tell them apart would report every well-annotated file.
  const result = honestyScan({
    "src/App.jsx": `
import { db } from "./lib/backend";
// TODO: add the export button later — coming soon
/* localStorage.setItem("x", 1) — deliberately not doing this */
export default function App() {
  const label = "not implemented yet";
  return <button onClick={() => db.entity("booking").create({})}>Book</button>;
}
`,
  }, { contract: CONTRACT });
  assert.deepEqual(result.findings, []);
  // The string literal is still visible to the soft label check, which is a warning, never a block.
  assert.ok(result.ok);
});

test("work the contract defers is not reported as dishonest", () => {
  const result = honestyScan({
    "src/App.jsx": `
import { db } from "./lib/backend";
export default () => <div>
  <button onClick={() => db.entity("booking").create({})}>Book</button>
  <span>Card payment coming soon — pay on arrival</span>
</div>;
`,
  }, { contract: CONTRACT });
  assert.equal(result.ok, true);
  assert.ok(!result.warnings.some((w) => /coming soon/i.test(w.snippet)),
    "a deferred item named in the contract is a kept agreement, not a placeholder");
});

test("the backend SDK itself is not scanned", () => {
  // It legitimately contains the primitives every pattern looks for.
  const result = honestyScan({
    "src/lib/backend/index.js": `localStorage.setItem("session", "x"); await new Promise((r) => setTimeout(r, 10));`,
  });
  assert.deepEqual(result.findings, []);
});

test("soft findings warn and never block", () => {
  const result = honestyScan({
    "src/App.jsx": `import { db } from "./lib/backend";
export default () => <button disabled={true} onClick={() => db.entity("x").create({})}>Later</button>;`,
  });
  assert.equal(result.ok, true, "a judgement call must not stop a working app from shipping");
  assert.ok(result.warnings.some((w) => w.id === "disabled_without_reason"));
  assert.match(result.summary, /honest \(1 warning/);
});

test("findings are phrased for a repair brief", () => {
  const result = honestyScan({
    "src/App.jsx": `export default () => <button onClick={() => {}}>Save</button>;`,
  });
  const failures = honestyFailures(result);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^src\/App\.jsx:1 — a control whose handler does nothing/);
});
