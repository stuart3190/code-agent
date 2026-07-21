// The backend SDK — Supabase implementation.
//
// This is the SWAPPABLE seam: generated apps import { auth, db, storage } from
// "./lib/backend" and NEVER touch @supabase/supabase-js directly. A different backend
// (own Postgres, self-hosted Supabase, etc.) just has to provide the same shape from
// createXxxBackend(config) — no generated app changes.
//
//   createSupabaseBackend({ url, anonKey, bucket?, appId? }) -> { auth, db, storage, _client }
//
// The factory is PURE: it takes its config as arguments, so the exact same code path can
// run in the browser (env wired in ./index.js) or headless in Node (env passed directly).
// Data model is intentionally thin and migration-free: ONE generic `entities` table
//   (id uuid, type text, data jsonb, owner uuid, app_id text, created_at timestamptz)
// so db.entity("note") / db.entity("task") need no per-app schema. When `appId` is set,
// every row is stamped and filtered with it, so two apps owned by the SAME user never see
// each other's rows even when they pick the same type string. Security stays owner-scoped
// RLS (owner = auth.uid()); app_id is a namespace, not a security boundary.

import { createClient } from "@supabase/supabase-js";

export function createSupabaseBackend({ url, anonKey, bucket = "uploads", appId = null, authUrl = null, paymentsUrl = null, actionsUrl = null, analyticsUrl = null } = {}) {
  if (!url || !anonKey) {
    throw new Error(
      "createSupabaseBackend: `url` and `anonKey` are required (set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)."
    );
  }
  const client = createClient(url, anonKey);

  // Normalise a Supabase {data,error} reply into a value-or-throw, so app code can
  // `await` and use try/catch instead of threading error objects through the UI.
  const unwrap = ({ data, error }) => {
    if (error) throw error;
    return data;
  };

  // Per-app auth (PLAN-per-app-auth default lane): when authUrl + appId are configured, sign-up/
  // sign-in go through the platform's app-auth Edge Function, which maps (appId, email) to an
  // app-scoped auth user and returns a REAL session — same email can register in many apps without
  // collision. The session is installed on this client, so db/storage/RLS behave identically.
  const appAuthPost = async (action, payload = {}) => {
    const res = await fetch(authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${anonKey}`, apikey: anonKey },
      body: JSON.stringify({ action, appId, ...payload }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `auth ${action} failed (${res.status})`);
    return out;
  };
  // Session-returning actions install the session on this client so db/storage/RLS just work.
  const appAuthCall = async (action, payload = {}) => {
    const out = await appAuthPost(action, payload);
    unwrap(await client.auth.setSession({
      access_token: out.session.access_token,
      refresh_token: out.session.refresh_token,
    }));
    return out.user;
  };

  const auth = authUrl && appId
    ? {
        async signUp({ email, password }) { return appAuthCall("signup", { email, password }); },
        async signIn({ email, password }) { return appAuthCall("signin", { email, password }); },
        // Emails a 6-digit code to the account's address (always resolves — no account enumeration).
        async resetPassword({ email }) { await appAuthPost("reset", { email }); },
        // Verifies the emailed code, sets the new password, and signs the user in.
        async confirmReset({ email, code, newPassword }) {
          return appAuthCall("reset-confirm", { email, code, newPassword });
        },
        async signOut() {
          const { error } = await client.auth.signOut();
          if (error) throw error;
        },
        async currentUser() {
          const { data } = await client.auth.getUser();
          const u = data?.user ?? null;
          // Surface the REAL email the person typed, not the app-scoped synthetic address.
          return u ? { ...u, email: u.user_metadata?.app_email || u.email } : null;
        },
      }
    : {
        async signUp({ email, password }) {
          const data = unwrap(await client.auth.signUp({ email, password }));
          return data.user;
        },
        async signIn({ email, password }) {
          const data = unwrap(await client.auth.signInWithPassword({ email, password }));
          return data.user;
        },
        // Direct (non-app-scoped) lane: Supabase's own recovery email; no code flow exists here.
        async resetPassword({ email }) {
          const { error } = await client.auth.resetPasswordForEmail(email);
          if (error) throw error;
        },
        async confirmReset() {
          throw new Error("confirmReset is only available for app-scoped auth — use the link in the recovery email instead.");
        },
        async signOut() {
          const { error } = await client.auth.signOut();
          if (error) throw error;
        },
        async currentUser() {
          const { data } = await client.auth.getUser();
          return data?.user ?? null;
        },
      };

  // db.entity(type) — CRUD over the generic `entities` table, scoped to one `type`.
  // Records are returned flat: { id, type, data, owner, created_at }.
  const db = {
    entity(type) {
      if (!type) throw new Error("db.entity(type): a non-empty entity type is required.");
      const table = () => client.from("entities");
      // Apply the app namespace to a query when this backend is app-scoped.
      const scoped = (q) => (appId ? q.eq("app_id", appId) : q);
      return {
        async create(data = {}) {
          const row = appId ? { type, data, app_id: appId } : { type, data };
          const rows = unwrap(await table().insert(row).select());
          return rows[0];
        },
        async list() {
          return unwrap(
            await scoped(table().select("*").eq("type", type)).order("created_at", { ascending: false })
          );
        },
        async get(id) {
          return unwrap(await scoped(table().select("*").eq("type", type).eq("id", id)).single());
        },
        async update(id, patch = {}) {
          const rows = unwrap(
            await scoped(table().update({ data: patch }).eq("type", type).eq("id", id)).select()
          );
          return rows[0];
        },
        async delete(id) {
          const { error } = await scoped(table().delete().eq("type", type).eq("id", id));
          if (error) throw error;
        },
      };
    },
  };

  // Storage is namespaced per user: every object key lives under `<uid>/...`, and the bucket's
  // RLS policies scope access to (storage.foldername(name))[1] = auth.uid(). The app stays
  // UNAWARE of tenancy — it passes its own logical `path` and stores back the RETURNED
  // (uid-prefixed) key opaquely. The bucket is PRIVATE, so reads go via short-lived signed URLs.
  const storage = {
    // file: a browser File/Blob or a Node Buffer/Uint8Array/ArrayBuffer.
    // path: optional logical key; auto-generated when omitted. The caller's uid is prefixed.
    async upload(file, path) {
      const uid = (await client.auth.getSession()).data.session?.user?.id;
      if (!uid) throw new Error("storage.upload: must be signed in to upload.");
      const name = path || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const key = `${uid}/${name}`;
      const data = unwrap(
        await client.storage.from(bucket).upload(key, file, { upsert: true })
      );
      return { path: data.path };
    },
    // Private bucket -> mint a short-lived signed URL. ASYNC (await it).
    async getUrl(path, expiresIn = 3600) {
      const data = unwrap(
        await client.storage.from(bucket).createSignedUrl(path, expiresIn)
      );
      return data.signedUrl;
    },
  };

  const payments = {
    async checkout({ productId, successPath = "/?checkout=success", cancelPath = "/?checkout=cancel", redirect = true } = {}) {
      if (!paymentsUrl || !appId) throw new Error("Payments are not configured for this app.");
      if (!productId) throw new Error("payments.checkout: productId is required.");
      const session = (await client.auth.getSession()).data.session;
      if (!session?.access_token) throw new Error("Sign in before starting checkout.");
      const response = await fetch(paymentsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`, apikey: anonKey },
        body: JSON.stringify({ appId, productId, successPath, cancelPath }),
      });
      const out = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(out.error || `Checkout could not start (${response.status}).`);
      if (redirect) window.location.assign(out.url);
      return out;
    },
  };

  const actionPost = async (action, payload = {}) => {
    if (!actionsUrl || !appId) throw new Error("App actions are not configured.");
    const session = (await client.auth.getSession()).data.session;
    if (!session?.access_token) throw new Error("Sign in before using notifications.");
    const response = await fetch(actionsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`, apikey: anonKey },
      body: JSON.stringify({ action, appId, ...payload }),
    });
    const out = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(out.error || `App action failed (${response.status}).`);
    return out;
  };

  const notifications = {
    async list({ unreadOnly = false, limit = 50 } = {}) {
      let query = client.from("app_notifications").select("id,title,body,data,read_at,created_at")
        .eq("app_id", appId).order("created_at", { ascending: false }).limit(Math.max(1, Math.min(100, limit)));
      if (unreadOnly) query = query.is("read_at", null);
      return unwrap(await query);
    },
    async markRead(id) {
      return unwrap(await client.from("app_notifications").update({ read_at: new Date().toISOString() }).eq("id", id).eq("app_id", appId).select().single());
    },
    async notifySelf({ title, body = "", data = {} }) { return actionPost("notify_self", { title, body, data }); },
    async emailSelf({ subject, text }) { return actionPost("email_self", { subject, text }); },
    async emit(event, payload = {}) { return actionPost("emit", { event, payload }); },
  };

  const sessionId = (() => {
    if (typeof window === "undefined") return `server-${Date.now()}`;
    try {
      const key = `buildr-session:${appId || "app"}`;
      let value = window.sessionStorage.getItem(key);
      if (!value) { value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`; window.sessionStorage.setItem(key, value); }
      return value;
    } catch { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  })();
  const analytics = {
    async track(name, properties = {}) {
      if (!analyticsUrl || !appId || typeof window === "undefined") return { skipped: true };
      const token = (await client.auth.getSession()).data.session?.access_token || anonKey;
      const response = await fetch(analyticsUrl, {
        method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: anonKey },
        body: JSON.stringify({ appId, sessionId, name, path: `${window.location.pathname}${window.location.search}`.slice(0, 500), properties }),
      });
      if (!response.ok) throw new Error(`Analytics event failed (${response.status}).`);
      return response.json();
    },
    async page(properties = {}) { return analytics.track("page_view", { title: document.title, ...properties }); },
  };

  if (typeof window !== "undefined" && analyticsUrl && appId) {
    queueMicrotask(() => analytics.page().catch(() => {}));
    window.addEventListener("error", (event) => analytics.track("client_error", {
      message: String(event.message || "Runtime error").slice(0, 500), file: String(event.filename || "").slice(0, 300),
      line: event.lineno || null, column: event.colno || null,
    }).catch(() => {}));
    window.addEventListener("unhandledrejection", (event) => analytics.track("client_error", {
      message: String(event.reason?.message || event.reason || "Unhandled rejection").slice(0, 500),
      stack: String(event.reason?.stack || "").slice(0, 1200),
    }).catch(() => {}));
  }

  return { auth, db, storage, payments, notifications, analytics, _client: client };
}
