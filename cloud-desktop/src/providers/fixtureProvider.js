import {
  FIXTURE_PROVIDER_KIND,
  PROVIDER_CONTRACT_VERSION,
  assertCloudDesktopProvider,
  capabilityUnavailable,
} from "./providerContract.js";
import { getApplicationRegistry } from "../apps/registry.js";
import { getScenario } from "../fixtures/scenarios.js";

export function createFixtureProvider({ seed = "thrallo-cloud-desktop-c1", scenario = "normal-active" } = {}) {
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
        applications: getApplicationRegistry().applications,
        workspace: getScenario(identity.scenario),
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
