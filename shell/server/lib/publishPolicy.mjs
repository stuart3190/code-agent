// Agent publish-policy evaluation.
//
// auto_publish skips the approval gate only when none of the run's touched paths match a
// protected glob. Matching is dependency-free: ** crosses directories, * and ? stay within
// one segment, and a bare directory pattern protects everything beneath it.

export function evaluatePublishPolicy(agent, statusOutput) {
  const mode = agent?.publish_mode === "auto_publish" ? "auto_publish" : "require_approval";
  const protectedPaths = Array.isArray(agent?.protected_paths) ? agent.protected_paths : [];
  const touched = touchedPathsFromStatus(statusOutput);
  const protectedTouched = touched.filter((path) =>
    protectedPaths.some((pattern) => matchesGlob(pattern, path)));
  if (mode === "auto_publish" && !protectedTouched.length) {
    return { action: "auto_publish", touched, protectedTouched: [] };
  }
  return {
    action: "require_approval",
    reason: mode === "auto_publish" ? "protected_path" : "policy",
    touched,
    protectedTouched,
  };
}

// Parses `git status --short` (including intent-to-add and renames) into repository paths.
export function touchedPathsFromStatus(statusOutput) {
  const paths = new Set();
  for (const line of String(statusOutput || "").split(/\r?\n/)) {
    if (line.length < 4) continue;
    let path = line.slice(3).trim();
    const rename = path.split(" -> ");
    if (rename.length === 2) {
      paths.add(unquote(rename[0]));
      path = rename[1];
    }
    if (path) paths.add(unquote(path));
  }
  return [...paths];
}

export function matchesGlob(pattern, path) {
  const normalized = String(pattern || "").replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized) return false;
  let source = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        source += ".*";
        i += 1;
        if (normalized[i + 1] === "/") i += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]]/g, "\\$&");
    }
  }
  // "src/config" also protects "src/config/anything".
  return new RegExp(`^${source}(?:/.*)?$`).test(String(path || "").replaceAll("\\", "/"));
}

function unquote(value) {
  const text = value.trim();
  return text.startsWith("\"") && text.endsWith("\"") ? text.slice(1, -1) : text;
}
