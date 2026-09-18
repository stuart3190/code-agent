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
 * What the baseline runtime ships everywhere Builder V2 runs: the backend SDK, app-scoped auth
 * (app-auth is deployed and proven), generic entities and the entity change subscription. Every
 * optional service is NOT assumed. A deployment that provides more declares it explicitly.
 */
export function baselineDeploymentAvailability() {
  return declaredAvailability({ backend_sdk: true, app_auth: true, entities: true, realtime: true }, { source: "baseline" });
}

/**
 * Availability read from the shell environment. The public runtime configuration decides the
 * core trio; optional services are enabled only by an explicit THRALLO_APP_SERVICE_<NAME>=1.
 */
export function availabilityFromEnv(env = process.env) {
  const url = String(env.SUPABASE_URL || "").trim();
  const key = String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "").trim();
  const core = Boolean(url && key);
  const flag = (name) => String(env[`THRALLO_APP_SERVICE_${name.toUpperCase()}`] || "").trim() === "1";
  return declaredAvailability({
    backend_sdk: core, app_auth: core, entities: core, realtime: core,
    ...Object.fromEntries(["storage", "payments", "notifications", "analytics", "runtime_actions", "knowledge", "meta_connector"]
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
