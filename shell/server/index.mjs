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
import { interruptLiveJobs, sweepInterrupted, sweepStaleJobs } from "./lib/buildJobs.mjs";
import { handlePreviewDomainCheck } from "./routes/previewDomainCheck.mjs";
import { sweepQaRuns } from "./lib/qaRuns.mjs";
import { startActionWorker, stopActionWorker } from "./lib/appIntegrations.mjs";
import {
  handleAgents, handleAgentUpdate, handleCodeAgentCapabilities, handleLatestRunGet,
  handleRepositories, handleRunCancel,
  handleRunArtifacts, handleRunArtifactContent, handleRunCreate, handleRunEvents, handleRunGet,
  handleRunPublish, handleRunResume,
  handleRepositoryFileGraph, handleRepositoryIndexGet, handleRepositoryIndexRefresh,
  handleRepositoryPulls,
  handleCompletion,
  handleRepositorySearch, handleRepositorySymbolSearch, handleRunRetry, handleUsage,
} from "./routes/codeAgent.mjs";
import { CodeAgentInputError } from "./lib/codeAgentContracts.mjs";
import { startCodeAgentWorker, stopCodeAgentWorker } from "./lib/codeAgentService.mjs";
import { startGithubWebhookWorker, stopGithubWebhookWorker } from "./lib/githubWebhookService.mjs";
import { startRepositoryIndexWorker, stopRepositoryIndexWorker } from "./lib/repositoryIndexService.mjs";
import { startRetentionSweeper, stopRetentionSweeper } from "./lib/retentionService.mjs";
import { startDeletedProjectSweeper, stopDeletedProjectSweeper } from "./lib/deletedProjectSweeper.mjs";
import { handleReleaseDownload, handleReleaseManifest } from "./lib/releaseDownloads.mjs";
import {
  handleDiagnosticsList, handleDiagnosticsRun, handleDiagnosticsStep,
  handleDiagnosticsDownload, handleDiagnosticsExplain, handleDiagnosticsPrefs,
  handleDiagnosticsRequests,
} from "./routes/diagnostics.mjs";
import { startDiagnosticsSweeper, stopDiagnosticsSweeper } from "./lib/appBuild/buildDiagnostics.mjs";
import { usageInsights, buildCostSummary, adminAnalytics } from "./lib/usageInsights.mjs";
import { isAdmin } from "./lib/admin.mjs";
import { stopCodexLoginSessions } from "./lib/codexLogin.mjs";
import {
  handleGithubAppCallback, handleGithubAppStart, handleGithubInstallationRepositories, handleGithubWebhook,
  handleGithubInstallations, handleGithubRepositoryConnect,
} from "./routes/githubApp.mjs";
import {
  handleAiByokConnect, handleAiConnections, handleAiProviderDisconnect, handleAiProviderSelect,
  handleAiEvaluationRun, handleAiEvaluations, handleAiRoutingUpdate,
  handleCodexLoginCancel, handleCodexLoginStart, handleCodexLoginStatus,
} from "./routes/aiConnections.mjs";
import { byokConfigured } from "./lib/byokStore.mjs";
import {
  handleBillingOverview, handleBillingPortal, handleBillingWebhook, handleBudgetUpdate,
  handleOpsTelemetry, handlePlanSelect,
} from "./routes/subscription.mjs";
import { isApiTokenBearer, ownerFromApiToken } from "./lib/apiTokens.mjs";
import { handleTokenCreate, handleTokenList, handleTokenRevoke } from "./routes/apiTokens.mjs";
import { handleAutomationDelete, handleAutomationUpdate, handleAutomations } from "./routes/automations.mjs";
import {
  handleConversationEvents, handleConversationGet, handleConversationMessage, handleConversations,
} from "./routes/conversations.mjs";
import {
  notificationChannels, vapidPublicKey, saveSubscription, removeSubscription,
} from "./lib/notifications/notificationService.mjs";
import { startLeadAgentRecovery, stopLeadAgentRecovery } from "./lib/leadAgentService.mjs";
import { startAutomationSweeper, stopAutomationSweeper } from "./lib/automationService.mjs";
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

// Preview/publish teardown bridge used by permanent deletion; null when provisiond is absent.
function provisiondCall() {
  if (!process.env.PROVISIOND_URL || !process.env.PROVISIOND_TOKEN) return null;
  return async (route, body) => fetch(`${process.env.PROVISIOND_URL}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.PROVISIOND_TOKEN}` },
    body: JSON.stringify(body),
  });
}

async function requireOwner(req, res) {
  const token = bearer(req);
  const owner = isApiTokenBearer(token)
    ? await ownerFromApiToken(token)
    : await ownerFromToken(token);
  if (!owner) { sendJson(res, 401, { error: "unauthorized — sign in first" }); return null; }
  return owner;
}

// Token management requires a real signed-in session: a leaked PAT must not mint more PATs.
async function requireSessionOwner(req, res) {
  const owner = await requireOwner(req, res);
  if (!owner) return null;
  if (owner.viaToken) {
    sendJson(res, 403, { error: "API tokens cannot manage tokens; sign in to the web workspace." });
    return null;
  }
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
      return await handleCodeAgentCapabilities(req, res);
    }
    if (p === "/api/v1/github/callback" && method === "GET") {
      return await handleGithubAppCallback(req, res, url);
    }
    if (p === "/api/v1/github/webhook" && method === "POST") {
      const raw = await readBody(req, BODY_LIMITS.webhook);
      return await handleGithubWebhook(req, res, raw);
    }
    if (p === "/api/v1/billing/webhook" && method === "POST") {
      const raw = await readBody(req, BODY_LIMITS.webhook);
      return await handleBillingWebhook(req, res, raw);
    }
    // Caddy's on_demand_tls ask gate for the SHARED front (read-only yes/no; unauthenticated
    // by design — Caddy blocks TLS handshakes on this answer). Regression-guarded by the
    // public-shell e2e: the Phase 24 route codemod silently swallowed this block once, which
    // broke every new preview/publish certificate until it was restored.
    if (p === "/api/domain-check" && method === "GET") {
      return await handlePreviewDomainCheck(req, res, url);
    }
    // Desktop release distribution: manifest + artifact streaming (Range-capable). Public —
    // only files listed in the release manifest are ever served.
    if (p === "/api/v1/downloads" && method === "GET") {
      return await handleReleaseManifest(req, res);
    }
    const downloadMatch = p.match(/^\/downloads\/([^/]+)$/);
    if (downloadMatch && ["GET", "HEAD"].includes(method)) {
      return await handleReleaseDownload(req, res, { name: decodeURIComponent(downloadMatch[1]) });
    }



    // Caddy's on_demand_tls ask gate for the SHARED front (read-only yes/no; Phase 19
    // re-homing — see routes/previewDomainCheck.mjs).

    // ── authenticated ───────────────────────────────────────────────────────────────────────
    if (p === "/api/v1/repositories" && ["GET", "POST"].includes(method)) {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRepositories(req, res, { owner, method, body: method === "POST" ? await readJson(req) : null });
    }
    const repositoryIndexMatch = p.match(/^\/api\/v1\/repositories\/([0-9a-f-]+)\/index$/i);
    if (repositoryIndexMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRepositoryIndexGet(req, res, { owner, repositoryId: repositoryIndexMatch[1] });
    }
    const repositoryIndexRefreshMatch = p.match(/^\/api\/v1\/repositories\/([0-9a-f-]+)\/index\/refresh$/i);
    if (repositoryIndexRefreshMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRepositoryIndexRefresh(req, res, {
        owner,
        repositoryId: repositoryIndexRefreshMatch[1],
      });
    }
    const repositoryPullsMatch = p.match(/^\/api\/v1\/repositories\/([0-9a-f-]+)\/pulls$/i);
    if (repositoryPullsMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRepositoryPulls(req, res, { owner, repositoryId: repositoryPullsMatch[1] });
    }
    const repositorySearchMatch = p.match(/^\/api\/v1\/repositories\/([0-9a-f-]+)\/search$/i);
    if (repositorySearchMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRepositorySearch(req, res, {
        owner,
        repositoryId: repositorySearchMatch[1],
        body: await readJson(req, BODY_LIMITS.standard),
      });
    }
    const repositorySymbolSearchMatch = p.match(/^\/api\/v1\/repositories\/([0-9a-f-]+)\/symbols\/search$/i);
    if (repositorySymbolSearchMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRepositorySymbolSearch(req, res, {
        owner,
        repositoryId: repositorySymbolSearchMatch[1],
        body: await readJson(req, BODY_LIMITS.standard),
      });
    }
    const repositoryGraphMatch = p.match(/^\/api\/v1\/repositories\/([0-9a-f-]+)\/graph$/i);
    if (repositoryGraphMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRepositoryFileGraph(req, res, {
        owner,
        repositoryId: repositoryGraphMatch[1],
        body: await readJson(req, BODY_LIMITS.standard),
      });
    }
    if (p === "/api/v1/ai/connections" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleAiConnections(req, res, owner);
    }
    if (p === "/api/v1/ai/byok" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleAiByokConnect(req, res, owner, await readJson(req));
    }
    if (p === "/api/v1/ai/provider" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleAiProviderSelect(req, res, owner, await readJson(req));
    }
    if (p === "/api/v1/ai/disconnect" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleAiProviderDisconnect(req, res, owner, await readJson(req));
    }
    if (p === "/api/v1/ai/routing" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleAiRoutingUpdate(req, res, owner, await readJson(req));
    }
    if (p === "/api/v1/ai/evaluations" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleAiEvaluations(req, res, owner);
    }
    if (p === "/api/v1/ai/evaluations" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleAiEvaluationRun(req, res, owner, await readJson(req));
    }
    if (p === "/api/v1/ai/codex/login/start" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleCodexLoginStart(req, res, owner);
    }
    const codexLoginMatch = p.match(/^\/api\/v1\/ai\/codex\/login\/([0-9a-f-]+)$/i);
    if (codexLoginMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleCodexLoginStatus(req, res, owner, codexLoginMatch[1]);
    }
    if (codexLoginMatch && method === "DELETE") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleCodexLoginCancel(req, res, owner, codexLoginMatch[1]);
    }
    if (p === "/api/v1/github/installations/start" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleGithubAppStart(req, res, owner);
    }
    if (p === "/api/v1/github/installations" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleGithubInstallations(req, res, owner);
    }
    const githubRepositoriesMatch = p.match(/^\/api\/v1\/github\/installations\/(\d+)\/repositories$/);
    if (githubRepositoriesMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleGithubInstallationRepositories(req, res, owner, githubRepositoriesMatch[1]);
    }
    if (p === "/api/v1/github/repositories/connect" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleGithubRepositoryConnect(req, res, owner, await readJson(req));
    }
    if (p === "/api/v1/agents" && ["GET", "POST"].includes(method)) {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleAgents(req, res, { owner, method, body: method === "POST" ? await readJson(req) : null });
    }
    const agentPatchMatch = p.match(/^\/api\/v1\/agents\/([0-9a-f-]+)$/i);
    if (agentPatchMatch && method === "PATCH") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleAgentUpdate(req, res, { owner, agentId: agentPatchMatch[1], body: await readJson(req) });
    }
    const createRunMatch = p.match(/^\/api\/v1\/agents\/([0-9a-f-]+)\/runs$/i);
    if (createRunMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRunCreate(req, res, { owner, agentId: createRunMatch[1], body: await readJson(req, BODY_LIMITS.standard) });
    }
    const latestRunMatch = p.match(/^\/api\/v1\/agents\/([0-9a-f-]+)\/runs\/latest$/i);
    if (latestRunMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleLatestRunGet(req, res, { owner, agentId: latestRunMatch[1] });
    }
    const runMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)$/i);
    if (runMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRunGet(req, res, { owner, runId: runMatch[1] });
    }
    const cancelRunMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)\/cancel$/i);
    if (cancelRunMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRunCancel(req, res, { owner, runId: cancelRunMatch[1] });
    }
    const publishRunMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)\/publish$/i);
    if (publishRunMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRunPublish(req, res, {
        owner,
        runId: publishRunMatch[1],
        body: await readJson(req, BODY_LIMITS.standard),
      });
    }
    const runArtifactsMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)\/artifacts$/i);
    if (runArtifactsMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRunArtifacts(req, res, { owner, runId: runArtifactsMatch[1] });
    }
    const artifactContentMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)\/artifacts\/([0-9a-f-]+)\/content$/i);
    if (artifactContentMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRunArtifactContent(req, res, {
        owner, runId: artifactContentMatch[1], artifactId: artifactContentMatch[2],
      });
    }
    const resumeRunMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)\/resume$/i);
    if (resumeRunMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRunResume(req, res, {
        owner, runId: resumeRunMatch[1], body: await readJson(req, BODY_LIMITS.standard),
      });
    }
    const retryRunMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)\/retry$/i);
    if (retryRunMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRunRetry(req, res, { owner, runId: retryRunMatch[1] });
    }
    const runEventsMatch = p.match(/^\/api\/v1\/runs\/([0-9a-f-]+)\/events$/i);
    if (runEventsMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleRunEvents(req, res, { owner, runId: runEventsMatch[1], url });
    }
    if (p === "/api/v1/completions" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleCompletion(req, res, { owner, body: await readJson(req, BODY_LIMITS.standard) });
    }
    if (p === "/api/v1/usage" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleUsage(req, res, owner);
    }
    // Owner accounts: view the product as another plan (presentation only).
    if (p === "/api/v1/owner/preview-plan" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req, BODY_LIMITS.standard);
      try {
        const { setPreviewPlan } = await import("./lib/usageBudgets.mjs");
        const overview = await setPreviewPlan(owner.id, body?.plan ?? null);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ownerAccount: overview.ownerAccount, previewPlan: overview.previewPlan, plan: overview.plan, budgets: overview.budgets }));
      } catch (error) {
        res.writeHead(error.status || 500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: error.message, code: error.code }));
      }
    }
    if (p === "/api/v1/notifications/config" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ vapidPublicKey: vapidPublicKey(), channels: notificationChannels() }));
    }
    if (p === "/api/v1/notifications/subscribe" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req, BODY_LIMITS.standard);
      try {
        const out = await saveSubscription(owner.id, body?.subscription);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(out));
      } catch (error) {
        res.writeHead(error.status || 500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: error.message }));
      }
    }
    if (p === "/api/v1/notifications/unsubscribe" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req, BODY_LIMITS.standard);
      const out = await removeSubscription(owner.id, body?.endpoint);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(out));
    }
    if (p === "/api/v1/conversations" && ["GET", "POST"].includes(method)) {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleConversations(req, res, {
        owner, method, body: method === "POST" ? await readJson(req, BODY_LIMITS.standard) : null,
      });
    }
    const conversationMatch = p.match(/^\/api\/v1\/conversations\/([0-9a-f-]+)$/i);
    if (conversationMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleConversationGet(req, res, { owner, conversationId: conversationMatch[1] });
    }
    if (conversationMatch && method === "DELETE") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const permanent = url.searchParams.get("permanent") === "1";
      try {
        if (permanent) {
          // Delete Now: the full cascade, no waiting period.
          const { deleteConversationCascade } = await import("./lib/conversationDelete.mjs");
          const { serviceClient } = await import("./lib/supabase.mjs");
          const out = await deleteConversationCascade(owner.id, conversationMatch[1], {
            client: serviceClient(), provisiond: provisiondCall(),
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(out));
        }
        // Default: soft delete into Recently Deleted — all data retained for the recovery window.
        const { conversationStore } = await import("./lib/conversationStore.mjs");
        const row = await conversationStore().softDeleteConversation(owner.id, conversationMatch[1]);
        if (!row) {
          res.writeHead(404, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ error: "Project not found." }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ deleted: true, deletedAt: row.deleted_at }));
      } catch (error) {
        res.writeHead(error.status || 500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: error.message, step: error.step || null }));
      }
    }
    if (p === "/api/v1/conversations/deleted" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const { conversationStore } = await import("./lib/conversationStore.mjs");
      const { RECOVERY_DAYS } = await import("./lib/conversationDelete.mjs");
      const rows = await conversationStore().listDeletedConversations(owner.id);
      const items = rows.map((row) => {
        const expiresAt = new Date(new Date(row.deleted_at).getTime() + RECOVERY_DAYS * 86400000);
        return {
          id: row.id, title: row.title, deletedAt: row.deleted_at,
          daysRemaining: Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86400000)),
        };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ items, recoveryDays: RECOVERY_DAYS }));
    }
    const conversationRestoreMatch = p.match(/^\/api\/v1\/conversations\/([0-9a-f-]+)\/restore$/i);
    if (conversationRestoreMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const { conversationStore } = await import("./lib/conversationStore.mjs");
      const row = await conversationStore().restoreConversation(owner.id, conversationRestoreMatch[1]);
      if (!row) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Project not found." }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ restored: true, id: row.id, title: row.title }));
    }
    const conversationMessageMatch = p.match(/^\/api\/v1\/conversations\/([0-9a-f-]+)\/messages$/i);
    if (conversationMessageMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleConversationMessage(req, res, {
        owner, conversationId: conversationMessageMatch[1], body: await readJson(req, BODY_LIMITS.standard),
      });
    }
    const conversationEventsMatch = p.match(/^\/api\/v1\/conversations\/([0-9a-f-]+)\/events$/i);
    if (conversationEventsMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleConversationEvents(req, res, { owner, conversationId: conversationEventsMatch[1], url });
    }
    if (p === "/api/v1/models" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const { modelSelectorPayload } = await import("./lib/modelSelector.mjs");
      return sendJson(res, 200, await modelSelectorPayload(owner.id));
    }
    const conversationModelMatch = p.match(/^\/api\/v1\/conversations\/([0-9a-f-]+)\/model$/i);
    if (conversationModelMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = await readJson(req, BODY_LIMITS.standard);
      const { selectableModelsForOwner, validateModelChoice } = await import("./lib/modelSelector.mjs");
      const { conversationStore } = await import("./lib/conversationStore.mjs");
      const store = conversationStore();
      const conversation = await store.getConversation(owner.id, conversationModelMatch[1]);
      if (!conversation) return sendJson(res, 404, { error: "Project not found." });
      try {
        const value = validateModelChoice(await selectableModelsForOwner(owner.id), body?.value);
        await store.updateConversation(conversation, { model_pref: value });
        await store.appendEvent(conversation, "model_changed", { value });
        return sendJson(res, 200, { value });
      } catch (error) {
        return sendJson(res, error.status || 500, { error: error.message, code: error.code || null });
      }
    }
    if (p === "/api/v1/usage/insights" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return sendJson(res, 200, await usageInsights(owner.id));
    }
    const buildSummaryMatch = p.match(/^\/api\/v1\/usage\/builds\/([0-9a-f-]+)$/i);
    if (buildSummaryMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const summary = await buildCostSummary(owner.id, buildSummaryMatch[1]);
      if (!summary) return sendJson(res, 404, { error: "No build summary for that Build ID." });
      return sendJson(res, 200, summary);
    }
    if (p === "/api/v1/admin/intelligence" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      if (!isAdmin(owner)) return sendJson(res, 403, { error: "Administrator access required", code: "admin_only" });
      const { providerIntelligenceSnapshot } = await import("./lib/providerIntelligence.mjs");
      return sendJson(res, 200, await providerIntelligenceSnapshot());
    }
    if (p === "/api/v1/admin/analytics" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      if (!isAdmin(owner)) return sendJson(res, 403, { error: "Administrator access required", code: "admin_only" });
      return sendJson(res, 200, await adminAnalytics());
    }
    // Advanced Diagnostics: the private technical detail behind a support reference.
    // Owner-scoped by query; admins additionally pass isAdmin for cross-account support.
    if (p === "/api/v1/diagnostics/incidents" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const { listIncidents } = await import("./lib/errorShield.mjs");
      return sendJson(res, 200, {
        incidents: await listIncidents(owner.id, { conversationId: url.searchParams.get("conversation") || null }),
      });
    }
    const incidentMatch = p.match(/^\/api\/v1\/diagnostics\/incidents\/(THR-[0-9A-F]{6})$/i);
    if (incidentMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const { incidentByReference } = await import("./lib/errorShield.mjs");
      const incident = await incidentByReference(owner.id, incidentMatch[1]);
      if (!incident) return sendJson(res, 404, { error: "No technical details found for that reference." });
      return sendJson(res, 200, { incident });
    }
    if (p === "/api/v1/diagnostics" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleDiagnosticsList(req, res, { owner, url });
    }
    if (p === "/api/v1/diagnostics/prefs" && ["GET", "POST"].includes(method)) {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleDiagnosticsPrefs(req, res, {
        owner, method, body: method === "POST" ? await readJson(req, BODY_LIMITS.standard) : null,
      });
    }
    const diagMatch = p.match(/^\/api\/v1\/diagnostics\/([0-9a-f-]+)$/i);
    if (diagMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleDiagnosticsRun(req, res, { owner, runId: diagMatch[1] });
    }
    const diagStepMatch = p.match(/^\/api\/v1\/diagnostics\/([0-9a-f-]+)\/step\/(\d+)$/i);
    if (diagStepMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleDiagnosticsStep(req, res, { owner, runId: diagStepMatch[1], seq: diagStepMatch[2] });
    }
    const diagDownloadMatch = p.match(/^\/api\/v1\/diagnostics\/([0-9a-f-]+)\/download$/i);
    if (diagDownloadMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleDiagnosticsDownload(req, res, { owner, runId: diagDownloadMatch[1] });
    }
    const diagRequestsMatch = p.match(/^\/api\/v1\/diagnostics\/([0-9a-f-]+)\/requests$/i);
    if (diagRequestsMatch && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleDiagnosticsRequests(req, res, { owner, runId: diagRequestsMatch[1] });
    }
    const diagExplainMatch = p.match(/^\/api\/v1\/diagnostics\/([0-9a-f-]+)\/explain$/i);
    if (diagExplainMatch && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleDiagnosticsExplain(req, res, { owner, runId: diagExplainMatch[1] });
    }
    if (p === "/api/v1/automations" && ["GET", "POST"].includes(method)) {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleAutomations(req, res, {
        owner, method, body: method === "POST" ? await readJson(req) : null,
      });
    }
    const automationMatch = p.match(/^\/api\/v1\/automations\/([0-9a-f-]+)$/i);
    if (automationMatch && method === "PATCH") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleAutomationUpdate(req, res, {
        owner, automationId: automationMatch[1], body: await readJson(req),
      });
    }
    if (automationMatch && method === "DELETE") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleAutomationDelete(req, res, { owner, automationId: automationMatch[1] });
    }
    if (p === "/api/v1/tokens" && ["GET", "POST"].includes(method)) {
      const owner = await requireSessionOwner(req, res); if (!owner) return;
      if (method === "GET") return await handleTokenList(req, res, owner);
      return await handleTokenCreate(req, res, owner, await readJson(req));
    }
    const tokenRevokeMatch = p.match(/^\/api\/v1\/tokens\/([0-9a-f-]+)$/i);
    if (tokenRevokeMatch && method === "DELETE") {
      const owner = await requireSessionOwner(req, res); if (!owner) return;
      return await handleTokenRevoke(req, res, owner, tokenRevokeMatch[1]);
    }
    if (p === "/api/v1/billing" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleBillingOverview(req, res, owner);
    }
    if (p === "/api/v1/billing/plan" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handlePlanSelect(req, res, owner, await readJson(req));
    }
    if (p === "/api/v1/billing/budgets" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleBudgetUpdate(req, res, owner, await readJson(req));
    }
    if (p === "/api/v1/billing/portal" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleBillingPortal(req, res, owner);
    }
    if (p === "/api/v1/ops/telemetry" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return await handleOpsTelemetry(req, res, owner);
    }
    {      const match = p.match(/^\/api\/test-runs\/([^/]+)$/);
    }
    // Background build jobs: /api/builds/:jobId/events · /api/builds/:jobId/cancel ·
    // /api/projects/:id/active-build. Ids come from the path; ownership is checked in buildJobs.
    {
      let m;
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
  startRetentionSweeper();
  startDeletedProjectSweeper();
  startDiagnosticsSweeper();
  startAutomationSweeper();
  startLeadAgentRecovery();
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
  stopRetentionSweeper();
  stopDeletedProjectSweeper();
  stopDiagnosticsSweeper();
  stopAutomationSweeper();
  stopLeadAgentRecovery();
  await stopCodexLoginSessions();
  if (!CODE_AGENT_STANDALONE) {
    await interruptLiveJobs().catch((e) => console.log(`[jobs] shutdown sweep failed: ${e.message}`));
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
