import { CodeAgentInputError } from "../lib/codeAgentContracts.mjs";
import { codeAgentStore } from "../lib/codeAgentStore.mjs";
import { automationsStore, nextRunAt } from "../lib/automationsStore.mjs";
import { parseAutomationInput, publicAutomation } from "../lib/automationService.mjs";

export async function handleAutomations(req, res, { owner, method, body }) {
  const store = automationsStore();
  if (method === "GET") {
    const rows = await store.list(owner.id);
    return sendJson(res, 200, { automations: rows.map(publicAutomation) });
  }
  return wrap(async () => {
    const input = parseAutomationInput(body);
    const repository = await codeAgentStore().getRepository(owner.id, String(body?.repositoryId || ""));
    if (!repository) throw new CodeAgentInputError("Repository not found", 404, "repository_not_found");
    if (input.kind === "pr_review" && !repository.installation_id) {
      throw new CodeAgentInputError(
        "Pull-request review automation requires a GitHub App repository connection",
        409,
        "github_installation_required",
      );
    }
    const row = await store.create(owner.id, {
      ...input,
      repository_id: repository.id,
      next_run_at: input.kind === "scheduled_task" ? nextRunAt(input.interval_hours) : null,
    });
    return sendJson(res, 201, { automation: publicAutomation(row) });
  });
}

export async function handleAutomationUpdate(_req, res, { owner, automationId, body }) {
  return wrap(async () => {
    const store = automationsStore();
    const existing = await store.get(owner.id, automationId);
    if (!existing) throw new CodeAgentInputError("Automation not found", 404, "automation_not_found");
    const patch = parseAutomationInput({ ...body, kind: existing.kind }, { partial: true });
    delete patch.kind;
    if (patch.interval_hours && existing.kind === "scheduled_task") {
      patch.next_run_at = nextRunAt(patch.interval_hours);
    }
    if (patch.enabled === true && existing.kind === "scheduled_task" && !existing.next_run_at) {
      patch.next_run_at = nextRunAt(patch.interval_hours || existing.interval_hours);
    }
    const row = await store.update(owner.id, automationId, patch);
    return sendJson(res, 200, { automation: publicAutomation(row) });
  });
}

export async function handleAutomationDelete(_req, res, { owner, automationId }) {
  const removed = await automationsStore().remove(owner.id, automationId);
  if (!removed) throw new CodeAgentInputError("Automation not found", 404, "automation_not_found");
  return sendJson(res, 200, { removed: true });
}

async function wrap(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CodeAgentInputError) throw error;
    if (error.status || error.code) {
      throw new CodeAgentInputError(error.message, error.status || 400, error.code || "automation_failed");
    }
    throw error;
  }
}

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
