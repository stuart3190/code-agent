import { ThralloClientError } from "../errors.mjs";
import { constantTimeEqual } from "./pkce.mjs";

const ALLOWED_PARAMETERS = Object.freeze(new Set(["code", "state", "error", "error_description"]));
const VALUE_PATTERN = /^[A-Za-z0-9._~-]{8,512}$/;

function invalidCallback(message, code = "invalid_callback") {
  return new ThralloClientError(message, { code, retryable: false });
}

export function parseAuthCallback(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw invalidCallback("Malformed Thrallo authentication callback.");
  }
  if (url.protocol !== "thrallo:" || url.hostname !== "auth" || url.pathname !== "/callback") {
    throw invalidCallback("Unexpected Thrallo authentication callback destination.");
  }
  if (url.username || url.password || url.port || url.hash) throw invalidCallback("Authentication callback contains forbidden URL components.");
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_PARAMETERS.has(key)) throw invalidCallback("Authentication callback contains an unknown parameter.");
    if (url.searchParams.getAll(key).length !== 1) throw invalidCallback("Authentication callback contains a duplicate parameter.");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");
  if (!state || !VALUE_PATTERN.test(state)) throw invalidCallback("Authentication callback state is missing or malformed.");
  if ((code && error) || (!code && !error)) throw invalidCallback("Authentication callback must contain exactly one result.");
  if (code && !VALUE_PATTERN.test(code)) throw invalidCallback("Authentication callback code is malformed.");
  if (error && !/^[A-Za-z0-9._~-]{3,64}$/.test(error)) throw invalidCallback("Authentication callback error is malformed.");
  if (code && errorDescription) throw invalidCallback("Successful authentication callback contains an error description.");
  if (errorDescription && errorDescription.length > 256) throw invalidCallback("Authentication callback error description is too long.");
  return Object.freeze({ code, state, error, errorDescription });
}

export function correlateAuthCallback(callback, expectedState, { now = Date.now(), expiresAt = Infinity } = {}) {
  if (Number(now) > Number(expiresAt)) throw invalidCallback("Authentication authorization result expired.", "authorization_expired");
  if (!constantTimeEqual(callback.state, expectedState)) throw invalidCallback("Authentication callback correlation failed.", "state_mismatch");
  return callback;
}
