// app-accounts — real accounts, memberships and administration for generated/published apps.
//
// The authority the audit asks for (§8): profile reads/updates, membership roles and status,
// invitations and provisioning are decided HERE from the caller's app-scoped identity and the
// app's membership rows — never from a role field on a generated business record, and never
// from anything the client sends about itself. The evaluation logic (policy.js) and the service
// (accountService.mjs) are shared byte-for-byte with the shell and its tests.
//
//   POST { command, appId, ...payload }  with  Authorization: Bearer <app user JWT>
//     me            -> { principal, membership, profile, profileFields, allowedActions }
//     updateMe      -> { profile }                 payload: { values }
//     permissions   -> { role, status, roles, allowedActions }
//     member        -> membership                 payload: { userId | email }
//     members       -> [membership]               (members.read)
//     invite        -> membership                 payload: { email, role }        (members.invite)
//     provision     -> membership                 payload: { email, role }        (members.provision; creates the account)
//     setRole       -> membership                 payload: { userId|email, role } (members.role)
//     setStatus     -> membership                 payload: { userId|email, status: active|suspended } (members.status)
//   Denials: 401 unauthenticated · 403 { code } · 404 member_not_found · 409 already_member/last_admin.
//
// Storage: app_users (mapping, deny-all RLS), app_memberships, app_profiles, app_membership_events,
// app_account_policies — all service-role only (migration 20260918120000_app_accounts_memberships).

import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import { AccountError, createAccountService } from "./accountService.mjs";
import { PlatformStateError, createPlatformStateService } from "./platformStateService.mjs";
import { buildPolicy } from "./policy.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SYNTH_DOMAIN = "apps.thrallo.com";
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
const COMMANDS = [
  "me", "updateMe", "permissions", "member", "members", "invite", "provision", "setRole", "setStatus",
  // WP8 — settings and audit history. There is deliberately no "appendHistory": history is
  // written by the platform (this function and the entities trigger), never by an application.
  "settings", "setSetting", "history",
];

type Row = Record<string, unknown>;
const fromRow = (row: Row | null) => row ? ({
  appId: row.app_id, email: row.email, authUserId: row.auth_user_id, role: row.role, status: row.status,
  grantedBy: row.granted_by, provisioned: row.provisioned === true, createdAt: row.created_at, updatedAt: row.updated_at,
}) : null;
const toRow = (row: Row) => ({
  app_id: row.appId, email: String(row.email).toLowerCase(), auth_user_id: row.authUserId ?? null, role: row.role,
  status: row.status, granted_by: row.grantedBy ?? null, provisioned: row.provisioned === true,
  updated_at: row.updatedAt ?? new Date().toISOString(),
});

/** Supabase storage twin over the service-role client. */
function supabaseAccountStorage(appIdFilter: string) {
  return {
    async getMapping(appId: string, { authUserId = null, email = null }: { authUserId?: string | null; email?: string | null }) {
      let query = svc.from("app_users").select("email,status,auth_user_id").eq("app_id", appId);
      query = authUserId ? query.eq("auth_user_id", authUserId) : query.eq("email", String(email).toLowerCase());
      const { data } = await query.maybeSingle();
      return data ? { authUserId: data.auth_user_id, email: data.email, status: data.status } : null;
    },
    async getMembership(appId: string, { authUserId = null, email = null }: { authUserId?: string | null; email?: string | null }) {
      let query = svc.from("app_memberships").select("*").eq("app_id", appId);
      query = authUserId ? query.eq("auth_user_id", authUserId) : query.eq("email", String(email).toLowerCase());
      const { data } = await query.maybeSingle();
      return fromRow(data as Row | null);
    },
    async listMemberships(appId: string) {
      const { data } = await svc.from("app_memberships").select("*").eq("app_id", appId);
      return (data || []).map((row) => fromRow(row as Row));
    },
    async upsertMembership(row: Row) {
      const { data, error } = await svc.from("app_memberships").upsert(toRow(row), { onConflict: "app_id,email" }).select("*").single();
      if (error) throw new AccountError("storage_error", error.message, 500);
      return fromRow(data as Row);
    },
    async getProfile(appId: string, authUserId: string) {
      const { data } = await svc.from("app_profiles").select("data").eq("app_id", appId).eq("auth_user_id", authUserId).maybeSingle();
      return (data?.data as Row) || null;
    },
    async setProfile(appId: string, authUserId: string, value: Row) {
      const { data, error } = await svc.from("app_profiles").upsert({ app_id: appId, auth_user_id: authUserId, data: value, updated_at: new Date().toISOString() },
        { onConflict: "app_id,auth_user_id" }).select("data").single();
      if (error) throw new AccountError("storage_error", error.message, 500);
      return data.data;
    },
    async appendEvent(row: Row) {
      await svc.from("app_membership_events").insert({
        app_id: row.appId, action: row.action, actor_user_id: row.actorUserId, actor_email: row.actorEmail,
        target_email: row.targetEmail, target_user_id: row.targetUserId, before: row.before, after: row.after, created_at: row.at,
      });
      return row;
    },
    async getPolicy(appId: string) {
      if (appId !== appIdFilter) return null;
      const { data } = await svc.from("app_account_policies").select("policy").eq("app_id", appId).maybeSingle();
      return data?.policy ? buildPolicy(data.policy as Record<string, unknown>) : null;
    },
  };
}

/** Supabase storage twin for settings and history (service role, app-scoped). */
function supabasePlatformStateStorage() {
  return {
    async getSettings(appId: string, scope: string, target: string | null) {
      const { data } = await svc.from("app_settings").select("key,value")
        .eq("app_id", appId).eq("scope", scope).eq("scope_target", target || "");
      return (data || []).reduce((all: Row, row: Row) => ({ ...all, [String(row.key)]: row.value }), {} as Row);
    },
    async setSetting(row: Row) {
      const { data, error } = await svc.from("app_settings").upsert({
        app_id: row.appId, scope: row.scope, scope_target: row.scopeTarget || "", key: row.key,
        value: row.value, updated_by: row.updatedBy ?? null, updated_at: row.updatedAt,
      }, { onConflict: "app_id,scope,scope_target,key" }).select("key,value,version").single();
      if (error) throw new PlatformStateError("storage_error", error.message, 500);
      return { ...row, value: data.value, version: data.version };
    },
    async appendEvent(row: Row) {
      const { data, error } = await svc.from("app_audit_events").insert({
        app_id: row.appId, actor_user_id: row.actorUserId, actor_email: row.actorEmail, action: row.action,
        resource: row.resource, resource_id: row.resourceId, before: row.before, after: row.after, created_at: row.createdAt,
      }).select("id").single();
      if (error) throw new PlatformStateError("storage_error", error.message, 500);
      return { ...row, id: data.id };
    },
    async listEvents(appId: string, { resource = null, resourceId = null, limit = 50, cursor = null }: Record<string, unknown> = {}) {
      let query = svc.from("app_audit_events").select("*").eq("app_id", appId)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(Number(limit) + 1);
      if (resource) query = query.eq("resource", resource);
      if (resourceId) query = query.eq("resource_id", resourceId);
      if (cursor) {
        const { data: at } = await svc.from("app_audit_events").select("created_at").eq("id", cursor).maybeSingle();
        if (at?.created_at) query = query.lt("created_at", at.created_at);
      }
      const { data } = await query;
      const rows = (data || []).map((row: Row) => ({
        id: row.id, action: row.action, resource: row.resource, resourceId: row.resource_id,
        actorUserId: row.actor_user_id, actorEmail: row.actor_email,
        before: row.before, after: row.after, createdAt: row.created_at,
      }));
      const page = rows.slice(0, Number(limit));
      return { events: page, nextCursor: rows.length > Number(limit) ? page.at(-1)?.id || null : null };
    },
    async getAuditConfig(appId: string) {
      const { data } = await svc.from("app_audit_config").select("enabled,sensitive_fields").eq("app_id", appId).maybeSingle();
      return data ? { enabled: data.enabled === true, sensitiveFields: (data.sensitive_fields as string[]) || [] } : null;
    },
  };
}

async function provisionAuthUser(appId: string, email: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${appId}:${email}`));
  const synth = `${Array.from(new Uint8Array(digest)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")}@${SYNTH_DOMAIN}`;
  const password = crypto.randomUUID() + crypto.randomUUID();
  const { data, error } = await svc.auth.admin.createUser({
    email: synth, password, email_confirm: true, user_metadata: { app_id: appId, app_email: email, provisioned: true },
  });
  if (error && !/already.*(regist|exist)/i.test(error.message)) throw new AccountError("provision_failed", error.message, 500);
  if (data?.user) {
    const { error: mapErr } = await svc.from("app_users").insert({ app_id: appId, email, auth_user_id: data.user.id });
    if (mapErr && !/duplicate|unique|conflict|23505/i.test(mapErr.message)) throw new AccountError("provision_failed", mapErr.message, 500);
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json(405, { error: "POST only" }, origin);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: "invalid JSON" }, origin); }
  const command = text(body.command, 20);
  const appId = text(body.appId, 64);
  if (!uuid(appId)) return json(400, { error: "Valid appId is required." }, origin);
  if (!COMMANDS.includes(command)) return json(400, { error: `command must be one of ${COMMANDS.join(", ")}` }, origin);

  const { data: authed, error: authError } = await svc.auth.getUser(token);
  if (authError || !authed.user) return json(401, { error: "Sign in to this app first.", code: "unauthenticated" }, origin);

  const storage = supabaseAccountStorage(appId);
  const policy = await storage.getPolicy(appId);
  const service = createAccountService({ storage, policy, profileFields: (policy as unknown as { profileFields?: string[] })?.profileFields || ["displayName"] });
  const actor = await service.actorFor(appId, authed.user.id);
  if (!actor) return json(401, { error: "Sign in to this app first.", code: "unauthenticated" }, origin);
  const platformState = createPlatformStateService({
    storage: supabasePlatformStateStorage(),
    policy: policy || undefined,
    settingsSchema: (policy as unknown as { settings?: Record<string, unknown> })?.settings || null,
    sensitiveFields: (policy as unknown as { sensitiveFields?: string[] })?.sensitiveFields || [],
  });

  try {
    switch (command) {
      case "me": return json(200, await service.me(appId, actor), origin);
      case "updateMe": return json(200, await service.updateMe(appId, actor, (body.values as Row) || {}), origin);
      case "permissions": return json(200, await service.permissions(appId, actor), origin);
      case "member": return json(200, await service.member(appId, actor, { userId: text(body.userId, 64) || null, email: text(body.email) || null }), origin);
      case "members": return json(200, { members: await service.members(appId, actor) }, origin);
      case "invite": return json(200, await service.invite(appId, actor, { email: text(body.email), role: text(body.role, 40) || null }), origin);
      case "provision": {
        const email = text(body.email).toLowerCase();
        const membership = await service.invite(appId, actor, { email, role: text(body.role, 40) || null, provisioned: true });
        await provisionAuthUser(appId, email);
        const mapping = await storage.getMapping(appId, { email });
        const activated = mapping ? await service.activateInvitation(appId, { email, authUserId: mapping.authUserId }) : null;
        return json(200, activated || membership, origin);
      }
      case "setRole": return json(200, await service.setRole(appId, actor, { userId: text(body.userId, 64) || null, email: text(body.email) || null, role: text(body.role, 40) }), origin);
      case "setStatus": return json(200, await service.setStatus(appId, actor, { userId: text(body.userId, 64) || null, email: text(body.email) || null, status: text(body.status, 20) }), origin);
      case "settings": return json(200, { values: await platformState.settings(appId, actor, { scope: text(body.scope, 20) || "app", target: text(body.target, 64) || null }) }, origin);
      case "setSetting": return json(200, await platformState.setSetting(appId, actor, { key: text(body.key, 80), value: body.value, target: text(body.target, 64) || null }), origin);
      case "history": return json(200, await platformState.history(appId, actor, {
        resource: text(body.resource, 80) || null, resourceId: text(body.resourceId, 80) || null,
        limit: Math.max(1, Math.min(200, Number(body.limit) || 50)), cursor: text(body.cursor, 80) || null,
      }), origin);
      default: return json(400, { error: "unknown command" }, origin);
    }
  } catch (error) {
    if (error instanceof AccountError || error instanceof PlatformStateError) {
      return json(error.status, { error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) }, origin);
    }
    return json(500, { error: String((error as Error)?.message || error).slice(0, 300) }, origin);
  }
});
