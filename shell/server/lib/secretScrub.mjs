// Canonical export-secret rules. Exports remove secret-bearing paths, then refuse the artifact if
// platform or provider credentials remain in any retained file.

// ── The rules ───────────────────────────────────────────────────────────────────────────

// Whole files that must never leave the platform, matched on path.
export const SECRET_PATH = /(^|\/)\.env(\.|$)|(^|\/)\.npmrc$|(^|\/)(secrets?|credentials?)\.(json|ya?ml|txt)$|\.pem$|\.key$/i;

// Platform secrets that must never appear in an artifact handed to a user, in any form.
// `sk_` is case-sensitive (Stripe); the rest are matched case-insensitively.
export const PLATFORM_SECRET_MARKERS = [
  "SUPABASE_SERVICE_ROLE",
  "STRIPE_SECRET_KEY",
  "BYOK_ENC_KEY",
  "CLOUDFLARE_API_TOKEN",
  "PLATFORM_ENC_KEY",
  "THRALLO_STRIPE_SECRET_KEY",
  "sk_",
];

// Provider API keys, by their published prefixes. A user's own key must not travel either.
export const PROVIDER_KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/;

// ── Assertion (export): refuse to produce the artifact at all ───────────────────────────

// Returns the markers found, so callers can decide whether to throw or report.
export function findPlatformSecrets(files) {
  const joined = Object.entries(files || {})
    .map(([path, contents]) => `${path}\n${contents}`)
    .join("\n");
  const upper = joined.toUpperCase();
  const leaked = PLATFORM_SECRET_MARKERS.filter((marker) =>
    (marker === "sk_" ? joined.includes(marker) : upper.includes(marker.toUpperCase())));
  const providerKey = PROVIDER_KEY_PATTERN.exec(joined);
  if (providerKey) leaked.push(`provider key (${providerKey[1].slice(0, 6)}…)`);
  return leaked;
}

export function assertNoPlatformSecrets(files) {
  const leaked = findPlatformSecrets(files);
  if (leaked.length) {
    throw new Error(`Export contains forbidden secret markers: ${leaked.join(", ")}`);
  }
}

// Files that are never worth shipping in an export: build output, dependencies, local state.
export const EXCLUDED_FROM_EXPORT = /(^|\/)(node_modules|dist|build|\.next|\.turbo|coverage|\.git|\.vercel|\.cache)(\/|$)|(^|\/)\.DS_Store$/;

export function stripExportNoise(files) {
  const out = {};
  let removed = 0;
  for (const [path, contents] of Object.entries(files || {})) {
    if (EXCLUDED_FROM_EXPORT.test(path) || SECRET_PATH.test(path)) { removed += 1; continue; }
    out[path] = contents;
  }
  return { files: out, removed };
}
