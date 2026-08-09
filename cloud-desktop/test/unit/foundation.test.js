import { describe, expect, it } from "vitest";
import { getApplicationRegistry } from "../../src/apps/registry.js";
import { createFixtureProvider } from "../../src/providers/fixtureProvider.js";
import { CAPABILITY_UNAVAILABLE, FIXTURE_PROVIDER_KIND } from "../../src/providers/providerContract.js";

describe("C0 cloud desktop foundation", () => {
  it("registers no applications before C1", () => {
    const registry = getApplicationRegistry();
    expect(registry.contractVersion).toBe(1);
    expect(registry.applications).toEqual([]);
    expect(Object.isFrozen(registry.applications)).toBe(true);
  });

  it("uses only a deterministic fixture provider", () => {
    const first = createFixtureProvider({ seed: "same", scenario: "neutral" });
    const second = createFixtureProvider({ seed: "same", scenario: "neutral" });

    expect(first.kind).toBe(FIXTURE_PROVIDER_KIND);
    expect(first.getBootstrapState()).toEqual(second.getBootstrapState());
    expect(first.getCalls()).toEqual(second.getCalls());
  });

  it("fails closed for unsupported capabilities and records the call", () => {
    const provider = createFixtureProvider({ seed: "c0", scenario: "neutral" });
    const result = provider.invoke("workspace.create");

    expect(result).toMatchObject({
      ok: false,
      error: { code: CAPABILITY_UNAVAILABLE, capability: "workspace.create" },
    });
    expect(provider.getCalls()).toEqual([
      { method: "invoke", capability: "workspace.create", sequence: 1 },
    ]);
  });
});
