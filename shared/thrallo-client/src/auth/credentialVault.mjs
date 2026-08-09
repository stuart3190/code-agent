import { ThralloClientError, redact } from "../errors.mjs";

const IDENTIFIER = /^[A-Za-z0-9._:@-]{1,128}$/;

function normalizeScope(scope) {
  const normalized = {
    accountId: String(scope?.accountId || ""),
    deviceId: String(scope?.deviceId || ""),
    kind: String(scope?.kind || "device-session"),
  };
  for (const [key, value] of Object.entries(normalized)) {
    if (!IDENTIFIER.test(value)) throw new TypeError(`Credential vault ${key} is invalid`);
  }
  return Object.freeze(normalized);
}

function vaultKey(prefix, scope) {
  const normalized = normalizeScope(scope);
  return `${prefix}:${encodeURIComponent(normalized.accountId)}:${encodeURIComponent(normalized.deviceId)}:${encodeURIComponent(normalized.kind)}`;
}

function vaultError(error, operation) {
  if (error instanceof ThralloClientError) return error;
  return new ThralloClientError(`Secure credential ${operation} failed.`, {
    code: "credential_store_failure",
    retryable: false,
    cause: error,
  });
}

function decodeRecord(raw) {
  if (raw == null) return null;
  const record = JSON.parse(raw);
  if (!record || !Number.isInteger(record.revision) || record.revision < 1 || !("value" in record)) {
    throw new TypeError("Invalid secure credential record");
  }
  return record;
}

export function createNativeCredentialVault({ secretStorage, keyPrefix = "thrallo.native-auth.v1" } = {}) {
  if (!secretStorage || typeof secretStorage.get !== "function" || typeof secretStorage.store !== "function" || typeof secretStorage.delete !== "function") {
    throw new TypeError("A native SecretStorage-compatible secure store is required");
  }

  async function retrieve(scope) {
    try {
      const record = decodeRecord(await secretStorage.get(vaultKey(keyPrefix, scope)));
      return record ? Object.freeze({ value: record.value, revision: record.revision }) : null;
    } catch (error) {
      throw vaultError(error, "retrieve");
    }
  }

  async function store(scope, value) {
    const key = vaultKey(keyPrefix, scope);
    try {
      if (await secretStorage.get(key) != null) throw new ThralloClientError("Secure credential already exists.", { code: "credential_conflict" });
      await secretStorage.store(key, JSON.stringify({ revision: 1, value }));
      return Object.freeze({ revision: 1 });
    } catch (error) {
      throw vaultError(error, "store");
    }
  }

  async function replace(scope, value, { expectedRevision } = {}) {
    const key = vaultKey(keyPrefix, scope);
    try {
      const current = decodeRecord(await secretStorage.get(key));
      if (!current || current.revision !== expectedRevision) {
        throw new ThralloClientError("Secure credential revision changed.", { code: "credential_conflict" });
      }
      const revision = current.revision + 1;
      await secretStorage.store(key, JSON.stringify({ revision, value }));
      return Object.freeze({ revision });
    } catch (error) {
      throw vaultError(error, "replace");
    }
  }

  async function remove(scope) {
    try {
      await secretStorage.delete(vaultKey(keyPrefix, scope));
      return Object.freeze({ deleted: true });
    } catch (error) {
      throw vaultError(error, "delete");
    }
  }

  return Object.freeze({ kind: "native-secure-store", persistent: true, store, retrieve, replace, delete: remove });
}

export function createDevelopmentCredentialVault({ failOperations = [] } = {}) {
  const records = new Map();
  const calls = [];
  const failures = new Set(failOperations);
  let sequence = 0;

  function record(operation, scope, outcome, revision = null) {
    sequence += 1;
    calls.push(Object.freeze({ sequence, operation, scope: normalizeScope(scope), outcome, revision }));
  }

  function failIfRequested(operation, scope) {
    if (!failures.has(operation)) return;
    record(operation, scope, "failure");
    throw new ThralloClientError(`Deterministic secure credential ${operation} failure.`, { code: "credential_store_failure" });
  }

  async function retrieve(scope) {
    failIfRequested("retrieve", scope);
    const key = vaultKey("fixture", scope);
    const current = records.get(key) || null;
    record("retrieve", scope, current ? "found" : "missing", current?.revision ?? null);
    return current ? Object.freeze({ value: structuredClone(current.value), revision: current.revision }) : null;
  }

  async function store(scope, value) {
    failIfRequested("store", scope);
    const key = vaultKey("fixture", scope);
    if (records.has(key)) throw new ThralloClientError("Secure credential already exists.", { code: "credential_conflict" });
    records.set(key, { value: structuredClone(value), revision: 1 });
    record("store", scope, "stored", 1);
    return Object.freeze({ revision: 1 });
  }

  async function replace(scope, value, { expectedRevision } = {}) {
    failIfRequested("replace", scope);
    const key = vaultKey("fixture", scope);
    const current = records.get(key);
    if (!current || current.revision !== expectedRevision) throw new ThralloClientError("Secure credential revision changed.", { code: "credential_conflict" });
    const revision = current.revision + 1;
    records.set(key, { value: structuredClone(value), revision });
    record("replace", scope, "replaced", revision);
    return Object.freeze({ revision });
  }

  async function remove(scope) {
    failIfRequested("delete", scope);
    const deleted = records.delete(vaultKey("fixture", scope));
    record("delete", scope, deleted ? "deleted" : "missing");
    return Object.freeze({ deleted });
  }

  return Object.freeze({
    kind: "deterministic-development-store",
    persistent: false,
    store,
    retrieve,
    replace,
    delete: remove,
    getCalls: () => Object.freeze(calls.map((call) => redact(call))),
    inspectKeys: () => Object.freeze([...records.keys()].sort()),
    setFailure: (operation, enabled = true) => enabled ? failures.add(operation) : failures.delete(operation),
  });
}
