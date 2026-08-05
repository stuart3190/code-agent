// WP-4 — capability kernel: the scaffold ships headless capabilities, the registry is the
// single authority, and every guard treats them as platform infrastructure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { CAPABILITIES, validateBindings, capabilityBrief } from "../../shell/server/lib/builderV2/capabilityRegistry.mjs";
import { indexFile } from "../../shell/server/lib/builderV2/indexerV0.mjs";
import { applyPatches } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { runStageGate } from "../../shell/server/lib/appBuild/stageGate.mjs";
import { honestyScan } from "../../shell/server/lib/appBuild/honestyScan.mjs";

const okCompile = async () => ({ ok: true, stderr: "" });

test("WP4 — every registry entry's package ships in the scaffold and EXPORTS its interface", () => {
  for (const entry of Object.values(CAPABILITIES)) {
    const source = REACT_VITE[entry.package];
    assert.ok(source, `${entry.package} missing from scaffold`);
    const index = indexFile(entry.package, source);
    assert.equal(index.opaque, false, `${entry.package} must parse`);
    const combined = `${source}\n${REACT_VITE["src/lib/capabilities/index.js"]}`;
    for (const fn of entry.interface) {
      assert.ok(new RegExp(`export (?:async )?(?:function|const)?\\s*\\{?[^}]*\\b${fn}\\b`).test(combined)
        || combined.includes(`export { ${fn}`) || combined.includes(`${fn},`) || combined.includes(`${fn} }`),
        `${entry.name}: ${fn} must be exported`);
    }
    // Headless by law: no JSX, no styling, no storage.
    assert.ok(!/return\s*\(?\s*</.test(source), `${entry.name} is headless — no JSX`);
    assert.ok(!/localStorage|sessionStorage|indexedDB/i.test(source.replace(/ensureVisitorSession/g, "")),
      `${entry.name} touches no browser storage itself`);
  }
});

test("WP4 — binding validation: unknown names and major mismatches fail loudly", () => {
  assert.equal(validateBindings([{ name: "crud", version: "1.0.0" }]).ok, true);
  const unknown = validateBindings([{ name: "teleportation" }]);
  assert.equal(unknown.ok, false);
  assert.match(unknown.problems[0], /unknown capability/);
  const major = validateBindings([{ name: "crud", version: "2.1.0" }]);
  assert.equal(major.ok, false);
  assert.match(major.problems[0], /major 2, platform ships 1\.0\.0/);
});

test("WP4 — the capability brief is byte-stable and sorted (a cacheable prefix segment)", () => {
  assert.equal(capabilityBrief(), capabilityBrief());
  assert.match(capabilityBrief(["session", "crud"]), /crud@1\.0\.0[\s\S]*session@1\.0\.0/);
});

test("WP4 — patch engine and stage gate both refuse capability edits", async () => {
  const tree = { ...REACT_VITE }; // the full scaffold — preflight-clean by construction

  const patched = applyPatches(tree, [{
    file: "src/lib/capabilities/crud.js", newFile: null, content: null, deleteFile: null,
    ops: [{ op: "append", symbol: null, content: "// vandalism" }],
  }]);
  assert.match(patched.rejected[0].reason, /protected platform infrastructure/);

  const vandalised = { ...tree, "src/lib/capabilities/crud.js": `${tree["src/lib/capabilities/crud.js"]}\n// drift` };
  const gate = await runStageGate(vandalised, { baseline: REACT_VITE, compile: okCompile });
  assert.equal(gate.ok, false);
  assert.ok(gate.problems.some((p) => /capabilities are platform infrastructure/.test(p)), JSON.stringify(gate.problems));
});

test("WP4 — the scaffold with capabilities still passes honesty and compiles conceptually", () => {
  const scan = honestyScan(
    Object.fromEntries(Object.entries(REACT_VITE).filter(([p]) => p.startsWith("src/"))),
    { contract: null, stageScoped: true },
  );
  assert.equal(scan.findings.length, 0, JSON.stringify(scan.findings));
});
