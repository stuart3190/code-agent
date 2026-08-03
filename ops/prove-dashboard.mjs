// Live proof for the project dashboard. Checks what production actually serves.
//
// This phase is mostly interface, and interface is proved in the browser — e2e/project-dashboard
// covers the header, the keyboard pattern and the three states across the device matrix. What can
// only be proved against production is what the deployed bundle really is: that the six tab bodies
// left the initial download, that each split chunk is genuinely fetchable, and that every API the
// tabs depend on is still owner-scoped.

import { serviceClient } from "../shell/server/lib/supabase.mjs";

const BASE = process.env.THRALLO_BASE_URL || "https://app.thrallo.com";
const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const get = async (path) => {
  const response = await fetch(`${BASE}${path}`, { redirect: "manual" });
  return { status: response.status, headers: response.headers, body: await response.text() };
};

// ── The deployed shell ──────────────────────────────────────────────────────────────────
const index = await get("/");
check(index.status === 200, "the app is served", String(index.status));

const mainScript = index.body.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
check(!!mainScript, "the main bundle is referenced from index.html", mainScript || "not found");

const main = await get(mainScript);
check(main.status === 200, "and is served", String(main.status));
const mainKb = Math.round(main.body.length / 1024);
console.log(`[proof] main bundle: ${mainKb} kB uncompressed`);

// ── The tab bodies left the initial download ────────────────────────────────────────────
//
// Each marker is a string that appears only in that tab's source. If one is still in the main
// bundle, that tab was not split and every visitor is downloading it.
const MARKERS = {
  AnalyticsView: "Same-day returning",
  // NOT "Monitoring begins within": that sentence lives in shared/operationalState.mjs, which the
  // main bundle legitimately contains. A marker has to be unique to the tab, or the proof reports a
  // split that did happen as one that did not.
  HealthView: "warning, not downtime",
  LogsView: "Nothing has happened here yet",
  DeploymentsView: "Nothing has been deployed yet",
  DomainsSection: "Your Thrallo address. Always active",
  ProjectSettingsBody: null,   // no distinctive copy; covered by the chunk check below
};

for (const [tab, marker] of Object.entries(MARKERS)) {
  if (!marker) continue;
  check(!main.body.includes(marker),
    `${tab} is NOT in the initial bundle`,
    main.body.includes(marker) ? "still bundled" : "split out");
}

// ── Every split chunk is really fetchable ───────────────────────────────────────────────
//
// A chunk that 404s turns a tab into a blank panel, and it would only ever be noticed by someone
// clicking that tab — the failure mode code splitting introduces.
// The bundler emits dynamic imports with BACKTICKS — import(`./AnalyticsView-DJxZRqTe.js`) — not
// double quotes. Matching only quotes found nothing, reported "0 chunks", and cascaded into three
// more false failures including one that looked like a caching regression.
const chunkNames = [...main.body.matchAll(/["'`]\.\/(\w[\w.-]*-[\w-]{6,}\.js)["'`]/g)].map((m) => m[1]);
const referenced = new Set(chunkNames);
console.log(`[proof] ${referenced.size} split chunk(s) referenced by the main bundle`);

let fetched = 0;
for (const name of referenced) {
  const chunk = await get(`/assets/${name}`);
  if (chunk.status === 200) fetched += 1;
  else check(false, `chunk ${name} is served`, String(chunk.status));
}
check(referenced.size >= 6, "all six tab bodies are split into their own chunks", `${referenced.size}`);
check(fetched === referenced.size, "and every one is served", `${fetched}/${referenced.size}`);

// The tab code has to be SOMEWHERE — proving it left the main bundle is only half the claim.
{
  const found = new Set();
  for (const name of referenced) {
    const chunk = await get(`/assets/${name}`);
    for (const [tab, marker] of Object.entries(MARKERS)) {
      if (marker && chunk.body.includes(marker)) found.add(tab);
    }
  }
  const expected = Object.entries(MARKERS).filter(([, m]) => m).map(([t]) => t);
  check(expected.every((t) => found.has(t)),
    "and each tab's code is present in a chunk, not merely missing",
    [...found].join(", "));
}

// ── Caching ─────────────────────────────────────────────────────────────────────────────
{
  const name = [...referenced][0];
  const chunk = await get(`/assets/${name}`);
  const cache = chunk.headers.get("cache-control") || "";
  check(/max-age=\d{5,}/.test(cache) || /immutable/.test(cache),
    "hashed chunks are cached hard, so a second visit downloads none of them", cache || "no header");
  const html = index.headers.get("cache-control") || "";
  check(!/max-age=\d{5,}/.test(html) || /no-cache|must-revalidate/.test(html),
    "while index.html is not, so a deploy is picked up", html || "no header");
}

// ── Every tab's API is still owner-scoped ───────────────────────────────────────────────
const PROJECT = "00000000-0000-4000-8000-000000000001";
for (const [label, path] of [
  ["analytics", `/api/v1/projects/${PROJECT}/analytics`],
  ["health", `/api/v1/projects/${PROJECT}/health`],
  ["logs", `/api/v1/projects/${PROJECT}/logs`],
  ["deployments", `/api/v1/projects/${PROJECT}/deployments`],
  ["domains", `/api/v1/projects/${PROJECT}/domains`],
]) {
  const response = await get(path);
  check(response.status === 401, `the ${label} tab's API refuses an anonymous request`, String(response.status));
}

// ── The dashboard's own route still resolves ────────────────────────────────────────────
{
  // Client-routed, so the server returns the shell for any dashboard address rather than a 404.
  const deep = await get(`/projects/${PROJECT}/logs?ref=abc`);
  check(deep.status === 200, "a deep link into a dashboard tab is served the app", String(deep.status));
  check(deep.body.includes(mainScript), "with the same bundle, so the client router can take over");
}

// ── Nothing changed about who can read what ─────────────────────────────────────────────
{
  const db = serviceClient();
  const { error } = await db.from("published_sites").select("project_id").limit(1);
  check(!error, "the service can still read publish state", error?.message || "ok");
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
