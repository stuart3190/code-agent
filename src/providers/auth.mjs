// Auth helper — extracted from spike.mjs (the proven OAuth round-trip).
// Reads the existing `codex login` tokens, refreshes in-memory if near expiry.
// Codex-specific token plumbing lives here; never logged/echoed.

import { readFile } from "node:fs/promises";
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

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
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
  return json.access_token;
}

// Returns { accessToken, accountId }. Refreshes in-memory only (does not rewrite auth.json).
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
    accessToken = await refreshAccessToken(refreshToken);
    console.log("[auth] refreshed OK.");
  }
  return { accessToken, accountId };
}
