// Asset Service (finish plan WP-7; master plan Part 18).
//
// The model NEVER searches for images. The contract emits INTENTS; this service resolves
// them — manifest first, cache second, provider LAST — ranks deterministically, seeds
// per-project variety, stamps the licence snapshot on every row, and degrades to a branded
// placeholder rather than ever blocking a build on imagery.
//
// Never-search rules: a (project, slot) that already has an asset resolves from the cache,
// period. A provider is consulted only for a cache miss, an explicit regenerate(), or a
// project duplication (new seed). Every provider consultation is visible in the result.

import crypto from "node:crypto";
import { serviceClient } from "../../supabase.mjs";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

// ── deterministic ranking (Part 18) ───────────────────────────────────────────────────────────

export function rankCandidates(candidates, { orientation = "landscape", paletteTags = [] } = {}) {
  const scored = candidates.map((candidate) => {
    let score = 0;
    if (candidate.orientation === orientation) score += 40;
    if ((candidate.width || 0) >= 1600) score += 25;
    else if ((candidate.width || 0) >= 1200) score += 15;
    if (candidate.alt && candidate.alt.length > 12) score += 10; // described photos beat anonymous ones
    score += paletteTags.filter((tag) => candidate.tags.includes(tag)).length * 5;
    if ((candidate.width || 0) < 800) score -= 40; // low resolution never wins
    return { ...candidate, score };
  });
  return scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
}

/** Seeded pick: same project+intent always picks the same photo; different projects differ. */
export function seededIndex(projectId, intent, poolSize) {
  if (poolSize <= 0) return 0;
  const seed = parseInt(sha256(`${projectId}:${intent}`).slice(0, 8), 16);
  return seed % poolSize;
}

/** The build-never-blocks fallback: a branded gradient, deterministic per intent. */
export function placeholderFor(projectId, { slot, intent }) {
  const hue = parseInt(sha256(`${projectId}:${slot}`).slice(0, 4), 16) % 360;
  return {
    placeholder: true,
    slot,
    intent,
    css: `linear-gradient(135deg, hsl(${hue} 60% 45%), hsl(${(hue + 40) % 360} 55% 30%))`,
    alt: intent,
  };
}

// ── the service ───────────────────────────────────────────────────────────────────────────────

export function createAssetService({ providers = [], client = serviceClient(), now = () => new Date() } = {}) {
  const provider = () => providers.find((p) => p.configured());

  async function cachedAsset(owner, projectId, slot) {
    const { data, error } = await client.from("bv2_assets").select("*")
      .eq("owner", owner).eq("project_id", projectId).eq("slot", slot).maybeSingle();
    if (error) return null;
    return data;
  }

  async function persistAsset(owner, projectId, { slot, intent, orientation }, chosen, providerName, license) {
    const row = {
      owner, project_id: projectId,
      provider: providerName, provider_asset_id: chosen.id,
      original_url: chosen.urls.original || chosen.urls.large,
      optimised_url: null, thumbnail_url: chosen.urls.thumb,
      storage_path: null,
      search_query: intent, intent, category: null,
      tags: chosen.tags, page: null, section: null, slot,
      alt_text: chosen.alt || intent,
      width: chosen.width, height: chosen.height, orientation: chosen.orientation,
      license: { ...license, retrievedAt: now().toISOString() },
      content_hash: null, variants: {},
      usage_count: 1, last_used: now().toISOString(),
    };
    const { data, error } = await client.from("bv2_assets")
      .upsert(row, { onConflict: "owner,project_id,provider,provider_asset_id,slot" })
      .select("*").maybeSingle();
    if (error) throw new Error(`asset persist: ${error.message}`);
    return data || row;
  }

  return {
    /**
     * Resolve intents → AssetRefs. Cache-first; the result reports exactly how each slot was
     * satisfied (cache | search | placeholder) and how many provider calls were made.
     */
    async resolveIntents(owner, projectId, intents = []) {
      const resolved = [];
      let providerCalls = 0;
      for (const request of intents) {
        const hit = await cachedAsset(owner, projectId, request.slot);
        if (hit) {
          await client.from("bv2_assets").update({
            usage_count: (hit.usage_count || 0) + 1, last_used: now().toISOString(),
          }).eq("id", hit.id).then(() => {}, () => {});
          resolved.push({ slot: request.slot, via: "cache", asset: hit });
          continue;
        }

        const active = provider();
        if (!active) {
          resolved.push({ slot: request.slot, via: "placeholder", asset: placeholderFor(projectId, request) });
          continue;
        }
        try {
          providerCalls += 1;
          const candidates = await active.search(request.intent, { orientation: request.orientation || "landscape" });
          const ranked = rankCandidates(candidates, { orientation: request.orientation || "landscape" });
          const pool = ranked.filter((c) => c.score === ranked[0]?.score || c.score >= (ranked[0]?.score || 0) - 10).slice(0, 5);
          if (!pool.length) {
            resolved.push({ slot: request.slot, via: "placeholder", asset: placeholderFor(projectId, request) });
            continue;
          }
          const chosen = pool[seededIndex(projectId, request.intent, pool.length)];
          const row = await persistAsset(owner, projectId, request, chosen, active.name, active.license);
          resolved.push({ slot: request.slot, via: "search", asset: row });
        } catch (error) {
          // Provider down or rate-limited: the build continues on a placeholder, loudly.
          console.error(`[bv2-assets] ${request.slot}: ${error.message} — placeholder used`);
          resolved.push({ slot: request.slot, via: "placeholder", asset: placeholderFor(projectId, request), error: error.message });
        }
      }
      return { resolved, providerCalls };
    },

    /**
     * Selective regeneration: ONLY the selected slots re-resolve; the directive rewrites the
     * provider query deterministically. Everything else stays byte-identical.
     */
    async regenerate(owner, projectId, { slots = [], directive = "" } = {}) {
      const rewritten = rewriteDirective(directive);
      const results = [];
      let providerCalls = 0;
      for (const slot of slots) {
        const existing = await cachedAsset(owner, projectId, slot);
        const intent = existing?.intent || slot;
        const query = rewritten ? `${intent} ${rewritten}` : intent;
        const active = provider();
        if (!active) { results.push({ slot, via: "placeholder", asset: placeholderFor(projectId, { slot, intent }) }); continue; }
        providerCalls += 1;
        const candidates = await active.search(query, { orientation: existing?.orientation || "landscape" });
        const ranked = rankCandidates(candidates, { orientation: existing?.orientation || "landscape" });
        const pool = ranked.slice(0, 5).filter((c) => c.id !== existing?.provider_asset_id); // a regeneration must CHANGE the image
        if (!pool.length) { results.push({ slot, via: "unchanged", asset: existing }); continue; }
        const chosen = pool[seededIndex(projectId, query, pool.length)];
        if (existing) await client.from("bv2_assets").delete().eq("id", existing.id);
        const row = await persistAsset(owner, projectId, { slot, intent, orientation: existing?.orientation }, chosen, active.name, active.license);
        results.push({ slot, via: "regenerated", asset: row });
      }
      return { results, providerCalls };
    },

    /** The asset index: filterable search over the project's imagery. */
    async searchAssets(owner, projectId, { intent = null, provider: providerName = null, tag = null } = {}) {
      let query = client.from("bv2_assets").select("*").eq("owner", owner).eq("project_id", projectId);
      if (intent) query = query.eq("intent", intent);
      if (providerName) query = query.eq("provider", providerName);
      const { data, error } = await query;
      if (error) throw new Error(`asset search: ${error.message}`);
      const rows = data || [];
      return tag ? rows.filter((r) => (r.tags || []).includes(tag)) : rows;
    },

    /** The manifest that versions WITH snapshots: restore a snapshot, restore its imagery. */
    async assetManifestFor(owner, projectId) {
      const rows = await this.searchAssets(owner, projectId, {});
      return rows.map((r) => ({ assetId: r.id, slot: r.slot, provider: r.provider, providerAssetId: r.provider_asset_id }))
        .sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
    },
  };
}

/** Deterministic directive → provider-query rewriting (Part 18). */
export function rewriteDirective(directive) {
  const lower = String(directive || "").toLowerCase();
  const rules = [
    [/darker|moody|dramatic/, "dark moody"],
    [/brighter|lighter|airy/, "bright airy natural light"],
    [/modern|contemporary/, "modern minimalist"],
    [/warm/, "warm tones"],
    [/professional|corporate/, "professional"],
    [/rustic|traditional/, "rustic"],
  ];
  const parts = rules.filter(([re]) => re.test(lower)).map(([, term]) => term);
  return parts.join(" ");
}
