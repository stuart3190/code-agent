// Phase 2.4 — the routing PROVIDER. It satisfies the SAME seam every provider does:
//
//   runTurn({ systemPrompt, messages, tools }) -> { text, toolCalls, usage }
//
// so runAgent never learns the router exists. Internally it asks the pure policy
// (src/router/router.mjs `chooseModel`) which provider+model to use for this task's turns,
// lazily builds the chosen underlying single-model provider, and delegates runTurn straight
// through. No engine edit, no seam change — the router is a clean layer ABOVE the seam.
//
//   createRoutingProvider({ config, turnMeta, makeProvider? }) -> { runTurn, model, rates, decision }
//
// In this harness every case is a SINGLE-INTENT task (an edit), so the decision is stable for the
// whole run: the routing provider resolves to ONE model and `model`/`rates` are exact, letting the
// harness setActiveRates correctly. (A future mixed-intent task that switched models mid-run would
// need per-turn rate plumbing in telemetry — a seam extension, out of scope here.)

import { createAnthropicProvider } from "./anthropicProvider.mjs";
import { createCodexProvider } from "./codexProvider.mjs";
import { chooseModel } from "../router/router.mjs";

// Default factory: turn a router decision into a concrete single-model provider behind the seam.
// Overridable (`makeProvider`) so offline tests can inject a fake without network calls.
function defaultMakeProvider(decision, config = {}) {
  if (decision.provider === "anthropic") {
    // config.apiKey (optional) carries a per-user BYOK key straight to the provider config —
    // the platform-key path (env fallback) is unchanged when it's absent.
    return createAnthropicProvider({ model: decision.model, cache: !!config.cache, apiKey: config.apiKey ?? null });
  }
  if (decision.provider === "codex") {
    return createCodexProvider();
  }
  throw new Error(`routingProvider: unknown provider "${decision.provider}"`);
}

export function createRoutingProvider({ config, turnMeta, makeProvider = defaultMakeProvider } = {}) {
  // Resolve the route once for this (single-intent) task. The decision carries the chosen model +
  // its rates so the harness can price the run correctly.
  const decision = chooseModel(turnMeta, config);
  let underlying = null; // built lazily on first turn, then reused

  async function runTurn(args) {
    if (!underlying) underlying = makeProvider(decision, config);
    return underlying.runTurn(args);
  }

  return { runTurn, model: decision.model, rates: decision.rates, decision };
}
