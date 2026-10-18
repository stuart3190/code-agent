"use strict";
const { createHash } = require("node:crypto");
const DEFAULT_SERVER = "https://app.thrallo.com";
const LEGACY_TOKEN_KEY = "thrallo.apiToken";

function normaliseServerOrigin(value) {
  let url;
  try { url = new URL(String(value || DEFAULT_SERVER)); }
  catch { throw new Error("Server URL must use https (http is allowed only for loopback development)."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback))
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Server URL must be an https origin without credentials, path, query or fragment (http is allowed only for loopback development).");
  }
  return url.origin;
}
function configuredServerOrigin(configuration) {
  // Repository settings are untrusted input, including in an otherwise trusted workspace.
  // Never use get(), whose effective value can come from .vscode/settings.json.
  const inspected = configuration.inspect("serverUrl");
  return normaliseServerOrigin(inspected?.globalValue ?? DEFAULT_SERVER);
}
const tokenKey = origin => `${LEGACY_TOKEN_KEY}:${normaliseServerOrigin(origin)}`;
async function readTokenForOrigin(secrets, origin) {
  const canonical = normaliseServerOrigin(origin);
  return (await secrets.get(tokenKey(canonical)))
    || (canonical === DEFAULT_SERVER ? await secrets.get(LEGACY_TOKEN_KEY) : undefined);
}
async function storeTokenForOrigin(secrets, origin, token) {
  await secrets.store(tokenKey(origin), token);
}
async function deleteTokenForOrigin(secrets, origin) {
  const canonical = normaliseServerOrigin(origin);
  await secrets.delete(tokenKey(canonical));
  if (canonical === DEFAULT_SERVER) await secrets.delete(LEGACY_TOKEN_KEY);
}
function connectionStateKey(origin, token) {
  return `${normaliseServerOrigin(origin)}:${token ? createHash("sha256").update(token).digest("hex") : "disconnected"}`;
}
module.exports = { DEFAULT_SERVER, normaliseServerOrigin, configuredServerOrigin,
  readTokenForOrigin, storeTokenForOrigin, deleteTokenForOrigin, connectionStateKey };
