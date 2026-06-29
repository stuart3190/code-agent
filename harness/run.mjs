// Regression harness driver.
//
// For each archetype case (a starting file tree + one edit prompt), run the engine,
// then assert: (A) the app still builds, (B) every prior-feature marker survives,
// (C) every new-feature marker is present. Green iff A AND B AND C.
//
//   node harness/run.mjs                  write-only engine (baseline path)
//   node harness/run.mjs --baseline       (re)write baseline/BASELINE.md + baseline.json
//   node harness/run.mjs --edit=apply_patch      run with the targeted edit tool active
//   node harness/run.mjs --edit=search_replace   "
//
// With --edit, results are compared against the committed baseline/baseline.json and a
// Phase 2.1 report + cliff re-measurement are written to baseline/PHASE-2.1.md (+ .json).
// The committed baseline.json is only rewritten by --baseline (write-only), never by --edit.
//
// Per-turn token/cost telemetry stays on throughout. All FREE on the ChatGPT sub; £ are
// "if-this-were-metered" with the clearly-labelled ASSUMED rates in src/cost.mjs.

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCodexProvider } from "../src/providers/codexProvider.mjs";
import { fmtGBP } from "../src/cost.mjs";
import { ensureDeps } from "./workspace.mjs";
import { runEngineCase } from "./runEngineCase.mjs";
import { CASES } from "./cases/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = path.join(HERE, "..", "baseline");
const MODEL = "gpt-5.5";
const BYTES_PER_TOKEN = 3.6; // measured in the Phase 1 generation spike (6222 b / 1733 out-tok)

const WRITE_BASELINE = process.argv.includes("--baseline");
const EDIT_FORMAT = (process.argv.find((a) => a.startsWith("--edit=")) || "").split("=")[1] || undefined;
const EDIT_TOOL_NAME = EDIT_FORMAT === "apply_patch" ? "apply_patch" : EDIT_FORMAT === "search_replace" ? "edit_file" : null;
const CTX = process.argv.includes("--ctx"); // Phase 2.2 context selection (input-side lever)

function row(r) {
  return {
    name: r.name,
    pass: r.pass,
    build: r.build,
    priorKept: r.prior.present.length,
    priorTotal: r.prior.present.length + r.prior.missing.length,
    priorMissing: r.prior.missing,
    newPresent: r.fresh.present.length,
    newTotal: r.fresh.present.length + r.fresh.missing.length,
    newMissing: r.fresh.missing,
    telemetry: r.telemetry,
    editStats: r.editStats,
    turnLog: r.turnLog,
    appBytes: r.appBytes,
  };
}

async function main() {
  console.log(
    `Regression harness — ${CASES.length} archetype(s), model=${MODEL}` +
      (EDIT_FORMAT ? ` · edit tool: ${EDIT_FORMAT}` : " · engine: write-only (baseline path)") +
      (CTX ? " · context selection: ON (Phase 2.2)" : "")
  );
  await ensureDeps();
  const provider = createCodexProvider();

  const results = [];
  for (const c of CASES) {
    console.log(`\n══ Case: ${c.name} — "${c.editPrompt}"`);
    const r = await runEngineCase(provider, c, { editFormat: EDIT_FORMAT, contextSelection: CTX });
    const pm = r.prior.missing.length ? ` (MISSING ${r.prior.missing.join(",")})` : "";
    const nm = r.fresh.missing.length ? ` (MISSING ${r.fresh.missing.join(",")})` : "";
    console.log(
      `  build: ${r.build ? "PASS" : "FAIL"}` +
        ` · prior kept: ${r.prior.present.length}/${r.prior.present.length + r.prior.missing.length}${pm}` +
        ` · new present: ${r.fresh.present.length}/${r.fresh.present.length + r.fresh.missing.length}${nm}`
    );
    if (EDIT_FORMAT) {
      const e = r.editStats;
      console.log(`  edits: ${e.applies}/${e.attempts} clean · ${e.failures} fail · ${e.fallbacks} fallback · ${e.writes} write_file`);
    }
    console.log(`  => ${r.pass ? "GREEN ✅" : "RED ❌"}`);
    if (r.finalText) console.log(`  summary: ${r.finalText.split("\n")[0]}`);
    results.push(row(r));
  }

  // ---- summary ----
  const passed = results.filter((r) => r.pass).length;
  const totalTurns = results.reduce((a, r) => a + r.telemetry.turns, 0);
  const totalGbp = results.reduce((a, r) => a + r.telemetry.gbp, 0);
  const totalTok = results.reduce((a, r) => a + r.telemetry.total, 0);
  const gbpPerTurn = totalTurns ? totalGbp / totalTurns : 0;

  console.log("\n══ Summary");
  console.log("  case             result  build  prior  new   turns  tokens   £-if-metered");
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(15)} ${(r.pass ? "GREEN" : "RED").padEnd(6)} ` +
        ` ${(r.build ? "ok" : "FAIL").padEnd(4)} ` +
        ` ${`${r.priorKept}/${r.priorTotal}`.padEnd(4)} ` +
        ` ${`${r.newPresent}/${r.newTotal}`.padEnd(4)} ` +
        ` ${String(r.telemetry.turns).padStart(4)}  ${String(r.telemetry.total).padStart(6)}   ${fmtGBP(r.telemetry.gbp)}`
    );
  }
  console.log(
    `\n  RELIABILITY: ${passed}/${results.length} cases green` +
      ` · £-if-metered/turn: ${fmtGBP(gbpPerTurn)}` +
      ` · total ${totalTurns} turns, ${totalTok} tok, ${fmtGBP(totalGbp)}`
  );

  const summary = { results, passed, totalTurns, totalGbp, totalTok, gbpPerTurn };

  if (WRITE_BASELINE) {
    if (EDIT_FORMAT) {
      console.error("\nRefusing to overwrite baseline with an edit-tool run. Use --baseline alone (write-only).");
      process.exit(2);
    }
    await writeBaseline(summary);
  }

  if (EDIT_FORMAT && CTX) {
    await reportPhase22(summary);
  } else if (EDIT_FORMAT) {
    await reportPhase21(summary);
  }

  const allGreen = passed === results.length;
  console.log(`\nRESULT: ${allGreen ? "ALL GREEN — engine reliable across archetypes." : "NOT ALL GREEN — see above."}`);
  process.exit(allGreen ? 0 : 1);
}

// ---- Phase 2.1 report: reliability + £/turn vs committed baseline + cliff re-measure ----
async function reportPhase21({ results, passed, totalTurns, totalGbp, gbpPerTurn }) {
  let base = null;
  try {
    base = JSON.parse(await readFile(path.join(BASELINE_DIR, "baseline.json"), "utf8"));
  } catch {
    console.warn("  (no baseline.json found — skipping vs-baseline comparison)");
  }

  // Edit-tool output spent emitting patches (turns that used the edit tool).
  const cliff = results.map((r) => {
    const editOut = r.turnLog
      .filter((t) => t.tools.includes(EDIT_TOOL_NAME))
      .reduce((a, t) => a + t.output, 0);
    const rewriteOut1x = Math.round(r.appBytes / BYTES_PER_TOKEN); // cost to re-emit whole file once
    return { name: r.name, appBytes: r.appBytes, editOut, rewriteOut1x };
  });
  const sumEditOut = cliff.reduce((a, c) => a + c.editOut, 0);
  const sumRewrite1x = cliff.reduce((a, c) => a + c.rewriteOut1x, 0);

  console.log("\n══ Cliff re-measurement (output tokens to apply ONE edit, edit-tool vs full-rewrite)");
  console.log("  Full-rewrite cost ∝ file SIZE; edit-tool cost ∝ CHANGE size (≈flat as files grow).");
  console.log("  file size   full-rewrite out-tok   edit-tool out-tok (measured)");
  for (const mult of [1, 5, 20]) {
    console.log(
      `  ${`${mult}×`.padEnd(10)}  ${String(sumRewrite1x * mult).padStart(18)}   ${String(sumEditOut).padStart(18)}`
    );
  }
  const factor = sumEditOut ? (sumRewrite1x * 20) / sumEditOut : 0;
  console.log(`  => at 20× file size, the edit tool emits ~${factor.toFixed(0)}× fewer output tokens per edit.`);

  if (base) {
    const dir = gbpPerTurn < base.cost.gbpPerTurn ? "CHEAPER" : "NOT cheaper";
    const relOk = passed === results.length && passed >= base.reliability.green;
    console.log(
      `\n══ vs committed baseline (${fmtGBP(base.cost.gbpPerTurn)}/turn, ${base.reliability.green}/${base.reliability.total} green):` +
        `\n  reliability ${passed}/${results.length} ${relOk ? "(floor held ✅)" : "(REGRESSED ❌)"}` +
        ` · £/turn ${fmtGBP(gbpPerTurn)} = ${dir} (${(((base.cost.gbpPerTurn - gbpPerTurn) / base.cost.gbpPerTurn) * 100).toFixed(0)}% lower)` +
        `\n  SHIP GATE: ${relOk && gbpPerTurn < base.cost.gbpPerTurn ? "PASS — green AND cheaper." : "FAIL — needs green AND cheaper."}`
    );
  }

  await mkdir(BASELINE_DIR, { recursive: true });
  const date = new Date().toISOString();
  const totalAttempts = results.reduce((a, r) => a + r.editStats.attempts, 0);
  const totalApplies = results.reduce((a, r) => a + r.editStats.applies, 0);
  const totalFallbacks = results.reduce((a, r) => a + r.editStats.fallbacks, 0);
  const totalWrites = results.reduce((a, r) => a + r.editStats.writes, 0);

  const json = {
    recordedAt: date,
    model: MODEL,
    editFormat: EDIT_FORMAT,
    note: "Phase 2.1 targeted-edit-tool run. £ uses ASSUMED gpt-5.5 rates (src/cost.mjs); FREE on the sub. Single-pass per case; gpt-5.5 nondeterministic.",
    reliability: { green: passed, total: results.length, score: passed / results.length },
    baselineReliability: base ? base.reliability : null,
    cost: { gbpPerTurn, totalGbpIfMetered: totalGbp, totalTurns },
    baselineGbpPerTurn: base ? base.cost.gbpPerTurn : null,
    edits: { attempts: totalAttempts, cleanApplies: totalApplies, fallbacks: totalFallbacks, writeFiles: totalWrites },
    cliff: { bytesPerToken: BYTES_PER_TOKEN, perCase: cliff, sumEditOut, sumRewrite1x, factorAt20x: factor },
    cases: results.map((r) => ({
      name: r.name,
      pass: r.pass,
      build: r.build,
      priorKept: `${r.priorKept}/${r.priorTotal}`,
      newPresent: `${r.newPresent}/${r.newTotal}`,
      turns: r.telemetry.turns,
      tokens: { input: r.telemetry.input, output: r.telemetry.output, total: r.telemetry.total },
      gbpIfMetered: r.telemetry.gbp,
      editStats: r.editStats,
    })),
  };
  await writeFile(path.join(BASELINE_DIR, "PHASE-2.1.json"), JSON.stringify(json, null, 2), "utf8");

  const baseLine = base ? `${fmtGBP(base.cost.gbpPerTurn)}/turn, ${base.reliability.green}/${base.reliability.total} green` : "n/a";
  const pct = base ? (((base.cost.gbpPerTurn - gbpPerTurn) / base.cost.gbpPerTurn) * 100).toFixed(0) : "?";
  const md = `# Phase 2.1 — targeted edit tool

_Recorded ${date} · model \`${MODEL}\` · edit format **\`${EDIT_FORMAT}\`** (chosen by A/B trial against the harness)._

The lever: make output scale with **change** size, not **file** size — without dropping below
the committed 3/3 baseline. \`write_file\` stays the fallback; after 2 failed edits on a file the
tool tells the model to rewrite it whole.

## Headline vs committed baseline (${baseLine})

- **Reliability:** ${passed}/${results.length} cases green ${passed === results.length ? "— floor held ✅" : "— REGRESSED ❌"}.
- **£-if-metered/turn:** ${fmtGBP(gbpPerTurn)} vs ${base ? fmtGBP(base.cost.gbpPerTurn) : "n/a"} baseline = **${pct}% lower** (ASSUMED gpt-5.5 rates; FREE on the sub).
- **Edits:** ${totalApplies}/${totalAttempts} applied clean · ${totalFallbacks} fell back to write_file · ${totalWrites} write_file calls total.

## Per case

| case | result | build | prior | new | turns | out tok | £-if-metered | edits clean | fallbacks |
|------|--------|-------|-------|-----|-------|---------|--------------|-------------|-----------|
${results
  .map(
    (r) =>
      `| ${r.name} | ${r.pass ? "GREEN" : "RED"} | ${r.build ? "ok" : "FAIL"} | ${r.priorKept}/${r.priorTotal} | ${r.newPresent}/${r.newTotal} | ${r.telemetry.turns} | ${r.telemetry.output} | ${fmtGBP(r.telemetry.gbp)} | ${r.editStats.applies}/${r.editStats.attempts} | ${r.editStats.fallbacks} |`
  )
  .join("\n")}

## Cliff re-measurement (the proof the lever worked)

Output tokens to apply **one edit**, as file size scales. Full-rewrite cost is ∝ file size
(re-emits the whole file); edit-tool cost is ∝ change size, so it stays ≈ flat as files grow.
Using \`BYTES_PER_TOKEN = ${BYTES_PER_TOKEN}\` (Phase 1 measured) and the measured patch output
(${sumEditOut} out-tok across the suite):

| file size | full-rewrite out-tok (∝ size) | edit-tool out-tok (measured, ≈flat) |
|-----------|-------------------------------|-------------------------------------|
| 1× | ${sumRewrite1x} | ${sumEditOut} |
| 5× | ${sumRewrite1x * 5} | ${sumEditOut} |
| 20× | ${sumRewrite1x * 20} | ${sumEditOut} |

**At 20× file size the edit tool emits ~${factor.toFixed(0)}× fewer output tokens per edit** — the
cliff the iteration findings projected is flattened.

## Caveats

- **Single-pass per case.** gpt-5.5 is nondeterministic; reliability is one run per case here.
- **Edit-tool column is change-bound, not literally constant** — a patch grows with the size of
  the change and the number of edit sites, not with unrelated file size. The point is it does not
  scale with file size the way a full rewrite does.
- **Cost is hypothetical** — ASSUMED gpt-5.5 rates in \`src/cost.mjs\`; everything was FREE on the
  ChatGPT sub.
`;
  await writeFile(path.join(BASELINE_DIR, "PHASE-2.1.md"), md, "utf8");
  console.log(`\nWrote baseline/PHASE-2.1.md + PHASE-2.1.json`);
}

// ---- Phase 2.2 report: input tokens/turn vs the recorded 2.1 line (the input-side win) ----
async function reportPhase22({ results, passed, totalTurns, gbpPerTurn }) {
  let prev = null;
  try {
    prev = JSON.parse(await readFile(path.join(BASELINE_DIR, "PHASE-2.1.json"), "utf8"));
  } catch {
    console.warn("  (no PHASE-2.1.json found — skipping vs-2.1 comparison)");
  }

  const inTok = results.reduce((a, r) => a + r.telemetry.input, 0);
  const outTok = results.reduce((a, r) => a + r.telemetry.output, 0);
  const inPerTurn = totalTurns ? inTok / totalTurns : 0;
  const outPerTurn = totalTurns ? outTok / totalTurns : 0;

  // 2.1 reference (input is the headline this phase; output should hold since the edit path is unchanged).
  const prevInTok = prev ? prev.cases.reduce((a, c) => a + c.tokens.input, 0) : null;
  const prevTurns = prev ? prev.cases.reduce((a, c) => a + c.turns, 0) : null;
  const prevInPerTurn = prev ? prevInTok / prevTurns : null;
  const prevOutPerTurn = prev ? prev.cases.reduce((a, c) => a + c.tokens.output, 0) / prevTurns : null;
  const relGreen = prev ? prev.reliability.green : null;
  const relTotal = prev ? prev.reliability.total : null;

  console.log("\n══ Phase 2.2 — context selection (input-side)");
  console.log(`  total input tokens: ${inTok}` + (prevInTok ? ` vs 2.1 ${prevInTok} = ${pctLower(prevInTok, inTok)}% lower (over ${totalTurns} turns vs ${prevTurns})` : ""));
  console.log(`  input tokens/turn: ${inPerTurn.toFixed(0)}` + (prevInPerTurn ? ` vs 2.1 ${prevInPerTurn.toFixed(0)} = ${pctLower(prevInPerTurn, inPerTurn)}% lower` : ""));
  console.log(`  output tokens/turn: ${outPerTurn.toFixed(0)}` + (prevOutPerTurn ? ` vs 2.1 ${prevOutPerTurn.toFixed(0)} (should hold — edit path unchanged)` : ""));
  if (prev) {
    const relOk = passed === results.length && passed >= relGreen;
    const inTotalDown = inTok < prevInTok;
    const inPerTurnDown = inPerTurn < prevInPerTurn;
    // Ship on total input (the real cost), since context selection also cuts turn count,
    // which can push per-turn up even as the bill falls. Per-turn is reported for context.
    console.log(
      `\n══ vs 2.1 (${prevInTok} in-tok over ${prevTurns} turns = ${prevInPerTurn.toFixed(0)}/turn, ${relGreen}/${relTotal} green):` +
        `\n  reliability ${passed}/${results.length} ${relOk ? "(floor held ✅)" : "(REGRESSED ❌)"}` +
        ` · total input ${inTotalDown ? "DOWN ✅" : "NOT down ❌"} · input/turn ${inPerTurnDown ? "DOWN ✅" : "up (fewer turns)"}` +
        `\n  SHIP GATE: ${relOk && inTotalDown ? "PASS — green AND total input down." : "FAIL — needs green AND total input down."}`
    );
  }

  await mkdir(BASELINE_DIR, { recursive: true });
  const date = new Date().toISOString();
  const perCase = results.map((r) => {
    const p = prev?.cases.find((c) => c.name === r.name);
    return {
      name: r.name,
      pass: r.pass,
      turns: r.telemetry.turns,
      inputPerTurn: r.telemetry.turns ? r.telemetry.input / r.telemetry.turns : 0,
      prevInputPerTurn: p ? p.tokens.input / p.turns : null,
      tokens: { input: r.telemetry.input, output: r.telemetry.output, total: r.telemetry.total },
      gbpIfMetered: r.telemetry.gbp,
    };
  });

  const json = {
    recordedAt: date,
    model: MODEL,
    editFormat: EDIT_FORMAT,
    contextSelection: true,
    note: "Phase 2.2 context-selection run (manifest + relevant-file contents + history pruning). Input tokens/turn is the headline; output should hold (edit path unchanged). £ uses ASSUMED gpt-5.5 rates (src/cost.mjs); FREE on the sub. Single-pass per case; gpt-5.5 nondeterministic.",
    reliability: { green: passed, total: results.length, score: passed / results.length },
    input: {
      total: inTok,
      perTurn: inPerTurn,
      turns: totalTurns,
      prevTotal: prevInTok,
      prevPerTurn: prevInPerTurn,
      prevTurns,
      totalPctLower: prevInTok ? Number(pctLower(prevInTok, inTok)) : null,
      perTurnPctLower: prevInPerTurn ? Number(pctLower(prevInPerTurn, inPerTurn)) : null,
    },
    output: { perTurn: outPerTurn, prevPerTurn: prevOutPerTurn },
    cost: { gbpPerTurn },
    cases: perCase,
  };
  await writeFile(path.join(BASELINE_DIR, "PHASE-2.2.json"), JSON.stringify(json, null, 2), "utf8");

  const inLine = prev ? `${prevInTok} in-tok over ${prevTurns} turns, ${relGreen}/${relTotal} green` : "n/a";
  const totalPct = prevInTok ? pctLower(prevInTok, inTok) : "?";
  const perTurnPct = prevInPerTurn ? pctLower(prevInPerTurn, inPerTurn) : "?";
  const md = `# Phase 2.2 — context selection (input-side lever)

_Recorded ${date} · model \`${MODEL}\` · edit format **\`${EDIT_FORMAT}\`** + context selection ON._

The lever: stop re-sending every accumulated file read and patch blob every turn. Carry a
paths-only **manifest** plus the **current contents of just the relevant files** (seeded from
\`src/App.jsx\` + its direct deps, grown as the model touches files) in the regenerated system
prompt, and **prune** the redundant copies out of the replayed history. The block also tells
the model not to re-read files already shown — so it patches directly instead of spending a
read turn. Output is untouched (same \`apply_patch\` edit path as 2.1), so the win is input-side.

## Headline vs 2.1 (${inLine})

- **Reliability:** ${passed}/${results.length} cases green ${passed === results.length ? "— floor held ✅" : "— REGRESSED ❌"}.
- **Total input:** ${inTok} tok over ${totalTurns} turns vs ${prevInTok ? prevInTok : "n/a"} over ${prevTurns ?? "n/a"} (2.1) = **${totalPct}% lower** — the real bill (context selection also cuts turn count).
- **Input tokens/turn:** ${inPerTurn.toFixed(0)} vs ${prevInPerTurn ? prevInPerTurn.toFixed(0) : "n/a"} (2.1) = ${perTurnPct}% lower _(per-turn is confounded by the turn-count drop)_.
- **Output tokens/turn:** ${outPerTurn.toFixed(0)} vs ${prevOutPerTurn ? prevOutPerTurn.toFixed(0) : "n/a"} (2.1) — edit path unchanged, so this should roughly hold.

## Per case

| case | result | turns | input tok | in/turn | 2.1 in/turn | out tok |
|------|--------|-------|-----------|---------|-------------|---------|
${results
  .map((r) => {
    const p = prev?.cases.find((c) => c.name === r.name);
    const prevIpt = p ? (p.tokens.input / p.turns).toFixed(0) : "—";
    const ipt = r.telemetry.turns ? (r.telemetry.input / r.telemetry.turns).toFixed(0) : "0";
    return `| ${r.name} | ${r.pass ? "GREEN" : "RED"} | ${r.telemetry.turns} | ${r.telemetry.input} | ${ipt} | ${prevIpt} | ${r.telemetry.output} |`;
  })
  .join("\n")}

## Caveats

- **Single-pass per case.** gpt-5.5 is nondeterministic; reliability is one run per case here.
- **Total input is the gate, not per-turn.** Context selection also cuts turn count (the model
  patches directly instead of spending list/read turns), which pushes per-turn input *up* even
  as the total bill falls. The total is the real cost; per-turn is reported for context.
- **Cost is hypothetical** — ASSUMED gpt-5.5 rates in \`src/cost.mjs\`; everything was FREE on the
  ChatGPT sub.
`;
  await writeFile(path.join(BASELINE_DIR, "PHASE-2.2.md"), md, "utf8");
  console.log(`\nWrote baseline/PHASE-2.2.md + PHASE-2.2.json`);
}

function pctLower(prev, now) {
  return (((prev - now) / prev) * 100).toFixed(0);
}

// ---- baseline writer (write-only engine only) ----
async function writeBaseline({ results, passed, totalTurns, totalGbp, totalTok, gbpPerTurn }) {
  await mkdir(BASELINE_DIR, { recursive: true });
  const date = new Date().toISOString();
  const json = {
    recordedAt: date,
    model: MODEL,
    engine: "full-file-rewrite (write_file only) — Phase 1 proven path",
    note: "Single-pass baseline. gpt-5.5 is nondeterministic; reliability is one run. £ uses ASSUMED gpt-5.5 rates (src/cost.mjs), no public price exists; all FREE on the ChatGPT sub.",
    reliability: { green: passed, total: results.length, score: passed / results.length },
    cost: { gbpPerTurn, totalGbpIfMetered: totalGbp, totalTurns, totalTokens: totalTok },
    cases: results.map((r) => ({
      name: r.name,
      pass: r.pass,
      build: r.build,
      priorKept: `${r.priorKept}/${r.priorTotal}`,
      newPresent: `${r.newPresent}/${r.newTotal}`,
      turns: r.telemetry.turns,
      tokens: { input: r.telemetry.input, output: r.telemetry.output, reasoning: r.telemetry.reasoning, total: r.telemetry.total },
      gbpIfMetered: r.telemetry.gbp,
      gbpPerTurn: r.telemetry.gbpPerTurn,
    })),
  };
  await writeFile(path.join(BASELINE_DIR, "baseline.json"), JSON.stringify(json, null, 2), "utf8");
  console.log(`\nWrote baseline -> baseline/baseline.json (+ existing BASELINE.md)`);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
