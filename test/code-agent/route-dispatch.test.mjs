// Route-dispatch safety: `return handleX(...)` inside the dispatcher's try/catch does NOT
// catch the handler's async throw (the try exits before the promise rejects), so a routine
// 404 like "Conversation not found" became an unhandled rejection that killed the process
// in production (2026-07-31). Every dispatch must be `return await handleX(...)`.

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("every route handler dispatch is awaited so thrown 4xx errors are caught, not fatal", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../../shell/server/index.mjs", import.meta.url)), "utf8");
  const bare = source.match(/return handle\w+\(/g) || [];
  assert.deepEqual(bare, [], "un-awaited handler dispatches found — use `return await handleX(...)`");
  assert.ok((source.match(/return await handle\w+\(/g) || []).length > 40, "dispatches present");
});
