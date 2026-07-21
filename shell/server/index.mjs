// The shell's thin Node server (pure http, no framework). It exists ONLY where a secret or the
// local engine is required: generation (Codex + engine), ledger debit (service role), Stripe, and
// the preview seam. Auth + project persistence live client-side on the backend SDK (RLS-scoped).
//
//   GET  /api/health                      liveness + which capabilities are env-configured
//   GET  /api/config                      public pricing/config, sourced from costModel (no hardcoding)
//   POST /api/generate      (auth, SSE)   the gated engine call + live ledger debit
//   POST /api/preview       (auth)        (re)start a live preview for a saved tree (no Codex spend)
//   POST /api/export        (auth)        download a ready-to-run project ZIP
//   POST /api/billing/checkout (auth)     Stripe Checkout (subscription tier | top-up)
//   GET  /api/billing/balance  (auth)     server-side balance read (convenience; UI reads via RLS too)
//   POST /api/stripe/webhook              Stripe events -> proven handler (raw body, signature-verified)

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadEnv, optionalEnv, SHELL_DIR } from "./lib/env.mjs";
import { resolveStaticPath } from "./lib/staticPath.mjs";
import {
  BODY_LIMITS, HttpInputError, allowedOrigins, applyCors, applySecurityHeaders,
  createRateLimiter, parseJson, readBody, staticCacheControl,
} from "./lib/httpSecurity.mjs";
import { ownerFromToken, bearer, haveSupabaseEnv, serviceClient } from "./lib/supabase.mjs";
import { haveStripeEnv } from "./lib/services.mjs";
import { handleGenerate } from "./routes/generate.mjs";
import { handleBuildEvents, handleActiveBuild, handleBuildCancel } from "./routes/builds.mjs";
import { interruptLiveJobs, sweepInterrupted, sweepStaleJobs } from "./lib/buildJobs.mjs";
import { handleCheckout, handleBalance, handleSubscription, handleSwitch, handleCancel } from "./routes/billing.mjs";
import { handleWebhook } from "./routes/stripeWebhook.mjs";
import { handlePreview } from "./routes/preview.mjs";
import { handleExport } from "./routes/export.mjs";
import { handlePublish, handleUnpublish } from "./routes/publish.mjs";
import { handleAndroid } from "./routes/android.mjs";
import { handleDomainCheck, handleDomainList, handleDomainConnect, handleDomainRemove } from "./routes/domains.mjs";
import { handleProjectDelete } from "./routes/projects.mjs";
import { handleAccountDelete } from "./routes/account.mjs";
import { handleByokGet, handleByokSave, handleByokClear } from "./routes/settings.mjs";
import { handleFeatures } from "./routes/features.mjs";
import { handleProjectEnvironments, handleProjectReleases, handleProjectSecrets } from "./routes/foundation.mjs";
import { handleQaArtifact, handleQaGet, handleQaList, handleQaStart } from "./routes/qa.mjs";
import { sweepQaRuns } from "./lib/qaRuns.mjs";
import { handlePaymentOverview, handlePaymentProducts, handleStripeOnboarding } from "./routes/saasPayments.mjs";
import { handleConnectWebhook } from "./routes/connectWebhook.mjs";
import { byokConfigured } from "./lib/byokStore.mjs";
import { TIERS, TOPUP_GBP_PER_CREDIT, WELCOME_CREDITS, effectiveGbpPerCredit, trueCostPerCredit } from "../../src/billing/costModel.mjs";
import { TOKENS_PER_CREDIT } from "../../src/cost.mjs";

loadEnv();
const PORT = Number(optionalEnv("SHELL_PORT", "8787"));
// Bind address. Default (unset) = all interfaces, the local-dev behavior. In production on the
// VPS this is set to the docker proxy-net gateway (10.83.7.1) so Caddy can reverse-proxy to the
// shell while the port stays unreachable from the public internet.
const HOST = optionalEnv("SHELL_HOST", "") || undefined;
const WEB_DIST = path.join(SHELL_DIR, "web", "dist");
const CORS_ORIGINS = allowedOrigins(optionalEnv("APP_URL", "https://buildr101.com"));
CORS_ORIGINS.add(`http://127.0.0.1:${PORT}`);
CORS_ORIGINS.add(`http://localhost:${PORT}`);
const consumeRate = createRateLimiter();

const readJson = async (req, limit = BODY_LIMITS.standard) => parseJson(await readBody(req, limit));

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

function ratePolicy(pathname, method) {
  if (pathname === "/api/domain-check") return { limit: 120, windowMs: 60_000 };
  if (pathname === "/api/generate") return { limit: 40, windowMs: 10 * 60_000 };
  if (pathname === "/api/preview") return { limit: 60, windowMs: 5 * 60_000 };
  if (["/api/publish", "/api/unpublish", "/api/android"].includes(pathname)) {
    return { limit: 15, windowMs: 10 * 60_000 };
  }
  if (method === "POST" || method === "DELETE") return { limit: 120, windowMs: 60_000 };
  return null;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function publicConfig() {
  return {
    tokensPerCredit: TOKENS_PER_CREDIT,
    floorGbpPerCredit: trueCostPerCredit(),
    topupGbpPerCredit: TOPUP_GBP_PER_CREDIT,
    welcomeCredits: WELCOME_CREDITS,
    tiers: TIERS.map((t) => ({
      id: t.id, name: t.name, gbpPerMonth: t.gbpPerMonth, bundledCredits: t.bundledCredits,
      managed: t.managed, effectiveGbpPerCredit: effectiveGbpPerCredit(t),
      freePreviewSlots: t.freePreviewSlots ?? null, note: t.note ?? null,
    })),
    modes: [
      { id: "byok", name: "BYOK", blurb: "Bring your own API key — inference on your key, £0 platform lane (3 preview slots)." },
      { id: "managed", name: "Managed credits", blurb: "We supply inference; buy a tier or top-up. Credits meter your building." },
      { id: "chatgpt", name: "ChatGPT sub (OAuth)", blurb: "Generation runs on the connected ChatGPT-sub Codex lane (free on the sub)." },
    ],
    previewMode: (optionalEnv("PREVIEW_MODE", "local")).toLowerCase(),
  };
}

async function deepHealth() {
  const timeoutMs = 2500;
  const bounded = (promise) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
  ]);
  const supabase = await bounded(serviceClient().from("projects").select("id").limit(1))
    .then(({ error }) => !error).catch(() => false);
  const mode = publicConfig().previewMode;
  const provisiond = mode !== "vps" || await bounded(fetch(`${optionalEnv("PROVISIOND_URL", "")}/health`))
    .then((r) => r.ok).catch(() => false);
  return { ok: supabase && provisiond, supabase, provisiond };
}

async function serveStatic(req, res) {
  // Only used in prod (after `vite build`). In dev the UI is served by Vite on :5173.
  let rel = new URL(req.url, "http://x").pathname;
  if (rel === "/" || rel === "") rel = "/index.html";
  let file = resolveStaticPath(WEB_DIST, rel);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  let fallback = false;
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = path.join(file, "index.html");
  } catch {
    file = path.join(WEB_DIST, "index.html"); // SPA fallback
    fallback = true;
  }
  try {
    const data = await readFile(file);
    const ext = path.extname(file);
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".svg": "image/svg+xml", ".json": "application/json",
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
      ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2",
      ".webmanifest": "application/manifest+json", ".txt": "text/plain" }[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": fallback ? "no-cache" : staticCacheControl(rel),
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

async function requireOwner(req, res) {
  const owner = await ownerFromToken(bearer(req));
  if (!owner) { sendJson(res, 401, { error: "unauthorized — sign in first" }); return null; }
  return owner;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  applySecurityHeaders(res);
  const corsOk = applyCors(res, origin, CORS_ORIGINS);
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const method = req.method || "GET";

  if (method === "OPTIONS") {
    res.writeHead(corsOk ? 204 : 403);
    return res.end();
  }
  if (!corsOk) return sendJson(res, 403, { error: "origin not allowed" });

  const policy = ratePolicy(p, method);
  if (policy) {
    const rate = consumeRate(`${clientIp(req)}:${method}:${p}`, policy.limit, policy.windowMs);
    res.setHeader("X-RateLimit-Remaining", String(rate.remaining));
    if (!rate.allowed) {
      res.setHeader("Retry-After", String(rate.retryAfter));
      return sendJson(res, 429, { error: "Too many requests. Please wait and try again." });
    }
  }

  try {
    // ── unauthenticated ───────────────────────────────────────────────────────────────────────
    if (p === "/api/health") {
      const deps = await deepHealth();
      return sendJson(res, deps.ok ? 200 : 503, { ...deps, previewMode: publicConfig().previewMode,
        stripe: haveStripeEnv(), byok: byokConfigured() });
    }
    if (p === "/api/config") return sendJson(res, 200, publicConfig());

    if (p === "/api/stripe/webhook" && method === "POST") {
      const raw = await readBody(req, BODY_LIMITS.webhook);
      return handleWebhook(req, res, raw);
    }
    if (p === "/api/stripe/connect-webhook" && method === "POST") {
      const raw = await readBody(req, BODY_LIMITS.webhook);
      return handleConnectWebhook(req, res, raw);
    }
    // Caddy's on_demand_tls ask gate (read-only yes/no; see routes/domains.mjs).
    if (p === "/api/domain-check" && method === "GET") {
      return handleDomainCheck(req, res, url);
    }

    // ── authenticated ───────────────────────────────────────────────────────────────────────
    if (p === "/api/features" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleFeatures(req, res, owner);
    }
    if (p === "/api/projects/secrets" && ["GET", "POST", "DELETE"].includes(method)) {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = method === "GET" ? null : await readJson(req);
      return handleProjectSecrets(req, res, { method, url, body, owner });
    }
    if (p === "/api/projects/releases" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleProjectReleases(req, res, url, owner);
    }
    if (p === "/api/projects/environments" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleProjectEnvironments(req, res, url, owner);
    }
    if (p === "/api/projects/payments" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handlePaymentOverview(req, res, url, owner);
    }
    if (p === "/api/projects/payments/onboard" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleStripeOnboarding(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/payments/products" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handlePaymentProducts(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/test-runs" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleQaStart(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/test-runs" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleQaList(req, res, url, owner);
    }
    {
      const artifact = p.match(/^\/api\/test-runs\/([^/]+)\/artifacts\/([^/]+)$/);
      if (artifact && method === "GET") {
        const owner = await requireOwner(req, res); if (!owner) return;
        return handleQaArtifact(req, res, decodeURIComponent(artifact[1]), decodeURIComponent(artifact[2]), owner);
      }
      const match = p.match(/^\/api\/test-runs\/([^/]+)$/);
      if (match && method === "GET") {
        const owner = await requireOwner(req, res); if (!owner) return;
        return handleQaGet(req, res, decodeURIComponent(match[1]), owner);
      }
    }
    if (p === "/api/generate" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req, BODY_LIMITS.tree);
      return handleGenerate(req, res, body, owner);
    }
    // Background build jobs: /api/builds/:jobId/events · /api/builds/:jobId/cancel ·
    // /api/projects/:id/active-build. Ids come from the path; ownership is checked in buildJobs.
    {
      let m;
      if ((m = p.match(/^\/api\/builds\/([^/]+)\/events$/)) && method === "GET") {
        const owner = await requireOwner(req, res); if (!owner) return;
        return handleBuildEvents(req, res, decodeURIComponent(m[1]), owner);
      }
      if ((m = p.match(/^\/api\/builds\/([^/]+)\/cancel$/)) && method === "POST") {
        const owner = await requireOwner(req, res); if (!owner) return;
        return handleBuildCancel(req, res, decodeURIComponent(m[1]), owner);
      }
      if ((m = p.match(/^\/api\/projects\/([^/]+)\/active-build$/)) && method === "GET") {
        const owner = await requireOwner(req, res); if (!owner) return;
        return handleActiveBuild(req, res, decodeURIComponent(m[1]), owner);
      }
    }
    if (p === "/api/preview" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req, BODY_LIMITS.tree);
      return handlePreview(req, res, body, owner);
    }
    if (p === "/api/export" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req);
      return handleExport(req, res, body, owner);
    }
    if (p === "/api/publish" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req, BODY_LIMITS.tree);
      return handlePublish(req, res, body, owner);
    }
    if (p === "/api/unpublish" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req);
      return handleUnpublish(req, res, body, owner);
    }
    if (p === "/api/android" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req, BODY_LIMITS.tree);
      return handleAndroid(req, res, body, owner);
    }
    if (p === "/api/domains" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleDomainList(req, res, url, owner);
    }
    if (p === "/api/domains" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req);
      return handleDomainConnect(req, res, body, owner);
    }
    if (p === "/api/domains/remove" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req);
      return handleDomainRemove(req, res, body, owner);
    }
    if (p === "/api/projects/delete" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req);
      return handleProjectDelete(req, res, body, owner);
    }
    if (p === "/api/account/delete" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req);
      return handleAccountDelete(req, res, body, owner);
    }
    if (p === "/api/billing/checkout" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req);
      return handleCheckout(req, res, body, owner);
    }
    if (p === "/api/billing/balance" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleBalance(req, res, owner);
    }
    if (p === "/api/billing/subscription" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleSubscription(req, res, owner);
    }
    if (p === "/api/billing/switch" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req);
      return handleSwitch(req, res, body, owner);
    }
    if (p === "/api/billing/cancel" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req);
      return handleCancel(req, res, body, owner);
    }
    if (p === "/api/settings/byok") {
      const owner = await requireOwner(req, res); if (!owner) return;
      if (method === "GET") return handleByokGet(req, res, owner);
      if (method === "POST") return handleByokSave(req, res, await readJson(req), owner);
      if (method === "DELETE") return handleByokClear(req, res, owner);
      return sendJson(res, 405, { error: "method not allowed" });
    }

    if (p.startsWith("/api/")) return sendJson(res, 404, { error: `no route ${method} ${p}` });

    // Static SPA (prod only).
    return serveStatic(req, res);
  } catch (e) {
    if (e instanceof HttpInputError) return sendJson(res, e.status, { error: e.message, code: e.code });
    if (e?.code === "bad_secret") return sendJson(res, 400, { error: e.message, code: e.code });
    if (e?.code === "upgrade_required") return sendJson(res, 402, { error: e.message, code: e.code });
    if (e?.code === "feature_unavailable") return sendJson(res, 404, { error: e.message, code: e.code });
    console.error(`[shell] 500 on ${method} ${p}:`, e?.stack || e?.message || e);
    sendJson(res, 500, { error: "Something went wrong. Please try again." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[shell] server on http://${HOST || "localhost"}:${PORT}`);
  const cfg = publicConfig();
  console.log(`[shell] preview mode: ${cfg.previewMode} · supabase env: ${haveSupabaseEnv()} · stripe env: ${haveStripeEnv()}`);
  // Any job rows THIS server left non-terminal are dead (their loop died with the process) —
  // mark them interrupted so no build ever shows "building" forever. Scoped by server_id.
  sweepInterrupted().catch((e) => console.log(`[jobs] sweep failed: ${e.message}`));
  sweepStaleJobs().catch((e) => console.log(`[jobs] stale sweep failed: ${e.message}`));
  sweepQaRuns().catch((e) => console.log(`[qa] stale sweep failed: ${e.message}`));
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shell] ${signal} - marking active builds interrupted`);
  server.close();
  await interruptLiveJobs().catch((e) => console.log(`[jobs] shutdown sweep failed: ${e.message}`));
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
