// Node's test runner executes files in parallel processes. Prime the shared generated-app
// dependency tree once before that fan-out: the in-process promise in ensureDeps prevents duplicate
// installs inside one worker, but cannot coordinate separate test workers in a cold checkout.
import { ensureDeps } from "../harness/workspace.mjs";

await ensureDeps();
