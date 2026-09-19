import dns from "node:dns/promises";
import net from "node:net";

export const IMAGE_MAX_BYTES = 15 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 10_000;

export function publicIp(address) {
  if (!net.isIP(address)) return false;
  const value = address.toLowerCase();
  if (value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value)) return false;
  if (value.startsWith("::ffff:")) return publicIp(value.slice(7));
  if (net.isIP(value) === 6) return true;
  const [a, b] = value.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 2, 88, 168].includes(b))
    || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
}

export function rasterMime(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString() === "ftyp"
    && ["avif", "avis"].includes(buffer.subarray(8, 12).toString())) return "image/avif";
  return null;
}

async function readBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maxBytes) throw new Error(`asset response exceeds ${maxBytes} bytes`);
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`asset response exceeds ${maxBytes} bytes`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error(`asset response exceeds ${maxBytes} bytes`); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

export async function fetchSafeImage(url, {
  fetchImpl = fetch,
  dnsLookup = (host) => dns.lookup(host, { all: true, verbatim: true }),
  allowedHosts = ["images.pexels.com"],
  maxBytes = IMAGE_MAX_BYTES,
  timeoutMs = IMAGE_TIMEOUT_MS,
  maxRedirects = 3,
} = {}) {
  let current = new URL(String(url));
  const allow = new Set(allowedHosts.map((host) => String(host).toLowerCase()));
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (current.protocol !== "https:" || current.username || current.password || !allow.has(current.hostname.toLowerCase())) {
      throw new Error("asset URL is not an allowlisted HTTPS origin");
    }
    const addresses = await dnsLookup(current.hostname);
    const rows = Array.isArray(addresses) ? addresses : [addresses];
    if (!rows.length || rows.some((row) => !publicIp(typeof row === "string" ? row : row.address))) {
      throw new Error("asset URL resolved to a non-public address");
    }
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirect === maxRedirects) throw new Error("asset redirect limit exceeded");
      const location = response.headers?.get?.("location");
      if (!location) throw new Error("asset redirect had no location");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`asset download failed: HTTP ${response.status}`);
    const bytes = await readBounded(response, maxBytes);
    const detected = rasterMime(bytes);
    const declared = String(response.headers?.get?.("content-type") || "").split(";", 1)[0].toLowerCase();
    if (!detected || declared !== detected) throw new Error("asset MIME does not match supported raster bytes");
    return { bytes, mime: detected, finalUrl: current.href };
  }
  throw new Error("asset redirect limit exceeded");
}
