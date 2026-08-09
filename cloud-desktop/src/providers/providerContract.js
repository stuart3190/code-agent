export const PROVIDER_CONTRACT_VERSION = 1;
export const FIXTURE_PROVIDER_KIND = "fixture";
export const CAPABILITY_UNAVAILABLE = "capability_unavailable";

export function capabilityUnavailable(capability) {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code: CAPABILITY_UNAVAILABLE,
      capability: String(capability || "unknown"),
      message: "This capability is unavailable in the C0 fixture provider.",
    }),
  });
}
export function assertCloudDesktopProvider(provider) {
  if (!provider || provider.kind !== FIXTURE_PROVIDER_KIND) {
    throw new TypeError("C0 accepts the deterministic fixture provider only.");
  }
  if (typeof provider.getBootstrapState !== "function" || typeof provider.invoke !== "function") {
    throw new TypeError("Cloud desktop provider does not satisfy contract version 1.");
  }
  return provider;
}
