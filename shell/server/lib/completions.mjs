// Inline code completion for editor clients.
//
// A single fast-tier model call with a fill-in-the-middle prompt, enriched with a few
// excerpts from the encrypted repository index. Completions spend real tokens, so they are
// metered like runs (standalone usage rows, billing-source tagged), blocked when the managed
// token budget is spent, and bounded by a per-owner per-minute limiter. Codex subscriptions
// cannot serve single-shot completions; those owners fall back to managed keys when
// configured.

import { optionalEnv } from "./env.mjs";
import { codeAgentStore } from "./codeAgentStore.mjs";
import { activeAiCredential } from "./aiCredentialStore.mjs";
import { modelCatalog, createProviderForCandidate } from "./modelRouting.mjs";
import { retrieveRepositoryContext } from "./repositoryIndexer.mjs";
import { budgetOverview } from "./usageBudgets.mjs";

const PREFIX_LIMIT = 6_000;
const SUFFIX_LIMIT = 2_000;
const CONTEXT_LIMIT = 3;

const INSTRUCTIONS = `You are a code completion engine. You receive the file path, code before the cursor (PREFIX), and code after the cursor (SUFFIX), plus optional repository excerpts.
Output ONLY the code to insert at the cursor: no markdown fences, no explanation, no repetition of the prefix or suffix.
Stop at a natural boundary within roughly ten lines. If no useful completion exists, output nothing.`;

const buckets = new Map();

export function completionRateAllowed(owner, now = Date.now()) {
  const perMinute = boundedEnv("CODE_AGENT_COMPLETIONS_PER_MINUTE", 30);
  const windowStart = now - 60_000;
  const entries = (buckets.get(owner) || []).filter((stamp) => stamp > windowStart);
  if (entries.length >= perMinute) {
    buckets.set(owner, entries);
    return false;
  }
  entries.push(now);
  buckets.set(owner, entries);
  return true;
}

export function resetCompletionRateForTests() {
  buckets.clear();
}

export function parseCompletionInput(body = {}) {
  const path = String(body.path || "").slice(0, 500);
  const prefix = String(body.prefix || "");
  if (!prefix.trim()) throw inputError("prefix is required");
  const localContext = Array.isArray(body.localContext)
    ? body.localContext.slice(0, 20).map((excerpt) => ({
      path: String(excerpt?.path || "").slice(0, 500),
      startLine: Math.max(Math.floor(Number(excerpt?.startLine) || 1), 1),
      endLine: Math.max(Math.floor(Number(excerpt?.endLine) || 1), 1),
      content: String(excerpt?.content || "").slice(0, 1_500),
    }))
      .filter((excerpt) => excerpt.path && excerpt.content.trim())
      .slice(0, CONTEXT_LIMIT)
    : [];
  return {
    repositoryId: String(body.repositoryId || "").slice(0, 64),
    repositoryFullName: String(body.repositoryFullName || "").slice(0, 255),
    path,
    language: String(body.language || "").slice(0, 60),
    prefix: prefix.slice(-PREFIX_LIMIT),
    suffix: String(body.suffix || "").slice(0, SUFFIX_LIMIT),
    localContext,
  };
}

export async function completeCode(owner, input, {
  store = codeAgentStore(),
  credentialResolver = activeAiCredential,
  providerFactory = createProviderForCandidate,
  contextRetriever = retrieveRepositoryContext,
  overviewResolver = budgetOverview,
  now = Date.now(),
} = {}) {
  const { isOwnerAccount } = await import("./ownerAccounts.mjs");
  const ownerAccount = await isOwnerAccount(owner);
  if (!ownerAccount && !completionRateAllowed(owner, now)) {
    throw serviceError("Completion rate limit reached; slow down.", 429, "rate_limited");
  }

  let credential = await credentialResolver(owner).catch(() => ({ provider: "managed", secret: null }));
  if (credential.provider === "codex") {
    credential = { provider: "managed", secret: null };
  }
  const candidate = pickFastCandidate(credential);
  if (!candidate) {
    throw serviceError(
      "No completion-capable model is configured. Connect an OpenAI, Anthropic, or Gemini key, or use managed AI.",
      409,
      "completion_unavailable",
    );
  }
  const billingSource = credential.provider === "managed" ? "managed" : "byok";
  if (billingSource === "managed") {
    const overview = await overviewResolver(owner, { store });
    if (!overview.unlimited && overview.budgets.managedTokens.remaining <= 0) {
      throw serviceError("Your monthly managed-model token allowance is used up.", 402, "budget_exceeded");
    }
  }

  // Editor-supplied local excerpts take priority (they reflect the working tree right now);
  // the server-side encrypted index fills any remaining slots.
  const repository = await resolveRepository(store, owner, input);
  let context = (input.localContext || []).slice(0, CONTEXT_LIMIT);
  if (repository && context.length < CONTEXT_LIMIT) {
    const query = completionQuery(input);
    const remote = await contextRetriever(owner, repository.id, query, {
      limit: CONTEXT_LIMIT - context.length,
    }).catch(() => []);
    context = [...context, ...remote];
  }

  const provider = providerFactory(candidate, credential);
  const started = Date.now();
  const response = await provider.turn({
    instructions: INSTRUCTIONS,
    input: [{ role: "user", content: buildCompletionPrompt(input, context) }],
    tools: [],
    safetyIdentifier: owner,
  });
  const completion = cleanCompletion(response.text || extractText(response));

  const usage = response.usage || {};
  await store.recordStandaloneUsage(owner, {
    provider: candidate.provider,
    model: candidate.model,
    input_tokens: usage.inputTokens || 0,
    cached_tokens: usage.cachedTokens || 0,
    output_tokens: usage.outputTokens || 0,
    reasoning_tokens: usage.reasoningTokens || 0,
    compute_seconds: 0,
    amount_gbp: 0,
    billing_source: billingSource,
    metadata: { kind: "completion", total_tokens: usage.totalTokens || 0 },
  }).catch(() => {});

  return {
    completion,
    provider: candidate.provider,
    model: candidate.model,
    contextExcerpts: context.length,
    latencyMs: Date.now() - started,
  };
}

export function buildCompletionPrompt(input, context = []) {
  const parts = [];
  for (const excerpt of context) {
    parts.push(`Repository excerpt ${excerpt.path}:${excerpt.startLine}-${excerpt.endLine}\n${String(excerpt.content || "").slice(0, 1_500)}`);
  }
  parts.push(`File: ${input.path || "untitled"}${input.language ? ` (${input.language})` : ""}`);
  parts.push(`PREFIX:\n${input.prefix}`);
  parts.push(`SUFFIX:\n${input.suffix || "(end of file)"}`);
  parts.push("Insert at the cursor:");
  return parts.join("\n\n");
}

export function cleanCompletion(text) {
  let out = String(text || "");
  const fenced = out.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (fenced) out = fenced[1];
  out = out.replace(/^\s*\n/, "").replace(/\s+$/, "");
  const lines = out.split("\n");
  if (lines.length > 15) out = lines.slice(0, 15).join("\n");
  return out.slice(0, 4_000);
}

function completionQuery(input) {
  const tail = input.prefix.split("\n").filter((line) => line.trim()).slice(-4).join("\n");
  return `${input.path} ${tail}`.slice(0, 1_500);
}

async function resolveRepository(store, owner, input) {
  if (input.repositoryId) return store.getRepository(owner, input.repositoryId);
  if (!input.repositoryFullName) return null;
  const repositories = await store.listRepositories(owner);
  return repositories.find((repo) =>
    repo.full_name.toLowerCase() === input.repositoryFullName.toLowerCase()) || null;
}

function pickFastCandidate(credential) {
  const catalog = modelCatalog();
  if (credential.provider !== "managed") {
    return catalog.find((entry) => entry.provider === credential.provider && entry.tier === "fast")
      || catalog.find((entry) => entry.provider === credential.provider && entry.tier === "balanced")
      || null;
  }
  return catalog.find((entry) => entry.tier === "fast" && entry.configured)
    || catalog.find((entry) => entry.tier === "balanced" && entry.configured)
    || null;
}

function extractText(response) {
  for (const item of response?.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text" && part.text) return part.text;
      }
    }
  }
  return "";
}

function boundedEnv(name, fallback) {
  const value = Number(optionalEnv(name, ""));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = "invalid_completion_request";
  return error;
}

function serviceError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
