import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildInteractionContract } from "../../shell/server/lib/builderV2/interactionContract.mjs";
import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";

const CASE = "package14s_contact_driveability";
const CLEAN_JOURNEY = {
  id: "booking", title: "Complete a booking", priority: "primary", steps: [
    { action: "select a date", target: "date options", expect: "selected date changes" },
    { action: "select a slot and party size", target: "slot and party options", expect: "selected slot and party size change" },
    { action: "enter name, email and phone", target: "contact details", expect: "contact fields accept details" },
    { action: "click review", target: "review button", expect: "exact booking review appears" },
  ],
};
const BASE_CONTRACT = {
  entities: [{ name: "booking", fields: [
    { name: "date" }, { name: "slot" }, { name: "partySize" },
    { name: "name" }, { name: "email" }, { name: "phone" },
  ] }],
  journeys: [CLEAN_JOURNEY],
};
const interactionContract = buildInteractionContract(BASE_CONTRACT, { modulePlan: [] });
const ROUTED_COMPOSITE = {
  ...BASE_CONTRACT,
  routes: [{ path: "/book", name: "Book" }],
  journeys: [{ id: "contact-validation", title: "Validate contact details", priority: "primary", steps: [{
    action: "open the booking experience and make a date, slot, and party size selection",
    target: "/book", operates: ["booking.date", "booking.slot", "booking.partySize"],
    expect: "the contact fields are visible",
  }] }],
};
ROUTED_COMPOSITE.interactionContract = buildInteractionContract(ROUTED_COMPOSITE, { modulePlan: [] });

// This deliberately reproduces the retained browser evidence shape: broad prose contains date
// words in later selection steps. The pre-repair verifier therefore moves the DATE group for
// slot/party and never reveals the contact step. The interaction contract still carries the
// correct machine identity for each control.
const CONFUSING_JOURNEY = {
  ...CLEAN_JOURNEY,
  steps: [
    CLEAN_JOURNEY.steps[0],
    { ...CLEAN_JOURNEY.steps[1], action: "select Friday 21 Feb slot and party size" },
    ...CLEAN_JOURNEY.steps.slice(2),
  ],
};

const APP = String.raw`
import React, { useEffect, useState } from "react";

function Choices({ title, values, value, onChange }) {
  return <fieldset><legend>{title}</legend><div>
    {values.map((item) => <button type="button" key={item} aria-pressed={value === item}
      onClick={() => onChange(item)}>{item}</button>)}
  </div></fieldset>;
}

export default function App() {
  const [routeReady, setRouteReady] = useState(window.location.pathname !== "/book");
  const [date, setDate] = useState("");
  const [slot, setSlot] = useState("");
  const [partySize, setPartySize] = useState("");
  const [contact, setContact] = useState({ name: "", email: "", phone: "07700900123" });
  const [review, setReview] = useState(false);
  const ready = date && slot && partySize;
  useEffect(() => {
    if (routeReady) return undefined;
    const timer = setTimeout(() => setRouteReady(true), 450);
    return () => clearTimeout(timer);
  }, [routeReady]);
  if (!routeReady) return <main><p>Loading booking availability</p></main>;
  const update = (field) => (event) => setContact((current) => ({ ...current, [field]: event.target.value }));
  return <main>
    <Choices title="Choose date" values={["Friday 14 Feb", "Friday 21 Feb"]} value={date} onChange={setDate} />
    <Choices title="Choose slot" values={["18:00 slot", "19:00 slot"]} value={slot} onChange={setSlot} />
    <Choices title="Choose party size" values={["2 guests", "4 guests"]} value={partySize} onChange={setPartySize} />
    {ready && <section aria-label="Contact details">
      <label htmlFor="guest-name">Name</label>
      <input id="guest-name" name="name" value={contact.name} onChange={update("name")} />
      <label>Email <input type="email" name="email" value={contact.email} onChange={update("email")} /></label>
      <input type="tel" name="phone" aria-label="Phone" value={contact.phone} onChange={update("phone")} />
      <button type="button" onClick={() => setReview(true)} disabled={!contact.name || !contact.email || !contact.phone}>Review</button>
    </section>}
    {review && <section><h2>Exact booking review</h2><p>{date}</p><p>{slot}</p><p>{partySize}</p>
      <p>{contact.name}</p><p>{contact.email}</p><p>{contact.phone}</p></section>}
  </main>;
}
`;

let server;
let previewUrl;

before(async () => {
  await ensureDeps(() => {});
  const tree = fromScaffold(REACT_VITE);
  tree["src/App.jsx"] = APP;
  const compiled = await buildTree(tree, CASE, () => {});
  assert.equal(compiled.ok, true, compiled.stderr);
  const dist = path.join(workDirFor(CASE), "dist");
  server = http.createServer(async (req, res) => {
    const relative = req.url === "/" ? "index.html" : req.url.replace(/^\//, "");
    const file = path.join(dist, relative);
    const bytes = await readFile(file).catch(() => readFile(path.join(dist, "index.html")));
    res.writeHead(200, { "content-type": relative.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(await bytes);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  previewUrl = `http://127.0.0.1:${server.address().port}/`;
});

after(async () => { await new Promise((resolve) => server?.close(resolve)); });

test("retained evidence shape reproduces contact undriveability when runtime drops interaction facts", async () => {
  const result = await verifyJourneys({ previewUrl, contract: { journeys: [CONFUSING_JOURNEY] }, timeoutMs: 60_000 });
  assert.equal(result.primaryStatus, "undriveable", JSON.stringify(result, null, 2));
  assert.equal(result.journeys[0].steps[2].status, "undriveable");
  assert.match(result.journeys[0].steps[2].detail, /could not drive/);
  assert.equal(result.journeys[0].steps[3].status, "not_reached");
});

test("the same compiled candidate is driveable with exact contracted control identity", async () => {
  const result = await verifyJourneys({ previewUrl, contract: {
    ...BASE_CONTRACT, journeys: [CONFUSING_JOURNEY], interactionContract,
  }, timeoutMs: 60_000 });
  assert.equal(result.pass, true, JSON.stringify(result, null, 2));
  const contact = result.journeys[0].steps[2];
  assert.equal(contact.status, "pass");
  assert.deepEqual(contact.controlEvidence.fields.map((field) => [field.field, field.status]), [
    ["name", "filled"], ["email", "filled"], ["phone", "filled"],
  ]);
  assert.ok(contact.controlEvidence.fields.every((field) => field.expectedValue === field.observedValue));
  const phone = contact.controlEvidence.fields.find((field) => field.field === "phone");
  assert.equal(phone.previousValue, "07700900123", JSON.stringify(phone));
  assert.notEqual(phone.expectedValue, phone.previousValue, JSON.stringify(phone));
  assert.equal(phone.probeValue, phone.expectedValue, JSON.stringify(phone));
  assert.match(result.journeys[0].steps[3].detail, /review contains 3 exact entered value/);
});

test("a route-targeted composite step waits for async controls and drives every declared selection", async () => {
  const result = await verifyJourneys({ previewUrl, contract: ROUTED_COMPOSITE, timeoutMs: 60_000 });
  assert.equal(result.pass, true, JSON.stringify(result, null, 2));
  const step = result.journeys[0].steps[0];
  assert.equal(step.status, "pass");
  assert.deepEqual(step.controlEvidence.selections.map((entry) => entry.contractedField),
    ["date", "slot", "partySize"]);
});
