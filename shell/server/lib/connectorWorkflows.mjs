import { sendEmail } from "./email.mjs";
import { requireFeature } from "./features.mjs";
import { getProjectSecret } from "./projectSecrets.mjs";
import { auditEvent } from "./projectState.mjs";
import { ownedProject, serviceClient } from "./supabase.mjs";
import { sendSms, sendWebhook } from "./appIntegrations.mjs";

const ACTIONS = new Set(["app_email", "app_sms", "signed_webhook", "slack_webhook", "discord_webhook"]);
const EVENT_RE = /^(\*|[a-z0-9][a-z0-9._:-]{0,79})$/i;

function bad(message) { return Object.assign(new Error(message), { code: "bad_workflow" }); }

export function cleanWorkflowInput(input = {}) {
  const name = String(input.name || "").trim().slice(0, 80);
  const triggerEvent = String(input.triggerEvent || "").trim().toLowerCase();
  const actionProvider = String(input.actionProvider || "").trim();
  if (!name) throw bad("Give this workflow a name.");
  if (!EVENT_RE.test(triggerEvent)) throw bad("Use an event such as booking.created, lead.captured, or * for every event.");
  if (!ACTIONS.has(actionProvider)) throw bad("Choose a supported workflow action.");
  return { name, trigger_event: triggerEvent, action_provider: actionProvider, enabled: input.enabled !== false };
}

export async function listConnectorWorkflows(owner, projectId, client = serviceClient()) {
  await requireFeature(owner, "integrations");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const { data, error } = await client.from("connector_workflows").select("id,name,enabled,trigger_event,action_provider,config,last_run_at,last_error,created_at,updated_at")
    .eq("owner", owner.id).eq("project_id", projectId).order("created_at");
  if (error) throw new Error(`connector workflows: ${error.message}`);
  return data || [];
}

export async function saveConnectorWorkflow(owner, projectId, input, client = serviceClient()) {
  await requireFeature(owner, "integrations");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const clean = cleanWorkflowInput(input);
  const now = new Date().toISOString();
  let query;
  if (input.id) {
    query = client.from("connector_workflows").update({ ...clean, updated_at: now })
      .eq("id", input.id).eq("owner", owner.id).eq("project_id", projectId).select("*").maybeSingle();
  } else {
    query = client.from("connector_workflows").insert({ owner: owner.id, project_id: projectId, ...clean })
      .select("*").single();
  }
  const { data, error } = await query;
  if (error) throw new Error(`workflow save: ${error.message}`);
  if (!data) throw bad("Workflow not found.");
  await auditEvent({ owner: owner.id, projectId, action: input.id ? "workflow.updated" : "workflow.created", target: data.id,
    metadata: { trigger: clean.trigger_event, action: clean.action_provider } }, client).catch(() => {});
  return data;
}

export async function deleteConnectorWorkflow(owner, projectId, workflowId, client = serviceClient()) {
  await requireFeature(owner, "integrations");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const { data, error } = await client.from("connector_workflows").delete()
    .eq("id", workflowId).eq("owner", owner.id).eq("project_id", projectId).select("id").maybeSingle();
  if (error) throw new Error(`workflow delete: ${error.message}`);
  if (!data) throw bad("Workflow not found.");
  await auditEvent({ owner: owner.id, projectId, action: "workflow.deleted", target: workflowId }, client).catch(() => {});
  return { deleted: true };
}

async function appActionConfig(task, client) {
  const { data, error } = await client.from("project_integrations").select("config")
    .eq("owner", task.owner).eq("project_id", task.project_id).eq("environment", "live").eq("provider", "app_actions").maybeSingle();
  if (error) throw new Error(`workflow destinations: ${error.message}`);
  return data?.config || {};
}

async function sendChatWebhook(provider, task, envelope, client) {
  const secretName = provider === "slack_webhook" ? "CONNECTOR_SLACK_WEBHOOK_URL" : "CONNECTOR_DISCORD_WEBHOOK_URL";
  const url = await getProjectSecret(task.owner, task.project_id, "live", secretName, client);
  if (!url) throw new Error(`${provider === "slack_webhook" ? "Slack" : "Discord"} is not connected.`);
  const summary = `${envelope.event}\n${JSON.stringify(envelope.payload).slice(0, 1500)}`;
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
    body: JSON.stringify(provider === "slack_webhook" ? { text: summary } : { content: summary.slice(0, 1900) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${provider === "slack_webhook" ? "Slack" : "Discord"} returned ${response.status}.`);
  return "sent";
}

async function executeWorkflow(workflow, task, envelope, client) {
  const config = await appActionConfig(task, client);
  if (workflow.action_provider === "app_email") {
    if (!config.email) throw new Error("Configure an owner alert email first.");
    if (!(await sendEmail({ to: config.email, subject: `[${envelope.event}] ${workflow.name}`, text: JSON.stringify(envelope, null, 2) }))) {
      throw new Error("Email delivery failed.");
    }
    return "sent";
  }
  if (workflow.action_provider === "app_sms") {
    if (!config.phone) throw new Error("Configure an owner SMS number first.");
    if (!(await sendSms(config.phone, `${envelope.event}: ${JSON.stringify(envelope.payload).slice(0, 1200)}`))) throw new Error("SMS delivery failed.");
    return "sent";
  }
  if (workflow.action_provider === "signed_webhook") {
    if (!config.webhook_url) throw new Error("Configure a signed webhook first.");
    const secret = await getProjectSecret(task.owner, task.project_id, "live", "WEBHOOK_SIGNING_SECRET", client);
    return sendWebhook(config.webhook_url, secret, { ...envelope, workflowId: workflow.id, workflow: workflow.name });
  }
  return sendChatWebhook(workflow.action_provider, task, envelope, client);
}

export async function runConnectorWorkflows(task, envelope, client = serviceClient()) {
  const { data, error } = await client.from("connector_workflows").select("id,name,action_provider")
    .eq("owner", task.owner).eq("project_id", task.project_id).eq("enabled", true)
    .in("trigger_event", [String(envelope.event || "").toLowerCase(), "*"]);
  if (error) throw new Error(`workflow lookup: ${error.message}`);
  const results = [];
  for (const workflow of data || []) {
    try {
      const result = await executeWorkflow(workflow, task, envelope, client);
      await client.from("connector_workflows").update({ last_run_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("id", workflow.id);
      results.push({ id: workflow.id, status: result });
    } catch (error) {
      const message = String(error.message || error).slice(0, 500);
      await client.from("connector_workflows").update({ last_run_at: new Date().toISOString(), last_error: message, updated_at: new Date().toISOString() }).eq("id", workflow.id);
      results.push({ id: workflow.id, status: "failed", error: message });
    }
  }
  return results;
}

