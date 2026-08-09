import {
  FIXTURE_PROVIDER_KIND,
  PROVIDER_CONTRACT_VERSION,
  assertCloudDesktopProvider,
  capabilityUnavailable,
} from "./providerContract.js";

export function createFixtureProvider({ seed = "c0", scenario = "neutral" } = {}) {
  const identity = Object.freeze({ seed: String(seed), scenario: String(scenario) });
  const calls = [];

  const provider = {
    kind: FIXTURE_PROVIDER_KIND,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    getBootstrapState() {
      calls.push(Object.freeze({ method: "getBootstrapState", sequence: calls.length + 1 }));
      return Object.freeze({
        providerKind: FIXTURE_PROVIDER_KIND,
        seed: identity.seed,
        scenario: identity.scenario,
        applications: Object.freeze([]),
      });
    },
    invoke(capability) {
      calls.push(Object.freeze({ method: "invoke", capability: String(capability), sequence: calls.length + 1 }));
      return capabilityUnavailable(capability);
    },
    getCalls() {
      return calls.map((call) => ({ ...call }));
    },
  };

  return Object.freeze(assertCloudDesktopProvider(provider));
}
