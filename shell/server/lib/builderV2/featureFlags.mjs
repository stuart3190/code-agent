// Builder v2 feature flags — DB-backed, cached, with an ABSOLUTE environment kill switch.
//
// Precedence (master plan Part 15): THRALLO_BV2_KILL=1 beats everything, checked on every
// read with no cache — an operator flipping the kill must not wait for a TTL. Below that,
// rows in bv2_feature_flags, cached for 60 seconds per process. An unknown flag is FALSE:
// v2 behaviour must always be opted into, never defaulted into.

import { serviceClient } from "../supabase.mjs";

const TTL_MS = 60_000;
let cache = { at: -Infinity, flags: new Map() };

export function killSwitchActive(env = process.env) {
  return env.THRALLO_BV2_KILL === "1";
}

async function reload(client, now) {
  const { data, error } = await client.from("bv2_feature_flags").select("key,value");
  if (error) throw new Error(`bv2 flags unreadable: ${error.message}`);
  cache = { at: now(), flags: new Map((data || []).map((row) => [row.key, row.value])) };
}

/**
 * Read one flag. Returns the stored JSON value (so allowlists work), or false when unset.
 * A flags-table read failure returns FALSE for everything — v2 fails closed, v1 is never
 * affected by v2's storage being unhappy.
 */
export async function flagValue(key, { client = serviceClient(), now = Date.now, env = process.env } = {}) {
  if (killSwitchActive(env)) return false;
  if (now() - cache.at > TTL_MS) {
    try {
      await reload(client, now);
    } catch (error) {
      console.error(`[bv2] ${error.message} — treating every flag as off`);
      cache = { at: now(), flags: new Map() };
    }
  }
  return cache.flags.has(key) ? cache.flags.get(key) : false;
}

/** Boolean convenience: any truthy stored value counts as on. */
export async function flagOn(key, options) {
  return Boolean(await flagValue(key, options));
}

/** Owner allowlist convenience: value may be `true` (everyone) or an array of owner ids. */
export async function flagOnFor(key, owner, options) {
  const value = await flagValue(key, options);
  if (value === true) return true;
  if (Array.isArray(value)) return value.includes(owner);
  return false;
}

export async function setFlag(key, value, { client = serviceClient(), updatedBy = "ops" } = {}) {
  const { error } = await client.from("bv2_feature_flags")
    .upsert({ key, value, updated_at: new Date().toISOString(), updated_by: updatedBy });
  if (error) throw new Error(`bv2 flag write failed: ${error.message}`);
  cache = { at: -Infinity, flags: new Map() }; // next read refetches
}

export function __resetFlagCacheForTests() {
  cache = { at: -Infinity, flags: new Map() };
}
