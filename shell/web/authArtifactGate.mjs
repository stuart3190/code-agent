import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { containsPrivilegedSupabaseCredential } from "./publicAuthConfig.mjs";

async function filesUnder(root, current = root) {
  const out = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(root, absolute));
    else if (entry.isFile()) out.push({ absolute, relative: path.relative(root, absolute).replaceAll("\\", "/") });
  }
  return out;
}

export async function verifyWebAuthArtifact({ distDir, config }) {
  if (!config?.configured) throw new Error("Cannot verify a web artifact without public Supabase auth configuration.");
  const files = await filesUnder(distDir);
  const publicTextFiles = files.filter(({ relative }) => /\.(?:js|css|html|json|map|webmanifest|txt)$/i.test(relative));
  const contents = await Promise.all(publicTextFiles.map(async (file) => ({
    ...file,
    text: await readFile(file.absolute, "utf8"),
  })));
  const allText = contents.map(({ text }) => text).join("\n");

  if (!allText.includes(config.url)) throw new Error("Built web artifact does not contain the configured public Supabase URL.");
  if (!allText.includes(config.key)) throw new Error("Built web artifact does not contain the configured public Supabase key.");
  if (containsPrivilegedSupabaseCredential(allText, config.privilegedValues)) {
    throw new Error("Built web artifact contains a privileged Supabase credential.");
  }

  const assets = [];
  for (const file of files.filter(({ relative }) => /(?:^|\/)assets\/.*\.(?:js|css)$/i.test(relative))) {
    const bytes = await readFile(file.absolute);
    assets.push({
      path: file.relative,
      bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    });
  }
  assets.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    authUrlHost: new URL(config.url).host,
    keyKind: config.keyKind,
    keyFingerprint: config.keyFingerprint,
    sourceMapCount: files.filter(({ relative }) => relative.endsWith(".map")).length,
    assets,
  };
}
