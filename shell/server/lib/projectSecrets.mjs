import { decryptSecret, encryptSecret, secretHint } from "./secretCrypto.mjs";
import { ownedProject, serviceClient } from "./supabase.mjs";

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ENVIRONMENTS = new Set(["test", "live"]);

function validate(environment, name) {
  if (!ENVIRONMENTS.has(environment)) throw Object.assign(new Error("environment must be test or live"), { code: "bad_secret" });
  if (!NAME_RE.test(name)) throw Object.assign(new Error("secret names must be uppercase letters, numbers and underscores"), { code: "bad_secret" });
}

export async function listProjectSecrets(owner, projectId, environment = "test", client = serviceClient()) {
  if (!(await ownedProject(owner, projectId, "id", client))) return null;
  const { data, error } = await client.from("project_secrets")
    .select("name,value_hint,environment,created_at,updated_at")
    .eq("owner", owner).eq("project_id", projectId).eq("environment", environment).order("name");
  if (error) throw new Error(`project secrets: ${error.message}`);
  return data || [];
}

export async function setProjectSecret(owner, projectId, environment, name, value, client = serviceClient()) {
  validate(environment, name);
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) {
    throw Object.assign(new Error("secret value is required and must be under 16 KiB"), { code: "bad_secret" });
  }
  if (!(await ownedProject(owner, projectId, "id", client))) return null;
  const now = new Date().toISOString();
  const row = {
    owner, project_id: projectId, environment, name,
    value_encrypted: encryptSecret(value), value_hint: secretHint(value), updated_at: now,
  };
  const { data, error } = await client.from("project_secrets")
    .upsert(row, { onConflict: "project_id,environment,name" })
    .select("name,value_hint,environment,created_at,updated_at").single();
  if (error) throw new Error(`project secret save: ${error.message}`);
  return data;
}

export async function deleteProjectSecret(owner, projectId, environment, name, client = serviceClient()) {
  validate(environment, name);
  if (!(await ownedProject(owner, projectId, "id", client))) return null;
  const { error } = await client.from("project_secrets")
    .delete().eq("owner", owner).eq("project_id", projectId).eq("environment", environment).eq("name", name);
  if (error) throw new Error(`project secret delete: ${error.message}`);
  return { deleted: true };
}

export async function getProjectSecret(owner, projectId, environment, name, client = serviceClient()) {
  validate(environment, name);
  const { data, error } = await client.from("project_secrets").select("value_encrypted")
    .eq("owner", owner).eq("project_id", projectId).eq("environment", environment).eq("name", name).maybeSingle();
  if (error) throw new Error(`project secret read: ${error.message}`);
  return data?.value_encrypted ? decryptSecret(data.value_encrypted) : null;
}
