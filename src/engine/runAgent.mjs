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
  // Stale-read compaction. In the 24.26-credit booking build every full-file read stayed verbatim
  // in history for the rest of its stage — the supporting stage's turn-1 reads of four files rode
  // along in seven later turns, AFTER the model had patched those same files, so the history was
  // both large and WRONG. When on: once a file is successfully mutated, earlier read results for
  // it are replaced with a deterministic summary (path, hashes, exports, what changed). The
  // current contents stay one read_file away and the model is told exactly that.
  compactStaleReads = false,
}) {
  const messages = [{ role: "user", content: prompt }];
  const telemetry = createTelemetry();
  const turnLog = []; // per-turn output attribution, for the cliff re-measurement
  let finalText = "";
  // message index -> { path, bytes } for full read results still in history verbatim.
  const liveReads = new Map();
  let prunedTokens = 0;

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
    // A budget guard that throws here stops the loop BEFORE the next provider request — but this
    // turn's response is already paid for, so its tool calls are applied first and the abort
    // happens after. Discarding paid work made every budget stop cost one wasted turn.
    let budgetStop = null;
    if (onUsage) {
      try {
        await onUsage(usage);
      } catch (error) {
        budgetStop = error;
      }
    }

    if (toolCalls.length === 0) {
      if (budgetStop && !text.trim()) throw budgetStop;
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

      if (compactStaleReads) {
        // Remember where this full read landed so a later mutation can supersede it.
        if (tc.name === "read_file" && typeof result?.contents === "string") {
          liveReads.set(messages.length - 1, { path: tc.arguments?.path, contents: result.contents });
        }
        // A successful mutation makes every EARLIER read of that file stale — compact them now,
        // before the next turn resends history.
        for (const changed of mutatedPaths(tc, result)) {
          for (const [index, read] of liveReads) {
            if (read.path !== changed || index === messages.length - 1) continue;
            prunedTokens += Math.ceil(read.contents.length / 4);
            messages[index] = {
              ...messages[index],
              output: JSON.stringify(staleReadStub(read, tree[changed])),
            };
            liveReads.delete(index);
          }
        }
      }
    }

    // The paid work is applied; now the budget stop may fire — before any further provider call.
    if (budgetStop) throw budgetStop;
  }

  return { tree, telemetry: { ...telemetry.summary(), prunedTokens }, turnLog, finalText };
}

// Paths a tool call SUCCESSFULLY changed. write_file/edit_file report per-path; apply_patch
// reports the list. A failed call changed nothing and supersedes nothing.
function mutatedPaths(tc, result) {
  if (result?.error) return [];
  if (tc.name === "write_file" || tc.name === "edit_file") {
    return tc.arguments?.path && result?.ok !== false ? [tc.arguments.path] : [];
  }
  if (tc.name === "apply_patch" && result?.ok) return result.changed || [];
  return [];
}

// The deterministic summary that replaces a superseded read: enough to know what the file was,
// what it became, and that the history copy must not be trusted. The full old body stays in
// diagnostics and checkpoints — it is removed from the ACTIVE context only.
function staleReadStub(read, currentSource) {
  const exports = typeof currentSource === "string"
    ? [...currentSource.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+([\w$]+)/g)].map((m) => m[1]).slice(0, 20)
    : [];
  return {
    _superseded: "this read is stale — the file was patched after it",
    path: read.path,
    readHash: fnv(read.contents),
    currentHash: typeof currentSource === "string" ? fnv(currentSource) : null,
    currentExports: exports,
    note: "Your later patch to this file was applied successfully. The context block / read_file has the current contents; do not rely on this old copy.",
  };
}

// Tiny stable content hash for the stubs — identity, not cryptography.
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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
