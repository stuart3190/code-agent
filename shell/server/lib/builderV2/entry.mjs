// Builder V2 customer-dispatch seam.
//
// V2 remains feature-gated until final cutover. Once an eligible request is accepted here it
// NEVER falls back to V1: queue/policy/budget failures are surfaced honestly. The durable worker
// owns all generation, compilation and browser work; this shell module only creates project/job
// records and relays coarse status.

import { createBudgetLedger } from "../appBuild/budgetLedger.mjs";
import { resolveBuildContext } from "../appBuild/buildContext.mjs";
import { createDiagSession } from "../appBuild/buildDiagnostics.mjs";
import { managedSettlementPaused, usesManagedCredits } from "../appBuild/providerPolicy.mjs";
import { normalizeByokSafety } from "../appBuild/byokSafety.mjs";
import { managedAffordableCreditLimit } from "../billingLimits.mjs";
import { createJob, subscribe } from "../buildJobs.mjs";
import { buildWorkerEnabled } from "../buildWorkQueue.mjs";
import { serviceClient } from "../supabase.mjs";
import { killSwitchActive, flagOn, flagOnFor } from "./featureFlags.mjs";

export async function v2BuildEligible(owner, options = {}) {
  try {
    if (killSwitchActive(options.env || process.env)) return { eligible: false, reason: "THRALLO_BV2_KILL is set" };
    if (!(await flagOn("bv2.enabled", options))) return { eligible: false, reason: "bv2.enabled is off" };
    if (!(await flagOnFor("bv2.owners", owner, options))) return { eligible: false, reason: "owner is not enrolled in bv2.owners" };
    return { eligible: true, reason: "kill switch clear, bv2.enabled on, owner enrolled" };
  } catch (error) {
    return { eligible: false, reason: `flag read failed (fails closed): ${error.message}` };
  }
}

const PHASES = Object.freeze({
  queued: ["Planner", "Queued for an isolated Builder V2 workerâ€¦"],
  preparing: ["Planner", "Preparing the verified buildâ€¦"],
  running: ["Builder", "Building in an isolated workerâ€¦"],
  complete: ["Publisher", "Verified preview ready."],
  failed: ["Builder", "The verified build stopped."],
});

async function buildCeiling(owner, mode, deps) {
  const context = await deps.resolveBuildContext(owner);
  if (usesManagedCredits(context.policy) && managedSettlementPaused()) {
    throw Object.assign(new Error("Managed Builder V2 dispatch is paused; no project or provider call was created."), {
      code: "settlement_paused",
    });
  }
  if (context.byok) {
    const platformCeiling = Number(process.env.THRALLO_BV2_DEFAULT_BUILD_CEILING || 60);
    const userCeiling = normalizeByokSafety(context.byokSafety, { provider: context.providerLabel }).maxCostPerBuild;
    return {
      ceiling: userCeiling == null ? platformCeiling : Math.min(platformCeiling, userCeiling),
      providerSelection: {
        provider: context.policy?.primaryProvider || context.providerLabel || "unknown",
        billingLane: context.policy?.billingLane || "byok_api",
        manualModel: context.routing?.routingMode === "manual" ? context.routing.preferredModel || null : null,
      },
    };
  }
  const balance = await deps.budgetLedger().getBalance(owner);
  return {
    ceiling: managedAffordableCreditLimit({ balance: balance.total, mode }),
    providerSelection: {
      provider: context.policy?.primaryProvider || "managed",
      billingLane: context.policy?.billingLane || "managed",
      manualModel: context.routing?.routingMode === "manual" ? context.routing.preferredModel || null : null,
    },
  };
}

function relay(ctx, job) {
  let lastAgent = null;
  const send = async (name, data) => {
    try {
      if (name === "phase") {
        const [agent, status] = PHASES[data.phase] || ["Builder", `Builder V2: ${data.phase}`];
        if (lastAgent && lastAgent !== agent) await ctx.emit("agent_done", { agent: lastAgent, ok: true });
        if (lastAgent !== agent) await ctx.emit("agent_spawned", { agent, status });
        lastAgent = agent;
        return;
      }
      if (name !== "end") return;
      if (lastAgent) await ctx.emit("agent_done", { agent: lastAgent, ok: data.status === "complete" });
      if (data.status === "complete" && data.result?.previewUrl) {
        await ctx.emit("preview_ready", {
          url: data.result.previewUrl, projectId: data.projectId,
          message: "Builder V2 verified the app. Preview ready.",
        });
      }
      const text = data.status === "complete"
        ? "Builder V2 finished the verified build."
        : (data.error || "Builder V2 stopped without producing an unverified preview.");
      await ctx.conversations.appendTurn(ctx.conversation, {
        role: "lead", content: text,
        payload: { projectId: data.projectId, jobId: data.jobId, pipelineVersion: "v2" },
      });
      await ctx.emit("message", { role: "lead", text, projectId: data.projectId });
    } catch (error) {
      console.error(`[bv2 relay ${job.id.slice(0, 8)}] ${error.message}`);
    }
  };
  subscribe(job, (name, data) => { void send(name, data); });
}

function productionDeps(overrides = {}) {
  return {
    client: serviceClient(), createJob,
    startDiagSessionSafe: (spec) => createDiagSession({ ...spec, strictWrites: true }),
    resolveBuildContext,
    budgetLedger: createBudgetLedger, workerEnabled: buildWorkerEnabled,
    ...overrides,
  };
}

async function dispatch(ctx, {
  project, mode, prompt, kind, trigger = "user", taskHint = null, deps: overrides = {}, preflight = null,
  v2Input = null,
}) {
  const deps = productionDeps(overrides);
  if (!deps.workerEnabled()) {
    throw Object.assign(new Error("Builder V2 requires the isolated build worker; no diagnostic or job was created."), {
      code: "worker_required",
    });
  }
  const checked = preflight || await buildCeiling(ctx.owner, mode, deps);
  const ceiling = checked.ceiling;
  if (!(ceiling > 0)) {
    throw Object.assign(new Error("Builder V2 was refused before dispatch because no build budget remains."), {
      code: "budget_exceeded",
    });
  }
  const diag = await deps.startDiagSessionSafe({
    owner: ctx.owner, projectId: project.id, conversationId: ctx.conversation.id,
    kind, prompt,
  });
  await diag.flush?.(); // the build_jobs FK must never race the asynchronous diagnostic insert
  let job;
  let existing = false;
  try {
    ({ job, existing } = await deps.createJob({
      owner: { id: ctx.owner }, projectId: project.id, mode, prompt,
      diag: diag.recorderForJob({ round: 1 }), trigger, taskHint,
      budgetAllowance: ceiling, pipelineVersion: "v2",
      providerSelection: checked.providerSelection,
      manualModel: checked.providerSelection?.manualModel || null,
      v2Input,
    }));
  } catch (error) {
    await diag.finish?.("failed");
    throw error;
  }
  if (existing && diag.id && diag.id !== job.diagSessionId) {
    await diag.finish?.("cancelled");
  }
  relay(ctx, job);
  await ctx.emit("build_started", {
    jobId: job.id, projectId: project.id, buildId: job.diagSessionId || diag.id, pipelineVersion: "v2",
    message: mode === "build" ? "Builder V2 is assembling the app." : "Builder V2 is applying a verified change.",
  });
  return { jobId: job.id, projectId: project.id, buildId: job.diagSessionId || diag.id, pipelineVersion: "v2" };
}

async function resumableBuild(client, owner, projectId) {
  const { data: builds, error: buildError } = await client.from("bv2_builds")
    .select("id,state,error,created_at").eq("owner", owner).eq("project_id", projectId)
    .in("state", ["blocked", "failed"]).order("created_at", { ascending: false }).limit(10);
  if (buildError) throw new Error(`Builder V2 resumable build lookup failed: ${buildError.message}`);
  const ids = (builds || []).map((row) => row.id);
  if (!ids.length) return null;
  const { data: snapshots, error: snapshotError } = await client.from("bv2_snapshots")
    .select("id,build_id,reason,created_at").eq("owner", owner).eq("project_id", projectId)
    .eq("state", "ready").in("build_id", ids).like("reason", "working:%")
    .order("created_at", { ascending: false });
  if (snapshotError) throw new Error(`Builder V2 checkpoint lookup failed: ${snapshotError.message}`);
  const available = new Set((snapshots || []).map((row) => row.build_id));
  const build = (builds || []).find((row) => available.has(row.id));
  return build ? { buildId: build.id, problems: build.error ? [String(build.error)] : [] } : null;
}

/** Accept a new application build. An exception remains a V2 failure; callers must not fallback. */
export async function startAppBuildV2(ctx, input, options = {}) {
  const deps = productionDeps(options.deps);
  if (!deps.workerEnabled()) {
    throw Object.assign(new Error("Builder V2 requires the isolated build worker; no project was created."), {
      code: "worker_required",
    });
  }
  const preflight = await buildCeiling(ctx.owner, "build", deps);
  const name = String(input.productName || "").trim() || null;
  let productId = ctx.conversation.product_id || null;
  if (name) {
    const product = await ctx.conversations.upsertProduct(ctx.owner, name.slice(0, 120));
    productId = product.id;
    if (!ctx.conversation.product_id) {
      await ctx.conversations.updateConversation(ctx.conversation, { product_id: product.id });
    }
  }
  const { data: project, error } = await deps.client.from("projects").insert({
    owner: ctx.owner, name: name || String(input.description).slice(0, 120), product_id: productId,
  }).select("*").single();
  if (error) throw new Error(`Builder V2 project creation failed: ${error.message}`);
  try {
    const result = await dispatch(ctx, {
      project, mode: "build", prompt: String(input.description), kind: "app_build_v2",
      deps: options.deps, preflight,
    });
    return { handled: true, result: { ...result, note: "Builder V2 dispatched to the isolated worker." } };
  } catch (error) {
    // This row was created solely for this dispatch. Delete it only when no durable build record
    // exists; an SSE/relay failure after enqueue must never delete the project beneath its worker.
    try {
      const { data: durable } = await deps.client.from("build_jobs").select("id")
        .eq("project_id", project.id).eq("owner", ctx.owner).limit(1);
      if (!durable?.length) {
        const cleanup = await deps.client.from("projects").delete().eq("id", project.id).eq("owner", ctx.owner);
        if (cleanup?.error) console.error(`[bv2 dispatch] empty project cleanup failed: ${cleanup.error.message}`);
      }
    } catch (cleanupError) {
      console.error(`[bv2 dispatch] preserved project because cleanup proof failed: ${cleanupError.message}`);
    }
    throw error;
  }
}

/** Edit/repair an existing project through V2. The compatibility snapshot is adopted in-worker. */
export async function startExistingAppWorkV2(ctx, {
  project, request, kind = "edit", trigger = "user", taskHint = null,
}, options = {}) {
  if (!project?.id) throw new Error("Builder V2 needs an owner-scoped project");
  const deps = productionDeps(options.deps);
  let mode = "iterate";
  let v2Input = null;
  if (kind === "repair" && !project.bv2_green_snapshot_id) {
    const resumable = await resumableBuild(deps.client, ctx.owner, project.id);
    if (!resumable) {
      throw Object.assign(new Error("This project has no green snapshot or resumable Builder V2 checkpoint."), {
        code: "no_resumable_checkpoint",
      });
    }
    mode = "resume_repair";
    v2Input = { sourceBuildId: resumable.buildId, problems: resumable.problems };
  }
  const result = await dispatch(ctx, {
    project, mode, prompt: String(request), kind: `${kind}_v2`, trigger, taskHint,
    deps: options.deps, v2Input,
  });
  return { handled: true, result: { ...result, note: `Builder V2 ${kind} dispatched to the isolated worker.` } };
}
