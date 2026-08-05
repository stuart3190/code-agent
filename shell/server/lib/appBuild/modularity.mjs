// Modular by construction — the gate that keeps generated apps out of the monolith shape.
//
// The 46.10-credit booking build put five journeys in one ~40KB App.jsx. Every stage re-read it,
// rewrote it (one 34KB write_file in the primary stage alone), and dragged it through history;
// context slicing could not safely remove much because the same file owned every journey. These
// checks make that shape a FAILED stage gate rather than a cost the whole pipeline pays for.
//
// Everything here is measured, never guessed: tokens, lines, exports, journeys touched (scored
// on words DISTINCTIVE to each journey — shared vocabulary discriminates nothing), and direct
// persistence calls. The rules are deliberately few and blocking only where the evidence was.

import { tokensOf } from "./projectManifest.mjs";

// The shell may carry routing, layout, providers and an error boundary — not features. The
// scaffold's own shell is ~600 tokens; triple that is generous.
export const APP_SHELL_MAX_TOKENS = 2_000;
// A single module bigger than this owns too much to patch, slice or verify surgically.
export const FILE_MAX_TOKENS = 4_000;
// Touching this many journeys in one big file is the definition of the monolith.
export const MAX_JOURNEYS_PER_FILE = 2;

const APP_SOURCE = (path) => /\.(jsx?|tsx?)$/.test(path) && path.startsWith("src/")
  && !path.startsWith("src/lib/") && !path.startsWith("src/components/ui/");

// A stated, justified exception in the file's opening lines: recorded, not silently blocking.
const EXCEPTION = /(?:\/\/|\/\*)\s*modularity:\s*(.{8,})/;

function journeyVocabulary(contract) {
  const perJourney = (contract?.journeys || []).map((j) => ({
    id: j.id,
    words: new Set(`${j.id} ${j.title} ${(j.steps || []).map((s) => `${s.action} ${s.expect}`).join(" ")}`
      .toLowerCase().match(/[a-z]{4,}/g) || []),
  }));
  // Distinctive words only: a word used by two journeys identifies neither.
  const counts = new Map();
  for (const j of perJourney) for (const w of j.words) counts.set(w, (counts.get(w) || 0) + 1);
  return perJourney.map((j) => ({ id: j.id, words: [...j.words].filter((w) => counts.get(w) === 1) }));
}

/** Measured facts about every app-source file. */
export function fileMetrics(tree, { contract = null } = {}) {
  const vocab = journeyVocabulary(contract);
  const metrics = [];
  for (const [path, raw] of Object.entries(tree || {})) {
    if (!APP_SOURCE(path)) continue;
    const source = String(raw || "");
    const lower = source.toLowerCase();
    metrics.push({
      path,
      tokens: tokensOf(source),
      lines: source.split("\n").length,
      exports: [...source.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([\w$]+)/g)].map((m) => m[1]),
      journeys: vocab.filter((j) => j.words.filter((w) => lower.includes(w)).length >= 2).map((j) => j.id),
      persistsDirectly: /\bdb\s*\.\s*entity\s*\(/.test(source) && /\.(jsx|tsx)$/.test(path),
      exception: (source.split("\n").slice(0, 10).join("\n").match(EXCEPTION) || [])[1] || null,
    });
  }
  return metrics;
}

/**
 * The gate. `previousGreen` enables the anti-collapse rule: a later stage must not merge the
 * modular tree back into a monolith or delete the route/data files an earlier stage built.
 */
export function modularityCheck(tree, { contract = null, previousGreen = null } = {}) {
  const metrics = fileMetrics(tree, { contract });
  const problems = [];
  const flags = [];

  for (const file of metrics) {
    if (/^src\/App\.(jsx?|tsx?)$/.test(file.path) && file.tokens > APP_SHELL_MAX_TOKENS) {
      problems.push(`${file.path} is ${file.tokens} tokens — the shell carries routing, layout and providers only `
        + `(max ${APP_SHELL_MAX_TOKENS}); move each page to its own file under src/routes/ and register it in ROUTES`);
      continue;
    }
    if (file.tokens > FILE_MAX_TOKENS) {
      if (file.exception) {
        flags.push(`${file.path} (${file.tokens} tok) over the size threshold with stated exception: ${file.exception.trim()}`);
      } else {
        problems.push(`${file.path} is ${file.tokens} tokens (max ${FILE_MAX_TOKENS}) — split it by route/component, `
          + "or state a justified exception in a leading `// modularity: <reason>` comment");
      }
    }
    if (file.journeys.length > MAX_JOURNEYS_PER_FILE && file.tokens > 3_000) {
      problems.push(`${file.path} implements ${file.journeys.length} journeys (${file.journeys.join(", ")}) — `
        + "a god component; give each journey its own route/component modules");
    }
    if (file.persistsDirectly && !file.path.startsWith("src/data/")) {
      problems.push(`${file.path} calls db.entity() inside a component — persistence belongs in a src/data/ module `
        + "the component imports");
    }
  }

  if (previousGreen) {
    for (const path of Object.keys(previousGreen)) {
      if (!/^src\/(routes|data)\//.test(path)) continue;
      if (!(path in tree)) {
        problems.push(`${path} existed in the last green tree and is gone — later stages must not merge modules `
          + "back into a monolith or drop route/data files");
      }
    }
  }

  return { ok: problems.length === 0, problems, flags, metrics };
}

/** One line for the gate log. */
export function modularitySummary(result) {
  const worst = [...result.metrics].sort((a, b) => b.tokens - a.tokens)[0];
  return `${result.metrics.length} modules, largest ${worst ? `${worst.path} (${worst.tokens} tok)` : "none"}`
    + `${result.flags.length ? ` · ${result.flags.length} stated exception(s)` : ""}`;
}
