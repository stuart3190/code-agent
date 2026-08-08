// Auth helper — extracted from spike.mjs (the proven OAuth round-trip).
// Reads the existing `codex login` tokens and refreshes near expiry. Refreshes PERSIST back to
// auth.json (2026-07-16): OpenAI rotates the refresh_token on every refresh, and the pre-fix
// in-memory-only version threw the rotated token away — so the server refreshed off the ORIGINAL
// login's refresh token forever, which aged out after an idle week and 401'd until a manual
// `codex login`. Persisting the rotation keeps the chain alive indefinitely; the VPS keep-alive
// timer (scripts/codex-keepalive.mjs) forces one refresh a day so idle periods can't starve it.
// Codex-specific token plumbing lives here; never logged/echoed.

import { readFile, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"; // official Codex CLI public client
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const EXPIRY_SKEW_S = 120; // refresh if the access token expires within this window

function jwtExp(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

async function refreshTokens(refreshToken, fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      scope: "openid profile email offline_access",
    }),
  });
  if (!res.ok) {
    throw new Error(`token refresh failed: HTTP ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("token refresh returned no access_token");
  return json; // { access_token, refresh_token? (rotated), id_token?, ... }
}

/**
 * Token provider for encrypted, owner-scoped Codex auth stored outside the filesystem.
 * The caller owns persistence so a rotated refresh token can be written back to the
 * canonical credential store. Secret values are never logged.
 */
export function createStoredAccessTokenProvider({
  loadAuth, persistAuth = async () => {}, fetchImpl = fetch, now = () => Date.now(),
} = {}) {
  if (typeof loadAuth !== "function") throw new Error("stored Codex auth needs a loader");
  let refreshing = null;
  const read = async () => {
    const value = await loadAuth();
    const auth = typeof value === "string" ? JSON.parse(value) : structuredClone(value);
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error("stored Codex auth is invalid");
    return auth;
  };
  return async () => {
    let auth = await read();
    let accessToken = auth.tokens?.access_token;
    const accountId = auth.tokens?.account_id;
    if (!accessToken || !accountId) throw new Error("stored Codex auth is missing access_token / account_id");
    const exp = jwtExp(accessToken);
    if (exp && exp - Math.floor(now() / 1000) <= EXPIRY_SKEW_S) {
      if (!auth.tokens?.refresh_token) throw new Error("stored Codex access token expired without a refresh token");
      refreshing ||= (async () => {
        // Reload inside the single-flight section: another call may already have persisted a
        // rotated token while this caller was waiting.
        const current = await read();
        const currentAccess = current.tokens?.access_token;
        const currentExp = jwtExp(currentAccess);
        if (!currentAccess || !current.tokens?.account_id) throw new Error("stored Codex auth is incomplete");
        if (!currentExp || currentExp - Math.floor(now() / 1000) > EXPIRY_SKEW_S) return current;
        if (!current.tokens?.refresh_token) throw new Error("stored Codex access token expired without a refresh token");
        const fresh = await refreshTokens(current.tokens.refresh_token, fetchImpl);
        current.tokens.access_token = fresh.access_token;
        if (fresh.refresh_token) current.tokens.refresh_token = fresh.refresh_token;
        if (fresh.id_token) current.tokens.id_token = fresh.id_token;
        current.last_refresh = new Date(now()).toISOString();
        await persistAuth(current);
        return current;
      })().finally(() => { refreshing = null; });
      auth = await refreshing;
      accessToken = auth.tokens.access_token;
    }
    return { accessToken, accountId: auth.tokens.account_id };
  };
}

// Fold a refresh response into the auth blob and write it back ATOMICALLY (tmp + rename), so a
// crash mid-write can't corrupt the only copy of the tokens.
async function persistRefresh(auth, fresh) {
  auth.tokens.access_token = fresh.access_token;
  if (fresh.refresh_token) auth.tokens.refresh_token = fresh.refresh_token;
  if (fresh.id_token) auth.tokens.id_token = fresh.id_token;
  auth.last_refresh = new Date().toISOString();
  const tmp = `${AUTH_PATH}.tmp`;
  await writeFile(tmp, JSON.stringify(auth, null, 2), "utf8");
  await rename(tmp, AUTH_PATH);
}

// Returns { accessToken, accountId }. Refreshes near expiry and persists the rotation.
export async function getAccessToken() {
  const auth = JSON.parse(await readFile(AUTH_PATH, "utf8"));
  if (auth.auth_mode !== "chatgpt") {
    console.warn(`WARNING: auth_mode is "${auth.auth_mode}", expected "chatgpt" (sub OAuth).`);
  }
  const accountId = auth.tokens?.account_id;
  let accessToken = auth.tokens?.access_token;
  const refreshToken = auth.tokens?.refresh_token;
  if (!accessToken || !accountId) throw new Error("auth.json missing access_token / account_id");

  const now = Math.floor(Date.now() / 1000);
  const exp = jwtExp(accessToken);
  if (exp && exp - now <= EXPIRY_SKEW_S) {
    if (!refreshToken) throw new Error("access token expired and no refresh_token present");
    console.log(`[auth] access token within ${EXPIRY_SKEW_S}s of expiry — refreshing...`);
    const fresh = await refreshTokens(refreshToken);
    accessToken = fresh.access_token;
    // Persistence failure must not fail the turn — but say so loudly, it means rot is coming back.
    await persistRefresh(auth, fresh).catch((e) =>
      console.warn(`[auth] WARNING: refreshed OK but could NOT persist rotated tokens: ${e.message}`));
    console.log("[auth] refreshed OK (rotation persisted).");
  }
  return { accessToken, accountId };
}

// Unconditional refresh + persist — the keep-alive path. Returns the new access token's expiry
// so callers can log how much runway the chain has.
export async function forceRefresh() {
  const auth = JSON.parse(await readFile(AUTH_PATH, "utf8"));
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) throw new Error("auth.json has no refresh_token — run `codex login`");
  const fresh = await refreshTokens(refreshToken);
  await persistRefresh(auth, fresh);
  return { expiresAt: new Date(jwtExp(fresh.access_token) * 1000).toISOString(), rotated: !!fresh.refresh_token };
}
