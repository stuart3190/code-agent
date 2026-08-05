// Context Retrieval Engine (master plan Part 2 §5 / Part 7) — the minimal context for one
// step, deterministically, with a HARD budget and a complete trace.
//
// Ranking, in order (scores fixed by the plan; ties broken smaller-file-first):
//   failureRefs bodies > targets bodies > direct deps of the write-set > distance-1 callers
//   as interfaces > bound-capability interfaces > everything else as summaries.
// Over budget demotes by ascending score — body -> interface -> summary — and NEVER truncates
// silently: every file lands in exactly one list with its reason and score in the trace.

import { tokensOf } from "./indexerV0.mjs";

export const FORMS = Object.freeze(["full", "interface", "summary", "omitted"]);

function interfaceOf(fileIndex) {
  if (!fileIndex) return "(unknown file)";
  if (fileIndex.opaque) return `${fileIndex.path} (opaque: ${fileIndex.tokens} tok — read_file for the body)`;
  const lines = [`${fileIndex.path}`];
  for (const s of fileIndex.symbols) {
    const entities = s.meta.entities.length ? ` entities:${s.meta.entities.join(",")}` : "";
    const routes = s.meta.routes.length ? ` routes:${s.meta.routes.join(",")}` : "";
    lines.push(`  ${s.exported ? "export " : ""}${s.kind} ${s.name}${entities}${routes}`);
  }
  return lines.join("\n");
}

function summaryOf(fileIndex) {
  if (!fileIndex) return "(unknown file)";
  const names = fileIndex.symbols.filter((s) => s.exported).map((s) => s.name).slice(0, 6);
  return `${fileIndex.path} — ${fileIndex.tokens} tok${names.length ? `; exports ${names.join(", ")}` : ""}`;
}

/**
 * @param graph       memoryGraph(...) over the CURRENT snapshot's index
 * @param tree        the materialised tree the graph was built from
 * @param targets     paths this step intends to WRITE (may include not-yet-existing paths)
 * @param failureRefs paths a verifier named
 * @param journeys    journeys this step owns (ownership via graph.owners)
 * @param capabilityPaths  bound capability interface files (e.g. src/lib/capabilities/…)
 */
export function retrieve({
  graph, tree, targets = [], failureRefs = [], journeys = [],
  capabilityPaths = [], budgetTokens = 12_000,
}) {
  const score = new Map();
  const reason = new Map();
  const note = (path, points, why) => {
    if (!(path in tree)) return; // planned-but-absent paths cost nothing and carry nothing
    if ((score.get(path) || 0) >= points) return;
    score.set(path, points);
    reason.set(path, why);
  };

  for (const path of failureRefs) note(path, 100, "a verifier pointed here");
  for (const path of targets) note(path, 50, "will be modified by this step");

  const writeSet = [...new Set([...failureRefs, ...targets])].filter((p) => p in tree);
  for (const path of writeSet) {
    for (const dep of graph.importsOf(path)) note(dep, 30, `direct dependency of ${path}`);
    for (const caller of graph.importersOf(path)) note(caller, 20, `distance-1 caller of ${path}`);
  }
  for (const path of capabilityPaths) note(path, 15, "bound capability interface");
  for (const journey of journeys) {
    for (const path of graph.owners(journey)) note(path, 5, `shares journey ${journey.id}`);
  }

  // Deterministic order: score desc, then smaller file, then path.
  const candidates = [...score.keys()].sort((a, b) => {
    const d = score.get(b) - score.get(a);
    if (d) return d;
    const t = tokensOf(tree[a]) - tokensOf(tree[b]);
    if (t) return t;
    return a.localeCompare(b);
  });

  const full = [];
  const budgetOmitted = [];
  const interfaces = [];
  const summaries = [];
  let used = 0;
  for (const path of candidates) {
    const points = score.get(path);
    const fileIndex = graph.file(path);
    const bodyTokens = tokensOf(tree[path]);
    const ifaceTokens = tokensOf(interfaceOf(fileIndex));
    // Bodies for the write-set and its direct deps; interfaces for callers/capabilities;
    // summaries for journey-sharers — each may DEMOTE (never promote) under the budget.
    const wantedForm = points >= 30 ? "full" : points >= 15 ? "interface" : "summary";
    const entry = { path, score: points, reason: reason.get(path) };
    if (wantedForm === "full" && used + bodyTokens <= budgetTokens) {
      full.push({ ...entry, form: "full", tokens: bodyTokens });
      used += bodyTokens;
    } else if (wantedForm !== "summary" && used + ifaceTokens <= budgetTokens) {
      interfaces.push({ ...entry, form: "interface", tokens: ifaceTokens, demoted: wantedForm === "full" });
      used += ifaceTokens;
    } else {
      const line = summaryOf(fileIndex);
      const t = tokensOf(line);
      if (used + t <= budgetTokens) {
        summaries.push({ ...entry, form: "summary", tokens: t, demoted: wantedForm !== "summary" });
        used += t;
      } else {
        // Even the one-line floor doesn't fit: the file is OMITTED, loudly, with its reason —
        // the budget is hard all the way down, and nothing ever overflows it silently.
        budgetOmitted.push({ ...entry, form: "omitted", tokens: 0, demoted: true });
      }
    }
  }

  const included = new Set(candidates.filter((p) => !budgetOmitted.some((o) => o.path === p)));
  const omitted = [
    ...budgetOmitted.map((o) => o.path),
    ...graph.paths().filter((p) => !included.has(p) && !budgetOmitted.some((o) => o.path === p)),
  ].sort();

  return {
    full, interfaces, summaries, omitted,
    tokens: used,
    budget: budgetTokens,
    trace: {
      query: { targets, failureRefs, journeys: journeys.map((j) => j.id), capabilityPaths, budgetTokens },
      included: [...full, ...interfaces, ...summaries, ...budgetOmitted].map(({ path, form, score: s, reason: r, tokens, demoted }) =>
        ({ path, form, score: s, reason: r, tokens, demoted: !!demoted })),
      omittedCount: omitted.length,
    },
  };
}

/** Render for a prompt: bodies, then interfaces, then one-line summaries. */
export function renderRetrieval(result, tree) {
  const lines = [];
  if (result.full.length) {
    lines.push("FILES IN FULL — each is here for a stated reason:");
    for (const f of result.full) lines.push(`\n// ${f.path} — ${f.reason}`, tree[f.path]);
  }
  if (result.interfaces.length) {
    lines.push("\nINTERFACES — green modules you code against; a full read is free if genuinely needed:");
    for (const f of result.interfaces) lines.push(f.iface || f.path);
  }
  if (result.summaries.length) {
    lines.push("\nALSO PRESENT:");
    for (const f of result.summaries) lines.push(`  ${f.path}`);
  }
  return lines.join("\n");
}
