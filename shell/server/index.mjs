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
import { handleBrandApply, handleBrandDelete, handleBrandOverview } from "./routes/visualBrand.mjs";
import { handleConsoleRecordDelete, handleConsoleUser, handleOwnerConsole } from "./routes/ownerConsole.mjs";
import { handleGithubConnect, handleGithubDisconnect, handleGithubExport, handleGithubOverview } from "./routes/github.mjs";
import { handleIntegrationOverview, handleIntegrationSave } from "./routes/integrations.mjs";
import {
  handleConnectorDisconnect, handleConnectorOAuthCallback, handleConnectorOAuthStart,
  handleConnectorOverview, handleConnectorSave, handleConnectorTest, handleConnectorWorkflows, handleMetaConnectorOAuthCallback,
} from "./routes/connectors.mjs";
import { startActionWorker, stopActionWorker } from "./lib/appIntegrations.mjs";
import { handleAnalytics } from "./routes/analytics.mjs";
import { handleEnvironmentOverview, handleReleaseAction, handleTestDeploy } from "./routes/environments.mjs";
import { handleTemplateCreate, handleTemplateDelete, handleTemplateList, handleTemplateRemix } from "./routes/templates.mjs";
import { handleRuntimeCheckout } from "./routes/runtimeCheckout.mjs";
import { handleRuntimeConnectors, handleRuntimeMetaCallback } from "./routes/runtimeConnectors.mjs";
import { handleRuntimeWebhook } from "./routes/runtimeWebhook.mjs";
import { handleActionSchedule, handleCapabilities, handleKnowledgeBase, handleRuntimeCredentialDelete } from "./routes/capabilities.mjs";
import {
  handleAgents, handleCodeAgentCapabilities, handleLatestRunGet, handleRepositories, handleRunCancel,
  handleRunArtifacts, handleRunCreate, handleRunEvents, handleRunGet, handleRunPublish,
  handleRepositoryFileGraph, handleRepositoryIndexGet, handleRepositoryIndexRefresh,
  handleRepositorySearch, handleRepositorySymbolSearch, handleRunRetry, handleUsage,
} from "./routes/codeAgent.mjs";
import { CodeAgentInputError } from "./lib/codeAgentContracts.mjs";
import { startCodeAgentWorker, stopCodeAgentWorker } from "./lib/codeAgentService.mjs";
import { startGithubWebhookWorker, stopGithubWebhookWorker } from "./lib/githubWebhookService.mjs";
import { startRepositoryIndexWorker, stopRepositoryIndexWorker } from "./lib/repositoryIndexService.mjs";
import { stopCodexLoginSessions } from "./lib/codexLogin.mjs";
import {
  handleGithubAppCallback, handleGithubAppStart, handleGithubInstallationRepositories, handleGithubWebhook,
  handleGithubInstallations, handleGithubRepositoryConnect,
} from "./routes/githubApp.mjs";
import {
  handleAiByokConnect, handleAiConnections, handleAiProviderDisconnect, handleAiProviderSelect,
  handleCodexLoginCancel, handleCodexLoginStart, handleCodexLoginStatus,
} from "./routes/aiConnections.mjs";
import { byokConfigured } from "./lib/byokStore.mjs";
import { TIERS, TOPUP_GBP_PER_CREDIT, WELCOME_CREDITS, effectiveGbpPerCredit, trueCostPerCredit } from "../../src/billing/costModel.mjs";
import { TOKENS_PER_CREDIT } from "../../src/cost.mjs";

loadEnv();
const PORT = Number(optionalEnv("SHELL_PORT", "8787"));
const CODE_AGENT_STANDALONE = optionalEnv("CODE_AGENT_STANDALONE", "on").toLowerCase() !== "off";
// Bind address. Default (unset) = all interfaces, the local-dev behavior. In production on the
// VPS this is set to the docker proxy-net gateway (10.83.7.1) so Caddy can reverse-proxy to the
// shell while the port stays unreachable from the public internet.
const HOST = optionalEnv("SHELL_HOST", "") || undefined;
const WEB_DIST = path.join(SHELL_DIR, "web", "dist");
const CORS_ORIGINS = allowedOrigins(optionalEnv("APP_URL", "http://localhost:5173"));
CORS_ORIGINS.add(`http://127.0.0.1:${PORT}`);
CORS_ORIGINS.add(`http://localhost:${PORT}`);
const consumeRate = createRateLimiter();

function applyRuntimeCors(res, origin) {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    return true;
  } catch { return false; }
}

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
  const store = optionalEnv("CODE_AGENT_STORE", "memory").toLowerCase();
  const table = CODE_AGENT_STANDALONE ? "ca_runs" : "projects";
  const supabase = CODE_AGENT_STANDALONE && store === "memory"
    ? true
    : await bounded(serviceClient().from(table).select("id").limit(1))
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
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const method = req.method || "GET";
  const runtimeCors = ["/api/runtime/checkout", "/api/runtime/connectors"].includes(p);
  const corsOk = runtimeCors ? applyRuntimeCors(res, origin) : applyCors(res, origin, CORS_ORIGINS);

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
    if (p === "/api/v1/capabilities" && method === "GET") {
      return handleCodeAgentCapabilities(req, res);
    }
    if (p === "/api/v1/github/callback" && method === "GET") {
      return handleGithubAppCallback(req, res, url);
    }
    if (p === "/api/v1/github/webhook" && method === "POST") {
      const raw = await readBody(req, BODY_LIMITS.webhook);
      return handleGithubWebhook(req, res, raw);
    }

    if (p === "/api/connectors/oauth/google/callback" && method === "GET") {
      return handleConnectorOAuthCallback(req, res, url);
    }
    if (p === "/api/connectors/oauth/meta/callback" && method === "GET") {
      return handleMetaConnectorOAuthCallback(req, res, url);
    }
    if (p === "/api/runtime/connectors/meta/callback" && method === "GET") {
      return handleRuntimeMetaCallback(req, res, url);
    }

    if (p === "/api/runtime/checkout" && method === "POST") {
      return handleRuntimeCheckout(req, res, await readJson(req), bearer(req), origin);
    }
    if (p === "/api/runtime/connectors" && method === "POST") {
      return handleRuntimeConnectors(req, res, await readJson(req), bearer(req), origin);
    }

    if (p === "/api/stripe/webhook" && method === "POST") {
      const raw = await readBody(req, BODY_LIMITS.webhook);
      return handleWebhook(req, res, raw);
    }
    if (p === "/api/stripe/connect-webhook" && method === "POST") {
      const raw = await readBody(req, BODY_LIMITS.webhook);
      return handleConnectWebhook(req, res, raw);
    }
    if (p === "/api/runtime/webhooks/replicate" && method === "POST") {
      const raw = await readBody(req, BODY_LIMITS.webhook);
      return handleRuntimeWebhook(req, res, raw, url);
    }
    // Caddy's on_demand_tls ask gate (read-only yes/no; see routes/domains.mjs).
    if (p === "/api/domain-check" && method === "GET") {
      return handleDomainCheck(req, res, url);
    }

    // ── authenticated ───────────────────────────────────────────────────────────────────────
    if (p === "/api/v1/repositories" && ["GET", "POST"].includes(method)) {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRepositories(req, res, { owner, method, body: method === "POST" ? await readJson(req) : null });
    }
    const repositoryIndexMatch = p.match(/^\/api\/v1\/repositories\/([0-9a-f-]+)\/index$/i);
    if (repositoryIndexMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRepositoryIndexGet(req, res, { owner, repositoryId: repositoryIndexMatch[1] });
    }
    const repositoryIndexRefreshMatch = p.match(/^\/api\/v1\/repositories\/([0-9a-f-]+)\/index\/refresh$/i);
    if (repositoryIndexRefreshMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRepositoryIndexRefresh(req, res, {
        owner,
        repositoryId: repositoryIndexRefreshMatch[1],
      });
    }
    const repositorySearchMatch = p.match(/^\/api\/v1\/repositories\/([0-9a-f-]+)\/search$/i);
    if (repositorySearchMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRepositorySearch(req, res, {
        owner,
        repositoryId: repositorySearchMatch[1],
        body: await readJson(req, BODY_LIMITS.standard),
      });
    }
    const repositorySymbolSearchMatch = p.match(/^\/api\/v1\/repositories\/([0-9a-f-]+)\/symbols\/search$/i);
    if (repositorySymbolSearchMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRepositorySymbolSearch(req, res, {
        owner,
        repositoryId: repositorySymbolSearchMatch[1],
        body: await readJson(req, BODY_LIMITS.standard),
      });
    }
    const repositoryGraphMatch = p.match(/^\/api\/v1\/repositories\/([0-9a-f-]+)\/graph$/i);
    if (repositoryGraphMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRepositoryFileGraph(req, res, {
        owner,
        repositoryId: repositoryGraphMatch[1],
        body: await readJson(req, BODY_LIMITS.standard),
      });
    }
    if (p === "/api/v1/ai/connections" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleAiConnections(req, res, owner);
    }
    if (p === "/api/v1/ai/byok" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleAiByokConnect(req, res, owner, await readJson(req));
    }
    if (p === "/api/v1/ai/provider" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleAiProviderSelect(req, res, owner, await readJson(req));
    }
    if (p === "/api/v1/ai/disconnect" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleAiProviderDisconnect(req, res, owner, await readJson(req));
    }
    if (p === "/api/v1/ai/codex/login/start" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleCodexLoginStart(req, res, owner);
    }
    const codexLoginMatch = p.match(/^\/api\/v1\/ai\/codex\/login\/([0-9a-f-]+)$/i);
    if (codexLoginMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleCodexLoginStatus(req, res, owner, codexLoginMatch[1]);
    }
    if (codexLoginMatch && method === "DELETE") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleCodexLoginCancel(req, res, owner, codexLoginMatch[1]);
    }
    if (p === "/api/v1/github/installations/start" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleGithubAppStart(req, res, owner);
    }
    if (p === "/api/v1/github/installations" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleGithubInstallations(req, res, owner);
    }
    const githubRepositoriesMatch = p.match(/^\/api\/v1\/github\/installations\/(\d+)\/repositories$/);
    if (githubRepositoriesMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleGithubInstallationRepositories(req, res, owner, githubRepositoriesMatch[1]);
    }
    if (p === "/api/v1/github/repositories/connect" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleGithubRepositoryConnect(req, res, owner, await readJson(req));
    }
    if (p === "/api/v1/agents" && ["GET", "POST"].includes(method)) {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleAgents(req, res, { owner, method, body: method === "POST" ? await readJson(req) : null });
    }
    const createRunMatch = p.match(/^\/api\/v1\/agents\/([0-9a-f-]+)\/runs$/i);
    if (createRunMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRunCreate(req, res, { owner, agentId: createRunMatch[1], body: await readJson(req, BODY_LIMITS.standard) });
    }
    const latestRunMatch = p.match(/^\/api\/v1\/agents\/([0-9a-f-]+)\/runs\/latest$/i);
    if (latestRunMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleLatestRunGet(req, res, { owner, agentId: latestRunMatch[1] });
    }
    const runMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)$/i);
    if (runMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRunGet(req, res, { owner, runId: runMatch[1] });
    }
    const cancelRunMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)\/cancel$/i);
    if (cancelRunMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRunCancel(req, res, { owner, runId: cancelRunMatch[1] });
    }
    const publishRunMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)\/publish$/i);
    if (publishRunMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRunPublish(req, res, {
        owner,
        runId: publishRunMatch[1],
        body: await readJson(req, BODY_LIMITS.standard),
      });
    }
    const runArtifactsMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)\/artifacts$/i);
    if (runArtifactsMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRunArtifacts(req, res, { owner, runId: runArtifactsMatch[1] });
    }
    const retryRunMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)\/retry$/i);
    if (retryRunMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRunRetry(req, res, { owner, runId: retryRunMatch[1] });
    }
    const runEventsMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)\/events$/i);
    if (runEventsMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRunEvents(req, res, { owner, runId: runEventsMatch[1], url });
    }
    if (p === "/api/v1/usage" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleUsage(req, res, owner);
    }
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
    if (p === "/api/projects/brand" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleBrandOverview(req, res, url, owner);
    }
    if (p === "/api/projects/brand" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleBrandApply(req, res, await readJson(req, BODY_LIMITS.tree), owner);
    }
    if (p === "/api/brand-kits/delete" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleBrandDelete(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/owner-console" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleOwnerConsole(req, res, url, owner);
    }
    if (p === "/api/projects/owner-console/user" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleConsoleUser(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/owner-console/record" && method === "DELETE") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleConsoleRecordDelete(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/github" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleGithubOverview(req, res, url, owner);
    }
    if (p === "/api/projects/github/connect" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleGithubConnect(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/github/export" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleGithubExport(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/github/disconnect" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleGithubDisconnect(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/integrations" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleIntegrationOverview(req, res, url, owner);
    }
    if (p === "/api/projects/integrations" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleIntegrationSave(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/connectors" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleConnectorOverview(req, res, url, owner);
    }
    if (p === "/api/projects/connectors" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleConnectorSave(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/capabilities" && ["GET", "POST", "DELETE"].includes(method)) {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = method === "GET" ? null : await readJson(req);
      return handleCapabilities(req, res, { method, url, body, owner });
    }
    if (p === "/api/projects/knowledge-bases" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleKnowledgeBase(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/action-schedules" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleActionSchedule(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/runtime-credentials" && method === "DELETE") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleRuntimeCredentialDelete(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/connectors/test" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleConnectorTest(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/connectors/disconnect" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleConnectorDisconnect(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/connectors/oauth/start" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleConnectorOAuthStart(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/connector-workflows" && ["GET", "POST", "DELETE"].includes(method)) {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = method === "GET" ? null : await readJson(req);
      return handleConnectorWorkflows(req, res, { method, url, body, owner });
    }
    if (p === "/api/projects/analytics" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleAnalytics(req, res, url, owner);
    }
    if (p === "/api/projects/environment-control" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleEnvironmentOverview(req, res, url, owner);
    }
    if (p === "/api/projects/environment-control/test" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleTestDeploy(req, res, await readJson(req), owner);
    }
    if (p === "/api/projects/environment-control/release" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleReleaseAction(req, res, await readJson(req), owner);
    }
    if (p === "/api/templates" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleTemplateList(req, res, owner);
    }
    if (p === "/api/templates" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleTemplateCreate(req, res, await readJson(req, BODY_LIMITS.tree), owner);
    }
    if (p === "/api/templates/remix" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleTemplateRemix(req, res, await readJson(req), owner);
    }
    if (p === "/api/templates/delete" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleTemplateDelete(req, res, await readJson(req), owner);
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
    if (e instanceof CodeAgentInputError) return sendJson(res, e.status, { error: e.message, code: e.code });
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
  if (!CODE_AGENT_STANDALONE) {
    sweepInterrupted().catch((e) => console.log(`[jobs] sweep failed: ${e.message}`));
    sweepStaleJobs().catch((e) => console.log(`[jobs] stale sweep failed: ${e.message}`));
    sweepQaRuns().catch((e) => console.log(`[qa] stale sweep failed: ${e.message}`));
    if (haveSupabaseEnv()) startActionWorker();
  }
  startCodeAgentWorker();
  startGithubWebhookWorker();
  startRepositoryIndexWorker();
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shell] ${signal} - marking active builds interrupted`);
  server.close();
  stopActionWorker();
  stopCodeAgentWorker();
  stopGithubWebhookWorker();
  stopRepositoryIndexWorker();
  await stopCodexLoginSessions();
  if (!CODE_AGENT_STANDALONE) {
    await interruptLiveJobs().catch((e) => console.log(`[jobs] shutdown sweep failed: ${e.message}`));
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
