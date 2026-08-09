import { CancelledError, mapClientError, redact } from "./errors.mjs";

export const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 150,
  maxDelayMs: 1_000,
  retryStatuses: Object.freeze([408, 429, 502, 503, 504]),
});

let fallbackRequestSequence = 0;
function defaultRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  fallbackRequestSequence += 1;
  return `thrallo-request-${Date.now().toString(36)}-${fallbackRequestSequence.toString(36)}`;
}

function defaultSleep(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new CancelledError());
    }, { once: true });
  });
}

function normalizeHeaders(value) {
  if (!value) return {};
  if (value instanceof Headers) return Object.fromEntries(value.entries());
  return { ...value };
}

function requestPath(url) {
  return `${url.pathname}${url.search ? "?[REDACTED]" : ""}`;
}

async function responsePayload(response) {
  if (response.status === 204) return null;
  const contentType = response.headers?.get?.("content-type") || "";
  try {
    return contentType.includes("json") ? await response.json() : await response.text();
  } catch {
    return null;
  }
}

function retryDelay(policy, attempt) {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * (2 ** Math.max(0, attempt - 1)));
}

export function createHttpTransport({
  baseUrl,
  authProvider = null,
  fetchImpl = globalThis.fetch,
  requestIdFactory = defaultRequestId,
  retryPolicy = {},
  sleep = defaultSleep,
  logger = null,
} = {}) {
  if (!baseUrl) throw new TypeError("Thrallo HTTP transport requires a host-supplied baseUrl");
  if (typeof fetchImpl !== "function") throw new TypeError("Thrallo HTTP transport requires fetch");
  const base = new URL(baseUrl);
  const policy = Object.freeze({ ...DEFAULT_RETRY_POLICY, ...retryPolicy });

  const emit = (event) => {
    if (typeof logger !== "function") return;
    logger(redact(event));
  };

  async function authHeaders(context) {
    if (!authProvider) return {};
    const supplied = typeof authProvider === "function" ? await authProvider(context) : await authProvider.getAuthHeaders(context);
    return normalizeHeaders(supplied);
  }

  async function request({ method = "GET", path: relativePath, body, headers = {}, signal, idempotent = false, operationId = null } = {}) {
    if (!relativePath) throw new TypeError("Thrallo request path is required");
    const normalizedMethod = method.toUpperCase();
    const safeToRetry = ["GET", "HEAD", "OPTIONS"].includes(normalizedMethod) || idempotent === true;
    const maxAttempts = safeToRetry ? Math.max(1, policy.maxAttempts) : 1;
    const requestId = requestIdFactory();
    const url = new URL(relativePath, base);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) throw new CancelledError({ requestId });
      let hostAuth;
      try {
        hostAuth = await authHeaders({ requestId, operationId, signal });
      } catch (error) {
        throw mapClientError(error, { requestId });
      }
      const requestHeaders = {
        accept: "application/json",
        ...headers,
        ...hostAuth,
        "x-request-id": requestId,
      };
      let encodedBody = body;
      if (body != null && typeof body !== "string" && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) {
        requestHeaders["content-type"] ||= "application/json";
        encodedBody = JSON.stringify(body);
      }
      emit({ type: "request", requestId, operationId, method: normalizedMethod, path: requestPath(url), attempt });
      try {
        const response = await fetchImpl(url, {
          method: normalizedMethod,
          headers: requestHeaders,
          body: ["GET", "HEAD"].includes(normalizedMethod) ? undefined : encodedBody,
          signal,
        });
        const payload = await responsePayload(response);
        if (response.ok) {
          emit({ type: "response", requestId, operationId, method: normalizedMethod, path: requestPath(url), status: response.status, attempt });
          return Object.freeze({
            ok: true,
            requestId,
            data: payload,
            observedAt: response.headers?.get?.("date") || null,
            source: "http",
            revision: response.headers?.get?.("etag") || null,
          });
        }
        const mapped = mapClientError(null, { status: response.status, payload, requestId });
        emit({ type: "error", requestId, operationId, method: normalizedMethod, path: requestPath(url), status: response.status, code: mapped.code, attempt });
        if (attempt < maxAttempts && policy.retryStatuses.includes(response.status) && mapped.retryable) {
          await sleep(retryDelay(policy, attempt), signal);
          continue;
        }
        throw mapped;
      } catch (error) {
        const mapped = mapClientError(error, { requestId });
        if (mapped.code === "cancelled") throw mapped;
        emit({ type: "error", requestId, operationId, method: normalizedMethod, path: requestPath(url), status: mapped.status, code: mapped.code, attempt });
        if (attempt < maxAttempts && mapped.retryable) {
          await sleep(retryDelay(policy, attempt), signal);
          continue;
        }
        throw mapped;
      }
    }
    throw new Error("Unreachable retry state");
  }

  async function openEventStream({ path: relativePath, cursor = null, headers = {}, signal, operationId = null } = {}) {
    if (!relativePath) throw new TypeError("Thrallo event-stream path is required");
    if (signal?.aborted) throw new CancelledError();
    const requestId = requestIdFactory();
    const url = new URL(relativePath, base);
    let hostAuth;
    try {
      hostAuth = await authHeaders({ requestId, operationId, signal });
    } catch (error) {
      throw mapClientError(error, { requestId });
    }
    const requestHeaders = {
      ...headers,
      ...hostAuth,
      accept: "text/event-stream",
      "x-request-id": requestId,
    };
    if (cursor != null) requestHeaders["last-event-id"] = String(cursor);
    emit({ type: "stream-connect", requestId, operationId, method: "GET", path: requestPath(url), cursor });
    try {
      const response = await fetchImpl(url, { method: "GET", headers: requestHeaders, signal });
      if (!response.ok) throw mapClientError(null, { status: response.status, payload: await responsePayload(response), requestId });
      if (!response.body) throw mapClientError(new TypeError("Event stream has no response body"), { requestId });
      return { requestId, chunks: response.body };
    } catch (error) {
      throw mapClientError(error, { requestId });
    }
  }

  return Object.freeze({ request, openEventStream, retryPolicy: policy });
}
