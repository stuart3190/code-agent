import crypto from "node:crypto";
import { emailConfigured, sendEmail } from "./email.mjs";
import { optionalEnv } from "./env.mjs";
import { requireFeature } from "./features.mjs";
import { getProjectSecret, setProjectSecret, deleteProjectSecret } from "./projectSecrets.mjs";
import { auditEvent } from "./projectState.mjs";
import { safeBrowserUrl } from "./qaRunner.mjs";
import { ownedProject, serviceClient } from "./supabase.mjs";

const PROVIDER = "app_actions";
const SIGNING_SECRET = "WEBHOOK_SIGNING_SECRET";

export function cleanIntegrationConfig(input = {}) {
  const webhookUrl = String(input.webhookUrl || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const phone = String(input.phone || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error("Enter a valid notification email."), { code: "bad_integration" });
  if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) throw Object.assign(new Error("SMS number must use international format, for example +447700900000."), { code: "bad_integration" });
  return { webhook_url: webhookUrl || null, email: email || null, phone: phone || null };
}

export function smsConfigured() {
  return !!(optionalEnv("TWILIO_ACCOUNT_SID") && optionalEnv("TWILIO_AUTH_TOKEN") && optionalEnv("TWILIO_FROM_NUMBER"));
}

export async function sendSms(to, body) {
  const sid = optionalEnv("TWILIO_ACCOUNT_SID");
  const token = optionalEnv("TWILIO_AUTH_TOKEN");
  const from = optionalEnv("TWILIO_FROM_NUMBER");
  if (!sid || !token || !from || !to) return false;
  const payload = new URLSearchParams({ To: to, From: from, Body: String(body).slice(0, 1500) });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded" }, body: payload,
  }).catch(() => null);
  return !!response?.ok;
}

async function integration(owner, projectId, client) {
  const { data, error } = await client.from("project_integrations").select("id,status,config,updated_at")
    .eq("owner", owner).eq("project_id", projectId).eq("provider", PROVIDER).eq("environment", "live").maybeSingle();
  if (error) throw new Error(`app integration: ${error.message}`);
  return data;
}

export async function integrationOverview(owner, projectId, client = serviceClient()) {
  await requireFeature(owner, "integrations");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const row = await integration(owner.id, projectId, client);
  const hasSecret = !!(await getProjectSecret(owner.id, projectId, "live", SIGNING_SECRET, client));
  return { config: row?.config || { webhook_url: null, email: null, phone: null }, signingSecretConfigured: hasSecret,
    providers: { email: emailConfigured(), sms: smsConfigured() } };
}

export async function saveIntegration(owner, projectId, input, client = serviceClient()) {
  await requireFeature(owner, "integrations");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const config = cleanIntegrationConfig(input);
  if (config.webhook_url && !(await safeBrowserUrl(config.webhook_url, "https://invalid.local"))) {
    throw Object.assign(new Error("Webhook must be a public HTTPS URL."), { code: "bad_integration" });
  }
  let signingSecret = null;
  if (config.webhook_url && !(await getProjectSecret(owner.id, projectId, "live", SIGNING_SECRET, client))) {
    signingSecret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
    await setProjectSecret(owner.id, projectId, "live", SIGNING_SECRET, signingSecret, client);
  }
  if (!config.webhook_url) await deleteProjectSecret(owner.id, projectId, "live", SIGNING_SECRET, client);
  const connected = !!(config.webhook_url || config.email || config.phone);
  const { error } = await client.from("project_integrations").upsert({
    owner: owner.id, project_id: projectId, provider: PROVIDER, environment: "live",
    status: connected ? "connected" : "disconnected", config, last_error: null, updated_at: new Date().toISOString(),
  }, { onConflict: "project_id,environment,provider" });
  if (error) throw new Error(`app integration save: ${error.message}`);
  await auditEvent({ owner: owner.id, projectId, action: "integrations.updated", metadata: {
    webhook: !!config.webhook_url, email: !!config.email, sms: !!config.phone,
  } }, client).catch(() => {});
  return { config, signingSecret, providers: { email: emailConfigured(), sms: smsConfigured() } };
}

export async function sendWebhook(url, secret, envelope) {
  if (!url || !secret || !(await safeBrowserUrl(url, "https://invalid.local"))) return "skipped";
  const body = JSON.stringify(envelope);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  const response = await fetch(url, { method: "POST", redirect: "error", headers: {
    "Content-Type": "application/json", "User-Agent": "Buildr101-Webhooks/1.0",
    "X-Buildr-Timestamp": String(timestamp), "X-Buildr-Signature": `sha256=${signature}`,
  }, body, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!response?.ok) throw new Error(`webhook delivery failed (${response?.status || "network"})`);
  return "sent";
}

async function processTask(task, client) {
  if (task.type === "app_email") {
    const sent = await sendEmail({ to: task.input.to, subject: task.input.subject, text: task.input.text });
    if (!sent) throw new Error("email delivery is not configured or failed");
    return { email: "sent" };
  }
  const row = await integration(task.owner, task.project_id, client);
  const config = row?.config || {};
  const envelope = { id: task.id, appId: task.project_id, event: task.input.event, actor: task.input.actor,
    actorEmail: task.input.actor_email, payload: task.input.payload, createdAt: task.created_at };
  const result = {};
  if (config.webhook_url) result.webhook = await sendWebhook(config.webhook_url,
    await getProjectSecret(task.owner, task.project_id, "live", SIGNING_SECRET, client), envelope);
  if (config.email) {
    const sent = await sendEmail({ to: config.email, subject: `[${task.input.event}] App event`, text: JSON.stringify(envelope, null, 2) });
    if (!sent) throw new Error("event email delivery failed");
    result.email = "sent";
  }
  if (config.phone) {
    const sent = await sendSms(config.phone, `${task.input.event}: ${JSON.stringify(task.input.payload).slice(0, 1200)}`);
    if (!sent) throw new Error("event SMS delivery failed");
    result.sms = "sent";
  }
  const { runConnectorWorkflows } = await import("./connectorWorkflows.mjs");
  result.workflows = await runConnectorWorkflows(task, envelope, client);
  return result;
}

let timer = null;
let polling = false;
async function poll(client = serviceClient()) {
  if (polling) return;
  polling = true;
  try {
    const { data: tasks, error } = await client.from("background_tasks").select("id,owner,project_id,type,input,attempts,created_at")
      .eq("status", "queued").in("type", ["app_email", "app_event"]).lte("available_at", new Date().toISOString())
      .order("created_at").limit(10);
    if (error) throw new Error(`action tasks: ${error.message}`);
    for (const task of tasks || []) {
      const { data: claimed } = await client.from("background_tasks").update({ status: "running", started_at: new Date().toISOString(),
        attempts: task.attempts + 1, updated_at: new Date().toISOString() }).eq("id", task.id).eq("status", "queued").select("id").maybeSingle();
      if (!claimed) continue;
      try {
        const output = await processTask(task, client);
        await client.from("background_tasks").update({ status: "succeeded", output, error: null,
          finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", task.id);
      } catch (error) {
        const retry = task.attempts + 1 < 3;
        await client.from("background_tasks").update({ status: retry ? "queued" : "failed", error: String(error.message || error).slice(0, 500),
          available_at: new Date(Date.now() + 30_000 * (task.attempts + 1)).toISOString(),
          finished_at: retry ? null : new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", task.id);
      }
    }
  } finally { polling = false; }
}

export function startActionWorker() {
  if (timer) return;
  poll().catch((error) => console.error(`[actions] ${error.message}`));
  timer = setInterval(() => poll().catch((error) => console.error(`[actions] ${error.message}`)), 5_000);
  timer.unref?.();
}

export function stopActionWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
