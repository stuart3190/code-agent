// Trusted writer for per-app end-user notifications.
//
// Two write paths exist, deliberately:
//
//   * the generated app's own client, through the SDK — RLS keeps it owner-scoped, so an app
//     (or a compromised one) can only ever notify the user who is signed in;
//   * this module, with the service role — for notifications the user must NOT be able to forge
//     for themselves: a welcome on signup, a security alert when their password changes.
//
// That split is the whole reason a trusted writer exists. Without it the feature is inert: the
// SDK could only echo the user's own actions back at them.
//
// Not to be confused with lib/notifications/notificationService.mjs, which notifies the THRALLO
// OWNER (web push, "your build needs a decision"). This notifies the end users OF a generated
// app, inside that app.

import { serviceClient } from "./supabase.mjs";

// Sources are a closed set so a notification's provenance is always recognisable, and so an
// app-authored row can never claim to be a platform one (the SDK cannot set `source` at all —
// the column is written here, with the service role).
export const NOTIFICATION_SOURCES = Object.freeze([
  "app_welcome",
  "password_changed",
  "app_updated",
]);

const LIMITS = { title: 160, body: 2000 };

function clamp(value, max) {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Resolve an app user by the email they actually signed up with. app-auth stores the real
// address in app_users while auth.users holds a synthetic one, so callers can address a person
// the way the app knows them.
export async function appUserByEmail({ appId, email, client = null }) {
  const db = client || serviceClient();
  const { data, error } = await db.from("app_users")
    .select("auth_user_id, status")
    .eq("app_id", String(appId))
    .eq("email", String(email).trim().toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`app user lookup: ${error.message}`);
  if (!data || data.status !== "active") return null;
  return data.auth_user_id;
}

// The trusted write. `source` is required: an untagged platform notification would be
// indistinguishable from one the app wrote itself.
export async function notifyAppUser({
  appId, appUserId = null, email = null, title, body = "", data = {}, source, client = null,
}) {
  if (!NOTIFICATION_SOURCES.includes(source)) {
    throw new Error(`unknown notification source: ${source}`);
  }
  const cleanTitle = clamp(title, LIMITS.title);
  if (!cleanTitle) throw new Error("notification title is required");

  const db = client || serviceClient();
  const owner = appUserId || (email ? await appUserByEmail({ appId, email, client: db }) : null);
  // A notification for a user who does not exist (or was disabled) is not an error worth
  // failing a signup or a password reset over — it simply has no recipient.
  if (!owner) return { delivered: false, reason: "no_recipient" };

  const { data: row, error } = await db.from("app_notifications").insert({
    owner,
    app_id: String(appId),
    title: cleanTitle,
    body: clamp(body, LIMITS.body),
    data: data && typeof data === "object" ? data : {},
    source,
  }).select("id").single();

  if (error) {
    // Never let a notification failure break the event that produced it.
    console.error(`[app-notifications] ${source}: ${error.message}`);
    return { delivered: false, reason: "write_failed" };
  }
  return { delivered: true, id: row.id };
}

// ── The real event integrations ─────────────────────────────────────────────────────────

// A new end user signs up to a generated app. Their first notification is the app's welcome —
// which also proves the notification surface works from the moment they arrive.
export async function notifyWelcome({ appId, appUserId, appName = null, client = null }) {
  return notifyAppUser({
    appId, appUserId, source: "app_welcome",
    title: appName ? `Welcome to ${appName}` : "Welcome",
    body: "Your account is ready. This is where you'll see updates.",
    data: { kind: "welcome" },
    client,
  });
}

// A password changed through the reset flow. This is the notification a user must not be able
// to write for themselves: it is how they find out about a change they did not make.
export async function notifyPasswordChanged({ appId, email, client = null }) {
  return notifyAppUser({
    appId, email, source: "password_changed",
    title: "Your password was changed",
    body: "If this wasn't you, reset your password again immediately and contact the app owner.",
    data: { kind: "security", at: new Date().toISOString() },
    client,
  });
}

// Read side for server callers (the SDK reads directly under RLS).
export async function listAppNotifications({ appId, appUserId, limit = 50, client = null }) {
  const db = client || serviceClient();
  const { data, error } = await db.from("app_notifications")
    .select("id, title, body, data, source, read_at, created_at")
    .eq("app_id", String(appId))
    .eq("owner", appUserId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(100, limit)));
  if (error) throw new Error(`notification list: ${error.message}`);
  return data || [];
}
