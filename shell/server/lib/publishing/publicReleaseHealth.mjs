import crypto from "node:crypto";

// Probe only our canonical publish hostname, never a user-supplied URL or redirect.
// An intact artifact on disk does not prove the public ingress serves that artifact.
export async function provePublicRelease(slug, manifest, {
  fetchImpl = fetch, attempts = 3, timeoutMs = 10_000, retryMs = 1_000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug || "")) {
    throw new Error("invalid public release slug");
  }
  const files = new Map((manifest?.files || []).map(row => [row.path, row]));
  if (!files.has("index.html")) throw new Error("public release manifest lacks index.html");
  const base = `https://${slug}.app.thrallo.com/`;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const check = async file => {
        const expected = files.get(file);
        if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0) {
          throw new Error(`public asset has no valid manifest entry: ${file}`);
        }
        const response = await fetchImpl(new URL(file, base), {
          redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs),
        });
        try {
          if (response.status !== 200) throw new Error(`public asset ${file} returned HTTP ${response.status}`);
          const chunks = []; let bytes = 0;
          for await (const chunk of response.body || []) {
            bytes += chunk.length;
            if (bytes > expected.bytes) throw new Error(`public asset ${file} exceeds its manifest size`);
            chunks.push(Buffer.from(chunk));
          }
          const body = Buffer.concat(chunks);
          if (bytes !== expected.bytes || crypto.createHash("sha256").update(body).digest("hex") !== expected.sha256) {
            throw new Error(`public asset ${file} does not match the activated release`);
          }
          return body;
        } finally { await response.body?.cancel().catch(() => {}); }
      };
      const index = (await check("index.html")).toString("utf8");
      const assets = new Set();
      for (const match of index.matchAll(/(?:src|href)=["']([^"'#]+)["']/gi)) {
        const url = new URL(match[1], base);
        if (url.origin !== new URL(base).origin) continue;
        const file = decodeURIComponent(url.pathname.slice(1));
        if (/\.(?:m?js|css)$/.test(file)) assets.add(file);
      }
      for (const file of assets) await check(file);
      return { url: base, verifiedFiles: ["index.html", ...assets] };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await sleep(retryMs);
    }
  }
  throw lastError || new Error("public release health check did not run");
}
