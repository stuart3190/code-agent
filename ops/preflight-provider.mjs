// The pre-build provider preflight: which lane the next build will use, before any spend.
//   node ops/preflight-provider.mjs <ownerId>
import { loadEnv } from "../shell/server/lib/env.mjs";
import { resolveBuildContext } from "../shell/server/lib/appBuild/buildContext.mjs";
import { preflightSummary } from "../shell/server/lib/appBuild/providerPolicy.mjs";

loadEnv();
const owner = process.argv[2];
if (!owner) { console.error("usage: node ops/preflight-provider.mjs <ownerId>"); process.exit(1); }
const context = await resolveBuildContext(owner);
console.log(preflightSummary(context.policy));
console.log(`Model: ${context.strongModel}`);
console.log(`Managed settlement pause applies: ${context.byok ? "no (this lane is not managed)" : "yes"}`);
process.exit(0);
