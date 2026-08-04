// PR7 acceptance: the honesty scan, run against real generated projects.
//
// Unit tests prove the patterns fire on fixtures I wrote. This runs the scan over projects the
// pipeline actually produced, which is the only way to know whether the patterns fire on real
// generated code and — more importantly — whether they stay quiet on code that is fine.
//
// The headline case is a real one: staged production run 2 built its entire reservation layer on
// localStorage. It compiled, it loaded, it survived a reload in the verifying browser, and it would
// have lost every booking the moment anyone opened it anywhere else.
//
//   node ops/prove-honesty.mjs

import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { honestyScan, honestyFailures } from "../shell/server/lib/appBuild/honestyScan.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";

loadEnv();
const db = serviceClient();
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
  return ok;
};

console.log("PR7 — the implementation honesty scan\n");

// ── 1. the untouched scaffold must be silent ──────────────────────────────────────────────────
// The most important false-positive check there is: if the scan cannot stay quiet on the code
// every single project starts from, it will report every single project.
console.log("1. the scaffold every project starts from");
const scaffold = honestyScan(REACT_VITE);
check("reports nothing", scaffold.ok, scaffold.summary);
check("and warns about nothing either", scaffold.warnings.length === 0,
  scaffold.warnings.map((w) => w.message).join("; ") || "clean");

// ── 2. real generated projects ────────────────────────────────────────────────────────────────
console.log("\n2. projects the pipeline actually generated");
const { data: projects, error } = await db
  .from("projects").select("id,name,tree,created_at")
  .order("created_at", { ascending: false }).limit(12);

if (error) {
  console.log(`  could not read projects: ${error.message}`);
  failures += 1;
} else {
  let scanned = 0;
  let dishonest = 0;
  const byPattern = new Map();

  for (const project of projects || []) {
    const tree = project.tree || {};
    if (!Object.keys(tree).length) continue;
    scanned += 1;
    const result = honestyScan(tree);
    if (!result.ok) {
      dishonest += 1;
      for (const finding of result.findings) {
        byPattern.set(finding.id, (byPattern.get(finding.id) || 0) + 1);
      }
      console.log(`  ${project.name || project.id.slice(0, 8)}: ${result.summary}`);
      for (const finding of result.findings.slice(0, 3)) console.log(`      ${finding.message.slice(0, 150)}`);
    } else {
      console.log(`  ${project.name || project.id.slice(0, 8)}: ${result.summary}`);
    }
  }

  check("at least one real project was scanned", scanned > 0, `${scanned} scanned`);
  console.log(`\n  ${dishonest}/${scanned} carry at least one dishonest implementation`);
  for (const [id, count] of [...byPattern].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${id}: ${count}`);
  }

  // The production defect this PR exists for. If the scan cannot find it in the tree that really
  // contained it, the pattern is decorative.
  const localStorageHits = (projects || []).filter((p) => {
    const source = Object.entries(p.tree || {})
      .filter(([path]) => path.startsWith("src/") && !path.startsWith("src/lib/backend/"))
      .map(([, body]) => String(body)).join("\n");
    return /localStorage\s*\.\s*setItem/.test(source);
  });
  if (localStorageHits.length) {
    const caught = localStorageHits.every((p) => honestyScan(p.tree).findings.some((f) => f.id === "fake_persistence"));
    check(`every project storing records in localStorage is caught (${localStorageHits.length} found)`, caught);
  } else {
    console.log("  (no recent project used localStorage — the pattern is covered by unit tests)");
  }
}

// ── 3. the repair brief ───────────────────────────────────────────────────────────────────────
console.log("\n3. a finding is something a repair can act on");
const sample = honestyScan({
  "src/App.jsx": `export default () => <button onClick={() => {}}>Save</button>;`,
});
const brief = honestyFailures(sample);
check("it names the file and line", /src\/App\.jsx:\d+/.test(brief[0] || ""));
check("and says what is wrong in plain words", /does nothing when used/.test(brief[0] || ""), brief[0]);

console.log(`\n${failures ? `FAILED — ${failures} check(s)` : "PASSED — every check"}`);
process.exit(failures ? 1 : 0);
