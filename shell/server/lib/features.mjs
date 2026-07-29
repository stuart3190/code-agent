import { FEATURE_REGISTRY, disabledFeatureMatrix, evaluateFeature } from "../../../src/features/entitlements.mjs";
import { isAdmin } from "./admin.mjs";
import { ledger } from "./services.mjs";
import { serviceClient } from "./supabase.mjs";

let cachedFlags = null;
let cachedAt = 0;
const CACHE_MS = 15_000;

async function loadFlags(client = serviceClient()) {
  if (cachedFlags && Date.now() - cachedAt < CACHE_MS) return cachedFlags;
  const { data, error } = await client.from("feature_flags").select("key,enabled,rollout_percent,config");
  if (error) throw new Error(`feature flags: ${error.message}`);
  cachedFlags = Object.fromEntries((data || []).map((row) => [row.key, row]));
  cachedAt = Date.now();
  return cachedFlags;
}

export function clearFeatureCache() {
  cachedFlags = null;
  cachedAt = 0;
}

export async function featureMatrix(owner, options = {}) {
  const admin = options.admin ?? isAdmin(owner);
  const entitlement = options.entitlement === undefined
    ? await ledger().getEntitlement(owner.id).catch(() => null)
    : options.entitlement;
  let flags;
  try {
    flags = options.flags || await loadFlags(options.client);
  } catch (error) {
    console.error(`[features] ${error.message}`);
    return {
      tier: entitlement?.tier || null,
      admin,
      features: disabledFeatureMatrix({ ownerId: owner.id, tier: entitlement?.tier || null, admin }),
    };
  }

  const features = Object.fromEntries(Object.keys(FEATURE_REGISTRY).map((feature) => [
    feature,
    evaluateFeature({
      feature,
      flag: flags[feature],
      ownerId: owner.id,
      tier: entitlement?.tier || null,
      admin,
    }),
  ]));
  return { tier: entitlement?.tier || null, admin, features };
}

export async function requireFeature(owner, feature, options = {}) {
  const matrix = await featureMatrix(owner, options);
  const access = matrix.features[feature];
  if (access?.allowed) return access;
  const error = new Error(access?.reason === "paid_plan_required"
    ? `${access.name} is available on paid plans.`
    : `${access?.name || "This feature"} is not available yet.`);
  error.code = access?.reason === "paid_plan_required" ? "upgrade_required" : "feature_unavailable";
  error.feature = feature;
  throw error;
}
