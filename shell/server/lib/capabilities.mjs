import { optionalEnv } from "./env.mjs";
import { requireFeature } from "./features.mjs";
import { deleteProjectSecret, getProjectSecret, setProjectSecret } from "./projectSecrets.mjs";
import { auditEvent } from "./projectState.mjs";
import { safeBrowserUrl } from "./qaRunner.mjs";
import { ownedProject, serviceClient } from "./supabase.mjs";

const objectSchema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = (description, maxLength = 8000) => ({ type: "string", description, maxLength });

export const CAPABILITY_PRESETS = Object.freeze([
  { id: "ai_text", name: "AI text & vision", category: "AI", provider: "openai", operation: "text", modes: ["managed","byok"], maxCredits: 1,
    description: "Generate, analyse, classify, or answer from text and optional images.",
    inputSchema: objectSchema({ prompt: string("The user request"), images: { type: "array", items: { type: "string" }, maxItems: 10 } }, ["prompt"]),
    outputSchema: objectSchema({ result: string("Generated response") }, ["result"]), config: { model: "gpt-5.4-mini", max_output_tokens: 2000,
      usd_per_million_input: 0.75, usd_per_million_cached_input: 0.075, usd_per_million_output: 4.5, usd_to_gbp: 0.8 } },
  { id: "ai_structured", name: "Structured AI extraction", category: "AI", provider: "openai", operation: "structured", modes: ["managed","byok"], maxCredits: 1,
    description: "Return schema-validated JSON for forms, extraction, moderation, and classification.",
    inputSchema: objectSchema({ prompt: string("Text or instruction to process", 20000) }, ["prompt"]),
    outputSchema: objectSchema({ result: string("Replace this schema with the fields your app needs") }, ["result"]), config: { model: "gpt-5.4-mini", max_output_tokens: 2000,
      usd_per_million_input: 0.75, usd_per_million_cached_input: 0.075, usd_per_million_output: 4.5, usd_to_gbp: 0.8 } },
  { id: "ai_image", name: "AI image generation", category: "AI", provider: "openai", operation: "image", modes: ["managed","byok"], maxCredits: 4,
    description: "Generate a premium image and persist it in the app's private storage.",
    inputSchema: objectSchema({ prompt: string("Image prompt", 8000) }, ["prompt"]), outputSchema: objectSchema({ path: string("Stored image path") }, ["path"]), config: { model: "gpt-5.4" } },
  { id: "replicate_video", name: "AI image-to-video", category: "Media", provider: "replicate", operation: "prediction", modes: ["managed","byok"], maxCredits: 20,
    description: "Run a Replicate video model asynchronously with progress, cancellation, and persistent output.",
    inputSchema: objectSchema({ prompt: string("Video direction", 8000), image: string("Runtime Storage image path") }, ["prompt"]),
    outputSchema: objectSchema({ path: string("Stored MP4 path") }, ["path"]), config: { model: "bytedance/seedance-1-pro", gbp_per_second: 0 } },
  { id: "media_finish", name: "Social video finishing", category: "Media", provider: "media", operation: "compose", modes: ["internal"], maxCredits: 2,
    description: "Join clips, add captions, branding and music, then export a polished social MP4.",
    inputSchema: objectSchema({ clips: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 }, aspect: { type: "string", enum: ["9:16","1:1","16:9"] },
      caption: string("Optional burned-in caption", 2000), logo: string("Optional stored logo path"), music: string("Optional stored music path") }, ["clips"]),
    outputSchema: objectSchema({ path: string("Stored MP4 path"), aspect: string("Output aspect ratio") }, ["path"]), config: { credit_charge: 1.5 } },
  { id: "image_convert", name: "Image optimisation", category: "Media", provider: "media", operation: "image_convert", modes: ["internal"], maxCredits: 0.25,
    description: "Resize and compress uploaded images into fast WebP assets.",
    inputSchema: objectSchema({ path: string("Runtime Storage image path"), width: { type: "integer" } }, ["path"]),
    outputSchema: objectSchema({ path: string("Stored WebP path") }, ["path"]), config: { credit_charge: 0.1 } },
  { id: "pdf_extract", name: "PDF text extraction", category: "Documents", provider: "document", operation: "pdf_extract", modes: ["internal"], maxCredits: 0.25,
    description: "Extract searchable text from an uploaded PDF without sending it to another provider.",
    inputSchema: objectSchema({ path: string("Runtime Storage PDF path") }, ["path"]),
    outputSchema: objectSchema({ text: string("Extracted text", 500000), truncated: { type: "boolean" } }, ["text"]), config: { credit_charge: 0.1 } },
  { id: "pdf_merge", name: "PDF merge", category: "Documents", provider: "document", operation: "pdf_merge", modes: ["internal"], maxCredits: 0.5,
    description: "Merge up to twenty uploaded PDFs into one private stored document.",
    inputSchema: objectSchema({ paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 } }, ["paths"]),
    outputSchema: objectSchema({ path: string("Merged PDF path") }, ["path"]), config: { credit_charge: 0.25 } },
  { id: "archive", name: "ZIP archive", category: "Documents", provider: "document", operation: "archive", modes: ["internal"], maxCredits: 0.25,
    description: "Bundle uploaded files into a downloadable ZIP archive.",
    inputSchema: objectSchema({ paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 } }, ["paths"]),
    outputSchema: objectSchema({ path: string("ZIP archive path") }, ["path"]), config: { credit_charge: 0.1 } },
  { id: "meta_accounts", name: "Meta account choices", category: "Social", provider: "meta", operation: "accounts", modes: ["internal"], maxCredits: 0,
    description: "List the Facebook Pages and Meta ad accounts available to the connected app user.",
    inputSchema: objectSchema({}), outputSchema: objectSchema({ pages: { type: "array" }, adAccounts: { type: "array" }, selectedPageId: string("Selected Page ID", 80), selectedAdAccountId: string("Selected ad account ID", 80) }), config: { credit_charge: 0 } },
  { id: "meta_page_post", name: "Facebook Page publishing", category: "Social", provider: "meta", operation: "page_post", modes: ["internal"], maxCredits: 0,
    description: "Publish text, a link or an uploaded static image to a Facebook Page now or schedule it with Meta.",
    inputSchema: objectSchema({ path: string("Optional Runtime Storage image path", 500), pageId: string("Optional connected Facebook Page ID", 80),
      message: string("Post text or image caption", 5000), destinationUrl: string("Optional public HTTPS link", 2000), publishAt: string("Optional ISO date at least twenty minutes ahead", 80) }),
    outputSchema: objectSchema({ postId: string("Facebook post ID", 160), photoId: string("Facebook photo ID", 160), status: string("published or scheduled", 40), scheduledFor: string("Scheduled ISO date", 80) }), config: { credit_charge: 0 } },
  { id: "meta_create_ad", name: "Meta paid-ad publishing", category: "Social", provider: "meta", operation: "create_ad", modes: ["internal"], maxCredits: 0,
    description: "Create a static-image Meta campaign, ad set, creative and ad, paused by default or scheduled after explicit confirmation.",
    inputSchema: objectSchema({ path: string("Runtime Storage image path"), adAccountId: string("Optional connected Meta ad account ID", 80),
      pageId: string("Optional connected Facebook Page ID", 80), name: string("Campaign and ad name", 120), message: string("Primary ad text", 5000),
      headline: string("Ad headline", 255), destinationUrl: string("Public HTTPS destination", 2000), dailyBudgetMinor: { type: "integer" },
      countries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 25 }, ageMin: { type: "integer" }, ageMax: { type: "integer" },
      callToAction: { type: "string", enum: ["LEARN_MORE","SHOP_NOW","SIGN_UP","BOOK_TRAVEL","CONTACT_US","GET_QUOTE"] },
      specialAdCategories: { type: "array", items: { type: "string" }, maxItems: 4 }, startAt: string("Optional ISO start time", 80),
      endAt: string("Optional ISO end time", 80), confirmed: { type: "boolean" } },
      ["path","name","message","headline","destinationUrl","dailyBudgetMinor","countries","confirmed"]),
    outputSchema: objectSchema({ campaignId: string("Meta campaign ID", 160), adSetId: string("Meta ad set ID", 160), creativeId: string("Meta creative ID", 160),
      adId: string("Meta ad ID", 160), status: string("PAUSED or ACTIVE", 20), scheduledFor: string("Scheduled ISO date", 80) }), config: { credit_charge: 0 } },
  { id: "knowledge_ingest", name: "Knowledge ingestion", category: "Knowledge", provider: "knowledge", operation: "ingest", modes: ["managed","byok"], maxCredits: 2,
    description: "Chunk and embed documents into an app-isolated knowledge base.",
    inputSchema: objectSchema({ knowledgeBaseKey: string("Knowledge base key", 80), name: string("Document name", 200), text: string("Document text", 500000) }, ["knowledgeBaseKey","text"]),
    outputSchema: objectSchema({ documentId: string("Document id"), chunks: { type: "integer" } }, ["documentId"]), config: { model: "text-embedding-3-small" } },
  { id: "knowledge_search", name: "Knowledge search", category: "Knowledge", provider: "knowledge", operation: "search", modes: ["managed","byok"], maxCredits: 0.25,
    description: "Semantically retrieve private project material for assistants and support apps.",
    inputSchema: objectSchema({ knowledgeBaseKey: string("Knowledge base key", 80), query: string("Search query", 8000), limit: { type: "integer" } }, ["knowledgeBaseKey","query"]),
    outputSchema: objectSchema({ matches: { type: "array" } }, ["matches"]), config: { model: "text-embedding-3-small" } },
  { id: "safe_http", name: "Safe HTTPS API", category: "Automation", provider: "http", operation: "request", modes: ["byok"], maxCredits: 0,
    description: "Call a configured public REST API without exposing its credential to generated code.",
    inputSchema: objectSchema({ payload: { type: "object" } }), outputSchema: { type: "object" }, config: { method: "POST", path: "/" } },
]);

const preset = (id) => CAPABILITY_PRESETS.find((item) => item.id === id);
const keyPattern = /^[a-z][a-z0-9_.-]{1,79}$/;

async function configuredSecrets(owner, projectId, client) {
  return {
    openai: !!(await getProjectSecret(owner, projectId, "live", "RUNTIME_OPENAI_API_KEY", client)),
    replicate: !!(await getProjectSecret(owner, projectId, "live", "RUNTIME_REPLICATE_API_TOKEN", client)),
    http: !!(await getProjectSecret(owner, projectId, "live", "RUNTIME_HTTP_TOKEN", client)),
    managedOpenAI: !!(optionalEnv("RUNTIME_OPENAI_API_KEY") || optionalEnv("OPENAI_API_KEY")),
    managedReplicate: !!optionalEnv("RUNTIME_REPLICATE_API_TOKEN"),
  };
}

export async function capabilityOverview(owner, projectId, client = serviceClient()) {
  await requireFeature(owner, "capability_runtime");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const [{ data: actions, error }, { data: jobs }, { data: bases }, { data: schedules }] = await Promise.all([
    client.from("project_actions").select("id,key,name,description,provider,operation,execution_mode,input_schema,output_schema,config,end_user_unit_cost,free_allowance,rate_limit_per_hour,timeout_seconds,enabled,created_at,updated_at")
      .eq("owner", owner.id).eq("project_id", projectId).order("created_at"),
    client.from("app_jobs").select("id,action_key,status,progress,error,runtime_credits_charged,created_at,finished_at")
      .eq("owner", owner.id).eq("project_id", projectId).order("created_at", { ascending: false }).limit(20),
    client.from("knowledge_bases").select("id,key,name,config,created_at,updated_at").eq("owner", owner.id).eq("project_id", projectId).order("created_at"),
    client.from("action_schedules").select("id,action_id,name,schedule,timezone,input,enabled,next_run_at,last_run_at,last_error")
      .eq("owner", owner.id).eq("project_id", projectId).order("created_at"),
  ]);
  if (error) throw new Error(`capability actions: ${error.message}`);
  return { presets: CAPABILITY_PRESETS, actions: actions || [], jobs: jobs || [], knowledgeBases: bases || [], schedules: schedules || [],
    credentials: await configuredSecrets(owner.id, projectId, client) };
}

function cleanSchema(value, fallback) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const raw = JSON.stringify(value);
  if (raw.length > 30_000) throw Object.assign(new Error("Action schema is too large."), { code: "bad_capability" });
  return value;
}

export async function saveCapability(owner, projectId, input, client = serviceClient()) {
  await requireFeature(owner, "capability_runtime");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const definition = preset(String(input.presetId || ""));
  if (!definition) throw Object.assign(new Error("Choose a supported capability preset."), { code: "bad_capability" });
  const key = String(input.key || definition.id).trim().toLowerCase();
  const name = String(input.name || definition.name).trim().slice(0, 120);
  const mode = String(input.executionMode || definition.modes[0]);
  if (!keyPattern.test(key)) throw Object.assign(new Error("Action key must start with a letter and use letters, numbers, dots, dashes, or underscores."), { code: "bad_capability" });
  if (!definition.modes.includes(mode)) throw Object.assign(new Error("That execution mode is not available for this capability."), { code: "bad_capability" });
  const config = { ...definition.config, ...(input.config && typeof input.config === "object" ? input.config : {}), max_credits: definition.maxCredits };
  if (definition.provider === "http") {
    let url;
    try { url = new URL(String(config.base_url || "")); } catch { url = null; }
    if (!url || url.protocol !== "https:" || !(await safeBrowserUrl(url.href, "https://invalid.local"))) {
      throw Object.assign(new Error("Generic API actions require a public HTTPS base URL."), { code: "bad_capability" });
    }
    config.base_url = url.origin;
    config.method = ["GET","POST","PUT","PATCH","DELETE"].includes(String(config.method).toUpperCase()) ? String(config.method).toUpperCase() : "POST";
    config.path = String(config.path || "/").startsWith("/") ? String(config.path).slice(0, 500) : "/";
    delete config.headers?.authorization; delete config.headers?.Authorization;
  }
  const credential = String(input.credential || "").trim();
  if (credential) {
    const secretName = definition.provider === "openai" || definition.provider === "knowledge" ? "RUNTIME_OPENAI_API_KEY"
      : definition.provider === "replicate" ? "RUNTIME_REPLICATE_API_TOKEN" : definition.provider === "http" ? "RUNTIME_HTTP_TOKEN" : null;
    if (secretName) await setProjectSecret(owner.id, projectId, "live", secretName, credential, client);
  }
  const row = { project_id: projectId, owner: owner.id, environment: "live", key, name,
    description: String(input.description || definition.description).slice(0, 1000), provider: definition.provider,
    operation: definition.operation, execution_mode: mode,
    input_schema: cleanSchema(input.inputSchema, definition.inputSchema), output_schema: cleanSchema(input.outputSchema, definition.outputSchema), config,
    end_user_unit_cost: Math.max(0, Math.min(1_000_000, Number(input.endUserUnitCost || 0))),
    free_allowance: Math.max(0, Math.min(1_000_000, Number(input.freeAllowance || 0))),
    rate_limit_per_hour: Math.max(1, Math.min(1000, Number(input.rateLimitPerHour || 20))),
    timeout_seconds: Math.max(5, Math.min(3600, Number(input.timeoutSeconds || 300))), enabled: input.enabled !== false,
    updated_at: new Date().toISOString() };
  const query = client.from("project_actions");
  const { data, error } = input.id
    ? await query.update(row).eq("id", input.id).eq("owner", owner.id).eq("project_id", projectId).select().maybeSingle()
    : await query.upsert(row, { onConflict: "project_id,environment,key" }).select().single();
  if (error) throw new Error(`capability save: ${error.message}`);
  await auditEvent({ owner: owner.id, projectId, action: "capability.saved", target: data?.id, metadata: { key, provider: definition.provider, mode } }, client).catch(() => {});
  return data;
}

export async function deleteCapability(owner, projectId, actionId, client = serviceClient()) {
  await requireFeature(owner, "capability_runtime");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const { data, error } = await client.from("project_actions").delete().eq("id", actionId).eq("owner", owner.id).eq("project_id", projectId).select("id").maybeSingle();
  if (error) throw new Error(`capability delete: ${error.message}`);
  return { deleted: !!data };
}

export async function saveKnowledgeBase(owner, projectId, input, client = serviceClient()) {
  await requireFeature(owner, "capability_runtime");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const key = String(input.key || "").trim().toLowerCase(); const name = String(input.name || "").trim();
  if (!keyPattern.test(key) || !name || name.length > 120) throw Object.assign(new Error("Enter a valid knowledge-base key and name."), { code: "bad_capability" });
  const { data, error } = await client.from("knowledge_bases").upsert({ owner: owner.id, project_id: projectId, key, name,
    config: {}, updated_at: new Date().toISOString() }, { onConflict: "project_id,key" }).select().single();
  if (error) throw new Error(`knowledge base save: ${error.message}`);
  return data;
}

export async function saveActionSchedule(owner, projectId, input, client = serviceClient()) {
  await requireFeature(owner, "capability_runtime");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const interval = Math.max(5, Math.min(43_200, Number(input.intervalMinutes || 60)));
  const { data: action } = await client.from("project_actions").select("id").eq("id", input.actionId).eq("owner", owner.id).eq("project_id", projectId).maybeSingle();
  if (!action) throw Object.assign(new Error("Choose a valid project action."), { code: "bad_capability" });
  const row = { owner: owner.id, project_id: projectId, action_id: action.id, name: String(input.name || "Scheduled action").slice(0,120),
    schedule: String(interval), timezone: "UTC", input: input.input && typeof input.input === "object" ? input.input : {}, enabled: input.enabled !== false,
    next_run_at: new Date(Date.now() + interval * 60_000).toISOString(), updated_at: new Date().toISOString() };
  const { data, error } = input.id ? await client.from("action_schedules").update(row).eq("id", input.id).eq("owner",owner.id).select().single()
    : await client.from("action_schedules").insert(row).select().single();
  if (error) throw new Error(`schedule save: ${error.message}`);
  return data;
}

export async function clearRuntimeCredential(owner, projectId, provider, client = serviceClient()) {
  await requireFeature(owner, "capability_runtime");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const name = provider === "openai" ? "RUNTIME_OPENAI_API_KEY" : provider === "replicate" ? "RUNTIME_REPLICATE_API_TOKEN" : provider === "http" ? "RUNTIME_HTTP_TOKEN" : null;
  if (!name) throw Object.assign(new Error("Unknown credential provider."), { code: "bad_capability" });
  await deleteProjectSecret(owner.id, projectId, "live", name, client);
  return { deleted: true };
}
