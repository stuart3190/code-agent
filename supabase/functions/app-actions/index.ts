// Authenticated actions for generated apps. External delivery is queued for the shell worker so
// provider credentials and webhook signing secrets never enter browser code or this function.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const svc = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const cors = (origin: string) => ({
  "Access-Control-Allow-Origin": origin || "null", "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin",
});
const json = (status: number, body: unknown, origin: string) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...cors(origin) },
});
const text = (value: unknown, max: number) => String(value || "").trim().slice(0, max);

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json(405, { error: "POST only" }, origin);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: authData, error: authError } = await svc.auth.getUser(token);
  if (authError || !authData.user) return json(401, { error: "Sign in first." }, origin);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "invalid JSON" }, origin); }
  const action = text(body.action, 40);
  const appId = text(body.appId, 64);
  if (!/^[0-9a-f-]{36}$/i.test(appId) || !["notify_self", "email_self", "emit"].includes(action)) {
    return json(400, { error: "Valid action and appId are required." }, origin);
  }
  const { data: appUser } = await svc.from("app_users").select("email,status")
    .eq("app_id", appId).eq("auth_user_id", authData.user.id).maybeSingle();
  if (!appUser || appUser.status !== "active") return json(403, { error: "This account cannot use app actions." }, origin);
  const { data: project } = await svc.from("projects").select("owner").eq("id", appId).maybeSingle();
  const { data: feature } = await svc.from("feature_flags").select("enabled").eq("key", "integrations").maybeSingle();
  if (!project || !feature?.enabled) return json(503, { error: "App integrations are not available yet." }, origin);
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const { count } = await svc.from("background_tasks").select("id", { count: "exact", head: true })
    .eq("project_id", appId).contains("input", { actor: authData.user.id }).gte("created_at", hourAgo);
  if ((count || 0) >= 60) return json(429, { error: "Too many app actions. Try again later." }, origin);
  if (action === "email_self") {
    const { count: emailCount } = await svc.from("background_tasks").select("id", { count: "exact", head: true })
      .eq("project_id", appId).eq("type", "app_email").contains("input", { actor: authData.user.id }).gte("created_at", hourAgo);
    if ((emailCount || 0) >= 10) return json(429, { error: "Too many emails. Try again later." }, origin);
  }

  if (action === "notify_self") {
    const title = text(body.title, 160);
    const message = text(body.body, 2000);
    if (!title) return json(400, { error: "title is required" }, origin);
    const data = body.data && typeof body.data === "object" ? body.data : {};
    if (JSON.stringify(data).length > 8000) return json(400, { error: "notification data is too large" }, origin);
    const { data: notification, error } = await svc.from("app_notifications").insert({
      app_id: appId, app_user_id: authData.user.id, title, body: message, data,
    }).select("id,title,body,data,read_at,created_at").single();
    if (error) return json(500, { error: "Notification could not be created." }, origin);
    return json(200, { notification }, origin);
  }

  let task;
  if (action === "email_self") {
    const subject = text(body.subject, 160);
    const message = text(body.text, 5000);
    if (!subject || !message) return json(400, { error: "subject and text are required" }, origin);
    task = { type: "app_email", input: { actor: authData.user.id, to: appUser.email, subject, text: message } };
  } else {
    const event = text(body.event, 80);
    const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
    if (!/^[a-z][a-z0-9_.-]{1,79}$/i.test(event)) return json(400, { error: "event name is invalid" }, origin);
    if (JSON.stringify(payload).length > 8000) return json(400, { error: "event payload is too large" }, origin);
    task = { type: "app_event", input: { actor: authData.user.id, actor_email: appUser.email, event, payload } };
  }
  const { data: queued, error } = await svc.from("background_tasks").insert({
    owner: project.owner, project_id: appId, type: task.type, input: task.input,
  }).select("id,status").single();
  if (error) return json(500, { error: "App action could not be queued." }, origin);
  return json(202, { task: queued }, origin);
});
