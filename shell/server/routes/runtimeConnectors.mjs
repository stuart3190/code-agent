import crypto from "node:crypto";
import { encryptSecret } from "../lib/secretCrypto.mjs";
import { exchangeMetaCode, loadMetaAccounts, metaAuthorizationUrl, metaConfigured, metaRuntimeRedirectUri } from "../lib/metaConnector.mjs";
import { ownerFromToken, serviceClient } from "../lib/supabase.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function originOwnsApp(client, appId, origin) {
  try {
    if (!origin?.startsWith("https://")) return false;
    const host = new URL(origin).hostname.toLowerCase();
    const { data: site } = await client.from("published_sites").select("slug").eq("project_id", appId).maybeSingle();
    if (site && host === `${site.slug}.app.buildr101.com`) return true;
    const { data: domain } = await client.from("custom_domains").select("domain").eq("project_id", appId)
      .eq("domain", host).not("verified_at", "is", null).maybeSingle();
    return !!domain;
  } catch { return false; }
}

async function runtimeActor(client, appId, accessToken) {
  if (!/^[0-9a-f-]{36}$/i.test(String(appId || ""))) return null;
  const user = await ownerFromToken(accessToken);
  if (!user) return null;
  const { data: mapping } = await client.from("app_users").select("status,email")
    .eq("app_id", appId).eq("auth_user_id", user.id).maybeSingle();
  return mapping?.status === "active" ? { user, mapping } : null;
}

function publicConfig(row) {
  const config = row?.config || {};
  return { available: metaConfigured(), connected: row?.status === "connected", status: row?.status || "disconnected",
    account: config.account || null, pages: config.pages || [], adAccounts: config.ad_accounts || [],
    selectedPageId: config.selected_page_id || null, selectedAdAccountId: config.selected_ad_account_id || null,
    expiresAt: config.expires_at || null, lastError: row?.last_error || null };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export async function handleRuntimeConnectors(req, res, body, accessToken, origin) {
  const appId = String(body?.appId || "");
  const action = String(body?.action || "overview");
  const client = serviceClient();
  if (!(await originOwnsApp(client, appId, origin))) return json(res, 403, { error: "This connection must start from the app's live domain." });
  const actor = await runtimeActor(client, appId, accessToken);
  if (!actor) return json(res, 401, { error: "Sign in to this app before connecting Meta." });
  const query = () => client.from("app_user_integrations").select("id,status,config,last_error,updated_at")
    .eq("project_id", appId).eq("app_user_id", actor.user.id).eq("provider", "meta").maybeSingle();
  if (action === "overview") return json(res, 200, publicConfig((await query()).data));
  if (action === "start") {
    if (!metaConfigured()) return json(res, 503, { error: "Meta connections are not enabled on Buildr yet." });
    const state = crypto.randomBytes(32).toString("base64url");
    const stateHash = crypto.createHash("sha256").update(state).digest("hex");
    const { error } = await client.from("app_connector_oauth_states").insert({ state_hash: stateHash, project_id: appId,
      app_user_id: actor.user.id, provider: "meta", return_origin: new URL(origin).origin,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
    if (error) throw new Error(`Runtime Meta OAuth state: ${error.message}`);
    return json(res, 200, { authorizationUrl: metaAuthorizationUrl(state, metaRuntimeRedirectUri()) });
  }
  if (action === "select") {
    const { data: row } = await query();
    if (!row || row.status !== "connected") return json(res, 409, { error: "Connect Meta before choosing accounts." });
    const pageId = body.pageId ? String(body.pageId) : row.config?.selected_page_id || null;
    const adAccountId = body.adAccountId ? String(body.adAccountId).replace(/^act_/, "") : row.config?.selected_ad_account_id || null;
    if (pageId && !(row.config?.pages || []).some((item) => item.id === pageId)) return json(res, 400, { error: "Choose a connected Facebook Page." });
    if (adAccountId && !(row.config?.ad_accounts || []).some((item) => item.id === adAccountId)) return json(res, 400, { error: "Choose a connected Meta ad account." });
    const config = { ...row.config, selected_page_id: pageId, selected_ad_account_id: adAccountId };
    const saved = await client.from("app_user_integrations").update({ config, updated_at: new Date().toISOString() }).eq("id", row.id);
    if (saved.error) throw new Error(`Meta account selection: ${saved.error.message}`);
    return json(res, 200, publicConfig({ ...row, config }));
  }
  if (action === "disconnect") {
    const removed = await client.from("app_user_integrations").delete().eq("project_id", appId)
      .eq("app_user_id", actor.user.id).eq("provider", "meta");
    if (removed.error) throw new Error(`Meta disconnect: ${removed.error.message}`);
    return json(res, 200, publicConfig(null));
  }
  return json(res, 400, { error: "Unknown connector action." });
}

function callbackPage(origin, payload) {
  const data = JSON.stringify({ __buildrRuntimeConnector: true, provider: "meta", ...payload }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Meta connection</title></head>
<body style="margin:0;background:#0b1020;color:#e2e8f0;font:15px system-ui;display:grid;min-height:100vh;place-items:center"><main style="max-width:420px;padding:32px;text-align:center">
<h1 style="font-size:20px">${payload.ok ? "Meta connected" : "Connection failed"}</h1><p style="color:#94a3b8">${payload.ok ? "You can close this window and return to the app." : escapeHtml(payload.error || "Return to the app and try again.")}</p></main>
<script>try{if(window.opener){window.opener.postMessage(${data},${JSON.stringify(origin)});setTimeout(()=>window.close(),250)}}catch(e){}</script></body></html>`;
}

export async function handleRuntimeMetaCallback(req, res, url) {
  const client = serviceClient();
  let origin = "https://buildr101.com";
  try {
    const state = String(url.searchParams.get("state") || "");
    const code = String(url.searchParams.get("code") || "");
    const oauthError = String(url.searchParams.get("error_description") || url.searchParams.get("error") || "");
    if (!state) throw new Error("The Meta connection state was missing.");
    const stateHash = crypto.createHash("sha256").update(state).digest("hex");
    const now = new Date().toISOString();
    const { data: oauthState, error } = await client.from("app_connector_oauth_states").update({ used_at: now })
      .eq("state_hash", stateHash).eq("provider", "meta").is("used_at", null).gt("expires_at", now)
      .select("project_id,app_user_id,return_origin").maybeSingle();
    if (error || !oauthState) throw new Error("This Meta connection request expired or was already used.");
    origin = oauthState.return_origin;
    if (oauthError) throw new Error(`Meta connection was cancelled (${oauthError}).`);
    if (!code) throw new Error("Meta did not return an authorization code.");
    const token = await exchangeMetaCode(code, metaRuntimeRedirectUri());
    const accounts = await loadMetaAccounts(token.accessToken);
    if (!accounts.pages.length && !accounts.adAccounts.length) throw new Error("Meta did not return any Pages or ad accounts this login can manage.");
    const config = { account: accounts.profile, pages: accounts.pages, ad_accounts: accounts.adAccounts,
      selected_page_id: accounts.pages[0]?.id || null, selected_ad_account_id: accounts.adAccounts[0]?.id || null,
      expires_at: new Date(Date.now() + token.expiresIn * 1000).toISOString() };
    const saved = await client.from("app_user_integrations").upsert({ project_id: oauthState.project_id, app_user_id: oauthState.app_user_id,
      provider: "meta", status: "connected", config, access_token_encrypted: encryptSecret(token.accessToken), last_error: null, updated_at: now,
    }, { onConflict: "project_id,app_user_id,provider" });
    if (saved.error) throw new Error(`Runtime Meta connector save: ${saved.error.message}`);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(callbackPage(origin, { ok: true }));
  } catch (error) {
    res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(callbackPage(origin, { ok: false, error: String(error.message || error).slice(0, 300) }));
  }
}
