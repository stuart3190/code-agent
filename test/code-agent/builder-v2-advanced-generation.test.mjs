// Deterministic reconstruction of the 2026-08-15 advanced asset-editor failure.
// No provider seam is used: scripted patches reproduce the retained monolith, fake async work,
// and decorative 3D candidate that the live build produced.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { clone, fromScaffold } from "../../src/engine/fileTree.mjs";
import { GENERATED_DEPENDENCIES } from "../../src/scaffolds/dependencyCatalog.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, depsNodeModules, ensureDeps } from "../../harness/workspace.mjs";
import { deriveBuildSpec, scopeBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { generationPolicyFor } from "../../shell/server/lib/builderV2/generationPolicy.mjs";
import { validateDependencyPlan } from "../../shell/server/lib/builderV2/dependencyPlan.mjs";
import { renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { applyPatches } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import {
  createOrchestrator, memoryBuildStore,
} from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import { verifyStage } from "../../shell/server/lib/builderV2/verification.mjs";

const PRIMARY = {
  id: "generate-validated-asset", title: "Generate a validated structured asset", priority: "primary",
  stage: "primary_journey", steps: [
    { action: "enter a plain-English asset prompt", target: "prompt box",
      expect: "the typed prompt remains visible", operates: ["prompt"], primitive: "textbox" },
    { action: "submit the prompt", target: "Generate button",
      expect: "planning and object graph validation progress is visible", reads: ["prompt"] },
    { action: "wait for generation to finish", target: "3D workspace",
      expect: "real model geometry appears on a grid with orbit and object selection" },
    { action: "reload the browser", target: "/app",
      expect: "the generated asset remains in history", reads: ["create-generation"] },
  ],
};

const PREVIEW = {
  id: "preview-and-select-parts", title: "Preview and select model parts", priority: "secondary",
  stage: "supporting", steps: [
    { action: "select a visible model part", target: "3D canvas",
      expect: "the selected object is highlighted with a bounding box" },
  ],
};

const EXPORT = {
  id: "download-compatible-exports", title: "Download compatible exports", priority: "secondary",
  stage: "supporting", steps: [
    { action: "download the XML model", target: "export panel",
      expect: "a compatible XML model download is created" },
  ],
};

const CONTRACT = {
  version: 1,
  summary: "A signed-in asset editor generates structured object graphs, renders them in genuine browser 3D, persists versions, and exports compatible model data.",
  projectType: "advanced_asset_editor",
  auth: { required: true, model: "email and password via the backend SDK", rules: [] },
  routes: [{ path: "/", name: "Auth" }, { path: "/app", name: "Workspace" }],
  entities: [
    { name: "assetGeneration", owned: true, fields: [{ name: "prompt", type: "string", required: true }] },
    { name: "assetVersion", owned: true, fields: [{ name: "modelSpec", type: "object", required: true }] },
    { name: "exportRecord", owned: true, fields: [{ name: "format", type: "string", required: true }] },
  ],
  operations: [
    { id: "create-generation", journey: PRIMARY.id, entity: "assetGeneration", description: "persist a generated asset" },
    { id: "create-initial-version", journey: PRIMARY.id, entity: "assetVersion", description: "persist its validated object graph" },
    { id: "record-export", journey: EXPORT.id, entity: "exportRecord", description: "record a real export" },
  ],
  journeys: [PRIMARY, PREVIEW, EXPORT], acceptance: [], states: [], integrations: [], imageIntents: [],
  deferred: [
    { item: "binary place serialization", reason: "XML model and reconstruction script are supported honestly" },
  ],
};
const CORE_CONTRACT = {
  ...CONTRACT,
  journeys: [PRIMARY],
  entities: CONTRACT.entities.slice(0, 2),
  operations: CONTRACT.operations.slice(0, 2),
};

test("the production preview base contains every generated-app dependency", () => {
  const previewPackage = JSON.parse(readFileSync(new URL("../../provisiond/base/package.json", import.meta.url), "utf8"));
  for (const [name, version] of Object.entries(GENERATED_DEPENDENCIES)) {
    assert.equal(previewPackage.dependencies[name], version,
      `${name} must be installed in the preview image at the compiler-supported version`);
  }
});

const patch = (fields) => ({ file: null, ops: null, newFile: null, content: null,
  deleteFile: null, replaceFile: null, ...fields });

const THREE_VIEW = `import { useEffect, useRef } from "react";
import * as THREE from "three";

export default function Browser3DView() {
  const host = useRef(null);
  useEffect(() => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
    camera.position.set(4, 3, 5);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2), new THREE.MeshStandardMaterial({ color: "#4f76c7" }));
    scene.add(mesh, new THREE.GridHelper(12, 12), new THREE.AmbientLight(0xffffff, 2));
    host.current.appendChild(renderer.domElement);
    const select = (event) => {
      pointer.set((event.offsetX / renderer.domElement.clientWidth) * 2 - 1, -(event.offsetY / renderer.domElement.clientHeight) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      mesh.material.emissive.set(raycaster.intersectObject(mesh).length ? "#284d91" : "#000000");
      renderer.render(scene, camera);
    };
    renderer.setSize(520, 360);
    renderer.domElement.addEventListener("pointerdown", select);
    renderer.render(scene, camera);
    return () => { renderer.domElement.removeEventListener("pointerdown", select); renderer.dispose(); host.current?.replaceChildren(); };
  }, []);
  return <section><div ref={host} aria-label="Interactive 3D model preview" /><p>Orbit, zoom, grid and object selection are enabled.</p></section>;
}
`;

const DATA = `import { makeEntityStore } from "../lib/capabilities/index.js";
export const generations = makeEntityStore({ entity: "assetGeneration" });
export const versions = makeEntityStore({ entity: "assetVersion" });
`;

const FLOW_WITH_DELAY = `import { useState } from "react";
import Browser3DView from "./Browser3DView.jsx";
import { generations, versions } from "../../data/crud.js";
export default function GenerateValidatedAssetFlow() {
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("idle");
  const generate = async () => {
    setStatus("planning and validating object graph");
    await new Promise((resolve) => setTimeout(resolve, 700));
    const record = await generations.create({ prompt });
    await versions.create({ assetId: record.id, modelSpec: { nodes: [{ type: "Part", size: [2, 1, 2] }] } });
    setStatus("generated asset remains in history");
  };
  return <main><label>Asset prompt<input value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label><button onClick={generate}>Generate</button><p>{status}</p><Browser3DView /></main>;
}
`;

const FLOW_REAL = FLOW_WITH_DELAY.replace(
  "    await new Promise((resolve) => setTimeout(resolve, 700));\n",
  "",
);

const ROUTE = `import GenerateValidatedAssetFlow from "../components/generate-validated-asset/GenerateValidatedAssetFlow.jsx";
export default function HomePage() { return <GenerateValidatedAssetFlow />; }
`;
const WORKSPACE_WITH_DELAY = FLOW_WITH_DELAY
  .replace('from "./Browser3DView.jsx"', 'from "../../components/generate-validated-asset/Browser3DView.jsx"')
  .replaceAll("GenerateValidatedAssetFlow", "WorkspaceScreen");
const WORKSPACE_REAL = WORKSPACE_WITH_DELAY.replace(
  "    await new Promise((resolve) => setTimeout(resolve, 700));\n", "",
);

test("advanced contract scoping supplies coherent primary modules and hides secondary work", () => {
  const spec = deriveBuildSpec(CONTRACT);
  assert.deepEqual(spec.tiers.essential.journeys, [PRIMARY.id]);
  assert.deepEqual(spec.tiers.essential.operations.sort(), ["create-generation", "create-initial-version"]);
  assert.deepEqual(spec.tiers.essential.entities.sort(), ["assetGeneration", "assetVersion"]);
  assert.deepEqual(spec.dependencyPlan.requirements.map((row) => [row.package, row.version]), [["three", "0.185.1"]]);

  const scoped = scopeBuildSpec(spec, [PRIMARY]);
  assert.deepEqual(scoped.operations.map((row) => row.id).sort(), ["create-generation", "create-initial-version"]);
  assert.deepEqual(scoped.entities.map((row) => row.name).sort(), ["assetGeneration", "assetVersion"]);
  assert.ok(scoped.modulePlan.some((row) => row.path.endsWith("/Browser3DView.jsx")), JSON.stringify(scoped.modulePlan));
  assert.ok(scoped.modulePlan.some((row) => row.path === "src/screens/scaffold/WorkspaceScreen.jsx"));
  assert.ok(!scoped.modulePlan.some((row) => row.path.endsWith("/GenerateValidatedAssetFlow.jsx")),
    "the scaffold screen replaces the old speculative whole-flow module");
  assert.ok(scoped.persistencePlan.owners.length > 0, "durable entity adapters have explicit owners");

  const prompt = renderPatchPrompt({ step: "core", contract: spec.contract, tiers: spec.tiers,
    tree: clone(fromScaffold(REACT_VITE)), modulePlan: scoped.modulePlan,
    moduleContracts: scoped.moduleContracts });
  assert.match(prompt, /three@0\.185\.1/);
  assert.match(prompt, /Generate a validated structured asset/);
  assert.doesNotMatch(prompt, /Preview and select model parts|Download compatible exports/,
    "core generation must not be briefed with secondary journeys");
  assert.doesNotMatch(prompt, /record-export/);
});

test("advanced policy separates bounded regeneration from retained-candidate correction", () => {
  assert.deepEqual(generationPolicyFor("simple"), {
    profile: "simple", maxGenerationAttempts: 3, maxCandidateCorrections: 2,
  });
  assert.deepEqual(generationPolicyFor("medium"), {
    profile: "medium", maxGenerationAttempts: 4, maxCandidateCorrections: 3,
  });
  assert.deepEqual(generationPolicyFor("advanced"), {
    profile: "advanced", maxGenerationAttempts: 5, maxCandidateCorrections: 5,
  });
});

test("an advanced build may reach a fourth full generation while a simple build remains capped", async () => {
  const invalid = () => [patch({
    newFile: "src/components/generate-validated-asset/Broken.jsx",
    content: "export default function Broken() { return (",
  })];
  const valid = () => [
    patch({ newFile: "src/components/generate-validated-asset/Browser3DView.jsx", content: THREE_VIEW }),
    patch({ newFile: "src/data/crud.js", content: DATA }),
    patch({ replaceFile: "src/screens/scaffold/WorkspaceScreen.jsx", content: WORKSPACE_REAL }),
  ];
  const run = async (profile) => {
    let calls = 0;
    const orchestrator = createOrchestrator({
      contractFn: async () => CORE_CONTRACT,
      patchesFn: async () => (++calls <= 3 ? invalid() : valid()),
      assetService: { resolveIntents: async () => ({ resolved: [], providerCalls: 0 }), assetManifestFor: async () => [] },
      snapshotStore: createSnapshotStore(), buildStore: memoryBuildStore(),
      baseTree: () => clone(fromScaffold(REACT_VITE)), baseline: REACT_VITE,
      compile: async () => ({ ok: true }),
      journeysFn: async ({ journeys }) => ({ journeys: journeys.map((journey) => ({ id: journey.id, status: "pass" })) }),
      classifyContract: async () => profile,
    });
    return { result: await orchestrator.runBuild({ owner: "owner", projectId: `project-${profile}`,
      request: `${profile} application`, profile, budgetCredits: 60 }), calls };
  };

  const simple = await run("simple");
  assert.equal(simple.result.state, "blocked");
  assert.match(simple.result.error, /within 3 generation attempts/);
  assert.equal(simple.calls, 3);

  const advanced = await run("advanced");
  assert.equal(advanced.result.state, "green", JSON.stringify(advanced.result));
  assert.equal(advanced.calls, 4, "the fourth bounded generation is admitted for advanced work");
});

test("structural batch preserves a non-promotable candidate and the exact modularity cause", () => {
  const tree = clone(fromScaffold(REACT_VITE));
  const giant = `export default function GenerateValidatedAssetFlow() { return <main>asset generation</main>; }\n/* ${"feature responsibility ".repeat(7_000)} */`;
  const result = applyPatches(tree, [
    patch({ newFile: "src/components/generate-validated-asset/GenerateValidatedAssetFlow.jsx", content: giant }),
    patch({ newFile: "src/components/generate-validated-asset/Browser3DView.jsx", content: THREE_VIEW }),
    patch({ newFile: "src/data/crud.js", content: DATA }),
  ], { contract: CONTRACT });
  assert.equal(result.modularityFailed, true);
  assert.equal(result.tree, tree, "ordinary result remains the safe original tree");
  assert.ok(result.provisionalTree["src/components/generate-validated-asset/Browser3DView.jsx"],
    "valid sibling work is retained only as a non-promotable candidate");
  assert.match(result.structuralProblems.join("\n"), /GenerateValidatedAssetFlow\.jsx is \d+ tokens/);
  assert.ok(result.rejected.every((row) => /structural invariant/.test(row.reason) || row.code === "tree_integrity_failed"));
});

test("orchestrator corrects the retained monolith and fake delay without full regeneration", async () => {
  const giant = `export default function GenerateValidatedAssetFlow() { return <main>asset generation</main>; }\n/* ${"feature responsibility ".repeat(7_000)} */`;
  const calls = [];
  const snapshots = [];
  const snapshotStore = createSnapshotStore();
  const orchestrator = createOrchestrator({
    contractFn: async () => CORE_CONTRACT,
    patchesFn: async (context) => {
      calls.push({ step: context.step, originalStep: context.originalStep,
        scope: context.repairScope?.kind || null, paths: Object.keys(context.tree).sort() });
      if (calls.length === 1) return [
        patch({ replaceFile: "src/screens/scaffold/WorkspaceScreen.jsx", content: giant }),
        patch({ newFile: "src/components/generate-validated-asset/Browser3DView.jsx", content: THREE_VIEW }),
        patch({ newFile: "src/data/crud.js", content: DATA }),
      ];
      if (calls.length === 2) return [
        patch({ replaceFile: "src/screens/scaffold/WorkspaceScreen.jsx", content: WORKSPACE_WITH_DELAY }),
      ];
      return [patch({ replaceFile: "src/screens/scaffold/WorkspaceScreen.jsx", content: WORKSPACE_REAL })];
    },
    assetService: { resolveIntents: async () => ({ resolved: [], providerCalls: 0 }), assetManifestFor: async () => [] },
    snapshotStore, buildStore: memoryBuildStore(), baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE, compile: async () => ({ ok: true }),
    journeysFn: async ({ journeys }) => ({ journeys: journeys.map((journey) => ({ id: journey.id, status: "pass" })) }),
    events: { checkpoint: async (event) => snapshots.push(event) },
    classifyContract: async () => "advanced",
  });

  const result = await orchestrator.runBuild({ owner: "owner", projectId: "advanced-project",
    request: "advanced structured asset editor with genuine browser 3D", profile: "advanced", budgetCredits: 60 });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(calls[0].step, "core");
  assert.equal(calls[1].step, "correction");
  assert.equal(calls[1].scope, "structural_modularity");
  assert.ok(calls[1].paths.includes("src/components/generate-validated-asset/Browser3DView.jsx"),
    "the correction receives the retained candidate, not the scaffold");
  assert.equal(calls[2].scope, "honesty");
  assert.equal(calls.filter((row) => row.step === "core").length, 1, "no whole-tree regeneration occurred");
  assert.ok(snapshots.some((row) => /candidate:core:1:structural/.test(row.reason)),
    "the invalid monolith is durably checkpointed as non-promotable evidence");
  assert.ok(snapshots.every((row) => row.promotable === false));
});

test("resume classifies a retained candidate before dispatch and buys only named corrections", async () => {
  const buildStore = memoryBuildStore();
  const sourceBuildId = await buildStore.create({ owner: "owner", project_id: "resume-project",
    profile: "advanced", request: "advanced asset editor", state: "blocked" });
  const snapshotStore = createSnapshotStore();
  const source = clone(fromScaffold(REACT_VITE));
  source["src/components/generate-validated-asset/Browser3DView.jsx"] =
    "export default function Browser3DView(){return <div><button>Orbit</button><div className='cube'>3D preview</div></div>}";
  source["src/screens/scaffold/WorkspaceScreen.jsx"] = WORKSPACE_WITH_DELAY;
  source["src/data/crud.js"] = DATA;
  await snapshotStore.createSnapshot("owner", "resume-project", source, {
    buildId: sourceBuildId, reason: "candidate:core:2",
  });
  const calls = [];
  const orchestrator = createOrchestrator({
    contractFn: async () => { throw new Error("resume must not regenerate a contract"); },
    patchesFn: async (context) => {
      calls.push({ step: context.step, scope: context.repairScope?.kind || null });
      if (context.repairScope?.kind === "runtime_dependency") {
        return [patch({ replaceFile: "src/components/generate-validated-asset/Browser3DView.jsx", content: THREE_VIEW })];
      }
      return [patch({ replaceFile: "src/screens/scaffold/WorkspaceScreen.jsx", content: WORKSPACE_REAL })];
    },
    assetService: { resolveIntents: async () => ({ resolved: [], providerCalls: 0 }), assetManifestFor: async () => [] },
    snapshotStore, buildStore, baseTree: () => clone(fromScaffold(REACT_VITE)), baseline: REACT_VITE,
    compile: async () => ({ ok: true }),
    journeysFn: async ({ journeys }) => ({ journeys: journeys.map((journey) => ({ id: journey.id, status: "pass" })) }),
  });

  const result = await orchestrator.runRepairFromCheckpoint({ owner: "owner", projectId: "resume-project",
    sourceBuildId, request: "repair the retained candidate", contract: CORE_CONTRACT,
    initialProblems: ["no runnable tree within 3 generation attempts"] });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.deepEqual(calls, [
    { step: "correction", scope: "runtime_dependency" },
    { step: "correction", scope: "honesty" },
  ], "the zero-model preflight avoids a broad repair or full regeneration");
});

test("decorative CSS 3D is rejected; a pinned, interactive Three.js module compiles", async () => {
  const spec = deriveBuildSpec(CONTRACT);
  const fake = clone(fromScaffold(REACT_VITE));
  fake["src/components/generate-validated-asset/Browser3DView.jsx"] =
    "export default function Browser3DView(){return <div><button>Orbit</button><div className='cube'>3D preview</div></div>}";
  let verdict = validateDependencyPlan(fake, spec.dependencyPlan);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.problems[0].code, "required_runtime_capability_missing");

  const real = clone(fromScaffold(REACT_VITE));
  real["src/components/generate-validated-asset/Browser3DView.jsx"] = THREE_VIEW;
  real["src/components/generate-validated-asset/GenerateValidatedAssetFlow.jsx"] = FLOW_REAL;
  real["src/data/crud.js"] = DATA;
  real["src/routes/HomePage.jsx"] = ROUTE;
  verdict = validateDependencyPlan(real, spec.dependencyPlan);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.problems));

  await ensureDeps(() => {});
  const gate = await verifyStage(real, {
    nodeModules: depsNodeModules(), baseline: REACT_VITE, contract: spec.contract,
    stage: { id: "core", journeys: [PRIMARY] },
    compile: (tree) => buildTree(tree, "advanced-generation-zero-model", () => {}),
  });
  assert.equal(gate.ok, true, JSON.stringify(gate.layers.d0d2.problems));
  assert.ok(gate.layers.d0d2.checks.some((row) => row.name === "dependencies" && row.ok));
  assert.ok(gate.layers.d0d2.checks.some((row) => row.name === "compile" && row.ok));
});
