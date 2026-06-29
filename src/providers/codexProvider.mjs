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

export function createCodexProvider() {
  // Phase 2.3: an optional prompt_cache_key improves prompt-cache ROUTING stickiness
  // (requests sharing the key + prefix are likelier to reuse the same cached KV state).
  // The field lives ONLY here, behind the seam; the engine passes a neutral `promptCacheKey`.
  async function runTurn({ systemPrompt, messages, tools, promptCacheKey }) {
    const { accessToken, accountId } = await getAccessToken();

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

    const res = await fetch(CODEX_RESPONSES_URL, {
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

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Codex responses HTTP ${res.status}: ${errBody}`);
    }

    // Parse SSE. Accumulate text from deltas (final output[] can be empty); collect
    // function_call items from response.output_item.done; usage from response.completed.
    let text = "";
    const toolCalls = [];
    let usage = null;
    let buf = "";
    const decoder = new TextDecoder();
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

    return { text: text.trim(), toolCalls, usage: normalizeUsage(usage) };
  }

  return { runTurn };
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
