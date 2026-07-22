import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { optionalEnv } from "./env.mjs";
import { getProjectSecret } from "./projectSecrets.mjs";
import { serviceClient } from "./supabase.mjs";
import { metaJson, metaPageToken, metaRuntimeConnection } from "./metaConnector.mjs";
import { trueCostPerCredit } from "../../../src/billing/costModel.mjs";

const MAX_HTTP_BYTES = 1_000_000;
const MAX_ASSET_BYTES = 500 * 1024 * 1024;
const MANAGED_MARGIN = 1.1;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./];

function isPrivateAddress(address) {
  const value = String(address || "").toLowerCase();
  if (value === "::1" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd")) return true;
  return PRIVATE_V4.some((pattern) => pattern.test(value));
}

function cleanError(error) {
  const message = String(error?.message || error || "Runtime action failed")
    .replace(/(?:sk-|r8_)[a-zA-Z0-9_-]{12,}/g, "[redacted]");
  return message.slice(0, 500);
}

function outputText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  return (response?.output || []).flatMap((item) => item?.content || [])
    .filter((item) => item?.type === "output_text").map((item) => item.text).join("\n");
}

export function openAiCostGbp(usage, config = {}) {
  if (!usage) return 0;
  const input = Math.max(0, Number(usage.input_tokens || usage.prompt_tokens || 0));
  const cached = Math.min(input, Math.max(0, Number(usage.input_tokens_details?.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0)));
  const output = Math.max(0, Number(usage.output_tokens || usage.completion_tokens || 0));
  const inputUsd = Number(config.usd_per_million_input ?? 0.75);
  const cachedUsd = Number(config.usd_per_million_cached_input ?? 0.075);
  const outputUsd = Number(config.usd_per_million_output ?? 4.5);
  const usdToGbp = Number(config.usd_to_gbp ?? 0.8);
  return (((input - cached) * inputUsd + cached * cachedUsd + output * outputUsd) / 1_000_000) * usdToGbp;
}

function mapped(object, mapping) {
  if (!mapping || typeof mapping !== "object") return object;
  const result = {};
  for (const [target, source] of Object.entries(mapping)) {
    const parts = String(source).split(".");
    let value = object;
    for (const part of parts) value = value?.[part];
    result[target] = value;
  }
  return result;
}

async function publicHttps(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return null;
  const rows = await lookup(host, { all: true }).catch(() => []);
  if (!rows.length || rows.some((row) => isPrivateAddress(row.address))) return null;
  return url;
}

export async function safeRuntimeFetch(rawUrl, init = {}, { maxBytes = MAX_HTTP_BYTES, redirects = 3 } = {}) {
  let url = await publicHttps(rawUrl);
  if (!url) throw new Error("The configured API URL is not a public HTTPS address.");
  for (let hop = 0; hop <= redirects; hop += 1) {
    const response = await fetch(url, { ...init, redirect: "manual", signal: init.signal || AbortSignal.timeout(30_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === redirects) throw new Error("The API redirected too many times.");
      const location = response.headers.get("location");
      url = location ? await publicHttps(new URL(location, url).href) : null;
      if (!url) throw new Error("The API redirected to an unsafe address.");
      continue;
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) throw new Error("The API response is too large.");
    return response;
  }
  throw new Error("The API request could not be completed.");
}

async function secretFor(action, client) {
  const name = action.execution_mode === "managed"
    ? null
    : action.provider === "openai" ? "RUNTIME_OPENAI_API_KEY"
      : action.provider === "replicate" ? "RUNTIME_REPLICATE_API_TOKEN"
        : action.provider === "http" ? "RUNTIME_HTTP_TOKEN" : null;
  if (action.execution_mode === "managed") {
    if (action.provider === "openai") return optionalEnv("RUNTIME_OPENAI_API_KEY") || optionalEnv("OPENAI_API_KEY");
    if (action.provider === "replicate") return optionalEnv("RUNTIME_REPLICATE_API_TOKEN");
    return null;
  }
  return name ? getProjectSecret(action.owner, action.project_id, action.environment, name, client) : null;
}

async function uploadBytes(client, job, bytes, extension, contentType) {
  const actor = job.app_user_id || job.owner;
  const key = `${job.project_id}/${actor}/${job.id}/${crypto.randomUUID()}.${extension}`;
  const { error } = await client.storage.from("runtime-assets").upload(key, bytes, { contentType, upsert: false });
  if (error) throw new Error(`Runtime output could not be stored: ${error.message}`);
  return key;
}

async function persistExternalFile(client, job, rawUrl) {
  const response = await safeRuntimeFetch(rawUrl, {}, { maxBytes: MAX_ASSET_BYTES });
  if (!response.ok) throw new Error(`Provider output download failed (${response.status}).`);
  const type = String(response.headers.get("content-type") || "application/octet-stream").split(";")[0];
  const extension = type === "video/mp4" ? "mp4" : type === "image/png" ? "png" : type === "image/webp" ? "webp"
    : type === "image/jpeg" ? "jpg" : type === "audio/mpeg" ? "mp3" : "bin";
  return uploadBytes(client, job, new Uint8Array(await response.arrayBuffer()), extension, type);
}

async function runOpenAI(action, job, client) {
  const key = await secretFor(action, client);
  if (!key) throw new Error(action.execution_mode === "managed" ? "Managed OpenAI is not configured." : "Add an OpenAI runtime key in Capabilities.");
  const config = action.config || {};
  if (action.operation === "embeddings") {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST", signal: AbortSignal.timeout(action.timeout_seconds * 1000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model || "text-embedding-3-small", input: job.input.text || job.input.input }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `OpenAI embeddings failed (${response.status}).`);
    const providerCostGbp = openAiCostGbp(data.usage, { usd_per_million_input: 0.02, usd_per_million_cached_input: 0.02,
      usd_per_million_output: 0, usd_to_gbp: config.usd_to_gbp ?? 0.8 });
    return { output: { embedding: data.data?.[0]?.embedding || [], usage: data.usage || null }, usage: data.usage || null, providerCostGbp };
  }
  const content = [];
  const prompt = job.input.prompt || job.input.text || config.prompt || "";
  if (prompt) content.push({ type: "input_text", text: String(prompt) });
  for (const image of Array.isArray(job.input.images) ? job.input.images.slice(0, 10) : []) {
    const { data } = await client.storage.from("runtime-assets").createSignedUrl(String(image), 300);
    if (data?.signedUrl) content.push({ type: "input_image", image_url: data.signedUrl, detail: config.image_detail || "auto" });
  }
  const body = {
    model: config.model || "gpt-5.4-mini", store: false,
    instructions: config.instructions || undefined,
    input: content.length ? [{ role: "user", content }] : String(prompt),
    max_output_tokens: Math.min(16_000, Number(config.max_output_tokens || 2000)),
  };
  if (action.operation === "image") body.tools = [{ type: "image_generation" }];
  if (action.operation === "structured" && action.output_schema?.type === "object") {
    body.text = { format: { type: "json_schema", name: "action_output", strict: true, schema: action.output_schema } };
  }
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST", signal: AbortSignal.timeout(action.timeout_seconds * 1000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI response failed (${response.status}).`);
  if (action.operation === "image") {
    const encoded = (data.output || []).find((item) => item.type === "image_generation_call")?.result;
    if (!encoded) throw new Error("OpenAI returned no generated image.");
    const storagePath = await uploadBytes(client, job, Buffer.from(encoded, "base64"), "png", "image/png");
    return { output: { path: storagePath, usage: data.usage || null }, usage: data.usage || null };
  }
  const value = outputText(data);
  let result = value;
  if (action.operation === "structured") {
    try { result = JSON.parse(value); } catch { throw new Error("OpenAI returned an invalid structured result."); }
  }
  const providerCostGbp = openAiCostGbp(data.usage, config);
  return { output: action.operation === "structured" ? result : { result, usage: data.usage || null }, usage: data.usage || null, providerCostGbp };
}

async function runReplicate(action, job, client) {
  const token = await secretFor(action, client);
  if (!token) throw new Error(action.execution_mode === "managed" ? "Managed Replicate is not configured." : "Add a Replicate runtime token in Capabilities.");
  const model = String(action.config?.model || "");
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(model)) throw new Error("Choose a valid Replicate model preset.");
  const inputs = { ...(action.config?.input_defaults || {}), ...job.input };
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value === "string" && value.startsWith(`${job.project_id}/`)) {
      const { data } = await client.storage.from("runtime-assets").createSignedUrl(value, 600);
      if (data?.signedUrl) inputs[key] = data.signedUrl;
    }
  }
  const publicUrl = optionalEnv("PUBLIC_URL", optionalEnv("APP_URL", "https://buildr101.com")).replace(/\/$/, "");
  const response = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: "POST", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Cancel-After": `${action.timeout_seconds}s` },
    body: JSON.stringify({ input: inputs, webhook: `${publicUrl}/api/runtime/webhooks/replicate?job=${job.id}`, webhook_events_filter: ["completed"] }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.detail || data?.title || `Replicate prediction failed (${response.status}).`);
  return { waiting: true, providerJobId: data.id, output: { provider_status: data.status, provider_url: data.urls?.web || null } };
}

async function runHttp(action, job, client) {
  const config = action.config || {};
  const base = new URL(String(config.base_url || ""));
  const endpoint = String(config.path || "/").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => encodeURIComponent(String(job.input[key] ?? "")));
  const url = new URL(endpoint, base);
  const token = await secretFor(action, client);
  const headers = { "Accept": "application/json", "Content-Type": "application/json", ...(config.headers || {}) };
  if (token) headers[String(config.auth_header || "Authorization")] = config.auth_scheme === "raw" ? token : `Bearer ${token}`;
  const method = String(config.method || "POST").toUpperCase();
  const response = await safeRuntimeFetch(url.href, {
    method, headers, body: ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(mapped(job.input, config.request_mapping)),
    signal: AbortSignal.timeout(Math.min(action.timeout_seconds, 60) * 1000),
  });
  const raw = await response.text();
  if (raw.length > MAX_HTTP_BYTES) throw new Error("The API response is too large.");
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = { text: raw }; }
  if (!response.ok) throw new Error(`The API returned ${response.status}: ${String(data?.error || data?.message || "request failed").slice(0, 200)}`);
  return { output: mapped(data, config.response_mapping) };
}

async function runProcess(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => { error = `${error}${chunk}`.slice(-8000); });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${command} timed out.`)); }, timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${command} failed: ${error.slice(-500)}`)); });
  });
}

async function downloadStorage(client, storagePath, destination) {
  const { data, error } = await client.storage.from("runtime-assets").download(storagePath);
  if (error || !data) throw new Error(`Input file could not be downloaded: ${error?.message || storagePath}`);
  await writeFile(destination, new Uint8Array(await data.arrayBuffer()));
}

async function runMedia(action, job, client) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "buildr-runtime-"));
  try {
    if (action.operation === "image_convert") {
      const input = path.join(temp, "input"); const output = path.join(temp, "output.webp");
      await downloadStorage(client, job.input.path, input);
      await runProcess("ffmpeg", ["-y", "-i", input, "-vf", `scale='min(${Number(job.input.width || 1920)},iw)':-2`, "-quality", "82", output], action.timeout_seconds * 1000);
      const bytes = await import("node:fs/promises").then((fs) => fs.readFile(output));
      return { output: { path: await uploadBytes(client, job, bytes, "webp", "image/webp") } };
    }
    const clips = Array.isArray(job.input.clips) ? job.input.clips.slice(0, 20) : [];
    if (!clips.length) throw new Error("At least one video clip is required.");
    const local = [];
    for (let index = 0; index < clips.length; index += 1) {
      const file = path.join(temp, `clip-${index}.mp4`); await downloadStorage(client, clips[index], file); local.push(file);
    }
    const listFile = path.join(temp, "clips.txt");
    await writeFile(listFile, local.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"));
    const target = String(job.input.aspect || "9:16");
    const [width, height] = target === "1:1" ? [1080, 1080] : target === "16:9" ? [1920, 1080] : [1080, 1920];
    const baseOutput = path.join(temp, "base.mp4");
    const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    await runProcess("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-vf", filter,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-movflags", "+faststart", baseOutput], action.timeout_seconds * 1000);

    const caption = String(job.input.caption || "").trim().slice(0, 2000);
    const logoPath = typeof job.input.logo === "string" ? job.input.logo : null;
    const musicPath = typeof job.input.music === "string" ? job.input.music : null;
    let output = baseOutput;
    if (caption || logoPath || musicPath) {
      const finalOutput = path.join(temp, "finished.mp4");
      const args = ["-y", "-i", baseOutput];
      let nextInput = 1;
      let logoIndex = null;
      let musicIndex = null;
      if (logoPath) {
        const logo = path.join(temp, "logo"); await downloadStorage(client, logoPath, logo);
        logoIndex = nextInput; nextInput += 1; args.push("-i", logo);
      }
      if (musicPath) {
        const music = path.join(temp, "music"); await downloadStorage(client, musicPath, music);
        musicIndex = nextInput; args.push("-stream_loop", "-1", "-i", music);
      }
      const filters = [];
      let videoLabel = "0:v";
      if (caption) {
        const captionFile = path.join(temp, "caption.txt"); await writeFile(captionFile, caption);
        filters.push(`[${videoLabel}]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile=${captionFile}:fontcolor=white:fontsize=${Math.round(width / 24)}:line_spacing=8:borderw=3:bordercolor=black@0.7:x=(w-text_w)/2:y=h-text_h-${Math.round(height * 0.08)}[captioned]`);
        videoLabel = "captioned";
      }
      if (logoIndex !== null) {
        filters.push(`[${logoIndex}:v]scale=${Math.round(width * 0.18)}:-1[logo];[${videoLabel}][logo]overlay=w-overlay_w-${Math.round(width * 0.04)}:${Math.round(height * 0.04)}[branded]`);
        videoLabel = "branded";
      }
      if (filters.length) args.push("-filter_complex", filters.join(";"), "-map", `[${videoLabel}]`);
      else args.push("-map", "0:v");
      if (musicIndex !== null) args.push("-map", `${musicIndex}:a`, "-shortest");
      else args.push("-map", "0:a?", "-shortest");
      args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-movflags", "+faststart", finalOutput);
      await runProcess("ffmpeg", args, action.timeout_seconds * 1000);
      output = finalOutput;
    }
    const bytes = await readFile(output);
    return { output: { path: await uploadBytes(client, job, bytes, "mp4", "video/mp4"), aspect: target } };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function runDocument(action, job, client) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "buildr-document-"));
  try {
    if (action.operation === "pdf_extract") {
      const input = path.join(temp, "input.pdf"); const output = path.join(temp, "output.txt");
      await downloadStorage(client, job.input.path, input);
      await runProcess("pdftotext", ["-layout", input, output], action.timeout_seconds * 1000);
      const text = (await readFile(output, "utf8")).slice(0, 500_000);
      return { output: { text, truncated: text.length >= 500_000 } };
    }
    const inputs = Array.isArray(job.input.paths) ? job.input.paths.slice(0, action.operation === "archive" ? 50 : 20) : [];
    if (!inputs.length) throw new Error("At least one stored file is required.");
    const files = [];
    for (let index = 0; index < inputs.length; index += 1) {
      const extension = action.operation === "pdf_merge" ? ".pdf" : path.extname(String(inputs[index])).slice(0, 12);
      const file = path.join(temp, `file-${index}${extension}`); await downloadStorage(client, inputs[index], file); files.push(file);
    }
    if (action.operation === "pdf_merge") {
      const output = path.join(temp, "merged.pdf");
      await runProcess("pdfunite", [...files, output], action.timeout_seconds * 1000);
      return { output: { path: await uploadBytes(client, job, await readFile(output), "pdf", "application/pdf") } };
    }
    if (action.operation === "archive") {
      const output = path.join(temp, "archive.zip");
      await runProcess("zip", ["-j", "-q", output, ...files], action.timeout_seconds * 1000);
      return { output: { path: await uploadBytes(client, job, await readFile(output), "zip", "application/zip") } };
    }
    throw new Error(`Unsupported document operation '${action.operation}'.`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

function chunks(text, size = 1200, overlap = 150) {
  const result = [];
  for (let start = 0; start < text.length; start += size - overlap) result.push(text.slice(start, start + size));
  return result.slice(0, 500);
}

async function embedTexts(key, values, model = "text-embedding-3-small") {
  const response = await fetch("https://api.openai.com/v1/embeddings", { method: "POST", signal: AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: values }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || "Embedding request failed.");
  return data.data.map((row) => row.embedding);
}

async function runKnowledge(action, job, client) {
  const key = await secretFor({ ...action, provider: "openai" }, client);
  if (!key) throw new Error("OpenAI embeddings are not configured for this knowledge action.");
  const { data: base } = await client.from("knowledge_bases").select("id").eq("project_id", job.project_id)
    .eq("key", job.input.knowledgeBaseKey || action.config?.knowledge_base_key).maybeSingle();
  if (!base) throw new Error("Knowledge base not found.");
  if (action.operation === "search") {
    const [embedding] = await embedTexts(key, [String(job.input.query || "")]);
    const { data, error } = await client.rpc("match_knowledge_chunks", { p_project: job.project_id, p_base: base.id, p_embedding: embedding, p_limit: Number(job.input.limit || 8) });
    if (error) throw new Error(`Knowledge search failed: ${error.message}`);
    return { output: { matches: data || [] } };
  }
  const value = String(job.input.text || "").trim();
  if (!value) throw new Error("Document text is required.");
  const { data: document, error } = await client.from("knowledge_documents").insert({ knowledge_base_id: base.id,
    project_id: job.project_id, owner: job.owner, name: String(job.input.name || "Document").slice(0, 200), status: "processing" }).select("id").single();
  if (error) throw new Error(`Knowledge document could not be created: ${error.message}`);
  const parts = chunks(value); const embeddings = [];
  for (let index = 0; index < parts.length; index += 50) embeddings.push(...await embedTexts(key, parts.slice(index, index + 50)));
  const rows = parts.map((content, index) => ({ knowledge_base_id: base.id, document_id: document.id, project_id: job.project_id,
    content, metadata: { index }, embedding: embeddings[index] }));
  const inserted = await client.from("knowledge_chunks").insert(rows);
  if (inserted.error) throw new Error(`Knowledge chunks could not be stored: ${inserted.error.message}`);
  await client.from("knowledge_documents").update({ status: "ready", updated_at: new Date().toISOString() }).eq("id", document.id);
  return { output: { documentId: document.id, chunks: rows.length } };
}

function connectedChoice(values, requested, fallback, label) {
  const raw = String(requested || fallback || "");
  const id = label === "ad account" ? raw.replace(/^act_/, "") : raw;
  if (!id || !(values || []).some((item) => String(item.id) === id)) throw new Error(`Choose a connected Meta ${label}.`);
  return id;
}

function publicDestination(value) {
  let url;
  try { url = new URL(String(value || "")); } catch { url = null; }
  if (!url || url.protocol !== "https:" || url.username || url.password) throw new Error("The ad destination must be a public HTTPS URL.");
  return url.href.slice(0, 2000);
}

export function normalizeMetaPublishAt(value, { minimumMinutes = 20, maximumDays = 29 } = {}) {
  if (!value) return null;
  const time = Date.parse(String(value));
  if (!Number.isFinite(time)) throw new Error("Choose a valid publishing date and time.");
  if (time < Date.now() + minimumMinutes * 60_000) throw new Error(`Scheduled publishing must be at least ${minimumMinutes} minutes ahead.`);
  if (time > Date.now() + maximumDays * 86_400_000) throw new Error(`Scheduled publishing cannot be more than ${maximumDays} days ahead.`);
  return new Date(time).toISOString();
}

export function buildMetaTargeting(input) {
  const countries = [...new Set((Array.isArray(input?.countries) ? input.countries : []).map((item) => String(item).trim().toUpperCase()))]
    .filter((item) => /^[A-Z]{2}$/.test(item)).slice(0, 25);
  if (!countries.length) throw new Error("Choose at least one two-letter country code for the Meta audience.");
  const requestedMin = Number(input?.ageMin ?? 18);
  const requestedMax = Number(input?.ageMax ?? 65);
  if (!Number.isFinite(requestedMin) || !Number.isFinite(requestedMax)) throw new Error("Choose a valid Meta audience age range.");
  const ageMin = Math.round(Math.max(18, Math.min(65, requestedMin)));
  const ageMax = Math.round(Math.max(ageMin, Math.min(65, requestedMax)));
  return { geo_locations: { countries }, age_min: ageMin, age_max: ageMax };
}

async function runtimeImage(client, job, storagePath) {
  const value = String(storagePath || "");
  const expected = `${job.project_id}/${job.app_user_id || job.owner}/`;
  if (!value.startsWith(expected)) throw new Error("Choose an image uploaded by this signed-in app account.");
  const { data, error } = await client.storage.from("runtime-assets").download(value);
  if (error || !data) throw new Error(`The Meta image could not be loaded: ${error?.message || "missing file"}`);
  if (data.size > 30 * 1024 * 1024) throw new Error("Meta static images must be smaller than 30 MB.");
  return data;
}

function formBody(values) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== "") {
    body.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return body;
}

async function runMeta(action, job, client) {
  const connection = await metaRuntimeConnection(job, client);
  const config = connection.config || {};
  if (action.operation === "accounts") return { output: { pages: config.pages || [], adAccounts: config.ad_accounts || [],
    selectedPageId: config.selected_page_id || null, selectedAdAccountId: config.selected_ad_account_id || null } };
  const pageId = connectedChoice(config.pages, job.input.pageId, config.selected_page_id, "Page");
  if (action.operation === "page_post") {
    const page = await metaPageToken(connection.token, pageId);
    const publishAt = normalizeMetaPublishAt(job.input.publishAt);
    let message = String(job.input.message || "").trim().slice(0, 5000);
    if (job.input.destinationUrl) message = `${message}${message ? "\n\n" : ""}${publicDestination(job.input.destinationUrl)}`;
    if (!job.input.path && !message) throw new Error("Add post text, a destination link or an image before publishing.");
    let body;
    let endpoint;
    if (job.input.path) {
      const image = await runtimeImage(client, job, job.input.path);
      body = new FormData();
      body.set("source", image, "facebook-post");
      body.set("message", message);
      endpoint = `${pageId}/photos`;
    } else {
      body = formBody({ message });
      endpoint = `${pageId}/feed`;
    }
    if (publishAt) { body.set("published", "false"); body.set("scheduled_publish_time", String(Math.floor(Date.parse(publishAt) / 1000))); }
    const result = await metaJson(endpoint, { token: page.token, method: "POST", body, timeout: 60_000 });
    return { output: { postId: String(result.post_id || result.id || ""), photoId: job.input.path ? String(result.id || "") : "",
      status: publishAt ? "scheduled" : "published", scheduledFor: publishAt } };
  }
  if (action.operation !== "create_ad") throw new Error(`Unsupported Meta operation '${action.operation}'.`);
  const adAccountId = connectedChoice(config.ad_accounts, job.input.adAccountId, config.selected_ad_account_id, "ad account");
  const destinationUrl = publicDestination(job.input.destinationUrl);
  const dailyBudget = Math.floor(Number(job.input.dailyBudgetMinor || 0));
  if (!Number.isInteger(dailyBudget) || dailyBudget < 100) throw new Error("Enter a daily ad budget of at least 100 in the ad account's smallest currency unit.");
  const targeting = buildMetaTargeting(job.input);
  const confirmed = job.input.confirmed === true;
  const startAt = job.input.startAt ? normalizeMetaPublishAt(job.input.startAt, { minimumMinutes: 10, maximumDays: 365 }) : null;
  const endAt = job.input.endAt ? new Date(job.input.endAt) : null;
  if (endAt && (!Number.isFinite(endAt.getTime()) || endAt.getTime() <= Date.parse(startAt || new Date().toISOString()))) throw new Error("The Meta ad end time must be after its start time.");
  // Stage the entire campaign paused. Only activate after every object exists, so a
  // rejected creative or ad can never leave a partially-created campaign spending.
  const status = "PAUSED";
  const special = (job.input.specialAdCategories || []).map((item) => String(item).trim().toUpperCase()).filter((item) => /^[A-Z_]{2,50}$/.test(item)).slice(0, 4);
  const image = await runtimeImage(client, job, job.input.path);
  const upload = new FormData(); upload.set("filename", image, "static-ad");
  const uploaded = await metaJson(`act_${adAccountId}/adimages`, { token: connection.token, method: "POST", body: upload, timeout: 60_000 });
  const imageHash = Object.values(uploaded.images || {})[0]?.hash;
  if (!imageHash) throw new Error("Meta accepted the image but did not return an image hash.");
  const name = String(job.input.name || "Static ad").trim().slice(0, 120);
  const campaign = await metaJson(`act_${adAccountId}/campaigns`, { token: connection.token, method: "POST", body: formBody({
    name, objective: "OUTCOME_TRAFFIC", special_ad_categories: special, status,
  }) });
  const adSet = await metaJson(`act_${adAccountId}/adsets`, { token: connection.token, method: "POST", body: formBody({
    name: `${name} audience`, campaign_id: campaign.id, daily_budget: dailyBudget, billing_event: "IMPRESSIONS",
    optimization_goal: "LINK_CLICKS", bid_strategy: "LOWEST_COST_WITHOUT_CAP", destination_type: "WEBSITE",
    targeting, status, start_time: startAt, end_time: endAt?.toISOString(),
  }) });
  const creative = await metaJson(`act_${adAccountId}/adcreatives`, { token: connection.token, method: "POST", body: formBody({
    name: `${name} creative`, object_story_spec: { page_id: pageId, link_data: { image_hash: imageHash, link: destinationUrl,
      message: String(job.input.message || "").slice(0, 5000), name: String(job.input.headline || "").slice(0, 255),
      call_to_action: { type: job.input.callToAction || "LEARN_MORE", value: { link: destinationUrl } } } },
  }) });
  const ad = await metaJson(`act_${adAccountId}/ads`, { token: connection.token, method: "POST", body: formBody({
    name, adset_id: adSet.id, creative: { creative_id: creative.id }, status,
  }) });
  if (confirmed) {
    await metaJson(campaign.id, { token: connection.token, method: "POST", body: formBody({ status: "ACTIVE" }) });
    await metaJson(adSet.id, { token: connection.token, method: "POST", body: formBody({ status: "ACTIVE" }) });
    await metaJson(ad.id, { token: connection.token, method: "POST", body: formBody({ status: "ACTIVE" }) });
  }
  return { output: { campaignId: String(campaign.id), adSetId: String(adSet.id), creativeId: String(creative.id),
    adId: String(ad.id), status: confirmed ? "ACTIVE" : "PAUSED", scheduledFor: startAt } };
}

async function execute(action, job, client) {
  if (action.provider === "openai") return runOpenAI(action, job, client);
  if (action.provider === "replicate") return runReplicate(action, job, client);
  if (action.provider === "http") return runHttp(action, job, client);
  if (action.provider === "media") return runMedia(action, job, client);
  if (action.provider === "document") return runDocument(action, job, client);
  if (action.provider === "knowledge") return runKnowledge(action, job, client);
  if (action.provider === "meta") return runMeta(action, job, client);
  throw new Error(`Unsupported runtime provider '${action.provider}'.`);
}

function chargeFor(action, result) {
  if (action.execution_mode === "byok") return { credits: 0, providerCostGbp: 0 };
  const maximum = Math.max(0, Number(action.config?.max_credits || 0));
  const providerCost = Math.max(0, Number(result.providerCostGbp || 0));
  const exact = providerCost > 0 ? providerCost / Math.max(0.0001, trueCostPerCredit()) * MANAGED_MARGIN
    : Math.max(0, Number(action.config?.credit_charge ?? maximum));
  return { credits: Math.min(maximum, Math.round(exact * 10_000) / 10_000), providerCostGbp: providerCost };
}

async function finishJob(client, job, action, result) {
  if (result.waiting) {
    await client.from("app_jobs").update({ status: "waiting_provider", progress: 15, provider_job_id: result.providerJobId,
      output: result.output || null, updated_at: new Date().toISOString() }).eq("id", job.id);
    return { waiting: true };
  }
  const cost = chargeFor(action, result);
  await client.rpc("settle_runtime_credits", { p_job: job.id, p_charge: cost.credits, p_provider_cost_gbp: cost.providerCostGbp });
  await client.from("app_jobs").update({ status: "succeeded", progress: 100, output: result.output || {}, error: null,
    finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
  return result.output || {};
}

async function failJob(client, job, error, { providerStarted = false, cancelled = false } = {}) {
  const charge = providerStarted ? Number(job.runtime_credits_reserved || 0) : 0;
  if (Number(job.runtime_credits_reserved || 0) > 0) await client.rpc("settle_runtime_credits", { p_job: job.id, p_charge: charge, p_provider_cost_gbp: 0 });
  await client.rpc("refund_app_units", { p_job: job.id });
  await client.from("app_jobs").update({ status: cancelled ? "cancelled" : "failed", error_code: cancelled ? "cancelled" : "runtime_failed", error: cleanError(error),
    finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
}

export async function processRuntimeTask(task, client = serviceClient()) {
  const { data: job } = await client.from("app_jobs").select("*").eq("id", task.input.job_id).maybeSingle();
  if (!job || TERMINAL.has(job.status)) return { skipped: true };
  if (job.cancel_requested_at) { await failJob(client, job, new Error("Cancelled"), { cancelled: true }); return { cancelled: true }; }
  const { data: action } = await client.from("project_actions").select("*").eq("id", job.action_id).maybeSingle();
  if (!action?.enabled) { await failJob(client, job, new Error("This action is disabled.")); return { failed: true }; }
  await client.from("app_jobs").update({ status: "running", progress: 5, started_at: job.started_at || new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", job.id);
  try { return await finishJob(client, job, action, await execute(action, job, client)); }
  catch (error) { await failJob(client, job, error); throw error; }
}

export async function pollProviderJobs(client = serviceClient()) {
  const { data: jobs } = await client.from("app_jobs").select("*,project_actions!inner(*)")
    .eq("status", "waiting_provider").eq("project_actions.provider", "replicate").limit(10);
  for (const job of jobs || []) {
    const action = job.project_actions; const token = await secretFor(action, client);
    if (!token) { await failJob(client, job, new Error("Replicate credential is unavailable."), { providerStarted: true }); continue; }
    if (job.cancel_requested_at) await fetch(`https://api.replicate.com/v1/predictions/${job.provider_job_id}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    const response = await fetch(`https://api.replicate.com/v1/predictions/${job.provider_job_id}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const data = await response?.json().catch(() => null);
    if (!response?.ok || !data) continue;
    if (["starting", "processing"].includes(data.status)) { await client.from("app_jobs").update({ progress: data.status === "processing" ? 45 : 20, updated_at: new Date().toISOString() }).eq("id", job.id); continue; }
    if (data.status === "succeeded") {
      const urls = (Array.isArray(data.output) ? data.output : [data.output]).filter((value) => typeof value === "string" && value.startsWith("https://"));
      const paths = [];
      for (const url of urls.slice(0, 10)) paths.push(await persistExternalFile(client, job, url));
      const seconds = Number(data.metrics?.predict_time || 0);
      const providerCostGbp = seconds * Math.max(0, Number(action.config?.gbp_per_second || 0));
      await finishJob(client, job, action, { output: { paths, path: paths[0] || null, provider_status: data.status, metrics: data.metrics || null }, providerCostGbp });
    } else await failJob(client, job, new Error(data.error || `Replicate prediction ${data.status}.`), { providerStarted: true, cancelled: !!job.cancel_requested_at || data.status === "canceled" });
  }
}

export async function enqueueDueSchedules(client = serviceClient()) {
  const now = new Date();
  const { data: schedules } = await client.from("action_schedules").select("*,project_actions(*)")
    .eq("enabled", true).lte("next_run_at", now.toISOString()).limit(20);
  for (const schedule of schedules || []) {
    const action = schedule.project_actions;
    const key = `schedule:${schedule.id}:${schedule.next_run_at}`;
    const { data: job, error } = await client.from("app_jobs").insert({ project_id: schedule.project_id, owner: schedule.owner,
      app_user_id: null, action_id: action.id, action_key: action.key, input: schedule.input, idempotency_key: key }).select("id").single();
    if (!error && job) {
      const maximum = action.execution_mode === "byok" ? 0 : Math.max(0, Number(action.config?.max_credits || 0));
      const reserved = await client.rpc("reserve_runtime_credits", { p_owner: schedule.owner, p_job: job.id, p_amount: maximum,
        p_provider: action.provider, p_mode: action.execution_mode });
      if (reserved.data?.ok) {
        const queued = await client.from("background_tasks").insert({ owner: schedule.owner, project_id: schedule.project_id, type: "runtime_job", input: { job_id: job.id } });
        if (queued.error) {
          await client.rpc("settle_runtime_credits", { p_job: job.id, p_charge: 0, p_provider_cost_gbp: 0 });
          await client.from("app_jobs").update({ status: "failed", error_code: "queue_failed", error: "Scheduled job could not be queued.", finished_at: now.toISOString() }).eq("id", job.id);
        }
      } else await client.from("app_jobs").update({ status: "failed", error_code: "owner_runtime_credits", error: "Insufficient runtime credits.", finished_at: now.toISOString() }).eq("id", job.id);
    }
    const intervalMinutes = Math.max(5, Number(schedule.schedule || 60));
    await client.from("action_schedules").update({ last_run_at: now.toISOString(), next_run_at: new Date(now.getTime() + intervalMinutes * 60_000).toISOString(), updated_at: now.toISOString() }).eq("id", schedule.id);
  }
}
