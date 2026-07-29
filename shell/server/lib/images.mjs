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
    "Search a stock-photo library for real, working, contextually relevant photos. Returns { photos: [{ url, alt, photographer }] }. Call this FIRST when building anything consumer-facing (business sites, shops, portfolios, landing pages) — real photography is the default for those apps. Use the returned url values in <img> tags with the alt text. Never invent image URLs.",
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
Photography (REQUIRED for consumer-facing apps and SaaS launch pages):
- Real stock photos are available via the search_images tool, and using them is the DEFAULT, not
  an option. If the app has ANY public-facing or content surface — a business site, shop,
  restaurant, salon, gym, portfolio, SaaS launch page, event, travel, food, property, blog, product
  page — your FIRST tool call is search_images. A hero without a real photo, or a business site
  made only of colour blocks, is a DEFECT: it will read as unfinished and the user will reject it.
- Fetch a hero image AND section imagery (services, menu items, gallery, about). One or two
  search_images calls with well-chosen queries (count 5-8) usually cover the whole app — pick the
  best from the returned set and reuse the batch across sections.
- Use the returned url values in <img> tags (or CSS backgrounds) with the alt text provided,
  sized with object-cover. Photos should carry the design: full-bleed heroes, image cards,
  gallery grids — not thumbnails squeezed into corners.
- NEVER invent or recall image URLs from memory (no unsplash/picsum/placeholder links) — only use
  URLs returned by search_images.
- SaaS must combine contextually relevant photography with a substantial, realistic product UI
  mockup in the hero and screenshot-led feature sections. A plain dashboard screenshot by itself is
  not a launch page, and three icon cards are not visual storytelling.
- The ONLY apps that skip photography are pure utilities or private-only admin tools with no public
  marketing surface. If in doubt, fetch photos.`;
