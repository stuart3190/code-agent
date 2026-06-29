// Phase 2.3 — empirical cache probe (SPENDS A LITTLE QUOTA: 2 tiny model calls).
//
// Verifies whether the reverse-engineered Codex-OAuth transport
// (chatgpt.com/backend-api/codex/responses) actually serves OpenAI-style implicit
// prompt caching. The research says the Codex backend caches automatically for any
// request >=1024 tokens and reports hits in usage.input_tokens_details.cached_tokens
// (which codexProvider already normalizes to usage.cached). This confirms it on OUR path.
//
// Method: send the SAME large (>1024-token) stable prefix twice, back-to-back, with a
// trivial output. Call 1 writes the cache; call 2 should read it -> usage.cached > 0.
//
// Run: node harness/_cache-probe.mjs
//
// GATE:
//   call 2 cached > 0  -> caching is LIVE on the Codex-OAuth path -> proceed to Step 4.
//   call 2 cached == 0 -> NOT effective here -> caching is a BYOK-only benefit; do NOT
//                         hack it; record the asymmetry (Step 6).

import { createCodexProvider } from "../src/providers/codexProvider.mjs";
import { BUILD_SYSTEM_PROMPT } from "../src/prompts/builder.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";

// Build a deterministic, byte-identical prefix comfortably over the 1024-token threshold
// (~3.7KB at the Phase-1-measured 3.6 bytes/token; we target >6KB for margin).
function buildStablePrefix() {
  const scaffoldDump = Object.entries(REACT_VITE)
    .map(([p, c]) => `## ${p}\n\`\`\`\n${c}\n\`\`\``)
    .join("\n\n");

  // A long, fixed guideline block — stable content, just here to push the prefix size up
  // so caching can engage. Identical on both calls (no dates/random/counters).
  const guideline =
    "When implementing, prefer small pure components, keep state local, name handlers " +
    "clearly, and never introduce dependencies that are not already declared. Validate " +
    "inputs at the edges, keep the render path free of side effects, and write code that " +
    "reads like the surrounding scaffold. ";
  const padding = Array.from({ length: 24 }, (_, i) => `Guideline ${i + 1}: ${guideline}`).join("\n");

  const prefix = `${BUILD_SYSTEM_PROMPT}\n\n# Scaffold (fixed)\n${scaffoldDump}\n\n# Coding guidelines (fixed)\n${padding}`;
  return prefix;
}

async function probe() {
  const provider = createCodexProvider();
  const systemPrompt = buildStablePrefix();
  const bytes = Buffer.byteLength(systemPrompt);
  console.log(`Stable prefix: ${bytes} bytes (~${Math.round(bytes / 3.6)} tokens est.) — threshold is 1024 tokens.`);
  if (bytes < 3700) console.warn("  WARNING: prefix may be under the 1024-token threshold; caching may not engage.");

  // Trivial, identical request body each time. No tools — keep output tiny.
  const messages = [{ role: "user", content: "Reply with exactly the two characters: OK" }];

  // Two regimes: (A) no key, back-to-back; (B) WITH a stable prompt_cache_key (the mechanism
  // Codex CLI uses for routing stickiness) + a 3rd warm-up call + small delays for propagation.
  // If implicit caching only failed in (A) due to routing, (B) is the fair test.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const KEY = "appbuilder-cacheprobe-v1"; // stable across calls

  async function call(label, opts) {
    const { usage, text } = await provider.runTurn({ systemPrompt, messages, tools: [], ...opts });
    console.log(
      `${label}: input=${usage.input} cached=${usage.cached} (= input_tokens_details.cached_tokens)` +
        ` output=${usage.output} total=${usage.total} · text="${(text || "").slice(0, 20).replace(/\n/g, " ")}"`
    );
    return usage;
  }

  console.log("\n── Regime A: no prompt_cache_key, back-to-back ──");
  const a1 = await call("A.call1", {});
  const a2 = await call("A.call2", {});

  console.log("\n── Regime B: WITH stable prompt_cache_key + warm-up + 1.5s delays ──");
  const b1 = await call("B.call1(warm)", { promptCacheKey: KEY });
  await sleep(1500);
  const b2 = await call("B.call2", { promptCacheKey: KEY });
  await sleep(1500);
  const b3 = await call("B.call3", { promptCacheKey: KEY });

  const results = [a1, a2, b1, b2, b3];
  const bestCached = Math.max(a2.cached || 0, b2.cached || 0, b3.cached || 0);
  console.log("\n──────── VERDICT ────────");
  if (bestCached > 0) {
    const at = b3.cached ? "B.call3" : b2.cached ? "B.call2" : "A.call2";
    console.log(`✅ CACHING IS LIVE on the Codex-OAuth transport. Best hit (${at}) reused ${bestCached} cached input tokens`);
    console.log(`   (${((bestCached / (b3.input || 1)) * 100).toFixed(0)}% of input). Proceed to Step 4 (cache-friendly shaping).`);
  } else {
    console.log("❌ NO cache hit on ANY measured call (cached=0), with AND without prompt_cache_key,");
    console.log("   across 5 calls sharing an identical >1024-token prefix. This transport does not");
    console.log("   appear to serve prompt caching. Treat caching as a BYOK-only benefit on this path.");
    console.log("   Do NOT hack it; record the asymmetry for the Phase 4 credit model (Step 6).");
  }
  return bestCached > 0;
}

probe()
  .then((live) => process.exit(live ? 0 : 3))
  .catch((err) => {
    console.error("PROBE ERROR:", err.message);
    process.exit(1);
  });
