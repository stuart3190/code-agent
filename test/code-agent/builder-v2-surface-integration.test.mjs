import assert from "node:assert/strict";
import test from "node:test";

import { deriveBuildSpec, scopeBuildSpec }
  from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { renderPatchPrompt }
  from "../../shell/server/lib/builderV2/modelLanes.mjs";
import {
  defectEvidence, defectWriteBoundary, verificationDefectRecord, verificationDefects,
} from "../../shell/server/lib/builderV2/verificationDefects.mjs";
import { deriveVerificationManifest }
  from "../../shell/server/lib/builderV2/verificationManifest.mjs";
import { journeySurfaceContext }
  from "../../shell/server/lib/builderV2/surfaceIntegration.mjs";

const PRIMARY_FLOW = "src/components/reserve-low-cost-entry/ReserveLowCostEntryFlow.jsx";
const SECONDARY_FLOW = "src/components/see-entry-validation/SeeEntryValidationFlow.jsx";
const SECONDARY_CONFIRMATION = "src/components/see-entry-validation/SeeEntryValidationConfirmation.jsx";
const SECONDARY_BEHAVIOUR = "src/extensions/custom/see-entry-validation.js";
const ROUTE = "src/routes/Competitions.jsx";

const CONTRACT = {
  version: 1,
  summary: "A basic public competition website with simulated entry reservation",
  projectType: "website",
  buildProfile: {
    version: 1, requestedBuildType: "website", resolvedBuildType: "website",
    applicationSubtype: "auto", requirementSignals: [], inferenceSource: "auto", confidence: 0.8,
  },
  routes: [
    { path: "/", name: "Home", purpose: "Public landing page", auth: false },
    { path: "/competitions", name: "Competitions", purpose: "Competition entry form", auth: false },
  ],
  entities: [], operations: [], states: [], acceptance: [], deferred: [], integrations: [],
  auth: { required: false, model: null, rules: [] },
  journeys: [
    {
      id: "reserve-low-cost-entry", title: "A visitor reserves a simulated entry", priority: "primary",
      steps: [
        { action: "open competitions", target: "/competitions", expect: "competition cards are visible" },
        { action: "choose a competition", target: "competitionId", expect: "the entry form is visible" },
        { action: "submit the valid form", target: "reserve entries button", expect: "confirmation is visible" },
      ],
    },
    {
      id: "see-entry-validation", title: "A visitor sees entry validation", priority: "secondary",
      steps: [
        { action: "open competitions and choose a competition", target: "/competitions", expect: "the entry form is visible" },
        { action: "submit the entry form with missing required details", target: "reserve entries button",
          expect: "visible validation messages identify missing name, invalid or missing email, invalid quantity, or unaccepted terms" },
        { action: "correct the form fields", target: "entry form", expect: "validation messages clear" },
      ],
    },
  ],
};

const TREE = {
  "src/main.jsx": `import App from "./App.jsx"; export default App;`,
  "src/App.jsx": `
    import HomePage from "./routes/HomePage";
    import CompetitionsPage from "./routes/Competitions";
    const ROUTES = { "/": HomePage, "/competitions": CompetitionsPage };
    export default function App(){ const Page = ROUTES[window.location.pathname] || HomePage; return <Page/>; }
  `,
  "src/routes/HomePage.jsx": `export default function HomePage(){ return <main>Budget Competitions</main>; }`,
  [ROUTE]: `
    import ReserveLowCostEntryFlow from "../components/reserve-low-cost-entry/ReserveLowCostEntryFlow";
    export default function Competitions(){ return <ReserveLowCostEntryFlow/>; }
  `,
  [PRIMARY_FLOW]: `
    export default function ReserveLowCostEntryFlow(){
      return <form><button aria-label="reserve entries button">Reserve</button><p>Validation: entrant name is required.</p></form>;
    }
  `,
  [SECONDARY_FLOW]: `
    import { validate } from "../../extensions/custom/see-entry-validation.js";
    export default function SeeEntryValidationFlow(){ return <form>{validate().map(x => <p key={x}>{x}</p>)}</form>; }
  `,
  [SECONDARY_CONFIRMATION]: `export default function Confirmation(){ return <p>Simulation accepted</p>; }`,
  [SECONDARY_BEHAVIOUR]: `export const validate = () => ["Missing name", "Invalid email", "Invalid quantity", "Unaccepted terms"];`,
};

test("retained smoke shape exposes the mounted route and current flow to a secondary increment", () => {
  const spec = deriveBuildSpec(CONTRACT);
  const journey = spec.contract.journeys.find((row) => row.id === "see-entry-validation");
  const scoped = scopeBuildSpec(spec, [journey]);
  const surface = journeySurfaceContext(TREE, spec.contract, [journey], { modulePlan: scoped.modulePlan });

  assert.deepEqual(surface.routePaths, ["/competitions"]);
  assert.deepEqual(surface.routeFiles, [ROUTE]);
  assert.ok(surface.mountedPaths.includes(PRIMARY_FLOW));
  assert.ok(surface.unreachableJourneyModules.includes(SECONDARY_FLOW));
  assert.ok(surface.unreachableJourneyModules.includes(SECONDARY_BEHAVIOUR));

  const prompt = renderPatchPrompt({
    step: "increment:see-entry-validation", originalStep: "increment:see-entry-validation",
    contract: spec.contract, tiers: spec.tiers, tree: TREE, journey,
    modulePlan: scoped.modulePlan, moduleContracts: scoped.moduleContracts,
    capabilityGraph: scoped.capabilityGraph, compositionPlan: scoped.compositionPlan,
  });
  assert.match(prompt, /MOUNTED JOURNEY SURFACE \(current runtime authority\)/);
  assert.match(prompt, /src\/routes\/Competitions\.jsx/);
  assert.match(prompt, /src\/components\/reserve-low-cost-entry\/ReserveLowCostEntryFlow\.jsx/);
  assert.match(prompt, /A new source file that no reachable route imports does NOT implement the journey/);
  assert.match(prompt, /Validation: entrant name is required/,
    "the increment receives the actual mounted flow source, not only its path");
});

test("retained smoke browser defect makes the mounted route a first-class repair owner", () => {
  const spec = deriveBuildSpec(CONTRACT);
  const manifest = deriveVerificationManifest(spec);
  const journey = spec.contract.journeys.find((row) => row.id === "see-entry-validation");
  const result = {
    journeys: [{
      id: journey.id, title: journey.title, priority: journey.priority, status: "fail",
      owners: [SECONDARY_FLOW, SECONDARY_CONFIRMATION, SECONDARY_BEHAVIOUR],
      attributionStatus: "attributed",
      steps: [
        { ...journey.steps[0], status: "pass", drove: true },
        { ...journey.steps[1], status: "fail", drove: true,
          detail: "expected validation, messages, identify, missing, name; found validation, name",
          observation: { text: "Validation: entrant name is required.", consoleSince: [], requestsSince: [] } },
        { ...journey.steps[2], status: "not_reached" },
      ],
    }],
    blockingErrors: [], consoleErrors: [], failedRequests: [],
  };
  const defects = verificationDefects({
    contract: spec.contract, interactionContract: spec.interactionContract,
    journeyResults: result, tree: TREE, manifest,
  });
  const defect = defects.find((row) => row.journeyId === "see-entry-validation" && row.stepIndex === 1);
  assert.ok(defect, JSON.stringify(defects));
  assert.deepEqual(defect.evidence.surfaceIntegration.routeFiles, [ROUTE]);
  assert.ok(defect.evidence.surfaceIntegration.unreachableJourneyModules.includes(SECONDARY_FLOW));
  assert.ok(defect.modules.includes(ROUTE));
  assert.ok(defect.modules.includes(PRIMARY_FLOW));

  const boundary = defectWriteBoundary([defect]);
  assert.ok(boundary.allowedFiles.includes(ROUTE), JSON.stringify(boundary));
  assert.ok(boundary.allowedFiles.includes(PRIMARY_FLOW), JSON.stringify(boundary));
  assert.match(defectEvidence([defect]).join("\n"), /editing dead source alone cannot change the browser result/);

  const durable = verificationDefectRecord(defect, { sourceTreeHash: "tree-hash" });
  assert.deepEqual(durable.surfaceIntegration.routeFiles, [ROUTE]);
  assert.ok(durable.surfaceIntegration.unreachableJourneyModules.includes(SECONDARY_FLOW));
});

test("a journey component mounted by its contracted route is not classified unreachable", () => {
  const mounted = {
    ...TREE,
    [ROUTE]: `
      import SeeEntryValidationFlow from "../components/see-entry-validation/SeeEntryValidationFlow";
      export default function Competitions(){ return <SeeEntryValidationFlow/>; }
    `,
  };
  const context = journeySurfaceContext(mounted, CONTRACT, ["see-entry-validation"]);
  assert.equal(context.unreachableJourneyModules.includes(SECONDARY_FLOW), false);
  assert.ok(context.mountedPaths.includes(SECONDARY_FLOW));
});
