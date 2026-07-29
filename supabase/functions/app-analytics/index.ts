// Privacy-light first-party analytics for published generated apps. No cookies, IP addresses,
// user agents or arbitrary request headers are stored.
import { createClient } from "npm:@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const svc = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const cors = (origin: string) => ({ "Access-Control-Allow-Origin": origin || "null",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" });
const json = (status: number, body: unknown, origin: string) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json", ...cors(origin) },
});

async function allowedOrigin(appId: string, origin: string) {
  try {
    if (!origin.startsWith("https://")) return false;
    const host = new URL(origin).hostname.toLowerCase();
    const { data: site } = await svc.from("published_sites").select("slug").eq("project_id", appId).maybeSingle();
    if (site && host === `${site.slug}.app.buildr101.com`) return true;
    const { data: domain } = await svc.from("custom_domains").select("domain").eq("project_id", appId)
      .eq("domain", host).not("verified_at", "is", null).maybeSingle();
    return !!domain;
  } catch { return false; }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json(405, { error: "POST only" }, origin);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "invalid JSON" }, origin); }
  const appId = String(body.appId || "");
  const sessionId = String(body.sessionId || "").slice(0, 100);
  const name = String(body.name || "").slice(0, 80);
  const path = String(body.path || "/").slice(0, 500);
  const properties = body.properties && typeof body.properties === "object" ? body.properties : {};
  if (!/^[0-9a-f-]{36}$/i.test(appId) || !/^[a-z][a-z0-9_.-]{1,79}$/i.test(name) || sessionId.length < 8) {
    return json(400, { error: "invalid analytics event" }, origin);
  }
  if (JSON.stringify(properties).length > 8000) return json(400, { error: "properties are too large" }, origin);
  if (!(await allowedOrigin(appId, origin))) return json(403, { error: "Analytics must come from this app's live domain." }, origin);
  const { data: project } = await svc.from("projects").select("owner").eq("id", appId).maybeSingle();
  const { data: feature } = await svc.from("feature_flags").select("enabled").eq("key", "analytics").maybeSingle();
  if (!project || !feature?.enabled) return json(503, { error: "Analytics are not available yet." }, origin);
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const { count } = await svc.from("app_analytics_events").select("id", { count: "exact", head: true })
    .eq("app_id", appId).eq("session_id", sessionId).gte("created_at", hourAgo);
  if ((count || 0) >= 500) return json(429, { error: "analytics rate limit" }, origin);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: authData } = await svc.auth.getUser(token);
  const { error } = await svc.from("app_analytics_events").insert({
    app_id: appId, owner: project.owner, app_user_id: authData.user?.id || null, session_id: sessionId, name, path, properties,
  });
  return error ? json(500, { error: "analytics write failed" }, origin) : json(202, { accepted: true }, origin);
});
