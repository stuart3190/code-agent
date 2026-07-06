// Stock images (Pexels) — the engine's search_images tool backend. Server-side key only
// (gitignored shell/.env: PEXELS_API_KEY); the generated app receives plain CDN URLs, never
// the key. Feature is fully optional: no key -> imagesConfigured() false -> the tool and its
// prompt addendum are simply not offered (generation is unchanged).
//
// Pexels photos are free for commercial use, no attribution required (photographer name is
// returned anyway so apps CAN credit). Hotlinking the images.pexels.com CDN is supported.

const PEXELS_SEARCH = "https://api.pexels.com/v1/search";

export function imagesConfigured() {
  return !!process.env.PEXELS_API_KEY;
}

export async function searchImages(query, { count = 5, orientation = "landscape" } = {}) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw new Error("PEXELS_API_KEY is not set");
  const perPage = Math.min(Math.max(Number(count) || 5, 1), 8);
  const params = new URLSearchParams({ query: String(query), per_page: String(perPage) });
  if (["landscape", "portrait", "square"].includes(orientation)) params.set("orientation", orientation);
  const res = await fetch(`${PEXELS_SEARCH}?${params}`, { headers: { Authorization: key } });
  if (!res.ok) throw new Error(`pexels search failed: HTTP ${res.status}`);
  const data = await res.json();
  return (data.photos || []).map((p) => ({
    url: p.src?.large2x || p.src?.large || p.src?.original,
    alt: p.alt || String(query),
    photographer: p.photographer,
    width: p.width,
    height: p.height,
  })).filter((p) => p.url);
}

// JSON-schema tool declaration, same shape as makeFileTools' schemas (provider-agnostic).
export const SEARCH_IMAGES_SCHEMA = {
  name: "search_images",
  description:
    "Search a stock-photo library for real, working, contextually relevant photos. Returns { photos: [{ url, alt, photographer }] }. Use the returned url values in <img> tags with the alt text. Never invent image URLs.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What the photo should show, e.g. 'barber cutting hair'" },
      count: { type: "number", description: "How many photos (1-8, default 5)" },
      orientation: { type: "string", enum: ["landscape", "portrait", "square"], description: "Photo orientation (default landscape)" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

// System-prompt addendum offered only when the key is present.
export const IMAGES_PROMPT_BLOCK = `
Images:
- Real stock photos are available via the search_images tool. For marketing/site-style builds
  (businesses, landing pages, portfolios), fetch contextually relevant photos — a hero image and
  section imagery — and use the returned url in <img> (or CSS background) with the alt text.
- One or two search_images calls with well-chosen queries beat many; pick from the returned set.
- NEVER invent or recall image URLs from memory (no unsplash/picsum/placeholder links) — only use
  URLs returned by search_images. Give images proper alt text and object-cover sizing.
- Tools and dashboards usually need NO photography — don't force imagery onto utility apps.`;
