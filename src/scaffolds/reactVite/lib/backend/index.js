// Backend SDK entry point for the generated app.
//
// Wires the Vite-injected env (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY / VITE_APP_ID,
// set in .env at materialization time) into the pure backend factory, then re-exports the
// stable surface the app uses:
//
//   import { auth, db, storage, payments } from "./lib/backend";
//
//   await auth.signUp({ email, password });   await auth.signIn({ email, password });
//   await auth.currentUser();                  await auth.signOut();
//   await auth.resetPassword({ email });       await auth.confirmReset({ email, code, newPassword });
//   const note  = await db.entity("note").create({ title, body });
//   const notes = await db.entity("note").list();
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
