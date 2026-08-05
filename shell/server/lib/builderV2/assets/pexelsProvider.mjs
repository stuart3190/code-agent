// Pexels provider adapter (finish plan WP-7 / master plan Part 18).
//
// Everything Pexels-shaped lives HERE — the Asset Service and the builder never see a
// provider API. fetch is injectable so the whole service is provable on recorded payloads.
//
// C6 LICENSING GATE — terms verified against https://www.pexels.com/license/ on 2026-08-05:
//   free for commercial use · attribution NOT required ("not necessary but always
//   appreciated") · modification permitted · hotlinking the CDN supported. Prohibited:
//   reselling unaltered copies as physical products, redistribution on other stock
//   platforms, implying endorsement, trademark use, identifiable people in a bad light.
//   Storing optimised copies inside a customer's generated site is ordinary licensed use,
//   not stock redistribution. This snapshot is stamped on EVERY asset row so a later terms
//   change never silently relicenses old imagery.

export const PEXELS_LICENSE_SNAPSHOT = Object.freeze({
  name: "Pexels License",
  url: "https://www.pexels.com/license/",
  attributionRequired: false,
  commercialUse: true,
  modificationAllowed: true,
  prohibited: [
    "reselling unaltered copies as physical products",
    "redistribution on stock photo or wallpaper platforms",
    "implying endorsement by people or brands in the imagery",
    "use in trademarks or business names",
    "identifiable people shown in a bad light",
  ],
  verifiedAt: "2026-08-05",
});

const PEXELS_SEARCH = "https://api.pexels.com/v1/search";

export function pexelsProvider({ apiKey = process.env.PEXELS_API_KEY, fetchImpl = fetch } = {}) {
  return {
    name: "pexels",
    license: PEXELS_LICENSE_SNAPSHOT,
    configured() { return !!apiKey; },

    /** Normalized search: [{ id, urls, width, height, orientation, alt, photographer, tags }]. */
    async search(query, { orientation = "landscape", perPage = 8 } = {}) {
      if (!apiKey) throw new Error("pexels: no API key configured");
      const params = new URLSearchParams({ query: String(query), per_page: String(Math.min(Math.max(perPage, 1), 15)) });
      if (["landscape", "portrait", "square"].includes(orientation)) params.set("orientation", orientation);
      const res = await fetchImpl(`${PEXELS_SEARCH}?${params}`, { headers: { Authorization: apiKey } });
      if (!res.ok) throw new Error(`pexels search failed: HTTP ${res.status}`);
      const data = await res.json();
      return (data.photos || []).map((photo) => ({
        id: String(photo.id),
        urls: {
          original: photo.src?.original || null,
          large: photo.src?.large2x || photo.src?.large || photo.src?.original || null,
          thumb: photo.src?.medium || photo.src?.small || null,
        },
        width: photo.width || null,
        height: photo.height || null,
        orientation: photo.width && photo.height
          ? (photo.width > photo.height ? "landscape" : photo.width < photo.height ? "portrait" : "square")
          : null,
        alt: photo.alt || String(query),
        photographer: photo.photographer || null,
        tags: (photo.alt || "").toLowerCase().match(/[a-z]{4,}/g) || [],
      })).filter((photo) => photo.urls.large);
    },
  };
}
