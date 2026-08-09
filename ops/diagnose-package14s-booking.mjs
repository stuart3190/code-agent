// Read-only reconstruction of Package 14S core attempts. It reports only structural
// capability/module defects, never generated source or credentials.

import { fromScaffold } from "../src/engine/fileTree.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { applyPatches } from "../shell/server/lib/builderV2/patchEngine.mjs";
import { bindCapabilities, deriveModulePlan } from "../shell/server/lib/builderV2/contractTiering.mjs";
import { lintRequiredCapabilityBindings, lintRequiredModulePlan } from "../shell/server/lib/builderV2/capabilityLint.mjs";

loadEnv();
const buildId = process.argv[2];
if (!buildId) throw new Error("build id required");
const client = serviceClient();
const get = async (query, label) => {
  const result = await query;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
};
const contractRow = await get(client.from("bv2_contracts").select("contract").eq("build_id", buildId).single(), "contract");
const rows = await get(client.from("bv2_patches").select("patch,created_at").eq("build_id", buildId).order("created_at"), "patches");
const groups = [];
for (const row of rows) {
  const current = groups.at(-1);
  if (!current || Date.parse(row.created_at) - Date.parse(current.at) > 5_000) groups.push({ at: row.created_at, rows: [row] });
  else current.rows.push(row);
}
const bindings = bindCapabilities(contractRow.contract);
const essential = (contractRow.contract.journeys || []).filter((journey) => journey.priority === "primary");
const plan = deriveModulePlan(contractRow.contract, essential);
const report = groups.map((group, index) => {
  const tree = fromScaffold(REACT_VITE);
  const applied = applyPatches(tree, group.rows.map((row) => row.patch), { contract: contractRow.contract });
  const capabilities = lintRequiredCapabilityBindings(applied.tree, bindings);
  const modules = lintRequiredModulePlan(applied.tree, plan);
  const source = Object.entries(applied.tree)
    .filter(([file]) => /^src\//.test(file) && !/^src\/lib\/(backend|capabilities)\//.test(file))
    .map(([, value]) => String(value)).join("\n");
  const factoryPatterns = bindings.filter((binding) => binding.requiredMethods?.length).map((binding) => {
    const factory = { booking: "makeBookingSystem", wizard: "makeWizardMachine", contact: "makeContactForm" }[binding.name];
    const declaration = factory
      ? source.match(new RegExp(`(?:const|let|var)\\s+([^=\\n]+)=\\s*${factory}\\s*\\(`))?.[1]?.trim() || null
      : null;
    return {
      capability: binding.name,
      factory,
      declaration,
      requiredMethods: binding.requiredMethods,
      bareMethodCalls: binding.requiredMethods.filter((method) => new RegExp(`(?:^|[^.\\w])${method}\\s*\\(`, "m").test(source)),
    };
  });
  const relevantLines = Object.entries(applied.tree)
    .filter(([file]) => plan.some((row) => row.path === file && row.factory))
    .flatMap(([file, value]) => String(value).split(/\r?\n/)
      .filter((line) => /makeBookingSystem|makeWizardMachine|createBooking|cancelBooking|getBooking|getState|subscribe|restore|select|next|confirm|cancel/.test(line))
      .map((line) => ({ file, line: line.trim().slice(0, 240) })));
  return {
    attempt: index + 1,
    patchCount: group.rows.length,
    patchRejections: applied.rejected.map((row) => row.reason),
    capabilityProblems: capabilities.problems,
    moduleProblems: modules.problems,
    factoryPatterns,
    relevantLines,
  };
});
console.log(JSON.stringify(report, null, 2));
