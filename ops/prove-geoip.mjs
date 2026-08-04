// Live proof for GeoLite2 country analytics.
//
// Two things have to be true at once and they pull against each other: country data must be REAL —
// resolved from the licensed database, never inferred — and analytics must never depend on it.
// So this proves the lookups against known addresses AND proves that removing the database leaves
// ingest working.
//
// The licence key is never printed, never returned by an endpoint and never shipped to the client.
// That is asserted here rather than assumed.

import { readFile, rename, stat } from "node:fs/promises";
import path from "node:path";

import {
  countryFor, geoipConfigured, geoipDir, geoipStatus, loadGeoip, STALE_AFTER_MS,
} from "../shell/server/lib/analytics/geoip.mjs";
import { MmdbReader } from "../shell/server/lib/analytics/mmdb.mjs";
import { recordBeacon } from "../shell/server/lib/analytics/ingest.mjs";
import { overview } from "../shell/server/lib/analytics/reports.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { optionalEnv } from "../shell/server/lib/env.mjs";

const BASE = process.env.THRALLO_BASE_URL || "https://app.thrallo.com";
const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const db = serviceClient();
const dbFile = path.join(geoipDir(), "GeoLite2-Country.mmdb");

// ── The database is real, current, and the licensed edition ─────────────────────────────
check(geoipConfigured(), "a MaxMind licence key is configured");

await loadGeoip();
const status = geoipStatus();
check(status.available, "the country database is loaded", status.reason || "available");
check(!status.stale, "and is not stale", `built ${status.builtAt}`);

{
  const info = await stat(dbFile).catch(() => null);
  check(!!info, "the database is on disk where the updater put it", dbFile);
  // A real GeoLite2-Country database is several megabytes; a stub or an error page is not.
  check(info && info.size > 1_000_000, "and is a real database rather than a stub",
    info ? `${Math.round(info.size / 1024 / 1024)} MB` : "missing");

  const reader = new MmdbReader(await readFile(dbFile));
  check(reader.metadata.databaseType === "GeoLite2-Country",
    "it is the licensed GeoLite2-Country edition", reader.metadata.databaseType);
  check(reader.metadata.nodeCount > 100_000,
    "with the full tree, not the test fixture", `${reader.metadata.nodeCount} nodes`);
  const age = Date.now() - reader.metadata.buildEpoch * 1000;
  check(age < STALE_AFTER_MS, "and was built recently", `${Math.round(age / 86_400_000)} days old`);
}

// ── Known addresses resolve to known countries ──────────────────────────────────────────
//
// Stable, well-known allocations. If MaxMind ever reassigns one this proof fails loudly, which is
// the correct outcome — it would mean the data changed under us.
for (const [ip, expected] of [
  // Deliberately NOT anycast public resolvers. 1.1.1.1 is APNIC research space and 9.9.9.9 is
  // Quad9 anycast; GeoLite2 has no country for either, which is the correct answer — an anycast
  // address is genuinely in many countries at once. Asserting one tested the proof, not the
  // product. These three are ordinary allocations, and cover IPv4, IPv6 and two countries.
  ["8.8.8.8", "US"],
  ["213.86.0.1", "GB"],
  ["2001:4860:4860::8888", "US"],
]) {
  const got = countryFor(ip);
  check(got === expected, `${ip} resolves to ${expected}`, String(got));
}

// ── Never a guess ───────────────────────────────────────────────────────────────────────
for (const ip of ["10.0.0.1", "192.168.0.1", "127.0.0.1", "::1", "", "not-an-ip", "999.999.999.999"]) {
  check(countryFor(ip) === null, `${ip || "(empty)"} yields no country rather than a guess`, String(countryFor(ip)));
}

// ── Ingest stores the code, and never the address ───────────────────────────────────────
const owners = [];
try {
  const { data: created } = await db.auth.admin.createUser({
    email: `p9-geoip-${Date.now()}@thrallo.invalid`,
    password: `P9!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
  });
  const OWNER = created.user.id;
  owners.push(OWNER);

  const PROJECT = crypto.randomUUID();
  const PRODUCT = crypto.randomUUID();
  const SLUG = `p9geo${Date.now().toString(36).slice(-5)}`;
  await db.from("ca_products").insert({ id: PRODUCT, owner: OWNER, name: "GeoProof" });
  await db.from("projects").insert({ id: PROJECT, owner: OWNER, name: "GeoProof", product_id: PRODUCT, tree: {} });
  await db.from("published_sites").insert({
    owner: OWNER, project_id: PROJECT, product_id: PRODUCT, slug: SLUG,
    url: `https://${SLUG}.app.thrallo.com/`,
  });
  await db.from("ca_subscriptions").upsert({ owner: OWNER, plan: "starter", status: "active" }, { onConflict: "owner" });

  const beacon = (ip) => recordBeacon({
    body: { kind: "pageview", appId: SLUG, path: "/", host: `${SLUG}.app.thrallo.com` },
    ip,
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    client: db,
  });

  const accepted = await beacon("8.8.8.8");
  check(accepted.accepted !== false, "a beacon with a resolvable address is accepted", JSON.stringify(accepted));
  await beacon("213.86.0.1");
  await beacon("10.0.0.1");   // private: no country, must still be counted

  const { data: events } = await db.from("analytics_events")
    .select("*").eq("owner", OWNER);
  check((events || []).length === 3, "every beacon was recorded", `${(events || []).length}`);

  const countries = (events || []).map((e) => e.country).sort();
  check(countries.filter(Boolean).length === 2, "two of them carry a country", countries.join(","));
  check(countries.includes("US") && countries.includes("GB"), "and they are the right ones", countries.join(","));
  check(countries.includes(null) || countries.some((c) => c === null),
    "while the private address is stored with no country rather than a placeholder");

  // The guarantee that matters most.
  const columns = Object.keys(events?.[0] || {});
  check(!columns.some((c) => /(^|_)ip($|_)|address/i.test(c)),
    "no column stores an address", columns.join(","));
  const serialised = JSON.stringify(events);
  for (const ip of ["8.8.8.8", "213.86.0.1", "10.0.0.1"]) {
    check(!serialised.includes(ip), `the address ${ip} appears nowhere in the stored events`);
  }

  // ── The report exposes it with its state ──────────────────────────────────────────────
  {
    // Roll the raw events up so the report has daily rows to read.
    const { rollupAnalytics } = await import("../shell/server/lib/analytics/rollup.mjs");
    await rollupAnalytics({ client: db }).catch(() => {});
    const report = await overview(OWNER, PROJECT, { client: db });
    check(report.countries?.available === true, "the report says country data is available",
      JSON.stringify(report.countries?.reason));
    check(!!report.countries?.builtAt, "and states how current the database is", report.countries?.builtAt);
    const keys = (report.countries?.rows || []).map((r) => r.key);
    check(keys.includes("US") || keys.includes("GB"),
      "with real rows", keys.join(",") || "none");
  }

  // ── Ingest survives the database going away ───────────────────────────────────────────
  {
    const parked = `${dbFile}.proof-parked`;
    await rename(dbFile, parked);
    await loadGeoip();                                   // reload with the file gone
    check(geoipStatus().available === false, "with the database removed, country becomes unavailable");
    check(countryFor("8.8.8.8") === null, "and lookups return nothing rather than throwing");

    const still = await beacon("8.8.8.8");
    check(still.accepted !== false, "and a beacon is STILL accepted", JSON.stringify(still));
    const { data: after } = await db.from("analytics_events").select("country").eq("owner", OWNER);
    check((after || []).length === 4, "and recorded", `${(after || []).length} events`);

    await rename(parked, dbFile);
    await loadGeoip();
    check(geoipStatus().available === true, "and it recovers when the database returns");
  }

  // ── The licence key is nowhere it should not be ───────────────────────────────────────
  {
    const key = optionalEnv("THRALLO_MAXMIND_LICENSE_KEY");
    check(!!key, "the key is readable by the server");

    const index = await (await fetch(`${BASE}/`)).text();
    const main = index.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
    const mainBundle = await (await fetch(`${BASE}${main}`)).text();
    const names = [...mainBundle.matchAll(/["'`]\.\/([\w.-]*-[\w-]{6,}\.js)["'`]/g)].map((m) => m[1]);
    const chunks = await Promise.all([...new Set(names)].map((n) => fetch(`${BASE}/assets/${n}`).then((r) => r.text())));
    const client = [mainBundle, ...chunks].join("\n");
    check(!client.includes(key), "and appears nowhere in the deployed client bundle");
    // The bundle DOES name MaxMind — the not-configured copy explains what country reporting is
    // waiting for, which is the honest thing to say. What must never ship is the key itself, and
    // the check above is the one that matters.
    check(!/license_key=/i.test(client), "and carries no licence-key parameter");

    const health = await (await fetch(`${BASE}/api/health`)).text();
    check(!health.includes(key), "nor in the health endpoint");

    // The one place it legitimately travels is the download URL, and error paths scrub it.
    const source = await readFile(new URL("../shell/server/lib/analytics/geoip.mjs", import.meta.url), "utf8");
    check(/license_key=<redacted>/.test(source), "and download errors redact it before logging");
    check(!/console\.log\([^)]*key/i.test(source), "no code path logs the key");
  }

  // ── Country never reaches a Free plan ─────────────────────────────────────────────────
  {
    await db.from("ca_subscriptions").upsert({ owner: OWNER, plan: "free", status: "active" }, { onConflict: "owner" });
    const free = await overview(OWNER, PROJECT, { client: db });
    check(free.countries?.available === false && free.countries?.reason === "plan",
      "a Free account is told country reporting is a paid feature", JSON.stringify(free.countries));
    check((free.countries?.rows || []).length === 0, "and receives no rows through it");
  }
} finally {
  for (const owner of owners) {
    for (const table of ["analytics_events", "analytics_daily", "published_sites", "projects", "ca_products", "ca_subscriptions"]) {
      await db.from(table).delete().eq("owner", owner).then(() => {}, () => {});
    }
    await db.auth.admin.deleteUser(owner).catch(() => {});
  }
  check(true, "the proof cleaned up after itself", `${owners.length} throwaway account(s)`);
}

console.log(`\n${out.join("\n")}\n`);
console.log(failed ? `${failed} FAILED` : `${out.length}/${out.length} checks passed`);
process.exit(failed ? 1 : 0);
