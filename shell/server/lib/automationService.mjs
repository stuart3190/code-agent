// Automations: webhook-triggered pull-request reviews and scheduled repository runs.
//
// Every automated run passes the same admission guards as a manual one (rate limits and
// budget); a rejected trigger is recorded on the automation row and skipped, never retried
// into a spiral. Runs carry automation_id provenance so the workspace can attribute them.

import { optionalEnv } from "./env.mjs";
import { automationsStore, nextRunAt } from "./automationsStore.mjs";
import { codeAgentStore } from "./codeAgentStore.mjs";
import { assertRunWithinBudget, assertWithinRateLimits } from "./usageBudgets.mjs";
import { activeAiProviderName } from "./aiCredentialStore.mjs";

let timer = null;
let sweeping = false;

export function parseAutomationInput(body = {}, { partial = false } = {}) {
  const patch = {};
  if (!partial || body.kind !== undefined) {
    const kind = String(body.kind || "").toLowerCase();
    if (!["pr_review", "scheduled_task"].includes(kind)) {
      throw inputError("kind must be pr_review or scheduled_task");
    }
    patch.kind = kind;
  }
  if (!partial || body.enabled !== undefined) {
    patch.enabled = body.enabled !== false;
  }
  if (body.intervalHours !== undefined || (!partial && patch.kind === "scheduled_task")) {
    const hours = Math.floor(Number(body.intervalHours ?? 24));
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
      throw inputError("intervalHours must be between 1 and 168");
    }
    patch.interval_hours = hours;
  }
  if (!partial || body.config !== undefined) {
    const config = body.config || {};
    patch.config = {
      prompt: String(config.prompt || "").slice(0, 10_000),
      includeDrafts: config.includeDrafts === true,
      autoPost: config.autoPost === true,
      mode: ["agent", "review"].includes(String(config.mode || "").toLowerCase())
        ? String(config.mode).toLowerCase()
        : undefined,
    };
    if (patch.config.mode === undefined) delete patch.config.mode;
  }
  return patch;
}

export function publicAutomation(row) {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    kind: row.kind,
    enabled: row.enabled,
    config: row.config || {},
    intervalHours: row.interval_hours,
    nextRunAt: row.next_run_at,
    lastRunId: row.last_run_id,
    lastTriggeredAt: row.last_triggered_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Fired by the GitHub webhook worker for pull_request opened / ready_for_review events.
export async function triggerPullRequestAutomations({ repository, pullNumber, title, draft }, {
  store = automationsStore(),
  runStore = codeAgentStore(),
} = {}) {
  const automations = await store.findForRepository(repository.id, "pr_review");
  const results = [];
  for (const automation of automations) {
    if (draft && !automation.config?.includeDrafts) {
      results.push({ automationId: automation.id, skipped: "draft" });
      continue;
    }
    const outcome = await createAutomationRun(automation, {
      repository,
      runStore,
      store,
      input: {
        prompt: automation.config?.prompt?.trim()
          || `Review pull request #${pullNumber}${title ? ` (${String(title).slice(0, 200)})` : ""}.`,
        mode: "review",
        model: "auto",
        pull_request: Number(pullNumber),
      },
    });
    results.push({ automationId: automation.id, ...outcome });
  }
  return results;
}

export async function sweepScheduledAutomations({
  store = automationsStore(),
  runStore = codeAgentStore(),
  now = new Date(),
} = {}) {
  const due = await store.claimDueScheduled(now.toISOString(), 10);
  const results = [];
  for (const automation of due) {
    const repository = await runStore.getRepository(automation.owner, automation.repository_id);
    if (!repository || repository.status !== "ready") {
      await store.recordTrigger(automation.id, {
        last_error: repository ? "Repository access is unavailable" : "Repository was removed",
      });
      results.push({ automationId: automation.id, skipped: "repository_unavailable" });
      continue;
    }
    const mode = automation.config?.mode === "review" ? "review" : "agent";
    const outcome = await createAutomationRun(automation, {
      repository,
      runStore,
      store,
      input: {
        prompt: automation.config?.prompt?.trim()
          || "Run scheduled repository maintenance: update dependencies with passing tests and fix any broken builds.",
        mode,
        model: "auto",
      },
    });
    results.push({ automationId: automation.id, ...outcome });
  }
  return results;
}

async function createAutomationRun(automation, { repository, runStore, store, input }) {
  try {
    const credentialProvider = await activeAiProviderName(automation.owner).catch(() => "managed");
    await assertWithinRateLimits(automation.owner, { store: runStore });
    await assertRunWithinBudget(automation.owner, { credentialProvider, store: runStore });
    const agent = await findOrCreateAgent(runStore, automation, repository, input.mode);
    const run = await runStore.createRun(automation.owner, agent, repository, {
      ...input,
      automation_id: automation.id,
    });
    await store.recordTrigger(automation.id, {
      last_run_id: run.id,
      last_triggered_at: new Date().toISOString(),
      last_error: null,
    });
    return { runId: run.id };
  } catch (error) {
    await store.recordTrigger(automation.id, {
      last_triggered_at: new Date().toISOString(),
      last_error: String(error.message || error).slice(0, 1_000),
    });
    return { skipped: error.code || "trigger_failed", error: error.message };
  }
}

async function findOrCreateAgent(runStore, automation, repository, mode) {
  const agents = await runStore.listAgents(automation.owner);
  const wanted = mode === "review" ? "review" : "agent";
  const existing = agents.find((agent) =>
    agent.repository_id === repository.id && agent.mode === wanted);
  if (existing) return existing;
  return runStore.createAgent(automation.owner, {
    repository_id: repository.id,
    name: wanted === "review" ? "Reviewer" : "Maintainer",
    mode: wanted,
  });
}

export function startAutomationSweeper() {
  if (timer) return;
  const interval = Math.max(Number(optionalEnv("CODE_AGENT_AUTOMATION_POLL_MS", "60000")), 5_000);
  timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweepScheduledAutomations()
      .catch((error) => console.error("[code-agent] automation sweep:", error))
      .finally(() => { sweeping = false; });
  }, interval);
  timer.unref?.();
}

export function stopAutomationSweeper() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { nextRunAt };

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = "invalid_automation";
  return error;
}
