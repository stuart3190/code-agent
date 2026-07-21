// Autonomous multi-platform poster — keeps Buildr101's social accounts alive without Stuart.
// (Personal-use tool, 2026-07-17. NOT a SaaS: posts only to OUR accounts with OUR tokens.)
//
//   node marketing/social-poster.mjs             generate ONE post, publish to every enabled platform
//   node marketing/social-poster.mjs --dry-run   generate + print, publish nothing
//
// Design: one brain, many mouths. Each run writes ONE post idea (Codex lane — free on the sub)
// with per-platform variants, then every adapter whose creds exist in shell/.env publishes it.
// buildr-social.timer fires 3×/day (09:05 / 13:35 / 18:05 UTC + jitter); the midday run
// self-skips half the time, so the cadence lands at 2-3 posts/day without looking scheduled.
// History lives in ~/.buildr-social-state.json (home dir — deploys can't clobber it) and is fed
// back to the model so angles don't repeat.
//
// Platforms & env (each optional — missing creds just skip that platform):
//   Facebook page   FB_PAGE_ID + FB_PAGE_TOKEN          (long-lived Page token, pages_manage_posts)
//   Instagram       IG_USER_ID (+ FB_PAGE_TOKEN)        (IG Business linked to the page,
//                                                        instagram_content_publish; images required)
//   X / Twitter     X_CLIENT_ID + X_CLIENT_SECRET       (OAuth2 PKCE app; refresh token persisted
//                                                        in the state file — text-only posts, free tier)
//   LinkedIn        LI_ACCESS_TOKEN + LI_PERSON_URN     (60-day member token; re-auth when it dies)
//
// CLAIMS DISCIPLINE (same bar as baseline/PROMO-KIT.md): the prompt forbids invented features,
// numbers, testimonials or offers. Everything the model may say is in FACTS below.

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createCodexProvider } from "../src/providers/codexProvider.mjs";
import { waitForInstagramContainer } from "./instagramPublishing.mjs";
import { loadEnv } from "../shell/server/lib/env.mjs";

loadEnv();
const GRAPH = "https://graph.facebook.com/v21.0";
const STATE_PATH = path.join(os.homedir(), ".buildr-social-state.json");
const DRY = process.argv.includes("--dry-run");

const IMAGES = {
  showcase: "https://buildr101.com/promo/ad-showcase-1.png",
  barber: "https://buildr101.com/promo/post-barber.jpg",
  chat: "https://buildr101.com/promo/ad-chat.png",
  vs: "https://buildr101.com/promo/ad-vs.png",
};

// ── generated card images ──────────────────────────────────────────────────────────────────────
// Most posts get FRESH art: the model designs a branded text card (eyebrow/headline/sub) and the
// VPS renders it via headless Chrome in Docker (zenika/alpine-chrome; ~/social-render is mounted
// at /render, brand fonts copied there once by the installer). The PNG is dropped straight into
// the served web dist (deploy tars overwrite but never delete, so old cards keep their URLs) —
// giving it a public URL both the FB photos endpoint and the IG media endpoint can fetch.
const RENDER_DIR = path.join(os.homedir(), "social-render");
const GEN_DIR = path.join(os.homedir(), "app-builder", "shell", "web", "dist", "promo", "gen");

function cardHtml({ eyebrow, headline, sub }) {
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  // one **word** in the headline renders amber
  const head = esc(headline).replace(/\*\*(.+?)\*\*/, '<span class="amber">$1</span>');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family:"Space Grotesk"; src:url("file:///render/fonts/space-grotesk.woff2") format("woff2"); font-weight:300 700; }
  @font-face { font-family:"Manrope"; src:url("file:///render/fonts/manrope.woff2") format("woff2"); font-weight:200 800; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:1080px; height:1080px; background:#0a0c0f; font-family:"Manrope",sans-serif;
    position:relative; overflow:hidden; display:flex; flex-direction:column; justify-content:center; padding:96px; }
  .glow { position:absolute; inset:0; background:
    radial-gradient(52rem 30rem at 85% -12%, rgba(245,166,35,0.15), transparent 62%),
    radial-gradient(40rem 24rem at 0% 115%, rgba(245,166,35,0.06), transparent 60%); }
  .grid-bg { position:absolute; inset:0; background-image:
    linear-gradient(rgba(42,50,60,0.4) 1px, transparent 1px),
    linear-gradient(90deg, rgba(42,50,60,0.4) 1px, transparent 1px);
    background-size:48px 48px;
    -webkit-mask-image:radial-gradient(46rem 46rem at 40% 30%, black, transparent 78%); }
  .eyebrow { position:relative; font-family:ui-monospace,Consolas,monospace; font-size:26px;
    letter-spacing:0.14em; text-transform:uppercase; color:#f5a623; }
  h1 { position:relative; margin-top:30px; font-family:"Space Grotesk"; font-weight:640;
    font-size:88px; letter-spacing:-0.03em; line-height:1.07; color:#f1f5f9; }
  h1 .amber { color:#f5a623; }
  .sub { position:relative; margin-top:34px; font-size:34px; line-height:1.45; color:#94a3b8; max-width:820px; }
  .footer { position:absolute; left:0; right:0; bottom:0; display:flex; align-items:center;
    justify-content:space-between; padding:26px 96px; border-top:1px solid #232a35; background:rgba(10,12,15,0.9); }
  .brand { display:flex; align-items:center; gap:13px; }
  .mark { width:42px; height:42px; border-radius:10px; background:#f5a623; display:grid; place-items:center; }
  .bword { font-family:"Space Grotesk"; font-weight:650; font-size:28px; color:#f1f5f9; letter-spacing:-0.02em; }
  .url { font-family:ui-monospace,Consolas,monospace; font-size:22px; color:#f7b955; }
</style></head><body>
  <div class="glow"></div><div class="grid-bg"></div>
  <div class="eyebrow">${esc(eyebrow)}</div>
  <h1>${head}</h1>
  <div class="sub">${esc(sub)}</div>
  <div class="footer">
    <div class="brand"><span class="mark"><svg width="23" height="23" viewBox="0 0 16 16" fill="none">
      <rect x="2" y="10.5" width="12" height="3" rx="1.5" fill="#0a0c0f"/>
      <rect x="2" y="6.5" width="9" height="3" rx="1.5" fill="#0a0c0f" fill-opacity="0.75"/>
      <rect x="2" y="2.5" width="6" height="3" rx="1.5" fill="#0a0c0f" fill-opacity="0.5"/></svg></span>
      <span class="bword">Buildr101</span></div>
    <span class="url">buildr101.com</span>
  </div>
</body></html>`;
}

async function renderCard(card) {
  await mkdir(RENDER_DIR, { recursive: true });
  await mkdir(GEN_DIR, { recursive: true });
  await writeFile(path.join(RENDER_DIR, "card.html"), cardHtml(card), "utf8");
  execFileSync("docker", [
    "run", "--rm", "-v", `${RENDER_DIR}:/render`, "zenika/alpine-chrome:latest",
    "--headless", "--no-sandbox", "--disable-gpu", "--window-size=1080,1080",
    "--screenshot=/render/card.png", "--virtual-time-budget=4000", "file:///render/card.html",
  ], { stdio: "pipe" });
  const name = `card-${Date.now()}.png`;
  await copyFile(path.join(RENDER_DIR, "card.png"), path.join(GEN_DIR, name));
  return `https://buildr101.com/promo/gen/${name}`;
}

const PILLARS = [
  "PROOF — the Iron & Oak barber site built from one sentence (image: barber). Show the actual prompt.",
  "FEATURE — spotlight ONE feature and why it matters (accounts/logins, saved data, file uploads, version rollback, visual edits, code export, custom domains on Pro, BYOK).",
  "HOW-IT-FEELS — the experience of changing an app by just asking (image: chat). Show an example ask.",
  "ENGAGEMENT — ask the audience a question (what would you build / what does your business need). No link.",
  "VS — why this isn't like website builders (image: vs). You describe, it builds; logins built in; no lock-in.",
  "TIP — a concrete prompt-writing tip: name your sections, name the data to save, iterate in small asks.",
];

const FACTS = `THE PRODUCT (the only claims allowed — never invent beyond this list):
- Buildr101 (buildr101.com): describe an app or website in plain English; it builds a real
  working web app in minutes — professional design, real stock photography, mobile-ready.
- Customer accounts/logins built in; data (bookings, orders, records) genuinely saved; file uploads.
- Iterate by asking in English; every build is a version you can roll back; click an element to
  target a change; errors can be auto-fixed ("Fix it").
- One-click publish to yourname.app.buildr101.com (paid plans); custom domains on Pro; unpublish
  any time; export full source code any time — no lock-in.
- Free to start: 30 build credits on signup, NO card. Paid plans from £12/month. Top-ups never
  expire. Bring-your-own-API-key option runs builds on your key.
- Proof story allowed verbatim: a barber-shop site ("Iron & Oak") was built UNTOUCHED from the
  single prompt "a website for a local barber shop: services with prices, opening hours, about
  the shop, and a booking request form".
FORBIDDEN: invented users/testimonials/numbers, discounts or offers that don't exist, "unlimited",
"free forever", claiming custom domains below Pro, competitor names, hashtag spam.`;

async function loadState() {
  try { return JSON.parse(await readFile(STATE_PATH, "utf8")); } catch { return { history: [] }; }
}
async function saveState(s) { await writeFile(STATE_PATH, JSON.stringify(s, null, 2), "utf8"); }

// ── generation ─────────────────────────────────────────────────────────────────────────────────
async function generatePost(history) {
  const recent = history.slice(-30).map((h) => `- (${h.pillar}) ${h.idea}`).join("\n") || "(none yet)";
  const provider = createCodexProvider();
  const { text } = await provider.runTurn({
    systemPrompt: `You write social posts for Buildr101. UK English, plain and confident, zero
corporate filler, zero hype-words ("revolutionary", "game-changing" banned). Short lands best.
Emoji sparingly (0-2). Vary rhythm between platforms — never identical text everywhere.\n\n${FACTS}`,
    messages: [{
      role: "user",
      content: `Write ONE post idea, adapted per platform. Pick a pillar we haven't used lately:\n${PILLARS.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\nRecent posts (do NOT repeat these angles):\n${recent}\n\nImage choice: PROOF posts use "barber" (the real screenshot is the proof). Most other posts use\n"card" — a fresh branded graphic you design: give it a punchy eyebrow (2-4 words), a headline\n(max 8 words, wrap exactly ONE word in ** ** to highlight it), and a one-line sub (max 16 words).\nThe stock images showcase|chat|vs are fallbacks — use sparingly. "none" for pure questions.\n\nReply with ONLY JSON:\n{"pillar":"FEATURE","idea":"one-line summary","image":"barber|showcase|chat|vs|card|none",\n "card":{"eyebrow":"NO LOCK-IN","headline":"Your code is **yours**.","sub":"Export the full source of anything you build, any time."},\n "facebook":"2-6 sentences, usually ends with buildr101.com",\n "instagram":"caption, line breaks fine, up to 3 hashtags at the end",\n "x":"under 260 characters including buildr101.com",\n "linkedin":"3-7 sentences, professional but human, ends with buildr101.com"}\n("card" key only when image is "card")`,
    }],
    tools: [],
  });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`model reply had no JSON object:\n${text.slice(0, 400)}`);
  return JSON.parse(match[0]);
}

// ── platform adapters (each returns a result line or null when not configured) ─────────────────
async function postFacebook(post, imageUrl) {
  const { FB_PAGE_ID, FB_PAGE_TOKEN } = process.env;
  if (!FB_PAGE_ID || !FB_PAGE_TOKEN) return null;
  const endpoint = imageUrl ? `${GRAPH}/${FB_PAGE_ID}/photos` : `${GRAPH}/${FB_PAGE_ID}/feed`;
  const body = new URLSearchParams({ access_token: FB_PAGE_TOKEN, message: post.facebook });
  if (imageUrl) body.set("url", imageUrl);
  const res = await fetch(endpoint, { method: "POST", body });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`facebook: ${JSON.stringify(out.error || out).slice(0, 200)}`);
  return `facebook ${out.id || out.post_id}`;
}

async function postInstagram(post, resolvedUrl) {
  const { IG_USER_ID, FB_PAGE_TOKEN } = process.env;
  if (!IG_USER_ID || !FB_PAGE_TOKEN) return null;
  const imageUrl = resolvedUrl || IMAGES.showcase; // IG requires an image — default in
  const create = await fetch(`${GRAPH}/${IG_USER_ID}/media`, {
    method: "POST",
    body: new URLSearchParams({ access_token: FB_PAGE_TOKEN, image_url: imageUrl, caption: post.instagram }),
  });
  const c = await create.json().catch(() => ({}));
  if (!create.ok) throw new Error(`instagram create: ${JSON.stringify(c.error || c).slice(0, 200)}`);
  await waitForInstagramContainer({ containerId: c.id, token: FB_PAGE_TOKEN, graph: GRAPH });
  const pub = await fetch(`${GRAPH}/${IG_USER_ID}/media_publish`, {
    method: "POST",
    body: new URLSearchParams({ access_token: FB_PAGE_TOKEN, creation_id: c.id }),
  });
  const p = await pub.json().catch(() => ({}));
  if (!pub.ok) throw new Error(`instagram publish: ${JSON.stringify(p.error || p).slice(0, 200)}`);
  return `instagram ${p.id}`;
}

// X OAuth2: the refresh token ROTATES on every refresh (like the Codex lesson — persist it!).
async function xAccessToken(state) {
  const { X_CLIENT_ID, X_CLIENT_SECRET } = process.env;
  const refresh = state.xRefreshToken;
  if (!X_CLIENT_ID || !X_CLIENT_SECRET || !refresh) return null;
  const res = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`x token refresh: ${JSON.stringify(out).slice(0, 200)}`);
  if (out.refresh_token) { state.xRefreshToken = out.refresh_token; await saveState(state); }
  return out.access_token;
}

async function postX(post, state) {
  const token = await xAccessToken(state);
  if (!token) return null;
  const res = await fetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: post.x }),
  });
  const out = await res.json().catch(() => ({}));
  // X's free tier returns 402 "credits depleted" for writes — best-effort, so skip (don't fail the
  // whole run over it; FB/IG are what matter). It'll start working if X's tier ever allows writes.
  if (res.status === 402) { console.log("[social] x: skipped (free-tier write credits unavailable)"); return null; }
  if (!res.ok) { console.warn(`[social] x: skipped (${JSON.stringify(out).slice(0, 160)})`); return null; }
  return `x ${out.data?.id}`;
}

async function postLinkedIn(post) {
  const { LI_ACCESS_TOKEN, LI_PERSON_URN } = process.env;
  if (!LI_ACCESS_TOKEN || !LI_PERSON_URN) return null;
  const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LI_ACCESS_TOKEN}`,
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: LI_PERSON_URN,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text: post.linkedin },
          shareMediaCategory: "NONE",
        },
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
    }),
  });
  if (!res.ok) throw new Error(`linkedin: ${(await res.text()).slice(0, 200)}`);
  return `linkedin ${res.headers.get("x-restli-id") || "ok"}`;
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────
const state = await loadState();

const post = await generatePost(state.history || []);
console.log(`[social] pillar=${post.pillar} image=${post.image}${post.card ? ` card="${post.card.headline}"` : ""}\n  fb: ${post.facebook}\n  ig: ${post.instagram}\n  x:  ${post.x}\n  li: ${post.linkedin}`);
if (DRY) { console.log("\n[social] dry run — nothing published."); process.exit(0); }

// Resolve the image ONCE: fresh rendered card, stock screenshot, or nothing.
let imageUrl = null;
if (post.image === "card" && post.card) {
  try { imageUrl = await renderCard(post.card); console.log(`[social] card rendered -> ${imageUrl}`); }
  catch (e) { console.error(`[social] card render failed (${e.message.slice(0, 120)}) — posting without image`); }
} else {
  imageUrl = IMAGES[post.image] || null;
}

const results = [];
const errors = [];
for (const [name, fn] of [
  ["facebook", () => postFacebook(post, imageUrl)],
  ["instagram", () => postInstagram(post, imageUrl)],
  ["x", () => postX(post, state)],
  ["linkedin", () => postLinkedIn(post)],
]) {
  try {
    const r = await fn();
    if (r) results.push(r); else console.log(`[social] ${name}: not configured, skipped`);
  } catch (e) { errors.push(`${name}: ${e.message}`); }
}

state.history = [...(state.history || []), { date: new Date().toISOString().slice(0, 10), pillar: post.pillar, idea: post.idea }].slice(-60);
await saveState(state);

console.log(results.length ? `\n[social] published -> ${results.join(" · ")}` : "\n[social] no platforms configured yet.");
if (errors.length) { console.error(`[social] FAILURES:\n  ${errors.join("\n  ")}`); process.exit(1); }
