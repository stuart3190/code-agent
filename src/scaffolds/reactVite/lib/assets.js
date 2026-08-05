// Platform asset helpers (Builder v2, master plan Part 18) — maintained infrastructure.
// Generated code IMPORTS these to render the imagery the Asset Service resolved; it never
// hardcodes provider URLs or its own <img> plumbing. Headless by design: these build
// props/values only — components spread them onto <img>/<source> however the design wants.
//
// Asset objects are the constants the builder injects (src/lib/assetData.js): either a
// resolved image { alt_text, original_url, optimised_url?, width, height,
// variants?: { avif: [{width,url}], webp: [{width,url}], blur } } or a branded
// placeholder { placeholder: true, css, alt } that renders as a gradient block.

export function isPlaceholder(asset) {
  return !!asset?.placeholder;
}

/** Inline style for a placeholder slot (and the blur-up backdrop behind real images). */
export function placeholderStyle(asset) {
  if (asset?.placeholder) return { background: asset.css };
  if (asset?.variants?.blur) {
    return {
      backgroundImage: `url(${asset.variants.blur})`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  }
  return {};
}

function srcSetOf(entries) {
  const usable = (entries || []).filter((e) => e && e.url);
  return usable.length ? usable.map((e) => `${e.url} ${e.width}w`).join(", ") : null;
}

/** <source> descriptors for a <picture>: AVIF first, WebP second; [] when unoptimised. */
export function pictureSources(asset, { sizes = "100vw" } = {}) {
  const sources = [];
  const avif = srcSetOf(asset?.variants?.avif);
  const webp = srcSetOf(asset?.variants?.webp);
  if (avif) sources.push({ type: "image/avif", srcSet: avif, sizes });
  if (webp) sources.push({ type: "image/webp", srcSet: webp, sizes });
  return sources;
}

/**
 * Props for the fallback <img> inside a <picture> (or standalone): lazy, async-decoded,
 * dimensioned against layout shift, blur backdrop until the real pixels arrive.
 * Usage: <img {...imageProps(assets.hero)} className="..." />
 */
export function imageProps(asset, { sizes = "100vw", loading = "lazy" } = {}) {
  if (!asset || asset.placeholder) return null;
  const webp = srcSetOf(asset.variants?.webp);
  return {
    src: asset.optimised_url || asset.original_url,
    ...(webp ? { srcSet: webp, sizes } : {}),
    alt: asset.alt_text || asset.alt || "",
    ...(asset.width ? { width: asset.width } : {}),
    ...(asset.height ? { height: asset.height } : {}),
    loading,
    decoding: "async",
    style: placeholderStyle(asset),
  };
}
