// Regression harness driver.
//
// For each archetype case (a starting file tree + one edit prompt), run the real
// graduated engine, then assert: (A) the app still builds, (B) every prior-feature
// marker survives, (C) every new-feature marker is present. Green iff A AND B AND C.
//
//   node harness/run.mjs              run all cases, print green/red + cost summary
//   node harness/run.mjs --baseline   also write baseline/BASELINE.md + baseline.json
//
// Per-turn token/cost telemetry stays on throughout (build plan: every optimisation's
// effect must be visible in real numbers). All FREE on the ChatGPT sub; £ figures are
// "if-this-were-metered" with the clearly-labelled ASSUMED rates in src/cost.mjs.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCodexProvider } from "../src/providers/codexProvider.mjs";
import { runAgent } from "../src/engine/runAgent.mjs";
import { fromScaffold, clone } from "../src/engine/fileTree.mjs";
import { makeFileTools } from "../src/tools/fileTools.mjs";
import { EDIT_SYSTEM_PROMPT } from "../src/prompts/builder.mjs";
import { fmtGBP } from "../src/cost.mjs";
import { markersPresent } from "./assertions.mjs";
import { ensureDeps, buildTree } from "./workspace.mjs";
import { CASES } from "./cases/index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_DIR = path.join(HERE, "..", "baseline");
const MODEL = "gpt-5.5"; // matches the provider seam
const WRITE_BASELINE = process.argv.includes("--baseline");

async function runCase(provider, c) {
  console.log(`\n══ Case: ${c.name} — "${c.editPrompt}"`);

  // Starting tree (scaffold + the case's pre-built app), cloned so nothing shared mutates.
  const tree = clone(fromScaffold(c.scaffold, c.startFiles));
  const { schemas, impls } = makeFileTools(tree);

  const { telemetry, finalText } = await runAgent({
    provider,
    systemPrompt: EDIT_SYSTEM_PROMPT,
    tools: schemas,
    toolImpls: impls,
    tree,
    prompt: c.editPrompt,
  });

  // (A) builds, (B) prior features survive, (C) new feature present.
  const build = await buildTree(tree, c.name);
  const prior = markersPresent(tree, c.priorFeatures);
  const fresh = markersPresent(tree, c.newFeature);

  const pass = build.ok && prior.missing.length === 0 && fresh.missing.length === 0;

  console.log(
    `  build: ${build.ok ? "PASS" : "FAIL"}` +
      ` · prior kept: ${prior.present.length}/${c.priorFeatures.length}` +
      `${prior.missing.length ? ` (MISSING ${prior.missing.join(",")})` : ""}` +
      ` · new present: ${fresh.present.length}/${c.newFeature.length}` +
      `${fresh.missing.length ? ` (MISSING ${fresh.missing.join(",")})` : ""}`
  );
  console.log(`  => ${pass ? "GREEN ✅" : "RED ❌"}`);
  if (finalText) console.log(`  summary: ${finalText.split("\n")[0]}`);

  return {
    name: c.name,
    pass,
    build: build.ok,
    priorKept: prior.present.length,
    priorTotal: c.priorFeatures.length,
    priorMissing: prior.missing,
    newPresent: fresh.present.length,
    newTotal: c.newFeature.length,
    newMissing: fresh.missing,
    telemetry,
  };
}

async function main() {
  console.log(`Regression harness — ${CASES.length} archetype(s), model=${MODEL}`);
  await ensureDeps();

  const provider = createCodexProvider();
  const results = [];
  for (const c of CASES) {
    results.push(await runCase(provider, c));
  }

  // ---- summary table ----
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

  if (WRITE_BASELINE) {
    await writeBaseline({ results, passed, totalTurns, totalGbp, totalTok, gbpPerTurn });
  }

  const allGreen = passed === results.length;
  console.log(`\nRESULT: ${allGreen ? "ALL GREEN — engine reliable across archetypes." : "NOT ALL GREEN — see above."}`);
  process.exit(allGreen ? 0 : 1);
}

async function writeBaseline({ results, passed, totalTurns, totalGbp, totalTok, gbpPerTurn }) {
  await mkdir(BASELINE_DIR, { recursive: true });
  const date = new Date().toISOString();

  const json = {
    recordedAt: date,
    model: MODEL,
    engine: "full-file-rewrite (write_file only) — Phase 1 proven path",
    note: "Single-pass baseline. gpt-5.5 is nondeterministic; reliability is one run. £ uses ASSUMED gpt-5.5 rates (src/cost.mjs), no public price exists; all FREE on the ChatGPT sub.",
    reliability: { green: passed, total: results.length, score: passed / results.length },
    cost: {
      gbpPerTurn,
      totalGbpIfMetered: totalGbp,
      totalTurns,
      totalTokens: totalTok,
    },
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

  const md = `# Phase 2 baseline — full-file-rewrite engine

_Recorded ${date} · model \`${MODEL}\` · engine: full-file rewrite (\`write_file\` only), the Phase 1 proven path._

This is the line every Phase 2 optimisation must beat **on cost without dropping on reliability**.

## Headline

- **Reliability:** ${passed}/${results.length} cases green (${((passed / results.length) * 100).toFixed(0)}%).
- **£-if-metered per turn:** ${fmtGBP(gbpPerTurn)} (ASSUMED gpt-5.5 rates — no public price; all FREE on the ChatGPT sub).
- **Totals:** ${totalTurns} turns · ${totalTok} blended tokens · ${fmtGBP(totalGbp)} if metered.

## Per case

| case | result | build | prior kept | new present | turns | in tok | out tok | total tok | £/turn |
|------|--------|-------|------------|-------------|-------|--------|---------|-----------|--------|
${results
  .map(
    (r) =>
      `| ${r.name} | ${r.pass ? "GREEN" : "RED"} | ${r.build ? "ok" : "FAIL"} | ${r.priorKept}/${r.priorTotal} | ${r.newPresent}/${r.newTotal} | ${r.telemetry.turns} | ${r.telemetry.input} | ${r.telemetry.output} | ${r.telemetry.total} | ${fmtGBP(r.telemetry.gbpPerTurn)} |`
  )
  .join("\n")}

## Caveats

- **Single-pass.** gpt-5.5 is nondeterministic; this reliability score is one run. A reliability *band* (repeat runs) is a future session.
- **Coarse assertions.** Build-passes + named-marker presence — the proven Phase 1 bar. Catches feature deletion and new-feature presence, not deep semantics.
- **Cost is hypothetical.** £ figures use clearly-labelled ASSUMED gpt-5.5 input/output rates in \`src/cost.mjs\`. Swap when a real metered rate is locked.
`;
  await writeFile(path.join(BASELINE_DIR, "BASELINE.md"), md, "utf8");
  console.log(`\nWrote baseline -> baseline/BASELINE.md + baseline.json`);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
