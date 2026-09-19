// Zero-model production preflight for the execution-first Builder V2 correction (92de017).
//
// Every check runs from the ACTUAL durable production worker context and makes ZERO provider
// calls. Nothing here mutates customer state: the preview it creates is destroyed, and the
// runtime proof deletes the visitor identity it creates.
//
// Run on the production host as the build-worker role:
//   sudo -u ubuntu THRALLO_PROCESS_ROLE=build-worker node ops/prove-execution-first-preflight.mjs

import crypto from "node:crypto";

import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { proveGeneratedRuntimeBackend } from "../shell/server/lib/runtimeEnv.mjs";
import { previewProvider } from "../shell/server/preview/index.mjs";
import { proveWorkerPreviewIsolation } from "../build-worker/previewIsolationPreflight.mjs";
import {
  SEVERITY, assertSeverityTablesDisjoint, partitionFindings, severityOf,
} from "../shell/server/lib/builderV2/validationSeverity.mjs";
import { deriveBuildSpec, scopeBuildSpec } from "../shell/server/lib/builderV2/buildSpec.mjs";
import { validateModuleConformance } from "../shell/server/lib/builderV2/moduleContracts.mjs";
import { lintDurablePersistence } from "../shell/server/lib/builderV2/persistenceLint.mjs";
import { durableOperationOwner } from "../shell/server/lib/builderV2/interactionContract.mjs";
import { bindCapabilities } from "../shell/server/lib/builderV2/contractTiering.mjs";
import { aggregateCapabilityFacts } from "../shell/server/lib/builderV2/capabilityLint.mjs";
import { memoryModelReservations } from "../shell/server/lib/builderV2/modelReservations.mjs";
import { createOrchestrator, memoryBuildStore } from "../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../shell/server/lib/builderV2/snapshotStore.mjs";
import { fromScaffold } from "../src/engine/fileTree.mjs";

loadEnv();

const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? ` — ${detail}` : ""}`);
  return ok;
};
const fail = (id, error) => record(id, false, error?.message || String(error));

// ── 1-2. worker context configuration ─────────────────────────────────────────────────────────

const preview = previewProvider();
record("preview_mode_vps", preview.mode === "vps", `PREVIEW_MODE resolved to ${preview.mode}`);
record("provisiond_url_present", Boolean(process.env.PROVISIOND_URL), "PROVISIOND_URL");
record("worker_role", process.env.THRALLO_PROCESS_ROLE === "build-worker",
  `THRALLO_PROCESS_ROLE=${process.env.THRALLO_PROCESS_ROLE || "(unset)"}`);
record("credential_store_supabase", process.env.CODE_AGENT_STORE === "supabase",
  `CODE_AGENT_STORE=${process.env.CODE_AGENT_STORE || "(unset)"}`);
record("managed_settlement_paused", process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED === "1",
  "settlement remains paused");

// ── 3-4. isolated provisioner reachability + real preview create/destroy ──────────────────────

const client = serviceClient();
let previewProof = null;
try {
  previewProof = await proveWorkerPreviewIsolation({ preview });
  record("provisioner_reachable", previewProof.health?.reachable === true,
    `origin ${previewProof.provisiondOrigin}, capacity ${previewProof.health?.capacity}`);
  record("isolated_preview_create_destroy",
    previewProof.status === "passed" && Boolean(previewProof.preview?.id) && Boolean(previewProof.teardown),
    `created and destroyed preview ${previewProof.preview?.id}`);
} catch (error) {
  fail("provisioner_reachable", error);
  fail("isolated_preview_create_destroy", error);
}

// ── 5-8. generated runtime: auth path, visitor session, authenticated CRUD, no privileged key ──

// app-auth validates that the appId is a real project ("valid appId required"), exactly as it
// does for a customer app. The proof therefore runs against a DISPOSABLE project row — the same
// shape a qualification build uses — and deletes it again whatever the outcome.
let smokeProjectId = null;
try {
  const anyOwner = await client.from("projects").select("owner").limit(1).single();
  if (anyOwner.error) throw new Error(`no owner available for the runtime probe: ${anyOwner.error.message}`);
  const created = await client.from("projects")
    .insert({ owner: anyOwner.data.owner, name: "execution-first runtime preflight", builder_version: "v2" })
    .select("id").single();
  if (created.error) throw new Error(`disposable project creation failed: ${created.error.message}`);
  smokeProjectId = created.data.id;

  const proof = await proveGeneratedRuntimeBackend({ projectId: smokeProjectId, adminClient: client });
  record("generated_vite_auth_url",
    proof?.appAuth === true && (proof?.materialized || []).includes("VITE_AUTH_URL"),
    "VITE_AUTH_URL materialised and app-auth answered");
  record("visitor_session_signup_recovery", proof?.visitorSession === true && proof?.sessionRecovery === true,
    "signup then recovery returned the same visitor identity");
  record("authenticated_runtime_crud", proof?.createReadUpdateDelete === true,
    "create/read/update/delete under the visitor identity");
  record("no_privileged_credential_in_runtime",
    proof?.source === "SUPABASE_ANON_KEY" && !/service_role|SUPABASE_SERVICE_ROLE|sb_secret/i.test(JSON.stringify(proof)),
    `runtime key source: ${proof?.source}`);
} catch (error) {
  fail("generated_vite_auth_url", error);
  fail("visitor_session_signup_recovery", error);
  fail("authenticated_runtime_crud", error);
  fail("no_privileged_credential_in_runtime", error);
} finally {
  if (smokeProjectId) {
    const removed = await client.from("projects").delete().eq("id", smokeProjectId);
    const residue = await client.from("projects").select("id").eq("id", smokeProjectId).maybeSingle();
    record("runtime_probe_cleanup", !removed.error && !residue.data,
      `disposable project ${smokeProjectId} removed`);
  }
}

// ── 9. candidate snapshots are non-promotable ─────────────────────────────────────────────────

try {
  const store = createSnapshotStore();
  const snapshot = await store.createSnapshot("preflight-owner", "preflight-project",
    { "src/App.jsx": "export default function App(){ return null; }" },
    { buildId: "preflight", reason: "candidate:core:1" });
  const materialisable = Boolean(await store.materialize("preflight-owner", snapshot.id));
  const pointer = await store.pointer("preflight-owner", "preflight-project", "green");
  record("candidate_snapshot_non_promotable", materialisable && pointer === null,
    "candidate materialises but never becomes a green pointer");
} catch (error) { fail("candidate_snapshot_non_promotable", error); }

// ── 10. severity model loaded as expected ─────────────────────────────────────────────────────

try {
  assertSeverityTablesDisjoint();
  const blockingOk = ["forbidden_persistence", "capability_owner_bypassed",
    "compile_failed", "protected_path_violation", "capability_method_unknown", "required_factory_missing"]
    .every((code) => severityOf(code) === SEVERITY.BLOCKING);
  const advisoryOk = ["required_method_uninvoked", "required_method_unbound", "required_module_missing",
    "module_plan_violation", "interaction_control_undriveable", "selection_state_unobservable",
    "review_data_flow_missing", "confirmation_data_flow_missing", "invalid_factory_configuration",
    "monolith_size", "process_memory", "durable_cancellation_missing"]
    .every((code) => severityOf(code) === SEVERITY.ADVISORY);
  const defaultAdvisory = severityOf("an_unreviewed_future_heuristic") === SEVERITY.ADVISORY;
  record("validation_severity_loaded", blockingOk && advisoryOk && defaultAdvisory,
    "blocking set, advisory set and advisory-by-default all as designed");
} catch (error) { fail("validation_severity_loaded", error); }

// ── 11-12. repair vs correction allowances ────────────────────────────────────────────────────

try {
  const reservations = memoryModelReservations();
  const reserve = (step, sequence) => reservations.reserve({
    owner: "preflight", projectId: "p", buildId: "b", callKey: `${step}-${sequence}`, step,
    provider: "codex", model: "gpt-5.5", billingLane: "connected_allowance",
    reservedCredits: 0.1, ceilingCredits: 100, maxRepairs: 1, maxCorrections: 2,
  });
  await reserve("core", 1);
  const c1 = await reserve("correction", 1);
  const c2 = await reserve("correction", 2);
  let correctionCapped = false;
  try { await reserve("correction", 3); } catch (error) { correctionCapped = error.code === "correction_limit_reached"; }
  const r1 = await reserve("repair", 1);
  let repairCapped = false;
  try { await reserve("repair", 2); } catch (error) { repairCapped = error.code === "repair_limit_reached"; }
  record("max_repairs_enforced", r1.repairDispatchCount === 1 && repairCapped,
    "one browser-informed repair, then refused");
  record("correction_allowance_separate",
    c1.repairDispatchCount === 0 && c2.correctionDispatchCount === 2 && correctionCapped
    && r1.repairDispatchCount === 1,
    "two corrections consumed zero repair slots; the repair remained available");
} catch (error) {
  fail("max_repairs_enforced", error);
  fail("correction_allowance_separate", error);
}

// ── 13. generic cancellation does not resolve to a booking capability ─────────────────────────

try {
  const crm = {
    summary: "A CRM for tracking customer subscriptions",
    entities: [{ name: "subscription", fields: [{ name: "plan" }, { name: "customerEmail" }] }],
    operations: [{ id: "cancel-subscription", entity: "subscription", action: "update" }],
    routes: [{ path: "/", name: "Subscriptions" }], auth: { required: false },
    journeys: [{ id: "manage-subscription", title: "Manage a subscription", priority: "primary", steps: [
      { action: "select a plan", target: "plan", expect: "plan becomes active" },
      { action: "enter the customer email", target: "customerEmail", expect: "email accepted" },
      { action: "review the subscription", target: "review", expect: "review shows the plan" },
      { action: "create the subscription", target: "create", expect: "subscription reference" },
      { action: "cancel the subscription", target: "cancel", expect: "status shows cancelled" },
    ] }],
  };
  const bindings = bindCapabilities(crm);
  const owner = durableOperationOwner(bindings);
  const spec = scopeBuildSpec(deriveBuildSpec(crm), crm.journeys);
  const serialised = JSON.stringify({ bindings, owner, plan: spec.modulePlan, flows: spec.interactionContract.flows });
  record("generic_cancellation_not_booking",
    owner.factory === "makeEntityStore" && !serialised.includes("makeBookingSystem"),
    `cancel-the-subscription resolves to ${owner.factory}`);
} catch (error) { fail("generic_cancellation_not_booking", error); }

// ── 14. useSyncExternalStore capability-reference form is accepted ────────────────────────────

try {
  const facts = aggregateCapabilityFacts({
    "src/app.jsx": `import { makeWizardMachine } from "./lib/capabilities";
const wizard = makeWizardMachine({ id: "w", steps: ["a"] });
export default function App() { return useSyncExternalStore(wizard.subscribe, wizard.getState); }`,
  }, []).get("makeWizardMachine");
  record("use_sync_external_store_accepted",
    facts.used.has("subscribe") && facts.used.has("getState") && !facts.invoked.has("subscribe"),
    "methods passed as references count as real usage");
} catch (error) { fail("use_sync_external_store_accepted", error); }

// ── 15. execution-first ordering, proven through the DEPLOYED orchestrator ────────────────────

const CONTRACT = {
  summary: "A booking workflow with durable confirmation",
  entities: [{ name: "booking", fields: [{ name: "date" }, { name: "slot" }] }],
  operations: [{ id: "create-booking", entity: "booking", action: "create" }],
  routes: [{ path: "/", name: "Booking" }], auth: { required: false },
  journeys: [{ id: "book", title: "Complete a booking", priority: "primary", steps: [
    { action: "select a date", target: "date", expect: "selected date becomes active" },
    { action: "review the booking", target: "review", expect: "review shows the date" },
    { action: "confirm booking", target: "confirm", expect: "durable booking reference" },
    { action: "cancel booking", target: "cancel booking", expect: "cancelled status" },
  ] }],
};
const UNPRESCRIBED = {
  "src/data/store.js": `import { makeBookingSystem, makeWizardMachine } from "../lib/capabilities";
export const bookings = makeBookingSystem({ entity: "booking" });
export const wizard = makeWizardMachine({ id: "book", steps: ["date", "review", "confirm"] });`,
  "src/routes/Booking.jsx": `import { useSyncExternalStore } from "react";
import { bookings, wizard } from "../data/store.js";
export default function Booking() {
  const state = useSyncExternalStore(wizard.subscribe, wizard.getState);
  return <main>
    <label htmlFor="date">Date</label>
    <input id="date" name="date" value={state.values.date || ""} onChange={(e) => { wizard.restore(); wizard.select("date", e.target.value); wizard.next(); }} />
    <p>Review: {state.values.date}</p>
    <button onClick={async () => wizard.confirm(await bookings.createBooking(state.values))}>Confirm booking</button>
    <button onClick={async () => { await bookings.cancelBooking("BK-1"); wizard.cancel(); }}>Cancel booking</button>
    <button onClick={() => bookings.getBooking("BK-1")}>Look up booking</button>
  </main>;
}`,
};

try {
  const { REACT_VITE } = await import("../src/scaffolds/reactVite.mjs");
  const timeline = [];
  const findings = [];
  const orchestrator = createOrchestrator({
    contractFn: async () => CONTRACT,
    patchesFn: async () => Object.entries(UNPRESCRIBED).map(([path, content]) => ({ newFile: path, content })),
    assetService: {
      async resolveIntents() { return { resolved: [], providerCalls: 0 }; },
      async assetManifestFor() { return []; },
    },
    snapshotStore: createSnapshotStore(),
    buildStore: memoryBuildStore(),
    baseTree: () => fromScaffold(REACT_VITE),
    baseline: REACT_VITE,
    compile: async () => { timeline.push("compile"); return { ok: true }; },
    journeysFn: async ({ journeys }) => {
      timeline.push("browser");
      return { journeys: journeys.map((journey) => ({ ...journey, status: "pass", steps: [] })) };
    },
    events: {
      checkpoint: async (event) => timeline.push(`checkpoint:${event.reason}:promotable=${event.promotable}`),
      candidateFindings: async (event) => findings.push(event),
    },
  });
  const outcome = await orchestrator.runBuild({ owner: "preflight", projectId: "preflight", request: "booking" });
  const checkpointAt = timeline.findIndex((row) => row.startsWith("checkpoint:candidate:"));
  const compileAt = timeline.indexOf("compile");
  const browserAt = timeline.indexOf("browser");
  const advisory = findings.flatMap((event) => event.advisory);
  const blocking = findings.flatMap((event) => event.blocking);
  record("execution_first_ordering",
    checkpointAt >= 0 && compileAt > checkpointAt && browserAt > compileAt,
    `order: ${timeline.filter((r) => !r.includes("corrected")).join(" -> ")}`);
  record("advisory_recorded_not_enforced", advisory.length > 0 && blocking.length === 0,
    `${advisory.length} advisory finding(s) recorded, ${blocking.length} blocking, build ${outcome.state}`);
} catch (error) {
  fail("execution_first_ordering", error);
  fail("advisory_recorded_not_enforced", error);
}

// ── verdict ───────────────────────────────────────────────────────────────────────────────────

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} production preflight checks passed`);
if (failed.length) {
  console.log(`FAILED: ${failed.map((row) => row.id).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("ZERO-MODEL PRODUCTION PREFLIGHT: GREEN — model dispatch is permitted");
}
