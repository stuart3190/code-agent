// Minimal, dependency-free semantic-version arithmetic for module resolution.
//
// Supports exact versions, caret (^), tilde (~), comparator sets (">=1.2.0 <2.0.0"), wildcards
// ("1.x", "1", "*") and "||" alternatives. Pre-release tags are compared lexically after the
// numeric triple. Nothing else — a module range is a small, reviewed string, not npm's grammar.

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value) {
  const match = VERSION.exec(String(value || "").trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] || null };
}

export function compareVersions(a, b) {
  const left = typeof a === "string" ? parseVersion(a) : a;
  const right = typeof b === "string" ? parseVersion(b) : b;
  if (!left || !right) throw new Error(`invalid semantic version: ${!left ? a : b}`);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

function partial(value) {
  const parts = String(value).replace(/^v/, "").split(".");
  const num = (part) => (part === undefined || part === "x" || part === "X" || part === "*" ? null : Number(part));
  return { major: num(parts[0]), minor: num(parts[1]), patch: num(parts[2]) };
}

function comparatorsFor(token) {
  const text = String(token).trim();
  if (!text || text === "*" || text === "x" || text === "X") return [];
  const op = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(text);
  const operator = op[1] || "";
  const base = partial(op[2]);
  if (base.major === null || Number.isNaN(base.major)) throw new Error(`invalid version range: ${token}`);
  const floor = { major: base.major, minor: base.minor ?? 0, patch: base.patch ?? 0, prerelease: null };
  if (operator === ">=" || operator === ">" || operator === "<" || operator === "<=") {
    return [{ operator, version: floor }];
  }
  if (operator === "^") {
    const ceiling = floor.major > 0 ? { major: floor.major + 1, minor: 0, patch: 0, prerelease: null }
      : floor.minor > 0 || base.minor === null ? { major: 0, minor: floor.minor + 1, patch: 0, prerelease: null }
        : { major: 0, minor: 0, patch: floor.patch + 1, prerelease: null };
    return [{ operator: ">=", version: floor }, { operator: "<", version: ceiling }];
  }
  if (operator === "~") {
    const ceiling = base.minor === null ? { major: floor.major + 1, minor: 0, patch: 0, prerelease: null }
      : { major: floor.major, minor: floor.minor + 1, patch: 0, prerelease: null };
    return [{ operator: ">=", version: floor }, { operator: "<", version: ceiling }];
  }
  // exact or wildcard partial ("1", "1.2", "1.x")
  if (base.minor === null) {
    return [{ operator: ">=", version: floor }, { operator: "<", version: { major: floor.major + 1, minor: 0, patch: 0, prerelease: null } }];
  }
  if (base.patch === null) {
    return [{ operator: ">=", version: floor }, { operator: "<", version: { major: floor.major, minor: floor.minor + 1, patch: 0, prerelease: null } }];
  }
  return [{ operator: "=", version: floor }];
}

function holds(comparator, version) {
  const order = compareVersions(version, comparator.version);
  switch (comparator.operator) {
    case ">=": return order >= 0;
    case ">": return order > 0;
    case "<": return order < 0;
    case "<=": return order <= 0;
    default: return order === 0;
  }
}

/** True when `version` satisfies `range`. An empty or "*" range accepts every version. */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`invalid semantic version: ${version}`);
  const alternatives = String(range ?? "*").split("||").map((part) => part.trim());
  return alternatives.some((alternative) => alternative.split(/\s+/).filter(Boolean)
    .flatMap(comparatorsFor).every((comparator) => holds(comparator, parsed)));
}

/** The highest version in `versions` that satisfies every range, or null. */
export function maxSatisfying(versions, ranges = []) {
  const candidates = versions.filter((version) => ranges.every((range) => satisfiesRange(version, range)));
  return candidates.sort(compareVersions).at(-1) || null;
}

export const majorOf = (version) => parseVersion(version)?.major ?? null;
