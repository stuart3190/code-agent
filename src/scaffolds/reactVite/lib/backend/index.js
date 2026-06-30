// Backend SDK entry point for the generated app.
//
// Wires the Vite-injected env (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY, set in .env)
// into the pure backend factory, then re-exports the stable surface the app uses:
//
//   import { auth, db, storage } from "./lib/backend";
//
//   await auth.signUp({ email, password });   await auth.signIn({ email, password });
//   await auth.currentUser();                  await auth.signOut();
//   const note  = await db.entity("note").create({ title, body });
//   const notes = await db.entity("note").list();
//   const { path } = await storage.upload(file);   const url = await storage.getUrl(path);
//
// The app NEVER imports @supabase/supabase-js directly — only this seam. Swapping the
// backend (self-hosted Supabase, own Postgres, …) means swapping the factory here, with
// no change to any generated app.

import { createSupabaseBackend } from "./supabaseBackend.js";

const backend = createSupabaseBackend({
  url: import.meta.env.VITE_SUPABASE_URL,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
});

export const auth = backend.auth;
export const db = backend.db;
export const storage = backend.storage;
export default backend;
