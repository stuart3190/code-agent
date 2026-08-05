// Asset optimisation (finish plan WP-7 / master plan Part 18 — V2-A2).
//
// sharp lives in the SHELL only, never in generated apps. Every chosen provider image is
// copied into thrallo-artifacts as AVIF + WebP responsive variants plus a tiny inline blur
// placeholder (LQIP), so previews never hotlink a provider CDN that may purge, and the
// scaffold's src/lib/assets.js helper can render picture/srcset/lazy/blur from the
// variants map alone. Optimisation is best-effort: any failure leaves the asset serving
// its original provider URLs — a build never blocks on image processing.

import crypto from "node:crypto";
import { serviceClient } from "../../supabase.mjs";

const ARTIFACT_BUCKET = process.env.CODE_AGENT_ARTIFACT_BUCKET || "thrallo-artifacts";
const ASSET_PREFIX = "bv2-assets";

/** Responsive rungs; each variant is generated only when the source is at least that wide. */
export const RESPONSIVE_WIDTHS = [640, 1280, 1920];
const BLUR_WIDTH = 16;

export function variantWidthsFor(sourceWidth) {
  const widths = RESPONSIVE_WIDTHS.filter((w) => w <= sourceWidth);
  return widths.length ? widths : [sourceWidth]; // small sources still get one variant
}

/**
 * createOptimiser — sharp, fetch and storage are all injectable so the pipeline is
 * provable on generated pixels with a capturing fake bucket (no network, no prod writes).
 */
export function createOptimiser({
  sharpImpl = null, fetchImpl = fetch, client = null, bucket = ARTIFACT_BUCKET,
} = {}) {
  let sharpPromise = null;
  const loadSharp = () => {
    if (sharpImpl) return Promise.resolve(sharpImpl);
    if (!sharpPromise) sharpPromise = import("sharp").then((m) => m.default);
    return sharpPromise;
  };
  const storageClient = () => client || serviceClient();

  return {
    /**
     * Download the original, emit AVIF+WebP at each eligible width plus the blur LQIP,
     * upload everything under bv2-assets/<owner>/<contentHash>/, and return the fields
     * persistAsset merges onto the asset row.
     */
    async optimise(owner, { url, alt = "" }) {
      const sharp = await loadSharp();
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`asset download failed: HTTP ${res.status}`);
      const original = Buffer.from(await res.arrayBuffer());
      const contentHash = crypto.createHash("sha256").update(original).digest("hex");
      const meta = await sharp(original).metadata();
      const widths = variantWidthsFor(meta.width || RESPONSIVE_WIDTHS[0]);

      const supa = storageClient();
      const basePath = `${ASSET_PREFIX}/${owner}/${contentHash}`;
      const variants = { avif: [], webp: [], blur: null };

      async function put(path, bytes, contentType) {
        const { error } = await supa.storage.from(bucket)
          .upload(path, bytes, { upsert: true, contentType });
        if (error) throw new Error(`asset variant upload: ${error.message}`);
      }
      const publicUrl = (path) => supa.storage.from(bucket).getPublicUrl(path)?.data?.publicUrl || null;

      for (const width of widths) {
        const resized = sharp(original).resize({ width, withoutEnlargement: true });
        const [avif, webp] = await Promise.all([
          resized.clone().avif({ quality: 55 }).toBuffer(),
          resized.clone().webp({ quality: 78 }).toBuffer(),
        ]);
        await put(`${basePath}/${width}.avif`, avif, "image/avif");
        await put(`${basePath}/${width}.webp`, webp, "image/webp");
        variants.avif.push({ width, path: `${basePath}/${width}.avif`, url: publicUrl(`${basePath}/${width}.avif`) });
        variants.webp.push({ width, path: `${basePath}/${width}.webp`, url: publicUrl(`${basePath}/${width}.webp`) });
      }

      const blurBytes = await sharp(original)
        .resize({ width: BLUR_WIDTH }).webp({ quality: 30 }).toBuffer();
      variants.blur = `data:image/webp;base64,${blurBytes.toString("base64")}`;

      const primary = variants.webp[variants.webp.length - 1];
      return {
        content_hash: contentHash,
        storage_path: basePath,
        optimised_url: primary.url,
        variants,
        width: meta.width || null,
        height: meta.height || null,
        alt,
      };
    },
  };
}
