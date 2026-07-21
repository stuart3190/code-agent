import assert from "node:assert/strict";
import { applyBrandToTree, cleanBrandConfig } from "../shell/server/lib/visualBrand.mjs";

const config = cleanBrandConfig({
  primary: "#ABCDEF", accent: "bad", background: "#010203", surface: "#111111", text: "#ffffff", font: "editorial", radius: 99,
});
assert.equal(config.primary, "#abcdef");
assert.equal(config.accent, "#f59e0b");
assert.equal(config.font, "editorial");
assert.equal(config.radius, 32);

const original = { "src/index.css": "@tailwind base;\nbody { margin: 0; }", "src/App.jsx": "export default () => null" };
const first = applyBrandToTree(original, config);
assert.equal(original["src/index.css"], "@tailwind base;\nbody { margin: 0; }");
assert.match(first.tree["src/index.css"], /--buildr-primary: #abcdef/);
assert.match(first.tree["src/index.css"], /Georgia/);
assert.match(first.tree["src/index.css"], /--buildr-radius: 32px/);

const second = applyBrandToTree(first.tree, { ...config, primary: "#123456", radius: 4 });
assert.equal((second.tree["src/index.css"].match(/buildr101:visual-brand:start/g) || []).length, 1);
assert.match(second.tree["src/index.css"], /--buildr-primary: #123456/);
assert.doesNotMatch(second.tree["src/index.css"], /--buildr-primary: #abcdef/);
assert.equal(second.tree["src/App.jsx"], original["src/App.jsx"]);

console.log("Visual brand tests passed");
