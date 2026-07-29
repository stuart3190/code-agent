import path from "node:path";

// Resolve a URL pathname beneath the built web root. URL paths are normalised to forward
// slashes first so the same traversal checks hold on Windows development machines and Linux
// production hosts. A null result is deliberately indistinguishable from a missing asset.
export function resolveStaticPath(root, rawPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rawPathname || "/"));
  } catch {
    return null;
  }

  const rootPath = path.resolve(root);
  const relativeUrlPath = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
  const candidate = path.resolve(rootPath, relativeUrlPath);
  const relative = path.relative(rootPath, candidate);

  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
}
