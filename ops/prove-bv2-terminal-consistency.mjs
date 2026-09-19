#!/usr/bin/env node

// Read-only, zero-provider acceptance gate. Historical non-green work acknowledgements remain
// visible, but only active or post-policy inconsistencies block the current runtime.

import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { proveBv2TerminalConsistency } from "./lib/bv2TerminalConsistency.mjs";

loadEnv();
const report = await proveBv2TerminalConsistency({ client: serviceClient() });
console.log(JSON.stringify({ ok: report.forward_runtime_consistent, zeroModel: true, ...report }, null, 2));
if (!report.forward_runtime_consistent) process.exitCode = 1;
