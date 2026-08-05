// Backend SDK entry point for the generated app.
//
// Wires the Vite-injected env (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_APP_ID,
// set in .env at materialization time) into the pure backend factory, then re-exports the
// stable surface the app uses. THIS COMMENT IS THE COMPLETE SUPPORTED SURFACE — everything
// below is real and there is nothing else; do not read the implementation to discover an API.
//
//   import { auth, db, storage } from "./lib/backend";
//
// AUTH — sessions are owner-scoped RLS; every db/storage call needs a signed-in session
// (anonymous apps: import { ensureVisitorSession } from "../visitorSession").
//   await auth.signUp({ email, password })            -> user
//   await auth.signIn({ email, password })            -> user
//   await auth.currentUser()                          -> user | null
//   await auth.signOut()
//   await auth.resetPassword({ email })               (no result; emails a code)
//   await auth.confirmReset({ email, code, newPassword }) -> user
//
// ENTITIES — db.entity("<type>") is generic CRUD; records come back FLAT:
// { id, type, data: {…your fields…}, owner, created_at }. Rows belong to the signed-in
// user (RLS) and to this app (app_id namespace) automatically.
//   .create(values)                                   -> row       (values become row.data)
//   .get(id)                                          -> row       (throws if absent)
//   .list({ filters, order, ascending, limit, cursor }) -> rows
//       filters: { field: value } exact-match on your data fields (or id / created_at), or
//                { field: { eq | neq | gte | lte | ilike | in: [...] } } per field
//       order:   "created_at" (default) | "id" | "type" · ascending: false by default
//       limit:   1..500 (default 100) · cursor: a created_at value for keyset pagination
//   .count(filters)                                   -> number
//   .update(id, values)                               -> row
//       REPLACES row.data with `values` wholesale — it does NOT merge. To change one field:
//       const row = await db.entity("booking").get(id);
//       await db.entity("booking").update(id, { ...row.data, status: "Cancelled" });
//   .delete(id)                                       (void; throws on failure)
//   .subscribe(callback)                              -> unsubscribe()   (live row changes)
//
// STORAGE
//   const { path } = await storage.upload(file);   const url = await storage.getUrl(path);
//
// The app NEVER imports @supabase/supabase-js directly — only this seam. Swapping the
// backend (self-hosted Supabase, own Postgres, …) means swapping the factory here, with
// no change to any generated app.
//
// FAIL-SOFT: if the env is missing (e.g. a downloaded project without a filled .env), the
// app still RENDERS — every backend call throws a clear configuration error on use instead
// of the whole module graph dying at import time (the old white-screen failure mode).

import { createSupabaseBackend } from "./supabaseBackend.js";

function unconfigured() {
  const fail = () => {
    throw new Error(
      "Backend is not configured: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env (copy .env.example), then restart the dev server."
    );
  };
  const surface = { signUp: fail, signIn: fail, signOut: fail, currentUser: fail, resetPassword: fail, confirmReset: fail };
  return {
    auth: surface,
    db: { entity: () => ({ create: fail, list: fail, get: fail, update: fail, delete: fail }) },
    storage: { upload: fail, getUrl: fail },
    payments: { checkout: fail },
    notifications: { list: fail, markRead: fail, notifySelf: fail, emailSelf: fail, emit: fail },
    actions: { invoke: fail, getJob: fail, listJobs: fail, cancel: fail, subscribe: fail, wait: fail },
    usage: { getBalance: fail },
    knowledge: { search: fail },
    integrations: { meta: { overview: fail, start: fail, connect: fail, select: fail, disconnect: fail } },
    analytics: { track: fail, page: fail },
    _client: null,
  };
}

let backend;
try {
  backend = createSupabaseBackend({
    url: import.meta.env.VITE_SUPABASE_URL,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    appId: import.meta.env.VITE_APP_ID || null,
    authUrl: import.meta.env.VITE_AUTH_URL || null,
    paymentsUrl: import.meta.env.VITE_PAYMENTS_URL || null,
    actionsUrl: import.meta.env.VITE_ACTIONS_URL || null,
    runtimeUrl: import.meta.env.VITE_RUNTIME_URL || null,
    connectorsUrl: import.meta.env.VITE_CONNECTORS_URL || null,
    analyticsUrl: import.meta.env.VITE_ANALYTICS_URL || null,
  });
} catch {
  backend = unconfigured();
}

export const auth = backend.auth;
export const db = backend.db;
export const storage = backend.storage;
export const payments = backend.payments;
export const notifications = backend.notifications;
export const actions = backend.actions;
export const usage = backend.usage;
export const knowledge = backend.knowledge;
export const integrations = backend.integrations;
export const analytics = backend.analytics;
export default backend;
