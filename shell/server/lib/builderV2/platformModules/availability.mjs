// Deployment availability (audit §4.1 "Optional service flags", §11 step 7).
//
// "Present in source" is not "available on this deployment". A module that requires a service the
// deployment does not provide must be reported as unavailable BEFORE implementation generation,
// never silently replaced by generated code. This file is the one place that says which services
// a deployment declares; the resolver consumes it and never assumes a service is enabled.

import { SERVICES } from "./registry.mjs";

export const AVAILABILITY_VERSION = 1;

const normalise = (services = {}) => Object.fromEntries(SERVICES.map((service) => [service, services[service] === true]));

/** An explicit declaration: every listed service is true or false, unknown services are false. */
export function declaredAvailability(services = {}, { source = "declared" } = {}) {
  const unknown = Object.keys(services).filter((service) => !SERVICES.includes(service));
  if (unknown.length) throw new Error(`unknown deployment services: ${unknown.join(", ")}`);
  return Object.freeze({ version: AVAILABILITY_VERSION, source, services: Object.freeze(normalise(services)) });
}

/**
 * What the SOURCE ships as platform-owned runtime: the backend SDK, app-scoped auth, generic
 * entities, the entity change subscription and — since WP4 — the app-accounts service. This is
 * the derivation default (tests, offline replays, compilation) and says what the platform CAN
 * install. It is not a claim about any deployment: the orchestrator resolves against
 * availabilityFromEnv(), where every optional service must be declared explicitly.
 */
export function baselineDeploymentAvailability() {
  return declaredAvailability({ backend_sdk: true, app_auth: true, entities: true, realtime: true, accounts: true }, { source: "source_baseline" });
}

/** A deployment that has not enabled any WP4+ service: the pre-migration production shape. */
export function legacyDeploymentAvailability() {
  return declaredAvailability({ backend_sdk: true, app_auth: true, entities: true, realtime: true }, { source: "legacy_deployment" });
}

/**
 * Availability read from the shell environment — the deployment's own declaration, and what a
 * live build resolves against. The public runtime configuration decides the core services;
 * every other service (the app-accounts function, storage, payments, …) is enabled only by an
 * explicit THRALLO_APP_SERVICE_<NAME>=1 once it has been deployed and its migration applied.
 */
export function availabilityFromEnv(env = process.env) {
  const url = String(env.SUPABASE_URL || "").trim();
  const key = String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "").trim();
  const core = Boolean(url && key);
  const flag = (name) => String(env[`THRALLO_APP_SERVICE_${name.toUpperCase()}`] || "").trim() === "1";
  return declaredAvailability({
    backend_sdk: core, app_auth: core, entities: core, realtime: core,
    ...Object.fromEntries(["storage", "payments", "notifications", "analytics", "runtime_actions", "knowledge", "meta_connector", "accounts"]
      .map((service) => [service, core && flag(service)])),
  }, { source: "env" });
}

/** Combine declarations; a service is available only when every source agrees. */
export function intersectAvailability(...availabilities) {
  const sources = availabilities.filter(Boolean);
  if (!sources.length) return baselineDeploymentAvailability();
  return declaredAvailability(Object.fromEntries(SERVICES.map((service) => [
    service, sources.every((availability) => availability.services?.[service] === true),
  ])), { source: sources.map((availability) => availability.source).join("+") });
}

export function serviceAvailable(availability, service) {
  return availability?.services?.[service] === true;
}
