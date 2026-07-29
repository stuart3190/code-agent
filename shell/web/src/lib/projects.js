// Project persistence — the one genuinely new state. Backed by a DEDICATED owner-scoped table,
// public.projects (migrations/projects.sql), whose RLS is modelled exactly on the Phase 3.1 entities
// policies. Reads/writes go through the user's own Supabase session (client()), so RLS owner-scopes
// every call — a user's projects survive reload/reopen and are invisible to other tenants. The tree is
// the durable build state; history carries the turn log that makes edits hold across sessions.
//
//   row = { id, owner, name, tree, history, preview_ref, created_at, updated_at }
// The UI keeps using .prompts / .previewRef / .updatedAt, so rowToProject maps the columns on read.

import { client } from "./backend.js";

const table = () => client().from("projects");

const unwrap = ({ data, error }) => { if (error) throw error; return data; };

// Column -> UI shape (history->prompts, preview_ref->previewRef, snake_case timestamps -> camelCase).
function rowToProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tree: row.tree,
    prompts: row.history || [],
    previewRef: row.preview_ref,
    knowledge: row.knowledge || "",
    publishedUrl: row.published_url || null,
    designProfile: row.design_profile || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Rename only (the full-state saveProject also carries name, but rename shouldn't rewrite the tree).
export async function renameProject(id, name) {
  const rows = unwrap(await table().update({ name, updated_at: new Date().toISOString() }).eq("id", id).select());
  return rowToProject(rows[0]);
}

// Save just the project knowledge (custom instructions applied to every turn).
export async function saveKnowledge(id, knowledge) {
  const rows = unwrap(await table().update({ knowledge, updated_at: new Date().toISOString() }).eq("id", id).select());
  return rowToProject(rows[0]);
}

// Record where the project's static site is published.
export async function savePublishedUrl(id, publishedUrl) {
  const rows = unwrap(await table().update({ published_url: publishedUrl, updated_at: new Date().toISOString() }).eq("id", id).select());
  return rowToProject(rows[0]);
}

export async function listProjects() {
  const rows = unwrap(await table().select("*").order("updated_at", { ascending: false }));
  return rows.map(rowToProject);
}

export async function getProject(id) {
  const row = unwrap(await table().select("*").eq("id", id).single());
  return rowToProject(row);
}

export async function createProject(name, id = undefined) {
  // owner is stamped by the DB default (auth.uid()); the app never sets it — same as Phase 3.1 entities.
  const row = { name: name || "Untitled app", tree: null, history: [], preview_ref: null };
  if (id) row.id = id;
  const rows = unwrap(await table().insert(row).select());
  return rowToProject(rows[0]);
}

// Persist the full build state after a generate/iterate turn.
export async function saveProject(id, { name, tree, prompts, previewRef, designProfile }) {
  const patch = { name, tree, history: prompts, preview_ref: previewRef, updated_at: new Date().toISOString() };
  if (designProfile !== undefined) patch.design_profile = designProfile;
  const rows = unwrap(await table().update(patch).eq("id", id).select());
  return rowToProject(rows[0]);
}

export async function deleteProject(id) {
  const { error } = await table().delete().eq("id", id);
  if (error) throw error;
}
