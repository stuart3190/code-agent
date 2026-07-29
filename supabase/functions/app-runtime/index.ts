// Authenticated capability gateway for generated apps. It validates and records work only;
// provider credentials and long-running execution stay in the trusted runtime worker.
import { createClient } from "npm:@supabase/supabase-js@2.49.8";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const svc = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const cors = (origin: string) => ({
  "Access-Control-Allow-Origin": origin || "null",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});
const json = (status: number, body: unknown, origin: string) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...cors(origin) },
});
const uuid = (value: unknown) => /^[0-9a-f-]{36}$/i.test(String(value || ""));
const text = (value: unknown, max = 200) => String(value || "").trim().slice(0, max);

function validate(schema: Record<string, unknown>, value: unknown) {
  if (!schema || schema.type !== "object") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "input must be an object";
  const input = value as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) if (!(String(key) in input)) return `${String(key)} is required`;
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties as Record<string, Record<string, unknown>> : {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(input)) if (!properties[key]) return `${key} is not allowed`;
  }
  for (const [key, rule] of Object.entries(properties)) {
    const current = input[key];
    if (current == null) continue;
    if (rule.type === "string" && typeof current !== "string") return `${key} must be text`;
    if (rule.type === "number" && typeof current !== "number") return `${key} must be a number`;
    if (rule.type === "integer" && !Number.isInteger(current)) return `${key} must be an integer`;
    if (rule.type === "boolean" && typeof current !== "boolean") return `${key} must be true or false`;
    if (rule.type === "array" && !Array.isArray(current)) return `${key} must be a list`;
    if (typeof current === "string" && Number(rule.maxLength) > 0 && current.length > Number(rule.maxLength)) return `${key} is too long`;
    if (Array.isArray(rule.enum) && !rule.enum.includes(current)) return `${key} has an invalid value`;
  }
  return null;
}

async function appUser(token: string, appId: string) {
  const { data, error } = await svc.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: mapping } = await svc.from("app_users").select("status,email")
    .eq("app_id", appId).eq("auth_user_id", data.user.id).maybeSingle();
  return mapping?.status === "active" ? { user: data.user, mapping } : null;
}

async function refund(job: Record<string, unknown>) {
  if (Number(job.runtime_credits_reserved || 0) > 0) await svc.rpc("settle_runtime_credits", { p_job: job.id, p_charge: 0, p_provider_cost_gbp: 0 });
  if (Number(job.app_units_reserved || 0) > 0) await svc.rpc("refund_app_units", { p_job: job.id });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json(405, { error: "POST only" }, origin);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "invalid JSON" }, origin); }
  const command = text(body.command || "invoke", 20);
  const appId = text(body.appId, 64);
  if (!uuid(appId)) return json(400, { error: "Valid appId is required." }, origin);
  const actor = await appUser(token, appId);
  if (!actor) return json(401, { error: "Sign in to this app first." }, origin);

  if (command === "get" || command === "cancel") {
    if (!uuid(body.jobId)) return json(400, { error: "Valid jobId is required." }, origin);
    const { data: job } = await svc.from("app_jobs").select("*").eq("id", body.jobId)
      .eq("project_id", appId).eq("app_user_id", actor.user.id).maybeSingle();
    if (!job) return json(404, { error: "Job not found." }, origin);
    if (command === "get") return json(200, { job }, origin);
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return json(200, { job }, origin);
    const now = new Date().toISOString();
    if (job.status === "queued") {
      await svc.from("app_jobs").update({ status: "cancelled", cancel_requested_at: now, finished_at: now, updated_at: now }).eq("id", job.id);
      await svc.from("background_tasks").update({ status: "cancelled", finished_at: now, updated_at: now })
        .eq("type", "runtime_job").contains("input", { job_id: job.id }).eq("status", "queued");
      await refund(job);
    } else {
      await svc.from("app_jobs").update({ cancel_requested_at: now, updated_at: now }).eq("id", job.id);
    }
    const { data: updated } = await svc.from("app_jobs").select("*").eq("id", job.id).single();
    return json(202, { job: updated }, origin);
  }

  if (command === "list") {
    const limit = Math.max(1, Math.min(100, Number(body.limit || 25)));
    let query = svc.from("app_jobs").select("*").eq("project_id", appId).eq("app_user_id", actor.user.id)
      .order("created_at", { ascending: false }).limit(limit);
    if (body.status) query = query.eq("status", text(body.status, 30));
    const { data, error } = await query;
    return error ? json(500, { error: "Jobs could not be loaded." }, origin) : json(200, { jobs: data || [] }, origin);
  }

  if (command === "usage") {
    const { data } = await svc.from("app_usage_ledger").select("delta,expires_at")
      .eq("project_id", appId).eq("app_user_id", actor.user.id);
    const now = Date.now();
    const balance = (data || []).reduce((sum, row) => !row.expires_at || Date.parse(row.expires_at) > now ? sum + Number(row.delta) : sum, 0);
    return json(200, { balance }, origin);
  }

  const actionKey = text(body.actionKey, 80);
  if (!/^[a-z][a-z0-9_.-]{1,79}$/i.test(actionKey)) return json(400, { error: "Valid actionKey is required." }, origin);
  const { data: action } = await svc.from("project_actions").select("*")
    .eq("project_id", appId).eq("environment", "live").eq("key", actionKey).eq("enabled", true).maybeSingle();
  if (!action) return json(404, { error: `Action '${actionKey}' is not configured.` }, origin);
  const input = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input : {};
  const inputBytes = new TextEncoder().encode(JSON.stringify(input)).length;
  if (inputBytes > 64_000) return json(413, { error: "Action input is too large; upload files to Storage and pass their paths." }, origin);
  const invalid = validate(action.input_schema || {}, input);
  if (invalid) return json(400, { error: invalid }, origin);
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const { count } = await svc.from("app_jobs").select("id", { count: "exact", head: true })
    .eq("project_id", appId).eq("app_user_id", actor.user.id).eq("action_id", action.id).gte("created_at", hourAgo);
  if ((count || 0) >= action.rate_limit_per_hour) return json(429, { error: "This action's hourly limit has been reached." }, origin);

  const idempotencyKey = text(body.idempotencyKey || crypto.randomUUID(), 120);
  if (!/^[a-zA-Z0-9_.:-]{1,120}$/.test(idempotencyKey)) return json(400, { error: "Invalid idempotency key." }, origin);
  const { data: project } = await svc.from("projects").select("owner").eq("id", appId).maybeSingle();
  if (!project) return json(404, { error: "App not found." }, origin);
  const { data: existing } = await svc.from("app_jobs").select("*").eq("project_id", appId)
    .eq("app_user_id", actor.user.id).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existing) return json(202, { job: existing, idempotent: true }, origin);

  const { data: job, error: jobError } = await svc.from("app_jobs").insert({
    project_id: appId, owner: project.owner, app_user_id: actor.user.id, action_id: action.id,
    action_key: action.key, input, idempotency_key: idempotencyKey,
  }).select("*").single();
  if (jobError || !job) return json(500, { error: "Job could not be created." }, origin);

  const units = Number(action.end_user_unit_cost || 0);
  if (Number(action.free_allowance || 0) > 0) {
    const { error } = await svc.from("app_usage_ledger").insert({ project_id: appId, app_user_id: actor.user.id,
      delta: Number(action.free_allowance), kind: "grant", ref: `free:${action.id}` });
    if (error && error.code !== "23505") console.error(`free allowance: ${error.message}`);
  }
  const unitReservation = await svc.rpc("reserve_app_units", { p_project: appId, p_user: actor.user.id, p_job: job.id, p_units: units });
  if (unitReservation.error || unitReservation.data?.ok === false) {
    await svc.from("app_jobs").update({ status: "failed", error_code: "insufficient_app_units", error: "Buy more app usage before running this action.", finished_at: new Date().toISOString() }).eq("id", job.id);
    return json(402, { error: "Buy more app usage before running this action.", code: "insufficient_app_units" }, origin);
  }

  const maximumCredits = action.execution_mode === "byok" ? 0 : Math.max(0, Number(action.config?.max_credits || 0));
  const creditReservation = await svc.rpc("reserve_runtime_credits", {
    p_owner: project.owner, p_job: job.id, p_amount: maximumCredits, p_provider: action.provider, p_mode: action.execution_mode,
  });
  if (creditReservation.error || creditReservation.data?.ok === false) {
    await svc.rpc("refund_app_units", { p_job: job.id });
    await svc.from("app_jobs").update({ status: "failed", error_code: "owner_runtime_credits", error: "This app is temporarily out of runtime credits.", finished_at: new Date().toISOString() }).eq("id", job.id);
    return json(402, { error: "This app is temporarily out of runtime credits.", code: "owner_runtime_credits" }, origin);
  }

  const { error: queueError } = await svc.from("background_tasks").insert({
    owner: project.owner, project_id: appId, type: "runtime_job", input: { job_id: job.id },
  });
  if (queueError) {
    await svc.rpc("settle_runtime_credits", { p_job: job.id, p_charge: 0, p_provider_cost_gbp: 0 });
    await svc.rpc("refund_app_units", { p_job: job.id });
    await svc.from("app_jobs").update({ status: "failed", error_code: "queue_failed", error: "Job could not be queued.", finished_at: new Date().toISOString() }).eq("id", job.id);
    return json(500, { error: "Job could not be queued." }, origin);
  }
  const { data: queued } = await svc.from("app_jobs").select("*").eq("id", job.id).single();
  return json(202, { job: queued }, origin);
});
