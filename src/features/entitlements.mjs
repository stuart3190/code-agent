export const FEATURE_REGISTRY = Object.freeze({
  publish: { name: "Publishing", tiers: ["starter", "pro", "studio"], alwaysOn: true },
  custom_domains: { name: "Custom domains", tiers: ["pro", "studio"], alwaysOn: true },
  source_zip_export: { name: "Source ZIP export", alwaysOn: true },
  test_fix: { name: "Test and Fix" },
  saas_runtime: { name: "SaaS runtime" },
  visual_editor: { name: "Visual editor" },
  owner_console: { name: "App owner console" },
  github_export: { name: "GitHub export", tiers: ["starter", "pro", "studio"] },
  github_sync: { name: "GitHub sync", tiers: ["starter", "pro", "studio"] },
  integrations: { name: "Integrations" },
  analytics: { name: "Analytics" },
  environments: { name: "Test and live environments" },
  templates: { name: "Templates and remixing" },
  capability_runtime: { name: "Capability runtime" },
  managed_ai_runtime: { name: "Managed AI runtime" },
  media_runtime: { name: "Media runtime" },
  knowledge_runtime: { name: "Knowledge runtime" },
  app_usage_packs: { name: "App usage packs" },
});

export function rolloutBucket(ownerId, feature) {
  const value = `${ownerId || "anonymous"}:${feature}`;
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 100;
}

export function evaluateFeature({ feature, flag, ownerId, tier = null, admin = false }) {
  const definition = FEATURE_REGISTRY[feature];
  if (!definition) return { feature, enabled: false, allowed: false, reason: "unknown_feature" };

  const enabled = definition.alwaysOn || !!flag?.enabled;
  const rollout = definition.alwaysOn ? 100 : Math.max(0, Math.min(100, Number(flag?.rollout_percent || 0)));
  const inRollout = enabled && (admin || rolloutBucket(ownerId, feature) < rollout);
  const tierAllowed = admin || !definition.tiers || definition.tiers.includes(tier);
  const reason = !enabled ? "disabled"
    : !inRollout ? "not_in_rollout"
      : !tierAllowed ? "paid_plan_required" : null;

  return {
    feature,
    name: definition.name,
    enabled,
    inRollout,
    tierAllowed,
    allowed: inRollout && tierAllowed,
    reason,
    requiredTiers: definition.tiers || null,
    config: flag?.config || {},
  };
}

export function disabledFeatureMatrix({ ownerId = null, tier = null, admin = false } = {}) {
  return Object.fromEntries(Object.keys(FEATURE_REGISTRY).map((feature) => [
    feature,
    evaluateFeature({ feature, flag: { enabled: false, rollout_percent: 0 }, ownerId, tier, admin }),
  ]));
}
