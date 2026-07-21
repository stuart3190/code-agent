// Premium design direction for generated apps. This module is deliberately pure: the shell
// supplies the model call and image search, while tests can prove selection/normalisation/audits
// without credentials or spend.

export const DESIGN_PRESETS = [
  "auto", "editorial-luxury", "bold-expressive", "warm-organic",
  "clean-saas", "technical-dark", "playful",
];

const FONT_PAIRS = {
  "space-manrope": {
    id: "space-manrope", bodyPackage: "@fontsource-variable/manrope", bodyFamily: "Manrope Variable",
    displayPackage: "@fontsource-variable/space-grotesk", displayFamily: "Space Grotesk Variable",
  },
  "newsreader-dm": {
    id: "newsreader-dm", bodyPackage: "@fontsource-variable/dm-sans", bodyFamily: "DM Sans Variable",
    displayPackage: "@fontsource-variable/newsreader", displayFamily: "Newsreader Variable",
  },
  "sora-dm": {
    id: "sora-dm", bodyPackage: "@fontsource-variable/dm-sans", bodyFamily: "DM Sans Variable",
    displayPackage: "@fontsource-variable/sora", displayFamily: "Sora Variable",
  },
  "jakarta-sora": {
    id: "jakarta-sora", bodyPackage: "@fontsource-variable/plus-jakarta-sans", bodyFamily: "Plus Jakarta Sans Variable",
    displayPackage: "@fontsource-variable/sora", displayFamily: "Sora Variable",
  },
  "newsreader-manrope": {
    id: "newsreader-manrope", bodyPackage: "@fontsource-variable/manrope", bodyFamily: "Manrope Variable",
    displayPackage: "@fontsource-variable/newsreader", displayFamily: "Newsreader Variable",
  },
  "space-dm": {
    id: "space-dm", bodyPackage: "@fontsource-variable/dm-sans", bodyFamily: "DM Sans Variable",
    displayPackage: "@fontsource-variable/space-grotesk", displayFamily: "Space Grotesk Variable",
  },
};

const FAMILIES = [
  { id: "cinematic-split", categories: ["marketing", "content"], presets: ["auto", "bold-expressive", "technical-dark"], font: "space-dm", composition: "cinematic split-screen with an asymmetrical, image-led opening", motif: "cropped photography crossing the content grid" },
  { id: "editorial-magazine", categories: ["marketing", "content"], presets: ["auto", "editorial-luxury"], font: "newsreader-dm", composition: "editorial magazine rhythm with offset columns and strong typographic contrast", motif: "numbered sections and fine rules" },
  { id: "gallery-first", categories: ["marketing", "content"], presets: ["auto", "warm-organic", "bold-expressive"], font: "newsreader-manrope", composition: "gallery-first composition with layered captions and varied image scale", motif: "full-width visual moments between compact copy" },
  { id: "luxury-minimal", categories: ["marketing", "content"], presets: ["auto", "editorial-luxury"], font: "newsreader-manrope", composition: "luxury minimal composition with generous negative space and restrained navigation", motif: "oversized editorial type paired with quiet detail" },
  { id: "bold-poster", categories: ["marketing", "content"], presets: ["auto", "bold-expressive", "playful"], font: "sora-dm", composition: "bold poster-like composition with purposeful scale changes and strong blocks", motif: "one memorable oversized typographic statement" },
  { id: "story-led", categories: ["marketing", "content"], presets: ["auto", "warm-organic"], font: "newsreader-dm", composition: "warm story-led flow with human photography and an irregular editorial cadence", motif: "handmade-feeling labels and narrative section transitions" },
  { id: "canvas-first", categories: ["saas", "utility", "interactive"], presets: ["auto", "clean-saas", "playful"], font: "jakarta-sora", composition: "canvas-first product workspace where the primary task owns most of the viewport", motif: "tools orbit a dominant interactive surface" },
  { id: "command-workspace", categories: ["saas", "utility", "interactive"], presets: ["auto", "technical-dark"], font: "space-dm", composition: "command workspace with compact navigation and a focused central work area", motif: "keyboard-forward controls and precise status language" },
  { id: "data-cockpit", categories: ["saas", "utility"], presets: ["auto", "clean-saas", "technical-dark"], font: "sora-dm", composition: "data cockpit with a strong information hierarchy rather than a marketing hero", motif: "one dominant metric or visualisation anchoring the screen" },
  { id: "calm-productivity", categories: ["saas", "utility"], presets: ["auto", "clean-saas", "warm-organic"], font: "jakarta-sora", composition: "calm productivity layout with lightweight chrome and progressive disclosure", motif: "soft grouping without a wall of identical cards" },
  { id: "modular-product", categories: ["saas", "utility", "interactive"], presets: ["auto", "playful", "bold-expressive"], font: "sora-dm", composition: "modular product layout with varied block sizes and a clear primary workflow", motif: "expressive status blocks mixed with functional controls" },
  { id: "split-navigation", categories: ["saas", "utility"], presets: ["auto", "editorial-luxury", "clean-saas"], font: "newsreader-dm", composition: "split-navigation application with a persistent contextual rail and editorial content area", motif: "section identity changes through type and spacing, not repeated cards" },
];

const PALETTES = {
  "editorial-luxury": "ink, warm ivory, muted stone and one deep jewel accent",
  "bold-expressive": "high-contrast neutrals with one vivid, confident accent",
  "warm-organic": "warm mineral neutrals, natural greens or clay, and soft contrast",
  "clean-saas": "cool clean neutrals with a crisp blue, teal or violet accent",
  "technical-dark": "near-black layered surfaces with a luminous cool accent",
  playful: "bright but controlled colour with one dominant accent and friendly contrast",
  auto: "a category-specific palette that does not resemble the scaffold blue defaults",
};

const AUTO_PALETTES = [
  "charcoal, parchment and oxidised copper",
  "midnight navy, chalk and electric citron",
  "deep forest, limestone and muted terracotta",
  "aubergine, fog grey and sharp coral",
  "espresso, warm cream and mineral blue",
  "graphite, cool white and vivid cobalt",
];

function hash(input) {
  let h = 2166136261;
  for (const c of String(input || "")) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function inferCategory(prompt = "") {
  const p = String(prompt).toLowerCase();
  if (/game|builder|editor|canvas|playground|simulator/.test(p)) return "interactive";
  if (/dashboard|analytics|crm|saas|admin|portal|workspace|project management/.test(p)) return "saas";
  if (/calculator|tracker|todo|utility|converter|planner|form/.test(p)) return "utility";
  if (/portfolio|blog|magazine|news|gallery|event/.test(p)) return "content";
  return "marketing";
}

export function normalizeStyle(style = {}) {
  const preset = DESIGN_PRESETS.includes(style?.preset) ? style.preset : "auto";
  return { preset, notes: String(style?.notes || "").trim().slice(0, 500) };
}

export function fallbackDesignProfile({ prompt, projectId, style } = {}) {
  const cleanStyle = normalizeStyle(style);
  const category = inferCategory(prompt);
  let candidates = FAMILIES.filter((f) => f.categories.includes(category) && f.presets.includes(cleanStyle.preset));
  if (!candidates.length) candidates = FAMILIES.filter((f) => f.categories.includes(category));
  const family = candidates[hash(`${projectId}|${prompt}|${cleanStyle.preset}`) % candidates.length];
  const consumer = category === "marketing" || category === "content";
  const palette = cleanStyle.preset === "auto"
    ? AUTO_PALETTES[hash(`${projectId}|${prompt}|palette`) % AUTO_PALETTES.length]
    : PALETTES[cleanStyle.preset];
  return {
    version: 2,
    preset: cleanStyle.preset,
    notes: cleanStyle.notes,
    seed: String(projectId || "new"),
    category,
    family: family.id,
    concept: `${family.composition}; make the result specific to ${String(prompt || "the product").slice(0, 120)}${cleanStyle.notes ? `; custom direction: ${cleanStyle.notes}` : ""}`,
    palette: palette || PALETTES.auto,
    typography: { ...FONT_PAIRS[family.font] },
    composition: family.composition,
    density: ["saas", "utility"].includes(category) ? "compact but breathable" : "expressive with deliberate whitespace",
    imagery: {
      required: consumer,
      queries: consumer ? [String(prompt || "premium business").slice(0, 100), `${category} authentic people details`] : [],
      placements: consumer ? ["primary opening visual", "at least two supporting content moments"] : [],
    },
    signature: [family.motif, "a composition that would still be recognisable with the logo removed"],
    avoid: ["generic centered hero followed by equal card grids", "default scaffold-blue palette", "identical rounded cards for every section", "decorative gradients used as a substitute for art direction"],
  };
}

export function normalizeDesignProfile(candidate, context = {}) {
  const fallback = fallbackDesignProfile(context);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return fallback;
  const family = FAMILIES.find((f) => f.id === candidate.family && f.categories.includes(candidate.category || fallback.category))
    || FAMILIES.find((f) => f.id === fallback.family);
  const category = ["marketing", "content", "saas", "utility", "interactive"].includes(candidate.category)
    ? candidate.category : fallback.category;
  const pair = FONT_PAIRS[candidate.fontPair] || FONT_PAIRS[candidate.typography?.id] || fallback.typography;
  const consumer = category === "marketing" || category === "content";
  const strings = (value, fallbackValue, max = 4) => Array.isArray(value)
    ? value.map((v) => String(v).trim()).filter(Boolean).slice(0, max) : fallbackValue;
  return {
    ...fallback,
    preset: DESIGN_PRESETS.includes(candidate.preset) ? candidate.preset : fallback.preset,
    notes: typeof candidate.notes === "string" ? candidate.notes.trim().slice(0, 500) : fallback.notes,
    category,
    family: family?.id || fallback.family,
    concept: String(candidate.concept || fallback.concept).slice(0, 500),
    palette: String(candidate.palette || fallback.palette).slice(0, 240),
    typography: { ...pair },
    composition: String(candidate.composition || family?.composition || fallback.composition).slice(0, 500),
    density: String(candidate.density || fallback.density).slice(0, 120),
    imagery: {
      required: consumer,
      queries: strings(candidate.imagery?.queries, fallback.imagery.queries, 3),
      placements: strings(candidate.imagery?.placements, fallback.imagery.placements, 4),
    },
    signature: strings(candidate.signature, fallback.signature, 4),
    avoid: [...new Set([...fallback.avoid, ...strings(candidate.avoid, [], 4)])].slice(0, 7),
  };
}

export const DESIGN_DIRECTOR_SYSTEM_PROMPT = `You are the design director for a premium web-app builder.
Return ONLY valid JSON, with no markdown. Choose an art direction specific to the requested product.
Do not default to the common SaaS recipe of a translucent top bar, centered hero, two CTA buttons,
radial glow and equal card grid. The result must have a recognisable visual idea and a composition
suited to its real use.

Allowed categories: marketing, content, saas, utility, interactive.
Allowed layout families: ${FAMILIES.map((f) => f.id).join(", ")}.
Allowed fontPair values: ${Object.keys(FONT_PAIRS).join(", ")}.

JSON shape:
{"category":"...","family":"...","concept":"...","palette":"...","fontPair":"...","composition":"...","density":"...","imagery":{"queries":["..."],"placements":["..."]},"signature":["..."],"avoid":["..."]}

Use the requested preset and custom notes as hard direction. Marketing/content sites need authentic
photography queries. SaaS, utilities and interactive apps should prioritise the product surface and
need not use stock photography. Their first signed-out viewport must visibly showcase the real product
surface with realistic seeded content; a login form, headline and feature grid are not a substitute.`;

export function parseDesignProfile(text, context = {}) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return normalizeDesignProfile(JSON.parse(raw), context); }
  catch { return fallbackDesignProfile(context); }
}

export function renderDesignBrief(profile, assets = []) {
  const photos = assets.length
    ? `\nAPPROVED PHOTOGRAPHY — use at least ${Math.min(3, assets.length)} DISTINCT URLs below in meaningful placements:\n${assets.map((p, i) => `${i + 1}. ${p.url} — ${p.alt || "contextual photo"}`).join("\n")}`
    : profile.imagery.required ? "\nPhotography was unavailable. Use the intentional type/vector-led fallback described by the caller; never invent URLs." : "";
  const productProof = ["saas", "utility", "interactive"].includes(profile.category)
    ? `\n- First-view product proof: open directly on a substantial, usable product surface with realistic in-memory seed content. Treat that workspace/dashboard/editor as the hero. Keep sign-in secondary for saving or syncing; never gate the product behind auth or substitute a headline + feature grid + form for the actual interface.`
    : "";
  return `PROJECT-SPECIFIC DESIGN BRIEF (treat as a build requirement):
- Category: ${profile.category}
- Layout family: ${profile.family}
- Concept: ${profile.concept}
- Custom direction: ${profile.notes || "none; make product-specific decisions"}
- Composition: ${profile.composition}
- Palette: ${profile.palette}
- Typography: import ${profile.typography.bodyPackage} for body (${profile.typography.bodyFamily}) and ${profile.typography.displayPackage} for display (${profile.typography.displayFamily}); set --font-sans and --font-display in src/index.css to those exact family names.
- Density: ${profile.density}
- Signature details: ${profile.signature.join("; ")}
- Avoid: ${profile.avoid.join("; ")}
This brief OVERRIDES the generic design defaults. Do not merely recolour the usual header/hero/card template.${productProof}${photos}`;
}

export function auditDesign(tree, { profile, assets = [], imageUnavailable = false } = {}) {
  const source = Object.values(tree || {}).filter((v) => typeof v === "string").join("\n");
  const app = String(tree?.["src/App.jsx"] || "");
  const css = String(tree?.["src/index.css"] || "");
  const main = String(tree?.["src/main.jsx"] || "");
  const issues = [];
  const warnings = [];
  if (!profile) return { ok: true, issues, warnings };

  if (!main.includes(profile.typography.bodyPackage) || !main.includes(profile.typography.displayPackage)) {
    issues.push("Apply the selected self-hosted body and display font imports in src/main.jsx.");
  }
  if (!css.includes(profile.typography.bodyFamily) || !css.includes(profile.typography.displayFamily)) {
    issues.push("Wire the selected font families into the Tailwind font-sans and font-display configuration.");
  }
  const scaffoldDefaults = ["--primary: 221.2 83.2% 53.3%", "--background: 0 0% 100%", "--radius: 0.5rem"];
  if (scaffoldDefaults.filter((v) => css.includes(v)).length >= 2) {
    issues.push("Replace the scaffold default palette/radius with the design brief's specific visual system.");
  }
  if (!/(sm:|md:|lg:|xl:)/.test(app)) issues.push("Add explicit responsive layout behaviour for phone and desktop widths.");
  const productCategory = ["saas", "utility", "interactive"].includes(profile.category);
  const authGate = /if\s*\(\s*(?:!\s*user|user\s*===?\s*null)\s*\)\s*return\s*\(?\s*<\s*(?:Auth|Login|SignIn)\w*/i.test(app)
    || /(?:!\s*user|user\s*===?\s*null)\s*\?\s*<\s*(?:Auth|Login|SignIn)\w*/i.test(app);
  if (productCategory && authGate) {
    issues.push("Remove the full-app authentication gate. The first signed-out screen must expose the real product workspace with realistic in-memory seed content; offer sign-in only as a secondary save/sync action.");
  }
  if (/images\.unsplash\.com|picsum\.photos|placehold\.co|placeholder\.com/i.test(source)) {
    issues.push("Remove invented or placeholder image hosts; use only approved returned image URLs.");
  }
  if (profile.imagery.required && assets.length) {
    const used = new Set(assets.filter((p) => source.includes(p.url)).map((p) => p.url)).size;
    const required = Math.min(3, assets.length);
    if (used < required) issues.push(`Use at least ${required} distinct approved photographs in meaningful hero/section placements (currently ${used}).`);
  } else if (profile.imagery.required && imageUnavailable) {
    warnings.push("Photo search was unavailable after retry; the app used the deliberate image-free fallback.");
  }
  return { ok: issues.length === 0, issues, warnings };
}

export const DESIGN_FAMILY_IDS = FAMILIES.map((f) => f.id);
