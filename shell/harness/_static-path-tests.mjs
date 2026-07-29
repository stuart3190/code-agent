import assert from "node:assert/strict";
import path from "node:path";
import { resolveStaticPath } from "../server/lib/staticPath.mjs";

const root = path.resolve("shell/web/dist");
const inside = (...parts) => path.join(root, ...parts);

assert.equal(resolveStaticPath(root, "/index.html"), inside("index.html"));
assert.equal(resolveStaticPath(root, "/assets/app.js"), inside("assets", "app.js"));
assert.equal(resolveStaticPath(root, "/assets/../index.html"), inside("index.html"));

for (const pathname of [
  "/../package.json",
  "/%2e%2e%2fpackage.json",
  "/..%2f..%2f.env",
  "/%2e%2e%5cpackage.json",
  "/..\\package.json",
  "/%",
]) {
  assert.equal(resolveStaticPath(root, pathname), null, `must reject ${pathname}`);
}

console.log("static path security: pass");
