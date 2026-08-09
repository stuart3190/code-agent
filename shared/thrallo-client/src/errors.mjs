const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token|api[-_]?key|session|verifier|nonce|(?:access|refresh)[-_]?handle|authorization[-_]?code/i;
const SENSITIVE_TEXT = [
  /\bBearer\s+[^\s,;]+/gi,
  /\bthrallo_pat_[A-Za-z0-9._-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /([?&](?:code|state|nonce|code_verifier|refresh_handle|access_handle)=)[^&#\s]*/gi,
];

export function redactText(value) {
  let output = String(value ?? "");
  for (const pattern of SENSITIVE_TEXT) output = output.replace(pattern, "[REDACTED]");
  return output;
}

export function redact(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]));
  }
  return value;
}

export class ThralloClientError extends Error {
  constructor(message, { code = "client_error", status = null, retryable = false, requestId = null, details = null, cause } = {}) {
    super(redactText(message || "Thrallo client error"), cause ? { cause } : undefined);
    this.name = "ThralloClientError";
    this.code = code;
    this.status = status;
    this.retryable = retryable === true;
    this.requestId = requestId;
    this.details = details == null ? null : redact(details);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      retryable: this.retryable,
      requestId: this.requestId,
      details: this.details,
    };
  }
}

export class CapabilityUnavailableError extends ThralloClientError {
  constructor({ capability = null, operationId = null, requestId = null } = {}) {
    super(`${operationId || "operation"} requires unavailable capability ${capability || "unknown"}.`, {
      code: "capability_unavailable",
      retryable: false,
      requestId,
      details: { capability, operationId },
    });
    this.name = "CapabilityUnavailableError";
  }
}

export class AuthenticationExpiredError extends ThralloClientError {
  constructor(options = {}) {
    super("The Thrallo session has expired.", { ...options, code: "authentication_expired", status: 401, retryable: false });
    this.name = "AuthenticationExpiredError";
  }
}

export class OfflineError extends ThralloClientError {
  constructor(message = "Thrallo is offline.", options = {}) {
    super(message, { ...options, code: "offline", retryable: true });
    this.name = "OfflineError";
  }
}

export class ConflictError extends ThralloClientError {
  constructor(message = "The project changed from the expected base revision.", options = {}) {
    super(message, { ...options, code: "conflict", status: options.status ?? 409, retryable: false });
    this.name = "ConflictError";
  }
}

export class CancelledError extends ThralloClientError {
  constructor(options = {}) {
    super("The operation was cancelled.", { ...options, code: "cancelled", retryable: false });
    this.name = "CancelledError";
  }
}

export function mapClientError(error, { status = null, payload = null, requestId = null } = {}) {
  if (error instanceof ThralloClientError) return error;
  const code = payload?.code || payload?.error?.code || null;
  const message = payload?.message || payload?.error?.message || error?.message || `Thrallo request failed${status ? ` (${status})` : ""}.`;
  if (status === 401 || code === "authentication_expired" || code === "invalid_token") {
    return new AuthenticationExpiredError({ requestId, details: payload });
  }
  if (status === 409 || status === 412 || code === "conflict" || code === "base_snapshot_conflict") {
    return new ConflictError(redactText(message), { status, requestId, details: payload });
  }
  if (error?.name === "AbortError" || code === "cancelled") return new CancelledError({ requestId });
  const retryable = error instanceof TypeError || [408, 429, 502, 503, 504].includes(status) || payload?.retryable === true;
  return new ThralloClientError(message, {
    code: code || (error instanceof TypeError ? "offline" : "request_failed"),
    status,
    retryable,
    requestId,
    details: payload,
    cause: error,
  });
}
