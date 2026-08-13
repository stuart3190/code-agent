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
import { MANAGED_FINAL_JOB_GRACE_CREDITS, managedAffordableCreditLimit } from "../billingLimits.mjs";
import { createJob, subscribe } from "../buildJobs.mjs";
import { buildWorkerEnabled } from "../buildWorkQueue.mjs";
import { serviceClient } from "../supabase.mjs";
import { killSwitchActive } from "./featureFlags.mjs";
import { requireFreshWorkerAdmission } from "./workerAdmission.mjs";
import { classifyComplexity, profileFor } from "../appBuild/buildProfile.mjs";
import { buildBudgetApprovals } from "./buildBudgetApprovals.mjs";

export async function v2BuildEligible(_owner, options = {}) {
  if (killSwitchActive(options.env || process.env)) {
    return { eligible: false, reason: "THRALLO_BV2_KILL is set" };
  }
  return { eligible: true, reason: "Builder V2 is the exclusive application builder" };
}

function requireV2CutoverAvailable(env = process.env) {
  if (!killSwitchActive(env)) return;
  throw Object.assign(new Error(
    "Builder V2 is temporarily unavailable because its emergency kill switch is active.",
  ), { code: "builder_v2_killed" });
}

const PHASES = Object.freeze({
  queued: ["Planner", "Queued for an isolated Builder V2 workerâ€¦"],
  preparing: ["Planner", "Preparing the verified buildâ€¦"],
  running: ["Builder", "Building in an isolated workerâ€¦"],
  complete: ["Publisher", "Verified preview ready."],
  failed: ["Builder", "The verified build stopped."],
});

async function buildCeiling(owner, mode, deps, { maxCredits = null } = {}) {
  const context = await deps.resolveBuildContext(owner);
  if (usesManagedCredits(context.policy) && managedSettlementPaused()) {
    throw Object.assign(new Error("Managed Builder V2 dispatch is paused; no project or provider call was created."), {
      code: "settlement_paused",
    });
  }
  if (context.byok) {
    const platformCeiling = Number(maxCredits || process.env.THRALLO_BV2_DEFAULT_BUILD_CEILING || 60);
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
  const standard = managedAffordableCreditLimit({ balance: balance.total, mode });
  const approved = Number(maxCredits) > standard
    ? Math.min(Number(maxCredits), Math.max(0, Number(balance.total) || 0) + MANAGED_FINAL_JOB_GRACE_CREDITS)
    : standard;
  return {
    ceiling: maxCredits == null ? standard : Math.min(approved, Number(maxCredits)),
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
    // Dependency injection must be evaluated before the production default. Eagerly constructing
    // serviceClient() here made a supplied in-memory client useless and forced tests, tooling, and
    // offline diagnostics to possess production Supabase credentials they never read.
    client: Object.hasOwn(overrides, "client") ? overrides.client : serviceClient(), createJob,
    startDiagSessionSafe: (spec) => createDiagSession({ ...spec, strictWrites: true }),
    resolveBuildContext,
    budgetLedger: createBudgetLedger, workerEnabled: buildWorkerEnabled,
    requireWorkerAdmission: requireFreshWorkerAdmission,
    ...overrides,
  };
}

async function dispatch(ctx, {
  project, mode, prompt, kind, trigger = "user", taskHint = null, deps: overrides = {}, preflight = null,
  v2Input = null, budgetApprovalId = null,
}) {
  const deps = productionDeps(overrides);
  if (!deps.workerEnabled()) {
    throw Object.assign(new Error("Builder V2 requires the isolated build worker; no diagnostic or job was created."), {
      code: "worker_required",
    });
  }
  if (!preflight?.workerAdmission) {
    await deps.requireWorkerAdmission({ client: deps.client, jobType: "builder_pipeline" });
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
      v2Input, budgetApprovalId,
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
    .eq("state", "ready").in("build_id", ids)
    .order("created_at", { ascending: false });
  if (snapshotError) throw new Error(`Builder V2 checkpoint lookup failed: ${snapshotError.message}`);
  const available = new Set((snapshots || [])
    .filter((row) => /^(?:working|candidate):/.test(String(row.reason || "")))
    .map((row) => row.build_id));
  const build = (builds || []).find((row) => available.has(row.id));
  return build ? { buildId: build.id, problems: build.error ? [String(build.error)] : [] } : null;
}

/** Accept a new application build. An exception remains a V2 failure; callers must not fallback. */
export async function startAppBuildV2(ctx, input, options = {}) {
  requireV2CutoverAvailable(options.env || process.env);
  const workerEnabled = options.deps?.workerEnabled || buildWorkerEnabled;
  if (!workerEnabled()) {
    throw Object.assign(new Error("Builder V2 requires the isolated build worker; no project was created."), {
      code: "worker_required",
    });
  }
  const deps = productionDeps(options.deps);
  const workerAdmission = await deps.requireWorkerAdmission({ client: deps.client, jobType: "builder_pipeline" });
  const complexity = classifyComplexity({ prompt: String(input.description) });
  const profile = profileFor(complexity.level);
  const configuredAdvancedCeiling = Number(process.env.THRALLO_BV2_MAX_APPROVED_BUILD_CEILING || 0);
  const classCeiling = complexity.level === "advanced" && configuredAdvancedCeiling > profile.maxCredits
    ? configuredAdvancedCeiling : profile.maxCredits;
  const preflight = {
    ...(await buildCeiling(ctx.owner, "build", deps, { maxCredits: classCeiling })), workerAdmission,
  };
  let approvals = null;
  let consumedApproval = null;
  if (complexity.level === "advanced") {
    approvals = options.deps?.approvalStore || buildBudgetApprovals({ client: deps.client });
    if (!options.approvalId) {
      const approval = await approvals.create(ctx.owner, ctx.conversation.id, input, {
        ceilingCredits: preflight.ceiling,
      });
      await ctx.emit("budget_approval_required", approval);
      return {
        handled: true,
        result: {
          waitingForApproval: true,
          approval,
          note: "This larger build is ready and waiting for budget approval.",
        },
      };
    }
    consumedApproval = await approvals.consume(ctx.owner, options.approvalId, {
      conversationId: ctx.conversation.id, input,
    });
    preflight.ceiling = Math.min(preflight.ceiling, consumedApproval.ceilingCredits);
  }

  let project = null;
  try {
    const name = String(input.productName || "").trim() || null;
    let productId = ctx.conversation.product_id || null;
    if (name) {
      const product = await ctx.conversations.upsertProduct(ctx.owner, name.slice(0, 120));
      productId = product.id;
      if (!ctx.conversation.product_id) {
        await ctx.conversations.updateConversation(ctx.conversation, { product_id: product.id });
      }
    }
    const created = await deps.client.from("projects").insert({
      owner: ctx.owner, name: name || String(input.description).slice(0, 120), product_id: productId,
      budget_approval_id: consumedApproval?.approvalId || null, builder_version: "v2",
    }).select("*").single();
    if (created.error) throw new Error(`Builder V2 project creation failed: ${created.error.message}`);
    project = created.data;
    const result = await dispatch(ctx, {
      project, mode: "build", prompt: String(input.description), kind: "app_build_v2",
      deps: options.deps, preflight,
      budgetApprovalId: consumedApproval?.approvalId || null,
    });
    if (consumedApproval) {
      await approvals.attachDispatch(ctx.owner, consumedApproval.approvalId, {
        projectId: result.projectId, jobId: result.jobId,
      });
      await ctx.emit("budget_approval_resolved", { ...consumedApproval, status: "consumed" });
    }
    return { handled: true, result: { ...result, note: "Builder V2 dispatched to the isolated worker." } };
  } catch (error) {
    // This row was created solely for this dispatch. Delete it only when no durable build record
    // exists; an SSE/relay failure after enqueue must never delete the project beneath its worker.
    let provedNoDurableJob = project == null;
    try {
      if (project) {
        const { data: durable, error: durableError } = await deps.client.from("build_jobs").select("id")
          .eq("project_id", project.id).eq("owner", ctx.owner).limit(1);
        if (durableError) throw durableError;
        provedNoDurableJob = !durable?.length;
      }
      if (project && provedNoDurableJob) {
        const cleanup = await deps.client.from("projects").delete().eq("id", project.id).eq("owner", ctx.owner);
        if (cleanup?.error) {
          provedNoDurableJob = false;
          console.error(`[bv2 dispatch] empty project cleanup failed: ${cleanup.error.message}`);
        }
      }
    } catch (cleanupError) {
      console.error(`[bv2 dispatch] preserved project because cleanup proof failed: ${cleanupError.message}`);
    }
    if (consumedApproval && provedNoDurableJob) {
      try {
        await approvals.reopen(ctx.owner, consumedApproval.approvalId);
      } catch (reopenError) {
        throw new AggregateError([error, reopenError], "Builder dispatch failed and its budget approval could not be reopened.");
      }
    }
    throw error;
  }
}

/** Edit/repair an existing project through V2. The compatibility snapshot is adopted in-worker. */
export async function startExistingAppWorkV2(ctx, {
  project, request, kind = "edit", trigger = "user", taskHint = null,
}, options = {}) {
  requireV2CutoverAvailable(options.env || process.env);
  if (!project?.id) throw new Error("Builder V2 needs an owner-scoped project");
  const workerEnabled = options.deps?.workerEnabled || buildWorkerEnabled;
  if (!workerEnabled()) {
    throw Object.assign(new Error("Builder V2 requires the isolated build worker; no diagnostic or job was created."), {
      code: "worker_required",
    });
  }
  const deps = productionDeps(options.deps);
  const workerAdmission = await deps.requireWorkerAdmission({ client: deps.client, jobType: "builder_pipeline" });
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
    preflight: { ...(await buildCeiling(ctx.owner, mode, deps)), workerAdmission },
  });
  return { handled: true, result: { ...result, note: `Builder V2 ${kind} dispatched to the isolated worker.` } };
}
