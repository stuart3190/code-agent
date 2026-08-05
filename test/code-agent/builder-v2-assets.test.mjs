// WP-7 / V2-A1 — the Asset Service: cache-first resolution, deterministic ranking with
// seeded variety, licence stamping, provider-failure placeholders, selective regeneration.
// Provider payloads follow the REAL Pexels API shape; the fetch is recorded, never live.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pexelsProvider, PEXELS_LICENSE_SNAPSHOT } from "../../shell/server/lib/builderV2/assets/pexelsProvider.mjs";
import {
  createAssetService, rankCandidates, seededIndex, placeholderFor, rewriteDirective,
} from "../../shell/server/lib/builderV2/assets/assetService.mjs";
import { createOptimiser, variantWidthsFor, RESPONSIVE_WIDTHS } from "../../shell/server/lib/builderV2/assets/optimiser.mjs";
import {
  imageProps, pictureSources, placeholderStyle, isPlaceholder,
} from "../../src/scaffolds/reactVite/lib/assets.js";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

// ── the real Pexels response shape, recorded ──────────────────────────────────────────────────

const RECORDED_PHOTOS = [
  { id: 101, width: 1920, height: 1280, alt: "family picking strawberries in a sunny field",
    photographer: "A. Farmer", src: { original: "https://images.pexels.com/101/original.jpg", large2x: "https://images.pexels.com/101/large2x.jpg", medium: "https://images.pexels.com/101/medium.jpg" } },
  { id: 102, width: 2400, height: 1600, alt: "strawberry rows at golden hour on a family farm",
    photographer: "B. Grower", src: { original: "https://images.pexels.com/102/original.jpg", large2x: "https://images.pexels.com/102/large2x.jpg", medium: "https://images.pexels.com/102/medium.jpg" } },
  { id: 103, width: 640, height: 960, alt: "berries",
    photographer: "C. Small", src: { original: "https://images.pexels.com/103/original.jpg", large: "https://images.pexels.com/103/large.jpg", medium: "https://images.pexels.com/103/medium.jpg" } },
  { id: 104, width: 1800, height: 1200, alt: "fresh strawberries close up in a wooden basket",
    photographer: "D. Macro", src: { original: "https://images.pexels.com/104/original.jpg", large2x: "https://images.pexels.com/104/large2x.jpg", medium: "https://images.pexels.com/104/medium.jpg" } },
];

function recordedFetch(log = []) {
  return async (url) => {
    log.push(String(url));
    return { ok: true, json: async () => ({ photos: RECORDED_PHOTOS }) };
  };
}

// Minimal fake of the PostgREST surface the service uses.
function fakeAssetClient() {
  const rows = [];
  let counter = 0;
  function chain() {
    const state = { filters: [], op: "select", payload: null, maybe: false, onConflict: null };
    const matches = (r) => state.filters.every(([c, v]) => r[c] === v);
    const run = () => {
      if (state.op === "select") {
        const out = rows.filter(matches).map((r) => ({ ...r }));
        return state.maybe ? { data: out[0] || null, error: null } : { data: out, error: null };
      }
      if (state.op === "upsert") {
        const keys = (state.onConflict || "").split(",");
        const existing = rows.find((r) => keys.every((k) => r[k] === state.payload[k]));
        if (existing) Object.assign(existing, state.payload);
        else rows.push({ id: `asset-${++counter}`, ...state.payload });
        const saved = rows.find((r) => keys.every((k) => r[k] === state.payload[k]));
        return state.maybe ? { data: { ...saved }, error: null } : { data: [{ ...saved }], error: null };
      }
      if (state.op === "update") { for (const r of rows) if (matches(r)) Object.assign(r, state.payload); return { data: null, error: null }; }
      if (state.op === "delete") { const keep = rows.filter((r) => !matches(r)); rows.length = 0; rows.push(...keep); return { data: null, error: null }; }
      return { data: null, error: { message: "unsupported" } };
    };
    const api = {
      select: () => api,
      upsert: (p, o = {}) => { state.op = "upsert"; state.payload = p; state.onConflict = o.onConflict; return api; },
      update: (p) => { state.op = "update"; state.payload = p; return api; },
      delete: () => { state.op = "delete"; return api; },
      eq: (c, v) => { state.filters.push([c, v]); return api; },
      maybeSingle: () => { state.maybe = true; return Promise.resolve(run()); },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return api;
  }
  return { from: () => chain(), _rows: rows };
}

const FIXED_NOW = () => new Date("2026-08-05T21:00:00Z");
const INTENTS = [
  { slot: "hero", intent: "family strawberry farm in summer", orientation: "landscape" },
  { slot: "route:/visit", intent: "family strawberry farm — plan your visit", orientation: "landscape" },
];

function service({ log = [], client = fakeAssetClient() } = {}) {
  const provider = pexelsProvider({ apiKey: "test-key", fetchImpl: recordedFetch(log) });
  return { svc: createAssetService({ providers: [provider], client, now: FIXED_NOW }), log, client };
}

test("A1 — first resolve searches once per slot; SECOND resolve makes ZERO provider calls", async () => {
  const { svc, log, client } = service();
  const first = await svc.resolveIntents("o", "proj-1", INTENTS);
  assert.equal(first.providerCalls, 2);
  assert.deepEqual(first.resolved.map((r) => r.via), ["search", "search"]);
  assert.equal(client._rows.length, 2, "both assets cached");

  const again = await svc.resolveIntents("o", "proj-1", INTENTS);
  assert.equal(again.providerCalls, 0, "the never-search rule");
  assert.deepEqual(again.resolved.map((r) => r.via), ["cache", "cache"]);
  assert.equal(log.length, 2, "no further HTTP after the cache is warm");
  assert.equal(client._rows[0].usage_count, 2, "reuse is counted");
});

test("A1 — every cached asset carries the C6 licence snapshot with its retrieval date", async () => {
  const { svc, client } = service();
  await svc.resolveIntents("o", "proj-1", [INTENTS[0]]);
  const row = client._rows[0];
  assert.equal(row.license.name, PEXELS_LICENSE_SNAPSHOT.name);
  assert.equal(row.license.attributionRequired, false);
  assert.ok(row.license.prohibited.length >= 4, "the prohibitions travel with the asset");
  assert.equal(row.license.retrievedAt, FIXED_NOW().toISOString());
  assert.equal(row.provider, "pexels");
  assert.ok(row.provider_asset_id);
  assert.ok(row.original_url.startsWith("https://images.pexels.com/"));
});

test("A1 — ranking is deterministic: orientation + resolution + described alt win; low-res never does", () => {
  const provider = pexelsProvider({ apiKey: "k", fetchImpl: recordedFetch() });
  return provider.search("strawberry farm").then((candidates) => {
    const ranked = rankCandidates(candidates, { orientation: "landscape" });
    assert.equal(ranked[ranked.length - 1].id, "103", "the 640px portrait 'berries' ranks last");
    assert.ok(ranked[0].score > ranked[ranked.length - 1].score);
    assert.deepEqual(ranked.map((r) => r.id), rankCandidates(candidates, { orientation: "landscape" }).map((r) => r.id));
  });
});

test("A1 — seeded variety: two projects with the same intent deterministically differ when the pool allows", () => {
  const a = seededIndex("project-A", "family strawberry farm in summer", 5);
  const b = seededIndex("project-B", "family strawberry farm in summer", 5);
  assert.equal(a, seededIndex("project-A", "family strawberry farm in summer", 5), "stable per project");
  // Not guaranteed different for any two ids, but these two differ — pinned so the seeding
  // can never silently collapse to index 0 for everyone.
  assert.notEqual(a, b, "distinct projects pick distinct pool positions");
});

test("A1 — provider failure degrades to a deterministic branded placeholder; the build never blocks", async () => {
  const failing = { name: "pexels", license: PEXELS_LICENSE_SNAPSHOT, configured: () => true,
    search: async () => { throw new Error("HTTP 429"); } };
  const svc = createAssetService({ providers: [failing], client: fakeAssetClient(), now: FIXED_NOW });
  const { resolved, providerCalls } = await svc.resolveIntents("o", "proj-1", [INTENTS[0]]);
  assert.equal(providerCalls, 1);
  assert.equal(resolved[0].via, "placeholder");
  assert.match(resolved[0].asset.css, /^linear-gradient/);
  assert.deepEqual(placeholderFor("proj-1", INTENTS[0]), placeholderFor("proj-1", INTENTS[0]), "deterministic");
  const noProvider = createAssetService({ providers: [], client: fakeAssetClient(), now: FIXED_NOW });
  const bare = await noProvider.resolveIntents("o", "p", [INTENTS[0]]);
  assert.equal(bare.resolved[0].via, "placeholder");
});

test("A1/A3 — regeneration touches ONLY the selected slot, changes the image, honours the directive", async () => {
  const { svc, client, log } = service();
  await svc.resolveIntents("o", "proj-1", INTENTS);
  const heroBefore = client._rows.find((r) => r.slot === "hero");
  const visitBefore = { ...client._rows.find((r) => r.slot === "route:/visit") };

  const { results } = await svc.regenerate("o", "proj-1", { slots: ["hero"], directive: "use darker photography" });
  assert.equal(results[0].via, "regenerated");
  assert.notEqual(results[0].asset.provider_asset_id, heroBefore.provider_asset_id, "the image actually changed");
  assert.match(log[log.length - 1], /dark\+moody|dark%20moody/, "the directive rewrote the provider query");

  const visitAfter = client._rows.find((r) => r.slot === "route:/visit");
  assert.equal(visitAfter.provider_asset_id, visitBefore.provider_asset_id, "unselected slots byte-identical");
  assert.equal(rewriteDirective("make it more modern and brighter"), "bright airy natural light modern minimalist");
  assert.equal(rewriteDirective("no known words"), "");
});

test("A1/A3 — the asset index filters and the manifest is deterministic per project", async () => {
  const { svc } = service();
  await svc.resolveIntents("o", "proj-1", INTENTS);
  const all = await svc.searchAssets("o", "proj-1", {});
  assert.equal(all.length, 2);
  assert.equal((await svc.searchAssets("o", "proj-1", { provider: "pexels" })).length, 2);
  const tagged = await svc.searchAssets("o", "proj-1", { tag: "strawberries" });
  assert.ok(tagged.length >= 1, "tag search finds described photos");

  const manifest = await svc.assetManifestFor("o", "proj-1");
  assert.deepEqual(manifest.map((m) => m.slot), ["hero", "route:/visit"], "sorted, snapshot-ready");
  assert.ok(manifest.every((m) => m.assetId && m.providerAssetId));
});

// ── V2-A2: sharp optimisation + scaffold rendering helpers ────────────────────────────────────

function fakeBucketClient(uploads = []) {
  return {
    storage: {
      from: () => ({
        upload: async (path, bytes, opts) => { uploads.push({ path, size: bytes.length, contentType: opts.contentType }); return { error: null }; },
        getPublicUrl: (path) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
      }),
    },
  };
}

test("A2 — REAL sharp: AVIF+WebP responsive variants + blur LQIP land in the bucket", async () => {
  const sharp = (await import("sharp")).default;
  const source = await sharp({ create: { width: 1400, height: 900, channels: 3, background: { r: 180, g: 60, b: 60 } } })
    .jpeg().toBuffer();
  const uploads = [];
  const optimiser = createOptimiser({
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => source }),
    client: fakeBucketClient(uploads),
  });

  const out = await optimiser.optimise("owner-1", { url: "https://images.pexels.com/x/original.jpg", alt: "test" });
  assert.equal(out.width, 1400);
  assert.deepEqual(out.variants.avif.map((v) => v.width), [640, 1280], "only widths the source supports");
  assert.deepEqual(out.variants.webp.map((v) => v.width), [640, 1280]);
  assert.match(out.variants.blur, /^data:image\/webp;base64,/, "inline LQIP");
  assert.ok(out.variants.blur.length < 2000, "blur stays tiny enough to inline");
  assert.equal(uploads.length, 4, "2 widths × 2 formats uploaded");
  assert.ok(uploads.every((u) => u.path.startsWith(`bv2-assets/owner-1/${out.content_hash}/`)), "content-addressed per owner");
  assert.ok(uploads.every((u) => u.size > 0));
  assert.equal(out.optimised_url, `https://cdn.test/${out.storage_path}/1280.webp`, "primary = largest webp");
  assert.equal(out.content_hash.length, 64, "sha256 of the ORIGINAL bytes");

  // A source smaller than every rung still gets exactly one variant at its own width.
  assert.deepEqual(variantWidthsFor(300), [300]);
  assert.deepEqual(variantWidthsFor(4000), RESPONSIVE_WIDTHS);
});

test("A2 — the service merges optimiser output onto the row; optimiser failure keeps original URLs", async () => {
  const goodOptimiser = { optimise: async (owner, { alt }) => ({
    content_hash: "c".repeat(64), storage_path: `bv2-assets/o/${"c".repeat(64)}`,
    optimised_url: "https://cdn.test/opt.webp",
    variants: { avif: [], webp: [{ width: 640, url: "https://cdn.test/640.webp" }], blur: "data:image/webp;base64,xx" },
    width: 640, height: 400, alt,
  }) };
  const client = fakeAssetClient();
  const provider = pexelsProvider({ apiKey: "k", fetchImpl: recordedFetch() });
  const svc = createAssetService({ providers: [provider], client, now: FIXED_NOW, optimiser: goodOptimiser });
  await svc.resolveIntents("o", "proj-1", [INTENTS[0]]);
  const row = client._rows[0];
  assert.equal(row.optimised_url, "https://cdn.test/opt.webp");
  assert.equal(row.content_hash, "c".repeat(64));
  assert.ok(row.variants.blur, "blur travels on the row");
  assert.ok(row.width > 640, "provider dimensions are not clobbered by variant dimensions");

  const failing = { optimise: async () => { throw new Error("sharp exploded"); } };
  const client2 = fakeAssetClient();
  const svc2 = createAssetService({ providers: [pexelsProvider({ apiKey: "k", fetchImpl: recordedFetch() })], client: client2, now: FIXED_NOW, optimiser: failing });
  const { resolved } = await svc2.resolveIntents("o", "proj-1", [INTENTS[0]]);
  assert.equal(resolved[0].via, "search", "the build continues");
  assert.equal(client2._rows[0].optimised_url, null);
  assert.ok(client2._rows[0].original_url, "original provider URL still serves");
});

test("A2 — scaffold assets.js renders picture/srcset/lazy/blur and ships in the scaffold tree", () => {
  assert.ok(REACT_VITE["src/lib/assets.js"].includes("pictureSources"), "registered in the scaffold");

  const asset = {
    alt_text: "strawberry rows at golden hour", original_url: "https://images.pexels.com/o.jpg",
    optimised_url: "https://cdn.test/1280.webp", width: 2400, height: 1600,
    variants: {
      avif: [{ width: 640, url: "https://cdn.test/640.avif" }, { width: 1280, url: "https://cdn.test/1280.avif" }],
      webp: [{ width: 640, url: "https://cdn.test/640.webp" }, { width: 1280, url: "https://cdn.test/1280.webp" }],
      blur: "data:image/webp;base64,abc",
    },
  };
  const props = imageProps(asset);
  assert.equal(props.loading, "lazy");
  assert.equal(props.decoding, "async");
  assert.equal(props.srcSet, "https://cdn.test/640.webp 640w, https://cdn.test/1280.webp 1280w");
  assert.equal(props.width, 2400, "dimensions pin layout against shift");
  assert.match(props.style.backgroundImage, /^url\(data:image\/webp/, "blur backdrop until pixels arrive");

  const sources = pictureSources(asset);
  assert.deepEqual(sources.map((s) => s.type), ["image/avif", "image/webp"], "AVIF preferred");

  const unoptimised = { alt_text: "x", original_url: "https://images.pexels.com/o.jpg" };
  assert.equal(imageProps(unoptimised).src, "https://images.pexels.com/o.jpg");
  assert.equal(imageProps(unoptimised).srcSet, undefined, "no fabricated srcset");
  assert.deepEqual(pictureSources(unoptimised), []);

  const ph = placeholderFor("p", { slot: "hero", intent: "farm" });
  assert.ok(isPlaceholder(ph));
  assert.equal(imageProps(ph), null, "placeholders render as styled blocks, not <img>");
  assert.match(placeholderStyle(ph).background, /^linear-gradient/);
});
