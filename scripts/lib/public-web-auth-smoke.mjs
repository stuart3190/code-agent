import crypto from "node:crypto";

import { containsPrivilegedSupabaseCredential } from "../../shell/web/publicAuthConfig.mjs";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assetReferences(text) {
  return [...new Set(String(text || "").match(/(?:\/)?assets\/[A-Za-z0-9_.-]+\.(?:js|css|map)/g) || [])];
}

export async function verifyPublicWebAuth({ origin, config, fetchImpl = fetch }) {
  if (!config?.configured) throw new Error("Public auth smoke requires configured Supabase public credentials.");
  const base = String(origin || "").replace(/\/$/, "");
  const indexResponse = await fetchImpl(`${base}/`, { redirect: "manual" });
  if (!indexResponse.ok) throw new Error(`Public application returned HTTP ${indexResponse.status}.`);
  const indexText = await indexResponse.text();
  const queue = assetReferences(indexText);
  if (!queue.some((name) => name.endsWith(".js"))) throw new Error("Public application did not reference a JavaScript asset.");

  const assets = [];
  const bodies = [indexText];
  const seen = new Set();
  while (queue.length) {
    const reference = queue.shift().replace(/^\//, "");
    if (seen.has(reference)) continue;
    seen.add(reference);
    const response = await fetchImpl(`${base}/${reference}`, { redirect: "manual" });
    if (!response.ok) throw new Error(`Public asset ${reference} returned HTTP ${response.status}.`);
    const body = await response.text();
    bodies.push(body);
    assets.push({ path: reference, bytes: Buffer.byteLength(body), sha256: sha256(body) });
    for (const nested of assetReferences(body)) if (!seen.has(nested.replace(/^\//, ""))) queue.push(nested);
  }

  const publicContent = bodies.join("\n");
  if (!publicContent.includes(config.url)) throw new Error("Deployed browser assets omit the configured public Supabase URL.");
  if (!publicContent.includes(config.key)) throw new Error("Deployed browser assets omit the configured public Supabase key.");
  if (containsPrivilegedSupabaseCredential(publicContent, config.privilegedValues)) {
    throw new Error("Deployed browser assets contain a privileged Supabase credential.");
  }

  for (const path of ["/.env", "/shell/.env", "/shell/web/.env"]) {
    const response = await fetchImpl(`${base}${path}`, { redirect: "manual" });
    const body = await response.text();
    if (/^\s*(?:VITE_)?SUPABASE_[A-Z_]+\s*=/m.test(body)
      || containsPrivilegedSupabaseCredential(body, config.privilegedValues)) {
      throw new Error(`Public path ${path} exposes environment configuration.`);
    }
  }

  const authResponse = await fetchImpl(`${config.url}/auth/v1/settings`, {
    headers: { apikey: config.key },
  });
  if (!authResponse.ok) throw new Error(`Supabase Auth rejected the public browser configuration with HTTP ${authResponse.status}.`);
  const authSettings = await authResponse.json();
  if (authSettings?.disable_signup === true) throw new Error("Supabase Auth has public signup disabled.");

  assets.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    authUrlHost: new URL(config.url).host,
    keyKind: config.keyKind,
    keyFingerprint: config.keyFingerprint,
    signupEnabled: true,
    sourceMapCount: assets.filter(({ path }) => path.endsWith(".map")).length,
    assets,
  };
}
