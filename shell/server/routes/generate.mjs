// POST /api/generate  — the ONE endpoint that spends Codex quota. Fires only on an explicit
// user click (the UI never calls it during typing/plan work). Streams the engine's per-turn log
// over SSE, then debits the LIVE ledger for the tokens actually served.
//
// Wraps proven code, reimplements none of it:
//   runAgent (src/engine)  ·  routing provider -> Codex (src/providers)  ·  BUILD/EDIT prompts
//   (src/prompts/builder)  ·  the reactVite scaffold  ·  buildTree (harness/workspace)  ·  the
//   live ledger.debit (src/billing) which itself enforces the balance + per-tier-ceiling guards.

import crypto from "node:crypto";
import { runAgent } from "../../../src/engine/runAgent.mjs";
import { fromScaffold, clone } from "../../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../../src/scaffolds/reactVite.mjs";
import { makeFileTools } from "../../../src/tools/fileTools.mjs";
import { BUILD_SYSTEM_PROMPT, PLAN_SYSTEM_PROMPT, systemPromptForEdit } from "../../../src/prompts/builder.mjs";
import { createRoutingProvider } from "../../../src/providers/routingProvider.mjs";
import { creditsForTurn } from "../../../src/billing/costModel.mjs";
import { buildTree } from "../../../harness/workspace.mjs";
import { ledger } from "../lib/services.mjs";
import { getDecryptedKey } from "../lib/byokStore.mjs";
import { previewProvider } from "../preview/index.mjs";

const BYOK_MODEL = "claude-sonnet-4-6"; // adapter default for the BYOK (Anthropic) lane; a picker is deferred

// SSE helper — one JSON event.
function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function handleGenerate(req, res, body, owner) {
  const prompt = (body?.prompt || "").trim();
  const mode = body?.mode === "iterate" ? "iterate" : body?.mode === "plan" ? "plan" : "build";
  // "Plan mode": an approved plan from a prior plan pass, fed into the build's user prompt so the
  // build is actually steered by it (not just displayed).
  const plan = typeof body?.plan === "string" ? body.plan.trim() : "";
  const projectId = body?.projectId || `new-${Date.now()}`;
  if (!prompt) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "prompt is required" }));
  }
  if (mode === "iterate" && (!body?.tree || typeof body.tree !== "object")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "iterate mode requires the current project `tree`" }));
  }

  const led = ledger();

  // BYOK: if the user has saved a provider key, generation runs on THEIR account and debits NO
  // platform credits. Absent -> the managed Codex/ChatGPT-sub lane, unchanged. The decrypted key
  // stays server-side (never sent to the client, never logged).
  let byokKey = null;
  try { byokKey = await getDecryptedKey(owner.id); } catch { byokKey = null; }
  const byok = !!byokKey;
  const providerConfig = byok
    ? { provider: "anthropic", strong: BYOK_MODEL, apiKey: byokKey }
    : { provider: "codex", strong: "gpt-5.5" }; // free ChatGPT-sub lane; single-model pass-through
  const buildProvider = (intent) => createRoutingProvider({ config: providerConfig, turnMeta: { intent } });

  // Coarse pre-spend gate — MANAGED lane only. BYOK users pay their own inference, so a zero
  // platform balance must not block them.
  const preBal = await led.getBalance(owner.id);
  if (!byok && preBal.total <= 0) {
    res.writeHead(402, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "insufficient_balance", balance: preBal,
      hint: "Buy a tier or top-up (Stripe test mode) to get credits." }));
  }

  // Settle a turn's cost: debit the ledger (managed) OR no-op (BYOK). Returns the fields the `done`
  // payload reports. This branches AROUND the ledger — it does not change ledger/billing logic.
  async function settle(telemetry, model, kind) {
    if (byok) {
      sse(res, "log", { line: `billing: BYOK — ${telemetry.total} tok billed to your ${providerConfig.provider} key (no platform credits used)` });
      return { debit: null, need: 0, balance: preBal };
    }
    const ref = `${kind}:${projectId}:${crypto.randomUUID()}`;
    const debit = await led.debit({ owner: owner.id, tokens: telemetry.total, model, ref });
    const need = creditsForTurn({ tokens: telemetry.total, model });
    const balance = await led.getBalance(owner.id);
    sse(res, "log", { line: `billing: debited ${need.toFixed(4)} cr (model ${model}, ${telemetry.total} tok) -> balance ${balance.total.toFixed(4)} cr` });
    return { debit, need, balance };
  }

  // Begin the SSE stream.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "start", { projectId, mode, balance: preBal, byok });

  try {
    // ── PLAN-ONLY pass ────────────────────────────────────────────────────────────────────────
    // No tools → the model's first text reply ends the runAgent loop (turn 1) and IS the plan.
    // Skips buildTree and the preview entirely: nothing is built, nothing is served. The client
    // holds finalText and sends it back as `plan` with the subsequent build press.
    if (mode === "plan") {
      const provider = buildProvider("generate");
      sse(res, "log", { line: `engine: plan on model ${provider.model} — plan-only pass, no build${byok ? " · BYOK" : ""}` });

      const { telemetry, finalText } = await runAgent({
        provider,
        systemPrompt: PLAN_SYSTEM_PROMPT,
        tools: [],
        toolImpls: {},
        tree: {},
        prompt,
        log: (line) => sse(res, "log", { line: String(line) }),
      });

      // Metered like any engine tokens on the managed lane (a plan is naturally cheap — one no-tool
      // turn); FREE under BYOK. KNOB: to make managed plan passes free too, skip settle for "plan".
      const { debit, need, balance } = await settle(telemetry, provider.model, "plan");

      sse(res, "done", {
        projectId, mode, finalText, telemetry, byok,
        decision: { model: provider.model, reason: provider.decision?.reason || null },
        debit, need, balance,
      });
      return; // no tree/build/preview in the plan payload — the client must not treat it as a built app
    }

    const intent = mode === "iterate" ? "edit" : "generate";
    const provider = buildProvider(intent);

    const tree = mode === "iterate" ? { ...body.tree } : clone(fromScaffold(REACT_VITE));
    const editFormat = mode === "iterate" ? "apply_patch" : undefined;
    const { schemas, impls } = makeFileTools(tree, { editFormat });
    const systemPrompt = mode === "iterate" ? systemPromptForEdit(editFormat) : BUILD_SYSTEM_PROMPT;

    sse(res, "log", { line: `engine: ${mode} on model ${provider.model} — ${provider.decision?.reason || ""}${plan ? " · steering by approved plan" : ""}` });

    // A held plan steers the build by riding in the user turn (the engine prompt is free-form).
    const enginePrompt = plan
      ? `${prompt}\n\nAn approved implementation plan for this app follows. Build according to it:\n\n${plan}`
      : prompt;

    const { telemetry, finalText } = await runAgent({
      provider,
      systemPrompt,
      tools: schemas,
      toolImpls: impls,
      tree,
      prompt: enginePrompt,
      log: (line) => sse(res, "log", { line: String(line) }),
    });

    // Prove it builds (same bar as the 3/3 harness) before we serve/save it.
    sse(res, "log", { line: "build: npm run build ..." });
    const build = await buildTree(tree, `shell-${projectId}`.replace(/[^a-zA-Z0-9_-]/g, "_"), () => {});
    sse(res, "log", { line: `build: ${build.ok ? "PASS" : "FAIL"}` });

    // Settle: debit the live ledger for the tokens served (managed), or no-op under BYOK.
    const { debit, need, balance } = await settle(telemetry, provider.model, "gen");

    // Preview (real local Vite, or the VPS stub).
    let preview = null;
    try {
      preview = mode === "iterate"
        ? await previewProvider().update(projectId, tree)
        : await previewProvider().start(projectId, tree);
      sse(res, "log", { line: `preview: ${preview.url ? preview.url : "(vps stub — no url)"}` });
    } catch (e) {
      sse(res, "log", { line: `preview: unavailable (${e.message})` });
      preview = { url: null, error: e.message };
    }

    sse(res, "done", {
      projectId, mode, finalText, tree, telemetry, byok,
      decision: { model: provider.model, reason: provider.decision?.reason || null },
      debit, need, balance, build: { ok: build.ok }, preview,
    });
  } catch (e) {
    sse(res, "error", { message: e.message });
  } finally {
    res.end();
  }
}
