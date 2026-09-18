// Exports/artifacts module v1 — platform infrastructure, do not edit or reimplement.
//
// "Export" is the feature most likely to be a lie. The audit records exactly how (§9
// "Exports/downloads"): a UI-only export that opened a print dialogue and produced no file; a
// download of whatever happened to be on screen rather than what the visitor asked for; a CSV
// built by joining values with commas, which corrupts the moment a value contains a comma, a
// quote or a newline.
//
// This module produces a REAL ARTIFACT: bytes, a media type, a filename, and a size. Three rules:
//
//   1. The source is the SAME query the screen showed, run again in full — not the loaded page.
//      An export of 50 of 4,000 rows is a wrong answer in a file, which outlives the screen.
//   2. Serialization is correct by construction. CSV quoting is implemented once, here, and the
//      formula-injection prefixes that turn a spreadsheet cell into a command are neutralised.
//   3. Columns are declared. An export that spreads whatever fields the records happen to carry
//      will one day include a field nobody meant to publish.
//
// Headless: it returns an artifact. How a screen offers it is the application's business.

export const EXPORTS_MODULE_VERSION = "1.0.0";

export const EXPORT_FORMATS = Object.freeze(["csv", "json", "tsv"]);

export const EXPORT_ERROR = Object.freeze({
  UNKNOWN_EXPORT: "export_unknown",
  UNKNOWN_FORMAT: "export_format_unknown",
  NOT_AUTHORIZED: "export_not_authorized",
  EMPTY: "export_empty",
  FAILED: "export_failed",
});

export class ExportError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const freeze = (value) => Object.freeze(value);
const listOf = (value) => (Array.isArray(value) ? value : []);
const MEDIA_TYPE = Object.freeze({ csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json" });
// A leading =, +, - or @ makes a spreadsheet treat a cell as a formula. A value that came from a
// visitor must never become one.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Compile the declared exports.
 *   exports: [{ id, entity, columns: [{ field, label? }], format?, filename?, grant? }]
 * Columns are declared, so what leaves the application is a decision rather than an accident.
 */
export function compileExports(definitions = [], { schema = null } = {}) {
  const compiled = {};
  for (const row of listOf(definitions)) {
    const id = String(row?.id || "").trim();
    const entity = String(row?.entity || "").trim();
    if (!id || !entity) continue;
    const fields = schema?.entities?.[entity]?.fields || null;
    const columns = listOf(row?.columns).map((column) => (typeof column === "string" ? { field: column } : column))
      .filter((column) => column?.field)
      .filter((column) => !fields || Object.hasOwn(fields, column.field) || ["id", "createdAt", "updatedAt"].includes(column.field))
      .map((column) => freeze({ field: String(column.field), label: String(column.label || column.field) }));
    if (!columns.length) continue;
    compiled[id] = freeze({
      id, entity, columns: freeze(columns),
      format: EXPORT_FORMATS.includes(row?.format) ? row.format : "csv",
      filename: String(row?.filename || `${entity}-export`),
      filters: freeze({ ...(row?.filters || {}) }),
      grant: row?.grant ? String(row.grant) : null,
    });
  }
  return freeze({ version: EXPORTS_MODULE_VERSION, definitions: freeze(compiled), ids: freeze(Object.keys(compiled)) });
}

/** One correct CSV/TSV cell: quoted when it must be, and never a formula. */
export function escapeCell(value, delimiter = ",") {
  if (value === null || value === undefined) return "";
  const raw = value instanceof Date ? value.toISOString()
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  const neutral = FORMULA_PREFIX.test(raw) ? `'${raw}` : raw;
  return /["\n\r]/.test(neutral) || neutral.includes(delimiter)
    ? `"${neutral.replace(/"/g, '""')}"` : neutral;
}

/** Serialize records into an artifact body. Exported so the bytes are testable directly. */
export function serialize(definition, records = []) {
  const rows = listOf(records).map((record) => ({
    id: record?.id, createdAt: record?.createdAt, updatedAt: record?.updatedAt, ...(record?.values || record),
  }));
  if (definition.format === "json") {
    return JSON.stringify(rows.map((row) => Object.fromEntries(definition.columns.map((column) => [column.field, row[column.field] ?? null]))), null, 2);
  }
  const delimiter = definition.format === "tsv" ? "\t" : ",";
  const header = definition.columns.map((column) => escapeCell(column.label, delimiter)).join(delimiter);
  const body = rows.map((row) => definition.columns
    .map((column) => escapeCell(row[column.field], delimiter)).join(delimiter));
  // A trailing newline: a file without one is a file some tools silently truncate.
  return [header, ...body].join("\n") + (body.length ? "\n" : "\n");
}

const byteLength = (text) => (typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : Buffer.byteLength(text, "utf8"));

/**
 * @param {object} options
 * @param {object} options.schema compileExports() output
 * @param {(entity: string, filters: object) => Promise<any[]>} options.read reads EVERY matching
 *   record, not one page
 * @param {(grant: string) => Promise<boolean>|boolean} [options.authorize]
 */
export function createExports({ schema, read, authorize = null, now = () => new Date() } = {}) {
  if (!schema?.definitions) throw new ExportError(EXPORT_ERROR.UNKNOWN_EXPORT, "createExports needs compiled exports");
  if (typeof read !== "function") throw new ExportError(EXPORT_ERROR.FAILED, "createExports needs a read adapter");
  const listeners = new Set();
  let state = { status: "idle", artifact: null, error: null };
  let snapshot = null;
  const emit = () => { for (const listener of [...listeners]) listener(getState()); };
  const commit = (patch) => { state = { ...state, ...patch }; snapshot = null; emit(); return getState(); };
  const getState = () => {
    if (!snapshot) snapshot = freeze({ ...state, artifact: state.artifact ? freeze({ ...state.artifact }) : null });
    return snapshot;
  };

  return {
    schema,
    getState,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    definition: (id) => schema.definitions[id] || null,

    /**
     * Build the artifact. Returns { body, mediaType, filename, bytes, rows } — a real file, whose
     * row count the caller can check against what the screen claimed.
     */
    async build(id, { filters = {}, format = null } = {}) {
      const declared = schema.definitions[id];
      if (!declared) {
        throw new ExportError(EXPORT_ERROR.UNKNOWN_EXPORT, `no export "${id}" is declared for this application`, { exports: [...schema.ids] });
      }
      const definition = format && EXPORT_FORMATS.includes(format) ? freeze({ ...declared, format }) : declared;
      if (format && !EXPORT_FORMATS.includes(format)) {
        throw new ExportError(EXPORT_ERROR.UNKNOWN_FORMAT, `"${format}" is not a supported export format`, { formats: [...EXPORT_FORMATS] });
      }
      if (definition.grant && authorize && (await authorize(definition.grant)) === false) {
        commit({ status: "error", artifact: null, error: { code: EXPORT_ERROR.NOT_AUTHORIZED, message: `not allowed to export ${id}` } });
        return { ok: false, reason: EXPORT_ERROR.NOT_AUTHORIZED };
      }
      commit({ status: "building", error: null });
      try {
        // The whole result set, re-read. Not the page the screen happened to hold.
        const records = await read(definition.entity, { ...definition.filters, ...filters });
        const body = serialize(definition, records);
        const stamp = now().toISOString().slice(0, 10);
        const artifact = {
          id, body,
          mediaType: MEDIA_TYPE[definition.format],
          filename: `${definition.filename}-${stamp}.${definition.format}`,
          bytes: byteLength(body),
          rows: listOf(records).length,
          columns: definition.columns.map((column) => column.field),
          generatedAt: now().toISOString(),
        };
        commit({ status: listOf(records).length ? "ready" : "empty", artifact, error: null });
        return { ok: true, artifact };
      } catch (error) {
        commit({ status: "error", artifact: null, error: { code: EXPORT_ERROR.FAILED, message: String(error?.message || error) } });
        return { ok: false, reason: EXPORT_ERROR.FAILED };
      }
    },

    /**
     * Hand the artifact to the browser. Kept separate from build() so the bytes are testable
     * without a DOM, and so a screen can show what it is about to download before it does.
     */
    download(artifact, { document: doc = globalThis.document, url = globalThis.URL } = {}) {
      if (!artifact?.body) throw new ExportError(EXPORT_ERROR.EMPTY, "there is nothing to download");
      if (!doc || !url?.createObjectURL) return { ok: false, reason: "no_document" };
      const blob = new Blob([artifact.body], { type: `${artifact.mediaType};charset=utf-8` });
      const href = url.createObjectURL(blob);
      const anchor = doc.createElement("a");
      anchor.href = href;
      anchor.download = artifact.filename;
      doc.body.appendChild(anchor);
      anchor.click();
      doc.body.removeChild(anchor);
      // Revoked on the next tick: revoking immediately races the click in some browsers, and
      // never revoking leaks the whole file for the life of the page.
      setTimeout(() => url.revokeObjectURL(href), 0);
      return { ok: true, filename: artifact.filename, bytes: artifact.bytes };
    },
  };
}
