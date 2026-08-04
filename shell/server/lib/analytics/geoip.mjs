// Country resolution for analytics.
//
// Answers one question — "which country is this address in" — and is designed so that the answer
// "I don't know" costs nothing. Analytics ingest runs on every page view of every published site;
// it must never wait on, or fail because of, a geo database.
//
// PRIVACY. The address is resolved in the same short window it is already hashed in
// (visitorIdentity), and only the two-letter country code survives. No raw IP is written anywhere,
// by this module or any other — that guarantee is older than this file and is unchanged by it.
//
// SECRECY. The licence key is read from THRALLO_MAXMIND_LICENSE_KEY, used only as a query parameter
// to MaxMind, and never logged, never returned by an endpoint, and never shipped to the client.
// Errors from the download are reported with the URL's query string stripped, because the key is
// IN that query string and an error log is the easiest place in the world to leak one.

import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream, createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";

import { optionalEnv } from "../env.mjs";
import { MmdbReader } from "./mmdb.mjs";

const EDITION = "GeoLite2-Country";
// Outside the repo tree on purpose: a 6 MB binary inside code-agent/ invites an accidental commit,
// is not source, and would be re-extracted over on every deploy.
const DEFAULT_DIR = "/home/ubuntu/geoip";
// MaxMind publishes weekly (Tuesdays). Checking twice that often keeps the copy fresh without
// hammering them, and matches the cadence their terms expect.
const REFRESH_MS = 3.5 * 24 * 60 * 60 * 1000;
// Past this, the data is still used but the UI says how old it is. Countries do not move, so an
// old database is degraded rather than wrong — saying nothing would be the bigger lie.
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const state = {
  reader: null,
  loadedAt: 0,
  buildEpoch: 0,
  error: null,
  path: null,
};
let refreshTimer = null;

export function geoipConfigured() {
  return !!optionalEnv("THRALLO_MAXMIND_LICENSE_KEY");
}

export function geoipDir() {
  return optionalEnv("THRALLO_GEOIP_DIR", DEFAULT_DIR);
}

const dbPath = () => path.join(geoipDir(), `${EDITION}.mmdb`);

/**
 * The country for an address, or null.
 *
 * Synchronous and allocation-light: it is called once per event during ingest. Every failure mode —
 * no key, no database, a database that will not parse, an address with no entry — is the same
 * `null`, because they are the same answer to the caller and distinguishing them here would only
 * invite someone to render the difference.
 */
export function countryFor(ip) {
  if (!state.reader) return null;
  try {
    return state.reader.country(ip);
  } catch {
    return null;
  }
}

/**
 * What the UI is allowed to say about country data.
 *
 * Three distinct situations, because they need three different sentences: the deployment has no
 * licence, the database is present and current, or it is present and old. "Unavailable" for all
 * three would be untrue in two of them.
 */
export function geoipStatus() {
  if (!geoipConfigured()) return { available: false, reason: "not_configured" };
  if (!state.reader) {
    // Kick a one-shot load. The server calls startGeoipUpdater() at boot, but anything else that
    // imports the reports module — a proof, a script, a worker — would otherwise report "loading"
    // for the life of the process while a perfectly good database sat on disk beside it.
    // Fire-and-forget on purpose: this function is synchronous and on the read path.
    if (!state.loading) {
      state.loading = true;
      loadGeoip().finally(() => { state.loading = false; });
    }
    return { available: false, reason: state.error ? "unavailable" : "loading" };
  }
  const builtAt = state.buildEpoch ? new Date(state.buildEpoch * 1000).toISOString() : null;
  const age = state.buildEpoch ? Date.now() - state.buildEpoch * 1000 : null;
  return {
    available: true,
    reason: null,
    builtAt,
    stale: age !== null && age > STALE_AFTER_MS,
  };
}

/**
 * Load the database from disk if it is there.
 *
 * Never throws. A missing or unreadable file leaves country resolution off and the rest of
 * analytics working, which is the whole point.
 */
export async function loadGeoip({ file = dbPath() } = {}) {
  try {
    const buffer = await readFile(file);
    const reader = new MmdbReader(buffer);
    state.reader = reader;
    state.buildEpoch = reader.metadata.buildEpoch || 0;
    state.loadedAt = Date.now();
    state.error = null;
    state.path = file;
    const built = state.buildEpoch ? new Date(state.buildEpoch * 1000).toISOString().slice(0, 10) : "unknown";
    console.log(`[geoip] loaded ${EDITION} (${reader.metadata.nodeCount} nodes, built ${built})`);
    return true;
  } catch (error) {
    state.reader = null;
    state.error = error.message;
    // Absence is normal before the first download; only say something when there IS a file that
    // will not load, which is a real problem someone should see.
    if (error.code !== "ENOENT") console.error(`[geoip] could not load the database: ${error.message}`);
    return false;
  }
}

/**
 * Fetch the current database from MaxMind and install it atomically.
 *
 * Downloads to a temp file, verifies it parses AND answers a known address, then renames into
 * place. A half-written or corrupt download must never replace a working database — the rename is
 * what makes that impossible, because it is atomic on the same filesystem.
 */
export async function updateGeoip({ fetchImpl = fetch, dir = geoipDir() } = {}) {
  const key = optionalEnv("THRALLO_MAXMIND_LICENSE_KEY");
  if (!key) return { updated: false, reason: "not_configured" };

  const accountId = optionalEnv("THRALLO_MAXMIND_ACCOUNT_ID");
  const url = `https://download.maxmind.com/app/geoip_download?edition_id=${EDITION}`
    + `&license_key=${encodeURIComponent(key)}&suffix=tar.gz`;

  await mkdir(dir, { recursive: true });
  const temp = path.join(os.tmpdir(), `thrallo-geoip-${process.pid}-${Date.now()}`);
  const archive = `${temp}.tar.gz`;

  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(120_000),
      headers: accountId
        ? { Authorization: `Basic ${Buffer.from(`${accountId}:${key}`).toString("base64")}` }
        : {},
    });
    if (!response.ok) {
      // The key is in the query string, so the URL never appears in this message.
      throw new Error(`MaxMind returned HTTP ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));

    const extracted = await extractMmdb(archive, temp);
    if (!extracted) throw new Error("the archive contained no .mmdb file");

    // Prove it works BEFORE it replaces anything. A database that parses but answers nothing is
    // as useless as one that does not parse, and both are worse than the copy already installed.
    const candidate = new MmdbReader(await readFile(extracted));
    if (candidate.country("81.2.69.160") !== "GB") {
      throw new Error("the downloaded database did not resolve a known address");
    }

    const target = path.join(dir, `${EDITION}.mmdb`);
    await rename(extracted, target).catch(async (error) => {
      // Cross-device rename fails; copy then remove is the fallback, still atomic enough because
      // the write completes before anything reads it.
      if (error.code !== "EXDEV") throw error;
      await writeFile(target, await readFile(extracted));
    });
    await loadGeoip({ file: target });
    return { updated: true, builtAt: geoipStatus().builtAt };
  } catch (error) {
    console.error(`[geoip] update failed: ${scrub(error.message)}`);
    return { updated: false, reason: scrub(error.message) };
  } finally {
    await rm(archive, { force: true }).catch(() => {});
    await rm(temp, { force: true, recursive: true }).catch(() => {});
  }
}

/**
 * Pull the single .mmdb out of MaxMind's tar.gz.
 *
 * A minimal tar reader rather than a shell-out: `tar` is not guaranteed present, and spawning a
 * process with a path derived from a download is a worse idea than parsing 512-byte headers.
 */
async function extractMmdb(archiveFile, intoPrefix) {
  const gunzip = createGunzip();
  const chunks = [];
  await pipeline(createReadStream(archiveFile), gunzip, async function* (source) {
    for await (const chunk of source) chunks.push(chunk);
    yield "";
  });
  const tar = Buffer.concat(chunks);

  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tar.toString("utf8", offset, offset + 100).replace(/\0.*$/, "");
    if (!name) break;                                   // two zero blocks end the archive
    const sizeField = tar.toString("utf8", offset + 124, offset + 136).replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField, 8) || 0;
    const body = offset + 512;
    if (name.endsWith(".mmdb")) {
      const out = `${intoPrefix}.mmdb`;
      await writeFile(out, tar.subarray(body, body + size));
      return out;
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  return null;
}

// The licence key can only reach a log through an error message that quoted the URL. Belt and
// braces: strip anything that looks like the query string, whatever produced it.
function scrub(message) {
  return String(message || "").replace(/license_key=[^&\s]*/gi, "license_key=<redacted>");
}

/**
 * Keep the copy current.
 *
 * Started only when a licence key exists, so a deployment without one does no work and logs
 * nothing. Failures are logged and retried on the next tick — a refresh that cannot reach MaxMind
 * leaves the existing database in place and serving.
 */
export function startGeoipUpdater({ intervalMs = REFRESH_MS } = {}) {
  if (refreshTimer || !geoipConfigured()) return null;
  const run = () => {
    updateGeoipIfStale().catch((error) => console.error(`[geoip] refresh: ${scrub(error.message)}`));
  };
  // Load whatever is already on disk immediately, so country data works from the first request
  // rather than after the first download.
  loadGeoip().then((loaded) => { if (!loaded) run(); }).catch(() => {});
  refreshTimer = setInterval(run, Math.max(intervalMs, 60 * 60_000));
  refreshTimer.unref?.();
  return refreshTimer;
}

export function stopGeoipUpdater() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

// Only download when the copy on disk is actually old, so a restart loop cannot turn into a
// download loop against MaxMind.
export async function updateGeoipIfStale({ maxAgeMs = REFRESH_MS } = {}) {
  try {
    const info = await stat(dbPath());
    if (Date.now() - info.mtimeMs < maxAgeMs) return { updated: false, reason: "fresh" };
  } catch { /* no file yet — download */ }
  return updateGeoip();
}

// Test seam: the module holds one reader for the process, and tests need to put a known one in.
export function setGeoipReaderForTests(reader, { buildEpoch = Math.floor(Date.now() / 1000) } = {}) {
  state.reader = reader;
  state.buildEpoch = buildEpoch;
  state.error = null;
}

export function fingerprint() {
  // A stable identifier for the loaded database, for the proof to assert that two processes agree
  // on which copy they have. Not the key, and not derived from it.
  return state.reader ? createHash("sha256").update(String(state.buildEpoch)).digest("hex").slice(0, 12) : null;
}
