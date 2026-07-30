#!/usr/bin/env node
// Thrallo CLI executable. All logic lives in cli/lib/cli.mjs so it stays unit-testable.

import { runCli } from "./lib/cli.mjs";

runCli(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`thrallo: ${error.message}`);
    process.exit(1);
  });
