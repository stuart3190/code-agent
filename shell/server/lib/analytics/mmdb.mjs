// A minimal MaxMind DB reader — enough to answer "which country is this IP in", and nothing else.
//
// Written rather than depended on, for the same reason the .env loader, the web-push sender and the
// HTTP server are: this codebase runs on five dependencies and a country lookup is a well-specified
// binary format, not a moving target. The MaxMind DB spec is public and stable at version 2.
//
// It reads exactly one path — country.iso_code — and decodes only the types needed to reach it.
// Anything else in the record is skipped without being materialised, so a lookup allocates almost
// nothing on the hot path (every published site's every page view).
//
// Correctness is proved against the real GeoLite2-Country database with known addresses in
// ops/prove-geoip.mjs; there is no substitute for that, and the parser is not trusted on review.

const METADATA_MARKER = Buffer.from("\xAB\xCD\xEFMaxMind.com", "binary");
// The marker cannot appear more than this far from the end in any real database, and bounding the
// search stops a corrupt file turning into a scan of the whole buffer.
const METADATA_MAX_SIZE = 128 * 1024;
// The data section begins this many bytes after the search tree, per the spec.
const DATA_SECTION_SEPARATOR = 16;

const TYPE = {
  POINTER: 1, UTF8: 2, DOUBLE: 3, BYTES: 4, UINT16: 5, UINT32: 6, MAP: 7,
  INT32: 8, UINT64: 9, UINT128: 10, ARRAY: 11, CACHE: 12, END: 13, BOOLEAN: 14, FLOAT: 15,
};

export class MmdbReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.metadata = readMetadata(buffer);
    this.searchTreeSize = (this.metadata.nodeCount * this.metadata.recordSize * 2) / 8;
    if (!Number.isInteger(this.searchTreeSize) || this.searchTreeSize > buffer.length) {
      throw new Error("mmdb: search tree size is not consistent with the file");
    }
  }

  /**
   * The two-letter country code for an address, or null.
   *
   * Null covers every "we do not know" case there is — a private address, an address the database
   * has no entry for, a malformed input — because they are all the same answer to the caller and
   * guessing between them would be inventing data.
   */
  country(ip) {
    const bits = addressBits(ip);
    if (!bits) return null;
    const pointer = this.#find(bits);
    if (pointer === null) return null;
    try {
      return this.#isoCode(pointer);
    } catch {
      // A record that does not decode is a corrupt database, not a country. Same answer as unknown.
      return null;
    }
  }

  // Walk the binary search tree one bit at a time. Every record either points at another node,
  // says "no data", or points into the data section.
  #find(bits) {
    const { nodeCount, recordSize } = this.metadata;
    let node = 0;
    for (const bit of bits) {
      if (node >= nodeCount) break;
      const record = this.#record(node, bit, recordSize);
      if (record === nodeCount) return null;          // the documented "not found" value
      if (record > nodeCount) return record - nodeCount + this.searchTreeSize;
      node = record;
    }
    return null;
  }

  #record(node, bit, recordSize) {
    const base = node * ((recordSize * 2) / 8);
    const b = this.buffer;
    if (recordSize === 24) {
      const at = base + (bit ? 3 : 0);
      return (b[at] << 16) | (b[at + 1] << 8) | b[at + 2];
    }
    if (recordSize === 28) {
      // The middle byte carries the top four bits of BOTH records — the left record's in the high
      // nibble, the right record's in the low one.
      const middle = b[base + 3];
      return bit
        ? ((middle & 0x0f) * 0x1000000) + ((b[base + 4] << 16) | (b[base + 5] << 8) | b[base + 6])
        : (((middle & 0xf0) >> 4) * 0x1000000) + ((b[base] << 16) | (b[base + 1] << 8) | b[base + 2]);
    }
    if (recordSize === 32) {
      const at = base + (bit ? 4 : 0);
      return b.readUInt32BE(at);
    }
    throw new Error(`mmdb: unsupported record size ${recordSize}`);
  }

  // The record is a map; the only key wanted is `country`, whose value is a map whose only wanted
  // key is `iso_code`. Everything else is skipped without being built.
  #isoCode(offset) {
    const country = this.#mapValue(offset, "country");
    if (country === null) return null;
    const code = this.#mapValue(country, "iso_code");
    if (code === null) return null;
    const { type, size, at } = this.#control(this.#deref(code));
    if (type !== TYPE.UTF8) return null;
    const value = this.buffer.toString("utf8", at, at + size);
    // Two uppercase letters or nothing: a database returning anything else is not to be trusted
    // into the analytics table.
    return /^[A-Z]{2}$/.test(value) ? value : null;
  }

  // Returns the offset of `key`'s value within the map at `offset`, or null.
  #mapValue(offset, key) {
    const resolved = this.#deref(offset);
    const { type, size, at } = this.#control(resolved);
    if (type !== TYPE.MAP) return null;
    let cursor = at;
    for (let i = 0; i < size; i += 1) {
      const keyCtrl = this.#control(this.#deref(cursor));
      const name = this.buffer.toString("utf8", keyCtrl.at, keyCtrl.at + keyCtrl.size);
      cursor = this.#skipKey(cursor);
      if (name === key) return cursor;
      cursor = this.#skip(cursor);
    }
    return null;
  }

  // A pointer is followed; anything else is already where it says it is.
  #deref(offset) {
    const ctrl = this.buffer[offset];
    if ((ctrl >> 5) !== TYPE.POINTER) return offset;
    return this.#pointer(offset).target;
  }

  /**
   * A pointer into the DATA section.
   *
   * Its value is an offset from the start of the data section, which begins 16 bytes after the
   * search tree — the documented separator. Omitting those 16 bytes landed every dereference one
   * record early: the tree found the right data, and then every key read as an empty string.
   *
   * Tree records need no such adjustment; their value already accounts for it, which is why
   * `#find` subtracts nodeCount rather than adding the separator.
   */
  #pointer(offset) {
    const b = this.buffer;
    const base = this.searchTreeSize + DATA_SECTION_SEPARATOR;
    const ctrl = b[offset];
    const size = (ctrl >> 3) & 0x3;
    const value = ctrl & 0x7;
    if (size === 0) return { target: base + ((value << 8) | b[offset + 1]), next: offset + 2 };
    if (size === 1) {
      return { target: base + ((value << 16) | (b[offset + 1] << 8) | b[offset + 2]) + 2048, next: offset + 3 };
    }
    if (size === 2) {
      return {
        target: base + ((value << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) + 526_336,
        next: offset + 4,
      };
    }
    return { target: base + b.readUInt32BE(offset + 1), next: offset + 5 };
  }

  // Decodes a control byte into { type, size, at } where `at` is where the payload begins.
  #control(offset) {
    const b = this.buffer;
    const ctrl = b[offset];
    let type = ctrl >> 5;
    let at = offset + 1;
    if (type === 0) { type = b[at] + 7; at += 1; }   // extended type
    let size = ctrl & 0x1f;
    if (size === 29) { size = 29 + b[at]; at += 1; }
    else if (size === 30) { size = 285 + ((b[at] << 8) | b[at + 1]); at += 2; }
    else if (size === 31) { size = 65_821 + ((b[at] << 16) | (b[at + 1] << 8) | b[at + 2]); at += 3; }
    return { type, size, at };
  }

  // A map key is always a string or a pointer to one; either way this returns the offset after it.
  #skipKey(offset) {
    if ((this.buffer[offset] >> 5) === TYPE.POINTER) return this.#pointer(offset).next;
    const { size, at } = this.#control(offset);
    return at + size;
  }

  // The offset immediately after the value at `offset`, without decoding it.
  #skip(offset) {
    if ((this.buffer[offset] >> 5) === TYPE.POINTER) return this.#pointer(offset).next;
    const { type, size, at } = this.#control(offset);
    switch (type) {
      case TYPE.MAP: {
        let cursor = at;
        for (let i = 0; i < size; i += 1) {
          cursor = this.#skipKey(cursor);
          cursor = this.#skip(cursor);
        }
        return cursor;
      }
      case TYPE.ARRAY: {
        let cursor = at;
        for (let i = 0; i < size; i += 1) cursor = this.#skip(cursor);
        return cursor;
      }
      case TYPE.BOOLEAN:
        return at;                 // the value is the size field itself
      default:
        return at + size;          // strings, numbers and bytes are all length-prefixed
    }
  }
}

function readMetadata(buffer) {
  const from = Math.max(0, buffer.length - METADATA_MAX_SIZE);
  const marker = buffer.lastIndexOf(METADATA_MARKER, buffer.length, "binary");
  if (marker < from) throw new Error("mmdb: no MaxMind metadata marker — not a MaxMind database");

  // The metadata is itself a data-section-encoded map, but addressed from the marker rather than
  // through the search tree — so it is decoded directly rather than through the reader.
  const map = decodeMap(buffer.subarray(marker + METADATA_MARKER.length));
  const nodeCount = map.node_count;
  const recordSize = map.record_size;
  if (!nodeCount || !recordSize) throw new Error("mmdb: metadata is missing node_count or record_size");
  return {
    nodeCount,
    recordSize,
    ipVersion: map.ip_version || 6,
    databaseType: map.database_type || "unknown",
    // Seconds since the epoch, per the spec. Used to decide whether the database is stale.
    buildEpoch: Number(map.build_epoch || 0),
  };
}

// The metadata map is small and read once at load, so it IS materialised — unlike a lookup record.
export function decodeMap(buffer) {
  const out = {};
  const control = (offset) => {
    let type = buffer[offset] >> 5;
    let at = offset + 1;
    if (type === 0) { type = buffer[at] + 7; at += 1; }
    let size = buffer[offset] & 0x1f;
    if (size === 29) { size = 29 + buffer[at]; at += 1; }
    else if (size === 30) { size = 285 + ((buffer[at] << 8) | buffer[at + 1]); at += 2; }
    else if (size === 31) { size = 65_821 + ((buffer[at] << 16) | (buffer[at + 1] << 8) | buffer[at + 2]); at += 3; }
    return { type, size, at };
  };
  // Pointers appear in the metadata too — GeoLite2 stores the `languages` entries as pointers into
  // strings it has already written. Without this case the decoder fell through to `default`,
  // advanced by the wrong number of bytes, and silently lost every key after `languages` —
  // including node_count and record_size, which is exactly how a working database looked corrupt.
  const pointer = (offset) => {
    const ctrl = buffer[offset];
    const ss = (ctrl >> 3) & 0x3;
    const v = ctrl & 0x7;
    const at = offset + 1;
    if (ss === 0) return { target: (v << 8) | buffer[at], next: at + 1 };
    if (ss === 1) return { target: ((v << 16) | (buffer[at] << 8) | buffer[at + 1]) + 2048, next: at + 2 };
    if (ss === 2) {
      return { target: ((v << 24) | (buffer[at] << 16) | (buffer[at + 1] << 8) | buffer[at + 2]) + 526_336, next: at + 3 };
    }
    return { target: buffer.readUInt32BE(at), next: at + 4 };
  };

  const value = (offset) => {
    if ((buffer[offset] >> 5) === TYPE.POINTER) {
      const { target, next } = pointer(offset);
      // The pointed-at value is decoded, but the cursor continues after the POINTER.
      return { value: value(target).value, next };
    }
    const { type, size, at } = control(offset);
    switch (type) {
      case TYPE.UTF8: return { value: buffer.toString("utf8", at, at + size), next: at + size };
      case TYPE.UINT16:
      case TYPE.UINT32:
      case TYPE.UINT64: {
        let n = 0;
        for (let i = 0; i < size; i += 1) n = n * 256 + buffer[at + i];
        return { value: n, next: at + size };
      }
      case TYPE.MAP: {
        let cursor = at;
        const nested = {};
        for (let i = 0; i < size; i += 1) {
          const key = value(cursor);
          cursor = key.next;
          const val = value(cursor);
          cursor = val.next;
          nested[key.value] = val.value;
        }
        return { value: nested, next: cursor };
      }
      case TYPE.ARRAY: {
        let cursor = at;
        const list = [];
        for (let i = 0; i < size; i += 1) {
          const item = value(cursor);
          cursor = item.next;
          list.push(item.value);
        }
        return { value: list, next: cursor };
      }
      case TYPE.BOOLEAN: return { value: size !== 0, next: at };
      default: return { value: null, next: at + size };
    }
  };
  const { type, size, at } = control(0);
  if (type !== TYPE.MAP) throw new Error("mmdb: metadata is not a map");
  let cursor = at;
  for (let i = 0; i < size; i += 1) {
    const key = value(cursor);
    cursor = key.next;
    const val = value(cursor);
    cursor = val.next;
    out[key.value] = val.value;
  }
  return out;
}

/**
 * An address as the 128 bits the tree is indexed by.
 *
 * IPv4 is mapped into IPv6 (::ffff:a.b.c.d) rather than traversed as 32 bits, because GeoLite2 is
 * an IPv6 database and its tree is built for the mapped form. Returns null for anything that is not
 * an address — including the private ranges, which no public database has an answer for.
 */
export function addressBits(ip) {
  const text = String(ip || "").trim();
  if (!text) return null;
  const bytes = ipBytes(text);
  if (!bytes) return null;
  const bits = [];
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  }
  return bits;
}

function ipBytes(text) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    const parts = text.split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    // ::ffff:a.b.c.d
    return [...new Array(10).fill(0), 0xff, 0xff, ...parts];
  }
  if (!text.includes(":")) return null;
  const [head, tail = ""] = text.split("::");
  const parse = (part) => (part ? part.split(":").filter(Boolean).map((h) => parseInt(h, 16)) : []);
  const left = parse(head);
  const right = parse(tail);
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!text.includes("::") && missing !== 0)) return null;
  const groups = [...left, ...new Array(Math.max(0, missing)).fill(0), ...right];
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const group of groups) {
    if (!Number.isFinite(group) || group > 0xffff) return null;
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}
