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

const semanticTree = {
  "src/index.css": ":root { --primary: 210 50% 40%; }",
  "tailwind.config.js": 'export default { colors: { primary: "hsl(var(--primary))" } };',
};
const semantic = applyBrandToTree(semanticTree, {
  primary: "#ff0000", accent: "#00ff00", background: "#ffffff", surface: "#eeeeee", text: "#111111", font: "technical", radius: 6,
});
assert.match(semantic.tree["src/index.css"], /:root, \.dark, \[class\*="theme-"\]/);
assert.match(semantic.tree["src/index.css"], /--primary: 0 100% 50%/);
assert.match(semantic.tree["src/index.css"], /--accent: 120 100% 50%/);
assert.match(semantic.tree["src/index.css"], /--background: 0 0% 100%/);
assert.match(semantic.tree["src/index.css"], /--font-display: "IBM Plex Mono"/);
assert.doesNotMatch(semantic.tree["src/index.css"], /--primary: #ff0000/);

const builderSource = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../shell/web/src/builder/Builder.jsx", import.meta.url), "utf8"));
assert.match(builderSource, /searchParams\.set\("buildrStyle", Date\.now\(\)\.toString\(\)\)/);

console.log("Visual brand tests passed");
