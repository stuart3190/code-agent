// A/B trial: which edit format does gpt-5.5 apply cleanly most often?
// Runs both formats across all cases (REPEATS each, for noise) and prints a comparison.
// This is the data shown before committing to one format.
//
//   node harness/trial-edit-format.mjs [repeats]

import { createCodexProvider } from "../src/providers/codexProvider.mjs";
import { fmtGBP } from "../src/cost.mjs";
import { ensureDeps } from "./workspace.mjs";
import { runEngineCase } from "./runEngineCase.mjs";
import { CASES } from "./cases/index.mjs";

const FORMATS = ["apply_patch", "search_replace"];
const REPEATS = Number(process.argv[2]) || 2;

async function main() {
  console.log(`A/B edit-format trial — ${FORMATS.join(" vs ")} · ${CASES.length} cases × ${REPEATS} repeats\n`);
  await ensureDeps();
  const provider = createCodexProvider();

  const agg = {};
  for (const format of FORMATS) agg[format] = { green: 0, runs: 0, attempts: 0, applies: 0, failures: 0, fallbacks: 0, writes: 0, gbp: 0, turns: 0, output: 0 };

  for (const format of FORMATS) {
    for (let rep = 1; rep <= REPEATS; rep++) {
      for (const c of CASES) {
        const tag = `${format}/${c.name}#${rep}`;
        process.stdout.write(`  ${tag} ... `);
        const r = await runEngineCase(provider, c, { editFormat: format, workName: `trial-${format}-${c.name}` });
        const a = agg[format];
        a.runs += 1;
        a.green += r.pass ? 1 : 0;
        a.attempts += r.editStats.attempts;
        a.applies += r.editStats.applies;
        a.failures += r.editStats.failures;
        a.fallbacks += r.editStats.fallbacks;
        a.writes += r.editStats.writes;
        a.gbp += r.telemetry.gbp;
        a.turns += r.telemetry.turns;
        a.output += r.telemetry.output;
        console.log(
          `${r.pass ? "GREEN" : "RED"} · edits ${r.editStats.applies}/${r.editStats.attempts} clean` +
            `${r.editStats.fallbacks ? `, ${r.editStats.fallbacks} fallback` : ""}` +
            `${r.editStats.writes ? `, ${r.editStats.writes} write_file` : ""} · ${r.telemetry.output} out-tok`
        );
      }
    }
    console.log("");
  }

  // ---- comparison ----
  console.log("══ Comparison");
  console.log("  format          reliability  clean-apply  fallbacks  writes  £/turn    out-tok/run");
  for (const format of FORMATS) {
    const a = agg[format];
    const cleanPct = a.attempts ? ((a.applies / a.attempts) * 100).toFixed(0) + "%" : "n/a";
    const gbpPerTurn = a.turns ? a.gbp / a.turns : 0;
    console.log(
      `  ${format.padEnd(15)} ${`${a.green}/${a.runs}`.padEnd(11)}  ${cleanPct.padEnd(11)}  ` +
        `${String(a.fallbacks).padEnd(9)}  ${String(a.writes).padEnd(6)}  ${fmtGBP(gbpPerTurn).padEnd(8)}  ${Math.round(a.output / a.runs)}`
    );
  }

  console.log(
    "\nRead: reliability must stay green; clean-apply = how often the model's edits applied " +
      "first try (higher = the model 'speaks' this format); fallbacks/writes = times it had to " +
      "rewrite a whole file. Pick the format that is green AND highest clean-apply."
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
