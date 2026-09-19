// HTTP connectors module v1 — platform infrastructure, do not edit or reimplement.
//
// "Call this API" is the request that produced the worst generated code in the corpus (audit
// §7.1 "HTTP connectors"): a fetch with a key pasted into the source, no timeout, no retry, a
// response parsed as whatever shape the example showed, and an error surfaced as a stack trace.
//
// Four rules make it a module rather than a wrapper:
//
//   1. EGRESS IS DECLARED. A connector names the exact host it may reach. Anything else is
//      refused, so a prompt-injected or mistyped URL cannot exfiltrate to a host nobody approved,
//      and a private address is never reachable at all.
//   2. SECRETS ARE REFERENCES. A connector names the secret it needs; the value is supplied by
//      the deployment at call time and never enters a contract, a prompt, a log or an error.
//   3. RESPONSES ARE VALIDATED. A declared response shape is checked, so a provider changing its
//      payload is a named failure rather than `undefined` three screens later.
//   4. RETRIES ARE BOUNDED AND SAFE. Only idempotent methods retry, only on transient statuses,
//      with backoff and a ceiling. Retrying a POST is how one charge becomes three.
//
// Headless: functions only.

export const CONNECTORS_MODULE_VERSION = "1.0.0";

export const CONNECTOR_ERROR = Object.freeze({
  UNKNOWN: "connector_unknown",
  TARGET_DENIED: "connector_target_denied",
  SECRET_MISSING: "connector_secret_missing",
  INPUT_INVALID: "connector_input_invalid",
  RESPONSE_INVALID: "connector_response_invalid",
  UPSTREAM: "connector_upstream_error",
  TIMEOUT: "connector_timeout",
});

export class ConnectorError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const freeze = (value) => Object.freeze(value);
const listOf = (value) => (Array.isArray(value) ? value : []);
const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
// Addresses that are never a third-party API. A connector that can reach these can reach the
// deployment's own internals, which is the shape of every server-side request forgery.
const PRIVATE_HOST = /^(?:localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cd])/i;
// The whole token, not just its prefix: redacting "sk-" and leaving the rest is not redaction.
const SECRET_LIKE = /(?:sk-|r8_|ghp_|xox[baprs]-|AIza)[A-Za-z0-9._-]{8,}|Bearer\s+[A-Za-z0-9._-]{16,}/g;

/** Strip anything that looks like a credential from text that may be shown or logged. */
export function redactSecrets(text) {
  return String(text ?? "").replace(SECRET_LIKE, "[redacted]");
}

/**
 * Compile the declared connectors.
 *   connectors: [{ id, method, url, host?, secret?, inputs?, responseShape?, timeoutMs?, retries? }]
 */
export function compileConnectors(connectors = []) {
  const definitions = {};
  for (const row of listOf(connectors)) {
    const id = String(row?.id || "").trim();
    const url = String(row?.url || "").trim();
    if (!id || !url) continue;
    let host = row?.host ? String(row.host) : null;
    if (!host) {
      try { host = new URL(url.replace(/\{[^}]+\}/g, "x")).host; } catch { host = null; }
    }
    if (!host || PRIVATE_HOST.test(host)) {
      throw new ConnectorError(CONNECTOR_ERROR.TARGET_DENIED,
        `connector "${id}" targets ${host || "an unparseable host"}, which is not a permitted egress target`, { host });
    }
    const method = String(row?.method || "GET").toUpperCase();
    definitions[id] = freeze({
      id, url, host, method,
      secret: row?.secret ? String(row.secret) : null,
      inputs: freeze(listOf(row?.inputs).map(String)),
      required: freeze(listOf(row?.required ?? row?.inputs).map(String)),
      responseShape: row?.responseShape ? freeze({ ...row.responseShape }) : null,
      timeoutMs: Number(row?.timeoutMs) > 0 ? Number(row.timeoutMs) : 10_000,
      // A non-idempotent method never retries, whatever the declaration asks for: retrying a POST
      // is how one charge becomes three.
      retries: IDEMPOTENT.has(method) ? Math.min(3, Math.max(0, Number(row?.retries ?? 2))) : 0,
    });
  }
  return freeze({ version: CONNECTORS_MODULE_VERSION, definitions: freeze(definitions), ids: freeze(Object.keys(definitions)) });
}

/** Fill a declared URL template from the input, encoding every value. */
export function buildUrl(definition, input = {}) {
  const url = definition.url.replace(/\{(\w+)\}/g, (match, key) => encodeURIComponent(String(input?.[key] ?? "")));
  const parsed = new URL(url);
  if (parsed.host !== definition.host || PRIVATE_HOST.test(parsed.host)) {
    throw new ConnectorError(CONNECTOR_ERROR.TARGET_DENIED,
      `connector "${definition.id}" may only reach ${definition.host}`, { attempted: parsed.host, allowed: definition.host });
  }
  if (parsed.protocol !== "https:") {
    throw new ConnectorError(CONNECTOR_ERROR.TARGET_DENIED, `connector "${definition.id}" must use https`, { protocol: parsed.protocol });
  }
  return parsed.toString();
}

/** Check a response against the declared shape: { field: "string"|"number"|"boolean"|"array"|"object" }. */
export function validateResponse(definition, body) {
  if (!definition.responseShape) return { ok: true, problems: [] };
  const problems = [];
  for (const [field, expected] of Object.entries(definition.responseShape)) {
    const value = body?.[field];
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (value === undefined) problems.push(`${field} is missing`);
    else if (expected !== "any" && actual !== expected) problems.push(`${field} is ${actual}, expected ${expected}`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * @param {object} options
 * @param {object} options.schema compileConnectors() output
 * @param {(name: string) => Promise<string|null>} [options.secrets] resolves a secret REFERENCE.
 *   Values never enter a contract, a prompt or an error.
 * @param {Function} [options.fetchImpl]
 */
export function createConnectors({ schema, secrets = null, fetchImpl = globalThis.fetch, sleep = null } = {}) {
  if (!schema?.definitions) throw new ConnectorError(CONNECTOR_ERROR.UNKNOWN, "createConnectors needs compiled connectors");
  const pause = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  return {
    schema,
    definition: (id) => schema.definitions[id] || null,

    /** Call one declared connector. Every failure is a named code, never a stack trace. */
    async invoke(connectorId, input = {}, { signal = null } = {}) {
      const definition = schema.definitions[String(connectorId)];
      if (!definition) {
        throw new ConnectorError(CONNECTOR_ERROR.UNKNOWN, `no connector "${connectorId}" is declared`, { connectors: [...schema.ids] });
      }
      const missing = definition.required.filter((field) => input?.[field] === undefined || input?.[field] === null || String(input[field]).trim() === "");
      if (missing.length) {
        return { ok: false, code: CONNECTOR_ERROR.INPUT_INVALID, missing, connector: definition.id };
      }
      let url;
      try { url = buildUrl(definition, input); }
      catch (error) { return { ok: false, code: error.code, message: error.message, details: error.details || null, connector: definition.id }; }

      const headers = { Accept: "application/json" };
      if (definition.secret) {
        const value = secrets ? await secrets(definition.secret) : null;
        if (!value) {
          return { ok: false, code: CONNECTOR_ERROR.SECRET_MISSING, secret: definition.secret, connector: definition.id,
            message: `the ${definition.secret} secret is not configured for this deployment` };
        }
        headers.Authorization = `Bearer ${value}`;
      }
      const body = definition.method === "GET" || definition.method === "HEAD" ? undefined
        : JSON.stringify(Object.fromEntries(definition.inputs.map((field) => [field, input?.[field]]).filter(([, value]) => value !== undefined)));
      if (body) headers["Content-Type"] = "application/json";

      let attempt = 0;
      let lastStatus = null;
      while (attempt <= definition.retries) {
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), definition.timeoutMs) : null;
        try {
          const response = await fetchImpl(url, { method: definition.method, headers, body, signal: signal || controller?.signal });
          if (timer) clearTimeout(timer);
          lastStatus = response.status;
          if (!response.ok) {
            // Only a transient status is worth trying again. A 400 will be a 400 next time too.
            if (TRANSIENT.has(response.status) && attempt < definition.retries) {
              attempt += 1;
              await pause(Math.min(4000, 250 * (2 ** attempt)));
              continue;
            }
            const text = await response.text().catch(() => "");
            return { ok: false, code: CONNECTOR_ERROR.UPSTREAM, status: response.status, connector: definition.id,
              message: redactSecrets(text).slice(0, 300), attempts: attempt + 1 };
          }
          const payload = await response.json().catch(() => null);
          const shape = validateResponse(definition, payload);
          if (!shape.ok) {
            // A provider that changed its payload is a named failure here rather than `undefined`
            // three screens later.
            return { ok: false, code: CONNECTOR_ERROR.RESPONSE_INVALID, problems: shape.problems, connector: definition.id, attempts: attempt + 1 };
          }
          return { ok: true, data: payload, status: response.status, connector: definition.id, attempts: attempt + 1 };
        } catch (error) {
          if (timer) clearTimeout(timer);
          const aborted = String(error?.name || "") === "AbortError";
          if (attempt < definition.retries) {
            attempt += 1;
            await pause(Math.min(4000, 250 * (2 ** attempt)));
            continue;
          }
          return {
            ok: false, code: aborted ? CONNECTOR_ERROR.TIMEOUT : CONNECTOR_ERROR.UPSTREAM,
            connector: definition.id, attempts: attempt + 1, status: lastStatus,
            message: redactSecrets(error?.message || String(error)).slice(0, 300),
          };
        }
      }
      return { ok: false, code: CONNECTOR_ERROR.UPSTREAM, connector: definition.id, attempts: attempt + 1, status: lastStatus };
    },
  };
}
