// What a stage is allowed to see.
//
// The Supporting stage consumed 292,652 input tokens against 7,920 out — a 37:1 ratio — because
// every turn re-read whatever the previous stages had written. Nothing distinguished the file it
// was about to change from a file that merely existed.
//
// This builds context by asking why each file is needed, and refuses to include one that has no
// answer. Every inclusion carries its reason, so an oversized context can be explained rather than
// merely truncated. A file outside the change set contributes its manifest summary — about a
// fortieth of its tokens — not its body.

import { buildManifest, renderManifest, summariseFile, tokensOf, areasOf } from "./projectManifest.mjs";

// Why a file is in the context. Ordered by strength: when the budget binds, the weakest reasons
// are the ones demoted to summaries.
export const REASONS = Object.freeze({
  target: "will be modified by this stage",
  dependency: "directly imported by a file being modified",
  caller: "directly calls a file being modified",
  prior_stage: "written by an earlier stage this one builds on",
  shared: "shared interface, type or contract",
  failure: "a verifier pointed at this file",
  entry: "application entry point",
});

const REASON_RANK = { target: 5, failure: 5, dependency: 4, prior_stage: 4, caller: 3, entry: 2, shared: 1 };

// Small enough that including it wholesale is cheaper than reasoning about whether to.
const ALWAYS_FULL = new Set(["package.json"]);

/**
 * Which files a stage may modify.
 *
 * From the stage's own responsibility and the contract, not from the tree — a stage that is told
 * "here is everything" edits everything, which is how a polish stage ends up touching the data
 * layer.
 */
export function targetsForStage(stageId, manifest, { contract = null } = {}) {
  const files = manifest.files.map((f) => f.path);
  const match = (predicate) => files.filter(predicate);

  switch (stageId) {
    case "foundation":
      // The shell and the design system only. An earlier version matched all of src/components/,
      // which on the real booking tree is 20 of 27 files — the foundation stage would have been
      // handed most of the project to establish routing.
      return match((p) => /^src\/(App|main)\.(jsx?|tsx?)$/.test(p) || /^src\/(layout|routes)\//.test(p) || /\.css$/.test(p));
    case "data":
      return match((p) => /^src\/(data|lib|api|services|hooks)\//.test(p) && !p.startsWith("src/lib/backend/"));
    case "primary_journey": {
      const words = (contract?.journeys || []).filter((j) => j.priority === "primary")
        .flatMap((j) => `${j.id} ${j.title}`.toLowerCase().match(/[a-z]{4,}/g) || []);
      return match((p) => words.some((w) => p.toLowerCase().includes(w)) || /^src\/App\./.test(p));
    }
    case "supporting": {
      const words = (contract?.journeys || []).filter((j) => j.priority !== "primary")
        .flatMap((j) => `${j.id} ${j.title}`.toLowerCase().match(/[a-z]{4,}/g) || []);
      // Screens and pages, plus anything the secondary journeys name. NOT src/components/ui/ —
      // those are the design-system primitives (Button, Input, Label), which a supporting-screens
      // stage consumes rather than edits, and which made up most of its 18-file context.
      return match((p) => (words.some((w) => p.toLowerCase().includes(w))
        || /^src\/(pages|screens)\//.test(p)
        || (/^src\/components\//.test(p) && !/^src\/components\/ui\//.test(p))));
    }
    case "polish":
      return match((p) => /\.css$/.test(p) || /^src\/(components|layout)\//.test(p));

    // A repair owns NOTHING by default. Its change set is whatever the verifier named, supplied as
    // `failures`, and the one-hop expansion below reaches its callers and imports. Falling through
    // to "all of src/" here would have quietly reinstated the whole-tree repair this exists to end.
    case "repair":
      return [];

    default:
      return files.filter((p) => p.startsWith("src/"));
  }
}

/**
 * Build one stage's context.
 *
 * Returns `{ full, summaries, omitted, tokens, budget, ok, breakdown }`. Nothing is silently
 * dropped: every file is in exactly one of the three lists with a reason.
 */
export function buildStageContext({
  tree, manifest = null, stageId, contract = null, objective = "",
  systemPrompt = "", failures = [], budgetTokens = 40_000, priorFiles = [],
}) {
  const map = manifest || buildManifest(tree, { contract });
  const targets = new Set(targetsForStage(stageId, map, { contract }));

  // Files a verifier is complaining about are targets whatever the stage nominally owns.
  for (const failure of failures) {
    const named = String(failure).match(/(src\/[\w./-]+)/);
    if (named && map.get(named[1])) targets.add(named[1]);
  }

  const reasons = new Map();
  const note = (path, reason) => {
    const existing = reasons.get(path);
    if (!existing || REASON_RANK[reason] > REASON_RANK[existing]) reasons.set(path, reason);
  };

  for (const path of targets) note(path, failures.length ? "failure" : "target");

  // What earlier stages WROTE. This is the discovery-turn fix from the 24.26-credit booking
  // build: the data stage's targets were empty (its modules did not exist yet), so one-hop
  // expansion had nothing to hop from, and the model spent two full turns reading App.jsx and
  // listing files that the pipeline knew about all along — then a third asking permission for
  // the body. Every later stage integrates with what the earlier ones produced; those files
  // (and only those — never the tree) belong in its opening context.
  for (const path of priorFiles) {
    if (map.get(path)) note(path, "prior_stage");
  }

  // One hop out from the change set, both directions. Two hops is the whole project again.
  for (const path of [...targets]) {
    const file = map.get(path);
    if (!file) continue;
    for (const importer of file.importedBy || []) note(importer, "caller");
    for (const specifier of file.imports || []) {
      if (!specifier.startsWith(".")) continue;
      const resolved = map.files.find((f) => f.path.includes(specifier.replace(/^\.+\//, "").replace(/\.\w+$/, "")));
      if (resolved) note(resolved.path, "dependency");
    }
  }

  // The backend SDK is the interface every data operation is written against, and it is small.
  for (const file of map.files) {
    if (file.path.startsWith("src/lib/backend/")) note(file.path, "shared");
    if (/^src\/main\./.test(file.path)) note(file.path, "entry");
    if (ALWAYS_FULL.has(file.path)) note(file.path, "shared");
  }

  // Order by strength, then take full files until the budget is spent; everything else summarises.
  const fixed = tokensOf(systemPrompt) + tokensOf(objective)
    + tokensOf(contract ? JSON.stringify(contract) : "");
  const manifestTokens = tokensOf(renderManifest(map));

  const candidates = [...reasons.entries()]
    .map(([path, reason]) => ({ path, reason, file: map.get(path), tokens: map.get(path)?.tokens || 0 }))
    .filter((c) => c.file)
    .sort((a, b) => REASON_RANK[b.reason] - REASON_RANK[a.reason] || a.tokens - b.tokens);

  const full = [];
  const summaries = [];
  let used = fixed + manifestTokens;

  for (const candidate of candidates) {
    if (used + candidate.tokens <= budgetTokens) {
      full.push(candidate);
      used += candidate.tokens;
    } else {
      // Over budget: this file becomes a summary rather than being dropped, so the stage still
      // knows it exists and what it exports.
      summaries.push({ ...candidate, reason: `${candidate.reason} (summarised: context budget)` });
      used += tokensOf(summariseFile(candidate.file));
    }
  }

  const included = new Set([...full, ...summaries].map((c) => c.path));
  const omitted = map.files.filter((f) => !included.has(f.path))
    .map((f) => ({ path: f.path, tokens: f.tokens, reason: "not in the change set or one hop from it" }));

  return {
    stageId,
    full, summaries, omitted,
    tokens: used,
    budget: budgetTokens,
    ok: used <= budgetTokens,
    breakdown: {
      system: tokensOf(systemPrompt),
      objective: tokensOf(objective),
      contract: tokensOf(contract ? JSON.stringify(contract) : ""),
      manifest: manifestTokens,
      fullFiles: full.reduce((s, c) => s + c.tokens, 0),
      summaries: summaries.reduce((s, c) => s + tokensOf(summariseFile(c.file)), 0),
    },
    // What a whole-tree context would have cost, for the comparison that justifies all of this.
    wholeTreeTokens: fixed + map.totalTokens,
  };
}

/** The context, rendered. */
export function renderContext(context, tree, manifest) {
  const map = manifest || buildManifest(tree);
  const lines = [renderManifest(map), ""];

  if (context.full.length) {
    lines.push("FILES YOU MAY READ IN FULL — each is here for a stated reason:");
    for (const { path, reason } of context.full) {
      lines.push(`\n// ${path} — ${REASONS[reason] || reason}`);
      lines.push(tree[path]);
    }
  }
  if (context.summaries.length) {
    lines.push("\nVERIFIED FILES, SUMMARISED — ask for one by name if you need its implementation:");
    for (const { file } of context.summaries) lines.push(summariseFile(file));
  }
  return lines.join("\n");
}

/** A line for the profile, and the diagnostic that must exist before any oversized call. */
export function contextReport(context) {
  const b = context.breakdown;
  return [
    `context for ${context.stageId}: ${context.tokens} tokens of ${context.budget} `
      + `(whole tree would be ${context.wholeTreeTokens})`,
    `  system ${b.system} · objective ${b.objective} · contract ${b.contract} · manifest ${b.manifest} `
      + `· ${context.full.length} full files ${b.fullFiles} · ${context.summaries.length} summaries ${b.summaries}`,
    `  omitted ${context.omitted.length} files (${context.omitted.reduce((s, o) => s + o.tokens, 0)} tokens)`,
    ...context.full.map((c) => `  FULL ${c.path} (${c.tokens}) — ${REASONS[c.reason] || c.reason}`),
  ].join("\n");
}
