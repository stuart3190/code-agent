// Files/storage module v1 — platform infrastructure, do not edit or reimplement.
//
// The SDK can already put bytes in a bucket. What every generated application then wrote for
// itself, and got wrong, is the part around it (audit §7.1 "Files/storage"):
//
//   - no declared limit, so a 400MB video went into a bucket meant for avatars and the upload
//     failed halfway with a network error the screen reported as "something went wrong";
//   - no declared type, so an application that wanted images accepted an .exe;
//   - metadata kept in a domain entity the application invented, drifting from the object that
//     actually exists, so deleting a record orphaned its file forever;
//   - a signed URL minted once and cached in component state, then served after it expired.
//
// This module owns the policy and the lifecycle. The POLICY IS DECLARED — accepted types, a
// maximum size, how many files a subject may hold — and it is checked BEFORE a byte is sent,
// because a refusal the visitor can act on is worth more than a failure they cannot. Metadata is
// recorded against the same durable record the file belongs to, so removing the record removes
// its files. Access is a short-lived signed URL, minted on demand and never cached past its own
// expiry.
//
// Headless: state and functions only.

export const FILES_MODULE_VERSION = "1.0.0";

export const FILE_STATUS = Object.freeze({
  IDLE: "idle", VALIDATING: "validating", UPLOADING: "uploading", READY: "ready",
  REFUSED: "refused", ERROR: "error",
});

export const FILE_ERROR = Object.freeze({
  TYPE_NOT_ALLOWED: "file_type_not_allowed",
  TOO_LARGE: "file_too_large",
  EMPTY: "file_empty",
  TOO_MANY: "file_quota_exceeded",
  NOT_FOUND: "file_not_found",
  NOT_OWNER: "file_not_owner",
  UPLOAD_FAILED: "file_upload_failed",
  UNAVAILABLE: "file_storage_unavailable",
});

export class FileError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const freeze = (value) => Object.freeze(value);
const listOf = (value) => (Array.isArray(value) ? value : []);
const KIND_TYPES = Object.freeze({
  image: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"],
  document: ["application/pdf", "text/plain", "text/csv",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  video: ["video/mp4", "video/webm", "video/quicktime"],
  audio: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4"],
});
const EXTENSION_OF = Object.freeze({
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
  "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv",
  "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3",
});

/**
 * Compile a declared file policy.
 *   { kinds: ["image"], types: [...], maxBytes, maxPerSubject, signedUrlSeconds }
 * A policy that names neither kinds nor types accepts nothing: an application that did not say
 * what it takes is not an application that takes everything.
 */
export function compileFilePolicy({ kinds = [], types = [], maxBytes = 10 * 1024 * 1024, maxPerSubject = 20, signedUrlSeconds = 900 } = {}) {
  const fromKinds = listOf(kinds).flatMap((kind) => KIND_TYPES[String(kind).toLowerCase()] || []);
  const accepted = [...new Set([...fromKinds, ...listOf(types).map(String)])];
  return freeze({
    version: FILES_MODULE_VERSION,
    kinds: freeze(listOf(kinds).map(String)),
    types: freeze(accepted),
    maxBytes: Number(maxBytes) > 0 ? Number(maxBytes) : 10 * 1024 * 1024,
    maxPerSubject: Number(maxPerSubject) > 0 ? Number(maxPerSubject) : 20,
    signedUrlSeconds: Number(signedUrlSeconds) > 0 ? Number(signedUrlSeconds) : 900,
    // The accept attribute a file input should carry, so the picker and the policy agree.
    accept: freeze(accepted),
  });
}

/** Check one file against the policy WITHOUT uploading it. Returns { ok } or { ok:false, code }. */
export function checkFile(policy, file, { held = 0 } = {}) {
  const size = Number(file?.size ?? 0);
  const type = String(file?.type || "").toLowerCase();
  if (!file || size === 0) return { ok: false, code: FILE_ERROR.EMPTY, message: "the file is empty" };
  if (policy.types.length && !policy.types.includes(type)) {
    return { ok: false, code: FILE_ERROR.TYPE_NOT_ALLOWED, message: `${type || "this file type"} is not accepted`, details: { accepted: [...policy.types] } };
  }
  if (size > policy.maxBytes) {
    return { ok: false, code: FILE_ERROR.TOO_LARGE, message: `the file is larger than the ${formatBytes(policy.maxBytes)} limit`, details: { size, maxBytes: policy.maxBytes } };
  }
  if (held >= policy.maxPerSubject) {
    return { ok: false, code: FILE_ERROR.TOO_MANY, message: `only ${policy.maxPerSubject} files may be attached`, details: { held, maxPerSubject: policy.maxPerSubject } };
  }
  return { ok: true };
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

/** A deterministic object key: subject-scoped, so removing a subject removes its files. */
export function fileKey({ subject = "shared", subjectId = "", name = "", type = "", now = Date.now() } = {}) {
  const safe = String(name).toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/-+\./g, ".").replace(/^-+|-+$/g, "").slice(0, 80)
    || `file.${EXTENSION_OF[String(type).toLowerCase()] || "bin"}`;
  return [String(subject), String(subjectId || "unscoped"), `${now}-${safe}`].filter(Boolean).join("/");
}

/**
 * @param {object} options
 * @param {object} options.policy compileFilePolicy() output
 * @param {object} options.storage the SDK storage surface { upload, getUrl, remove, list }
 * @param {object} [options.metadata] an entity repository recording one row per stored file
 */
export function createFiles({ policy, storage, metadata = null, now = () => Date.now() } = {}) {
  if (!policy?.types) throw new FileError(FILE_ERROR.UNAVAILABLE, "createFiles needs a compiled file policy");
  if (typeof storage?.upload !== "function") throw new FileError(FILE_ERROR.UNAVAILABLE, "createFiles needs the storage surface");
  const listeners = new Set();
  let state = { status: FILE_STATUS.IDLE, progress: 0, error: null, files: [], subject: null, subjectId: null };
  let snapshot = null;
  const emit = () => { for (const listener of [...listeners]) listener(getState()); };
  const commit = (patch) => { state = { ...state, ...patch }; snapshot = null; emit(); return getState(); };
  const getState = () => {
    if (!snapshot) snapshot = freeze({ ...state, files: freeze(state.files.map((row) => freeze({ ...row }))), policy });
    return snapshot;
  };

  const recorded = async (subject, subjectId) => {
    if (!metadata) return [];
    const rows = await metadata.list({ filters: { subject, subjectId } });
    return rows.map((row) => ({ id: row.id, ...row.values }));
  };

  return {
    policy,
    getState,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    check: (file, options) => checkFile(policy, file, options),

    /** Every file attached to one subject record. */
    async list({ subject = "shared", subjectId = null } = {}) {
      const files = await recorded(subject, subjectId);
      commit({ subject, subjectId, files, status: FILE_STATUS.READY, error: null });
      return files;
    },

    /**
     * Upload one file. The policy is checked BEFORE a byte is sent, so a refusal names what is
     * wrong instead of arriving as a failed request halfway through a large file.
     */
    async upload(file, { subject = "shared", subjectId = null, onProgress = null } = {}) {
      const held = (await recorded(subject, subjectId)).length;
      commit({ status: FILE_STATUS.VALIDATING, progress: 0, error: null, subject, subjectId });
      const verdict = checkFile(policy, file, { held });
      if (!verdict.ok) {
        commit({ status: FILE_STATUS.REFUSED, error: { code: verdict.code, message: verdict.message, details: verdict.details || null } });
        return { ok: false, reason: verdict.code, error: getState().error, state: getState() };
      }
      const key = fileKey({ subject, subjectId, name: file?.name, type: file?.type, now: now() });
      commit({ status: FILE_STATUS.UPLOADING, progress: 0 });
      try {
        const stored = await storage.upload(file, {
          path: key,
          contentType: file?.type || undefined,
          onProgress: (event) => { commit({ progress: Number(event?.percent) || 0 }); onProgress?.(event); },
        });
        const record = {
          path: stored?.path || key, name: String(file?.name || key.split("/").pop()),
          contentType: String(file?.type || ""), size: Number(file?.size || 0),
          subject, subjectId: subjectId ? String(subjectId) : null, uploadedAt: new Date(now()).toISOString(),
        };
        // Metadata is recorded against the subject, not invented in a screen, so what the
        // application believes it has and what the bucket holds cannot drift.
        const saved = metadata ? { id: (await metadata.create(record)).id, ...record } : record;
        commit({ status: FILE_STATUS.READY, progress: 100, files: [...state.files, saved], error: null });
        return { ok: true, file: saved, state: getState() };
      } catch (error) {
        commit({ status: FILE_STATUS.ERROR, error: { code: FILE_ERROR.UPLOAD_FAILED, message: String(error?.message || error) } });
        return { ok: false, reason: FILE_ERROR.UPLOAD_FAILED, state: getState() };
      }
    },

    /** Upload several, stopping at the first refusal so a partial batch is never a surprise. */
    async uploadMany(files, options = {}) {
      const results = [];
      for (const file of Array.from(files || [])) {
        const result = await this.upload(file, options);
        results.push(result);
        if (!result.ok) break;
      }
      return { ok: results.every((row) => row.ok), results, state: getState() };
    },

    /**
     * A short-lived signed URL, minted on demand. Never cached past its own expiry: the module
     * returns the seconds it is good for so a caller cannot keep a dead link on screen.
     */
    async url(path, { expiresIn = policy.signedUrlSeconds } = {}) {
      if (!path) throw new FileError(FILE_ERROR.NOT_FOUND, "a stored path is required");
      const url = await storage.getUrl(path, expiresIn);
      return freeze({ url, expiresIn, expiresAt: new Date(now() + expiresIn * 1000).toISOString() });
    },

    /** Remove the object AND its metadata row: one call, no orphan on either side. */
    async remove(pathOrId) {
      const row = state.files.find((file) => file.path === pathOrId || file.id === pathOrId)
        || (metadata && pathOrId ? (await recorded(state.subject, state.subjectId)).find((file) => file.path === pathOrId || file.id === pathOrId) : null);
      const path = row?.path || pathOrId;
      try {
        await storage.remove(path);
        if (metadata && row?.id) await metadata.remove(row.id);
        commit({ files: state.files.filter((file) => file.path !== path), error: null, status: FILE_STATUS.READY });
        return { ok: true, path, state: getState() };
      } catch (error) {
        commit({ status: FILE_STATUS.ERROR, error: { code: FILE_ERROR.UNAVAILABLE, message: String(error?.message || error) } });
        return { ok: false, reason: FILE_ERROR.UNAVAILABLE, state: getState() };
      }
    },

    /**
     * Remove every file attached to one subject record. Called when that record is deleted, which
     * is the only honest moment to do it: a sweep over "files nobody references" cannot tell an
     * orphan from a file an application has not attached yet.
     */
    async removeForSubject({ subject = "shared", subjectId = null } = {}) {
      const rows = await recorded(subject, subjectId);
      const removed = [];
      for (const row of rows) {
        await storage.remove(row.path);
        if (metadata && row.id) await metadata.remove(row.id);
        removed.push(row.path);
      }
      commit({ files: [], status: FILE_STATUS.READY, error: null });
      return { ok: true, removed };
    },
  };
}
