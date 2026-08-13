import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const rootPackage = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const preflight = await readFile(new URL("../../ops/ensure-scaffold-deps.mjs", import.meta.url), "utf8");

test("a cold full-suite run installs shared scaffold dependencies before test-worker fan-out", () => {
  const script = rootPackage.scripts["test:code-agent"];
  assert.match(script, /^node ops\/ensure-scaffold-deps\.mjs && node --test /,
    "the dependency preflight must finish before node starts parallel test workers");
  assert.match(preflight, /import \{ ensureDeps \} from "\.\.\/harness\/workspace\.mjs"/);
  assert.match(preflight, /await ensureDeps\(\)/);
});
