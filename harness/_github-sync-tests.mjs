import assert from "node:assert/strict";
import { githubRepoName, githubTreeEntries } from "../shell/server/lib/githubSync.mjs";
import { evaluateFeature } from "../src/features/entitlements.mjs";

assert.equal(githubRepoName(" My Premium SaaS! "), "my-premium-saas");
assert.equal(githubRepoName("..."), "buildr101-app");
assert.equal(githubRepoName("a".repeat(200)).length, 100);

const entries = githubTreeEntries({ "src/App.jsx": "new", "README.txt": "readme" }, ["src/App.jsx", "old.txt"]);
assert.deepEqual(entries.find((entry) => entry.path === "src/App.jsx"), { path: "src/App.jsx", mode: "100644", type: "blob", content: "new" });
assert.equal(entries.find((entry) => entry.path === "old.txt").sha, null);
assert.equal(entries.some((entry) => entry.path === "user-added.txt"), false);

const enabled = { enabled: true, rollout_percent: 100 };
assert.equal(evaluateFeature({ feature: "github_export", flag: enabled, ownerId: "free", tier: null }).allowed, false);
assert.equal(evaluateFeature({ feature: "github_export", flag: enabled, ownerId: "paid", tier: "starter" }).allowed, true);
assert.equal(evaluateFeature({ feature: "github_sync", flag: enabled, ownerId: "paid", tier: "pro" }).allowed, true);

console.log("GitHub sync tests passed");
