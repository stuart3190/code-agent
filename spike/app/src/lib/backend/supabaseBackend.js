// The backend SDK — Supabase implementation.
//
// This is the SWAPPABLE seam: generated apps import { auth, db, storage } from
// "./lib/backend" and NEVER touch @supabase/supabase-js directly. A different backend
// (own Postgres, self-hosted Supabase, etc.) just has to provide the same shape from
// createXxxBackend(config) — no generated app changes.
//
//   createSupabaseBackend({ url, anonKey, bucket? }) -> { auth, db, storage, _client }
//
// The factory is PURE: it takes its config as arguments, so the exact same code path can
// run in the browser (env wired in ./index.js) or headless in Node (env passed directly).
// Data model is intentionally thin and migration-free: ONE generic `entities` table
//   (id uuid, type text, data jsonb, owner uuid, created_at timestamptz)
// so db.entity("note") / db.entity("task") need no per-app schema.

import { createClient } from "@supabase/supabase-js";

export function createSupabaseBackend({ url, anonKey, bucket = "uploads" } = {}) {
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

  const auth = {
    async signUp({ email, password }) {
      const data = unwrap(await client.auth.signUp({ email, password }));
      return data.user;
    },
    async signIn({ email, password }) {
      const data = unwrap(await client.auth.signInWithPassword({ email, password }));
      return data.user;
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
      return {
        async create(data = {}) {
          const rows = unwrap(await table().insert({ type, data }).select());
          return rows[0];
        },
        async list() {
          return unwrap(
            await table().select("*").eq("type", type).order("created_at", { ascending: false })
          );
        },
        async get(id) {
          return unwrap(await table().select("*").eq("type", type).eq("id", id).single());
        },
        async update(id, patch = {}) {
          const rows = unwrap(
            await table().update({ data: patch }).eq("type", type).eq("id", id).select()
          );
          return rows[0];
        },
        async delete(id) {
          const { error } = await table().delete().eq("type", type).eq("id", id);
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

  return { auth, db, storage, _client: client };
}
