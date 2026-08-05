// The thin provider seam. ALL Codex/Responses specifics live here.
// The engine speaks a neutral shape; a future BYOK adapter could satisfy the same interface.
//
// Interface:  runTurn({ systemPrompt, messages, tools }) -> { text, toolCalls, usage }
//
// Neutral message shapes the engine uses:
//   { role:"user"|"assistant", content:string }
//   { role:"assistant", toolCalls:[{ id, name, arguments }] }     // arguments = JSON string
//   { role:"tool", toolCallId, name, output:string }
// Neutral tool shape:
//   { name, description, parameters }   // parameters = JSON schema object

import { getAccessToken } from "./auth.mjs";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const MODEL = "gpt-5.5"; // proven working for ChatGPT-account auth ("-codex" is rejected)

// neutral messages -> Responses `input` items
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

// neutral tools -> Responses function tools
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

export function createCodexProvider({ fetchImpl = fetch, tokenProvider = getAccessToken } = {}) {
  // Phase 2.3: an optional prompt_cache_key improves prompt-cache ROUTING stickiness
  // (requests sharing the key + prefix are likelier to reuse the same cached KV state).
  // The field lives ONLY here, behind the seam; the engine passes a neutral `promptCacheKey`.
  // fetchImpl/tokenProvider are injectable so the identifier plumbing is provable without a
  // ChatGPT account; production always uses the defaults.
  async function runTurn({ systemPrompt, messages, tools, promptCacheKey }) {
    const { accessToken, accountId } = await tokenProvider();

    const body = {
      model: MODEL,
      instructions: systemPrompt,
      input: toInputItems(messages),
      stream: true,
      store: false, // backend rejects store:true/stream:false; no `metadata` (would 400)
    };
    if (promptCacheKey) body.prompt_cache_key = promptCacheKey;
    const wireTools = toWireTools(tools);
    if (wireTools) {
      body.tools = wireTools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }

    const res = await fetchImpl(CODEX_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-ID": accountId,
        "OpenAI-Beta": "responses=experimental",
        originator: "codex_cli_rs",
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    // The strongest STABLE identifiers this transport actually exposes, typed so a billing row
    // can never be mistaken for an OpenAI-platform request id:
    //   codex:response:<id>  — the backend's response object id (response.created/completed)
    //   codex:request:<id>   — the HTTP x-request-id header, when the backend sends one
    // Nothing is ever invented: no id in the stream and no header means null, recorded as null.
    const headerRequestId = res.headers?.get?.("x-request-id") || null;
    let providerRequestId = headerRequestId ? `codex:request:${headerRequestId}` : null;

    if (!res.ok) {
      const errBody = await res.text();
      const error = new Error(`Codex responses HTTP ${res.status}${providerRequestId ? ` (${providerRequestId})` : ""}: ${errBody}`);
      // A failed call that the backend received still has an identity — keep it for incident logs.
      error.providerRequestId = providerRequestId;
      throw error;
    }

    // Parse SSE. Accumulate text from deltas (final output[] can be empty); collect
    // function_call items from response.output_item.done; usage from response.completed.
    let text = "";
    const toolCalls = [];
    let usage = null;
    let buf = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let evt;
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }
          // The response id arrives on response.created and again on response.completed; the
          // response id beats the HTTP header because it names the turn, not the connection.
          if (evt.response?.id) providerRequestId = `codex:response:${evt.response.id}`;
          if (evt.type === "response.output_text.delta" && typeof evt.delta === "string") {
            text += evt.delta;
          } else if (evt.type === "response.output_item.done" && evt.item?.type === "function_call") {
            const it = evt.item;
            let args;
            try {
              args = JSON.parse(it.arguments || "{}");
            } catch {
              args = { __raw: it.arguments };
            }
            toolCalls.push({ id: it.call_id, name: it.name, rawArguments: it.arguments, arguments: args });
          } else if (evt.type === "response.completed" && evt.response?.usage) {
            usage = evt.response.usage;
          }
        }
      }
    } catch (streamError) {
      // The backend opened a response and the stream died mid-flight: the turn happened, tokens
      // may have been consumed, and its identifier is the only handle support has. Retain it.
      streamError.providerRequestId = providerRequestId;
      throw streamError;
    }

    return { text: text.trim(), toolCalls, usage: { ...normalizeUsage(usage), providerRequestId } };
  }

  // The transport's identity, exposed so telemetry stops recording model:null — which made every
  // Codex usage row price at the default rate and classify by guesswork. `model` is the REAL wire
  // model (the ChatGPT-account backend rejects "-codex"-suffixed names), and `providerId` names
  // the lane so billing rows are attributable without inference.
  return { runTurn, model: MODEL, providerId: "codex" };
}

// Codex usage shape -> neutral blended shape a BYOK adapter could also fill.
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
