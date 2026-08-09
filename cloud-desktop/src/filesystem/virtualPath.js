export const MAX_VIRTUAL_PATH_LENGTH = 1024;
export const MAX_VIRTUAL_SEGMENT_LENGTH = 120;

export class VirtualPathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VirtualPathError";
    this.code = code;
  }
}

const unsafeSegment = /[<>:"|?*\u0000-\u001f]/;
const hostPath = /^[a-zA-Z]:[\\/]/;

export function validateVirtualName(value) {
  const name = String(value ?? "").trim();
  if (!name) return { ok: false, code: "name_required" };
  if (name.length > MAX_VIRTUAL_SEGMENT_LENGTH) return { ok: false, code: "name_too_long" };
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) return { ok: false, code: "unsafe_name" };
  if (unsafeSegment.test(name) || /[. ]$/.test(name)) return { ok: false, code: "unsafe_name" };
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return { ok: false, code: "prohibited_name" };
  return { ok: true, name };
}

export function normalizeVirtualPath(input) {
  const source = String(input ?? "");
  if (source.includes("\0")) throw new VirtualPathError("null_byte", "Virtual paths cannot contain null bytes");
  if (hostPath.test(source)) throw new VirtualPathError("host_path", "Host filesystem paths are not accepted");
  const slashed = source.replace(/\\/g, "/");
  const rooted = slashed.startsWith("/") ? slashed : `/${slashed}`;
  const segments = [];
  for (const rawSegment of rooted.split("/")) {
    if (!rawSegment || rawSegment === ".") continue;
    if (rawSegment === "..") throw new VirtualPathError("path_traversal", "Path traversal is not allowed");
    const validation = validateVirtualName(rawSegment);
    if (!validation.ok) throw new VirtualPathError(validation.code, `Unsafe virtual path segment: ${rawSegment}`);
    segments.push(validation.name);
    if (segments.length > 100) throw new VirtualPathError("path_too_deep", "Virtual path is too deep");
  }
  const normalized = `/${segments.join("/")}`;
  if (normalized.length > MAX_VIRTUAL_PATH_LENGTH) throw new VirtualPathError("path_too_long", "Virtual path is too long");
  return normalized === "" ? "/" : normalized;
}

export function joinVirtualPath(parent, name) {
  const validation = validateVirtualName(name);
  if (!validation.ok) throw new VirtualPathError(validation.code, "Unsafe virtual item name");
  const base = normalizeVirtualPath(parent);
  return normalizeVirtualPath(`${base === "/" ? "" : base}/${validation.name}`);
}

export function parentVirtualPath(path) {
  const normalized = normalizeVirtualPath(path);
  if (normalized === "/") return null;
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "/" : normalized.slice(0, index);
}

export function basenameVirtualPath(path) {
  const normalized = normalizeVirtualPath(path);
  return normalized === "/" ? "/" : normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function virtualPathKey(path) {
  return normalizeVirtualPath(path).toLocaleLowerCase("en-US");
}

export function isSameOrDescendantPath(candidate, ancestor) {
  const candidateKey = virtualPathKey(candidate);
  const ancestorKey = virtualPathKey(ancestor);
  if (ancestorKey === "/") return true;
  return candidateKey === ancestorKey || candidateKey.startsWith(`${ancestorKey}/`);
}
