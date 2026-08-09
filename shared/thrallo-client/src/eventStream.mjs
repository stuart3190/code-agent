import { CancelledError, OfflineError, mapClientError } from "./errors.mjs";

async function* readableChunks(source) {
  if (!source) return;
  if (typeof source[Symbol.asyncIterator] === "function") {
    yield* source;
    return;
  }
  if (typeof source.getReader === "function") {
    const reader = source.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  throw new TypeError("SSE source must be an async iterable or ReadableStream");
}

function parseData(lines) {
  const text = lines.join("\n");
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export async function* parseSseChunks(source) {
  const decoder = new TextDecoder();
  let buffer = "";
  let current = { data: [] };

  function flush() {
    if (!current.id && !current.event && current.data.length === 0 && current.retry == null) return null;
    const event = Object.freeze({
      id: current.id || null,
      type: current.event || "message",
      data: parseData(current.data),
      retry: current.retry ?? null,
    });
    current = { data: [] };
    return event;
  }

  for await (const chunk of readableChunks(source)) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        const event = flush();
        if (event) yield event;
        continue;
      }
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") current.data.push(value);
      else if (field === "id" && !value.includes("\0")) current.id = value;
      else if (field === "event") current.event = value;
      else if (field === "retry" && /^\d+$/.test(value)) current.retry = Number(value);
    }
  }
  buffer += decoder.decode();
  if (buffer) {
    const lines = buffer.replace(/\r$/, "").split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith("data:")) current.data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith("id:")) current.id = line.slice(3).replace(/^ /, "");
      else if (line.startsWith("event:")) current.event = line.slice(6).replace(/^ /, "");
    }
  }
  const finalEvent = flush();
  if (finalEvent) yield finalEvent;
}

function terminalEvent(event) {
  return event.type === "done" || event.data?.terminal === true;
}

export async function* consumeEventStream({
  connect,
  initialCursor = null,
  signal = null,
  maxReconnects = 3,
  reconnectDelayMs = 0,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
} = {}) {
  if (typeof connect !== "function") throw new TypeError("Event stream connect function is required");
  let cursor = initialCursor;
  let reconnects = 0;

  while (true) {
    if (signal?.aborted) throw new CancelledError();
    try {
      const connection = await connect({ cursor, signal, attempt: reconnects + 1 });
      const chunks = connection?.chunks || connection;
      let sawTerminal = false;
      for await (const event of parseSseChunks(chunks)) {
        if (signal?.aborted) throw new CancelledError();
        if (event.id != null) cursor = event.id;
        const delivered = Object.freeze({ ...event, cursor });
        yield delivered;
        if (terminalEvent(event)) {
          sawTerminal = true;
          break;
        }
      }
      if (sawTerminal) return;
      if (reconnects >= maxReconnects) throw new OfflineError("Event stream ended before a terminal event.", { details: { cursor } });
    } catch (error) {
      const mapped = mapClientError(error);
      if (mapped.code === "cancelled" || !mapped.retryable || reconnects >= maxReconnects) throw mapped;
    }
    reconnects += 1;
    if (reconnectDelayMs > 0) await sleep(reconnectDelayMs, signal);
  }
}
