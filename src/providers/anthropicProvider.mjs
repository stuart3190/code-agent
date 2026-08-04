// The FIRST BYOK adapter — Anthropic (Claude) via the official Messages API.
// It satisfies the SAME seam the Codex provider does, so the engine never learns it exists:
//
//   runTurn({ systemPrompt, messages, tools }) -> { text, toolCalls, usage }
//
// All Anthropic/Messages-API specifics live here. The neutral shapes the engine speaks are
// identical to the Codex path (see codexProvider.mjs); only the wire translation differs.
//
//   createAnthropicProvider({ model, cache, maxTokens }) -> { runTurn, rates, model }
//
// Key custody (Phase 4, done right): the API key is read from process.env.ANTHROPIC_API_KEY ONLY,
// sent solely as the `x-api-key` header, and never logged, written to a file, or committed.

import { anthropicRatesFor } from "../cost.mjs";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6"; // Preserve the existing site-generation lane; Code Agent passes its own current model.
const DEFAULT_MAX_TOKENS = 16000; // a generous cap (billed only for tokens actually emitted)

// ---- neutral -> Messages API translation (pure; exported for offline tests) ----

// A configurable timeout that cannot be configured into uselessness: a typo or a stray 0 must not
// disable the bound, which is the state this provider was already in.
function boundedMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 5_000 ? Math.floor(parsed) : fallback;
}

function safeParse(s) {
  if (typeof s !== "string") return s ?? {};
  try {
    return JSON.parse(s || "{}");
  } catch {
    return { __raw: s };
  }
}

// Neutral messages -> Anthropic `messages`. The one non-obvious bit: Anthropic requires ALL
// tool_result blocks answering a single assistant turn's (possibly parallel) tool calls to sit in
// ONE following user message. The engine emits one assistant tool-call message then N separate
// `{role:"tool"}` messages, so we coalesce consecutive neutral tool results into one user message.
export function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.content }] });
    } else if (m.role === "assistant" && m.toolCalls) {
      out.push({
        role: "assistant",
        content: m.toolCalls.map((tc) => ({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: safeParse(tc.arguments), // tc.arguments is the raw JSON string the engine round-trips
        })),
      });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: [{ type: "text", text: m.content }] });
    } else if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.output };
      const prev = out[out.length - 1];
      const prevIsToolResults =
        prev && prev.role === "user" && Array.isArray(prev.content) && prev.content.every((b) => b.type === "tool_result");
      if (prevIsToolResults) prev.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

// Neutral tools -> Anthropic tools. Only the schema key name differs (`parameters` -> `input_schema`).
export function toAnthropicTools(tools) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
}

// Build the full request body. `cache` gates Anthropic prompt caching: a cache_control breakpoint on
// the last system block (render order tools->system->messages, so it caches tools+system — the
// byte-stable prefix the engine's --cache mode already freezes) and one on the last content block of
// the latest turn (to cache the append-only history incrementally). When cache is off we set NO
// breakpoint, so the cache-hostile 2.2 default never pays the 1.25× write premium for zero hits.
export function buildRequestBody({ systemPrompt, messages, tools, model = DEFAULT_MODEL, maxTokens = DEFAULT_MAX_TOKENS, cache = false }) {
  const system = [{ type: "text", text: systemPrompt }];
  if (cache) system[system.length - 1].cache_control = { type: "ephemeral" };

  const wireMessages = toAnthropicMessages(messages);
  if (cache && wireMessages.length) {
    const last = wireMessages[wireMessages.length - 1];
    if (Array.isArray(last.content) && last.content.length) {
      const i = last.content.length - 1;
      last.content[i] = { ...last.content[i], cache_control: { type: "ephemeral" } };
    }
  }

  const body = { model, max_tokens: maxTokens, system, messages: wireMessages, stream: true };
  const wireTools = toAnthropicTools(tools);
  if (wireTools) {
    body.tools = wireTools;
    body.tool_choice = { type: "auto" };
  }
  return body;
}

// ---- Anthropic usage -> neutral blended usage ----
// Anthropic's `input_tokens` is the UNCACHED remainder only; the full prompt is
// input_tokens + cache_creation + cache_read. We fold all three into neutral `input` so cost.mjs's
// invariant (`cached`/`cacheWrite` are subsets of `input`) holds, and surface read vs write separately.
export function normalizeUsage(u) {
  if (!u) return { input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0, total: 0 };
  const remainder = u.input_tokens ?? 0;
  const cached = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const input = remainder + cached + cacheWrite;
  const output = u.output_tokens ?? 0;
  return { input, output, reasoning: 0, cached, cacheWrite, total: input + output };
}

// ---- SSE accumulator (pure; exported for offline tests) ----
// Feed it parsed event objects; it assembles text, tool calls, usage, and the stop reason.
export function createAccumulator() {
  let text = "";
  const toolCalls = [];
  const partial = {}; // content-block index -> { id, name, json }
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let stopReason = null;

  function mergeUsage(u) {
    if (!u) return;
    // input/cache counts arrive on message_start; output_tokens is finalised (cumulative) on message_delta.
    if (u.input_tokens != null) usage.input_tokens = u.input_tokens;
    if (u.cache_creation_input_tokens != null) usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
    if (u.cache_read_input_tokens != null) usage.cache_read_input_tokens = u.cache_read_input_tokens;
    if (u.output_tokens != null) usage.output_tokens = u.output_tokens;
  }

  function push(evt) {
    switch (evt.type) {
      case "message_start":
        mergeUsage(evt.message?.usage);
        break;
      case "content_block_start":
        if (evt.content_block?.type === "tool_use") {
          partial[evt.index] = { id: evt.content_block.id, name: evt.content_block.name, json: "" };
        }
        break;
      case "content_block_delta": {
        const d = evt.delta;
        if (d?.type === "text_delta") text += d.text ?? "";
        else if (d?.type === "input_json_delta" && partial[evt.index]) partial[evt.index].json += d.partial_json ?? "";
        break;
      }
      case "content_block_stop": {
        const p = partial[evt.index];
        if (p) {
          const raw = p.json && p.json.trim() ? p.json : "{}";
          toolCalls.push({ id: p.id, name: p.name, rawArguments: raw, arguments: safeParse(raw) });
          delete partial[evt.index];
        }
        break;
      }
      case "message_delta":
        mergeUsage(evt.usage);
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        break;
    }
  }

  return {
    push,
    result() {
      return { text: text.trim(), toolCalls, usage: normalizeUsage(usage), stopReason };
    },
  };
}

// ---- the provider ----

// `apiKey` (optional) is the per-request BYOK key source: when the caller supplies one at the
// provider-CONFIG level it is used verbatim; otherwise we fall back to process.env.ANTHROPIC_API_KEY
// (the platform key). This is the ONLY change for per-user BYOK — the runTurn signature and every
// wire-translation function above are unchanged. The key is never logged, written, or committed.
export function createAnthropicProvider({ model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL, cache = false, maxTokens = DEFAULT_MAX_TOKENS, apiKey = null } = {}) {
  const rates = anthropicRatesFor(model);

  async function runTurn({ systemPrompt, messages, tools }) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error(
        "No Anthropic API key. Provide one via the provider config (BYOK) or process.env.ANTHROPIC_API_KEY " +
          "(it is never logged, written to disk, or committed). Set it and re-run."
      );
    }

    const body = buildRequestBody({ systemPrompt, messages, tools, model, maxTokens, cache });

    /**
     * A stall timeout, not a deadline.
     *
     * This call had no bound of ANY kind, while every sibling provider had one. A connection that
     * opened and then went quiet — a provider incident, a dropped route — hung here forever: the
     * Lead Agent's turn neither threw nor returned, so nothing recovered it and the conversation
     * sat on "Understanding request…" indefinitely. That is the ten-minute stuck build.
     *
     * A fixed deadline is the wrong instrument for a token stream: a genuinely long generation is
     * healthy and would be killed mid-answer. What is unhealthy is SILENCE, so the timer measures
     * the gap between chunks and is reset by each one. A hard ceiling sits behind it so a provider
     * that trickles a byte forever still ends.
     */
    const stallMs = boundedMs(process.env.ANTHROPIC_STALL_MS, 120_000);
    const ceilingMs = boundedMs(process.env.ANTHROPIC_MAX_MS, 900_000);
    const controller = new AbortController();
    let stallTimer = null;
    let stalled = false;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { stalled = true; controller.abort(); }, stallMs);
    };
    const ceiling = setTimeout(() => { stalled = true; controller.abort(); }, ceilingMs);
    ceiling.unref?.();
    armStall();
    stallTimer.unref?.();

    // Normalised so the router's retry classifier recognises it: a stall is a transient provider
    // fault and is exactly the kind of thing worth failing over for.
    const asStall = (cause) => {
      const error = new Error(
        `Anthropic stopped responding after ${Math.round(stallMs / 1000)}s of silence. `
        + "The request was abandoned rather than left hanging.",
      );
      error.status = 504;
      error.code = "anthropic_timeout";
      error.cause = cause;
      return error;
    };

    let res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(stallTimer); clearTimeout(ceiling);
      throw stalled ? asStall(error) : error;
    }

    if (!res.ok) {
      clearTimeout(stallTimer); clearTimeout(ceiling);
      const errBody = await res.text(); // Anthropic errors do not echo the key
      const error = new Error(`Anthropic messages HTTP ${res.status}: ${errBody}`);
      error.status = res.status;
      error.code = res.status === 429 ? "anthropic_rate_limit" : "anthropic_request_failed";
      throw error;
    }

    // Parse the SSE stream line by line, feeding each `data:` event to the accumulator.
    const acc = createAccumulator();
    let buf = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        // Each chunk is proof the provider is still there, so the silence timer starts again.
        armStall();
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          let evt;
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }
          acc.push(evt);
        }
      }
    } catch (error) {
      throw stalled ? asStall(error) : error;
    } finally {
      clearTimeout(stallTimer);
      clearTimeout(ceiling);
    }

    const { text, toolCalls, usage, stopReason } = acc.result();
    // A safety-classifier decline returns HTTP 200 with stop_reason "refusal": surface a note, no
    // tool calls, so the engine loop ends cleanly instead of crashing on missing content.
    if (stopReason === "refusal") {
      return { text: text || "[anthropic safety refusal — request declined]", toolCalls: [], usage };
    }
    return { text, toolCalls, usage };
  }

  return { runTurn, rates, model };
}
