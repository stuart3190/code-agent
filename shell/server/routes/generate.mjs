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
import { BUILD_SYSTEM_PROMPT, systemPromptForEdit } from "../../../src/prompts/builder.mjs";
import { createRoutingProvider } from "../../../src/providers/routingProvider.mjs";
import { creditsForTurn } from "../../../src/billing/costModel.mjs";
import { buildTree } from "../../../harness/workspace.mjs";
import { ledger } from "../lib/services.mjs";
import { previewProvider } from "../preview/index.mjs";

// SSE helper — one JSON event.
function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function handleGenerate(req, res, body, owner) {
  const prompt = (body?.prompt || "").trim();
  const mode = body?.mode === "iterate" ? "iterate" : "build";
  const projectId = body?.projectId || `new-${Date.now()}`;
  if (!prompt) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "prompt is required" }));
  }
  if (mode === "iterate" && (!body?.tree || typeof body.tree !== "object")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "iterate mode requires the current project `tree`" }));
  }

  // Coarse pre-spend gate: never burn Codex quota for a user with no credit balance.
  const led = ledger();
  const preBal = await led.getBalance(owner.id);
  if (preBal.total <= 0) {
    res.writeHead(402, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "insufficient_balance", balance: preBal,
      hint: "Buy a tier or top-up (Stripe test mode) to get credits." }));
  }

  // Begin the SSE stream.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  sse(res, "start", { projectId, mode, balance: preBal });

  try {
    const intent = mode === "iterate" ? "edit" : "generate";
    const provider = createRoutingProvider({
      config: { provider: "codex", strong: "gpt-5.5" }, // free ChatGPT-sub lane; single-model pass-through
      turnMeta: { intent },
    });

    const tree = mode === "iterate" ? { ...body.tree } : clone(fromScaffold(REACT_VITE));
    const editFormat = mode === "iterate" ? "apply_patch" : undefined;
    const { schemas, impls } = makeFileTools(tree, { editFormat });
    const systemPrompt = mode === "iterate" ? systemPromptForEdit(editFormat) : BUILD_SYSTEM_PROMPT;

    sse(res, "log", { line: `engine: ${mode} on model ${provider.model} — ${provider.decision?.reason || ""}` });

    const { telemetry, finalText } = await runAgent({
      provider,
      systemPrompt,
      tools: schemas,
      toolImpls: impls,
      tree,
      prompt,
      log: (line) => sse(res, "log", { line: String(line) }),
    });

    // Prove it builds (same bar as the 3/3 harness) before we serve/save it.
    sse(res, "log", { line: "build: npm run build ..." });
    const build = await buildTree(tree, `shell-${projectId}`.replace(/[^a-zA-Z0-9_-]/g, "_"), () => {});
    sse(res, "log", { line: `build: ${build.ok ? "PASS" : "FAIL"}` });

    // Debit the live ledger for the tokens actually served (idempotent on this turn's ref).
    const ref = `gen:${projectId}:${crypto.randomUUID()}`;
    const debit = await led.debit({ owner: owner.id, tokens: telemetry.total, model: provider.model, ref });
    const need = creditsForTurn({ tokens: telemetry.total, model: provider.model });
    const balance = await led.getBalance(owner.id);
    sse(res, "log", { line: `billing: debited ${need.toFixed(4)} cr (model ${provider.model}, ${telemetry.total} tok) -> balance ${balance.total.toFixed(4)} cr` });

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
      projectId, mode, finalText, tree, telemetry,
      decision: { model: provider.model, reason: provider.decision?.reason || null },
      debit, need, balance, build: { ok: build.ok }, preview,
    });
  } catch (e) {
    sse(res, "error", { message: e.message });
  } finally {
    res.end();
  }
}
