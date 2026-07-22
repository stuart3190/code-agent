import crypto from "node:crypto";
import { decryptSecret, encryptSecret } from "./secretCrypto.mjs";
import { optionalEnv } from "./env.mjs";
import { auditEvent } from "./projectState.mjs";
import { getProjectSecret, setProjectSecret } from "./projectSecrets.mjs";

const ENVIRONMENT = "live";
const OWNER_TOKEN_SECRET = "CONNECTOR_META_ACCESS_TOKEN";
const META_SCOPES = [
  "public_profile", "pages_show_list", "pages_read_engagement", "pages_manage_posts",
  "ads_read", "ads_management",
];

function bad(message) {
  return Object.assign(new Error(message), { code: "bad_connector" });
}

export function metaGraphVersion() {
  const configured = String(optionalEnv("META_GRAPH_VERSION", "v24.0"));
  return /^v\d+\.\d+$/.test(configured) ? configured : "v24.0";
}

export function metaConfigured() {
  return !!(optionalEnv("META_APP_ID") && optionalEnv("META_APP_SECRET"));
}

export function metaOwnerRedirectUri() {
  return `${optionalEnv("APP_URL", "https://buildr101.com").replace(/\/$/, "")}/api/connectors/oauth/meta/callback`;
}

export function metaRuntimeRedirectUri() {
  return `${optionalEnv("APP_URL", "https://buildr101.com").replace(/\/$/, "")}/api/runtime/connectors/meta/callback`;
}

export function metaAuthorizationUrl(state, redirectUri) {
  const params = new URLSearchParams({ client_id: optionalEnv("META_APP_ID"), redirect_uri: redirectUri,
    response_type: "code", state, scope: META_SCOPES.join(",") });
  return `https://www.facebook.com/${metaGraphVersion()}/dialog/oauth?${params}`;
}

async function metaJson(path, { token, method = "GET", params = {}, body, timeout = 20_000 } = {}) {
  const url = new URL(`https://graph.facebook.com/${metaGraphVersion()}/${String(path).replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  if (token && optionalEnv("META_APP_SECRET")) {
    url.searchParams.set("appsecret_proof", crypto.createHmac("sha256", optionalEnv("META_APP_SECRET")).update(token).digest("hex"));
  }
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body instanceof URLSearchParams) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const response = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeout) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const message = String(data?.error?.message || `Meta returned ${response.status}`).replace(/(?:EA[A-Za-z0-9]+|EAA[A-Za-z0-9]+)/g, "[redacted]");
    throw new Error(message.slice(0, 400));
  }
  return data;
}

export async function exchangeMetaCode(code, redirectUri) {
  if (!metaConfigured()) throw bad("Meta is not configured on Buildr yet.");
  const short = await metaJson("oauth/access_token", { params: {
    client_id: optionalEnv("META_APP_ID"), client_secret: optionalEnv("META_APP_SECRET"),
    redirect_uri: redirectUri, code,
  } });
  if (!short.access_token) throw bad("Meta did not return an access token.");
  const long = await metaJson("oauth/access_token", { params: {
    grant_type: "fb_exchange_token", client_id: optionalEnv("META_APP_ID"),
    client_secret: optionalEnv("META_APP_SECRET"), fb_exchange_token: short.access_token,
  } }).catch(() => short);
  return { accessToken: long.access_token || short.access_token, expiresIn: Number(long.expires_in || short.expires_in || 5_184_000) };
}

export async function loadMetaAccounts(accessToken) {
  const [profile, pageData, adData] = await Promise.all([
    metaJson("me", { token: accessToken, params: { fields: "id,name" } }),
    metaJson("me/accounts", { token: accessToken, params: { fields: "id,name,tasks", limit: 100 } }),
    metaJson("me/adaccounts", { token: accessToken, params: { fields: "id,name,account_status,currency,timezone_name", limit: 100 } }),
  ]);
  const pages = (pageData.data || []).filter((item) => item?.id).map((item) => ({
    id: String(item.id), name: String(item.name || "Facebook Page").slice(0, 120), tasks: Array.isArray(item.tasks) ? item.tasks.slice(0, 20) : [],
  }));
  const adAccounts = (adData.data || []).filter((item) => item?.id).map((item) => ({
    id: String(item.id).replace(/^act_/, ""), name: String(item.name || "Meta ad account").slice(0, 120),
    status: Number(item.account_status || 0), currency: String(item.currency || ""), timezone: String(item.timezone_name || ""),
  }));
  return { profile: { id: String(profile.id || ""), name: String(profile.name || "Meta account").slice(0, 120) }, pages, adAccounts };
}

export async function metaPageToken(accessToken, pageId) {
  const data = await metaJson("me/accounts", { token: accessToken, params: { fields: "id,name,access_token,tasks", limit: 100 } });
  const page = (data.data || []).find((item) => String(item.id) === String(pageId));
  if (!page?.access_token) throw new Error("That Facebook Page is no longer available. Reconnect Meta and try again.");
  return { token: page.access_token, name: page.name || "Facebook Page" };
}

export async function beginMetaOwnerOAuth(ownerId, projectId, client) {
  if (!metaConfigured()) throw bad("Meta is not configured on Buildr yet.");
  const state = crypto.randomBytes(32).toString("base64url");
  const stateHash = crypto.createHash("sha256").update(state).digest("hex");
  const { error } = await client.from("connector_oauth_states").insert({
    state_hash: stateHash, owner: ownerId, project_id: projectId, provider: "meta",
    code_verifier_encrypted: encryptSecret(crypto.randomBytes(32).toString("base64url")),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) throw new Error(`Meta OAuth state: ${error.message}`);
  return { authorizationUrl: metaAuthorizationUrl(state, metaOwnerRedirectUri()), provider: "meta" };
}

export async function finishMetaOwnerOAuth(url, client) {
  const state = String(url.searchParams.get("state") || "");
  const code = String(url.searchParams.get("code") || "");
  const oauthError = String(url.searchParams.get("error_description") || url.searchParams.get("error") || "");
  if (!state) throw bad("The Meta connection state was missing.");
  const now = new Date().toISOString();
  const stateHash = crypto.createHash("sha256").update(state).digest("hex");
  const { data: oauthState, error } = await client.from("connector_oauth_states").update({ used_at: now })
    .eq("state_hash", stateHash).eq("provider", "meta").is("used_at", null).gt("expires_at", now)
    .select("owner,project_id").maybeSingle();
  if (error || !oauthState) throw bad("This Meta connection request expired or was already used.");
  if (oauthError) throw bad(`Meta connection was cancelled (${oauthError}).`);
  if (!code) throw bad("Meta did not return an authorization code.");
  const token = await exchangeMetaCode(code, metaOwnerRedirectUri());
  const accounts = await loadMetaAccounts(token.accessToken);
  if (!accounts.pages.length && !accounts.adAccounts.length) throw bad("Meta did not return any Pages or ad accounts this login can manage.");
  await setProjectSecret(oauthState.owner, oauthState.project_id, ENVIRONMENT, OWNER_TOKEN_SECRET, token.accessToken, client);
  const config = { account_id: accounts.profile.id, account_name: accounts.profile.name, pages: accounts.pages,
    ad_accounts: accounts.adAccounts, selected_page_id: accounts.pages[0]?.id || null,
    selected_ad_account_id: accounts.adAccounts[0]?.id || null,
    scopes: META_SCOPES, expires_at: new Date(Date.now() + token.expiresIn * 1000).toISOString(), readonly: false };
  const saved = await client.from("project_integrations").upsert({ owner: oauthState.owner, project_id: oauthState.project_id,
    provider: "meta", environment: ENVIRONMENT, status: "connected", config, last_error: null, updated_at: now,
  }, { onConflict: "project_id,environment,provider" });
  if (saved.error) throw new Error(`Meta connector save: ${saved.error.message}`);
  await auditEvent({ owner: oauthState.owner, projectId: oauthState.project_id, action: "connector.connected", target: "meta",
    metadata: { oauth: "meta", pages: accounts.pages.length, adAccounts: accounts.adAccounts.length } }, client).catch(() => {});
  return { provider: "meta", projectId: oauthState.project_id, accountName: accounts.profile.name };
}

export async function metaOwnerAccessToken(owner, projectId, client) {
  return getProjectSecret(owner, projectId, ENVIRONMENT, OWNER_TOKEN_SECRET, client);
}

export async function testMetaOwner(owner, projectId, config, client) {
  const token = await metaOwnerAccessToken(owner, projectId, client);
  if (!token) throw new Error("Reconnect Meta before testing it.");
  const accounts = await loadMetaAccounts(token);
  return { detail: `Meta connected: ${accounts.pages.length} Page${accounts.pages.length === 1 ? "" : "s"} and ${accounts.adAccounts.length} ad account${accounts.adAccounts.length === 1 ? "" : "s"}.`, accounts };
}

export async function metaRuntimeConnection(job, client) {
  if (job.app_user_id) {
    const { data, error } = await client.from("app_user_integrations").select("status,config,access_token_encrypted")
      .eq("project_id", job.project_id).eq("app_user_id", job.app_user_id).eq("provider", "meta").maybeSingle();
    if (error) throw new Error(`Meta connection: ${error.message}`);
    if (!data || data.status !== "connected") throw new Error("Connect a Meta account before publishing.");
    if (Date.parse(data.config?.expires_at || 0) <= Date.now() + 60_000) throw new Error("The Meta connection expired. Reconnect it and try again.");
    return { token: decryptSecret(data.access_token_encrypted), config: data.config || {} };
  }
  const { data } = await client.from("project_integrations").select("status,config").eq("owner", job.owner)
    .eq("project_id", job.project_id).eq("provider", "meta").eq("environment", ENVIRONMENT).maybeSingle();
  const token = await metaOwnerAccessToken(job.owner, job.project_id, client);
  if (!token || data?.status !== "connected") throw new Error("Connect the project to Meta before publishing.");
  return { token, config: data.config || {} };
}

export { metaJson };
