// Cookieless visitor identity.
//
// A visitor is sha256(salt-of-the-day + ip + user agent + app). The salt is random per day and
// deleted after two days, so once it is gone nobody — including us, holding the raw IP — can
// recompute yesterday's hash or link it to today's. That property is what makes this lawful
// without a consent banner, and it is the reason the salt is never derived from a fixed secret.
//
// The raw IP exists only as an argument to the hash, for the length of one request. It is never
// written anywhere.

import { createHash, randomBytes } from "node:crypto";
import { serviceClient } from "../supabase.mjs";

// Salts older than this cannot be used to correlate anything, so they are destroyed. Two days,
// not one, so a request arriving either side of midnight UTC still finds its salt.
export const SALT_RETENTION_DAYS = 2;
const SESSION_WINDOW_MS = 30 * 60 * 1000;

const cache = new Map();

export function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// Ingest runs on every page view, so the salt is cached in process. A cold start does one read.
export async function saltFor(day, client = serviceClient()) {
  if (cache.has(day)) return cache.get(day);

  const { data: existing } = await client
    .from("analytics_salts").select("salt").eq("day", day).maybeSingle();
  if (existing?.salt) {
    cache.set(day, existing.salt);
    return existing.salt;
  }

  const salt = randomBytes(32).toString("hex");
  // Two ingests can race on the first request of a day. Whoever loses the insert re-reads, so both
  // end up with the same salt — otherwise the same person would count as two visitors.
  const { error } = await client.from("analytics_salts").insert({ day, salt });
  if (error) {
    const { data: winner } = await client
      .from("analytics_salts").select("salt").eq("day", day).maybeSingle();
    const settled = winner?.salt || salt;
    cache.set(day, settled);
    return settled;
  }
  cache.set(day, salt);
  return salt;
}

export function hashVisitor({ salt, ip, userAgent, appId }) {
  return createHash("sha256")
    .update(`${salt}|${ip || ""}|${userAgent || ""}|${appId || ""}`)
    .digest("hex");
}

// A session is the same visitor within a 30-minute window. Derived rather than stored, so there is
// still no identifier on the visitor's device.
export function hashSession(visitorHash, now = Date.now()) {
  return createHash("sha256")
    .update(`${visitorHash}|${Math.floor(now / SESSION_WINDOW_MS)}`)
    .digest("hex");
}

export async function identify({ ip, userAgent, appId, now = new Date(), client = serviceClient() }) {
  const day = dayKey(now);
  const salt = await saltFor(day, client);
  const visitorHash = hashVisitor({ salt, ip, userAgent, appId });
  return { day, visitorHash, sessionHash: hashSession(visitorHash, now.getTime()) };
}

// Destroy salts old enough that the hashes made with them can no longer be recomputed. This is the
// step that makes the whole scheme honest rather than merely cookieless.
export async function sweepSalts(client = serviceClient(), now = new Date()) {
  const cutoff = new Date(now.getTime() - SALT_RETENTION_DAYS * 86_400_000);
  const day = dayKey(cutoff);
  const { error } = await client.from("analytics_salts").delete().lt("day", day);
  if (error) throw new Error(`salt sweep failed: ${error.message || error}`);
  for (const key of cache.keys()) if (key < day) cache.delete(key);
  return { before: day };
}

export function __resetSaltCacheForTests() {
  cache.clear();
}
