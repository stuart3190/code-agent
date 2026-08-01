// The Lead Agent — the durable per-owner entity that owns the user relationship
// (docs/PRINCIPLES.md, Principles 1, 2, 8, 9, 11, 12; Platform Architecture 3, 4, 6).
//
// One debuggable loop: user message → memory-injected context → routed model turn → tool
// calls resolved through the Capability Registry (specialists are ephemeral display
// entities spawned around each invocation) → final plain-language answer. The conversation
// event stream mirrors run events (monotonic sequence, resumable SSE). Crash/deploy
// recovery marks stale "thinking" conversations idle so the Lead Agent never visibly dies.

import { optionalEnv } from "./env.mjs";
import { conversationStore } from "./conversationStore.mjs";
import { codeAgentStore } from "./codeAgentStore.mjs";
import { capabilityToolDefs, invokeCapability, listCapabilities } from "./capabilityRegistry.mjs";
import { registerCoreCapabilities } from "./capabilities/coreCapabilities.mjs";
import { activeAiCredential } from "./aiCredentialStore.mjs";
import { createRoutedCodingModel } from "./modelRouting.mjs";
import { budgetOverview } from "./usageBudgets.mjs";
import { notifyOwnerIfAway } from "./notifications/notificationService.mjs";

const MAX_TURNS = 12;
const HISTORY_TURNS = 30;

let coreRegistered = false;
export function ensureCoreCapabilities() {
  if (coreRegistered) return;
  registerCoreCapabilities();
  coreRegistered = true;
}

export function resetLeadAgentForTests() {
  coreRegistered = false;
}

const LEAD_INSTRUCTIONS = `You are Thrallo's Lead Agent — the single AI this user always talks to. You run their software team.
Non-negotiable behaviour (from the Thrallo Product Principles):
- Conversation is the operating system. The user describes outcomes; YOU decide every technical detail: frameworks, databases, authentication, hosting, structure, testing, deployment. NEVER ask technical questions. The ask_business_question tool is only for genuine business decisions, and you must state the business consequence.
- You own the relationship. Specialists (Planner, Designer, Builder, Database, Tester, Reviewer, Publisher) are your disposable workers — the capabilities you invoke carry their identities; you never hand the user off.
- Context is permanent. Use the MEMORY section; use the remember capability proactively whenever the user reveals a durable preference, product, or fact, so they never repeat themselves.
- Anticipate. When the obvious next step is clear (an experienced engineer would just do it), do it or line it up — don't wait to be asked. Surprise the user, within their plan budgets.
- Be plain and brief. Status lines and answers are plain English. No jargon walls. When work is dispatched, say what the team is doing and what happens next.
- Builds outcomes, not projects: infer whether the request needs a web app, an API, a repo change, a review, etc. Never mention templates.
- If a capability fails, say what happened honestly and what you'll do about it.
FAILURE HANDLING — you are autonomous. A failed build, test, preview, deployment or verification check is UNFINISHED WORK, not a reason to hand control back. Diagnose the root cause, apply the smallest safe repair (repair_app for existing apps), and re-run the checks — repeat until it passes or a genuine blocker is reached. Never say "I'll fix that if you say the word", "would you like me to repair it", or "tell me to continue". While repairing, give one brief progress line ("Found an auth configuration issue — repairing and re-running verification."). Ask before continuing ONLY when the fix would materially change the requested product or architecture, requires destructive/irreversible action, needs credentials/payment/external approval, or presents materially different product decisions you cannot infer. Routine failures (bug fixes, CORS, auth config, failed tests, runtime errors, missing migrations, deployment or verification failures) are never permission questions.

FAILURE EVIDENCE — never state a cause for a failed build without evidence. Every build records permanent diagnostics (Build ID in the build_started event); the platform quotes the exact stored compiler/test/lint/runtime output in blocked messages, and the Diagnostics view holds the full logs. When you discuss why something failed, refer to and quote that stored output — never a guess, a memory, or a summary. If diagnostics were not captured, say exactly that and call it a platform bug rather than inventing an explanation.

Respond with tool calls to put the team to work, and finish with a short plain-language message to the user.`;

// ── message intake ────────────────────────────────────────────────────────────────────────

// Workspace context (Phase 24 principle): the desktop shares what the editor already
// knows — bounded, structured, and always visible to the user before it is sent.
export function sanitizeWorkspaceContext(context) {
  if (!context || typeof context !== "object") return null;
  const clean = {};
  if (context.file) clean.file = String(context.file).slice(0, 300);
  if (context.language) clean.language = String(context.language).slice(0, 40);
  if (context.selection) clean.selection = String(context.selection).slice(0, 4_000);
  if (Array.isArray(context.diagnostics)) {
    clean.diagnostics = context.diagnostics.slice(0, 5).map((d) => String(d).slice(0, 300));
  }
  if (context.previewUrl) clean.previewUrl = String(context.previewUrl).slice(0, 300);
  return Object.keys(clean).length ? clean : null;
}

function describeWorkspaceContext(context) {
  const parts = [];
  if (context.file) parts.push(`Active file: ${context.file}${context.language ? ` (${context.language})` : ""}`);
  if (context.selection) parts.push(`Selected code:\n\`\`\`\n${context.selection}\n\`\`\``);
  if (context.diagnostics?.length) parts.push(`Open problems:\n- ${context.diagnostics.join("\n- ")}`);
  if (context.previewUrl) parts.push(`Active preview: ${context.previewUrl}`);
  return parts.join("\n");
}

export async function postUserMessage(owner, { conversationId = null, text, workspaceContext = null, modelPref = null }, {
  store = conversationStore(),
  processOptions = {},
} = {}) {
  ensureCoreCapabilities();
  const trimmed = String(text || "").trim();
  if (!trimmed) throw inputError("Message text is required");
  if (trimmed.length > 20_000) throw inputError("Message is too long");
  const context = sanitizeWorkspaceContext(workspaceContext);

  let conversation = conversationId ? await store.getConversation(owner, conversationId) : null;
  if (conversationId && !conversation) throw inputError("Conversation not found", 404, "conversation_not_found");
  if (!conversation) {
    conversation = await store.createConversation(owner, { title: trimmed.slice(0, 80) });
    // The Begin-screen model selector rides with the first message; validated against the
    // owner's actual catalog so an unconfigured provider can never be stored.
    if (modelPref && modelPref !== "auto") {
      try {
        const { selectableModelsForOwner, validateModelChoice } = await import("./modelSelector.mjs");
        const value = validateModelChoice(await selectableModelsForOwner(owner), modelPref);
        conversation = await store.updateConversation(conversation, { model_pref: value });
      } catch { /* invalid preference — the conversation starts on Auto */ }
    }
  }
  if (conversation.state === "thinking") {
    throw inputError("The team is still working on the previous message.", 409, "conversation_busy");
  }

  await store.appendTurn(conversation, {
    role: "user", content: trimmed,
    ...(context ? { payload: { workspace_context: context } } : {}),
  });
  await store.appendEvent(conversation, "message", {
    role: "user", text: trimmed,
    ...(context ? { workspaceContext: { file: context.file || null, hasSelection: !!context.selection, diagnostics: context.diagnostics?.length || 0 } } : {}),
  });
  const claimed = await store.claimConversationThinking(conversation);
  if (!claimed) throw inputError("The team is still working on the previous message.", 409, "conversation_busy");

  const processing = processConversation(claimed, { store, ...processOptions })
    .catch((error) => console.error("[lead-agent] processing:", error));
  return { conversation: claimed, processing };
}

// ── the Lead Agent loop ───────────────────────────────────────────────────────────────────

export async function processConversation(conversation, {
  store = conversationStore(),
  runStore = codeAgentStore(),
  credentialResolver = activeAiCredential,
  modelFactory = null,
  overviewResolver = budgetOverview,
} = {}) {
  ensureCoreCapabilities();
  const emit = (type, payload) => store.appendEvent(conversation, type, payload);
  try {
    let credential = await credentialResolver(conversation.owner)
      .catch(() => ({ provider: "managed", secret: null, routing: {} }));
    if (credential.provider === "codex") credential = { provider: "managed", secret: null, routing: {} };
    const billingSource = credential.provider === "managed" ? "managed" : "byok";
    if (billingSource === "managed") {
      const overview = await overviewResolver(conversation.owner, { store: runStore });
      if (overview.budgets.managedTokens.remaining <= 0) {
        await finishWithMessage(store, conversation,
          "Your monthly managed-model allowance is used up, so I can't think right now. Connect your own provider key in Settings, or wait for the reset.");
        return;
      }
    }

    const ctx = {
      owner: conversation.owner,
      conversation,
      conversations: store,
      emit,
      relayRun: (runId) => relayRunEvents({ store, runStore, conversation, runId }),
    };

    // Per-conversation model preference: honored when available; unavailable selections
    // NEVER silently switch — they fall back only when the user enabled automatic
    // fallback (with a visible notice), and otherwise stop with a clear warning.
    const { selectableModelsForOwner, resolveConversationModel } = await import("./modelSelector.mjs");
    const catalog = await selectableModelsForOwner(conversation.owner).catch(() => ({ options: [{ value: "auto", available: true }], allowFallback: true }));
    const resolution = resolveConversationModel(conversation, catalog);
    if (resolution.warning) {
      await finishWithMessage(store, conversation, resolution.warning);
      return;
    }
    if (resolution.notice) {
      await store.appendTurn(conversation, { role: "lead", content: resolution.notice, payload: { progress: true } });
      await emit("message", { role: "lead", text: resolution.notice });
    }

    const model = modelFactory
      ? await modelFactory(credential, resolution.requested)
      : await createRoutedCodingModel({
        owner: conversation.owner,
        credential,
        requested: resolution.requested,
        policy: { ...(credential.routing || {}), mode: resolution.mode || null },
      });

    const tools = await capabilityToolDefs(ctx);
    const input = await assembleInput(store, conversation);
    await emit("agent_spawned", { agent: "Lead Agent", status: "Understanding request…" });

    for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
      const response = await model.turn({
        instructions: await leadInstructions(store, conversation),
        input,
        tools,
        safetyIdentifier: conversation.owner,
      });
      await meterUsage(runStore, conversation.owner, response.usage, billingSource);
      input.push(...response.output);
      const calls = response.output.filter((item) => item.type === "function_call");

      if (!calls.length) {
        const text = (response.text || "Done.").trim();
        await emit("agent_done", { agent: "Lead Agent" });
        await finishWithMessage(store, conversation, text);
        return;
      }

      for (const call of calls) {
        let args;
        try { args = JSON.parse(call.arguments || "{}"); } catch { args = {}; }
        const capability = listCapabilities().find((entry) => entry.id === call.name);
        const specialist = capability?.specialist || "Lead Agent";
        if (specialist !== "Lead Agent") {
          await emit("agent_spawned", { agent: specialist, status: capability?.statusText || "Working…" });
        } else if (capability?.statusText) {
          await emit("agent_status", { agent: "Lead Agent", status: capability.statusText });
        }
        let output;
        try {
          output = await invokeCapability(call.name, ctx, args);
        } catch (error) {
          output = { ok: false, error: error.message, code: error.code || "capability_failed" };
        }
        if (specialist !== "Lead Agent") {
          await emit("agent_done", { agent: specialist, ok: output?.ok !== false });
        }
        if (output?.__pause === "waiting_user") {
          await store.appendTurn(conversation, {
            role: "lead", content: output.question,
            payload: { question: true, businessConsequence: output.businessConsequence },
          });
          await emit("question_asked", {
            question: output.question,
            businessConsequence: output.businessConsequence,
          });
          await store.updateConversation(conversation, { state: "waiting_user", last_activity_at: nowIso() });
          notifyOwnerIfAway(conversation.owner, conversation.id, {
            title: "Quick decision needed",
            body: String(output.question).slice(0, 140),
            tag: `question-${conversation.id}`,
          }).catch(() => {});
          return;
        }
        input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
      }
      await store.updateConversation(conversation, { last_activity_at: nowIso() });
    }
    await emit("agent_done", { agent: "Lead Agent" });
    await finishWithMessage(store, conversation,
      "I hit my per-message working limit before finishing — the work so far is recorded above. Tell me to continue and I'll pick it straight up.");
  } catch (error) {
    await emit("lead_error", { error: error.message, code: error.code || "lead_agent_failed" });
    await store.updateConversation(conversation, { state: "idle", last_activity_at: nowIso() });
  }
}

// ── context assembly (Memory System injection) ────────────────────────────────────────────

async function leadInstructions(store, conversation) {
  const [profile, products, memories] = await Promise.all([
    store.getOwnerProfile(conversation.owner),
    store.listProducts(conversation.owner),
    store.listMemories(conversation.owner, { productId: conversation.product_id, limit: 12 }),
  ]);
  const sections = [LEAD_INSTRUCTIONS];
  if (profile && Object.keys(profile).length) {
    sections.push(`MEMORY — owner profile:\n${JSON.stringify(profile)}`);
  }
  if (products.length) {
    sections.push(`MEMORY — the user's products:\n${products.map((product) =>
      `- ${product.name}${product.summary ? `: ${product.summary}` : ""}`).join("\n")}`);
  }
  if (memories.length) {
    sections.push(`MEMORY — remembered facts and preferences:\n${memories.map((memory) =>
      `- [${memory.kind}] ${memory.content}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

// Scoped conversation context (audit 2026-08-01): only the most recent turns ride in
// full; older turns are collapsed into one compact summary block instead of being
// replayed verbatim, and no single turn may exceed TURN_CHAR_CAP (long evidence dumps
// arrive once, not on every subsequent message). Exported for the context tests.
const RECENT_FULL_TURNS = 16;
const TURN_CHAR_CAP = 6_000;
const SUMMARY_LINE_CAP = 200;

export async function assembleInput(store, conversation) {
  const turns = (await store.listTurns(conversation.owner, conversation.id, { limit: HISTORY_TURNS }) || [])
    .filter((turn) => ["user", "lead"].includes(turn.role) && turn.content);
  const older = turns.slice(0, Math.max(turns.length - RECENT_FULL_TURNS, 0));
  const recent = turns.slice(-RECENT_FULL_TURNS);

  const input = [];
  if (older.length) {
    const summary = older.map((turn) =>
      `- ${turn.role === "user" ? "User" : "You"}: ${String(turn.content).replace(/\s+/g, " ").slice(0, SUMMARY_LINE_CAP)}`).join("\n");
    input.push({
      role: "user",
      content: `[Conversation summary — ${older.length} earlier message(s), condensed. Rely on your product memory for standing facts.]\n${summary}`,
    });
  }
  for (const turn of recent) {
    // Workspace context rides the model turn only — the visible thread stays the user's
    // own words, marked with a transparent context chip by the shell.
    const context = turn.payload?.workspace_context;
    const suffix = context
      ? `\n\n[Shared automatically from the user's editor — visible to them as a context chip]\n${describeWorkspaceContext(context)}`
      : "";
    const content = String(turn.content);
    const capped = content.length > TURN_CHAR_CAP
      ? `${content.slice(0, TURN_CHAR_CAP)}\n[… truncated for context economy — full text is in the conversation record]`
      : content;
    input.push({
      role: turn.role === "user" ? "user" : "assistant",
      content: `${capped}${suffix}`,
    });
  }
  return input;
}

// ── run relay: specialist progress from dispatched runs flows into the conversation ───────

const RELAY_STATUS = {
  "run.provisioning": "Setting up a secure workspace…",
  "run.indexing": "Reading the codebase…",
  "run.running": "Writing code…",
  "review.checked_out": "Reading the pull request…",
  "publish.approved": "Publishing…",
};

function relayRunEvents({ store, runStore, conversation, runId }) {
  const unsubscribe = runStore.subscribe(runId, async (event) => {
    try {
      const status = RELAY_STATUS[event.type];
      if (status) {
        await store.appendEvent(conversation, "agent_status", { agent: "Builder", status, runId });
      }
      if (event.type === "run.waiting_for_approval") {
        await store.appendEvent(conversation, "approval_card", {
          runId,
          kind: event.payload?.action?.action === "post_review" ? "post_review" : "create_pull_request",
          message: event.payload?.message || "Ready for your approval.",
        });
      }
      if (/^run\.(succeeded|failed|cancelled|interrupted)$/.test(event.type)) {
        unsubscribe();
        const outcome = event.type.split(".")[1];
        const text = outcome === "succeeded"
          ? `The team finished that run successfully.${event.payload?.result?.summary ? ` ${String(event.payload.result.summary).slice(0, 300)}` : ""}`
          : `That run ${outcome}${event.payload?.error ? `: ${String(event.payload.error).slice(0, 200)}` : "."}`;
        await store.appendEvent(conversation, "agent_done", { agent: "Builder", ok: outcome === "succeeded", runId });
        await store.appendTurn(conversation, { role: "lead", content: text, payload: { runId } });
        await store.appendEvent(conversation, "message", { role: "lead", text, runId });
      }
    } catch (error) {
      console.error("[lead-agent] relay:", error.message);
    }
  });
  return unsubscribe;
}

// ── helpers, recovery ─────────────────────────────────────────────────────────────────────

async function finishWithMessage(store, conversation, text) {
  await store.appendTurn(conversation, { role: "lead", content: text });
  await store.appendEvent(conversation, "message", { role: "lead", text });
  await store.updateConversation(conversation, { state: "idle", last_activity_at: nowIso() });
}

async function meterUsage(runStore, owner, usage = {}, billingSource) {
  if (!usage || !Object.keys(usage).length) return;
  await runStore.recordStandaloneUsage(owner, {
    provider: "lead-agent",
    model: "conversation",
    input_tokens: usage.inputTokens || 0,
    cached_tokens: usage.cachedTokens || 0,
    output_tokens: usage.outputTokens || 0,
    reasoning_tokens: usage.reasoningTokens || 0,
    compute_seconds: 0,
    amount_gbp: 0,
    billing_source: billingSource,
    metadata: { kind: "conversation", total_tokens: usage.totalTokens || 0 },
  }).catch(() => {});
}

let recoveryTimer = null;
export function startLeadAgentRecovery() {
  if (recoveryTimer) return;
  const interval = Math.max(Number(optionalEnv("LEAD_AGENT_RECOVERY_MS", "60000")), 10_000);
  recoveryTimer = setInterval(() => {
    recoverStaleConversations().catch((error) => console.error("[lead-agent] recovery:", error));
  }, interval);
  recoveryTimer.unref?.();
}

export function stopLeadAgentRecovery() {
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;
}

// A conversation stuck in "thinking" past the stale window means the process died mid-loop.
// The Lead Agent never visibly dies: recover to idle with an honest event so the user can
// simply continue.
export async function recoverStaleConversations({ store = conversationStore(), now = Date.now() } = {}) {
  const staleMinutes = Math.max(Number(optionalEnv("LEAD_AGENT_STALE_MINUTES", "5")), 1);
  const staleBefore = new Date(now - staleMinutes * 60_000).toISOString();
  const recovered = await store.recoverStaleThinking(staleBefore);
  for (const conversation of recovered) {
    await store.appendEvent(conversation, "lead_recovered", {
      message: "I lost my train of thought during a restart — everything above is saved. Tell me to continue.",
    });
  }
  return recovered;
}

function nowIso() {
  return new Date().toISOString();
}

function inputError(message, status = 400, code = "invalid_message") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
