// The MaxMind DB reader.
//
// Verified against MaxMind's OWN test database — a real file produced by their tooling, with
// documented expected answers — rather than against a fixture this repo wrote. A parser checked
// only against its own encoder proves that the two agree, not that either is right.
//
// The fixture is downloaded on first run and cached in the OS temp directory rather than committed:
// it is third-party data, and a 19 KB binary in the repo is a thing people stop noticing. With no
// network and no cache the suite SKIPS rather than fails, and says so — a green tick that silently
// covered nothing would be worse than an honest skip.

import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MmdbReader, addressBits } from "../../shell/server/lib/analytics/mmdb.mjs";

const FIXTURE_URL = "https://raw.githubusercontent.com/maxmind/MaxMind-DB/main/test-data/GeoIP2-Country-Test.mmdb";
const CACHE = path.join(os.tmpdir(), "thrallo-test-data", "GeoIP2-Country-Test.mmdb");

async function fixture() {
  try {
    return await readFile(CACHE);
  } catch { /* not cached yet */ }
  try {
    const response = await fetch(FIXTURE_URL, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    await mkdir(path.dirname(CACHE), { recursive: true });
    await writeFile(CACHE, buffer);
    return buffer;
  } catch {
    return null;
  }
}

const db = await fixture();
const skip = db ? false : "MaxMind test database unavailable (no cache, no network)";

test("the metadata is read the way the spec describes it", { skip }, () => {
  const reader = new MmdbReader(db);
  assert.equal(reader.metadata.databaseType, "GeoIP2-Country");
  assert.equal(reader.metadata.ipVersion, 6);
  assert.ok(reader.metadata.nodeCount > 0, "node count");
  assert.ok([24, 28, 32].includes(reader.metadata.recordSize), `record size ${reader.metadata.recordSize}`);
  assert.ok(reader.metadata.buildEpoch > 1_600_000_000, "a real build timestamp, used to spot a stale database");
});

test("metadata survives the pointer that used to break it", { skip }, () => {
  // GeoLite2 stores `languages` as pointers into strings it has already written. Without a pointer
  // case the decoder advanced by the wrong number of bytes and silently lost every key AFTER
  // languages — including node_count and record_size. A perfectly good database looked corrupt.
  const reader = new MmdbReader(db);
  assert.ok(reader.metadata.nodeCount > 0 && reader.metadata.recordSize > 0,
    "both live after `languages` in the metadata map");
});

test("known addresses resolve to their documented countries", { skip }, () => {
  const reader = new MmdbReader(db);
  // From MaxMind's own source-data for this fixture.
  assert.equal(reader.country("81.2.69.160"), "GB");
  assert.equal(reader.country("89.160.20.112"), "SE");
  assert.equal(reader.country("216.160.83.56"), "US");
  assert.equal(reader.country("2001:218::1"), "JP", "IPv6 as well as IPv4");
});

test("data pointers land on the record, not sixteen bytes before it", { skip }, async () => {
  // The data section starts 16 bytes after the search tree. Omitting that separator put every
  // dereference one record early: the tree found the RIGHT data and then every key read as an
  // empty string, so every lookup returned null while looking like it had worked.
  const reader = new MmdbReader(db);
  assert.equal(reader.country("81.2.69.160"), "GB");
  const source = await readFile(new URL("../../shell/server/lib/analytics/mmdb.mjs", import.meta.url), "utf8");
  assert.match(source, /const DATA_SECTION_SEPARATOR = 16;/);
  assert.match(source, /const base = this\.searchTreeSize \+ DATA_SECTION_SEPARATOR;/);
});

test("an address with no answer yields nothing rather than a guess", { skip }, () => {
  const reader = new MmdbReader(db);
  // Private ranges, loopback and reserved space have no country and must never be given one.
  for (const ip of ["10.0.0.1", "192.168.1.1", "127.0.0.1", "::1", "169.254.1.1"]) {
    assert.equal(reader.country(ip), null, `${ip} must resolve to nothing`);
  }
});

test("malformed input is refused rather than guessed at", { skip }, () => {
  const reader = new MmdbReader(db);
  for (const bad of ["", null, undefined, "not-an-ip", "999.1.1.1", "1.2.3", "::gggg", "  "]) {
    assert.equal(reader.country(bad), null, `${JSON.stringify(bad)} must resolve to nothing`);
  }
});

test("a corrupt file is rejected at load, not at lookup", { skip }, () => {
  // Failing loudly when the database is opened means one log line at startup. Failing per-lookup
  // would mean one per page view, on every published site.
  assert.throws(() => new MmdbReader(Buffer.alloc(64)), /no MaxMind metadata marker/);
  const truncated = Buffer.concat([db.subarray(0, 32), db.subarray(db.length - 400)]);
  assert.throws(() => new MmdbReader(truncated), /mmdb:/);
});

// ── Address parsing, which needs no database ────────────────────────────────────────────

test("IPv4 is mapped into the IPv6 tree, because that is where GeoLite2 keeps it", () => {
  const bits = addressBits("81.2.69.160");
  assert.equal(bits.length, 128, "always 128 bits, never 32");
  // ::ffff:0:0/96 — eighty zeroes, then sixteen ones, then the address.
  assert.deepEqual(bits.slice(0, 80), new Array(80).fill(0));
  assert.deepEqual(bits.slice(80, 96), new Array(16).fill(1));
});

test("IPv6 shorthand expands correctly", () => {
  assert.equal(addressBits("2001:218::1").length, 128);
  assert.equal(addressBits("::1").length, 128);
  assert.equal(addressBits("::").length, 128);
  // Nine groups cannot be an address, and neither can a stray word.
  assert.equal(addressBits("1:2:3:4:5:6:7:8:9"), null);
  assert.equal(addressBits("hello"), null);
  assert.equal(addressBits("1.2.3.4.5"), null);
  assert.equal(addressBits("256.1.1.1"), null);
});
