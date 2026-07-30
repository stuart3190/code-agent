#!/usr/bin/env node
// Thrallo CLI executable. All logic lives in cli/lib/cli.mjs so it stays unit-testable.

import { runCli } from "./lib/cli.mjs";

// process.exitCode (not process.exit) lets libuv handles drain — process.exit here crashes
// intermittently on Windows with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)".
runCli(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`thrallo: ${error.message}`);
    process.exitCode = 1;
  });
