import { GENERATED_DEPENDENCY_CATALOG } from "../../../../src/scaffolds/dependencyCatalog.mjs";

const contractText = (contract, journeys) => [
  contract?.summary,
  ...(journeys || []).flatMap((journey) => [
    journey?.id, journey?.title,
    ...(journey?.steps || []).flatMap((step) => [step?.action, step?.expect]),
  ]),
  ...(contract?.acceptance || []).map((row) => typeof row === "string" ? row : row?.criterion || row?.description),
  ...(contract?.integrations || []).flatMap((row) => [row?.name, row?.purpose]),
].filter(Boolean).join(" ").toLowerCase();

const pathPart = (value) => String(value || "feature")
  .replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "feature";

/**
 * Map explicit contract capabilities onto packages already baked into the isolated compiler.
 * No package is inferred from an application brand or domain: the same browser-3D requirement
 * receives the same engine in a CAD viewer, a product configurator or a game-asset editor.
 */
export function deriveDependencyPlan(contract, journeys = contract?.journeys || []) {
  const text = contractText(contract, journeys);
  const requirements = GENERATED_DEPENDENCY_CATALOG.filter((entry) => (
    entry.signals.some((signal) => text.includes(signal))
  )).map((entry) => {
    const matchingJourneys = (journeys || []).filter((journey) => {
      const journeyText = contractText({ summary: "" }, [journey]);
      return entry.signals.some((signal) => journeyText.includes(signal));
    });
    const ownerJourney = matchingJourneys[0] || journeys?.[0] || null;
    const directory = pathPart(ownerJourney?.id);
    return {
      capability: entry.capability,
      package: entry.package,
      version: entry.version,
      role: entry.role,
      ownerJourneyId: ownerJourney?.id || null,
      journeyIds: matchingJourneys.map((journey) => journey.id),
      ownerModule: `src/components/${directory}/Browser3DView.jsx`,
      installMode: "sandbox_baked",
    };
  });
  return {
    version: 1,
    installMode: "sandbox_baked",
    networkDuringCompile: false,
    requirements,
  };
}

export function scopeDependencyPlan(plan, journeys = []) {
  const ids = new Set((journeys || []).map((journey) => journey?.id).filter(Boolean));
  return {
    ...(plan || { version: 1, installMode: "sandbox_baked", networkDuringCompile: false }),
    requirements: (plan?.requirements || []).filter((row) => {
      const owners = row.journeyIds?.length ? row.journeyIds : [row.ownerJourneyId].filter(Boolean);
      return !owners.length || owners.some((id) => ids.has(id));
    }),
  };
}

export function dependencyPlanBrief(plan) {
  if (!(plan?.requirements || []).length) {
    return "DEPENDENCY PLAN: use the fixed scaffold packages only; no additional runtime package is required for this scope.";
  }
  return [
    "APPROVED DEPENDENCY PLAN (machine-validated and already installed in the network-isolated sandbox):",
    ...(plan.requirements || []).map((row) => `- ${row.capability}: import ${row.package}@${row.version} in ${row.ownerModule}; ${row.role}.`),
    "Do not simulate these capabilities with decorative HTML/CSS, and do not add or change package versions.",
  ].join("\n");
}

/** Prove that a required specialist runtime is genuinely present, not merely named in copy. */
export function validateDependencyPlan(tree, plan) {
  const problems = [];
  let manifest = {};
  try { manifest = JSON.parse(tree?.["package.json"] || "{}"); }
  catch { return { ok: false, problems: [{ code: "dependency_manifest_invalid", file: "package.json", message: "package.json is not valid JSON" }] }; }
  const declared = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
  for (const requirement of plan?.requirements || []) {
    if (declared[requirement.package] !== requirement.version) {
      problems.push({
        code: "required_runtime_dependency_missing", file: "package.json",
        capability: requirement.capability, package: requirement.package,
        message: `required ${requirement.capability} runtime ${requirement.package}@${requirement.version} is not pinned in package.json`,
      });
      continue;
    }
    const imports = Object.entries(tree || {}).filter(([path, source]) => (
      /^src\/.*\.(?:jsx?|tsx?)$/.test(path)
      && new RegExp(`(?:from\\s*|import\\s*\\()["']${requirement.package.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[\\/"'])`).test(String(source))
    ));
    if (!imports.length) {
      problems.push({
        code: "required_runtime_capability_missing", file: requirement.ownerModule,
        capability: requirement.capability, package: requirement.package,
        message: `contract requires ${requirement.capability}, but generated source never imports the approved ${requirement.package} runtime`,
      });
      continue;
    }
    if (requirement.capability === "browser_3d") {
      const source = imports.map(([, value]) => String(value)).join("\n");
      if (!/\bWebGLRenderer\b/.test(source) || !/\b(?:Raycaster|OrbitControls)\b/.test(source)) {
        problems.push({
          code: "required_runtime_capability_incomplete", file: imports[0][0],
          capability: requirement.capability, package: requirement.package,
          message: "browser_3d requires a real WebGLRenderer plus camera/object interaction (Raycaster or OrbitControls); labels and CSS shapes are not a 3D engine",
        });
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
