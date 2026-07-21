// THE tool-use loop — the single, deduplicated heart of the engine, extracted from
// the two near-identical copies in the spike (generate.mjs + iterate.mjs).
//
// Archetype- and provider-agnostic: it speaks only the neutral seam
//   provider.runTurn({ systemPrompt, messages, tools }) -> { text, toolCalls, usage }
// and a generic toolImpls map. Codex specifics live entirely behind the provider.
//
//   runAgent({ provider, systemPrompt, tools, toolImpls, tree, prompt, maxTurns, log })
//     -> { tree, telemetry, finalText }
//
// `tree` is mutated in place by the toolImpls (bind them with makeFileTools(tree)).
// `telemetry` is the summary() of per-turn usage; per-turn lines are logged live.

import { createTelemetry } from "./telemetry.mjs";
import { fmtGBP, TOKENS_PER_CREDIT } from "../cost.mjs";
import { directDeps, renderContextBlock, pruneHistory } from "./context.mjs";

const DEFAULT_MAX_TURNS = 25;
const MAX_EMPTY_RETRY = 1; // a transient 0-token/no-tool turn retries this many times, then fails

export async function runAgent({
  provider,
  systemPrompt,
  tools,
  toolImpls,
  tree,
  prompt,
  maxTurns = DEFAULT_MAX_TURNS,
  log = console.log,
  // Optional caller-side metering guard. Called after every provider response and before any
  // returned tool calls are applied, so a product shell can enforce a prepaid usage ceiling
  // without coupling the provider seam or this engine to a billing implementation.
  onUsage = null,
  // Phase 2.2 context selection. When on, send a paths-only manifest + the CURRENT contents
  // of just the relevant files (seeded from `entryFile` + grown as the model touches files),
  // and prune the accumulating read/patch payloads out of the re-sent history.
  contextSelection = false,
  // Phase 2.3 cache-friendly mode. Opposite trade-off to 2.2: keep the prompt prefix
  // byte-STABLE and the history APPEND-ONLY so the Codex backend serves most input from its
  // prompt cache (~10% rate). The up-front context block (manifest + relevant-file contents)
  // is computed ONCE from the initial tree and frozen — never regenerated — so `instructions`
  // is identical every turn; history is NOT pruned. (Verified live on this transport; no
  // prompt_cache_key — it suppressed hits here.) 2.2-style live context + pruning would bust
  // the cache, so --cache and --ctx are alternatives, not stacked.
  cacheFriendly = false,
  entryFile = "src/App.jsx",
}) {
  const messages = [{ role: "user", content: prompt }];
  const telemetry = createTelemetry();
  const turnLog = []; // per-turn output attribution, for the cliff re-measurement
  let finalText = "";

  // --ctx wins if both are set (they're alternative input strategies).
  const useCache = cacheFriendly && !contextSelection;

  // Conservative inclusion: seed with the likely edit target + its direct local deps, so the
  // model never edits blind. Grows (never shrinks) as the model reads/mutates more files.
  const relevant = new Set();
  if (contextSelection || useCache) {
    if (entryFile in tree) relevant.add(entryFile);
    for (const d of directDeps(tree, entryFile)) relevant.add(d);
  }

  // Cache-friendly: freeze the context block at the INITIAL tree state, ONCE. Reused verbatim
  // every turn so the prefix stays byte-identical (cacheable). The model's own append-only
  // patch history carries any deltas — the standard initial-state-plus-diffs agent pattern.
  const frozenBlock = useCache ? renderContextBlock(tree, [...relevant]) : "";

  let emptyStreak = 0;
  for (let turn = 1; turn <= maxTurns; turn++) {
    // 2.2: regenerate the system prompt from live state + prune history (input-minimal, cache-hostile).
    // 2.3: stable frozen block + append-only history (cache-friendly, input grows but bills cheap).
    const turnSystem = contextSelection
      ? `${systemPrompt}\n\n${renderContextBlock(tree, [...relevant])}`
      : useCache
        ? `${systemPrompt}\n\n${frozenBlock}`
        : systemPrompt;
    const turnMessages = contextSelection ? pruneHistory(messages, { keepLastTurn: true }) : messages;

    const { text, toolCalls, usage } = await provider.runTurn({ systemPrompt: turnSystem, messages: turnMessages, tools });

    const c = telemetry.record(usage);
    const s = telemetry.summary();
    log(
      `   turn ${turn}: in/out/reason/cached ${usage.input}/${usage.output}/${usage.reasoning}/${usage.cached}` +
        ` (total ${usage.total}) · cost-if-metered ${fmtGBP(c.gbp)}` +
        ` · running ${s.total} tok = ${(s.total / TOKENS_PER_CREDIT).toFixed(2)} credits`
    );
    if (onUsage) await onUsage(usage);

    if (toolCalls.length === 0) {
      if (text.trim() !== "") {
        finalText = text; // normal completion: a summary with no further tool calls
        break;
      }
      // Empty turn: no text AND no tool call — the transient the edit-fallback can't catch.
      // Retry once (same request) before giving up, so it isn't a silent premature finish.
      if (++emptyStreak <= MAX_EMPTY_RETRY) {
        log(`   turn ${turn}: empty response (no text, no tool call) — retrying (${emptyStreak}/${MAX_EMPTY_RETRY})`);
        continue;
      }
      log(`   turn ${turn}: empty response again — giving up.`);
      break;
    }
    emptyStreak = 0;

    // Attribute this turn's output to its mutating tool calls (by argument bytes), so the
    // cliff re-measurement can compare patch output vs full-file output.
    const mutBytes = toolCalls.reduce((a, tc) => a + mutationBytes(tc.arguments), 0);
    if (mutBytes > 0) {
      turnLog.push({ turn, output: usage.output, tools: toolCalls.map((t) => t.name), mutBytes });
    }

    // Record the assistant's tool calls, then execute each and feed results back.
    messages.push({
      role: "assistant",
      toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.rawArguments })),
    });

    for (const tc of toolCalls) {
      const impl = toolImpls[tc.name];
      // await supports async impls (e.g. the shell's search_images); no-op for the sync file tools.
      const result = impl ? await impl(tc.arguments) : { error: `unknown tool: ${tc.name}` };
      log(`     ↳ ${summarizeCall(tc, result)}`);
      if (contextSelection) for (const p of touchedPaths(tc, result)) relevant.add(p);
      messages.push({
        role: "tool",
        toolCallId: tc.id,
        name: tc.name,
        output: JSON.stringify(result),
      });
    }
  }

  return { tree, telemetry: telemetry.summary(), turnLog, finalText };
}

// Paths a tool call brought into play, so context selection keeps their current contents in
// the block: a read/write/edit targets `arguments.path`; apply_patch reports `result.changed`.
function touchedPaths(tc, result) {
  const out = [];
  const p = tc.arguments?.path;
  if (typeof p === "string") out.push(p);
  if (Array.isArray(result?.changed)) out.push(...result.changed);
  return out;
}

// Bytes of file-mutating payload in a tool call's arguments (write_file contents,
// apply_patch input, or edit_file edits). 0 for read-only calls.
function mutationBytes(args) {
  if (!args) return 0;
  if (typeof args.contents === "string") return Buffer.byteLength(args.contents);
  if (typeof args.input === "string") return Buffer.byteLength(args.input);
  if (Array.isArray(args.edits)) return Buffer.byteLength(JSON.stringify(args.edits));
  return 0;
}

// Generic one-line summary of a tool call for the live log.
function summarizeCall(tc, result) {
  const p = tc.arguments?.path;
  if (tc.name === "write_file") {
    return `write_file ${p} (${result.bytes ?? "?"}b${result.created === false ? ", rewrote" : ", new"})`;
  }
  if (tc.name === "apply_patch") {
    return result.ok ? `apply_patch -> ${(result.changed || []).join(", ")}` : `apply_patch FAILED: ${result.error}`;
  }
  if (tc.name === "edit_file") {
    return result.ok ? `edit_file ${p} (${result.bytes ?? "?"}b)` : `edit_file ${p} FAILED: ${result.error}`;
  }
  if (tc.name === "read_file") return `read_file ${p}`;
  if (tc.name === "list_files") return "list_files";
  return tc.name + (p ? ` ${p}` : "");
}
