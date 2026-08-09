import { assertSyntheticResourceName, redactedError } from "./policy.mjs";

export function createResourceRegistry() {
  const resources = [];
  return {
    register(resource) {
      assertSyntheticResourceName(resource.name);
      if (typeof resource.remove !== "function") throw new TypeError("cleanup resource requires remove()");
      resources.push({ ...resource, removed: false });
    },
    list() {
      return resources.map(({ remove: _remove, ...resource }) => ({ ...resource }));
    },
    async cleanup() {
      const results = [];
      for (const resource of [...resources].reverse()) {
        if (resource.removed) continue;
        try {
          await resource.remove();
          resource.removed = true;
          results.push({ kind: resource.kind, name: resource.name, outcome: "deleted" });
        } catch (error) {
          results.push({ kind: resource.kind, name: resource.name, outcome: "failed", error: redactedError(error) });
        }
      }
      return results;
    },
  };
}
