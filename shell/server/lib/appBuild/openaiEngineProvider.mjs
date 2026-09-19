// Engine-contract provider (runTurn) over the public OpenAI Responses API with Thrallo's
// managed API key. The generation engine natively speaks only Codex-OAuth and Anthropic;
// Thrallo production runs on an OpenAI API key, so this adapter closes that gap. Message and
// tool translation mirrors src/providers/codexProvider.mjs; transport is non-streaming
// api.openai.com with the key from env.
//
//   runTurn({ systemPrompt, messages, tools }) -> { text, toolCalls, usage }

import { optionalEnv } from "../env.mjs";
import { approvedConfiguredModel, assertProviderModel } from "../modelCatalogue.mjs";
import { DISPATCH_STATES, providerFailure } from "../providerOutcome.mjs";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

function toInputItems(messages) {
  const items = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({ role: "user", content: [{ type: "input_text", text: m.content }] });
    } else if (m.role === "assistant" && m.toolCalls) {
      for (const tc of m.toolCalls) {
        items.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.arguments });
      }
    } else if (m.role === "assistant") {
      items.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
    } else if (m.role === "tool") {
      items.push({ type: "function_call_output", call_id: m.toolCallId, output: m.output });
    }
  }
  return items;
}

function toWireTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
}

export function createOpenAIEngineProvider({ model, apiKey = null, fetchImpl = fetch } = {}) {
  const key = apiKey || optionalEnv("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is required for managed app builds.");
  const resolvedModel = assertProviderModel({
    provider: "openai",
    model: model || approvedConfiguredModel("OPENAI_BALANCED_MODEL", "gpt-5.6-terra", { provider: "openai", tier: "balanced" }),
  }).model;

  async function runTurn({ systemPrompt, messages, tools, signal = null, maxOutputTokens = null }) {
    const body = {
      model: resolvedModel,
      instructions: systemPrompt,
      input: toInputItems(messages),
      store: false,
      ...(maxOutputTokens ? { max_output_tokens: Math.max(1, Math.floor(maxOutputTokens)) } : {}),
    };
    const wireTools = toWireTools(tools);
    if (wireTools) {
      body.tools = wireTools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }

    let res;
    try { res = await fetchImpl(RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000),
    }); } catch (error) { throw providerFailure(error, { state: DISPATCH_STATES.ambiguous }); }
    if (!res.ok) {
      const errBody = await res.text();
      const error = new Error(`OpenAI responses HTTP ${res.status}: ${errBody.slice(0, 400)}`);
      error.status = res.status;
      error.providerRequestId = res.headers?.get?.("x-request-id") || null;
      throw providerFailure(error, { state: res.status < 500 ? DISPATCH_STATES.rejected : DISPATCH_STATES.ambiguous,
        providerRequestId: error.providerRequestId, retrySafe: [408, 409, 425, 429].includes(res.status) });
    }
    const data = await res.json();

    let text = "";
    const toolCalls = [];
    for (const item of data.output || []) {
      if (item.type === "message") {
        for (const part of item.content || []) {
          if (part.type === "output_text" && part.text) text += part.text;
        }
      } else if (item.type === "function_call") {
        let args;
        try { args = JSON.parse(item.arguments || "{}"); } catch { args = { __raw: item.arguments }; }
        toolCalls.push({ id: item.call_id, name: item.name, rawArguments: item.arguments, arguments: args });
      }
    }
    return {
      text: text.trim(),
      toolCalls,
      // The provider's own response id rides with the usage. The 2026-08-05 billing incident could
      // only be reconciled against tariff tables because no provider id was stored — and the first
      // fix patched src/providers/codexProvider (used by ops probes), while THIS is the provider
      // production's managed path actually runs on. The verification build recorded zero ids,
      // which is how the mistake surfaced.
      usage: { ...normalizeUsage(data.usage), providerRequestId: data.id || null },
    };
  }

  return { runTurn, model: resolvedModel, provider: "openai" };
}

function normalizeUsage(u) {
  if (!u) return { input: 0, output: 0, reasoning: 0, cached: 0, total: 0 };
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  return {
    input,
    output,
    reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
    cached: u.input_tokens_details?.cached_tokens ?? 0,
    total: u.total_tokens ?? input + output,
  };
}
