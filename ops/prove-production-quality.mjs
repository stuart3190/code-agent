// Production-quality proof: the audit's findings, checked against the deployed system.
//
// Everything here was found by auditing rather than by using the product. The distinction matters
// because each one passed every feature test that existed: the feature worked, and then a provider
// went quiet, a table grew past a page, or an operator read a health endpoint.
//
// Deliberately NOT proved here, and not faked:
//   - GeoLite2 country analytics. No licence key exists; the product says countries are
//     unavailable and this proof asserts that it says so, which is the only honest check.
//   - A real Starter checkout, its webhook and the subscription that follows. That needs a real
//     card. Configuration is proved; the payment is not, and a PASS here would be a lie.

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { thralloStripeConfigured, thralloWebhookConfigured, stripeConfigMistake } from "../shell/server/lib/subscriptionBilling.mjs";
import { allowedOrigins } from "../shell/server/lib/httpSecurity.mjs";
import { optionalEnv } from "../shell/server/lib/env.mjs";

const BASE = process.env.THRALLO_BASE_URL || "https://app.thrallo.com";
const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const db = serviceClient();
const get = async (path, init = {}) => {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual", ...init });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, headers: response.headers, text, json };
};

// ── Health tells the truth about THIS product ───────────────────────────────────────────
{
  const health = await get("/api/health");
  check(health.status === 200, "the health endpoint answers", String(health.status));
  check(health.json?.supabase === true, "and reports the database", String(health.json?.supabase));

  // It read haveStripeEnv(), which checks the LEGACY Buildr101 variables — so production served
  // `"stripe": false` while Thrallo billing was fully configured and live.
  check(health.json?.stripe === thralloStripeConfigured(),
    "the Stripe signal matches Thrallo's own configuration",
    `endpoint ${health.json?.stripe} vs thrallo ${thralloStripeConfigured()}`);
  check(health.json?.stripe === true,
    "and Thrallo's Stripe really is configured, so this is not a vacuous match");
  check(typeof health.json?.stripeWebhook === "boolean",
    "webhook configuration is reported separately from checkout",
    String(health.json?.stripeWebhook));
  check(health.json?.stripeWebhook === thralloWebhookConfigured(), "and matches");
  check(stripeConfigMistake() === null,
    "no legacy-variable misconfiguration", stripeConfigMistake() || "clean");
}

// ── CORS trusts only this product ───────────────────────────────────────────────────────
{
  // Production was verified answering `Access-Control-Allow-Origin: https://buildr101.com`.
  for (const origin of ["https://buildr101.com", "https://www.buildr101.com", "http://localhost:5173", "https://evil.example"]) {
    const response = await get("/api/v1/settings", {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
    });
    const allowed = response.headers.get("access-control-allow-origin");
    check(allowed !== origin, `${origin} is not granted cross-origin access`, allowed || "no header");
  }
  const own = await get("/api/v1/settings", {
    method: "OPTIONS",
    headers: { Origin: BASE, "Access-Control-Request-Method": "GET" },
  });
  check(own.headers.get("access-control-allow-origin") === BASE,
    "while this product's own origin still is", own.headers.get("access-control-allow-origin") || "none");

  const configured = allowedOrigins(optionalEnv("APP_URL", "http://localhost:5173"));
  check(!configured.has("https://buildr101.com"), "and the allowlist itself holds no other product");
}

// ── Security headers ────────────────────────────────────────────────────────────────────
{
  const page = await get("/");
  const csp = page.headers.get("content-security-policy") || "";
  check(/frame-ancestors 'none'/.test(csp), "the app cannot be framed");
  check(/object-src 'none'/.test(csp), "plugins are refused");
  check(/form-action 'self' https:\/\/checkout\.stripe\.com/.test(csp), "forms post only to us and Stripe");
  check(page.headers.get("x-content-type-options") === "nosniff", "content types are not sniffed");
  check(page.headers.get("x-frame-options") === "DENY", "and the legacy header agrees");
  check(/max-age=\d+/.test(page.headers.get("strict-transport-security") || ""), "HSTS is set");

  // preview.buildr101.com stays in frame-src because provisiond really serves previews there.
  // Asserted so its removal is a decision, not an accident.
  check(/frame-src[^;]*preview\.buildr101\.com/.test(csp),
    "the preview origin production actually uses is still permitted");
}

// ── Path traversal ──────────────────────────────────────────────────────────────────────
for (const attempt of [
  "/../../../../etc/passwd",
  "/assets/../../shell/.env",
  "/%2e%2e%2f%2e%2e%2fshell/.env",
  "/..%5c..%5cshell%5c.env",
]) {
  const response = await get(attempt);
  const leaked = /SUPABASE_SERVICE_ROLE|STRIPE_SECRET|ANTHROPIC_API_KEY/.test(response.text);
  check(!leaked, `no secret is served for ${attempt}`, String(response.status));
}

// ── Every mutating endpoint refuses an anonymous caller ─────────────────────────────────
{
  const PROJECT = "00000000-0000-4000-8000-000000000001";
  const guarded = [
    ["GET", "/api/v1/settings"], ["GET", "/api/v1/conversations"], ["GET", "/api/v1/usage"],
    ["GET", "/api/v1/billing"], ["GET", "/api/v1/tokens"], ["GET", "/api/v1/notifications"],
    ["POST", "/api/v1/conversations/bulk"], ["POST", "/api/v1/notifications/read"],
    ["POST", "/api/v1/billing/cancel"], ["POST", "/api/v1/billing/portal"],
    ["GET", `/api/v1/projects/${PROJECT}/analytics`], ["GET", `/api/v1/projects/${PROJECT}/logs`],
    ["GET", `/api/v1/projects/${PROJECT}/deployments`], ["GET", `/api/v1/projects/${PROJECT}/health`],
    ["GET", `/api/v1/projects/${PROJECT}/domains`], ["POST", "/api/export"],
  ];
  let refused = 0;
  for (const [method, path] of guarded) {
    const response = await get(path, {
      method,
      ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
    });
    if (response.status === 401) refused += 1;
    else check(false, `${method} ${path} refuses anonymous access`, String(response.status));
  }
  check(refused === guarded.length, `every guarded endpoint refuses anonymous access`, `${refused}/${guarded.length}`);
}

// ── A stuck build reaches a terminal state ──────────────────────────────────────────────
{
  // The boot sweeps sat behind `if (!CODE_AGENT_STANDALONE)` and production runs with it ON, so
  // the sweep whose purpose is "no build shows building forever" never ran. Five jobs were found
  // stuck in queued/running for eleven and thirteen hours.
  const { data, error } = await db.from("build_jobs")
    .select("id,status,created_at").in("status", ["queued", "running"]);
  check(!error, "build jobs are readable", error?.message || "ok");
  const stale = (data || []).filter((r) => Date.now() - Date.parse(r.created_at) > 90 * 60_000);
  check(stale.length === 0,
    "no build has been left non-terminal past the stale window",
    `${stale.length} stale of ${(data || []).length} non-terminal`);
}

// ── Notification history exists and is Thrallo's own ────────────────────────────────────
{
  const { error } = await db.from("ca_notifications").select("id").limit(1);
  check(!error, "the account notification history is readable", error?.message || "ok");
  const { error: appError } = await db.from("app_notifications").select("id").limit(1);
  check(!appError, "and the apps' own stream is a separate table", appError?.message || "ok");
}

// ── The counts Settings shows are really available ──────────────────────────────────────
{
  // `published_sites.live` does not exist; filtering on it threw, the catch turned it into
  // `counts: null`, and every customer's Usage tab read "temporarily unavailable".
  const { error } = await db.from("published_sites")
    .select("id", { count: "exact", head: true }).is("unpublished_at", null);
  check(!error, "live sites can be counted the way Settings counts them", error?.message || "ok");
  const { error: badError } = await db.from("published_sites")
    .select("id", { count: "exact", head: true }).eq("live", true);
  check(!!badError, "and the column it used to filter on genuinely does not exist",
    badError ? "rejected as expected" : "UNEXPECTEDLY ACCEPTED");
}

// ── Claims match behaviour ──────────────────────────────────────────────────────────────
//
// Read across the main bundle AND every split chunk. Checking only the main bundle would report a
// missing sentence for every string that lives in a lazily-loaded tab — which, since the tabs were
// split, is most of the customer-facing copy in the product.
{
  const index = await get("/");
  const main = index.text.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
  const mainBundle = (await get(main)).text;
  const chunkNames = [...mainBundle.matchAll(/["'`]\.\/([\w.-]*-[\w-]{6,}\.js)["'`]/g)].map((m) => m[1]);
  const chunks = await Promise.all([...new Set(chunkNames)].map((name) => get(`/assets/${name}`)));
  const client = [mainBundle, ...chunks.map((c) => c.text)].join("\n");
  check(chunkNames.length > 0, "the client is code-split", `${new Set(chunkNames).size} chunk(s)`);

  check(!/faster builds/i.test(client),
    "the deployed client does not promise faster builds on a paid plan");
  check(/does not meter storage/.test(client),
    "and says plainly that storage is not metered");
  // Countries stay unavailable until a GeoLite2 licence exists. The honest check is that the
  // product SAYS so rather than inferring a country from a language header.
  check(/Countries/.test(client), "the analytics view still has a countries section");
  check(/unavailable|not available/i.test(client),
    "which states unavailability rather than guessing");
  // Asserted positively. A "must not contain 'guessed from'" check matched the product's own
  // disclaimer — "deliberately not guessed from browser language or timezone" — and reported the
  // right behaviour as a failure.
  check(/not guessed from browser language or timezone/i.test(client),
    "and states that it is not inferred from language or timezone");
  check(/GeoLite2/i.test(client), "naming what it is waiting for");

  // The server emitted `lead_recovered` and nothing in the client handled it, so a recovered
  // conversation kept showing "Understanding request…" indefinitely.
  check(client.includes("lead_recovered"),
    "the deployed client handles the recovery event the server sends");
  check(/train of thought/.test(client), "and has a sentence for it");
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
