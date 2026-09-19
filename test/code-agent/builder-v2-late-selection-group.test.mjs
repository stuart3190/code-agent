// A declared selection waits, bounded, for its option group — whether or not THIS step navigated.
//
// Retained defect (bv2 medium qualification, build a5396ba2 on a18d823): "select a member row to
// edit" ran the instant "open the administrator page" passed on the page heading, while the
// members table was still seeding its rows. The immediate query found no group, the step went
// undriveable, and three repair waves were spent on a control that was seconds from existing.
// The post-navigation polling already bounded that race for a step that navigated itself; the
// same bounded window now protects every declared selection, and a group that never appears
// still ends undriveable after it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { MINIMAL_CONTRACT_VERIFIER_POLICY } from "../../shell/server/lib/appBuild/verifierPolicy.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

const JOURNEY = "administrator-manages-member-roles";
const contract = deriveBuildSpec({
  summary: "Alder Studio team administration: pick a member row from a table that loads its rows",
  projectType: "dashboard", version: 1, auth: { required: false },
  routes: [{ path: "/admin", name: "Team Administration", auth: false, purpose: "members table" }],
  entities: [{ name: "member", owned: false, fields: ["userId", "displayName", "email", "role"].map((name) => ({ name, type: "string", required: true })) }],
  operations: [],
  journeys: [{ id: JOURNEY, title: "select a member", priority: "primary", steps: [
    { action: "open the administrator page", target: "/admin", expect: "the Team Administration heading and members table are visible" },
    { action: "select a member row to edit", target: "members table", operates: ["userId"], produces: ["displayName", "email"],
      primitive: "selection", expect: "the selected member row is highlighted and its current role is displayed" },
  ] }],
  acceptance: [
    { id: "a1", kind: "functional", journey: JOURNEY, statement: "the members table lists every member with a role" },
    { id: "a2", kind: "functional", journey: JOURNEY, statement: "selecting a member row highlights it" },
    { id: "a3", kind: "functional", journey: JOURNEY, statement: "the selected member's current role is displayed" },
  ],
  states: [], deferred: [], imageIntents: [], integrations: [],
}).contract;
const selection = contract.interactionContract.flows.find((flow) => flow.journeyId === JOURNEY && flow.kind === "selection");

const appFor = ({ delayMs, never }) => ({
  "src/App.jsx": `import { useEffect, useState } from "react";
import { useSemanticSelection } from "./lib/capabilities/react.js";

const MEMBERS = [
  { userId: "u1", displayName: "Ada Lovelace", email: "ada@example.test", role: "Member" },
  { userId: "u2", displayName: "Grace Hopper", email: "grace@example.test", role: "Administrator" },
];

export default function App() {
  const [members, setMembers] = useState([]);
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    ${never ? "return undefined;" : `const timer = setTimeout(() => setMembers(MEMBERS), ${delayMs});
    return () => clearTimeout(timer);`}
  }, []);
  const choice = useSemanticSelection({ name: "userId", value: selected, onSelect: setSelected });
  const current = members.find((member) => member.userId === selected);
  return (
    <main>
      <h1>Team Administration</h1>
      <p>Members table and role controls.</p>
      <section aria-label="members table">
        <h2>Members table</h2>
        {members.length === 0 && <p>Loading members table…</p>}
        {members.length > 0 && <div {...choice.groupProps}>
          {members.map((member) => (
            <button key={member.userId} {...choice.optionProps(member.userId, "user Id " + member.displayName)}>
              <span style={{ display: "block" }}>{member.displayName}</span>
              <span style={{ display: "block" }}>{member.email}</span>
            </button>
          ))}
        </div>}
      </section>
      {current && <p role="status">Selected member row highlighted: {current.displayName} · current role {current.role}</p>}
    </main>
  );
}
`,
});

const CASES = {
  lateRows: appFor({ delayMs: 2_000, never: false }),
  neverRows: appFor({ delayMs: 0, never: true }),
};
const servers = new Map();
const results = new Map();
const builds = new Map();

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  for (const [name, app] of Object.entries(CASES)) {
    const caseName = `bv2-late-selection-group-${name}`;
    const built = await buildTree({ ...fromScaffold(REACT_VITE), ...app }, caseName, () => {});
    builds.set(name, built);
    if (!built.ok) continue;
    const root = path.join(workDirFor(caseName), "dist");
    const server = http.createServer(async (request, response) => {
      const requested = (request.url || "/").split("?")[0];
      const file = requested === "/" ? "/index.html" : requested;
      try {
        const body = await readFile(path.join(root, file));
        response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript"
          : file.endsWith(".css") ? "text/css" : "text/html" });
        response.end(body);
      } catch {
        try {
          response.writeHead(200, { "content-type": "text/html" });
          response.end(await readFile(path.join(root, "index.html")));
        } catch { response.writeHead(404); response.end("not found"); }
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.set(name, server);
    results.set(name, await verifyJourneys({
      previewUrl: `http://127.0.0.1:${server.address().port}`, contract, timeoutMs: 240_000,
      verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
    }));
  }
}, { timeout: 900_000 });

after(async () => {
  for (const server of servers.values()) await new Promise((resolve) => server.close(resolve));
});

const transcriptOf = (journey) => (journey.steps || [])
  .map((step) => `${String(step.status).padEnd(12)} | ${step.action} | ${step.detail}`).join("\n");

test("the contract derives one declared selection over the member identity", () => {
  assert.ok(selection, JSON.stringify(contract.interactionContract.flows.map((flow) => flow.id)));
  assert.equal(selection.control.logicalField, "userId");
  assert.equal(contract.interactionContract.valid, true, JSON.stringify(contract.interactionContract.problems));
});

test("a selection whose option group renders a moment after the previous step is driven, not declared missing",
  { ...needsBrowser, timeout: 300_000 }, () => {
    assert.equal(builds.get("lateRows").ok, true, builds.get("lateRows")?.stderr);
    const journey = results.get("lateRows").journeys.find((row) => row.id === JOURNEY);
    const transcript = transcriptOf(journey);
    assert.equal(journey.steps[0]?.status, "pass", transcript);
    assert.equal(journey.steps[1]?.status, "pass", transcript);
    assert.match(journey.steps[1]?.detail || "", /Ada Lovelace|Grace Hopper/, transcript);
  });

test("a selection whose option group never appears is still undriveable after the bounded wait",
  { ...needsBrowser, timeout: 300_000 }, () => {
    assert.equal(builds.get("neverRows").ok, true, builds.get("neverRows")?.stderr);
    const journey = results.get("neverRows").journeys.find((row) => row.id === JOURNEY);
    const transcript = transcriptOf(journey);
    assert.equal(journey.steps[1]?.status, "undriveable", transcript);
    assert.match(journey.steps[1]?.detail || "", /no selectable control group matched contracted field userId/, transcript);
  });
