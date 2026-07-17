// Shared Android-link helpers — imported by both the publish core (which injects assetlinks into
// EVERY publish once a project has a signing key, so republishing never breaks an installed app)
// and the Android export. Kept separate to avoid a publish.mjs <-> android.mjs import cycle.

// Android application-id segments must match [a-z][a-z0-9_]* — slugs carry dashes, so underscore
// them and guard a leading digit. Permanent per Play listing once chosen.
export function packageIdFor(slug) {
  let seg = String(slug || "app").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!seg || /^[0-9]/.test(seg)) seg = `a_${seg}`;
  return `com.buildr101.app_${seg}`;
}

// Digital Asset Links — the file the app's origin must serve so the TWA runs without a URL bar.
export function assetlinksJson(packageId, fingerprint) {
  return JSON.stringify([{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: packageId,
      sha256_cert_fingerprints: [String(fingerprint).trim().toUpperCase()],
    },
  }], null, 2);
}
