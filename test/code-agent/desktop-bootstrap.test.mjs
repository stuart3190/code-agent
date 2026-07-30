import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const desktop = new URL("../../desktop/", import.meta.url);

test("the upstream pin is a real, exact Code - OSS commit", async () => {
  const pin = JSON.parse(await readFile(new URL("upstream.json", desktop), "utf8"));
  assert.equal(pin.repository, "https://github.com/microsoft/vscode.git");
  assert.match(pin.tag, /^\d+\.\d+\.\d+$/);
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  assert.equal(pin.license, "MIT");
});

test("the product overlay carries Thrallo identity, Open VSX, and no Microsoft marketplace", async () => {
  const overrides = JSON.parse(await readFile(new URL("product.overrides.json", desktop), "utf8"));
  assert.equal(overrides.nameShort, "Thrallo");
  assert.equal(overrides.nameLong, "Thrallo Desktop");
  assert.equal(overrides.applicationName, "thrallo");
  assert.equal(overrides.dataFolderName, ".thrallo");
  assert.equal(overrides.darwinBundleIdentifier, "com.thrallo.desktop");
  assert.equal(overrides.extensionsGallery.serviceUrl, "https://open-vsx.org/vscode/gallery");
  assert.equal(overrides.enableTelemetry, false);
  assert.equal(overrides.updateUrl, "", "updates stay disabled until an update server exists");
  assert.equal(overrides.quality, undefined,
    "quality must stay unset: stable/insider flips the win32 packager into the appx branch, which needs Microsoft-proprietary win32ContextMenu DLL config");
  const raw = JSON.stringify(overrides);
  assert.doesNotMatch(raw, /marketplace\.visualstudio\.com/i, "Microsoft's marketplace is not licensed for forks");
  assert.doesNotMatch(raw, /vscode-unpkg\.net|az764295\.vo\.msecnd\.net/i);
});

test("desktop assets and scripts exist and the icon containers are well-formed", async () => {
  for (const file of ["bootstrap.mjs", "build.mjs", "generate-assets.mjs", "README.md"]) {
    await access(new URL(file, desktop));
  }
  const ico = await readFile(new URL("assets/thrallo.ico", desktop));
  assert.deepEqual([...ico.subarray(0, 4)], [0, 0, 1, 0], "ICO magic");
  assert.ok(ico.readUInt16LE(4) >= 2, "ICO carries multiple sizes");
  const icns = await readFile(new URL("assets/thrallo.icns", desktop));
  assert.equal(icns.subarray(0, 4).toString("ascii"), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length, "ICNS declared length matches");
  const png = await readFile(new URL("assets/thrallo-512.png", desktop));
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("no secrets appear anywhere in the desktop overlay inputs", async () => {
  for (const file of ["upstream.json", "product.overrides.json", "bootstrap.mjs", "build.mjs"]) {
    const content = await readFile(new URL(file, desktop), "utf8");
    assert.doesNotMatch(content, /thrallo_pat_[0-9a-f]{10}/);
    assert.doesNotMatch(content, /sk-[A-Za-z0-9]{20}/);
    assert.doesNotMatch(content, /SUPABASE_SERVICE|PLATFORM_ENC_KEY/);
  }
});

test("the local index scores identifier overlap and bounds excerpts", () => {
  const { buildLocalIndex, queryLocalIndex, isIndexableFile } =
    require("../../editor/vscode/lib/localIndex.js");
  const index = buildLocalIndex([
    { path: "src/retry.js", content: "export function retryWithBackoff(task) {\n  const delayMs = 100;\n  return task();\n}" },
    { path: "src/other.js", content: "export const unrelatedThing = 1;" },
  ]);
  const hits = queryLocalIndex(index, "call retryWithBackoff with delayMs", { limit: 2 });
  assert.equal(hits[0].path, "src/retry.js");
  assert.ok(hits[0].score > 0);
  assert.ok(hits[0].content.length <= 1500);
  assert.deepEqual(queryLocalIndex(index, "retryWithBackoff", { limit: 2, excludePath: "src/retry.js" })
    .map((hit) => hit.path), []);
  assert.equal(isIndexableFile("node_modules/x/index.js", 10), false);
  assert.equal(isIndexableFile("src/app.png", 10), false);
  assert.equal(isIndexableFile("src/app.ts", 400_000), false);
  assert.equal(isIndexableFile("src/app.ts", 4_000), true);
});

test("completion input accepts bounded local context and drops junk entries", async () => {
  const { parseCompletionInput } = await import("../../shell/server/lib/completions.mjs");
  const parsed = parseCompletionInput({
    prefix: "const x = ",
    localContext: [
      { path: "a.js", startLine: 1, endLine: 30, content: "x".repeat(5_000) },
      { path: "", content: "no path" },
      { path: "b.js", startLine: 2, endLine: 9, content: "   " },
      { path: "c.js", startLine: 1, endLine: 5, content: "ok" },
      { path: "d.js", startLine: 1, endLine: 5, content: "dropped by limit" },
      { path: "e.js", startLine: 1, endLine: 5, content: "dropped by limit" },
    ],
  });
  assert.equal(parsed.localContext.length, 3, "valid entries fill the 3-excerpt limit");
  assert.equal(parsed.localContext[0].content.length, 1_500);
  assert.deepEqual(parsed.localContext.map((entry) => entry.path), ["a.js", "c.js", "d.js"]);
});
