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
import { fileURLToPath } from "node:url";
import { loadEnv, optionalEnv, SHELL_DIR } from "./lib/env.mjs";
import { ownerFromToken, bearer, haveSupabaseEnv } from "./lib/supabase.mjs";
import { haveStripeEnv } from "./lib/services.mjs";
import { handleGenerate } from "./routes/generate.mjs";
import { handleCheckout, handleBalance, handleSubscription, handleSwitch, handleCancel } from "./routes/billing.mjs";
import { handleWebhook } from "./routes/stripeWebhook.mjs";
import { handlePreview } from "./routes/preview.mjs";
import { handleExport } from "./routes/export.mjs";
import { handlePublish, handleUnpublish } from "./routes/publish.mjs";
import { handleDomainCheck, handleDomainList, handleDomainConnect, handleDomainRemove } from "./routes/domains.mjs";
import { handleByokGet, handleByokSave, handleByokClear } from "./routes/settings.mjs";
import { byokConfigured } from "./lib/byokStore.mjs";
import { TIERS, TOPUP_GBP_PER_CREDIT, effectiveGbpPerCredit, trueCostPerCredit } from "../../src/billing/costModel.mjs";
import { TOKENS_PER_CREDIT } from "../../src/cost.mjs";

loadEnv();
const PORT = Number(optionalEnv("SHELL_PORT", "8787"));
// Bind address. Default (unset) = all interfaces, the local-dev behavior. In production on the
// VPS this is set to the docker proxy-net gateway (10.83.7.1) so Caddy can reverse-proxy to the
// shell while the port stays unreachable from the public internet.
const HOST = optionalEnv("SHELL_HOST", "") || undefined;
const WEB_DIST = path.join(SHELL_DIR, "web", "dist");

function cors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(Buffer.concat(chunks)));
  });
}
const json = (buf) => { try { return JSON.parse(buf.toString("utf8") || "{}"); } catch { return {}; } };

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function publicConfig() {
  return {
    tokensPerCredit: TOKENS_PER_CREDIT,
    floorGbpPerCredit: trueCostPerCredit(),
    topupGbpPerCredit: TOPUP_GBP_PER_CREDIT,
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

async function serveStatic(req, res) {
  // Only used in prod (after `vite build`). In dev the UI is served by Vite on :5173.
  let rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  let file = path.join(WEB_DIST, rel);
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = path.join(file, "index.html");
  } catch {
    file = path.join(WEB_DIST, "index.html"); // SPA fallback
  }
  try {
    const data = await readFile(file);
    const ext = path.extname(file);
    const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".svg": "image/svg+xml", ".json": "application/json" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
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
  cors(res, origin);
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const method = req.method || "GET";

  if (method === "OPTIONS") { res.writeHead(204); return res.end(); }

  try {
    // ── unauthenticated ───────────────────────────────────────────────────────────────────────
    if (p === "/api/health") {
      return sendJson(res, 200, { ok: true, previewMode: publicConfig().previewMode,
        supabase: haveSupabaseEnv(), stripe: haveStripeEnv(), byok: byokConfigured() });
    }
    if (p === "/api/config") return sendJson(res, 200, publicConfig());

    if (p === "/api/stripe/webhook" && method === "POST") {
      const raw = await readBody(req);
      return handleWebhook(req, res, raw);
    }
    // Caddy's on_demand_tls ask gate (read-only yes/no; see routes/domains.mjs).
    if (p === "/api/domain-check" && method === "GET") {
      return handleDomainCheck(req, res, url);
    }

    // ── authenticated ───────────────────────────────────────────────────────────────────────
    if (p === "/api/generate" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = json(await readBody(req));
      return handleGenerate(req, res, body, owner);
    }
    if (p === "/api/preview" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = json(await readBody(req));
      return handlePreview(req, res, body, owner);
    }
    if (p === "/api/export" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = json(await readBody(req));
      return handleExport(req, res, body, owner);
    }
    if (p === "/api/publish" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = json(await readBody(req));
      return handlePublish(req, res, body, owner);
    }
    if (p === "/api/unpublish" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = json(await readBody(req));
      return handleUnpublish(req, res, body, owner);
    }
    if (p === "/api/domains" && method === "GET") {
      const owner = await requireOwner(req, res); if (!owner) return;
      return handleDomainList(req, res, url, owner);
    }
    if (p === "/api/domains" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = json(await readBody(req));
      return handleDomainConnect(req, res, body, owner);
    }
    if (p === "/api/domains/remove" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = json(await readBody(req));
      return handleDomainRemove(req, res, body, owner);
    }
    if (p === "/api/billing/checkout" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = json(await readBody(req));
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
      const body = json(await readBody(req));
      return handleSwitch(req, res, body, owner);
    }
    if (p === "/api/billing/cancel" && method === "POST") {
      const owner = await requireOwner(req, res); if (!owner) return;
      const body = json(await readBody(req));
      return handleCancel(req, res, body, owner);
    }
    if (p === "/api/settings/byok") {
      const owner = await requireOwner(req, res); if (!owner) return;
      if (method === "GET") return handleByokGet(req, res, owner);
      if (method === "POST") return handleByokSave(req, res, json(await readBody(req)), owner);
      if (method === "DELETE") return handleByokClear(req, res, owner);
      return sendJson(res, 405, { error: "method not allowed" });
    }

    if (p.startsWith("/api/")) return sendJson(res, 404, { error: `no route ${method} ${p}` });

    // Static SPA (prod only).
    return serveStatic(req, res);
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[shell] server on http://${HOST || "localhost"}:${PORT}`);
  const cfg = publicConfig();
  console.log(`[shell] preview mode: ${cfg.previewMode} · supabase env: ${haveSupabaseEnv()} · stripe env: ${haveStripeEnv()}`);
});
