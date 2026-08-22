import crypto from "node:crypto";

import { serviceClient } from "../supabase.mjs";

export const BUILD_ENVELOPE_VERSION = 1;
export const FUNDING_POOL = Object.freeze({
  CUSTOMER: "customer_generation",
  RECOVERY: "thrallo_recovery",
});

const r4 = (value) => Math.round(Number(value || 0) * 10_000) / 10_000;
const unique = (values) => [...new Set((values || []).filter(Boolean))];
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
};
const stable = (value) => JSON.stringify(canonical(value));

export function contractHash(contract) {
  return crypto.createHash("sha256").update(stable(contract || {})).digest("hex");
}

export function complexityBand(value) {
  return ({ simple: "basic_static", medium: "stateful_crud", advanced: "complex_interactive" })[value]
    || (value === "basic_static" || value === "stateful_crud" || value === "complex_interactive"
      ? value : "basic_static");
}

export function contractRuntimeRequirements(contract = {}) {
  const capabilityText = stable({
    capabilities: contract.capabilities || [],
    graph: contract.capabilityGraph || {},
    interactions: contract.interactionContract || {},
  }).toLowerCase();
  const journeyText = (contract.journeys || []).flatMap((journey) => [journey.title, journey.description,
    ...(journey.steps || []).flatMap((step) => [step.action, step.target, step.expect]),
  ]).filter(Boolean).join(" ").toLowerCase();
  const actionText = (contract.journeys || []).flatMap((journey) => (journey.steps || [])
    .map((step) => step.action)).filter(Boolean).join(" ").toLowerCase();
  const withoutNegatedCapabilities = (value) => String(value).replace(
    /\b(?:no|without|not requiring|does not require|do not require|never uses?)\s+(?:an?\s+)?(?:auth(?:entication)?|accounts?|sign.?up|sign.?in|log.?in|admin|checkout|payments?|persistence|database)\b/gi,
    "",
  );
  const accountEvidence = withoutNegatedCapabilities(`${capabilityText} ${journeyText}`);
  const accounts = contract.auth?.required === true
    || (contract.auth?.required !== false
      && /\b(auth|account|sign.?up|sign.?in|log.?in|session|password|profile)\b/.test(accountEvidence));
  const durableMutation = (contract.entities || []).length > 0
    || /\b(create|insert|update|delete|cancel|book|reserve|submit|save|persist|mutation)\b/
      .test(withoutNegatedCapabilities(`${capabilityText} ${actionText}`));
  return { accounts, durableMutation };
}

function moduleRows(spec = {}, contract = {}) {
  const planned = spec.modulePlan || contract.modulePlan || [];
  if (planned.length) return planned.map((row, index) => ({
    id: row.id || row.path || `module-${index + 1}`,
    path: row.path || null,
    required: row.required !== false,
    journeyIds: unique(row.journeyIds || row.journeys || []),
  }));
  return unique((contract.journeys || []).flatMap((journey) => journey.owners || []))
    .map((path, index) => ({ id: path || `module-${index + 1}`, path, required: true, journeyIds: [] }));
}

function stage({ id, fundingSource, input = 0, output = 0, credits = 0, duration = 0,
  dependencyIds = [], required = true }) {
  return {
    id, required, fundingSource,
    estimatedInputTokens: Math.ceil(input), estimatedOutputTokens: Math.ceil(output),
    estimatedCredits: r4(credits), estimatedDurationMs: Math.ceil(duration),
    dependencyIds: unique(dependencyIds),
  };
}

/**
 * Derive the immutable funding and execution contract from the validated implementation contract.
 * The arithmetic deliberately scales with journeys, modules, owners and steps. It has no global
 * repair-count or class-duration cap; the only hard time boundary is three times this build's own
 * expected duration.
 */
export function deriveBuildEnvelope({
  contract, spec = {}, profile = "simple", approvedCustomerCredits,
  generationProviderPolicy = null, recoveryProviderPolicy = null,
  recoveryFloorCredits = 0,
  measuredP95Ms = null, measuredSampleCount = 0, startedAt = new Date().toISOString(),
} = {}) {
  if (!contract || typeof contract !== "object") throw new Error("a validated contract is required for a build envelope");
  const approved = Number(approvedCustomerCredits);
  if (!(approved > 0)) throw new Error("a positive customer generation approval is required");

  const journeys = contract.journeys || [];
  const modules = moduleRows(spec, contract);
  const owners = unique(journeys.flatMap((journey) => journey.owners || []));
  const stepCount = journeys.reduce((sum, journey) => sum + (journey.steps || []).length, 0);
  const requirements = contractRuntimeRequirements(contract);
  const band = complexityBand(profile);
  const stages = [];

  stages.push(stage({
    id: "contract", fundingSource: FUNDING_POOL.CUSTOMER,
    input: 4_500 + (journeys.length * 350), output: 3_000 + (journeys.length * 300),
    credits: 0.75 + (journeys.length * 0.08), duration: 75_000 + (journeys.length * 5_000),
  }));
  stages.push(stage({
    id: "capability_preflight", fundingSource: "platform", credits: 0,
    duration: requirements.accounts || requirements.durableMutation ? 45_000 : 5_000,
    dependencyIds: ["contract"],
  }));

  const coreModules = Math.max(1, modules.filter((row) => row.required).length || modules.length);
  stages.push(stage({
    id: "core_generation", fundingSource: FUNDING_POOL.CUSTOMER,
    input: 8_000 + (coreModules * 1_200) + (stepCount * 180),
    output: 4_000 + (coreModules * 1_400),
    credits: 1.4 + (coreModules * 0.42) + (stepCount * 0.035),
    duration: 90_000 + (coreModules * 28_000), dependencyIds: ["capability_preflight"],
  }));

  journeys.forEach((journey, index) => {
    const journeyOwners = unique(journey.owners || []);
    const journeySteps = (journey.steps || []).length;
    stages.push(stage({
      id: `journey_generation:${journey.id || index + 1}`,
      fundingSource: FUNDING_POOL.CUSTOMER,
      input: 2_500 + (journeyOwners.length * 900) + (journeySteps * 220),
      output: 1_500 + (journeyOwners.length * 750) + (journeySteps * 180),
      credits: 0.35 + (journeyOwners.length * 0.22) + (journeySteps * 0.06),
      duration: 35_000 + (journeyOwners.length * 18_000) + (journeySteps * 8_000),
      dependencyIds: ["core_generation"],
    }));
  });

  stages.push(stage({
    id: "compile", fundingSource: "platform", credits: 0,
    duration: 45_000 + (modules.length * 4_000),
    dependencyIds: journeys.length
      ? journeys.map((journey, index) => `journey_generation:${journey.id || index + 1}`)
      : ["core_generation"],
  }));
  stages.push(stage({
    id: "fresh_browser_verification", fundingSource: "platform", credits: 0,
    duration: Math.max(45_000, journeys.length * 95_000), dependencyIds: ["compile"],
  }));
  stages.push(stage({
    id: "promotion_projection", fundingSource: "platform", credits: 0,
    duration: 30_000, dependencyIds: ["fresh_browser_verification"],
  }));

  const strategyCostPlan = [
    {
      id: "contract_protocol_correction",
      estimatedCredits: r4(0.75 + (journeys.length * 0.08)),
      basis: { journeys: journeys.length },
    },
    {
      id: "deterministic_patch_correction",
      estimatedCredits: r4(Math.max(0.75, modules.length * 0.22)),
      basis: { modules: modules.length },
    },
    {
      id: "exact_owning_file_repair",
      estimatedCredits: r4(journeys.reduce((sum, journey) => (
        sum + 0.65 + (unique(journey.owners || []).length * 0.28) + ((journey.steps || []).length * 0.07)
      ), 0)),
      basis: { journeys: journeys.length, steps: stepCount },
    },
    {
      id: "causal_dependency_repair",
      estimatedCredits: r4(Math.max(0.8, owners.length * 0.48)),
      basis: { owningModules: owners.length },
    },
    {
      id: "owner_module_regeneration",
      estimatedCredits: r4(Math.max(1, owners.length * 0.9)),
      basis: { uniqueOwnerModules: owners.length },
    },
  ];
  const recoveryCredits = r4(Math.max(Number(recoveryFloorCredits || 0),
    strategyCostPlan.reduce((sum, row) => sum + row.estimatedCredits, 0)));
  const customerPlanned = r4(stages.filter((row) => row.fundingSource === FUNDING_POOL.CUSTOMER)
    .reduce((sum, row) => sum + row.estimatedCredits, 0));
  const expectedDurationMs = Math.ceil(stages.reduce((sum, row) => sum + row.estimatedDurationMs, 0)
    + (strategyCostPlan.length * 55_000));
  const enoughTimingEvidence = Number(measuredSampleCount) >= 20 && Number(measuredP95Ms) > 0;

  return canonical({
    version: BUILD_ENVELOPE_VERSION,
    contractHash: contractHash(contract),
    complexityBand: band,
    generationProviderPolicy,
    recoveryProviderPolicy: recoveryProviderPolicy || {
      billingLane: "managed", usageResponsibility: "thrallo_repair", managedFallback: false,
    },
    customerGeneration: {
      approvedCredits: r4(approved), plannedCredits: customerPlanned,
      consumedCredits: 0, heldCredits: 0,
      remainingRequiredCredits: r4(Math.max(0, customerPlanned)),
    },
    thralloRecovery: {
      approvedCredits: recoveryCredits, consumedCredits: 0, heldCredits: 0,
      strategyCostPlan,
      strategyCapacity: Math.max(3, (journeys.length * 3) + owners.length + 2),
      exceptionalApproval: null,
    },
    execution: {
      expectedDurationMs,
      softTargetDurationMs: enoughTimingEvidence ? Math.ceil(Number(measuredP95Ms) * 1.2) : null,
      hardSafetyDurationMs: expectedDurationMs * 3,
      expectedCalls: stages.filter((row) => row.fundingSource === FUNDING_POOL.CUSTOMER).length
        + strategyCostPlan.length,
      expectedBrowserPasses: Math.max(1, journeys.length),
      startedAt,
      lastDurableProgressAt: startedAt,
    },
    runtimeRequirements: requirements,
    approvalRequired: customerPlanned > approved + 1e-9,
    stages,
  });
}

export function envelopePoolCeiling(envelope, pool) {
  if (pool === FUNDING_POOL.RECOVERY) return Number(envelope?.thralloRecovery?.approvedCredits || 0)
    + Number(envelope?.thralloRecovery?.exceptionalApproval?.additionalAllowance || 0);
  return Number(envelope?.customerGeneration?.approvedCredits || 0);
}

export function assertEnvelopeCanFund(envelope, stageId, poolBudget = null) {
  const target = (envelope?.stages || []).find((row) => row.id === stageId && row.required !== false);
  if (!target) return { ok: true, requiredCredits: 0 };
  if (![FUNDING_POOL.CUSTOMER, FUNDING_POOL.RECOVERY].includes(target.fundingSource)) {
    return { ok: true, requiredCredits: 0 };
  }
  const remaining = Number(poolBudget?.remainingCredits
    ?? envelopePoolCeiling(envelope, target.fundingSource));
  if (remaining + 1e-9 < Number(target.estimatedCredits || 0)) {
    throw Object.assign(new Error(`required stage ${stageId} is not funded by its ${target.fundingSource} pool`), {
      code: target.fundingSource === FUNDING_POOL.RECOVERY
        ? "recovery_envelope_exhausted" : "customer_envelope_exhausted",
      retryable: false, dispatchState: "before_dispatch", fundingPool: target.fundingSource,
      remainingCredits: remaining, requiredCredits: Number(target.estimatedCredits || 0),
    });
  }
  return { ok: true, requiredCredits: Number(target.estimatedCredits || 0) };
}

export function memoryBuildEnvelopes() {
  const rows = new Map();
  const progress = new Map();
  const approvals = new Map();
  const durationExtensions = new Map();
  return {
    async create({ owner, projectId, buildId, envelope }) {
      const key = `${owner}:${buildId}`;
      const existing = rows.get(key);
      if (existing && stable(existing.envelope) !== stable(envelope)) {
        throw Object.assign(new Error("build envelope is immutable for this contract version"), {
          code: "build_envelope_identity_conflict",
        });
      }
      const row = existing || { id: `envelope-${rows.size + 1}`, owner, projectId, buildId, envelope };
      rows.set(key, row);
      return { ...row };
    },
    async get(owner, buildId) {
      const row = rows.get(`${owner}:${buildId}`) || null;
      const storedApproval = approvals.get(`${owner}:${buildId}`) || null;
      const storedDuration = durationExtensions.get(`${owner}:${buildId}`) || null;
      const approval = storedApproval && Date.parse(storedApproval.expiresAt) > Date.now()
        ? storedApproval : null;
      const duration = storedDuration && Date.parse(storedDuration.expiresAt) > Date.now()
        ? storedDuration : null;
      return row ? { ...row, envelope: { ...row.envelope,
        thralloRecovery: { ...row.envelope.thralloRecovery, exceptionalApproval: approval },
        execution: { ...row.envelope.execution,
          expectedDurationMs: duration?.revisedExpectedDurationMs || row.envelope.execution.expectedDurationMs,
          hardSafetyDurationMs: duration ? duration.revisedExpectedDurationMs * 3
            : row.envelope.execution.hardSafetyDurationMs,
          internalExtension: duration,
        } } } : null;
    },
    async approveRecovery({ owner, buildId, actor, reason, additionalAllowance, expiresAt }) {
      const row = rows.get(`${owner}:${buildId}`);
      if (!row || !actor || !reason || !(Number(additionalAllowance) > 0) || !expiresAt) {
        throw new Error("a durable build, actor, reason, positive allowance and expiry are required");
      }
      const approval = { actor, reason,
        previousCeiling: envelopePoolCeiling(row.envelope, FUNDING_POOL.RECOVERY),
        additionalAllowance: Number(additionalAllowance), expiresAt };
      approvals.set(`${owner}:${buildId}`, approval);
      return approval;
    },
    async approveDurationExtension({ owner, buildId, actor, reason, revisedExpectedDurationMs, expiresAt }) {
      const row = rows.get(`${owner}:${buildId}`);
      if (!row || !actor || !reason
          || !(Number(revisedExpectedDurationMs) > Number(row?.envelope?.execution?.expectedDurationMs || 0))
          || !expiresAt) {
        throw new Error("a durable build, actor, reason, revised duration and expiry are required");
      }
      const extension = { actor, reason,
        previousExpectedDurationMs: Number(row.envelope.execution.expectedDurationMs),
        revisedExpectedDurationMs: Number(revisedExpectedDurationMs), expiresAt };
      durationExtensions.set(`${owner}:${buildId}`, extension);
      return extension;
    },
    async markProgress(owner, buildId, kind, details = {}, at = new Date().toISOString()) {
      const key = `${owner}:${buildId}`;
      const row = rows.get(key);
      if (!row) throw new Error("build envelope not found");
      const event = { kind, details, at };
      const list = progress.get(key) || [];
      list.push(event); progress.set(key, list);
      row.lastDurableProgressAt = at;
      return event;
    },
    progress: (owner, buildId) => [...(progress.get(`${owner}:${buildId}`) || [])],
    rows: () => [...rows.values()].map((row) => ({ ...row })),
  };
}

export function supabaseBuildEnvelopes(client = serviceClient()) {
  const unwrap = ({ data, error }, action) => {
    if (error) throw Object.assign(new Error(`${action}: ${error.message}`), { code: error.code });
    return data;
  };
  return {
    async create({ owner, projectId, buildId, envelope }) {
      const payload = {
        owner, project_id: projectId, build_id: buildId, version: envelope.version,
        contract_hash: envelope.contractHash, complexity_band: envelope.complexityBand,
        envelope,
      };
      const created = await client.from("bv2_build_envelopes").insert(payload).select("*").single();
      if (!created.error) return created.data;
      if (created.error.code !== "23505") return unwrap(created, "create Builder V2 envelope");
      const existing = unwrap(await client.from("bv2_build_envelopes").select("*")
        .eq("owner", owner).eq("build_id", buildId).eq("version", envelope.version).maybeSingle(),
      "read concurrent Builder V2 envelope");
      if (!existing || existing.contract_hash !== envelope.contractHash
          || stable(existing.envelope) !== stable(envelope)) {
        throw Object.assign(new Error("build envelope is immutable for this contract version"), {
          code: "build_envelope_identity_conflict",
        });
      }
      return existing;
    },
    async get(owner, buildId) {
      const row = unwrap(await client.from("bv2_build_envelopes").select("*")
        .eq("owner", owner).eq("build_id", buildId).order("version", { ascending: false })
        .limit(1).maybeSingle(), "read Builder V2 envelope");
      if (!row) return null;
      const approval = unwrap(await client.from("bv2_recovery_approvals").select("*")
        .eq("owner", owner).eq("build_id", buildId).gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      "read Builder V2 recovery approval");
      const duration = unwrap(await client.from("bv2_duration_extensions").select("*")
        .eq("owner", owner).eq("build_id", buildId).gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
      "read Builder V2 duration extension");
      return { ...row, envelope: { ...row.envelope,
        thralloRecovery: { ...row.envelope.thralloRecovery,
          exceptionalApproval: approval ? {
            actor: approval.actor, reason: approval.reason,
            previousCeiling: Number(approval.previous_ceiling),
            additionalAllowance: Number(approval.additional_allowance), expiresAt: approval.expires_at,
          } : null },
        execution: { ...row.envelope.execution,
          expectedDurationMs: duration ? Number(duration.revised_expected_duration_ms)
            : row.envelope.execution.expectedDurationMs,
          hardSafetyDurationMs: duration ? Number(duration.revised_expected_duration_ms) * 3
            : row.envelope.execution.hardSafetyDurationMs,
          internalExtension: duration ? {
            actor: duration.actor, reason: duration.reason,
            previousExpectedDurationMs: Number(duration.previous_expected_duration_ms),
            revisedExpectedDurationMs: Number(duration.revised_expected_duration_ms),
            expiresAt: duration.expires_at,
          } : null,
        } } };
    },
    async approveRecovery({ owner, buildId, actor, reason, additionalAllowance, expiresAt }) {
      const current = await this.get(owner, buildId);
      if (!current || !actor || !reason || !(Number(additionalAllowance) > 0) || !expiresAt) {
        throw new Error("a durable build, actor, reason, positive allowance and expiry are required");
      }
      return unwrap(await client.from("bv2_recovery_approvals").insert({
        owner, build_id: buildId, actor, reason,
        previous_ceiling: envelopePoolCeiling(current.envelope, FUNDING_POOL.RECOVERY),
        additional_allowance: Number(additionalAllowance), expires_at: expiresAt,
      }).select("*").single(), "approve Builder V2 exceptional recovery");
    },
    async approveDurationExtension({ owner, buildId, actor, reason, revisedExpectedDurationMs, expiresAt }) {
      const current = await this.get(owner, buildId);
      if (!current || !actor || !reason
          || !(Number(revisedExpectedDurationMs) > Number(current?.envelope?.execution?.expectedDurationMs || 0))
          || !expiresAt) {
        throw new Error("a durable build, actor, reason, revised duration and expiry are required");
      }
      return unwrap(await client.from("bv2_duration_extensions").insert({
        owner, build_id: buildId, actor, reason,
        previous_expected_duration_ms: Number(current.envelope.execution.expectedDurationMs),
        revised_expected_duration_ms: Number(revisedExpectedDurationMs), expires_at: expiresAt,
      }).select("*").single(), "approve Builder V2 duration extension");
    },
    async markProgress(owner, buildId, kind, details = {}, at = new Date().toISOString()) {
      return unwrap(await client.from("bv2_build_progress").insert({
        owner, build_id: buildId, kind, details, progressed_at: at,
      }).select("*").single(), "record Builder V2 durable progress");
    },
  };
}

export function createEnvelopeProgressGuard({ envelopeStore, now = () => Date.now() } = {}) {
  if (!envelopeStore) throw new Error("envelope progress guard needs an envelope store");
  return {
    mark: (owner, buildId, kind, details = {}) => envelopeStore.markProgress(owner, buildId, kind, details,
      new Date(now()).toISOString()),
    async beforeDispatch(owner, buildId) {
      const row = await envelopeStore.get(owner, buildId);
      const envelope = row?.envelope || row;
      if (!envelope?.execution?.hardSafetyDurationMs) return { ok: true, guarded: false };
      const started = new Date(envelope.execution.startedAt).getTime();
      if (now() - started < Number(envelope.execution.hardSafetyDurationMs)) {
        return { ok: true, guarded: false };
      }
      throw Object.assign(new Error(
        "Builder V2 reached its contract-derived safety boundary and was checkpointed for an internal extension.",
      ), {
        code: "internal_extension_required", classification: "platform", action: "pause_new_dispatches",
        retryable: false, providerCallMade: false, reservationState: "not_created",
        customerActionRequired: false, customerMessageKey: "build_checking_internal_extension",
        dispatchState: "before_dispatch", checkpointId: null,
      });
    },
  };
}
