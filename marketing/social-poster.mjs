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

import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCodexProvider } from "../src/providers/codexProvider.mjs";
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
      content: `Write ONE post idea, adapted per platform. Pick a pillar we haven't used lately:\n${PILLARS.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n\nRecent posts (do NOT repeat these angles):\n${recent}\n\nReply with ONLY JSON:\n{"pillar":"PROOF","idea":"one-line summary","image":"showcase|barber|chat|vs|none",\n "facebook":"2-6 sentences, usually ends with buildr101.com",\n "instagram":"caption, line breaks fine, up to 3 hashtags at the end",\n "x":"under 260 characters including buildr101.com",\n "linkedin":"3-7 sentences, professional but human, ends with buildr101.com"}`,
    }],
    tools: [],
  });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`model reply had no JSON object:\n${text.slice(0, 400)}`);
  return JSON.parse(match[0]);
}

// ── platform adapters (each returns a result line or null when not configured) ─────────────────
async function postFacebook(post) {
  const { FB_PAGE_ID, FB_PAGE_TOKEN } = process.env;
  if (!FB_PAGE_ID || !FB_PAGE_TOKEN) return null;
  const imageUrl = IMAGES[post.image] || null;
  const endpoint = imageUrl ? `${GRAPH}/${FB_PAGE_ID}/photos` : `${GRAPH}/${FB_PAGE_ID}/feed`;
  const body = new URLSearchParams({ access_token: FB_PAGE_TOKEN, message: post.facebook });
  if (imageUrl) body.set("url", imageUrl);
  const res = await fetch(endpoint, { method: "POST", body });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`facebook: ${JSON.stringify(out.error || out).slice(0, 200)}`);
  return `facebook ${out.id || out.post_id}`;
}

async function postInstagram(post) {
  const { IG_USER_ID, FB_PAGE_TOKEN } = process.env;
  if (!IG_USER_ID || !FB_PAGE_TOKEN) return null;
  const imageUrl = IMAGES[post.image] || IMAGES.showcase; // IG requires an image — default in
  const create = await fetch(`${GRAPH}/${IG_USER_ID}/media`, {
    method: "POST",
    body: new URLSearchParams({ access_token: FB_PAGE_TOKEN, image_url: imageUrl, caption: post.instagram }),
  });
  const c = await create.json().catch(() => ({}));
  if (!create.ok) throw new Error(`instagram create: ${JSON.stringify(c.error || c).slice(0, 200)}`);
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
  const token = await xAccessToken(state).catch((e) => { throw e; });
  if (!token) return null;
  const res = await fetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: post.x }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`x: ${JSON.stringify(out).slice(0, 200)}`);
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

// Midday run self-skips half the time -> natural 2-3 posts/day cadence.
const hourUtc = new Date().getUTCHours();
if (!DRY && hourUtc >= 12 && hourUtc < 16 && Math.random() < 0.5) {
  console.log("[social] midday coin-flip says skip — cadence stays human.");
  process.exit(0);
}

const post = await generatePost(state.history || []);
console.log(`[social] pillar=${post.pillar} image=${post.image}\n  fb: ${post.facebook}\n  ig: ${post.instagram}\n  x:  ${post.x}\n  li: ${post.linkedin}`);
if (DRY) { console.log("\n[social] dry run — nothing published."); process.exit(0); }

const results = [];
const errors = [];
for (const [name, fn] of [
  ["facebook", () => postFacebook(post)],
  ["instagram", () => postInstagram(post)],
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
