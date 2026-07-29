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
import { createAnthropicProvider } from "../src/providers/anthropicProvider.mjs";
import { createRoutingProvider } from "../src/providers/routingProvider.mjs";
import { ratesForModel, chooseModel } from "../src/router/router.mjs";
import { fmtGBP, setActiveRates, USD_GBP } from "../src/cost.mjs";
import { ensureDeps } from "./workspace.mjs";
import { runEngineCase } from "./runEngineCase.mjs";
import { CASES } from "./cases/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = path.join(HERE, "..", "baseline");
const BYTES_PER_TOKEN = 3.6; // measured in the Phase 1 generation spike (6222 b / 1733 out-tok)

// Provider selection (the seam in action). Default = codex (FREE on the sub). `--provider=anthropic`
// (or APP_BUILDER_PROVIDER=anthropic) runs the SAME harness on the BYOK adapter — REAL money.
const PROVIDER = ((process.argv.find((a) => a.startsWith("--provider=")) || "").split("=")[1] || process.env.APP_BUILDER_PROVIDER || "codex").toLowerCase();
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const MODEL = PROVIDER === "anthropic" ? ANTHROPIC_MODEL : "gpt-5.5";

const WRITE_BASELINE = process.argv.includes("--baseline");
const EDIT_FORMAT = (process.argv.find((a) => a.startsWith("--edit=")) || "").split("=")[1] || undefined;
const EDIT_TOOL_NAME = EDIT_FORMAT === "apply_patch" ? "apply_patch" : EDIT_FORMAT === "search_replace" ? "edit_file" : null;
const CTX = process.argv.includes("--ctx"); // Phase 2.2 context selection (input-side lever)
const CACHE = process.argv.includes("--cache"); // Phase 2.3 cache-friendly shaping (stable prefix + append-only)

// Phase 2.4 model router. `--router` turns on the selection layer ABOVE the seam (a routing PROVIDER
// that delegates to the chosen model — runAgent is untouched). `--route=` picks the strategy:
//   auto         cost-aware: strong for generation, and for edits the cheaper model ONLY if its
//                apply_patch adherence makes it actually cheaper once fallback rewrites are priced in.
//   cheap-edits  force edits -> cheap (to MEASURE the cheap model's real adherence live).
//   strong       everything -> strong (the all-Sonnet A/B comparison baseline).
const ROUTER = process.argv.includes("--router");
const ROUTE_STRATEGY = (process.argv.find((a) => a.startsWith("--route=")) || "").split("=")[1] || "auto";
const STRONG_MODEL = (process.argv.find((a) => a.startsWith("--strong=")) || "").split("=")[1] || "claude-sonnet-4-6";
const CHEAP_MODEL = (process.argv.find((a) => a.startsWith("--cheap=")) || "").split("=")[1] || "claude-haiku-4-5";

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
    routedModel: r.routedModel,
    intent: r.intent,
  };
}

async function readJson(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}

// REAL-money preflight for the Anthropic BYOK path: show model/rates/key-source + an estimate, and
// hard-stop if the key is missing (nothing is sent). Estimate uses the recorded Codex suite shape.
function anthropicPreflight(provider) {
  console.log("\n══ Anthropic BYOK preflight (spends REAL money on your key) ══════════════════");
  console.log(`  model: ${provider.model}  ·  rates: ${provider.rates.label}`);
  console.log(`  key:   read from env ANTHROPIC_API_KEY only — never logged, written to disk, or committed`);
  const estIn = 18500, estOut = 5500; // ~recorded 3-case Codex suite shape
  const estUsd = (estIn / 1e6) * provider.rates.usdPerMInput + (estOut / 1e6) * provider.rates.usdPerMOutput;
  console.log(`  est:   ~${estIn} in + ~${estOut} out ≈ $${estUsd.toFixed(3)} (${fmtGBP(estUsd * USD_GBP)}) per suite run — pennies; billed on real tokens`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("  ABORT: ANTHROPIC_API_KEY is not set. Set it and re-run — nothing was sent.");
    return false;
  }
  console.log("  key present ✓ — proceeding to spend.");
  console.log("═════════════════════════════════════════════════════════════════════════════");
  return true;
}

// REAL-money preflight for the Phase 2.4 router path (Anthropic, multi-model). Shows the strong/cheap
// pair + strategy, the per-suite estimate at the edit-routed model's rates, and hard-stops on a
// missing key. All routing-measurement runs go through here.
function routerPreflight() {
  console.log("\n══ Phase 2.4 router preflight (spends REAL money on your key) ════════════════");
  console.log(`  strong: ${STRONG_MODEL}  ·  cheap: ${CHEAP_MODEL}  ·  strategy: ${ROUTE_STRATEGY}`);
  console.log(`  key:    read from env ANTHROPIC_API_KEY only — never logged, written to disk, or committed`);
  // The harness cases are all EDITs, so under strategy=strong they bill at the strong model's rates and
  // otherwise (auto/cheap-edits) at the cheap model's — estimate at whichever the edit route resolves to.
  const editModel = ROUTE_STRATEGY === "strong" ? STRONG_MODEL : CHEAP_MODEL;
  const rates = ratesForModel(editModel);
  const estIn = 18500, estOut = 5500; // ~recorded 3-case Anthropic suite shape
  const estUsd = (estIn / 1e6) * rates.usdPerMInput + (estOut / 1e6) * rates.usdPerMOutput;
  console.log(`  est:    edits route to ${editModel} → ~${estIn} in + ~${estOut} out ≈ $${estUsd.toFixed(3)} (${fmtGBP(estUsd * USD_GBP)}) per suite — pennies, billed on real tokens`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("  ABORT: ANTHROPIC_API_KEY is not set. Set it and re-run — nothing was sent.");
    return false;
  }
  console.log("  key present ✓ — proceeding to spend.");
  console.log("═════════════════════════════════════════════════════════════════════════════");
  return true;
}

async function main() {
  const modelLabel = ROUTER ? `router(strong=${STRONG_MODEL}, cheap=${CHEAP_MODEL}, route=${ROUTE_STRATEGY})` : MODEL;
  console.log(
    `Regression harness — ${CASES.length} archetype(s), provider=${ROUTER ? "anthropic+router" : PROVIDER}, model=${modelLabel}` +
      (EDIT_FORMAT ? ` · edit tool: ${EDIT_FORMAT}` : " · engine: write-only (baseline path)") +
      (CTX ? " · context selection: ON (Phase 2.2)" : "") +
      (CACHE ? " · cache-friendly: ON (Phase 2.3)" : "")
  );

  // Build the provider behind the SAME seam. Codex is FREE on the sub; Anthropic spends REAL money,
  // so it gets a cost preflight + a hard key check before anything runs. With --router, the provider
  // is the routing layer, built PER CASE inside the loop (intent -> chosen model) so its rates can
  // drive the live £; it gets its own real-money preflight here.
  let provider = null;
  let routerConfig = null;
  if (ROUTER) {
    if (!EDIT_FORMAT) {
      console.error("--router needs an edit tool (e.g. --edit=apply_patch) — the patch/fallback dynamic IS what routing weighs.");
      process.exit(2);
    }
    routerConfig = { provider: "anthropic", strong: STRONG_MODEL, cheap: CHEAP_MODEL, strategy: ROUTE_STRATEGY, cache: CACHE };
    if (!routerPreflight()) process.exit(2);
  } else if (PROVIDER === "anthropic") {
    provider = createAnthropicProvider({ model: ANTHROPIC_MODEL, cache: CACHE });
    setActiveRates(provider.rates); // REAL Anthropic rates drive the live £ + summary, not gpt-5.5 assumptions
    if (!anthropicPreflight(provider)) process.exit(2);
  } else if (PROVIDER === "codex") {
    provider = createCodexProvider();
  } else {
    console.error(`Unknown --provider=${PROVIDER} (expected "codex" or "anthropic").`);
    process.exit(2);
  }

  await ensureDeps();

  const results = [];
  for (const c of CASES) {
    console.log(`\n══ Case: ${c.name} — "${c.editPrompt}"`);
    // --router: resolve the route for this (single-intent) case, then run the chosen model behind the
    // unchanged seam. setActiveRates makes the live £ price at the routed model's REAL rates.
    let caseProvider = provider;
    let intent = "edit";
    if (ROUTER) {
      intent = Object.keys(c.startFiles || {}).length ? "edit" : "generate";
      caseProvider = createRoutingProvider({ config: routerConfig, turnMeta: { intent } });
      setActiveRates(caseProvider.rates);
      console.log(`  route: intent=${intent} -> ${caseProvider.model}  ::  ${caseProvider.decision.reason}`);
    }
    const r = await runEngineCase(caseProvider, c, { editFormat: EDIT_FORMAT, contextSelection: CTX, cacheFriendly: CACHE });
    r.routedModel = ROUTER ? caseProvider.model : MODEL;
    r.intent = intent;
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
  const totalInput = results.reduce((a, r) => a + r.telemetry.input, 0);
  const totalCached = results.reduce((a, r) => a + (r.telemetry.cached || 0), 0);
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
  console.log(
    `  CACHE: ${totalCached}/${totalInput} input tok cached` +
      ` = ${totalInput ? ((totalCached / totalInput) * 100).toFixed(1) : "0.0"}% hit rate` +
      ` (cached billed at ASSUMED 10% of input rate)`
  );

  const summary = { results, passed, totalTurns, totalGbp, totalTok, gbpPerTurn };

  if (ROUTER) {
    // Phase 2.4: write a per-strategy report and, once both A (strong) and B (cheap-edits) exist,
    // the combined A/B with the fallback decomposition. Never touches the committed Codex baselines.
    await reportPhase24(summary, routerConfig);
  } else if (PROVIDER === "anthropic") {
    // The Codex baselines (BASELINE/PHASE-2.*) are committed reference lines — an Anthropic run must
    // NOT overwrite them. It writes its own report and compares against them read-only.
    await reportAnthropic(summary);
  } else {
    if (WRITE_BASELINE) {
      if (EDIT_FORMAT) {
        console.error("\nRefusing to overwrite baseline with an edit-tool run. Use --baseline alone (write-only).");
        process.exit(2);
      }
      await writeBaseline(summary);
    }

    if (EDIT_FORMAT && CACHE) {
      await reportPhase23(summary);
    } else if (EDIT_FORMAT && CTX) {
      await reportPhase22(summary);
    } else if (EDIT_FORMAT) {
      await reportPhase21(summary);
    }
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

// ---- Phase 2.3 report: cache hit rate + discounted £/turn vs the recorded 2.2 line ----
async function reportPhase23({ results, passed, totalTurns, totalGbp, gbpPerTurn }) {
  let prev = null;
  try {
    prev = JSON.parse(await readFile(path.join(BASELINE_DIR, "PHASE-2.2.json"), "utf8"));
  } catch {
    console.warn("  (no PHASE-2.2.json found — skipping vs-2.2 comparison)");
  }

  const inTok = results.reduce((a, r) => a + r.telemetry.input, 0);
  const cachedTok = results.reduce((a, r) => a + (r.telemetry.cached || 0), 0);
  const hitRate = inTok ? cachedTok / inTok : 0;

  // 2.2 reference: it mutates `instructions` + prunes history every turn, so its prompt cache
  // hit rate is ~0 by construction. £ uses the SAME cache-discounted cost model (re-run 2.2 under
  // it for an apples-to-apples line). Total £ is the bill; per-turn is reported for context.
  const prevGbpPerTurn = prev ? prev.cost.gbpPerTurn : null;
  const prevTurns = prev ? prev.input.turns : null;
  const prevTotalGbp = prev && prevTurns != null ? prevGbpPerTurn * prevTurns : null;

  console.log("\n══ Phase 2.3 — cache-friendly shaping (stable prefix + append-only)");
  console.log(`  cache hit rate: ${(hitRate * 100).toFixed(1)}% (${cachedTok}/${inTok} input tok served from cache)`);
  console.log(`  discounted £/turn: ${fmtGBP(gbpPerTurn)} · total £: ${fmtGBP(totalGbp)} over ${totalTurns} turns`);
  if (prev) {
    const relOk = passed === results.length && passed >= prev.reliability.green;
    const cheaperTotal = prevTotalGbp != null && totalGbp < prevTotalGbp;
    const cheaperPerTurn = prevGbpPerTurn != null && gbpPerTurn < prevGbpPerTurn;
    console.log(
      `\n══ vs 2.2 (${fmtGBP(prevGbpPerTurn)}/turn over ${prevTurns} turns = ${fmtGBP(prevTotalGbp)} total, ${prev.reliability.green}/${prev.reliability.total} green):` +
        `\n  reliability ${passed}/${results.length} ${relOk ? "(floor held ✅)" : "(REGRESSED ❌)"}` +
        ` · total £ ${cheaperTotal ? "DOWN ✅" : "NOT down"} · £/turn ${cheaperPerTurn ? "DOWN ✅" : "up"}` +
        `\n  SHIP GATE: ${relOk && cheaperTotal ? "PASS — green AND total £ down." : "needs green AND total £ down (caching may be latency-gated on short cases — see notes)."}`
    );
  }

  await mkdir(BASELINE_DIR, { recursive: true });
  const date = new Date().toISOString();
  const perCase = results.map((r) => ({
    name: r.name,
    pass: r.pass,
    turns: r.telemetry.turns,
    input: r.telemetry.input,
    cached: r.telemetry.cached || 0,
    cacheHitRate: r.telemetry.cacheHitRate || 0,
    output: r.telemetry.output,
    gbpIfMetered: r.telemetry.gbp,
  }));

  const json = {
    recordedAt: date,
    model: MODEL,
    editFormat: EDIT_FORMAT,
    cacheFriendly: true,
    note:
      "Phase 2.3 cache-friendly run (stable frozen context block + append-only history; no prompt_cache_key — it suppressed hits on this transport). Caching VERIFIED live on the Codex-OAuth path (probe: 85% on a stable prefix). £ uses ASSUMED gpt-5.5 rates with cached input at 10% (src/cost.mjs); FREE on the sub. Single-pass per case; gpt-5.5 nondeterministic. Cache writes have propagation latency, so short (few-turn) cases may under-show hits vs a long session.",
    reliability: { green: passed, total: results.length, score: passed / results.length },
    cache: { totalInput: inTok, totalCached: cachedTok, hitRate },
    cost: { gbpPerTurn, totalGbpIfMetered: totalGbp, totalTurns },
    vs22: prev
      ? { gbpPerTurn: prevGbpPerTurn, totalGbp: prevTotalGbp, turns: prevTurns, green: prev.reliability.green, total: prev.reliability.total }
      : null,
    cases: perCase,
  };
  await writeFile(path.join(BASELINE_DIR, "PHASE-2.3.json"), JSON.stringify(json, null, 2), "utf8");

  const prevLine = prev ? `${fmtGBP(prevGbpPerTurn)}/turn over ${prevTurns} turns = ${fmtGBP(prevTotalGbp)} total, ${prev.reliability.green}/${prev.reliability.total} green` : "n/a";
  const relOkMd = passed === results.length && (!prev || passed >= prev.reliability.green);
  const cheaperTotalMd = prevTotalGbp != null && totalGbp < prevTotalGbp;
  const verdict = !relOkMd
    ? `**Verdict: DO NOT SHIP — reliability regressed below the 3/3 floor.**`
    : cheaperTotalMd
      ? `**Verdict: cache-friendly shaping beats 2.2 on total £ while holding 3/3 — eligible to become the default on the Codex path.**`
      : `**Verdict: caching is VERIFIED LIVE, but cache-friendly shaping did NOT beat 2.2 on total £ on this short-session harness — reliability held 3/3 and £/turn fell, but it took more turns and write-propagation latency left most short cases at 0 hits, so the total bill rose. 2.2 stays the DEFAULT on the Codex path; \`--cache\` is retained as opt-in and is the lever for the BYOK adapter (where the cache has no latency penalty and \`prompt_cache_key\` works) and for long interactive sessions. Nothing regressed; nothing is force-shipped.**`;
  const md = `# Phase 2.3 — prompt caching (cache-friendly request shaping)

_Recorded ${date} · model \`${MODEL}\` · edit format **\`${EDIT_FORMAT}\`** + cache-friendly shaping ON._

**Investigation result: prompt caching IS live on the reverse-engineered Codex-OAuth transport**
(\`chatgpt.com/backend-api/codex/responses\`). A direct probe reused **85%** of a stable
>1024-token prefix from cache, automatically, with **no** \`prompt_cache_key\` (setting one
actually suppressed hits to 0 here — the opposite of its public-API behaviour). Cache hits are
reported in \`usage.input_tokens_details.cached_tokens\`; cached input is billed at a large
discount (ASSUMED 10% of input rate).

The lever: keep the prompt prefix **byte-stable** and history **append-only** so the backend
serves repeated input from cache. The up-front context block (manifest + relevant-file contents)
is computed **once** from the initial tree and **frozen** — never regenerated — so \`instructions\`
is identical every turn; history is **not** pruned. This is the *opposite* trade-off to Phase 2.2,
which minimises raw input by regenerating a live context block and pruning history — that mutates
the prefix every turn and gets ~0 cache hits. \`--cache\` and \`--ctx\` are therefore alternatives.

## Headline vs 2.2 (${prevLine})

- **Reliability:** ${passed}/${results.length} cases green ${passed === results.length ? "— floor held ✅" : "— REGRESSED ❌"}.
- **Cache hit rate:** ${(hitRate * 100).toFixed(1)}% of input (${cachedTok}/${inTok} tok) served from cache.
- **£-if-metered:** ${fmtGBP(gbpPerTurn)}/turn · ${fmtGBP(totalGbp)} total over ${totalTurns} turns (cached input discounted).

${verdict}

## Per case

| case | result | turns | input tok | cached | hit% | out tok | £-if-metered |
|------|--------|-------|-----------|--------|------|---------|--------------|
${results
  .map((r) => {
    const hr = r.telemetry.input ? ((r.telemetry.cached || 0) / r.telemetry.input * 100).toFixed(0) : "0";
    return `| ${r.name} | ${r.pass ? "GREEN" : "RED"} | ${r.telemetry.turns} | ${r.telemetry.input} | ${r.telemetry.cached || 0} | ${hr}% | ${r.telemetry.output} | ${fmtGBP(r.telemetry.gbp)} |`;
  })
  .join("\n")}

## The provider asymmetry (for the Phase 4 credit model)

Caching benefits whichever provider serves it. On this Codex-OAuth path it is **live and free**
(no key, automatic). The future BYOK official-API adapter also caches (per OpenAI docs) and there
\`prompt_cache_key\` *does* help routing — so the cost-per-credit differs by provider and by request
shape. The edit tool (2.1) and context selection (2.2) are engine-level and help every provider;
caching (2.3) is a per-provider cost lever layered on top.

## Caveats

- **Single-pass per case.** gpt-5.5 is nondeterministic; reliability is one run per case.
- **Cache writes have propagation latency on this transport.** A cold prefix written on turn 1
  may not be readable a second or two later (observed in the probe: immediate back-to-back missed,
  but the same prefix hit minutes later). So short, few-turn harness cases can **under-show** the
  hit rate a longer interactive session would get. Treat the harness number as a floor.
- **No \`prompt_cache_key\` on the Codex path** — it suppressed hits in the probe; the passthrough
  exists in the provider for the BYOK adapter only.
- **Cost is hypothetical** — ASSUMED gpt-5.5 rates (incl. the 10% cached multiplier) in
  \`src/cost.mjs\`; everything was FREE on the ChatGPT sub.
`;
  await writeFile(path.join(BASELINE_DIR, "PHASE-2.3.md"), md, "utf8");
  console.log(`\nWrote baseline/PHASE-2.3.md + PHASE-2.3.json`);
}

function pctLower(prev, now) {
  return (((prev - now) / prev) * 100).toFixed(0);
}

// ---- Anthropic BYOK report: REAL £/turn + cache stats, compared READ-ONLY to the recorded Codex
// reference lines. The proof of the seam is reliability holding 3/3 with the engine untouched. ----
async function reportAnthropic({ results, passed, totalTurns, totalGbp, gbpPerTurn }) {
  const inTok = results.reduce((a, r) => a + r.telemetry.input, 0);
  const outTok = results.reduce((a, r) => a + r.telemetry.output, 0);
  const cachedTok = results.reduce((a, r) => a + (r.telemetry.cached || 0), 0);
  const cacheWriteTok = results.reduce((a, r) => a + (r.telemetry.cacheWrite || 0), 0);
  const hitRate = inTok ? cachedTok / inTok : 0;
  const relOk = passed === results.length;
  const mode = CACHE ? "--cache (2.3 cache-friendly)" : CTX ? "--ctx (2.2 context selection)" : EDIT_FORMAT ? `--edit=${EDIT_FORMAT}` : "write-only";

  const codexBase = await readJson(path.join(BASELINE_DIR, "baseline.json"));
  const codex22 = await readJson(path.join(BASELINE_DIR, "PHASE-2.2.json"));
  const codex23 = await readJson(path.join(BASELINE_DIR, "PHASE-2.3.json"));

  console.log("\n══ Anthropic BYOK report (REAL Messages-API rates) ══════════════════════════");
  console.log(`  provider=anthropic · model=${MODEL} · config=${mode}`);
  console.log(
    `  RELIABILITY: ${passed}/${results.length} cases green ` +
      (relOk ? "— SEAM HELD ✅ (same harness, different provider, engine untouched)" : "— REGRESSED ❌ (below the 3/3 floor — DO NOT SHIP)")
  );
  console.log(`  £/turn (REAL): ${fmtGBP(gbpPerTurn)} · total ${fmtGBP(totalGbp)} over ${totalTurns} turns`);
  console.log(`  tokens: ${inTok} in · ${outTok} out · cache-read ${cachedTok} (${(hitRate * 100).toFixed(1)}%) · cache-write ${cacheWriteTok}`);
  if (codexBase) console.log(`  vs Codex full-rewrite baseline: ${codexBase.reliability.green}/${codexBase.reliability.total} green @ ${fmtGBP(codexBase.cost.gbpPerTurn)}/turn (ASSUMED gpt-5.5; FREE on sub)`);
  if (CACHE && codex23) console.log(`  vs Codex 2.3 --cache: ${(codex23.cache.hitRate * 100).toFixed(1)}% hit, ${fmtGBP(codex23.cost.gbpPerTurn)}/turn (ASSUMED)`);
  if (CTX && codex22) console.log(`  vs Codex 2.2 --ctx: ${fmtGBP(codex22.cost.gbpPerTurn)}/turn (ASSUMED)`);

  await mkdir(BASELINE_DIR, { recursive: true });
  const date = new Date().toISOString();
  const json = {
    recordedAt: date,
    provider: "anthropic",
    model: MODEL,
    config: mode,
    note: "First BYOK adapter run, behind the SAME runTurn seam as Codex with the engine (runAgent/tools) untouched. £ uses REAL published Anthropic Messages-API rates (src/cost.mjs ANTHROPIC_RATES); this SPENT real money. Single-pass per case; the model is nondeterministic.",
    reliability: { green: passed, total: results.length, score: passed / results.length },
    cost: { gbpPerTurn, totalGbpIfMetered: totalGbp, totalTurns, real: true },
    tokens: { input: inTok, output: outTok },
    cache: { read: cachedTok, write: cacheWriteTok, hitRate },
    codexReference: {
      baseline: codexBase ? { green: codexBase.reliability.green, total: codexBase.reliability.total, gbpPerTurn: codexBase.cost.gbpPerTurn } : null,
      phase22: codex22 ? { gbpPerTurn: codex22.cost.gbpPerTurn } : null,
      phase23: codex23 ? { gbpPerTurn: codex23.cost.gbpPerTurn, hitRate: codex23.cache.hitRate } : null,
    },
    cases: results.map((r) => ({
      name: r.name,
      pass: r.pass,
      turns: r.telemetry.turns,
      input: r.telemetry.input,
      output: r.telemetry.output,
      cacheRead: r.telemetry.cached || 0,
      cacheWrite: r.telemetry.cacheWrite || 0,
      gbp: r.telemetry.gbp,
    })),
  };
  await writeFile(path.join(BASELINE_DIR, "ANTHROPIC.json"), JSON.stringify(json, null, 2), "utf8");

  const verdict = !relOk
    ? "**Verdict: DO NOT SHIP — reliability regressed below the committed 3/3 floor on the Anthropic adapter.**"
    : "**Verdict: the seam holds — the SAME regression harness passes 3/3 on a second provider (Anthropic Messages API) with `runAgent` and the tools untouched. The adapter alone translated the neutral shapes. £ is REAL (published Anthropic rates).**";
  const md = `# Anthropic BYOK adapter — first second-provider run

_Recorded ${date} · provider **anthropic** · model \`${MODEL}\` · config **${mode}**._

The first BYOK adapter (\`src/providers/anthropicProvider.mjs\`) runs behind the **same**
\`runTurn({systemPrompt, messages, tools}) -> {text, toolCalls, usage}\` seam as the Codex provider.
The engine (\`runAgent\`, the tools, the prompts, context selection) is **unchanged** — the adapter
alone translates the neutral message/tool/usage shapes to and from Anthropic's Messages API
(system param, \`tool_use\`/\`tool_result\` content blocks, SSE streaming, cache_control, usage fields).
Unlike the FREE Codex sub path, this **spent real money** on the user's key; £ figures use the
**REAL published** Anthropic rates in \`src/cost.mjs\`.

## Headline

- **Reliability:** ${passed}/${results.length} cases green ${relOk ? "— seam held ✅" : "— REGRESSED ❌"}.
- **£/turn (REAL):** ${fmtGBP(gbpPerTurn)} · total ${fmtGBP(totalGbp)} over ${totalTurns} turns.
- **Tokens:** ${inTok} in · ${outTok} out · cache-read ${cachedTok} (${(hitRate * 100).toFixed(1)}%) · cache-write ${cacheWriteTok}.

${verdict}

## Per case

| case | result | turns | input tok | output tok | cache-read | cache-write | £ (REAL) |
|------|--------|-------|-----------|------------|------------|-------------|----------|
${results
  .map(
    (r) =>
      `| ${r.name} | ${r.pass ? "GREEN" : "RED"} | ${r.telemetry.turns} | ${r.telemetry.input} | ${r.telemetry.output} | ${r.telemetry.cached || 0} | ${r.telemetry.cacheWrite || 0} | ${fmtGBP(r.telemetry.gbp)} |`
  )
  .join("\n")}

## vs the recorded Codex reference lines (read-only; ASSUMED gpt-5.5 rates, FREE on the sub)

${codexBase ? `- **Codex full-rewrite baseline:** ${codexBase.reliability.green}/${codexBase.reliability.total} green @ ${fmtGBP(codexBase.cost.gbpPerTurn)}/turn.` : "- (no baseline.json found)"}
${codex22 ? `- **Codex 2.2 \`--ctx\`:** ${fmtGBP(codex22.cost.gbpPerTurn)}/turn.` : ""}
${codex23 ? `- **Codex 2.3 \`--cache\`:** ${(codex23.cache.hitRate * 100).toFixed(1)}% cache-hit @ ${fmtGBP(codex23.cost.gbpPerTurn)}/turn.` : ""}

> Codex £ are ASSUMED (no public gpt-5.5 price) and FREE on the sub; Anthropic £ are REAL spend.
> They are not directly comparable as bills — the comparison that matters is **reliability parity**
> (same harness, both 3/3) and the **per-provider cost asymmetry** that feeds the Phase 4 credit model.

## Caching note (config \`${mode}\`)

cache-read ${cachedTok} / cache-write ${cacheWriteTok} tok. On \`--cache\`, Anthropic \`cache_control\`
breakpoints sit on the frozen tools+system prefix and the append-only history. \`${MODEL}\` has a
**${MODEL.includes("opus") ? "4096" : MODEL.includes("haiku") ? "4096" : "2048"}-token** minimum
cacheable prefix — a prefix under it silently won't write (treat a 0 here as a floor, not a ceiling).
Unlike the Codex transport, Anthropic caching has no write-propagation latency, so it is the lever
the 2.3 finding flagged as a **BYOK-only win**.

## Caveats

- **Single-pass per case;** the model is nondeterministic — reliability is one run per case.
- **Extended thinking is OFF** in this adapter (replaying \`thinking\` blocks would need the engine to
  carry them — out of scope for "adapter only, engine unchanged"). Revisit alongside the router.
- **£ is REAL** — published Anthropic rates in \`src/cost.mjs\`; this run spent money on the key.
`;
  await writeFile(path.join(BASELINE_DIR, "ANTHROPIC.md"), md, "utf8");
  console.log(`\nWrote baseline/ANTHROPIC.md + ANTHROPIC.json`);
}

// ---- Phase 2.4 router report -------------------------------------------------------------------
// Splits each run's output tokens into clean-patch turns vs write_file (fallback rewrite) turns, so
// the A/B can answer the real question: did routing edits to the cheap model lower cost, or did its
// weaker apply_patch adherence cause more rewrites that ate the saving? Writes PHASE-2.4.<strategy>.json
// each run, and the combined PHASE-2.4.md once both A (strong) and B (cheap-edits) exist.

// Decompose one run's turnLog: output tokens spent on patch turns vs write_file (rewrite) turns.
function decompose(results) {
  let patchOut = 0, writeOut = 0, patchTurns = 0, writeTurns = 0;
  for (const r of results) {
    for (const t of r.turnLog || []) {
      const wrote = t.tools.includes("write_file");
      const patched = t.tools.includes("apply_patch") || t.tools.includes("edit_file");
      if (wrote) { writeOut += t.output; writeTurns += 1; } // a fallback rewrite (attribute the whole turn)
      else if (patched) { patchOut += t.output; patchTurns += 1; }
    }
  }
  return { patchOut, writeOut, patchTurns, writeTurns };
}

function sumEditStats(results) {
  const k = ["attempts", "applies", "failures", "fallbacks", "writes"];
  const out = Object.fromEntries(k.map((x) => [x, results.reduce((a, r) => a + (r.editStats[x] || 0), 0)]));
  out.measuredAdherence = out.attempts ? out.applies / out.attempts : null; // clean applies / patch attempts
  return out;
}

async function reportPhase24({ results, passed, totalTurns, totalGbp, gbpPerTurn }, routerConfig) {
  await mkdir(BASELINE_DIR, { recursive: true });
  const date = new Date().toISOString();
  const strategy = routerConfig.strategy;
  const editModel = results.find((r) => r.intent === "edit")?.routedModel || routerConfig.strong;
  const inTok = results.reduce((a, r) => a + r.telemetry.input, 0);
  const outTok = results.reduce((a, r) => a + r.telemetry.output, 0);
  const dec = decompose(results);
  const edits = sumEditStats(results);

  const json = {
    recordedAt: date,
    provider: "anthropic",
    router: { strong: routerConfig.strong, cheap: routerConfig.cheap, strategy, cache: !!routerConfig.cache },
    editRoutedTo: editModel,
    note: "Phase 2.4 router run behind the SAME runTurn seam (a routing provider; runAgent untouched). All harness cases are edits, so the route is uniform per run. £ uses REAL published Anthropic rates (src/cost.mjs); this SPENT real money. Single-pass; the model is nondeterministic.",
    reliability: { green: passed, total: results.length, score: passed / results.length },
    cost: { gbpPerTurn, totalGbpIfMetered: totalGbp, totalTurns, real: true },
    tokens: { input: inTok, output: outTok },
    edits, // attempts/applies/fallbacks/writes + measuredAdherence (the value to feed back to `auto`)
    decomposition: dec, // patchOut vs writeOut — where the cheap model's output actually went
    cases: results.map((r) => ({
      name: r.name,
      pass: r.pass,
      routedModel: r.routedModel,
      turns: r.telemetry.turns,
      input: r.telemetry.input,
      output: r.telemetry.output,
      gbp: r.telemetry.gbp,
      editStats: r.editStats,
    })),
  };
  const jsonName = `PHASE-2.4.${strategy}.json`;
  await writeFile(path.join(BASELINE_DIR, jsonName), JSON.stringify(json, null, 2), "utf8");
  console.log(`\nWrote baseline/${jsonName}`);

  // Build the combined A/B once both the strong (A) and cheap-edits (B) runs exist.
  const A = await readJson(path.join(BASELINE_DIR, "PHASE-2.4.strong.json"));
  const B = await readJson(path.join(BASELINE_DIR, "PHASE-2.4.cheap-edits.json"));
  if (!(A && B)) {
    console.log(`  (A/B PHASE-2.4.md pending — have ${A ? "A=strong" : ""}${B ? "B=cheap-edits" : ""}; run the other strategy to complete it.)`);
    return;
  }

  const relOk = B.reliability.green === B.reliability.total;
  const cheaperTotal = B.cost.totalGbpIfMetered < A.cost.totalGbpIfMetered;
  const cheaperPerTurn = B.cost.gbpPerTurn < A.cost.gbpPerTurn;
  const totalPct = (((A.cost.totalGbpIfMetered - B.cost.totalGbpIfMetered) / A.cost.totalGbpIfMetered) * 100).toFixed(0);
  const cheapModel = B.editRoutedTo;
  const measured = B.edits.measuredAdherence;

  // What would `auto` decide now, given the MEASURED cheap-model adherence (prior -> measure -> calibrate)?
  const autoNow = chooseModel(
    { intent: "edit" },
    { provider: "anthropic", strong: A.editRoutedTo, cheap: cheapModel, strategy: "auto", adherence: measured != null ? { [cheapModel]: measured } : undefined }
  );

  // Erosion: of B's output, how much went to fallback REWRITES (the saving-eater).
  const bWriteShare = B.tokens.output ? (B.decomposition.writeOut / B.tokens.output) * 100 : 0;

  const verdict = !relOk
    ? `**Verdict: DO NOT SHIP — routing edits to ${cheapModel} regressed reliability to ${B.reliability.green}/${B.reliability.total}, below the committed 3/3 floor. The write_file fallback could not save a build the cheap model broke. Routing-to-${cheapModel} stays OFF.**`
    : cheaperTotal
      ? `**Verdict: routing edits to ${cheapModel} HELD 3/3 and cut total £ by ${totalPct}% vs all-${A.editRoutedTo} — routing pays on the Anthropic path even with ${cheapModel}'s weaker apply_patch adherence (${B.edits.fallbacks} fallback(s); ${bWriteShare.toFixed(0)}% of its output went to rewrites, which trimmed but did not erase the saving). Eligible to ship as the edit route, with the write_file fallback as the reliability floor.**`
      : `**Verdict: routing edits to ${cheapModel} HELD 3/3 but did NOT beat all-${A.editRoutedTo} on total £ — ${cheapModel}'s weaker apply_patch adherence caused ${B.edits.fallbacks} write_file fallback(s) (${bWriteShare.toFixed(0)}% of its output was full rewrites), and those rewrites ate the rate saving. This is a valid, honest finding: cheap ≠ cheaper here. Keep edits on ${A.editRoutedTo} (or improve the cheap model's patch adherence first). Nothing force-shipped.**`;

  const md = `# Phase 2.4 — model router (the router, and only the router)

_Recorded ${date} · provider **anthropic** · router strong=\`${A.editRoutedTo}\` cheap=\`${cheapModel}\` · edit tool \`apply_patch\` · input strategy \`--ctx\`._

The router is a **selection layer ABOVE the provider seam**: a routing provider
(\`src/providers/routingProvider.mjs\`) that asks the pure policy (\`src/router/router.mjs\`
\`chooseModel\`) which model to use, then delegates \`runTurn\` to it. \`runAgent\`, the tools, the
prompts and the cost model are **untouched** — the router never reaches into the engine. On the
single-model Codex lane it is a **thin pass-through** (nothing to route); the abstraction bites on
the multi-model Anthropic side, measured here.

**The encoded finding (\`baseline/ANTHROPIC.md\`):** a cheaper model with weaker \`apply_patch\`
adherence falls back to full \`write_file\` rewrites, and a rewrite emits far more output than a
patch — so routing an edit to a cheap model only pays *if it still patches cleanly*. The policy
prices this (cost-aware \`auto\`); this run **measures it for real**.

## A/B — all-strong vs routed-cheap-edits (REAL Anthropic spend, paired single-pass)

| run | edit route | reliability | £/turn | total £ | input tok | output tok | patch out | rewrite out | clean applies | fallbacks |
|-----|-----------|-------------|--------|---------|-----------|------------|-----------|-------------|---------------|-----------|
| **A — all-strong** | \`${A.editRoutedTo}\` (\`--route=strong\`) | ${A.reliability.green}/${A.reliability.total} | ${fmtGBP(A.cost.gbpPerTurn)} | ${fmtGBP(A.cost.totalGbpIfMetered)} | ${A.tokens.input} | ${A.tokens.output} | ${A.decomposition.patchOut} | ${A.decomposition.writeOut} | ${A.edits.applies}/${A.edits.attempts} | ${A.edits.fallbacks} |
| **B — routed** | \`${cheapModel}\` (\`--route=cheap-edits\`) | ${B.reliability.green}/${B.reliability.total} | ${fmtGBP(B.cost.gbpPerTurn)} | ${fmtGBP(B.cost.totalGbpIfMetered)} | ${B.tokens.input} | ${B.tokens.output} | ${B.decomposition.patchOut} | ${B.decomposition.writeOut} | ${B.edits.applies}/${B.edits.attempts} | ${B.edits.fallbacks} |

- **Reliability (the floor):** B = ${B.reliability.green}/${B.reliability.total} ${relOk ? "— held ✅" : "— REGRESSED ❌"}. (The Phase-2.1 \`write_file\` fallback is the safety net behind any failed cheap-model patch.)
- **Total £:** B ${cheaperTotal ? "DOWN ✅" : "NOT down ❌"} vs A (${fmtGBP(B.cost.totalGbpIfMetered)} vs ${fmtGBP(A.cost.totalGbpIfMetered)} = ${totalPct}% ${cheaperTotal ? "lower" : "higher"}). £/turn ${cheaperPerTurn ? "down" : "up"}.
- **Did fallbacks eat the saving?** ${bWriteShare.toFixed(0)}% of ${cheapModel}'s output went to full \`write_file\` rewrites (${B.edits.fallbacks} fallback(s) on ${B.edits.attempts} patch attempt(s)). ${cheaperTotal ? "They trimmed the saving but did not erase it." : "They erased the rate saving — this is the 'cheap ≠ cheaper' result."}

${verdict}

## Measured adherence → what \`auto\` decides now (prior → measure → calibrate)

The catalogue seeded \`${cheapModel}\` with a **prior** apply_patch adherence. This run **measured**
${measured != null ? `**${(measured * 100).toFixed(0)}%**` : "n/a"} (clean applies ÷ patch attempts = ${B.edits.applies}/${B.edits.attempts}).
Feeding that back into the pure \`auto\` policy, it would route an edit to:

> **${autoNow.model}** — ${autoNow.reason}

This closes the loop: the policy's edit decision is no longer a guess, it's grounded in a real
adherence number. (Update \`MODEL_CAPS["${cheapModel}"].patchAdherence\` to ${measured != null ? measured.toFixed(2) : "the measured value"} to make \`auto\` reflect it by default.)

## Per case (B — routed)

| case | route | result | turns | output tok | clean applies | fallbacks | write_file | £ (REAL) |
|------|-------|--------|-------|------------|---------------|-----------|-----------|----------|
${B.cases
  .map((c) => `| ${c.name} | ${c.routedModel} | ${c.pass ? "GREEN" : "RED"} | ${c.turns} | ${c.output} | ${c.editStats.applies}/${c.editStats.attempts} | ${c.editStats.fallbacks} | ${c.editStats.writes} | ${fmtGBP(c.gbp)} |`)
  .join("\n")}

## Scope + caveats

- **Router only.** No \`search_replace\`-vs-\`apply_patch\` A/B and no extended thinking this session
  (both flagged as separate future work; the router needs neither).
- **Single-intent harness.** Every case is an edit, so the route is uniform per run and telemetry
  prices it exactly at one model's rates. A future *mixed-intent* task switching models mid-run would
  need per-turn rate plumbing in telemetry — a seam extension, not built here.
- **Single-pass per case;** the model is nondeterministic — A and B are one paired run each.
- **£ is REAL** — published Anthropic rates in \`src/cost.mjs\`; these runs spent money on the key.
- **Generation route is policy-proven, not live-measured here** — the harness has no from-scratch
  generation case; \`auto\`/\`cheap-edits\` both keep generation on the strong model by construction.
`;
  await writeFile(path.join(BASELINE_DIR, "PHASE-2.4.md"), md, "utf8");
  console.log(`Wrote baseline/PHASE-2.4.md (A/B complete: A=strong, B=cheap-edits)`);
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
