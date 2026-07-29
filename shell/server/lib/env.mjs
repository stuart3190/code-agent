// Minimal .env loader (no dependency). Reads KEY=VALUE lines from the first of
// shell/.env or the repo-root .env into process.env WITHOUT overwriting anything
// already set in the real environment (exported vars win — same custody model as
// every prior phase: secrets come from the environment, never from committed files).

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SHELL_DIR = path.resolve(HERE, "..", "..");        // app-builder/shell
export const REPO_ROOT = path.resolve(SHELL_DIR, "..");          // app-builder

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

let loaded = false;
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  for (const p of [path.join(SHELL_DIR, ".env"), path.join(REPO_ROOT, ".env")]) {
    if (!existsSync(p)) continue;
    const vals = parseEnv(readFileSync(p, "utf8"));
    for (const [k, v] of Object.entries(vals)) {
      if (process.env[k] === undefined) process.env[k] = v; // real env wins
    }
  }
}

// Read a required env var or throw a clear, secret-free error.
export function requireEnv(name) {
  loadEnv();
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (set it in the environment or shell/.env — never commit it).`);
  return v;
}

export function optionalEnv(name, fallback = undefined) {
  loadEnv();
  return process.env[name] ?? fallback;
}
