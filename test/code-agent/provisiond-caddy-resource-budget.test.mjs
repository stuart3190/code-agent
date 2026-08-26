import assert from "node:assert/strict";
import test from "node:test";

import { caddyRuntimeArgs } from "../../provisiond/docker.mjs";

test("shared Caddy has a bounded one-GiB no-swap budget by default", () => {
  assert.deepEqual(caddyRuntimeArgs({}), [
    "--memory", "1g", "--memory-swap", "1g", "--restart", "unless-stopped",
  ]);
});

test("shared Caddy memory remains explicitly configurable and bounded", () => {
  assert.deepEqual(caddyRuntimeArgs({ CADDY_MEMORY_LIMIT: "1280m" }), [
    "--memory", "1280m", "--memory-swap", "1280m", "--restart", "unless-stopped",
  ]);
  assert.throws(() => caddyRuntimeArgs({ CADDY_MEMORY_LIMIT: "unlimited" }),
    /CADDY_MEMORY_LIMIT/);
});
