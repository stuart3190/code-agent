// Turn honesty and journey findings into a repair brief a model can actually act on.
//
// The repair loop was handed these as generic quality warnings — one line of prose in a list. It
// responded by swapping `localStorage` for `sessionStorage`, which is the same defect with a
// different noun, and the patch verifier recorded that as "effective" because the project still
// compiled. Findings went 4 → 4 → 7 across three rounds and 62 credits.
//
// A repair cannot fix what it has not been told. This says exactly what is wrong, exactly where,
// what the contract requires instead, and — for persistence specifically — names the one API that
// is acceptable and forbids the substitution that actually happened.

// Every browser-local store, so a brief can rule out the whole class rather than the one instance
// that was found. Naming only localStorage is how sessionStorage became the "fix".
export const PROHIBITED_STORES = ["localStorage", "sessionStorage", "indexedDB", "IndexedDB",
  "document.cookie", "window.name", "a module-level array", "a React context used as the database"];

/**
 * The persistence brief.
 *
 * Deliberately prescriptive. A repair told "don't use localStorage" will reach for the nearest
 * other thing on the shelf; a repair told "use db.entity('booking'), here are the operations, and
 * none of these other stores count" has one move available to it.
 */
export function persistenceRepairBrief({ findings, contract }) {
  const files = [...new Set(findings.map((f) => f.file))];
  const apis = [...new Set(findings.map((f) => (f.snippet.match(/\b(localStorage|sessionStorage|indexedDB)\b/) || [])[1]).filter(Boolean))];
  const entities = contract?.entities || [];
  const operations = contract?.operations || [];

  const lines = [
    "FUNCTIONAL DEFECT — the application stores its data in the browser instead of the database.",
    "",
    "It compiles, it renders, and it survives a reload on the machine that created the data. It is",
    "still broken: nothing is saved anywhere real, so the data is invisible to any other browser,",
    "any other device and any other signed-in session. This is the defect, not a style preference.",
    "",
    "EXACTLY WHERE:",
  ];
  for (const finding of findings) {
    lines.push(`  ${finding.file}:${finding.line}  ${finding.snippet}`);
  }
  lines.push("");
  if (apis.length) lines.push(`DETECTED BROWSER STORAGE APIS: ${apis.join(", ")}`);
  lines.push("");

  lines.push("WHAT THE CONTRACT REQUIRES:");
  for (const entity of entities) {
    const fields = (entity.fields || []).map((f) => `${f.name}:${f.type}${f.required ? " (required)" : ""}`).join(", ");
    lines.push(`  ${entity.name}${entity.owned ? " — rows belong to the signed-in user" : ""} { ${fields} }`);
  }
  for (const op of operations) lines.push(`  ${op.id}: ${op.description}`);
  const persistence = (contract?.acceptance || []).filter((a) => /persist|reload|refresh|surviv|sign|session/i.test(a.statement || ""));
  for (const test of persistence) lines.push(`  ACCEPTANCE: ${test.statement}`);
  lines.push("");

  lines.push("THE ONLY SUPPORTED DATA API:");
  lines.push('  import { db, auth } from "./lib/backend";');
  lines.push('  await db.entity("<type>").create(record)   // returns the stored record');
  lines.push('  await db.entity("<type>").list()           // rows for the signed-in user');
  lines.push('  await db.entity("<type>").update(id, patch)');
  lines.push('  await db.entity("<type>").delete(id)');
  lines.push("");

  lines.push("WHAT TO DO:");
  lines.push("Replace browser-only persistence with the generated app's real database entity");
  lines.push("operations. Data must survive refresh and a new authenticated session.");
  lines.push("");
  lines.push("DO NOT substitute one browser store for another. None of these is persistence, and");
  lines.push(`swapping between them is not a fix: ${PROHIBITED_STORES.join(", ")}.`);
  lines.push("A previous repair of this exact defect replaced localStorage with sessionStorage and");
  lines.push("was rejected. Every read and write listed above must go through db.entity().");

  return { brief: lines.join("\n"), files, apis };
}

/**
 * The journey brief.
 *
 * A failing journey is evidence, and the evidence is what makes it fixable: which step, what was
 * expected, what actually happened, and what the browser said while it happened.
 */
export function journeyRepairBrief({ journeys, contract }) {
  const failing = (journeys?.failures || []);
  if (!failing.length) return null;

  const lines = [
    "FUNCTIONAL DEFECT — the application does not complete a journey the contract requires.",
    "",
    "It compiles and it loads. Driven in a real browser, it does not do what was agreed.",
    "",
  ];

  for (const journey of failing) {
    lines.push(`JOURNEY "${journey.title}"${journey.priority === "primary" ? " (PRIMARY — the preview cannot ship until this passes)" : ""}:`);
    for (const [index, step] of (journey.steps || []).entries()) {
      const mark = step.status === "pass" ? "ok  " : step.status === "fail" ? "FAIL" : "    ";
      lines.push(`  ${mark} ${index + 1}. ${step.action}`);
      if (step.status === "fail") {
        lines.push(`         expected: ${step.expect}`);
        lines.push(`         actual:   ${step.detail || "the expected result never appeared"}`);
      }
    }
    lines.push("");
  }

  if (journeys.consoleErrors?.length) {
    lines.push("BROWSER CONSOLE DURING THE RUN:");
    for (const error of journeys.consoleErrors) lines.push(`  ${error}`);
    lines.push("");
  }
  if (journeys.failedRequests?.length) {
    lines.push("NETWORK REQUESTS THAT FAILED:");
    for (const request of journeys.failedRequests) lines.push(`  ${request}`);
    lines.push("");
  }

  const entities = contract?.entities || [];
  if (entities.length) {
    lines.push("THE DATA THESE JOURNEYS MUST READ AND WRITE, through db.entity():");
    for (const entity of entities) lines.push(`  ${entity.name}`);
    lines.push("");
  }

  lines.push("Fix the failing step so the expected result actually happens. Do not change the");
  lines.push("expectation, and do not remove the feature to make the check stop failing.");
  return lines.join("\n");
}

/**
 * The brief for whatever combination of things is wrong.
 *
 * Persistence leads when present: a journey that fails BECAUSE nothing is stored is one defect, and
 * fixing the storage fixes the journey. Repairing them as two problems produces two patches that
 * fight each other.
 */
export function functionalRepairBrief({ honesty = null, journeys = null, contract = null }) {
  const parts = [];
  const persistenceFindings = (honesty?.findings || []).filter((f) => f.id === "fake_persistence");
  const otherFindings = (honesty?.findings || []).filter((f) => f.id !== "fake_persistence");

  if (persistenceFindings.length) {
    parts.push(persistenceRepairBrief({ findings: persistenceFindings, contract }).brief);
  }
  if (otherFindings.length) {
    parts.push([
      "FUNCTIONAL DEFECT — controls that do not do what they appear to do:",
      ...otherFindings.map((f) => `  ${f.file}:${f.line}  ${f.label}\n         ${f.snippet}\n         ${f.message.split("—").slice(1).join("—").trim()}`),
      "",
      "Every visible action must work, be disabled with a stated reason, or be removed.",
    ].join("\n"));
  }
  const journeyBrief = journeyRepairBrief({ journeys, contract });
  if (journeyBrief) parts.push(journeyBrief);

  return parts.length ? parts.join("\n\n────────────────────────────────────────\n\n") : null;
}

/** A stable identity for a finding, so two rounds can be compared rather than counted. */
export function findingKey(finding) {
  return `${finding.id}:${finding.file}:${String(finding.snippet || "").replace(/\s+/g, " ").trim().slice(0, 80)}`;
}

// The functional escalation ladder. Deliberately short: three blind full-project repair rounds is
// what produced 62 credits and a worse app than it started with.
export const FUNCTIONAL_TIERS = ["targeted", "regenerate_module", "restore_and_block"];

/**
 * Where to go after a functional repair that did not work.
 *
 * ONE targeted attempt, then regenerate only the defective module from the contract, then stop.
 * "Stop" means restoring the last green checkpoint and telling the customer the feature is
 * blocked — not handing them a broken app and calling it done.
 */
export function nextFunctionalTier(current) {
  const at = FUNCTIONAL_TIERS.indexOf(current || "targeted");
  return at >= 0 && at < FUNCTIONAL_TIERS.length - 1 ? FUNCTIONAL_TIERS[at + 1] : null;
}

/**
 * The brief for regenerating just the broken module.
 *
 * Scoped to the files the findings actually name, so this is a rewrite of the data layer rather
 * than another pass over the whole project.
 */
export function regenerateModuleBrief({ findings, contract }) {
  const files = [...new Set((findings || []).map((f) => f.file))].filter((f) => f && f !== "src/");
  const entities = contract?.entities || [];
  return [
    "REGENERATE THIS MODULE — the targeted fix did not work.",
    "",
    `Rewrite ${files.length ? files.join(", ") : "the data layer"} from scratch. Keep the exported`,
    "function names the screens already import, so nothing else has to change, but do not keep the",
    "implementation: it stores data in the browser and must not.",
    "",
    "The module's entire job is to read and write these through db.entity() from ./lib/backend:",
    ...entities.map((e) => `  ${e.name} { ${(e.fields || []).map((f) => f.name).join(", ")} }`),
    "",
    "Every exported function must await a real db.entity() call. No browser storage of any kind,",
    "no in-memory arrays that outlive a function, no caches standing in for the database.",
    "Touch no other file.",
  ].join("\n");
}
