import assert from "node:assert/strict";
import { isDeployableRelease } from "../shell/server/lib/environments.mjs";

const tree = { "src/App.jsx": "export default () => null" };
assert.equal(isDeployableRelease({ environment: "test", status: "ready", source_tree: tree }, "test"), true);
assert.equal(isDeployableRelease({ environment: "live", status: "ready", source_tree: tree }, "test"), false);
assert.equal(isDeployableRelease({ environment: "test", status: "failed", source_tree: tree }, "test"), false);
assert.equal(isDeployableRelease({ environment: "test", status: "ready", source_tree: null }, "test"), false);

console.log("Environment tests passed");
