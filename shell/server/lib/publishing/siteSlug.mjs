// Shared DNS-label normalisation for every Thrallo publishing surface.

export function slugifySiteName(name) {
  return String(name || "").toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}
