import crypto from "node:crypto";
import { optionalEnv } from "../lib/env.mjs";
import { getProjectSecret } from "../lib/projectSecrets.mjs";
import { serviceClient } from "../lib/supabase.mjs";

const secrets = new Map();
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

function equal(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

async function signingSecret(action, client) {
  const token = action.execution_mode === "managed"
    ? optionalEnv("RUNTIME_REPLICATE_API_TOKEN")
    : await getProjectSecret(action.owner, action.project_id, action.environment, "RUNTIME_REPLICATE_API_TOKEN", client);
  if (!token) return null;
  const key = crypto.createHash("sha256").update(token).digest("hex");
  const cached = secrets.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const response = await fetch("https://api.replicate.com/v1/webhooks/default/secret", {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const data = await response?.json().catch(() => null);
  if (!response?.ok || !data?.key) return null;
  secrets.set(key, { value: data.key, expires: Date.now() + 60 * 60_000 });
  return data.key;
}

export async function handleRuntimeWebhook(req, res, rawBody, url) {
  const jobId = url.searchParams.get("job");
  if (!/^[0-9a-f-]{36}$/i.test(jobId || "")) return json(res, 400, { error: "invalid job" });
  const client = serviceClient();
  const { data: job } = await client.from("app_jobs").select("id,status,provider_job_id,project_actions(*)").eq("id", jobId).maybeSingle();
  if (!job?.project_actions || ["succeeded", "failed", "cancelled"].includes(job.status)) return json(res, 200, { received: true });
  const id = String(req.headers["webhook-id"] || "");
  const timestamp = String(req.headers["webhook-timestamp"] || "");
  const signatures = String(req.headers["webhook-signature"] || "").split(/\s+/).filter(Boolean);
  if (!id || !timestamp || !signatures.length || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return json(res, 401, { error: "invalid webhook metadata" });
  }
  const secret = await signingSecret(job.project_actions, client);
  if (!secret?.startsWith("whsec_")) return json(res, 503, { error: "webhook verification unavailable" });
  const expected = crypto.createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${timestamp}.${rawBody.toString("utf8")}`).digest("base64");
  if (!signatures.some((signature) => signature.startsWith("v1,") && equal(signature.slice(3), expected))) {
    return json(res, 401, { error: "invalid webhook signature" });
  }
  let payload;
  try { payload = JSON.parse(rawBody.toString("utf8")); } catch { return json(res, 400, { error: "invalid JSON" }); }
  if (payload.id !== job.provider_job_id) return json(res, 409, { error: "prediction mismatch" });
  const hash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const { error } = await client.from("provider_webhook_events").insert({ provider: "replicate", external_id: id,
    job_id: job.id, payload_hash: hash, processed_at: new Date().toISOString() });
  if (error?.code === "23505") return json(res, 200, { received: true, duplicate: true });
  if (error) return json(res, 500, { error: "webhook could not be recorded" });
  await client.from("app_jobs").update({ progress: ["succeeded", "failed", "canceled"].includes(payload.status) ? 85 : 55,
    updated_at: new Date().toISOString() }).eq("id", job.id).eq("status", "waiting_provider");
  return json(res, 200, { received: true });
}
